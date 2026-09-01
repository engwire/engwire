/**
 * @file `engwire status` — what the runner is doing and what it last did.
 *
 * Pull request titles are written by whoever opened the pull request, and this
 * prints them to a terminal. Escape sequences in one could rewrite the rest of
 * the output, so they are stripped here, at the point of display, rather than
 * on the way in — the database should hold what GitHub said.
 */

import { paths } from "../config/paths.ts";
import { isLocked } from "../service/lock.ts";
import { Store } from "../store/store.ts";

/**
 * Neutralise anything a terminal would act on rather than show.
 *
 * Two passes, and both are needed. `Bun.stripANSI` removes whole escape
 * sequences, so `ESC[2J` disappears instead of leaving `[2J` behind as
 * litter — but it does not touch a bare carriage return, which is enough on
 * its own to overwrite the line above. The control-character pass catches that
 * and anything `stripANSI` did not recognise. It runs second, because it would
 * otherwise eat the ESC that lets `stripANSI` see a sequence at all.
 *
 * It covers C1 as well as C0. `stripANSI` is documented as removing escape
 * *sequences*, not as a general control-character filter, and measured against
 * Bun 1.4 it passes 26 of the 32 C1 characters straight through — U+0085 among
 * them, which breaks the line on its own.
 */
function plain(text: string): string {
  return Bun.stripANSI(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/**
 * Dismissal reasons are stored as codes, because the store is queried and
 * compared; a terminal is not where anyone should have to read one. Everything
 * else in `detail` — a failure message, a supersede note — is already prose and
 * passes through, which is why this is a `Map` and not an object: it has no
 * inherited keys for an unknown code to reach.
 */
const REASONS = new Map([
  ["no_automation", "no matching rule"],
  ["fork", "opened from a fork"],
  ["superseded_by_newer", "replaced by a newer request"],
]);

export async function status(): Promise<number> {
  const p = paths();

  const running = isLocked(p.lockFile);

  if (!(await Bun.file(p.dbFile).exists())) {
    console.log(running ? "Runner    running" : "Runner    stopped");
    console.log("No runs yet. Run `engwire setup` to get started.");
    return 0;
  }

  const store = new Store(p.dbFile);
  try {
    // The lock says whether a runner is live; the row says which one. The row
    // outlives a runner that crashed, so it is read only when the lock was just
    // observed held — a probe, not a lock this holds, so the pid and start time
    // are the best available answer rather than a guaranteed one.
    const holder = running ? store.runner() : null;
    const who = holder ? ` (pid ${holder.pid}, since ${holder.startedAt})` : "";
    console.log(running ? `Runner    running${who}` : "Runner    stopped");

    const runs = store.recentRuns(15);
    if (runs.length === 0) {
      console.log("No review requests seen yet.");
      return 0;
    }
    console.log("");
    for (const run of runs) {
      const where = `${run.repo}#${run.pullNumber}`;
      const detail = run.detail ? `  ${REASONS.get(run.detail) ?? plain(run.detail)}` : "";
      console.log(
        `${run.status.padEnd(11)} ${where.padEnd(34)} ${plain(run.title).slice(0, 48)}${detail}`,
      );
    }

    // Which rows are still live is the least guessable thing about this output,
    // and there is no telemetry to discover that someone guessed wrong.
    console.log("");
    console.log("Queued work follows the pull request and your config until it starts.");
    console.log("A running review is frozen. A dismissal is permanent.");
    return 0;
  } finally {
    store.close();
  }
}
