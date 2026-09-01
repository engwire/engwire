/**
 * @file The imperative shell: poll, decide, execute, reclaim.
 *
 * Scheduling policy lives in `reconcile.ts`; this file coordinates GitHub,
 * durable state, review execution, shutdown and worktree cleanup.
 */

import { skillPreflightProblem } from "../claude/skills.ts";
import { GhError } from "../github/gh.ts";
import { discoverReviewRequests } from "../github/reviews.ts";
import { removeWorktree } from "../git/worktree.ts";
import type { NewRunDecision } from "../store/store.ts";
import { accountMatches, executeRun, runId, type Runtime } from "./execute.ts";
import type { ReviewRequest, ReviewRun } from "./model.ts";
import { reconcileReviews, type DismissReason, type ReviewDecision } from "./reconcile.ts";

/** Discover review requests, decide what to do, and write the decisions down. */
export async function pollAndSchedule(runtime: Runtime): Promise<ReviewDecision[]> {
  const { store, config, log } = runtime;

  const requests = await discoverReviewRequests(runtime.gh, {
    login: runtime.login,
    since: store.watchingSince(),
  });

  const decisions = reconcileReviews({
    requests,
    automations: config.reviews,
    activeRuns: store.activeRuns(),
    handledEventIds: store.knownEventIds(requests.map((r) => r.eventId)),
  });

  const now = new Date().toISOString();
  // Every discovered request is written down, whether or not it will run: an
  // unrecorded one is rediscovered on every poll, forever. The two cases differ
  // only in the status and the skill.
  const record = (
    request: ReviewRequest,
    decision: NewRunDecision,
  ) =>
    store.insert({
      id: runId(request),
      eventId: request.eventId,
      repo: request.repo,
      pullNumber: request.pullNumber,
      headSha: request.headSha,
      title: request.title,
      requestedAt: request.requestedAt,
      createdAt: now,
      ...decision,
    });

  // All of it or none of it. Enqueueing a newer request and superseding the
  // queued run it replaces are one decision written twice, and a crash between
  // the two would leave both queued with no poll able to notice: the newer
  // event is recorded by then, so reconciliation never sees it as fresh again.
  const notes: string[] = [];
  store.transaction(() => {
    for (const decision of decisions) {
      switch (decision.kind) {
        case "enqueue": {
          const { request, automation } = decision;
          record(request, { skill: automation.skill, status: "queued", detail: null });
          notes.push(`queued ${request.repo}#${request.pullNumber} (${automation.skill})`);
          break;
        }
        case "dismiss": {
          const { request, reason } = decision;
          record(request, { skill: null, status: "dismissed", detail: reason });
          break;
        }
        case "revoke": {
          // The same reason a fresh request from this repository would get, so
          // the two spellings of "no rule names it" cannot drift apart.
          const reason: DismissReason = "no_automation";
          store.finish(decision.runId, "dismissed", reason);
          notes.push(`revoked queued run ${decision.runId}: no rule names its repository`);
          break;
        }
        case "retarget": {
          const { runId, headSha, skill } = decision;
          store.retarget(runId, { headSha, skill });
          notes.push(`retargeted run ${runId} to ${headSha.slice(0, 7)} (${skill})`);
          break;
        }
        case "hold":
          // Nothing durable: the run stays queued, and the returned decision
          // keeps it out of this cycle's claim.
          break;
        case "supersede": {
          // Only ever a queued run, so there is no process to stop and no
          // checkout to remove — see `reconcile.ts`.
          store.finish(decision.runId, "superseded", `replaced by event ${decision.byEventId}`);
          notes.push(`superseded run ${decision.runId}`);
          break;
        }
      }
    }
  });

  // After the commit: a log line is a claim that something happened.
  for (const note of notes) log(note);
  return decisions;
}

