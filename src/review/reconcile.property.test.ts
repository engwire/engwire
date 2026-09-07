/**
 * @file Scheduling invariants checked against deterministic generated inputs.
 *
 * Complements the named cases in `reconcile.test.ts` with decision-set equality and request-order independence across bounded fixture pools. Failures report a seed for reproduction; no GitHub, git or database is involved.
 */

import { describe, expect, test } from "bun:test";
import { matchesRepo, type ReviewAutomation } from "../config/config.ts";
import type { ReviewRequest, ReviewRun } from "./model.ts";
import { reconcileReviews, type ReviewDecision } from "./reconcile.ts";

/** Deterministic generator so a failing seed reproduces the input. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32: short, and its period is far past anything used here.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Small pools make collisions common. */
const REPOS = ["acme/api", "acme/web", "other/tool", "Acme/API"];
/** Numeric and lexical order differ, exposing incorrect same-timestamp tie-breaks. */
const EVENT_IDS = ["9", "10", "99", "100", "101", "1000", "2", "20"];
const SKILLS = ["review-pr", "review-legacy"];
const TIMES = ["2026-08-01T10:00:00Z", "2026-08-01T10:00:01Z", "2026-08-01T11:00:00Z"];

/**
 * Rule arrangements `parseConfig` accepts, drawn whole rather than assembled
 * pattern by pattern.
 *
 * Independent patterns produce shadowed rules — `["*", "acme/api"]`, or
 * anything at all after a `*` — which the parser refuses, so no config reaching
 * `reconcileReviews` can look like that. The empty list is absent for a
 * stronger reason: `run.ts` refuses to start without rules precisely so that
 * nothing is dismissed `no_automation` wholesale, and a third of these seeds
 * used to do nothing but that. `nobody/here` is how the reachable
 * `no_automation` still gets generated.
 */
const RULE_SETS: readonly (readonly string[][])[] = [
  [["acme/api"]],
  [["*"]],
  [["nobody/here"]],
  // Specific before wildcard, which is the arrangement the README teaches and
  // the only valid way two rules can both match one repository.
  [["acme/api"], ["acme/*"]],
  [["acme/*"], ["other/tool"]],
  // Several patterns in one rule, so `repos.some(...)` is not indistinguishable
  // from looking at `repos[0]`.
  [["acme/api", "other/tool"]],
];

function generate(next: () => number): {
  requests: ReviewRequest[];
  automations: ReviewAutomation[];
  activeRuns: ReviewRun[];
  handledEventIds: Set<string>;
} {
  const pick = <T,>(from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;
  const count = (max: number) => Math.floor(next() * (max + 1));

  // Discovery stamps one current snapshot onto all events for a candidate.
  // Keep siblings consistent so permutation tests only vary request order.
  const snapshots = new Map<string, { headSha: string; isDraft: boolean; isFork: boolean }>();
  const snapshotOf = (repo: string, pullNumber: number) => {
    const key = `${repo}#${pullNumber}`;
    const found = snapshots.get(key);
    if (found) return found;
    const made = {
      headSha: String(Math.floor(next() * 4)).repeat(40),
      isDraft: next() < 0.4,
      isFork: next() < 0.25,
    };
    snapshots.set(key, made);
    return made;
  };

  // Event ids are unique, as required by the store; distinct events can share a pull.
  const ids = [...EVENT_IDS];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }

  const requests: ReviewRequest[] = [];
  for (let i = 0; i < count(6); i++) {
    const repo = pick(REPOS);
    const pullNumber = 1 + Math.floor(next() * 3);
    requests.push({
      eventId: ids[i]!,
      repo,
      pullNumber,
      title: "t",
      requestedAt: pick(TIMES),
      ...snapshotOf(repo, pullNumber),
    });
  }

  const automations: ReviewAutomation[] = pick(RULE_SETS).map((repos) => ({
    repos: [...repos],
    skill: pick(SKILLS),
    skipDrafts: next() < 0.6,
  }));

  const activeRuns: ReviewRun[] = [];
  // The requests a run was recorded from, which is what made them handled.
  // Taken without replacement: `UNIQUE(event_id)` means one event produced at
  // most one run, so two active runs sharing an id is a row the store refuses.
  const recordedByRuns = new Set<string>();
  const unrecorded = [...requests];
  for (let i = 0; i < count(3); i++) {
    // Rediscovered handled events still provide current PR state for queued runs.
    // Unrelated runs also exercise holds when discovery provides no evidence.
    const from =
      unrecorded.length > 0 && next() < 0.5
        ? unrecorded.splice(Math.floor(next() * unrecorded.length), 1)[0]
        : undefined;
    if (from) recordedByRuns.add(from.eventId);
    activeRuns.push({
      id: `run-${i}`,
      eventId: from?.eventId ?? String(50 + i),
      repo: from?.repo ?? pick(REPOS),
      pullNumber: from?.pullNumber ?? 1 + Math.floor(next() * 3),
      headSha: String(Math.floor(next() * 4)).repeat(40),
      title: "t",
      skill: pick(SKILLS),
      status: next() < 0.7 ? "queued" : "running",
      worktreePath: null,
      retainUntil: null,
      detail: null,
      requestedAt: pick(TIMES),
      createdAt: pick(TIMES),
      startedAt: null,
      finishedAt: null,
    });
  }

  const handledEventIds = new Set<string>([
    ...requests.filter(() => next() < 0.3).map((r) => r.eventId),
    ...recordedByRuns,
  ]);
  // Closed downwards over each pull: reconciliation records the older siblings
  // as `superseded_by_newer` in the same pass that classifies the newest, so a
  // handled event never leaves an older one still fresh. The reverse does
  // happen and is deliberately kept — a skipped draft is the newest event on
  // its pull and stays unhandled while its older siblings do not.
  for (const request of requests) {
    if (handledEventIds.has(request.eventId)) continue;
    const newerHandled = requests.some(
      (other) =>
        handledEventIds.has(other.eventId) && samePull(other, request) && newer(other, request),
    );
    if (newerHandled) handledEventIds.add(request.eventId);
  }
  return { requests, automations, activeRuns, handledEventIds };
}

