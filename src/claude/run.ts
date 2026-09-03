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
 * buffers a twenty-minute transcript in memory, and the log is complete even if
 * the runner is killed.
 */

import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { absolutePath } from "../config/paths.ts";
import { GITHUB_ENV } from "../github/gh.ts";

export type ClaudeResult = {
  exitCode: number;
  timedOut: boolean;
  ok: boolean;
};

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

/** How long a review gets to stop politely before it is killed. */
const KILL_GRACE_MS = 10_000;

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
  // A transcript is a review of private code. 0700 on the directory and 0600 on
  // the file, whatever the machine's umask is and whatever the path was before.
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(options.logPath), 0o700);
  const fd = openSync(options.logPath, "a", 0o600);
  let untrap = () => {};
  let shutdownSignal: NodeJS.Signals | undefined;
  try {
    fchmodSync(fd, 0o600);
    const proc = Bun.spawn({
      cmd: [options.bin, ...SETTING_SOURCES, "-p", options.prompt],
      cwd: options.cwd,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      // Explicit rather than inherited: under launchd the runner's environment
      // is the plist's, and the agent needs to see exactly that — the same PATH
      // that made `gh` findable is the one its own tools will look on.
      //
      // Host and repository are pinned rather than left ambient, because `gh`
      // reads both from the environment before it infers anything: a stray
      // `GH_REPO` in the reviewer's shell would send a plain `gh pr review 42`
      // to a repository this run has never seen. A skill that names a
      // repository still wins, which is right — this only fixes the default.
      // Prompting is off because nobody is at the terminal.
      env: {
        ...process.env,
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
      // Engwire is not a sandbox, and the reviewer's `allowed-tools` is where
      // that boundary actually lives.
      detached: true,
    });

    let cleanupError: unknown;
    /**
     * Signal everything the review started.
     *
     * `ESRCH` is the group already being gone. So, on macOS, is `EPERM`, which
     * it frequently reports rather than `ESRCH` while a just-emptied group
     * disappears — measured over repeated runs in which nothing from the review
     * survived. That is a Darwin observation and stays one: Engwire created
     * this group, so `EPERM` from Linux would mean what it says, and the run
     * should fail rather than call it cleanup.
     *
     * Anything else is a bug here, and a run that could not clean up after
     * itself should not report a clean finish — recorded rather than thrown
     * because two of the three callers are timers, where throwing would skip
     * the cleanup below.
     */
    const signalRun = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid, signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const gone = code === "ESRCH" || (process.platform === "darwin" && code === "EPERM");
        if (!gone) cleanupError ??= error;
      }
    };

    let force: ReturnType<typeof setTimeout> | undefined;
    /** SIGTERM so the agent can finish its transcript; SIGKILL if it will not. */
    const endRun = (signal: NodeJS.Signals) => {
      signalRun(signal);
      force ??= setTimeout(() => signalRun("SIGKILL"), KILL_GRACE_MS);
      force.unref();
    };

    let timedOut = false;
    const terminate = setTimeout(() => {
      timedOut = true;
      endRun("SIGTERM");
    }, options.timeoutMs);
    terminate.unref();

    // Ctrl-C reaches a child through the terminal's foreground process group,
    // which the review just left, and launchd's stop signal never went there at
    // all. So the runner passes its own termination down — and then waits, on
    // the same terms as a timeout. Re-raising immediately would leave a tool
    // that ignores SIGTERM running with nothing left to escalate against it.
    const forward = (signal: NodeJS.Signals) => {
      if (shutdownSignal) return;
      shutdownSignal = signal;
      endRun(signal);
    };
    untrap = () => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    // Registered after the spawn, and safe there only because nothing between
    // the two awaits: a signal raised in that span is delivered on the next
    // event-loop turn, so `forward` is always in place before any handler runs.
    // Measured, because the alternative is a detached review nobody signals —
    // the runner would wait out the whole timeout while launchd counted down to
    // SIGKILL. An `await` introduced above this line would open that window.
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    const exitCode = await proc.exited;
    clearTimeout(terminate);
    clearTimeout(force);
    // The agent has exited; what it left running has not. SIGKILL without a
    // grace period, because anything still here already outlived the process
    // that started it.
    signalRun("SIGKILL");
    if (cleanupError) throw cleanupError;
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
