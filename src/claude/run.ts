/**
 * @file Handing the review to Claude Code.
 *
 * The boundary this file defends: Engwire decides *when* a review happens and
 * *where* it happens; the skill decides *what* a review is. Nothing here parses
 * a diff, composes a comment, or calls GitHub. The separation lets the reviewer
 * improve reviews by editing a Markdown skill they already own, without a new
 * Engwire binary.
 *
 * Output goes straight to a file descriptor the child writes to. Nothing
 * buffers a twenty-minute transcript in memory. Output already written remains
 * available if the runner is killed; the outcome line requires normal cleanup.
 */

import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { absolutePath, privateDir } from "../config/paths.ts";
import { withoutStartupCodeVariables } from "../environment.ts";
import { withoutGitVariables } from "../git/environment.ts";
import { GITHUB_ENV } from "../github/gh.ts";

export type ClaudeResult = {
  exitCode: number;
  timedOut: boolean;
  ok: boolean;
};

/** Why a review stopped early, when something stopped it. */
type StopCause = "timeout" | NodeJS.Signals;

/**
 * Claude Code loads settings, hooks, skills and `CLAUDE.md` from its working
 * directory by default, and `-p` does not stop to ask whether that directory is
 * trusted. The working directory here is a pull request — so a contributor
 * could ship a `.claude/settings.json` with hooks and have Engwire execute it.
 *
 * `user` is therefore the only setting source: the reviewer's own configuration
 * and their own review skill, never the branch under review.
 *
 * This is a measured security boundary: it keeps project memory, skills, hooks
 * and MCP configuration out of the session. See `docs/experiments.md` for the
 * evidence and its limits.
 */
export const SETTING_SOURCES = ["--setting-sources", "user"];

/**
 * How long a review gets to stop politely before it is killed.
 *
 * Exported because the launchd plist is sized against it: `ExitTimeOut` has to
 * leave room for this whole wait, or the supervisor can SIGKILL the runner
 * before review cleanup finishes.
 */
export const KILL_GRACE_MS = 10_000;