/**
 * Keep pull identity independent of production `pullKey` so a missing repository component cannot corrupt both implementation and oracle. `matchesRepo` is shared deliberately: its policy has separate tests.
 */
const samePull = (
  a: { repo: string; pullNumber: number },
  b: { repo: string; pullNumber: number },
) => a.repo === b.repo && a.pullNumber === b.pullNumber;

/** Newer by request timestamp, then numeric event id. */
function newer(a: ReviewRequest, b: ReviewRequest): boolean {
  if (a.requestedAt !== b.requestedAt) return a.requestedAt > b.requestedAt;
  return BigInt(a.eventId) > BigInt(b.eventId);
}

type Input = ReturnType<typeof generate>;

/**
 * Derive the complete decision set from the input, including each decision's payload. Equality checks both missing and unjustified decisions; one-way implications could accept a reconciler that dismisses every request or supersedes every queued run.
 */
function expectedDecisions(input: Input): ReviewDecision[] {
  const fresh = input.requests.filter((r) => !input.handledEventIds.has(r.eventId));
  const ruleFor = (repo: string) =>
    input.automations.find((rule) => rule.repos.some((pattern) => matchesRepo(pattern, repo)));
  const newestFresh = (of: { repo: string; pullNumber: number }) =>
    fresh
      .filter((r) => samePull(r, of))
      .reduce<ReviewRequest | undefined>((best, r) => (best && newer(best, r) ? best : r), undefined);

  const out: ReviewDecision[] = [];

  for (const request of fresh) {
    // Asked as the rule rather than by rebuilding production's answer: a
    // request loses to any newer fresh sibling. Picking the newest and
    // comparing identities would be the algorithm again, one line shorter.
    if (fresh.some((other) => samePull(other, request) && newer(other, request))) {
      out.push({ kind: "dismiss", request, reason: "superseded_by_newer" });
      continue;
    }
    const rule = ruleFor(request.repo);
    if (!rule) {
      out.push({ kind: "dismiss", request, reason: "no_automation" });
      continue;
    }
    // Before the draft check: a draft can be marked ready, a fork can never
    // become eligible, so the durable reason is the one worth recording.
    if (request.isFork) {
      out.push({ kind: "dismiss", request, reason: "fork" });
      continue;
    }
    // The one request left deliberately unrecorded — GitHub may never ask
    // again once the draft is ready, so consuming it here would lose it.
    if (request.isDraft && rule.skipDrafts) continue;
    out.push({ kind: "enqueue", request, automation: rule });
  }

  for (const run of input.activeRuns) {
    // "Scheduling never cancels a running review."
    if (run.status !== "queued") continue;

    const rule = ruleFor(run.repo);
    if (!rule) {
      out.push({ kind: "revoke", runId: run.id });
      continue;
    }

    // Eligible requests and held drafts supersede queued work; dismissed forks do not.
    const replacement = newestFresh(run);
    if (replacement && !replacement.isFork) {
      out.push({ kind: "supersede", runId: run.id, byEventId: replacement.eventId });
      continue;
    }

    // Handled events still carry current PR state. Sibling snapshots agree.
    const current = [...input.requests].reverse().find((r) => samePull(r, run));
    if (!current) {
      out.push({ kind: "hold", runId: run.id });
      continue;
    }
    if (current.headSha !== run.headSha || rule.skill !== run.skill) {
      out.push({ kind: "retarget", runId: run.id, headSha: current.headSha, skill: rule.skill });
    }
    if (rule.skipDrafts && current.isDraft) out.push({ kind: "hold", runId: run.id });
  }

  return out;
}

/**
 * Compare all fields while ignoring object-key and decision order. Discover fields dynamically so future JSON-representable payload additions are checked too. Parsing back gives structural assertion diffs and detaches the expected result from shared input objects.
 */
const canonicalDecisions = (decisions: readonly ReviewDecision[]): unknown[] =>
  decisions
    .map((decision) =>
      JSON.stringify(decision, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    )
    .sort()
    .map((decision): unknown => JSON.parse(decision));

/** Preserve the original error and assertion diff while adding the failing seed. */
function eachSeed(seeds: number, check: (seed: number) => void): void {
  for (let seed = 1; seed <= seeds; seed++) {
    try {
      check(seed);
    } catch (error) {
      if (error instanceof Error) error.message = `seed ${seed}: ${error.message}`;
      throw error;
    }
  }
}

describe("reconcileReviews, over generated inputs", () => {
  test("decides exactly what the input calls for, and nothing besides", () => {
    eachSeed(2_000, (seed) => {
      const input = generate(random(seed));
      // Snapshot expectations first so input mutation cannot change the oracle's answer.
      const want = canonicalDecisions(expectedDecisions(input));

      expect(canonicalDecisions(reconcileReviews(input))).toEqual(want);
    });
  });

  test("answers the same however the poll ordered the requests", () => {
    // Request order must not change the winner: timestamp, then numeric event id.
    eachSeed(500, (seed) => {
      const next = random(seed);
      const input = generate(next);
      const shuffled = [...input.requests];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      // Against the oracle rather than against another call of the same
      // function: two invocations agreeing says only that they agree, and a
      // failure would leave the reader to work out which side was right.
      const want = canonicalDecisions(expectedDecisions(input));

      expect(canonicalDecisions(reconcileReviews({ ...input, requests: shuffled }))).toEqual(want);
    });
  });
});