/**
 * Carry out one claimed review.
 *
 * The caller decides when: one at a time, and not configurable. Two reviews of
 * the same repository would race over one bare clone — creating it, fetching
 * into it, adding worktrees to it — and this is a background process on a
 * laptop, where throughput was never the point.
 *
 * `executeRun` records expected checkout and agent failures, so a rejection
 * escaping it means the runner itself is broken. The row is marked as
 * best-effort bookkeeping and the error rethrown; swallowing it would turn a
 * failing database into an endless stream of individually failed reviews.
 */
async function startRun(runtime: Runtime, run: ReviewRun): Promise<void> {
  try {
    await executeRun(runtime, run);
  } catch (error) {
    try {
      runtime.store.finish(run.id, "failed", message(error));
    } catch {
      // The store is what just failed; the original error is the one to report.
    }
    throw error;
  }
}

/**
 * Remove worktrees whose retention has elapsed.
 *
 * By default, a finished review keeps its checkout for a day so the reviewer
 * can look at what Claude looked at. Nothing more elaborate than a configurable
 * TTL until a disk actually fills — the revision is still on GitHub and the
 * transcript is still in the log.
 */
export async function reapWorktrees(runtime: Runtime, now = new Date()): Promise<number> {
  let removed = 0;
  for (const { id, worktreePath } of runtime.store.expiredWorktrees(now)) {
    const run = runtime.store.get(id);
    if (run) {
      try {
        await removeWorktree(runtime.paths.repoDir(run.repo), worktreePath);
      } catch (error) {
        // A directory that will not delete is worth retrying next tick. The
        // store calls around this one are not wrapped: a database that has
        // stopped working is not a cleanup problem.
        runtime.log(`could not remove ${worktreePath}: ${message(error)}`);
        continue;
      }
    }
    runtime.store.setWorktree(id, null);
    removed += 1;
  }
  return removed;
}

/**
 * Queued runs ahead of the next claimable one whose skill did not pass the
 * preflight — missing, unreadable, reserved, or not left invocable by its own
 * front matter. They stay queued: this is a broken local setup, not a failed
 * review, and the measured failure modes exit successfully without reviewing
 * anything. `executeRun` takes this check and the identity check again once the
 * checkout is ready, since preparing one can clone.
 *
 * It stops at the first run that passes, which is the run `claimNext` is about
 * to take: `activeRuns` and `claimNext` order the queue the same way. Scanning
 * further would age the answer for the row actually claimed, and read files for
 * runs this cycle cannot reach.
 *
 * Per run, not per config: one misspelled rule holds the repositories it names
 * and nothing else.
 */
function skillHolds(runtime: Runtime, exclude: readonly string[]): string[] {
  const held: string[] = [];
  for (const run of runtime.store.activeRuns()) {
    if (run.status !== "queued" || exclude.includes(run.id)) continue;
    // A queued run with no skill is the store disagreeing with itself, and
    // `executeRun` is where that is refused and recorded. It is still the run
    // `claimNext` will take, so the scan ends here either way.
    if (!run.skill) break;
    const problem = skillPreflightProblem(run.skill);
    if (!problem) break;
    held.push(run.id);
    runtime.log(
      `holding ${run.repo}#${run.pullNumber}: review skill ${run.skill} — ${problem}`,
    );
  }
  return held;
}

/** Runs reconciliation judged ineligible this cycle; they stay queued. */
function heldRuns(decisions: readonly ReviewDecision[]): string[] {
  return decisions.filter((d) => d.kind === "hold").map((d) => d.runId);
}

/**
 * One cycle, with the review awaited: one poll, at most one review.
 *
 * Used by `engwire run --once` and by tests, with the same shape as one
 * `runLoop` iteration. Limiting a cycle prevents later backlog entries from
 * using eligibility evidence gathered before an earlier, potentially long
 * review.
 */
export async function tickOnce(runtime: Runtime): Promise<void> {
  if (await accountMatches(runtime)) {
    const held = heldRuns(await pollAndSchedule(runtime));
    // Again after the poll, as `runLoop` does: `gh auth switch` during those
    // seconds would have the review post as somebody else, and the claim it
    // consumes is not the switched account's to spend.
    if (await accountMatches(runtime)) {
      // The preflight is last, with nothing awaited between it and the claim.
      // Taken before the account check, it would be answering about a
      // filesystem that had a `gh` subprocess worth of time to change.
      const run = runtime.store.claimNext({ exclude: [...held, ...skillHolds(runtime, held)] });
      if (run) await startRun(runtime, run);
    }
  }
  await reapWorktrees(runtime);
}

