/**
 * @file The lifecycle boundary: what the loop must not do once it is stopping.
 *
 * `runLoop` owns daemon scheduling, so it must not start a long-running review
 * after launchd has asked it to stop.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config.ts";
import type { Paths } from "../config/paths.ts";
import { GhError, type Gh } from "../github/gh.ts";
import { Store } from "../store/store.ts";
import type { Runtime } from "./execute.ts";
import { pollAndSchedule, runLoop, tickOnce } from "./loop.ts";

function runtime(over: {
  onPoll: () => void | Promise<void>;
  claimNext?: () => null;
  /** Called with the number of this identity check, before it answers. */
  onLogin?: (nth: number) => void;
  /** Shutdown, which the loop now reads from the runtime it was given. */
  signal?: AbortSignal;
  /** Checkouts past their retention, for the reaper at the end of a cycle. */
  expiredWorktrees?: () => { id: string; worktreePath: string }[];
  /** Called with each run id the reaper looks up, before it answers. */
  onGet?: (id: string) => void;
}): { runtime: Runtime; claims: number; recordedPolls: number; polledInTransaction: boolean } {
  const state = { claims: 0, recordedPolls: 0, polledInTransaction: false };
  // Unusually white-box, and deliberately: *where* the poll is recorded is the
  // contract. It commits with the decisions or not at all, so that a crash
  // between the two cannot leave durable decisions beside a `status` still
  // reporting the previous poll. Recorded outside the transaction again, the
  // store's own rollback test still passes and only this notices.
  let inTransaction = false;
  const store = {
    watchingSince: () => "2026-01-01T00:00:00Z",
    activeRuns: () => [],
    knownEventIds: () => new Set<string>(),
    claimNext: () => {
      state.claims += 1;
      return over.claimNext?.() ?? null;
    },
    expiredWorktrees: () => over.expiredWorktrees?.() ?? [],
    get: (id: string) => {
      over.onGet?.(id);
      return { id, repo: "acme/api" };
    },
    // The reaper clears the row's checkout once it has gone.
    setWorktree: () => {},
    recordPoll: () => {
      state.polledInTransaction = inTransaction;
      state.recordedPolls += 1;
    },
    transaction: <T,>(work: () => T): T => {
      inTransaction = true;
      try {
        return work();
      } finally {
        inTransaction = false;
      }
    },
  } as unknown as Store;

  let logins = 0;
  const gh = {
    json: async () => {
      await over.onPoll();
      return [];
    },
    text: async () => "",
    login: async () => {
      over.onLogin?.(++logins);
      return "me";
    },
  } as unknown as Gh;

  return {
    runtime: {
      store,
      config: { reviews: [], advanced: { pollIntervalMs: 60_000 } } as unknown as Config,
      // The reaper resolves a clone per run. Pointed somewhere absent, so
      // `removeWorktree` deletes the checkout and never reaches the prune,
      // which would spawn a real `git`.
      paths: {
        repoDir: (repo: string) => join(tmpdir(), "engwire-no-such-clone", repo),
      } as unknown as Paths,
      gh,
      login: "me",
      log: () => {},
      cloneUrlFor: (repo) => repo,
      signal: over.signal ?? new AbortController().signal,
    },
    get claims() {
      return state.claims;
    },
    /**
     * Polls that got all the way through to writing their decisions down —
     * which the `polls` counters in these tests, being attempts, are not.
     */
    get recordedPolls() {
      return state.recordedPolls;
    },
    /** Whether that write happened inside the decisions' own transaction. */
    get polledInTransaction() {
      return state.polledInTransaction;
    },
  };
}

describe("a poll that finished", () => {
  test("is recorded only when GitHub answered and the decisions were written", async () => {
    // The distinction `status` is built on. A runner that cannot reach GitHub,
    // or that holds because `gh` is signed in as somebody else, is still a live
    // process with a queue behind it — indistinguishable from one working
    // through a quiet backlog unless something says when it last got through.
    let polls = 0;
    const harness = runtime({
      onPoll: () => {
        // The first poll answers; the second is an outage.
        if (polls++ === 0) return;
        throw new GhError(["search"], 1, "could not resolve host");
      },
    });

    await pollAndSchedule(harness.runtime);
    expect(harness.recordedPolls, "a poll that answered was not recorded").toBe(1);
    // And recorded *with* the decisions, not after them. Outside the
    // transaction, a crash in the gap leaves durable decisions beside a
    // `status` still reporting the previous poll — the report disagreeing with
    // the one fact it exists to make trustworthy. The store's rollback test
    // cannot see this; only the placement can, so the placement is asserted.
    expect(
      harness.polledInTransaction,
      "the poll was recorded outside the transaction that wrote the decisions",
    ).toBe(true);

    await pollAndSchedule(harness.runtime).catch(() => {});

    // Still one. The failed poll must leave the previous time standing, or a
    // wedged runner would keep looking freshly successful.
    expect(harness.recordedPolls, "an outage was recorded as a completed poll").toBe(1);
  });

  test("is not recorded when the account check holds the cycle", async () => {
    // `accountMatches` failing means the cycle never polls at all, so there is
    // nothing to record — and that is exactly the state a reviewer needs to
    // see as a stale time rather than a fresh one.
    const harness = runtime({
      onPoll: () => {},
      onLogin: () => {
        throw new GhError(["api", "user"], 1, "could not resolve host");
      },
    });

    await tickOnce(harness.runtime);

    expect(harness.recordedPolls).toBe(0);
  });
});

