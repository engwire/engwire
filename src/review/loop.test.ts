/**
 * @file The lifecycle boundary: what the loop must not do once it is stopping.
 *
 * `runLoop` owns daemon scheduling, so it must not start a long-running review
 * after launchd has asked it to stop.
 */

import { describe, expect, test } from "bun:test";
import type { Config } from "../config/config.ts";
import type { Paths } from "../config/paths.ts";
import { GhError, type Gh } from "../github/gh.ts";
import type { Store } from "../store/store.ts";
import type { Runtime } from "./execute.ts";
import { runLoop } from "./loop.ts";

function runtime(over: {
  onPoll: () => void | Promise<void>;
  claimNext?: () => null;
  /** Called with the number of this identity check, before it answers. */
  onLogin?: (nth: number) => void;
}): { runtime: Runtime; claims: number } {
  const state = { claims: 0 };
  const store = {
    watchingSince: () => "2026-01-01T00:00:00Z",
    activeRuns: () => [],
    knownEventIds: () => new Set<string>(),
    claimNext: () => {
      state.claims += 1;
      return over.claimNext?.() ?? null;
    },
    expiredWorktrees: () => [],
    transaction: <T,>(work: () => T) => work(),
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
      paths: {} as Paths,
      gh,
      login: "me",
      log: () => {},
      cloneUrlFor: (repo) => repo,
    },
    get claims() {
      return state.claims;
    },
  };
}

describe("runLoop", () => {
  test("does not start a review after shutdown was requested mid-poll", async () => {
    // SIGTERM lands while the poll is in flight. Without a check between the
    // poll and the queue, the runner would begin a fresh review that launchd is
    // already waiting to kill.
    const controller = new AbortController();
    const harness = runtime({
      onPoll: () => controller.abort(),
      claimNext: () => null,
    });

    await runLoop(harness.runtime, controller.signal);

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
    });

    const started = Date.now();
    await runLoop(harness.runtime, controller.signal);

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
    });
    github.runtime.config.advanced.pollIntervalMs = 1;
    await runLoop(github.runtime, transient.signal);
    expect(polls).toBeGreaterThan(1);

    const fatal = runtime({
      onPoll: () => {
        throw new TypeError("store is not a function");
      },
    });
    expect(runLoop(fatal.runtime, new AbortController().signal)).rejects.toThrow(TypeError);
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
    });

    await runLoop(harness.runtime, controller.signal);

    expect(harness.claims).toBe(0);
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
    });
    harness.runtime.config.advanced.pollIntervalMs = 1;

    await runLoop(harness.runtime, controller.signal);

    // One claim attempt, from the one cycle that had evidence.
    expect(polls).toBeGreaterThan(2);
    expect(harness.claims).toBe(1);
  });
});
