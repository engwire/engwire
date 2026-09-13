/**
 * @file Carrying out one review.
 *
 * Expected checkout and agent failures are written to the run row, because a
 * review that fails silently is worse than one that never started: the reviewer
 * is waiting on an answer that is not coming. Store failures still escape so a
 * broken runner does not masquerade as a failed review. Expected terminal paths
 * after a checkout is named also assign a retention deadline, allowing the
 * reaper to reclaim the directory after checkout or agent failure.
 */

import { reviewPrompt, runClaude, type ClaudeResult } from "../claude/run.ts";
import { skillPreflightProblem } from "../claude/skills.ts";
import type { Config } from "../config/config.ts";
import type { Paths } from "../config/paths.ts";
import { GitAborted } from "../git/repository.ts";
import { prepareRevision } from "../git/worktree.ts";
import { GhError, type Gh } from "../github/gh.ts";
import type { Store } from "../store/store.ts";
import type { ReviewRequest, ReviewRun } from "./model.ts";

export type Runtime = {
  store: Store;
  config: Config;
  paths: Paths;
  gh: Gh;
  login: string;
  log: (message: string) => void;
  /**
   * Where a repository is cloned from. Wired to `cloneUrl` at the composition
   * root and to a local path by the integration test — one seam, named as an
   * ordinary dependency rather than hidden as an optional test hook.
   */
  cloneUrlFor: (repo: string) => string;
  /**
   * Shutdown, for everything that must not start after one is requested.
   *
   * On the runtime rather than a parameter of `runLoop`, because the loop is
   * not the last place that decides: `executeRun` spawns the agent minutes of
   * checkout later, and that is the commitment worth refusing.
   */
  signal: AbortSignal;
};

/** Whether `gh` still uses this installation's account; a `gh` failure holds work. */
export async function accountMatches(runtime: Runtime): Promise<boolean> {
  let account: string;
  try {
    account = await runtime.gh.login();
  } catch (error) {
    // Only a failed `gh` waits. A local failure obeys the same fail-loudly rule
    // as everything else.
    if (!(error instanceof GhError)) throw error;
    // A shutdown is not a GitHub outage. The runner's `gh` carries the shutdown
    // signal, so a stop refuses the call before it spawns and cuts short one
    // already in flight — both arrive here, and both would otherwise be
    // reported as "could not verify the gh account": a claim about GitHub,
    // printed while somebody watches the runner exit and decides whether it
    // exited cleanly. The caller reads the same signal to say what happened.
    if (!runtime.signal.aborted) {
      runtime.log(`holding: could not verify the gh account: ${error.message}`);
    }
    return false;
  }
  if (account !== runtime.login) {
    runtime.log(`holding: gh is authenticated as ${account}, not ${runtime.login}`);
    return false;
  }
  return true;
}

/**
 * A readable, stable run id — it names the worktree directory and the log file,
 * so `acme-api-42-e5591` answers "what is this?" without a database.
 *
 * Derived entirely from the request, never randomised: rediscovering the same
 * GitHub event produces the same id, so a retried insert collides on the same
 * row rather than littering the data directory with near-duplicates.
 *
 * No revision in it. A queued run follows the pull request's head until it is
 * claimed, so a SHA here would name whichever revision happened to be current
 * when the row was written — and the checkout it labels answers that
 * question exactly, with `git rev-parse HEAD`.
 */
export function runId(request: ReviewRequest): string {
  const slug = request.repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  // The event id names a directory, so it is reduced to characters that cannot
  // mean anything to a path.
  const event = request.eventId.replace(/[^a-zA-Z0-9]+/g, "");
  return `${slug}-${request.pullNumber}-${event}`;
}