describe("runLoop", () => {
  test("does not start a review after shutdown was requested mid-poll", async () => {
    // SIGTERM lands while the poll is in flight. Without a check between the
    // poll and the queue, the runner would begin a fresh review that launchd is
    // already waiting to kill.
    const controller = new AbortController();
    const harness = runtime({
      onPoll: () => controller.abort(),
      claimNext: () => null,
      signal: controller.signal,
    });

    await runLoop(harness.runtime);

    expect(harness.claims).toBe(0);
  });

  test("stops without waiting out the poll interval, even when the poll failed", async () => {
    // The abort fired while the poll was suspended and raises no event a
    // listener registered afterwards would see, so launchd would otherwise wait
    // a full interval on a runner with nothing left to do.
    const controller = new AbortController();
    const harness = runtime({
      onPoll: () => {
        controller.abort();
        throw new GhError(["search", "prs"], 1, "could not resolve host");
      },
      signal: controller.signal,
    });

    const started = Date.now();
    await runLoop(harness.runtime);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(harness.claims).toBe(0);
  });

  test("survives GitHub being unreachable, but not a broken database", async () => {
    // A GitHub outage is worth outliving; a failing store is a broken runner
    // that should stop rather than stay alive and quiet.
    const transient = new AbortController();
    let polls = 0;
    const github = runtime({
      onPoll: () => {
        if (++polls >= 2) transient.abort();
        throw new GhError(["search", "prs"], 1, "could not resolve host");
      },
      signal: transient.signal,
    });
    github.runtime.config.advanced.pollIntervalMs = 1;
    await runLoop(github.runtime);
    expect(polls).toBeGreaterThan(1);

    const fatal = runtime({
      onPoll: () => {
        throw new TypeError("store is not a function");
      },
    });
    expect(runLoop(fatal.runtime)).rejects.toThrow(TypeError);
  });

  test("does not claim a review when shutdown lands during the last identity check", async () => {
    // The window the post-poll check cannot cover: the reaper and the final
    // `gh` call both await, so a SIGTERM arriving inside either would otherwise
    // be noticed only after a twenty-minute review had already started — the
    // exact outcome `service install`, which stops the old service first, would
    // hit.
    const controller = new AbortController();
    const harness = runtime({
      onPoll: () => {},
      // The second is the check immediately before the claim.
      onLogin: (nth) => {
        if (nth === 2) controller.abort();
      },
      signal: controller.signal,
    });

    await runLoop(harness.runtime);

    expect(harness.claims).toBe(0);
  });

  test("shutdown during the first identity check stops before the poll", async () => {
    // Every awaited step is followed by its own check. Noticing a stop only
    // after the poll would buy GitHub a whole search the runner no longer
    // wants, which is what "shutdown does not start work" has to mean for the
    // work that is merely expensive rather than dangerous.
    const controller = new AbortController();
    let polls = 0;
    const harness = runtime({
      onPoll: () => {
        polls += 1;
      },
      onLogin: () => controller.abort(),
      signal: controller.signal,
    });

    await runLoop(harness.runtime);

    expect(polls).toBe(0);
  });

  test("a failed poll claims nothing, even after a successful one", async () => {
    // Preserving the previous cycle's answer would stop an outage promoting
    // work judged ineligible, but still let work last seen as eligible start
    // long after that observation stopped being current. Both are the same
    // mistake, so a cycle without fresh evidence claims nothing at all.
    const controller = new AbortController();
    let polls = 0;
    const harness = runtime({
      onPoll: () => {
        polls += 1;
        if (polls === 1) return; // first cycle succeeds: queue looks runnable
        if (polls >= 3) controller.abort();
        throw new GhError(["search", "prs"], 1, "could not resolve host");
      },
      claimNext: () => null,
      signal: controller.signal,
    });
    harness.runtime.config.advanced.pollIntervalMs = 1;

    await runLoop(harness.runtime);

    // One claim attempt, from the one cycle that had evidence.
    expect(polls).toBeGreaterThan(2);
    expect(harness.claims).toBe(1);
  });
});

/**
 * A poll against a real store.
 *
 * The decisions themselves are covered by `reconcile.test.ts` and the writes by
 * `store.test.ts`; what is untested between them is the wiring — that a
 * decision reaches the row it is about. So this stubs GitHub and nothing else.
 */
