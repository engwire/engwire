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
import type { Config } from "../config/config.ts";
import type { Paths } from "../config/paths.ts";
import { prepareRevision } from "../git/worktree.ts";
import type { Gh } from "../github/gh.ts";
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
};

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
 * when the row was written — and the checkout it labels answers that question
 * exactly, with `git rev-parse HEAD`.
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

  try {
    await prepareRevision({
      sha: run.headSha,
      pullNumber: run.pullNumber,
      repoDir: paths.repoDir(run.repo),
      worktreeDir: worktree,
      url: runtime.cloneUrlFor(run.repo),
      ghBin: config.advanced.ghBin,
    });
  } catch (error) {
    store.finish(run.id, "failed", `checkout failed: ${message(error)}`, {
      retainUntil: retainUntil(),
    });
    log(`failed to check out ${run.repo}#${run.pullNumber}: ${message(error)}`);
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
