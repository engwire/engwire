/**
 * @file Durable state: one table of review runs.
 *
 * Engwire treats the numeric `review_requested` issue-event id as globally
 * unique, not unique per repository. That is an assumption, and it was checked
 * rather than inherited: ids sampled from three unrelated repositories fell
 * inside one narrow band, never collided, and ordered the same way as their
 * timestamps. Note also that the timeline mixes id spaces — reviews and
 * comments carry ids from a different, shorter range — so this holds only
 * because discovery keeps `review_requested` entries and nothing else.
 *
 * Rows are never deleted. A run row is a few hundred bytes and a busy reviewer
 * produces a handful a day, so keeping them forever costs nothing and buys the
 * strongest dedup invariant available — `UNIQUE(event_id)` means a GitHub
 * review request cannot be acted on twice even if the runner crashes between
 * deciding and executing. Only worktrees are reclaimed.
 *
 * The schema lives here rather than in a `.sql` file so the compiled binary has
 * nothing to find at runtime.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReviewRun, RunStatus, TerminalRunStatus } from "../review/model.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_runs (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL UNIQUE,
  repo          TEXT NOT NULL,
  pull_number   INTEGER NOT NULL,
  head_sha      TEXT NOT NULL,
  title         TEXT NOT NULL,
  skill         TEXT,
  status        TEXT NOT NULL CHECK (status IN (
                  'queued', 'running', 'completed',
                  'failed', 'interrupted', 'superseded', 'dismissed')),
  worktree_path TEXT,
  retain_until  TEXT,
  detail        TEXT,
  requested_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS review_runs_status ON review_runs (status);
CREATE INDEX IF NOT EXISTS review_runs_requested
  ON review_runs (requested_at, CAST(event_id AS INTEGER));
`;

type Row = {
  id: string;
  event_id: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  title: string;
  skill: string | null;
  status: string;
  worktree_path: string | null;
  retain_until: string | null;
  detail: string | null;
  requested_at: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/**
 * The two shapes a scheduling decision is born in.
 *
 * A decision is only ever recorded as queued or dismissed on the spot; every
 * other status is reached by a transition. The fields are not independent of
 * that choice: a queued run carries the skill its rule named — the runner
 * refuses to invent one later — and a dismissed run carries the reason it was
 * passed over. Correlating them here means `queued` with no skill cannot be
 * written at all, rather than being caught downstream.
 */
export type NewRunDecision =
  | { status: "queued"; skill: string; detail: null }
  | { status: "dismissed"; skill: null; detail: string };

type NewReviewRun = Omit<
  ReviewRun,
  "worktreePath" | "retainUntil" | "startedAt" | "finishedAt" | "status" | "skill" | "detail"
> &
  NewRunDecision;

/**
 * Which state a run must already be in for each way of finishing.
 *
 * `completed` means Claude exited successfully, so it can only follow a run
 * that actually started; `dismissed` and `superseded` describe a decision
 * dropped before it ever did. Constraining the destination alone would still
 * let a queued run be recorded as completed. A tiny transition table, applied
 * as a `WHERE` clause, instead of a status class per state.
 */
const REQUIRED_BEFORE: Record<TerminalRunStatus, "queued" | "running"> = {
  dismissed: "queued",
  superseded: "queued",
  completed: "running",
  failed: "running",
  interrupted: "running",
};

/**
 * Rows are never deleted, so a mutation aimed at a row the caller just read
 * must hit exactly one. Zero means the state machine has been violated — for
 * `setWorktree` specifically, proceeding would create the untracked checkout
 * that recording the path early exists to prevent.
 */
function requireOne(changes: number, what: string): void {
  if (changes !== 1) {
    throw new Error(`${what} matched ${changes} rows, expected 1`);
  }
}

