import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseTooNewError, Store } from "./store.ts";

/** Every fixture starts queued; tests reach other states through Store transitions. */
type QueuedSeed = Extract<Parameters<Store["insert"]>[0], { status: "queued" }>;

function seedRun(over: Partial<QueuedSeed> = {}): QueuedSeed {
  return {
    id: "run-1",
    eventId: "evt-1",
    repo: "acme/api",
    pullNumber: 42,
    headSha: "a".repeat(40),
    title: "Add widgets",
    skill: "review-pr",
    status: "queued",
    detail: null,
    requestedAt: "2026-08-01T10:00:00Z",
    createdAt: "2026-08-01T10:00:00Z",
    ...over,
  };
}

function seed(store: Store, over: Partial<QueuedSeed> = {}) {
  const run = seedRun(over);
  store.insert(run);
  return run;
}

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => {
  store.close();
});

describe("Store", () => {
  test("one review request can only ever produce one run", () => {
    const run = seed(store);
    // A crash between deciding and executing means the same decision arrives
    // twice. The unique event id, not the caller, is what stops it.
    expect(store.insert({ ...run, id: "run-2" })).toBe(false);
    expect(store.recentRuns().length).toBe(1);
  });

  test("watchingSince is fixed at first use", () => {
    const first = store.watchingSince(new Date("2026-01-01T00:00:00Z"));
    const second = store.watchingSince(new Date("2027-01-01T00:00:00Z"));
    expect(second).toBe(first);
  });

  test("an installation belongs to the first account that used it", () => {
    // The queue is a list of decisions made on one person's behalf, and no run
    // row names them; a restart under another account must not inherit it.
    expect(store.reviewerLogin()).toBeNull();
    expect(store.bindReviewer("alice")).toBe("alice");
    expect(store.bindReviewer("bob")).toBe("alice");
    expect(store.reviewerLogin()).toBe("alice");
  });

  test("knownEventIds reports only what it has seen", () => {
    seed(store, { eventId: "evt-a" });
    expect(store.knownEventIds(["evt-a", "evt-b"])).toEqual(new Set(["evt-a"]));
    expect(store.knownEventIds([])).toEqual(new Set());
  });

  test("claimNext takes the run asked for first, exactly once", () => {
    // Both rows were written by the same poll, so only the GitHub event time
    // can order them.
    const sameCycle = "2026-08-01T12:00:00Z";
    seed(store, { id: "new", eventId: "2", requestedAt: "2026-08-01T11:00:00Z", createdAt: sameCycle });
    seed(store, { id: "old", eventId: "1", requestedAt: "2026-08-01T10:00:00Z", createdAt: sameCycle });

    expect(store.claimNext()?.id).toBe("old");
    expect(store.claimNext()?.id).toBe("new");
    expect(store.claimNext()).toBeNull();
  });

  test("claiming records the start, and says so in what it returns", () => {
    seed(store);
    // The returned run must agree with the row just committed; asserting only
    // the reloaded row would miss a stale value handed back to the caller.
    expect(store.claimNext({ now: new Date("2026-08-01T12:00:00Z") })).toMatchObject({
      status: "running",
      startedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(store.get("run-1")?.startedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  test("a run interrupted by a crash is never retried", () => {
    // The skill posts to GitHub, so a review cut short may already have said
    // something. Running it again could say it twice.
    seed(store);
    store.claimNext();
    store.setWorktree("run-1", "/tmp/run-1");

    expect(store.recoverInterrupted("2026-08-02T00:00:00Z")).toBe(1);
    expect(store.get("run-1")).toMatchObject({
      status: "interrupted",
      detail: "runner stopped mid-review; request the review again",
    });
    expect(store.recoverInterrupted("2026-08-02T00:00:00Z")).toBe(0);

    // Its abandoned checkout is still reclaimed.
    expect(store.expiredWorktrees(new Date("2026-08-03T00:00:00Z"))).toEqual([
      { id: "run-1", worktreePath: "/tmp/run-1" },
    ]);
  });

  test("a claim released before the review starts is queued again, and its checkout reclaimed", () => {
    // The skill a run names, or the account it was accepted for, can change
    // while its checkout is being prepared. Nothing has run and nothing has
    // posted, so the request is still outstanding: a terminal status would
    // spend an event GitHub will not send again.
    seed(store);
    store.claimNext({ now: new Date("2026-08-01T12:00:00Z") });
    store.setWorktree("run-1", "/tmp/run-1");

    store.releaseClaim("run-1", "2026-08-01T13:00:00Z");

    expect(store.get("run-1")).toMatchObject({ status: "queued", startedAt: null });

    // The checkout goes back to the reaper. Without a deadline it would be
    // invisible to it, and the private source it holds would outlive a rule
    // nobody fixes.
    expect(store.expiredWorktrees(new Date("2026-08-01T14:00:00Z"))).toEqual([
      { id: "run-1", worktreePath: "/tmp/run-1" },
    ]);

    // But not while the next attempt is using it. The deadline outlives the
    // release, so the row it belongs to is claimable again long before the
    // deadline passes — and the reaper deletes directories.
    expect(store.claimNext({ now: new Date("2026-08-01T12:30:00Z") })?.id).toBe("run-1");
    expect(store.expiredWorktrees(new Date("2026-08-01T14:00:00Z"))).toEqual([]);

    // Only a claim can be given back. A finished run is not one.
    store.finish("run-1", "completed", null);
    expect(() => store.releaseClaim("run-1", "2026-08-01T13:00:00Z")).toThrow();
  });

  test("finishing a run does not erase a cleanup deadline it already had", () => {
    // A released claim keeps its checkout scheduled for reclamation. The next
    // poll can then dismiss or supersede that queued row — neither of which
    // names a deadline, and both of which would otherwise make the directory
    // invisible to the reaper for good.
    seed(store);
    store.claimNext();
    store.setWorktree("run-1", "/tmp/run-1");
    store.releaseClaim("run-1", "2026-08-01T13:00:00Z");

    store.finish("run-1", "superseded", "replaced by event 2");

    expect(store.expiredWorktrees(new Date("2026-08-01T14:00:00Z"))).toEqual([
      { id: "run-1", worktreePath: "/tmp/run-1" },
    ]);
  });

  test("a decision that half-applied is no decision at all", () => {
    // Enqueueing a newer request and superseding the one it replaces is a
    // single answer. Half of it would leave both queued, and the newer event is
    // recorded by then, so no later poll would ever notice.
    seed(store, { id: "older", eventId: "1" });
    expect(() =>
      store.transaction(() => {
        seed(store, { id: "newer", eventId: "2" });
        store.finish("older", "superseded", "replaced by event 2");
        throw new Error("crash");
      }),
    ).toThrow("crash");

    expect(store.get("newer")).toBeNull();
    expect(store.get("older")).toMatchObject({ status: "queued" });
  });

  test("a dismissal is born finished; a queued decision is not", () => {
    // Every other route into a terminal status writes a finish time. A
    // dismissal never transitions, so it has to carry one from the start.
    seed(store, { id: "waiting", eventId: "1" });
    store.insert({
      ...seedRun({ id: "passed-over", eventId: "2" }),
      status: "dismissed",
      skill: null,
      detail: "no_automation",
    });

    expect(store.get("waiting")?.finishedAt).toBeNull();
    expect(store.get("passed-over")?.finishedAt).toBe(seedRun().createdAt);
  });

  test("a queued run can be retargeted; a claimed one cannot", () => {
    seed(store);
    store.retarget("run-1", { headSha: "b".repeat(40), skill: "review-payments" });
    expect(store.get("run-1")).toMatchObject({
      headSha: "b".repeat(40),
      skill: "review-payments",
      status: "queued",
    });

    // Once claimed the target is frozen: "once a review starts, it finishes"
    // would mean nothing if what it reviews could move underneath it.
    store.claimNext();
    expect(() =>
      store.retarget("run-1", { headSha: "c".repeat(40), skill: "review-pr" }),
    ).toThrow(/expected 1/);
  });

  test("an excluded run stays queued and is passed over", () => {
    // Reconciliation can judge a queued run ineligible for this cycle — its
    // pull request went back to draft — without consuming it.
    seed(store, { id: "held", eventId: "1", requestedAt: "2026-08-01T10:00:00Z" });
    seed(store, { id: "next", eventId: "2", requestedAt: "2026-08-01T11:00:00Z" });

    expect(store.claimNext({ exclude: ["held"] })?.id).toBe("next");
    expect(store.get("held")?.status).toBe("queued");
    expect(store.claimNext({ exclude: ["held"] })).toBeNull();
    expect(store.claimNext()?.id).toBe("held");
  });

  test("a run that never started cannot be recorded as completed", () => {
    // The destination alone is not enough: `completed` means Claude exited
    // successfully, so it has to follow a run that was actually claimed.
    seed(store);
    expect(() => store.finish("run-1", "completed", null)).toThrow(/expected 1/);
    expect(store.get("run-1")?.status).toBe("queued");
  });

  test("a mutation aimed at a row that is not there fails loudly", () => {
    // Rows are never deleted, so zero matches means the state machine has been
    // violated — and for setWorktree, carrying on would strand a checkout the
    // reaper cannot see.
    expect(() => store.setWorktree("nobody", "/tmp/x")).toThrow(/expected 1/);
  });

  test("the database refuses a status the domain does not define", () => {
    // `toRun` casts stored text to RunStatus; the CHECK is what makes that
    // cast honest, so it is pinned here rather than left to a manual check.
    const run = { ...seedRun(), id: "bogus", eventId: "bogus" };
    expect(() =>
      store.insert({ ...run, status: "elsewhere" as "queued" }),
    ).toThrow(/CHECK constraint/);
  });

  test("expired worktrees are the ones past retention with a checkout left", () => {
    seed(store, { id: "kept", eventId: "1" });
    seed(store, { id: "expired", eventId: "2" });
    // Claimed before completing: `completed` means Claude exited successfully,
    // so it is only reachable from a run that actually started.
    store.claimNext();
    store.claimNext();
    store.setWorktree("kept", "/tmp/kept");
    store.setWorktree("expired", "/tmp/expired");
    store.finish("kept", "completed", null, { retainUntil: "2026-08-02T00:00:00Z" });
    store.finish("expired", "completed", null, { retainUntil: "2026-08-01T00:00:00Z" });

    expect(store.expiredWorktrees(new Date("2026-08-01T12:00:00Z"))).toEqual([
      { id: "expired", worktreePath: "/tmp/expired" },
    ]);
  });

  test("a run with no checkout is never reaped", () => {
    seed(store);
    store.claimNext();
    store.finish("run-1", "failed", "checkout failed", { retainUntil: "2026-01-01T00:00:00Z" });
    expect(store.expiredWorktrees(new Date("2027-01-01T00:00:00Z"))).toEqual([]);
  });

  test("activeRuns covers queued and running only", () => {
    // Driven entirely through the public API — the Store owns these
    // transitions, so a test that reaches past them proves less.
    seed(store, { id: "running", eventId: "1", requestedAt: "2026-08-01T10:00:00Z" });
    seed(store, { id: "queued", eventId: "2", requestedAt: "2026-08-01T11:00:00Z" });
    seed(store, { id: "done", eventId: "3", requestedAt: "2026-08-01T12:00:00Z" });

    expect(store.claimNext()?.id).toBe("running");
    // Dismissed rather than completed: a run that never started cannot have
    // finished successfully, and the Store now refuses that transition.
    store.finish("done", "dismissed", "no_automation");

    expect(store.activeRuns().map((run) => run.id).sort()).toEqual(["queued", "running"]);
  });
});

describe("schema version", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engwire-schema-"));
    file = join(dir, "engwire.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function journalModeOf(path: string): string {
    const db = new Database(path);
    try {
      return db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode;
    } finally {
      db.close();
    }
  }

  function versionOf(path: string): number {
    const db = new Database(path);
    try {
      return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    } finally {
      db.close();
    }
  }

  test("a database records the schema it was written with", () => {
    new Store(file).close();
    expect(versionOf(file)).toBe(1);
  });

  test("a stamped database does not recreate a missing table", () => {
    new Store(file).close();

    const db = new Database(file);
    db.exec("DROP TABLE review_runs");
    db.close();

    // Handing it a fresh empty table would answer "not reviewed yet" for every
    // outstanding request, and each of those answers spends a review.
    const store = new Store(file);
    expect(() => store.recentRuns()).toThrow();
    store.close();
  });

  test("a database from before versioning is adopted, not rebuilt", () => {
    // The rows are the dedup guarantee — losing them would let every
    // outstanding review request be acted on a second time.
    const store = new Store(file);
    seed(store);
    store.close();

    const db = new Database(file);
    db.exec("PRAGMA user_version = 0");
    db.close();

    const reopened = new Store(file);
    expect(reopened.recentRuns().length).toBe(1);
    reopened.close();
    expect(versionOf(file)).toBe(1);
  });

  test("failed schema adoption rolls back every change", () => {
    // The incomplete table makes index creation fail after `meta` is created,
    // providing a natural interruption in the middle of SCHEMA.
    const db = new Database(file);
    db.exec("CREATE TABLE review_runs (id TEXT PRIMARY KEY)");
    db.close();

    expect(() => new Store(file)).toThrow();

    const reopened = new Database(file);
    try {
      const meta = reopened
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        )
        .get()!.count;
      expect(meta).toBe(0);
      expect(
        reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version,
      ).toBe(0);
    } finally {
      reopened.close();
    }
  });

  test("a database from a newer engwire is refused rather than half-read", () => {
    const store = new Store(file);
    seed(store);
    store.close();

    const db = new Database(file);
    db.exec("PRAGMA user_version = 999");
    // Journal mode is persistent, so it reveals any write before the refusal.
    db.exec("PRAGMA journal_mode = delete");
    db.close();

    expect(() => new Store(file)).toThrow(DatabaseTooNewError);
    expect(versionOf(file)).toBe(999);
    expect(journalModeOf(file)).toBe("delete");
  });
});
