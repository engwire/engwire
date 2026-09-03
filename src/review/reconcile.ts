/**
 * @file Pure scheduling decisions for review requests and queued runs.
 *
 * Keeping this pure makes duplicate reviews, stale revisions and repository
 * authorization testable with plain objects, without GitHub, git or Claude.
 *
 * Scheduling only. Worktree cleanup and crash recovery have different
 * invariants and different inputs, so they are separate operations rather than
 * branches of one planner.
 *
 * Note what is *not* here: concurrency. Reconcile decides which runs should
 * exist; the loop decides how many execute at once. Withholding a decision for
 * capacity would leave it unrecorded, so the next poll would rediscover it and
 * the queue order would depend on polling luck.
 */

import { matchesRepo, type ReviewAutomation } from "../config/config.ts";
import { pullKey, type ReviewRequest, type ReviewRun } from "./model.ts";

export type DismissReason =
  /** No `[[review]]` rule names this repository. */
  | "no_automation"
  /** The pull request comes from a fork; see below. */
  | "fork"
  /** A newer request for the same pull request appeared in this poll. */
  | "superseded_by_newer";

export type ReviewDecision =
  | { kind: "enqueue"; request: ReviewRequest; automation: ReviewAutomation }
  | { kind: "dismiss"; request: ReviewRequest; reason: DismissReason }
  /** Drop a run that has not started yet in favour of a newer request. */
  | { kind: "supersede"; runId: string; byEventId: string }
  /** Drop a queued run whose repository is no longer configured for review. */
  | { kind: "revoke"; runId: string }
  /**
   * Point a queued run at the pull request's current head, and at the skill
   * today's rule names. Same request, same row — only what it will execute.
   */
  | { kind: "retarget"; runId: string; headSha: string; skill: string }
  /**
   * Leave a queued run where it is, but do not start it this cycle.
   *
   * The only decision with no durable effect. Every other kind moves a row;
   * this one says the row is currently ineligible and will be reconsidered on
   * the next poll, so nothing is written down.
   */
  | { kind: "hold"; runId: string };

/**
 * GitHub issue-event ids are integers, and the store orders them as integers. A
 * lexical fallback for values the API cannot produce would only be a second,
 * disagreeing definition of "newest"; `BigInt` throws instead, and needs no
 * opinion about how large an id may become.
 */
