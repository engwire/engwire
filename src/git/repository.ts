/**
 * @file Engwire's own copy of a repository.
 *
 * The reviewer's checkout is off limits — it has uncommitted work, hooks, and a
 * branch they care about, and a review must never be the reason any of that
 * moves. Engwire keeps its own bare clone per repository and builds worktrees
 * from it, so reviews do not disturb the owner's working copies.
 *
 * How that clone is kept cheap — bare, blobless, single-revision fetches — is
 * this module's business alone. Nothing above it names a git flag.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { absolutePath } from "../config/paths.ts";
import { gitEnvironment } from "./environment.ts";
import { readText } from "../read-text.ts";

/**
 * Put the cause before argv so `status`'s 100-column detail shows the failure
 * instead of inert-config flags. Retain the full command and stderr for logs.
 */
export function gitFailureMessage(
  args: readonly string[],
  exitCode: number,
  stderr: string,
): string {
  // git writes its progress first and its remediation last, so neither end of
  // stderr is reliably the cause: a clone opens with "Cloning into …", and
  // dubious ownership closes with the `git config` command that fixes it. The
  // `fatal:`/`error:` line between them is the answer, and the last one wins
  // when there are several. Everything else follows rather than being dropped —
  // "remote: Repository not found" is often the more useful half of a pair, and
  // remediation is worth keeping too.
  const said = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const named = said.findLastIndex((line) => /^(fatal|error):/.test(line));
  const at = named === -1 ? said.length - 1 : named;
  const cause = said[at] ?? `no output (exit ${exitCode})`;
  const rest = [...said.slice(0, at), ...said.slice(at + 1)];
  const behind = rest.length > 0 ? ` (${rest.join("; ")})` : "";
  const command = ["git", ...args].join(" ");
  return `git ${subcommandOf(args)} failed (exit ${exitCode}): ${cause}${behind}\n  ${command}`;
}

/**
 * A `git` that ran and exited non-zero.
 *
 * Not exported, and the distinction it draws is an internal one: the recovery
 * paths in this module — a fetch falling back to the pull ref, a `cat-file`
 * reading "absent" — mean *this*, a git that ran and said no, rather than a
 * stop or a local failure that never got an answer out of git at all. What
 * leaves the module is `GitAborted` or the error itself; nothing outside asks
 * whether a git exited non-zero, unlike `GhError`.
 */
class GitError extends Error {
  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(gitFailureMessage(args, exitCode, stderr));
    this.name = "GitError";
  }
}

/**
 * The command was stopped rather than having failed on its own terms.
 *
 * Its own error because the two answer different questions: a `GitError` says
 * something about the repository and belongs in the run's `detail`, while this
 * says only that the caller ran out of time or was told to stop — and which of
 * those it was is the caller's to say.
 *
 * Exported, unlike `GitError`, because the distinction cannot be recovered from
 * the signals afterwards. Unwinding a genuine failure does work of its own:
 * `ensureRepository` awaits the removal of its staging directory before
 * rethrowing, and a deadline that elapses during those milliseconds would have
 * the caller read "aborted" over a perfectly good message about a repository it
 * could not authenticate to. The thrown value is the only account of what
 * actually stopped the command.
 */
export class GitAborted extends Error {
  constructor(args: readonly string[]) {
    super(`git ${subcommandOf(args)} was stopped before it finished`);
    this.name = "GitAborted";
  }
}

/** Empty value passed to unambiguous config keys through `--config-env`. */
const GIT_INERT = "ENGWIRE_GIT_INERT";

/**
 * Which git command failed, for a message read where there is no room for argv.
 *
 * Not `args[0]`: the inert-config overrides come first. Not the first non-flag
 * either — `-c key=value` and `-C path` put their operands there, and only the
 * first of those is recognisable by its `=`. So the operand-taking flags are
 * skipped by name, which is the whole list git has that matters here.
 */
function subcommandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-c" || arg === "-C") {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

/**
 * How long a signalled git gets to exit before it is killed.
 *
 * Its own name rather than `KILL_GRACE_MS`, which `claude/run.ts` exports with
 * a different number: two constants under one name is one grep with two
 * answers. Exported for the reason that one is — the plist has to leave room
 * for every wait a shutdown can land inside, and the test that holds it to
 * that cannot include a grace it cannot see.
 */
