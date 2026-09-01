/**
 * @file One runner per installation.
 *
 * A held SQLite transaction makes the lock process-owned and crash-safe. That
 * lets startup treat every leftover `running` row as interrupted without a pid
 * liveness protocol; `docs/architecture.md` records the choice and tradeoff.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class LockedError extends Error {
  constructor() {
    super("Another engwire runner is already running.");
    this.name = "LockedError";
  }
}

/**
 * Hold the runner lock until the returned function is called.
 *
 * The transaction is never committed; it exists only for the lock it takes.
 */
export function acquireLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, { create: true });
  // Fail rather than wait: a second runner should say so immediately, not hang.
  db.exec("PRAGMA busy_timeout = 0");
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new LockedError();
    throw error;
  }
  return () => {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  };
}

/**
 * Whether a runner holds the lock right now.
 *
 * Answered by trying to take it, which is the only question with a reliable
 * answer — and immediately giving it back.
 */
export function isLocked(file: string): boolean {
  // A lock that was never taken cannot be held, and asking would create the
  // database — `engwire status` should not write to disk to answer a question.
  if (!existsSync(file)) return false;

  let release: () => void;
  try {
    release = acquireLock(file);
  } catch (error) {
    if (error instanceof LockedError) return true;
    throw error;
  }
  release();
  return false;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "SQLITE_BUSY" || /database is locked/i.test(String(error));
}