function toRun(row: Row): ReviewRun {
  return {
    id: row.id,
    eventId: row.event_id,
    repo: row.repo,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    title: row.title,
    skill: row.skill,
    status: row.status as RunStatus,
    worktreePath: row.worktree_path,
    retainUntil: row.retain_until,
    detail: row.detail,
    requestedAt: row.requested_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class Store {
  // Private: the Store owns claiming, atomic decisions, identity binding and
  // recovery. A caller holding the handle could step around all of it.
  private readonly db: Database;

  constructor(file: string) {
    // 0700: the data directory holds clones of private repositories and the
    // transcripts of reviews of them. It should not depend on the machine's
    // ambient umask to stay unreadable.
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // `mode` only applies to directories this call creates; an existing one
      // keeps whatever it had, which on an upgrade could be world-readable.
      chmodSync(dirname(file), 0o700);
    }
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * When this installation started watching, fixed at first call.
   *
   * Set by the first runner that starts with a review rule configured, not by
   * `setup`: installing Engwire authorizes nothing, and naming a repository is
   * the moment that matters. Discovery ignores anything older.
   *
   * It is one watermark, not one per rule. A request Engwire has recorded stays
   * recorded, but one that arrived after this point while the runner happened
   * to be stopped was never seen, so a rule added later can still pick it up.
   */
  watchingSince(now = new Date()): string {
    const existing = this.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'watching_since'")
      .get();
    if (existing) return existing.value;
    const value = now.toISOString();
    this.db.run("INSERT INTO meta (key, value) VALUES ('watching_since', ?)", [value]);
    return value;
  }

  /**
   * Who is running, for `engwire status` to display.
   *
   * Informational only. Whether a runner is *live* is the lock's answer, not
   * this row's — which is why a stale row after a crash is harmless: nothing
   * reads it unless the lock is held.
   */
  recordRunner(info: { pid: number; startedAt: string; version: string }): void {
    this.db.run(
      "INSERT INTO meta (key, value) VALUES ('runner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [JSON.stringify(info)],
    );
  }

  runner(): { pid: number; startedAt: string; version: string } | null {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'runner'")
      .get();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  /**
   * The GitHub account this installation belongs to, or null if unclaimed.
   *
   * Separate from `bindReviewer` because `doctor` has to be able to ask without
   * answering: a diagnostic that claimed the installation for whichever account
   * happened to run it would be deciding, not reporting.
   */
  reviewerLogin(): string | null {
    return (
      this.db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'reviewer_login'")
        .get()?.value ?? null
    );
  }

  /**
   * Claim this installation for an account, or return the one that owns it.
   *
   * The queue is a list of decisions made on one person's behalf. Nothing in a
   * run row names them, so without this an installation would happily execute
   * work accepted as `alice` after `gh auth switch bob` and a restart — posting
   * as Bob a review Alice was asked for. One installation, one identity; a
   * second account is a second `ENGWIRE_HOME`.
   */
  bindReviewer(login: string): string {
    const existing = this.reviewerLogin();
    if (existing) return existing;
    this.db.run("INSERT INTO meta (key, value) VALUES ('reviewer_login', ?)", [login]);
    return login;
  }

  /**
   * Apply several writes or none. Synchronous: never `await` inside `work`,
   * because the transaction commits when the callback returns.
   *
   * One poll produces one reconciled answer, and parts of it depend on each
   * other: enqueueing a newer request and superseding the queued one it
   * replaces are the same decision written twice. A crash between them would
   * leave both queued, and the newer event is already recorded, so no later
   * poll would ever regenerate the supersession.
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  knownEventIds(eventIds: readonly string[]): Set<string> {
    if (eventIds.length === 0) return new Set();
    const placeholders = eventIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ event_id: string }, string[]>(
        `SELECT event_id FROM review_runs WHERE event_id IN (${placeholders})`,
      )
      .all(...(eventIds as string[]));
    return new Set(rows.map((row) => row.event_id));
  }

  activeRuns(): ReviewRun[] {
    return this.db
      .query<Row, []>(
        `SELECT * FROM review_runs WHERE status IN ('queued','running')
          ORDER BY requested_at, CAST(event_id AS INTEGER)`,
      )
      .all()
      .map(toRun);
  }

  recentRuns(limit = 20): ReviewRun[] {
    return this.db
      .query<Row, [number]>(
        `SELECT * FROM review_runs
          ORDER BY created_at DESC, requested_at DESC, CAST(event_id AS INTEGER) DESC
          LIMIT ?`,
      )
      .all(limit)
      .map(toRun);
  }

  get(id: string): ReviewRun | null {
    const row = this.db
      .query<Row, [string]>("SELECT * FROM review_runs WHERE id = ?")
      .get(id);
    return row ? toRun(row) : null;
  }

  /**
   * Record a scheduling decision.
   *
   * The conflict clause names `event_id` deliberately: a duplicate request is
   * expected and ignored, while a primary-key collision or any future
   * constraint violation is a bug and still raises.
   */
  insert(run: NewReviewRun): boolean {
    const result = this.db.run(
      `INSERT INTO review_runs
         (id, event_id, repo, pull_number, head_sha, title, skill, status, detail,
          requested_at, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
      [
        run.id,
        run.eventId,
        run.repo,
        run.pullNumber,
        run.headSha,
        run.title,
        run.skill,
        run.status,
        run.detail,
        run.requestedAt,
        run.createdAt,
        // A dismissal is born terminal: it was decided and over in the same
        // instant. Leaving it null would make `dismissed` the one ending with
        // no ending, so anything later measuring a run would have to know it.
        run.status === "dismissed" ? run.createdAt : null,
      ],
    );
    return result.changes > 0;
  }

  /**
   * Take the queued run whose review was asked for first.
   *
   * Ordered by the GitHub event time, not by when Engwire wrote the row: one
   * poll discovers a batch of requests within the same millisecond, so the
   * local clock cannot tell them apart. GitHub's timestamps resolve only to the
   * second, so the tie-break is the event id — cast, because the column is TEXT
   * and `"10"` sorts before `"9"`. Reconciliation orders the same way.
   */
  claimNext(now = new Date()): ReviewRun | null {
    const claim = this.db.transaction((): ReviewRun | null => {
      const row = this.db
        .query<Row, []>(
          `SELECT * FROM review_runs WHERE status = 'queued'
            ORDER BY requested_at, CAST(event_id AS INTEGER) LIMIT 1`,
        )
        .get();
      if (!row) return null;
      // One timestamp for the row and the value returned, so the caller cannot
      // be handed a run that disagrees with what was just committed.
      const startedAt = now.toISOString();
      this.db.run(
        "UPDATE review_runs SET status = 'running', started_at = ? WHERE id = ?",
        [startedAt, row.id],
      );
      return toRun({ ...row, status: "running", started_at: startedAt });
    });
    return claim();
  }

  setWorktree(id: string, path: string | null): void {
    const result = this.db.run("UPDATE review_runs SET worktree_path = ? WHERE id = ?", [path, id]);
    requireOne(result.changes, `setWorktree(${id})`);
  }

  finish(
    id: string,
    status: TerminalRunStatus,
    detail: string | null,
    options: { retainUntil?: string | null; now?: Date } = {},
  ): void {
    const now = options.now ?? new Date();
    const result = this.db.run(
      `UPDATE review_runs
          SET status = ?, detail = ?, retain_until = ?, finished_at = ?
        WHERE id = ? AND status = ?`,
      [status, detail, options.retainUntil ?? null, now.toISOString(), id, REQUIRED_BEFORE[status]],
    );
    requireOne(result.changes, `finish(${id}, ${status}) from ${REQUIRED_BEFORE[status]}`);
  }

  /**
   * Close out runs left `running` by a dead runner.
   *
   * There is exactly one runner per installation — the lock guarantees it — so
   * anything still marked running at startup belongs to a process that is gone.
   * No pid liveness check, which would be answering a question pid reuse makes
   * unanswerable anyway.
   *
   * `interrupted` is terminal. The review may already have posted to GitHub
   * before the runner died, and nothing here can tell; re-running it would risk
   * a second review of the same pull request, which is worse than none.
   * `retainUntil` is set so the abandoned checkout is still reaped.
   */
  recoverInterrupted(retainUntil: string, now = new Date()): number {
    const result = this.db.run(
      `UPDATE review_runs
          SET status = 'interrupted',
              detail = 'runner stopped mid-review; request the review again',
              retain_until = ?,
              finished_at = ?
        WHERE status = 'running'`,
      [retainUntil, now.toISOString()],
    );
    return result.changes;
  }

  /** Finished runs whose worktree has outlived its retention. */
  expiredWorktrees(now = new Date()): { id: string; worktreePath: string }[] {
    return this.db
      .query<{ id: string; worktree_path: string }, [string]>(
        `SELECT id, worktree_path FROM review_runs
          WHERE worktree_path IS NOT NULL
            AND retain_until IS NOT NULL
            AND retain_until <= ?`,
      )
      .all(now.toISOString())
      .map((row) => ({ id: row.id, worktreePath: row.worktree_path }));
  }
}