export const GIT_KILL_GRACE_MS = 5_000;

/**
 * @param cwd Required, not optional: every git Engwire runs works in a
 * directory it created, and the process's own can be a checkout of the branch
 * under review. Naming it at every call is what keeps that true by
 * construction rather than by convention.
 *
 * @param signal Required for the same reason. A git that cannot be stopped is
 * the failure this parameter exists to prevent: the runner reviews one pull
 * request at a time, so a `clone` or `fetch` stalled on a half-open connection
 * holds the only execution slot there is — indefinitely, while polling
 * continues and the queue grows, with nothing in `status` saying why. A default
 * here would let the next call site reintroduce that silently.
 */
export async function git(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  // Load-bearing, not a shortcut: a listener added to an already-aborted signal
  // never fires, so spawning here would produce exactly the process this
  // parameter exists to prevent — one running with nothing left to stop it.
  if (signal.aborted) throw new GitAborted(args);
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // `git` is resolved through this PATH, not the ambient one — a review run
    // from inside a contributor's checkout must not find their `git` — and the
    // helpers git reaches for itself, `ssh` among them, inherit the same rule.
    env: {
      ...gitEnvironment(),
      PATH: absolutePath(),
      GIT_TERMINAL_PROMPT: "0",
      [GIT_INERT]: "",
    },
    // A separate group lets cancellation stop git and its credential/transport
    // helpers together. Bun.spawn's signal option only stops the leader.
    // Terminal signals no longer reach this group directly; the caller must
    // forward shutdown through the required AbortSignal. A second Ctrl-C can
    // terminate the runner before its pending escalation finishes.
    detached: true,
  });

  // Held rather than handed to `Response.text()`, which locks the stream and
  // leaves nothing to cancel.
  const out = readText(proc.stdout);
  const err = readText(proc.stderr);

  let force: ReturnType<typeof setTimeout> | undefined;
  // SIGTERM first so git can remove the partial objects it is mid-write on;
  // SIGKILL for the descendant that ignores it. `ESRCH` is the group already
  // being gone, and on macOS so is `EPERM` while a just-emptied group
  // disappears — the same measured Darwin behaviour `claude/run.ts` documents.
  //
  // Nothing here throws, unlike the rest of this module. Every caller is an
  // abort listener, a timer callback, or the `finally` below: a throw from the
  // first two is an uncaught exception that takes the runner down mid-shutdown,
  // and one from the third replaces the `GitAborted` that is the only account
  // of what actually stopped the command.
  const stop = (signalName: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signalName);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The group is already gone, which is the ordinary case and not a
      // failure. On macOS `EPERM` says the same thing while a just-emptied
      // group disappears — the measured Darwin behaviour `claude/run.ts`
      // documents.
      if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) return;
      // Anything else means the signal did not arrive, and the drain below is
      // waiting on a process nothing has told to stop — an abort that turns
      // into a wait with no end, which is the failure this whole function
      // exists to prevent. The leader alone is worse than the group and far
      // better than nothing.
      try {
        proc.kill(signalName);
      } catch {
        // Then it is gone after all, or beyond reach either way.
      }
    }
  };
  // `??=` on the escalation, because this has two callers: the abort listener
  // below and the read-failure path in the `catch`. Reached twice, a plain
  // assignment leaves the first timer armed and unreachable — it fires five
  // seconds later at a process group that has since been reaped, which is the
  // bet on pid reuse the `finally` below is written to avoid making.
  const abort = () => {
    stop("SIGTERM");
    // The reads go too, and this is the half a signal cannot deliver. Killing
    // the group closes the pipes every writer still in it holds — but what a
    // `fetch` hands off to run later leaves the group first, and a descendant
    // outside it keeps stdout open with nothing here able to reach it. Measured:
    // the leader exited at once, the abort fired, and the drain below never
    // finished, so a stopped checkout held the runner's one execution slot
    // exactly as an unstopped one would. `gh.ts` cancels its reads for this
    // reason and this borrows the same helper.
    out.cancel();
    err.cancel();
    force ??= setTimeout(() => stop("SIGKILL"), GIT_KILL_GRACE_MS);
    force.unref();
  };
  // Removed in the `finally` rather than left to `{ once: true }`, which fires
  // only on abort — and the ordinary path here is a git that exits on its own,
  // where nothing would ever take the listener off. `sleep` in `review/loop.ts`
  // is the same rule for the same reason.
  signal.addEventListener("abort", abort);

  let drained = false;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([out.text, err.text, proc.exited]);
    drained = true;
    // Asked after the wait, not instead of it: a git killed by the abort exits
    // non-zero with whatever it managed to say on stderr, and reporting that as
    // an ordinary git failure would blame the repository for the deadline.
    if (signal.aborted) throw new GitAborted(args);
    if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
    return stdout;
  } catch (error) {
    // Everything below is the read having rejected rather than ended, which is
    // the one way out of here that leaves no evidence the group is empty: the
    // wait is over while git may well not be, and a detached spawn has no
    // terminal left to reach it either. Defensive rather than observed — a
    // subprocess stream ends cleanly even when the process is killed under it —
    // but an unstoppable git is the failure this whole function is built to
    // prevent, so it does not get a way in through the error path.
    if (drained) throw error;
    // Already stopping, and the read lost the race with its own cancellation.
    // Reported as what stopped the command, or `executeRun` reads a shutdown as
    // a failed checkout and spends a request that is still outstanding. The
    // `finally` below does the killing.
    if (signal.aborted) throw new GitAborted(args);
    // Nobody asked, so nothing else is coming: stop it here, on the same terms
    // an abort would, escalation included — and *wait*, rather than only
    // signalling. A local failure must not be handed back while a git may still
    // be mutating the clone, whatever the caller does next; this module is
    // arranged so that two gits never work on one repository at once, and
    // returning early would leave that to luck. The escalation `abort` just
    // armed bounds the wait; the group kill after it is the one the `finally`
    // would have done had the caller stopped us.
    abort();
    await proc.exited;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    // Only when something signalled this group, which is what `force` records —
    // an abort, or the read failure below it. That is the whole difference from
    // the agent in `claude/run.ts`, which kills its group on every exit. The drain above ends
    // only once every writer has closed the pipe, so arriving here normally is
    // evidence that nothing is still holding *these* — not that the group is
    // empty. A descendant that redirected its own streams could outlive a clean
    // exit and go unsignalled — git waits for the helpers it runs in front of
    // you, the credential helper and the transport, but nothing here is a
    // promise that it waits for everything it starts, and what a `fetch` hands
    // off to run later detaches itself out of this group on the way. Signalling
    // anyway would not catch that one and would otherwise aim at a pid the
    // kernel has already reclaimed, once per command and a dozen times per
    // checkout, each a small bet on pid reuse for no gain. After an abort the
    // bet is worth taking — this replaces the pending escalation, so a
    // descendant that ignored SIGTERM goes now rather than never.
    if (force !== undefined) {
      clearTimeout(force);
      stop("SIGKILL");
    }
  }
}

