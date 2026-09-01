import { describe, expect, test } from "bun:test";
import type { ReviewAutomation } from "../config/config.ts";
import type { ReviewRequest, ReviewRun } from "./model.ts";
import { reconcileReviews } from "./reconcile.ts";

function request(over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    eventId: "1",
    repo: "acme/api",
    pullNumber: 42,
    headSha: "a".repeat(40),
    title: "Add widgets",
    requestedAt: "2026-08-01T10:00:00Z",
    isDraft: false,
    isFork: false,
    ...over,
  };
}

function run(over: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: "run-1",
    eventId: "0",
    repo: "acme/api",
    pullNumber: 42,
    headSha: "a".repeat(40),
    title: "Add widgets",
    skill: "review-pr",
    status: "queued",
    worktreePath: null,
    retainUntil: null,
    detail: null,
    requestedAt: "2026-08-01T09:00:00Z",
    createdAt: "2026-08-01T09:00:00Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

const anyRepo: ReviewAutomation = { repos: ["*"], skill: "review-pr", skipDrafts: true };

const base = {
  automations: [anyRepo],
  activeRuns: [] as ReviewRun[],
  handledEventIds: new Set<string>(),
};

describe("reconcileReviews", () => {
  test("enqueues a fresh request against a matching rule", () => {
    const decisions = reconcileReviews({ ...base, requests: [request()] });
    expect(decisions).toEqual([
      { kind: "enqueue", request: request(), automation: anyRepo },
    ]);
  });

  test("ignores a request it has already recorded", () => {
    const decisions = reconcileReviews({
      ...base,
      requests: [request({ eventId: "7" })],
      handledEventIds: new Set(["7"]),
    });
    expect(decisions).toEqual([]);
  });

  test("a second request on an unchanged revision is a second review", () => {
    // The point of identifying a request by its GitHub event rather than by
    // (repo, pull, sha): re-requesting review of the same commit is a real ask.
    const first = request({ eventId: "1", requestedAt: "2026-08-01T10:00:00Z" });
    const second = request({ eventId: "2", requestedAt: "2026-08-02T10:00:00Z" });

    const decisions = reconcileReviews({
      ...base,
      requests: [second],
      handledEventIds: new Set([first.eventId]),
    });

    expect(decisions).toEqual([{ kind: "enqueue", request: second, automation: anyRepo }]);
  });

  test("dismisses a request when no rule names its repository", () => {
    const decisions = reconcileReviews({
      ...base,
      automations: [{ repos: ["other/*"], skill: "review-pr", skipDrafts: true }],
      requests: [request()],
    });
    expect(decisions).toEqual([
      { kind: "dismiss", request: request(), reason: "no_automation" },
    ]);
  });

  test("holds a draft rather than recording it, so it can be reviewed later", () => {
    // Marking a draft ready does not re-request the reviewers it already had,
    // so a dismissal here would consume the only event Engwire ever sees.
    const draft = request({ isDraft: true });
    expect(reconcileReviews({ ...base, requests: [draft] })).toEqual([]);

    // Nothing was recorded, so the same event is acted on once it is ready.
    expect(reconcileReviews({ ...base, requests: [{ ...draft, isDraft: false }] })).toEqual([
      { kind: "enqueue", request: { ...draft, isDraft: false }, automation: anyRepo },
    ]);

    const permissive: ReviewAutomation = { repos: ["*"], skill: "review-pr", skipDrafts: false };
    expect(
      reconcileReviews({ ...base, automations: [permissive], requests: [draft] }),
    ).toEqual([{ kind: "enqueue", request: draft, automation: permissive }]);
  });

  test("keeps only the newest request per pull request, and records the rest", () => {
    const older = request({ eventId: "1", requestedAt: "2026-08-01T10:00:00Z" });
    const newer = request({ eventId: "2", requestedAt: "2026-08-01T12:00:00Z" });

    const decisions = reconcileReviews({ ...base, requests: [newer, older] });

    expect(decisions).toEqual([
      { kind: "dismiss", request: older, reason: "superseded_by_newer" },
      { kind: "enqueue", request: newer, automation: anyRepo },
    ]);
  });

  test("supersedes a queued run when its pull request is re-requested", () => {
    const queued = run({ id: "run-old" });
    const decisions = reconcileReviews({
      ...base,
      requests: [request({ eventId: "9" })],
      activeRuns: [queued],
    });

    expect(decisions).toContainEqual({
      kind: "supersede",
      runId: "run-old",
      byEventId: "9",
    });
  });

  test("never cancels a review already running", () => {
    // Killing Claude mid-review could truncate a review it has already begun
    // posting. A redundant second review is the cheaper mistake.
    const running = run({ id: "run-old", status: "running", startedAt: "2026-08-01T09:00:01Z" });
    const decisions = reconcileReviews({
      ...base,
      requests: [request({ eventId: "9" })],
      activeRuns: [running],
    });
    expect(decisions.some((d) => d.kind === "supersede")).toBe(false);
  });

  test("a running review is frozen, however the pull request has moved", () => {
    // Reconciliation never changes a running target. If a pre-agent check gives
    // the claim back, it becomes queued and a later poll can retarget it.
    const running = run({ status: "running", startedAt: "2026-08-01T09:00:01Z" });
    const decisions = reconcileReviews({
      ...base,
      automations: [{ repos: ["*"], skill: "review-payments", skipDrafts: true }],
      requests: [request({ headSha: "b".repeat(40), isDraft: true })],
      handledEventIds: new Set(["1"]),
      activeRuns: [running],
    });
    expect(decisions).toEqual([]);
  });

  test("leaves queued runs on other pull requests alone", () => {
    const other = run({ id: "run-other", pullNumber: 7 });
    const decisions = reconcileReviews({
      ...base,
      requests: [request()],
      activeRuns: [other],
    });
    expect(decisions.some((d) => d.kind === "supersede")).toBe(false);
  });

  test("a held draft still supersedes the queued review it replaces", () => {
    // The held request is going somewhere, so the queued one is answering a
    // stale question. Leaving it would review the pull request now and again
    // once it is ready.
    const queued = run({ id: "run-old" });
    const draft = request({ eventId: "9", isDraft: true });
    const decisions = reconcileReviews({ ...base, requests: [draft], activeRuns: [queued] });

    expect(decisions).toEqual([{ kind: "supersede", runId: "run-old", byEventId: "9" }]);
  });

  test("a permanently dismissed request does not supersede queued work", () => {
    // A fork request is going nowhere, so dropping the queued review for it
    // would lose the review altogether rather than replace it.
    const queued = run({ id: "run-old" });
    const decisions = reconcileReviews({
      ...base,
      requests: [request({ eventId: "9", isFork: true })],
      activeRuns: [queued],
    });
    expect(decisions.some((d) => d.kind === "supersede")).toBe(false);
  });

  test("a draft fork is recorded as a fork, the reason that will not change", () => {
    const both = request({ isFork: true, isDraft: true });
    expect(reconcileReviews({ ...base, requests: [both] })).toEqual([
      { kind: "dismiss", request: both, reason: "fork" },
    ]);
  });

  test("dismisses a pull request opened from a fork", () => {
    // A rule names the *base* repository. Anyone may open a pull request into
    // it, and reviewing means running an agent on the branch's contents.
    const fork = request({ isFork: true });
    expect(reconcileReviews({ ...base, requests: [fork] })).toEqual([
      { kind: "dismiss", request: fork, reason: "fork" },
    ]);
  });

  test("a queued run follows the pull request head until it is claimed", () => {
    // A run can wait long enough for the author to push. Reviewing the revision
    // that was current when it was scheduled would comment on code that moved.
    const queued = run({ id: "run-1", eventId: "1", headSha: "a".repeat(40) });
    const pushed = request({ eventId: "1", headSha: "b".repeat(40) });

    expect(
      reconcileReviews({
        ...base,
        requests: [pushed],
        activeRuns: [queued],
        handledEventIds: new Set(["1"]),
      }),
    ).toEqual([
      { kind: "retarget", runId: "run-1", headSha: "b".repeat(40), skill: "review-pr" },
    ]);
  });

  test("a queued run uses the skill from the current rule", () => {
    const queued = run({ id: "run-1", eventId: "1", skill: "review-pr" });
    const payments: ReviewAutomation = {
      repos: ["*"],
      skill: "review-payments",
      skipDrafts: true,
    };

    expect(
      reconcileReviews({
        ...base,
        automations: [payments],
        requests: [request({ eventId: "1" })],
        activeRuns: [queued],
        handledEventIds: new Set(["1"]),
      }),
    ).toEqual([
      {
        kind: "retarget",
        runId: "run-1",
        headSha: "a".repeat(40),
        skill: "review-payments",
      },
    ]);
  });

  test("a held draft is still retargeted, so it starts on the latest revision", () => {
    const queued = run({ id: "run-1", eventId: "1", headSha: "a".repeat(40) });
    const pushed = request({ eventId: "1", headSha: "b".repeat(40), isDraft: true });

    expect(
      reconcileReviews({
        ...base,
        requests: [pushed],
        activeRuns: [queued],
        handledEventIds: new Set(["1"]),
      }),
    ).toEqual([
      { kind: "retarget", runId: "run-1", headSha: "b".repeat(40), skill: "review-pr" },
      { kind: "hold", runId: "run-1" },
    ]);
  });

  test("holds a queued run whose pull request went back to draft", () => {
    // The event is already recorded, so it cannot be dismissed — GitHub may
    // never re-request the reviewer once it is ready again. It waits instead.
    const queued = run({ id: "run-1", eventId: "1" });
    const handled = request({ eventId: "1", isDraft: true });

    const decisions = reconcileReviews({
      ...base,
      requests: [handled],
      activeRuns: [queued],
      handledEventIds: new Set(["1"]),
    });

    expect(decisions).toEqual([{ kind: "hold", runId: "run-1" }]);
  });

  test("stops holding once the pull request is ready again", () => {
    const queued = run({ id: "run-1", eventId: "1" });
    const decisions = reconcileReviews({
      ...base,
      requests: [request({ eventId: "1", isDraft: false })],
      activeRuns: [queued],
      handledEventIds: new Set(["1"]),
    });
    expect(decisions).toEqual([]);
  });

  test("a rule that stops skipping drafts releases the run it was holding", () => {
    // Queued work is judged against today's rule, both halves of it.
    const queued = run({ id: "run-1", eventId: "1" });
    const permissive: ReviewAutomation = { repos: ["*"], skill: "review-pr", skipDrafts: false };
    const decisions = reconcileReviews({
      ...base,
      automations: [permissive],
      requests: [request({ eventId: "1", isDraft: true })],
      activeRuns: [queued],
      handledEventIds: new Set(["1"]),
    });
    expect(decisions).toEqual([]);
  });

  test("revokes a queued run whose repository is no longer configured", () => {
    // `repos` gates where an agent runs, so removing a repository has to stop
    // work that was queued while it was still allowed.
    const queued = run({ id: "run-old", repo: "acme/removed" });
    const decisions = reconcileReviews({
      ...base,
      automations: [{ repos: ["acme/api"], skill: "review-pr", skipDrafts: true }],
      requests: [],
      activeRuns: [queued],
    });
    expect(decisions).toEqual([{ kind: "revoke", runId: "run-old" }]);
  });

  test("leaves a queued run alone while it is still being asked for", () => {
    const queued = run({ id: "run-old", eventId: "1" });
    const decisions = reconcileReviews({
      ...base,
      requests: [request({ eventId: "1" })],
      activeRuns: [queued],
      handledEventIds: new Set(["1"]),
    });
    expect(decisions).toEqual([]);
  });

  test("holds a queued run when its pull request no longer asks for review", () => {
    // Discovery returns open pull requests that still request this reviewer.
    // Absence means withdrawn, closed, or already reviewed by hand — and it
    // can also mean the search index lagged, so the run waits rather than
    // being consumed.
    const queued = run({ id: "run-old", eventId: "1" });
    const decisions = reconcileReviews({
      ...base,
      requests: [],
      activeRuns: [queued],
      handledEventIds: new Set(["1"]),
    });
    expect(decisions).toEqual([{ kind: "hold", runId: "run-old" }]);
  });

  test("same-second requests are ordered by event id as a number", () => {
    // GitHub timestamps resolve to the second, so the tie-break decides which
    // ask is newest. Lexicographically "9" sorts after "10"; numerically it
    // does not, and event 10 is the later one.
    const at = "2026-08-01T10:00:00Z";
    const nine = request({ eventId: "9", requestedAt: at });
    const ten = request({ eventId: "10", requestedAt: at });

    expect(reconcileReviews({ ...base, requests: [nine, ten] })).toEqual([
      { kind: "dismiss", request: nine, reason: "superseded_by_newer" },
      { kind: "enqueue", request: ten, automation: anyRepo },
    ]);
  });

  test("is order independent, including two asks on one pull request", () => {
    const a = request({ eventId: "1", pullNumber: 1, requestedAt: "2026-08-01T10:00:00Z" });
    const b = request({ eventId: "2", pullNumber: 2, requestedAt: "2026-08-01T11:00:00Z" });
    expect(reconcileReviews({ ...base, requests: [a, b] })).toEqual(
      reconcileReviews({ ...base, requests: [b, a] }),
    );

    // The case where order could actually change the outcome: same pull
    // request, same second, so only the event id decides which one survives.
    const at = "2026-08-01T10:00:00Z";
    const nine = request({ eventId: "9", requestedAt: at });
    const ten = request({ eventId: "10", requestedAt: at });
    expect(reconcileReviews({ ...base, requests: [nine, ten] })).toEqual(
      reconcileReviews({ ...base, requests: [ten, nine] }),
    );
  });

  test("first matching rule wins, so the specific one can precede the catch-all", () => {
    const payments: ReviewAutomation = {
      repos: ["acme/payments"],
      skill: "review-payments",
      skipDrafts: true,
    };
    const decisions = reconcileReviews({
      ...base,
      automations: [payments, anyRepo],
      requests: [request({ repo: "acme/payments" })],
    });
    expect(decisions[0]).toMatchObject({ kind: "enqueue", automation: payments });
  });
});