function byEventId(a: ReviewRequest, b: ReviewRequest): number {
  const left = BigInt(a.eventId);
  const right = BigInt(b.eventId);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function reconcileReviews(input: {
  requests: readonly ReviewRequest[];
  automations: readonly ReviewAutomation[];
  /** Runs currently `queued` or `running`. */
  activeRuns: readonly ReviewRun[];
  /** Event ids already recorded, in any status. */
  handledEventIds: ReadonlySet<string>;
}): ReviewDecision[] {
  // Oldest first, tie-broken by id so two requests sharing a timestamp cannot
  // swap places between polls and produce different decisions. GitHub's
  // timestamps only resolve to the second, so the tie-break decides which of
  // two same-second asks is "newest" — and it has to compare the ids as the
  // numbers they are. Lexicographically, "9" sorts after "10".
  const fresh = input.requests
    .filter((request) => !input.handledEventIds.has(request.eventId))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || byEventId(a, b));

  // Ascending order means the last write per pull request is the newest.
  const newest = new Map<string, ReviewRequest>();
  for (const request of fresh) newest.set(pullKey(request), request);

  // Every request, not just the unhandled ones, and absence matters as much as
  // presence. An event already acted on is useless as a *new* decision, but it
  // is evidence that the pull request still asks this reviewer for a review,
  // and it carries that pull request's state as of this poll.
  const currentRequestsByPull = new Map<string, ReviewRequest>();
  for (const request of input.requests) currentRequestsByPull.set(pullKey(request), request);

  const decisions: ReviewDecision[] = [];
  // Requests that make an older queued run stale. An enqueued request does;
  // so does a held draft, which is why this is not simply "what was enqueued".
  // A permanently dismissed request does not: it is going nowhere, so dropping
  // queued work for it would lose the review entirely.
  const superseding = new Map<string, ReviewRequest>();

  for (const request of fresh) {
    const key = pullKey(request);

    // Older siblings are dismissed rather than ignored. An unrecorded request
    // is rediscovered on every poll, forever.
    if (newest.get(key) !== request) {
      decisions.push({ kind: "dismiss", request, reason: "superseded_by_newer" });
      continue;
    }

    const automation = input.automations.find((rule) =>
      rule.repos.some((pattern) => matchesRepo(pattern, request.repo)),
    );
    if (!automation) {
      // Recorded, and therefore permanent for *this* request: adding a rule
      // later does not resurrect one already seen and passed over. A surprise
      // review of a month-old pull request is worse than a missed one the
      // reviewer can re-request.
      decisions.push({ kind: "dismiss", request, reason: "no_automation" });
      continue;
    }

    // Before the draft check, because a pull request can be both and only one
    // of the two answers is actionable: the author can mark a draft ready, but
    // nothing can make a fork eligible. The durable reason is the useful one
    // to record.
    //
    // `repos` names the *base* repository, and anyone may open a pull request
    // into it from a fork. Matching a rule therefore says the change is being
    // proposed somewhere trusted, not that it came from someone trusted — and
    // what Engwire does next is start an agent on the branch's contents. Forks
    // are therefore refused rather than treated as authorized by the base
    // repository's rule.
    if (request.isFork) {
      decisions.push({ kind: "dismiss", request, reason: "fork" });
      continue;
    }

    // Held, not dismissed — the one place a request is deliberately left
    // unrecorded. GitHub does not reliably emit a fresh `review_requested`
    // when a draft becomes ready for reviewers it already had, so recording
    // this event would consume the only request Engwire is going to see.
    // Discovery re-reads every candidate's events each poll, so the request
    // simply waits until the pull request is ready, is withdrawn, or closes.
    //
    // It still makes an older queued run stale: that run is answering a
    // question this request has replaced, and letting it proceed would review
    // the pull request now *and* again once it is ready.
    if (request.isDraft && automation.skipDrafts) {
      superseding.set(key, request);
      continue;
    }

    decisions.push({ kind: "enqueue", request, automation });
    superseding.set(key, request);
  }

  // A queued review of a pull request that has just been re-requested is
  // answering a stale question, and nothing has happened yet, so replacing it
  // costs nothing.
  //
  // A *running* one is left alone. Cancelling it would mean killing Claude and
  // deleting the directory it is working in, with no way to know whether it had
  // already posted its review — and an extra review is a smaller harm than a
  // truncated one. Once a review starts, it finishes.
  for (const run of input.activeRuns) {
    if (run.status !== "queued") continue;

    // Queued work is re-judged against today's rule, not the one that scheduled
    // it. `repos` is an authorization boundary: removing a repository must not
    // be followed by a review of it queued under the old configuration.
    const automation = input.automations.find((rule) =>
      rule.repos.some((pattern) => matchesRepo(pattern, run.repo)),
    );
    if (!automation) {
      decisions.push({ kind: "revoke", runId: run.id });
      continue;
    }

    const replacement = superseding.get(pullKey(run));
    if (replacement) {
      decisions.push({ kind: "supersede", runId: run.id, byEventId: replacement.eventId });
      continue;
    }

    // A queued run may start only on positive evidence that it is still
    // wanted. Discovery returns open pull requests that currently request this
    // reviewer, so a run whose pull request is missing from this poll has had
    // its request withdrawn, been closed, or already been reviewed by hand —
    // every reading of which says do not start it. It may also be nothing worse
    // than GitHub's search index lagging, which is why this holds rather than
    // dismisses: a held run costs a poll, a wrong one costs a review nobody
    // asked for.
    const current = currentRequestsByPull.get(pullKey(run));
    if (!current) {
      decisions.push({ kind: "hold", runId: run.id });
      continue;
    }

    // A queued run follows the pull request until the moment it is claimed.
    // A run can wait long enough for the author to push several times;
    // reviewing the revision that was current when it was scheduled would post
    // comments on code that has since moved. Pinning still happens, just at the
    // last poll before the run is claimed. The skill comes from today's rule
    // for the same reason `repos` and `skip_drafts` do: queued work is judged
    // against the configuration in force, not the one it was born under.
    if (current.headSha !== run.headSha || automation.skill !== run.skill) {
      decisions.push({
        kind: "retarget",
        runId: run.id,
        headSha: current.headSha,
        skill: automation.skill,
      });
    }

    // The other half of the same rule. An author can convert a pull request
    // back to draft after a review was queued for it, and `skip_drafts` means
    // "do not run an agent on a draft", not "the draft state when we happened
    // to schedule it". This cannot be a dismissal either: the request is
    // already recorded, and GitHub may never re-request the reviewer once it is
    // ready again, so consuming it here would lose the review for good.
    if (automation.skipDrafts && current.isDraft) {
      decisions.push({ kind: "hold", runId: run.id });
    }
  }

  return decisions;
}