/**
 * Return the key to blank so one executable config entry cannot run.
 *
 * The keys git reaches are named by the reviewer, not by Engwire, and there is
 * no wildcard override — so each has to be found in the effective config:
 *
 * - a filter driver's `smudge` or `process`, which a committed `.gitattributes`
 *   activates by naming the filter. `required` goes with them — git-lfs marks
 *   its filter required, and a required filter whose commands are disabled
 *   fails the checkout outright rather than falling back. `clean` is the
 *   check-in direction and measurably does not run here, so it is left alone.
 * - a hook configured as `hook.<name>.command`, git 2.54's alternative to a
 *   script on disk. `core.hooksPath` does not cover these; `enabled` is the
 *   documented way to switch one off, and it is keyed by the hook's own name
 *   rather than by the event it answers.
 *
 * An empty value serves both: it disables a driver, and reads as false for
 * `enabled`.
 */
function inertKey(key: string): string | undefined {
  if (/^filter\..*\.(smudge|process|required)$/.test(key)) return key;
  const hook = /^hook\.(.+)\.event$/.exec(key);
  return hook ? `hook.${hook[1]}.enabled` : undefined;
}

/**
 * Arguments that stop git running a reviewer-configured program.
 *
 * These overrides are targeted rather than replacing the global config because
 * blobless fetches still need the reviewer's proxy and credential settings. The
 * executable keys, measured behaviour and residual boundary are recorded in
 * `docs/experiments.md`.
 *
 * @param dir The repository whose effective configuration the command will use.
 */