function polling(options: {
  detail: Record<string, unknown>;
  events: Record<string, unknown>[];
  skill?: string;
}): { runtime: Runtime; store: Store } {
  const store = new Store(":memory:");
  // Fixed before the poll, because the first call to `watchingSince` is what
  // sets it: left to default it would be *now*, and discovery would filter out
  // every event below as older than the installation itself.
  store.watchingSince(new Date("2026-01-01T00:00:00Z"));
  const responses: Record<string, unknown> = {
    search: [{ number: 42, repository: { nameWithOwner: "acme/api" } }],
    view: {
      headRefOid: "a".repeat(40),
      isDraft: false,
      title: "Add widgets",
      isCrossRepository: false,
      closed: false,
      reviewRequests: [{ login: "me" }],
      ...options.detail,
    },
    events: options.events,
  };
  const gh = {
    json: async <T,>(args: string[]) =>
      responses[args[0] === "search" ? "search" : args[0] === "pr" ? "view" : "events"] as T,
    text: async () => "",
    login: async () => "me",
  } as unknown as Gh;

  return {
    store,
    runtime: {
      store,
      config: {
        reviews: [{ repos: ["acme/*"], skill: options.skill ?? "review-pr", skipDrafts: true }],
        advanced: { pollIntervalMs: 60_000 },
      } as unknown as Config,
      paths: {} as Paths,
      gh,
      login: "me",
      log: () => {},
      cloneUrlFor: (repo) => repo,
      signal: new AbortController().signal,
    },
  };
}

function event(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    event: "review_requested",
    created_at: "2026-08-01T10:00:00Z",
    requested_reviewer: { login: "me" },
    ...over,
  };
}

function queued(store: Store, over: Record<string, unknown> = {}) {
  store.insert({
    id: "run-1",
    eventId: "1",
    repo: "acme/api",
    pullNumber: 42,
    headSha: "b".repeat(40),
    title: "Add widgets",
    skill: "review-pr",
    status: "queued",
    detail: null,
    requestedAt: "2026-08-01T10:00:00Z",
    createdAt: "2026-08-01T10:00:00Z",
    ...over,
  } as Parameters<Store["insert"]>[0]);
}

describe("the worktree reaper", () => {
  test("a shutdown stops it between checkouts, never inside one", async () => {
    // `removeWorktree` deletes a checkout and then prunes the clone's entry
    // naming it, and a stop landing between those two would leave the clone
    // pointing at a directory that is gone. So the signal is read between
    // worktrees and not inside one — and a backlog of them is exactly what a
    // shutdown should not sit through, with launchd already counting down.
    //
    // The abort is sprung from the lookup of the first run, which is the only
    // way to land inside the reap: `tickOnce` checks the signal immediately
    // before calling it, so aborting any earlier means it never reaps at all.
    const dir = mkdtempSync(join(tmpdir(), "engwire-reap-"));
    const first = join(dir, "one");
    const second = join(dir, "two");
    mkdirSync(first);
    mkdirSync(second);
    const controller = new AbortController();
    try {
      const { runtime: rt } = runtime({
        onPoll: () => {},
        signal: controller.signal,
        expiredWorktrees: () => [
          { id: "a", worktreePath: first },
          { id: "b", worktreePath: second },
        ],
        onGet: () => controller.abort(),
      });

      await tickOnce(rt);

      // The one it had started on is finished rather than abandoned half-done.
      expect(existsSync(first)).toBe(false);
      // And the rest of the backlog is left for the next runner to reap.
      expect(existsSync(second)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pollAndSchedule", () => {
  test("a push moves the queued run to the revision the poll saw", async () => {
    // A run can wait long enough for the author to push several times, and
    // reviewing the revision it was scheduled at would comment on code that has
    // since moved.
    const { runtime, store } = polling({ detail: {}, events: [event(1)] });
    queued(store);

    await pollAndSchedule(runtime);

    expect(store.get("run-1")?.headSha).toBe("a".repeat(40));
    store.close();
  });

  test("a second request replaces the run answering the first", async () => {
    // Asking again is a distinct act, and the older queued run is answering a
    // question this one replaced.
    const { runtime, store } = polling({
      detail: {},
      events: [event(1), event(2, { created_at: "2026-08-02T10:00:00Z" })],
    });
    queued(store);

    await pollAndSchedule(runtime);

    expect(store.get("run-1")).toMatchObject({ status: "superseded" });
    expect(store.recentRuns().find((run) => run.eventId === "2")).toMatchObject({
      status: "queued",
    });
    store.close();
  });

  test("holding a run writes nothing at all", async () => {
    // The one decision with no durable effect: a pull request back in draft is
    // ineligible this cycle and reconsidered on the next poll. Recording it
    // would consume a request GitHub may never send again.
    //
    // Seeded at the revision the poll reports, so a retarget cannot fire
    // alongside and blur what is being asserted — those are two decisions, and
    // a held run may legitimately be retargeted by the same poll.
    const { runtime, store } = polling({ detail: { isDraft: true }, events: [event(1)] });
    queued(store, { headSha: "a".repeat(40) });
    const before = store.get("run-1");

    const decisions = await pollAndSchedule(runtime);

    expect(decisions.some((decision) => decision.kind === "hold")).toBe(true);
    expect(store.get("run-1")).toEqual(before);
    store.close();
  });
});