export async function executeRun(runtime: Runtime, run: ReviewRun): Promise<void> {
  const { store, config, paths, log } = runtime;
  const retainUntil = () =>
    new Date(Date.now() + config.advanced.worktreeTtlMs).toISOString();

  log(`reviewing ${run.repo}#${run.pullNumber} at ${run.headSha.slice(0, 7)}`);

  // A queued run always carries the skill its automation named. If the row says
  // otherwise the database is not in a state this code understands, and a skill
  // decides what an authenticated agent does — so guess nothing.
  if (!run.skill) {
    store.finish(run.id, "failed", "queued run has no skill; refusing to invent one");
    log(`run ${run.id} has no skill recorded`);
    return;
  }

  // Recorded before anything is created, not after. The path is deterministic,
  // and a crash between creating the checkout and writing the row down would
  // otherwise strand a directory the reaper cannot see — it only reclaims runs
  // whose path it knows. The reaper already tolerates a path that was never
  // created, which is the cheaper direction to be wrong in.
  const worktree = paths.worktreeDir(run.id);
  store.setWorktree(run.id, worktree);

  // Every caller of this has one property in common: no agent has run, so
  // nothing has been posted and the request is still outstanding. That now
  // includes a shutdown during the checkout, which is why stopping mid-clone
  // is not recorded as a failed review.
  const release = (why: string) => {
    store.releaseClaim(run.id, new Date().toISOString());
    log(`holding ${run.repo}#${run.pullNumber}: ${why}`);
  };

  try {
    await prepareRevision({
      sha: run.headSha,
      pullNumber: run.pullNumber,
      repoDir: paths.repoDir(run.repo),
      worktreeDir: worktree,
      url: runtime.cloneUrlFor(run.repo),
      ghBin: config.advanced.ghBin,
      // Two ways to stop a checkout, and the catch below tells them apart
      // because they mean opposite things afterwards: the deadline is this
      // run's own failure, while a shutdown stops every run there is and
      // spends none of them.
      signal: AbortSignal.any([
        runtime.signal,
        AbortSignal.timeout(config.advanced.checkoutTimeoutMs),
      ]),
    });
  } catch (error) {
    // Three outcomes, told apart by the error rather than by the signals.
    // Asking the signals alone would be wrong twice over: unwinding a real
    // failure takes time of its own — `ensureRepository` removes its staging
    // directory before rethrowing — so a deadline elapsing in that gap would
    // bury "could not read Username" under a report about the clock.
    //
    // A git that *stopped* while the runner is stopping gives the claim back:
    // that is not this pull request's fault, nothing ran, so the request is
    // still outstanding, and the half-written checkout goes to the reaper. The
    // existing bare clone survives, making the next attempt cheaper; an
    // unfinished first clone gets best-effort cleanup in `ensureRepository`.
    // `prepareRevision` replaces the worktree either way. A git stopped by the
    // deadline alone spends the run — that is the stalled clone or fetch the
    // deadline exists for, and a runner reviewing one pull request at a time
    // cannot wait it out. Anything else is what git said.
    if (error instanceof GitAborted && runtime.signal.aborted) {
      release("shutdown was requested while the checkout was being prepared");
      return;
    }
    // Named without its milliseconds, which are this program's spelling of the
    // setting rather than the reviewer's.
    const why =
      error instanceof GitAborted
        ? "checkout exceeded checkout_timeout"
        : `checkout failed: ${message(error)}`;
    store.finish(run.id, "failed", why, { retainUntil: retainUntil() });
    log(`${run.repo}#${run.pullNumber}: ${why}`);
    return;
  }

  // Checkout preparation may clone, so recheck both dependencies immediately
  // before the agent starts. Identity goes first because it awaits; the skill
  // check is synchronous and stays adjacent to the spawn.
  //
  // A stop asked for during the checkout is a stop asked for before the review:
  // starting one here commits the next twenty minutes to work launchd is
  // already counting down to kill. Asked before the account check as well as
  // after it, so a shutdown does not wait out one more `gh` subprocess.
  if (runtime.signal.aborted) {
    release("shutdown was requested before the agent started");
    return;
  }
  const matches = await accountMatches(runtime);
  // Asked again after the check, and before its answer is read: the runner's
  // `gh` carries the shutdown signal, so a stop landing inside the identity
  // call comes back as a plain `false`. Filed as the account answer it is not,
  // that would tell the reviewer `gh auth switch` happened during their review.
  if (runtime.signal.aborted) {
    release("shutdown was requested before the agent started");
    return;
  }
  if (!matches) {
    release("gh is no longer the account this review was accepted for");
    return;
  }
  const problem = skillPreflightProblem(run.skill);
  if (problem) {
    release(`review skill ${run.skill} — ${problem}`);
    return;
  }

  // The catch covers the review, and nothing else. Writing the outcome down is
  // outside it: a store failure is the runner being broken, and swallowing it
  // here would file "the database stopped working" as one more failed review.
  let result: ClaudeResult;
  try {
    result = await runClaude({
      bin: config.advanced.claudeBin,
      ghBin: config.advanced.ghBin,
      repo: run.repo,
      cwd: worktree,
      prompt: reviewPrompt(run.skill, run.repo, run.pullNumber, run.headSha),
      timeoutMs: config.advanced.runTimeoutMs,
      logPath: paths.runLog(run.id),
    });
  } catch (error) {
    store.finish(run.id, "failed", message(error), { retainUntil: retainUntil() });
    log(`review of ${run.repo}#${run.pullNumber} failed: ${message(error)}`);
    return;
  }

  if (result.ok) {
    // "Claude exited 0", which is all Engwire observed. The skill owns posting
    // to GitHub, so whether a review actually appeared there is not something
    // this can claim — and saying "reviewed" would claim it.
    store.finish(run.id, "completed", null, { retainUntil: retainUntil() });
    log(`completed ${run.repo}#${run.pullNumber} — see ${paths.runLog(run.id)}`);
    return;
  }

  const detail = result.timedOut
    ? `timed out after ${config.advanced.runTimeoutMs}ms`
    : `claude exited ${result.exitCode}`;
  store.finish(run.id, "failed", detail, { retainUntil: retainUntil() });
  log(`review of ${run.repo}#${run.pullNumber} ${detail} — see ${paths.runLog(run.id)}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