export async function inertOverrides(dir: string, signal: AbortSignal): Promise<string[]> {
  // Listing names succeeds on an empty result, where matching them in git does
  // not — so a `git` that fails here fails the command it guards, rather than
  // being read as "nothing to disable". Values are never asked for: they can
  // contain newlines, and only the keys are needed.
  const keys = (await git(["config", "--name-only", "--list"], dir, signal)).split("\n");
  const overrides = new Set(keys.map(inertKey).filter((key) => key !== undefined));
  return [
    // `--config-env` rather than `-c`, because a subsection name may contain an
    // `=` that `-c` would misparse into a different key. The two fixed keys
    // below have no such ambiguity.
    ...[...overrides].map((key) => `--config-env=${key}=${GIT_INERT}`),
    "-c",
    "core.hooksPath=/dev/null",
    // Empty rather than `false`: git documents versions through 2.35.1 as
    // reading a boolean-looking value here as the hook's pathname. Measured
    // inert on 2.54.0, including where the reviewer had set it to `true`.
    "-c",
    "core.fsmonitor=",
  ];
}

/** The HTTPS URL Engwire clones, and the one `gh` resolves from inside a worktree. */
export function cloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * Scoped to github.com rather than to the clone as a whole.
 *
 * A bare `credential.helper` would answer for every host a command inside the
 * worktree reaches, and the empty entry that precedes it would suppress the
 * user's own helpers for those hosts too. Engwire authenticates to exactly one
 * host, so it configures exactly one: a URL section overrides github.com and
 * leaves the rest of the user's credential configuration untouched.
 */
const HELPER_KEY = "credential.https://github.com.helper";

/**
 * The credential helper Engwire writes into its own clones.
 *
 * Engwire never holds a token: it shells out to `gh` each time git needs one.
 * Whatever `gh_bin` names is what the helper runs — an absolute path when the
 * config gives one, which matters because git runs the helper through a shell
 * whose `PATH` under launchd may not have the user's `gh` on it. Quoted,
 * because a home directory can contain a space.
 */