export async function runLoop(runtime: Runtime, signal: AbortSignal): Promise<void> {
  let inFlight: Promise<void> | null = null;
  let broken: unknown;

  while (!signal.aborted) {
    // A review that failed in a way `executeRun` does not model is the runner
    // being broken, and it is noticed here because the loop deliberately does
    // not await the review it started.
    if (broken) throw broken;

    // Evidence for *this* cycle, and nothing is claimed without it. Carrying a
    // previous cycle's answer forward would prevent an outage promoting work
    // that was judged ineligible, but still permit the mirror image: work last
    // seen as eligible starting long after that observation stopped being
    // current. Both are the same mistake. A poll that fails simply means no
    // review starts. Waiting for the next poll is safer than using stale
    // evidence.
    //
    // The list is the run ids reconciliation held; `null` is the separate fact
    // that this cycle produced no evidence at all. The skill preflight is not
    // in it — that is taken immediately before the claim, since a reaper and a
    // `gh` subprocess run between here and there.
    let held: string[] | null = null;
    try {
      if (await accountMatches(runtime)) {
        held = heldRuns(await pollAndSchedule(runtime));
      }
    } catch (error) {
      // GitHub being briefly unavailable is the one failure worth surviving,
      // and `GhError` is exactly that. A SQLite write that fails, or a bug in
      // reconciliation, is not a transient poll problem — logging those once a
      // minute forever would keep a broken runner alive and quiet.
      if (!(error instanceof GhError)) throw error;
      runtime.log(`poll failed: ${error.message}`);
    }

    // Checked again after the poll, not only before it. A poll takes seconds
    // and starting a review can commit to twenty minutes, so beginning one
    // after launchd asked the runner to stop is the difference between shutting
    // down and being SIGKILLed partway through a review.
    if (signal.aborted) break;

    if (!inFlight) {
      // Reclaiming runs `git worktree prune` against a bare clone, and a review
      // starting up is about to fetch into and add worktrees to that same
      // clone. One at a time means one git mutator at a time, so the reaper
      // only runs while nothing is being reviewed — retaining a checkout for
      // one more poll interval is safer than racing those mutations.
      await reapWorktrees(runtime);

      // Fresh evidence, then identity, then shutdown, then the preflight and
      // the claim with nothing awaited between them. The abort check belongs
      // after the account check and not only before the reaper: both of those
      // await, and a SIGTERM arriving inside either would otherwise start a
      // twenty-minute review that launchd is already counting down to kill.
      const run =
        held !== null && (await accountMatches(runtime)) && !signal.aborted
          ? runtime.store.claimNext({ exclude: [...held, ...skillHolds(runtime, held)] })
          : null;
      if (run) {
        const started = startRun(runtime, run);
        inFlight = started;
        // Attached once, to the promise just created. Re-attaching on every
        // poll while a review runs would accumulate a handler per minute.
        void started.then(
          () => {
            inFlight = null;
          },
          (error) => {
            inFlight = null;
            broken = error;
          },
        );
      }
    }

    if (signal.aborted) break;
    await sleep(runtime.config.advanced.pollIntervalMs, signal);
  }

  // A review already under way is awaited; that is the promise the run states
  // make, and the plist's ExitTimeOut is sized for it. Its rejection is already
  // observed above, so this only waits.
  await inFlight?.catch(() => {});
  if (broken) throw broken;
}

/**
 * Wait, unless we are stopping. Both paths clean up after themselves.
 *
 * `{ once: true }` removes the listener when abort fires — but the normal exit
 * is the timer, which fires every poll and leaves the listener attached. A
 * runner polling all day would accumulate one per minute.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // An abort that already happened fires no event, so a listener registered
  // now would never run and this would sleep out the full interval.
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