export async function runClaude(options: {
  bin: string;
  /** The configured `gh`; if absolute, its directory joins the agent's PATH. */
  ghBin: string;
  /** `owner/name`, the repository this checkout came from. */
  repo: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  logPath: string;
}): Promise<ClaudeResult> {
  // A transcript is a review of private code: its directory gets the
  // private-directory policy, and the file itself 0600 whatever the machine's
  // umask is and whatever the path was before.
  privateDir(dirname(options.logPath));
  const fd = openSync(options.logPath, "a", 0o600);
  const startedAt = Date.now();
  let untrap = () => {};
  let shutdownSignal: NodeJS.Signals | undefined;
  try {
    fchmodSync(fd, 0o600);

    let proc: Bun.Subprocess | undefined;
    let cleanupError: unknown;
    /**
     * Signal everything the review started.
     *
     * Ignore `ESRCH` and, on Darwin only, `EPERM`. The latter was observed
     * after signalling a group and reaping its leader, with no surviving tools;
     * its mechanism is unestablished (docs/experiments.md). Other errors fail
     * the run. Record them rather than throwing from a timer or signal handler,
     * so the remaining cleanup and transcript write still happen.
     */
    const signalRun = (signal: NodeJS.Signals) => {
      // Nothing has been started yet, which is the whole point of registering
      // the handlers below before the spawn.
      if (!proc) return;
      try {
        process.kill(-proc.pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const gone = code === "ESRCH" || (process.platform === "darwin" && code === "EPERM");
        if (!gone) cleanupError ??= error;
      }
    };

    let force: ReturnType<typeof setTimeout> | undefined;
    /** Forward the stop signal, then escalate to SIGKILL after the grace period. */
    const endRun = (signal: NodeJS.Signals) => {
      signalRun(signal);
      force ??= setTimeout(() => signalRun("SIGKILL"), KILL_GRACE_MS);
      force.unref();
    };

    /**
     * Why the review is stopping, kept at whichever reason came first.
     *
     * Both can be true, and a second one arriving does not change what
     * happened: a shutdown a hundred milliseconds before the deadline stops the
     * review, and the run-timeout timer still fires afterwards. Recording the
     * later reason would file a machine going down as a review that ran too
     * long, in the one line of the transcript that says how it ended. The
     * database never hears about this one either way: a shutdown re-raises
     * itself below, and the runner is gone before `executeRun` records
     * anything.
     */
    let stopCause: StopCause | undefined;
    const stopRun = (cause: StopCause) => {
      if (stopCause) return;
      stopCause = cause;
      endRun(cause === "timeout" ? "SIGTERM" : cause);
    };

    // Ctrl-C reaches a child through the terminal's foreground process group,
    // which the review just left, and launchd's stop signal never went there at
    // all. So the runner passes its own termination down — and then waits, on
    // the same terms as a timeout. Re-raising immediately would leave a tool
    // that ignores SIGTERM running with nothing left to escalate against it.
    const forward = (signal: NodeJS.Signals) => {
      // Kept even when something else stopped the review first: the runner
      // still has to re-raise this and go down as the shutdown it is.
      shutdownSignal ??= signal;
      stopRun(signal);
    };
    untrap = () => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    // Before the spawn, not after. A signal that arrives with no handler
    // registered takes its default action and terminates the runner where it
    // stands — measured, and not deferred to the next event-loop turn the way
    // a signal with a handler is. Registering afterwards would leave a span,
    // however short, in which the review has been detached and the process that
    // knows how to stop it is gone.
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    proc = Bun.spawn({
      cmd: [options.bin, ...SETTING_SOURCES, "-p", options.prompt],
      cwd: options.cwd,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      // Start from the runner's environment (the plist's under launchd), then
      // filter startup selectors and pin the review's repository and tool paths.
      //
      // Host and repository are pinned rather than left ambient, because `gh`
      // reads both from the environment before it infers anything: a stray
      // `GH_REPO` in the reviewer's shell would send a plain `gh pr review 42`
      // to a repository this run has never seen. A skill that names a
      // repository still wins, which is right — this only fixes the default.
      // Prompting is off because nobody is at the terminal.
      //
      // The ambient `GIT_*` namespace goes for the reasons
      // `git/environment.ts` gives — a skill's ordinary `git diff` reads an
      // inherited `GIT_DIR` exactly as Engwire's own git does, and
      // `GIT_EXEC_PATH` would replace the helper it fetches through.
      //
      // And the reviewer's configuration goes too, which is where this parts
      // company with Engwire's own git. That git never runs `diff`; the skill
      // does, and a diff driver is executable configuration a contributor can
      // *select*: `.gitattributes` in the branch names `diff=x`, and
      // `diff.x.command` in the reviewer's global config is what runs, on the
      // branch's own content. Measured. It is the filter problem in a second
      // place, and the cheaper answer here is to hand the agent no global or
      // system configuration at all rather than teach this boundary every key
      // that executes. The worktree's own config still applies — Engwire wrote
      // that one.
      //
      // Everything above is this spawn's own; `claudeEnvironment` is the part
      // `doctor` shares, and says why a variable that decides what runs is a
      // different problem from one that says where a repository is.
      env: {
        ...claudeEnvironment(process.env),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...GITHUB_ENV,
        GH_REPO: options.repo,
        GH_PROMPT_DISABLED: "1",
        PATH: agentPath(options.ghBin),
      },
      // The agent runs tools, and a tool that outlives it goes on doing
      // whatever it was doing. `detached` puts the review in its own process
      // group, which is the handle for all of it at once. Measured, not
      // assumed: without this, a grandchild of a SIGTERMed `claude` reparents
      // to init and keeps writing, so Engwire would start the next review while
      // the last one could still post.
      //
      // The group covers the tool tree, not a determined escape from it: a
      // descendant that calls `setsid` leaves the group and is beyond this.
      // This is process cleanup, not a sandbox or tool-permission boundary.
      detached: true,
    });
    // A signal that arrived while the spawn was in flight found nothing to
    // stop. There is something now.
    if (shutdownSignal) endRun(shutdownSignal);

    const terminate = setTimeout(() => stopRun("timeout"), options.timeoutMs);
    terminate.unref();

    const exitCode = await proc.exited;
    clearTimeout(terminate);
    clearTimeout(force);
    // The agent has exited; what it left running has not. SIGKILL without a
    // grace period, because anything still here already outlived the process
    // that started it.
    signalRun("SIGKILL");
    // The one line here the runner writes rather than the agent, and what lets
    // the file be read on its own: the output above simply stops, so a timeout,
    // a non-zero exit, a shutdown and an ordinary finish are otherwise the same
    // silence, and the status that separates them is in a database nobody has
    // open while reading a log. After the kill, so anything still holding this
    // descriptor has at least been signalled first — `process.kill` returns
    // before the kernel reaps, so this orders the two as well as anything can
    // rather than promising the last word. Before the throw, because a
    // transcript that does not say how it ended is the failure this is for.
    writeSync(fd, `\n[engwire] ${outcome({ exitCode, stopCause, startedAt, cleanupError })}\n`);
    if (cleanupError) throw cleanupError;
    const timedOut = stopCause === "timeout";
    return { exitCode, timedOut, ok: exitCode === 0 && !timedOut };
  } finally {
    untrap();
    closeSync(fd);
    // Last, deliberately: the runner's own shutdown completes only once the
    // review's has.
    if (shutdownSignal) process.kill(process.pid, shutdownSignal);
  }
}

/**
 * How the review ended, in the transcript's own words.
 *
 * Prefixed so a reader can tell a runner-authored line from the agent's, and
 * so `grep '^\[engwire\]'` over a day of transcripts answers "which of these
 * finished". The timeout and the signal are named rather than folded into an
 * exit code: `claude` killed by SIGTERM and `claude` exiting non-zero are the
 * same number to a shell and very different things to whoever is debugging.
 *
 * A failed cleanup is part of the ending rather than left to the exception it
 * also becomes. `runClaude` throws it, `executeRun` records the run as failed,
 * and a transcript ending `claude finished` would then be the one place that
 * disagreed with both.
 */
function outcome(run: {
  exitCode: number;
  stopCause: StopCause | undefined;
  startedAt: number;
  cleanupError: unknown;
}): string {
  // Elapsed run time, in every branch. It is measured after the wait, so
  // attaching it to the *stop* would date a timeout to the moment the review
  // finally let go rather than the moment its deadline passed — a ten-minute
  // limit reported as ten minutes and eight seconds.
  const took = `after ${Math.round((Date.now() - run.startedAt) / 1000)}s`;
  const ended =
    run.stopCause === "timeout"
      ? `claude reached its run_timeout and was stopped; the review ended ${took}`
      : run.stopCause
        ? `the runner was stopped by ${run.stopCause}; the review ended ${took}`
        : run.exitCode === 0
          ? `claude finished ${took}`
          : `claude exited ${run.exitCode} ${took}`;
  if (!run.cleanupError) return ended;
  // What failed is the signal, which is all this knows. Whether anything is
  // still running is a further claim: a group can refuse one signal and be
  // empty a moment later.
  const why = run.cleanupError instanceof Error ? run.cleanupError.message : String(run.cleanupError);
  return `${ended}, but Engwire could not signal the review's process group: ${why}`;
}

/**
 * The environment every `claude` Engwire starts gets.
 *
 * Shared because Claude has two spawn sites and one boundary: `runClaude` hands
 * it a pull request, and `doctor` probes it from wherever the reviewer typed
 * the command — which `docs/experiments.md` notes can be that same checkout.
 * The Linux measurement is `LD_PRELOAD=./libprobe.so claude --version`:
 * `--version` *is* what `doctor` runs, so a policy private to `runClaude` would
 * have left the sharper of the two callers exposed. Only the environment is
 * shared; the agent's `GH_REPO`, git configuration and PATH stay at the spawn
 * that needs them, since `doctor` posts nothing and reviews nothing.
 *
 * Remove startup-code selectors and inherited `GIT_*` overrides. The review
 * spawn also disables global and system Git configuration; see its environment
 * block for the diff-driver hazard and why that policy differs from Engwire's
 * own Git commands.
 */
export function claudeEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return withoutStartupCodeVariables(withoutGitVariables(env));
}