function credentialHelper(ghBin: string): string {
  return `!'${ghBin.replaceAll("'", `'\\''`)}' auth git-credential`;
}

/**
 * Ensure a bare clone exists at `dir`, cloning from `url` if it does not.
 *
 * Blobless: history metadata is cheap, file contents are fetched on demand.
 *
 * The credential helper is passed to `clone` rather than configured after it,
 * so the very first fetch is authenticated — otherwise a private repository
 * would only clone for someone who had already set up git credentials by hand.
 * `clone -c` also persists it, so the lazy blob fetches a checkout triggers are
 * authenticated too. The empty helper before it resets the list for github.com:
 * git tries helpers in order until one answers, and a helper inherited from the
 * user's global config could otherwise answer first, as an account that is not
 * the one `engwire doctor` checked.
 *
 * The clone lands beside its destination and is renamed into place. A crash
 * halfway through would otherwise leave a directory that exists, is not a
 * repository, and is treated as one by every later review.
 *
 * The helper is rewritten on every call, not only on the first. It embeds an
 * absolute path, and `gh` moves — a Homebrew upgrade, a reinstall — so a clone
 * made months ago would otherwise keep invoking a `gh` that is no longer there
 * while `doctor` reports the new one as healthy.
 */
export async function ensureRepository(options: {
  url: string;
  dir: string;
  ghBin: string;
  signal: AbortSignal;
}): Promise<void> {
  const github = options.url.startsWith("https://github.com/");

  if (existsSync(options.dir)) {
    if (github) await configureCredentials(options.dir, options.ghBin, options.signal);
    return;
  }

  const parent = dirname(options.dir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = `${options.dir}.incoming`;
  await rm(staging, { recursive: true, force: true });
  try {
    // Run from the directory just created, not from wherever the runner was
    // started — which can be a checkout of the branch under review. `clone` is
    // a command git runs without a repository, so measurably it does not honour
    // the surrounding one's config, but that is git's semantics to change and
    // this is the only `git` Engwire runs outside a directory of its own.
    await git(
      [
        ...(await inertOverrides(parent, options.signal)),
        "clone",
        // No templates, so the repository Engwire owns holds none of the
        // reviewer's programs rather than holding them harmlessly. A global
        // `init.templateDir` — how the pre-commit and husky crowd share hooks
        // — copies its `hooks/` into every repository `clone` creates, this one
        // included. Measured: they never fire, because every git below pins
        // `core.hooksPath` at `/dev/null`. That is a property of the commands
        // remembering to, though, and this is a property of the directory: a
        // file that is not there cannot be run by a command that forgets.
        "--template=",
        "--bare",
        "--filter=blob:none",
        ...cloneAuth(options.ghBin, github),
        options.url,
        staging,
      ],
      parent,
      options.signal,
    );
    await rename(staging, options.dir);
  } catch (error) {
    // The clone's own error is the one worth reporting, so the cleanup may not
    // replace it: a killed `clone` deletes its target directory as it unwinds,
    // and an `rm` racing that can fail on a path it has already walked. Thrown
    // from here, that would reach `executeRun` as an ordinary checkout failure
    // — spending a claim that a shutdown should have handed back.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function cloneAuth(ghBin: string, github: boolean): string[] {
  return github
    ? ["-c", `${HELPER_KEY}=`, "-c", `${HELPER_KEY}=${credentialHelper(ghBin)}`]
    : [];
}

/**
 * Idempotent: replaces whatever the clone's config held with the current answer.
 *
 * Rewritten on every use rather than once at clone time, because the helper
 * embeds an absolute `gh` path and `gh` moves with a Homebrew upgrade. A clone
 * made months ago would otherwise keep invoking a binary that is gone, while
 * `doctor` reported the new one as healthy.
 */
async function configureCredentials(
  dir: string,
  ghBin: string,
  signal: AbortSignal,
): Promise<void> {
  // `--replace-all` writes the empty value whether or not anything was there,
  // collapsing however many helpers the clone had picked up into the one that
  // resets the list. It replaces an `--unset-all` that exits non-zero on the
  // ordinary first run — and so needed its failure specially excused — with a
  // command that simply succeeds. Measured: the resulting local config is
  // identical, from a fresh clone and from one already carrying helpers.
  await git(["config", "--replace-all", HELPER_KEY, ""], dir, signal);
  await git(["config", "--add", HELPER_KEY, credentialHelper(ghBin)], dir, signal);
}

/**
 * Fetch one revision into the clone.
 *
 * By SHA first, which GitHub allows and which gets exactly the revision the run
 * was claimed at. Falling back to `refs/pull/N/head` covers the case where the
 * server refuses an arbitrary SHA; that ref is guaranteed to exist, though it
 * may already have moved past the revision under review — which the caller
 * detects, because the checkout is by SHA and simply fails.
 */
export async function fetchRevision(
  dir: string,
  sha: string,
  pullNumber: number,
  signal: AbortSignal,
): Promise<void> {
  // Already here: a second review of the same revision, or a revision the last
  // fetch happened to bring along. Cheap to check, and it removes a network
  // round trip from the common case of re-reviewing a pull request.
  if (await hasRevision(dir, sha, signal)) return;

  const inert = await inertOverrides(dir, signal);
  try {
    await git([...inert, "fetch", "--no-tags", "--filter=blob:none", "origin", sha], dir, signal);
  } catch (error) {
    // Only a git-level failure earns the fallback — any non-zero exit, whatever
    // it was about, since a fetch that could not authenticate is as good a
    // reason to try the pull ref as one that did not know the SHA. A stop, or a
    // read that failed locally, is neither — and
    // `git()` takes trouble to tell those apart, which this would spend by
    // answering all three the same way. Rethrowing a `GitAborted` here also
    // reports the stop one call earlier than waiting for the next `git` to
    // refuse the same signal.
    if (!(error instanceof GitError)) throw error;
    await git(
      [
        ...inert,
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "origin",
        `+refs/pull/${pullNumber}/head:refs/engwire/pull/${pullNumber}`,
      ],
      dir,
      signal,
    );
  }
}

async function hasRevision(dir: string, sha: string, signal: AbortSignal): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`], dir, signal);
    return true;
  } catch (error) {
    // "Absent" is what a git that ran and did not find the object means. A stop
    // or a local read failure means nothing about the object, and answering
    // `false` to those would send the caller to fetch on the strength of an
    // error it never saw.
    if (!(error instanceof GitError)) throw error;
    return false;
  }
}