/**
 * The agent's executable search path, with nothing relative left in it.
 *
 * The invariant: **no entry in the agent's PATH is relative to the pull
 * request.** Its working directory is a checkout of the branch under review, so
 * every relative `PATH` entry is a directory a contributor controls — and a
 * skill or hook that runs `gh`, `git` or anything else by name would find their
 * file first. Measured, not assumed: with cwd inside a checkout, each of `.`,
 * `tools`, a leading `:` and a trailing `:` executes a file from it.
 *
 * The reviewer's own shell PATH may well contain one of those, so filtering is
 * the fix rather than declining to add one. This is the executable half of the
 * boundary `--setting-sources user` draws for configuration, and the filtering
 * itself is `absolutePath` — the same rule the runner's own subprocesses get.
 *
 * An absolute `gh_bin` is then prepended: it names a binary that may not be on
 * `PATH` at all — the point of configuring it — while the skill posts by
 * running `gh` by name. A bare `"gh"` is already resolved through the inherited
 * PATH and contributes nothing.
 */
export function agentPath(ghBin: string, path = process.env.PATH ?? ""): string {
  const dirs = absolutePath(path).split(":").filter(Boolean);
  if (isAbsolute(ghBin)) dirs.unshift(dirname(ghBin));
  return [...new Set(dirs)].join(":");
}

/**
 * How a skill is invoked: `/review-pr acme/api#42 at 8f3a1c2...`.
 *
 * The revision is named explicitly because the worktree is the only thing
 * Engwire can pin. A skill that reaches for `gh pr diff` sees whatever GitHub
 * considers current, which may already be a push ahead of the checkout it is
 * standing in — so the SHA it was asked about has to be something it can read.
 */
export function reviewPrompt(
  skill: string,
  repo: string,
  pullNumber: number,
  headSha: string,
): string {
  return `/${skill} ${repo}#${pullNumber} at ${headSha}`;
}
