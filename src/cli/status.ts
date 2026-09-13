/**
 * @file `engwire status` — what the runner is doing and what it last did.
 *
 * Pull request titles are written by whoever opened the pull request, and this
 * prints them to a terminal. Escape sequences in one could rewrite the rest of
 * the output, so they are stripped here, at the point of display, rather than
 * on the way in — the database should hold what GitHub said.
 */

import { paths } from "../config/paths.ts";
import type { ReviewRun } from "../review/model.ts";
import type { DismissReason } from "../review/reconcile.ts";
import { isLocked } from "../service/lock.ts";
import { Store } from "../store/store.ts";
import { VERSION } from "../version.ts";

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
 *
 * The bidirectional formatting characters go too, and they are the same attack
 * by another route: U+202E reverses everything after it, so a title can display
 * as text nobody wrote — the trojan-source trick, aimed at a report whose whole
 * job is to be believed. The whole `Bidi_Control` set, U+061C included: it is
 * the one that does not live beside the others, and a set missing a member is a
 * filter with a documented way through it. Only the reordering ones, so the
 * zero-width joiners an ordinary emoji is built from are left alone.
 */
function plain(text: string): string {
  return Bun.stripANSI(text).replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );
}

/**
 * Dismissal reasons are stored as codes, because the store is queried and
 * compared; a terminal is not where anyone should have to read one. Everything
 * else in `detail` — a failure message, a supersede note — is already prose and
 * passes through.
 *
 * Written as a record and read as a `Map`, because each half buys what the
 * other cannot. The record makes the compiler count them, so a reason added to
 * `DismissReason` and not to this table is a build error rather than a code
 * printed raw into somebody's terminal. The `Map` has no inherited keys for an
 * unknown `detail` to reach, and a detail is an arbitrary string —
 * `"constructor"` is a value on any object literal.
 */
const PROSE: Record<DismissReason, string> = {
  no_automation: "no matching rule",
  fork: "opened from a fork",
  superseded_by_newer: "replaced by a newer request",
};

const REASONS = new Map(Object.entries(PROSE));

/** The row's columns, in the order it prints them. */
const AGE = 8;
const STATUS = 11;
const WHERE = 30;
const TITLE = 40;
/**
 * The width a row is allowed to reach before its detail moves to its own line.
 *
 * The columns above already spend 93 of it when they are all full, so what fits
 * after a row is short: a dismissal reason rides along beside a short title and
 * takes its own line beside a long one. Carrying even the shortest of them
 * against a full title would need 111 columns, and the longest 122 — wrapping
 * mid-word on an ordinary terminal, which is the outcome the second line exists
 * to prevent. The bound is the terminal's to give, not the detail's to ask for,
 * and `status.test.ts` holds both halves of that to the arithmetic.
 */
const ROW = 110;

/**
 * What to do about a runner left on another version — not the same command
 * everywhere, and not always a command at all.
 *
 * `engwire service install` is the macOS answer and exits 1 anywhere else, so
 * naming it unconditionally hands a Linux reviewer a remedy that fails. Off
 * macOS the supervisor is theirs, and restarting it is what picks up the new
 * binary; the `Logs` note already names where that supervisor's output goes,
 * so this does not guess at systemd twice.
 *
 * A sentence of its own rather than a clause, because it shares no line with
 * the versions: two prereleases — `0.1.0-beta.123` beside `0.1.0-beta.124` — ran
 * the single-line form past the width every other line here is held to, and
 * fixtures guessing how long a version might get is not a bound.
 *
 * Empty from a source checkout on either platform: `service install` refuses
 * one, so there is nothing to act on and the mismatch is stated bare.
 */
export function versionRemedy(
  standalone = Bun.isStandaloneExecutable,
  platform: string = process.platform,
): string {
  if (!standalone) return "";
  return platform === "darwin"
    ? "Run `engwire service install` to restart it."
    : "Restart your supervisor to pick it up.";
}

/**
 * What to do when no runner has ever started, and none is running now.
 *
 * The second half is a precondition rather than a description. One of the two
 * answers takes the runner lock — `run --once` does, `setup` does not — so
 * offered to a reader whose runner is already holding it, it is advice that
 * cannot be taken. The caller checks; this says so beside the sentence rather
 * than only at the one call site, because the next caller will not have read
 * that.
 *
 * "Run `engwire setup`" is the right answer exactly once: before there is a
 * config. The state this line actually guards is a missing *database*, which
 * outlasts setup by however long it takes somebody to name a repository — so
 * said to a reader who has just run setup it points backwards, to the command
 * they came from, and is the one place a first run can stall with every line
 * above it reporting success.
 *
 * Whether the rules inside are usable is left to `run --once`, which says so
 * exactly and is the next step either way. Parsing the config here would give
 * `status` a second opinion about a file it does not own, and an error to
 * render for a question nobody asked it.
 */
export function nothingRunYet(configured: boolean): string {
  return configured
    ? "Nothing has run yet. `engwire run --once` polls once and exits."
    : "No runs yet. Run `engwire setup` to get started.";
}

/**
 * Where the runner's own output is, which is not always this directory.
 *
 * launchd writes it here, so naming the directory is the whole answer on macOS.
 * Every other supervisor sends stdout wherever it sends stdout — the journal,
 * for the unit in docs/linux.md — and leaves this directory holding the review
 * transcripts alone. Pointing at the wrong file is no better than pointing at
 * nothing, which is why the directory is named rather than assumed.
 */
export function logsNote(logsDir: string, platform: string = process.platform): string[] {
  const lines = [`Logs      ${logsDir}`];
  if (platform !== "darwin") {
    lines.push(
      `${" ".repeat(AGE + 2)}transcripts only; runner output goes to its supervisor — systemd: journalctl --user -u engwire`,
    );
  }
  return lines;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/**
 * An age, not a timestamp.
 *
 * The question this report answers is whether anything has happened lately, and
 * a column of ISO strings makes the reader do that subtraction themselves.
 * Coarse on purpose — a review takes minutes, so a second is never the unit
 * anyone needs, and one column stays one column at every scale.
 *
 * A clock ahead of ours reads as "just now", which is the answer worth giving:
 * `requested_at` comes from GitHub and a laptop drifts, and "in 2s ago" is not
 * an improvement. The first branch is what produces that — every negative age
 * is under a minute — so the clamp below changes no answer today. It stays as
 * the statement of intent, because the alternative is the next person to add a
 * branch above it having to rediscover that ages can be negative at all.
 */
export function ago(when: string, now = Date.now()): string {
  const at = Date.parse(when);
  if (Number.isNaN(at)) return "";
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  // Years, so the column has a width: rows are never deleted, and "2404d ago"
  // would widen it for everyone the first time a dormant installation wakes up.
  if (ms < YEAR) return `${Math.floor(ms / DAY)}d ago`;
  return `${Math.floor(ms / YEAR)}y ago`;
}

/**
 * Truncation the reader can see, measured in the columns a terminal will spend.
 *
 * A title cut silently at the column edge reads as the whole title, and pull
 * request titles are exactly where the interesting half is often at the end.
 *
 * Counted with `Bun.stringWidth` rather than `.length`, because they disagree
 * exactly where a table falls apart: a CJK title is two columns per character,
 * so forty of them would run to eighty and take every column after it with
 * them. The ellipsis is one column, and is reserved before the walk.
 *
 * Walked in grapheme clusters rather than code points, because width is not
 * additive over the pieces of a character. `❤` is one column and the variation
 * selector after it is none, but `❤️` — the two together, which is what a
 * keyboard produces — is two: measured a piece at a time, thirty of them read
 * as thirty and printed as sixty, and this overshot its own budget by half
 * again while checking it. Clusters are also the unit a reader sees, so the cut
 * no longer lands between a letter and its accent.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function fit(text: string, columns: number): string {
  if (Bun.stringWidth(text) <= columns) return text;
  let kept = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const width = Bun.stringWidth(segment);
    if (used + width > columns - 1) break;
    kept += segment;
    used += width;
  }
  return `${kept}\u2026`;
}

function pad(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - Bun.stringWidth(text)));
}

/**
 * As much of the text as fits, taken from one end.
 *
 * Its own function because `elide` needs both ends and `fit` needs the ellipsis
 * reserved; this is the part they share.
 */
function take(clusters: readonly string[], columns: number, fromEnd: boolean): string {
  let kept = "";
  let used = 0;
  for (const cluster of fromEnd ? [...clusters].reverse() : clusters) {
    const width = Bun.stringWidth(cluster);
    if (used + width > columns) break;
    kept = fromEnd ? cluster + kept : kept + cluster;
    used += width;
  }
  return kept;
}

/**
 * Truncation that keeps both ends, for a name whose ends both identify it.
 *
 * A repository is told apart by its owner and by the *end* of its name, and
 * cutting the end off is how `acme/cluster-api-provider-aws` and
 * `acme/cluster-api-provider-gcp` come to print as the same row — in the column
 * whose only job is to say which pull request this is. Two of somebody's
 * repositories sharing a long prefix is a naming convention, not bad luck.
 *
 * Titles keep the plain cut above: prose reads from the left, and a title that
 * has lost its end is still the same title, where an identifier that has lost
 * its end is a different pull request.
 */
function elide(text: string, columns: number): string {
  if (Bun.stringWidth(text) <= columns) return text;
  const clusters = [...GRAPHEMES.segment(text)].map(({ segment }) => segment);
  // The ellipsis costs a column; the tail takes the odd one of what is left,
  // because that is the half doing the distinguishing.
  const tail = Math.floor((columns - 1) / 2);
  return `${take(clusters, columns - 1 - tail, false)}\u2026${take(clusters, tail, true)}`;
}

/**
 * `repo#pull`, bounded so it cannot push the title column sideways.
 *
 * The pull number survives whatever the repository name has to give up: pull
 * numbers are per-repository, so an identifier that kept the number and lost
 * the repository identifies nothing at all.
 */
function identify(repo: string, pull: number, columns: number): string {
  const suffix = `#${pull}`;
  return `${elide(repo, columns - Bun.stringWidth(suffix))}${suffix}`;
}

/**
 * When this row last became what it says it is.
 *
 * A finished run is dated by its outcome, a running one by its start, and a
 * queued one by the moment Engwire wrote the decision down. That reads as "as
 * of" against whatever the status column says, which is the only reading that
 * is true for every row.
 *
 * The same instant `recentRuns` orders and truncates by, and it has to be: a
 * column sorted on one clock and labelled with another does not descend.
 */
function asOf(run: ReviewRun): string {
  return run.finishedAt ?? run.startedAt ?? run.createdAt;
}

export async function status(): Promise<number> {
  const p = paths();

  const running = isLocked(p.lockFile);

  if (!(await Bun.file(p.dbFile).exists())) {
    console.log(running ? "Runner    running" : "Runner    stopped");
    // Only for a runner that is up. That one is the state least likely to
    // explain itself — holding the lock, having written nothing — and its
    // output is the only place that can. Stopped, there is nothing there to
    // read: `service install` is what creates the directory, so on the fresh
    // installation this branch usually describes it does not exist yet, and
    // the line would stand between the reader and the one below it that is
    // actually a next step.
    if (running) {
      for (const line of logsNote(p.logsDir)) console.log(line);
      console.log("");
      // Not `nothingRunYet`: that offers `run --once`, and a runner holding
      // the lock is exactly what makes that command fail. The advice is for a
      // stopped installation, which is the only state it is true in.
      console.log("No review history yet.");
    } else {
      console.log(nothingRunYet(await Bun.file(p.configFile).exists()));
    }
    return 0;
  }

  const store = new Store(p.dbFile);
  try {
    // The lock says whether a runner is live; the row says which one. The row
    // outlives a runner that crashed, so it is read only when the lock was just
    // observed held — a probe, not a lock this holds, so the pid and start time
    // are the best available answer rather than a guaranteed one.
    const holder = running ? store.runner() : null;
    const who = holder
      ? ` ${holder.version} since ${ago(holder.startedAt)} (pid ${holder.pid})`
      : "";
    console.log(fit(running ? `Runner    running${who}` : "Runner    stopped", ROW));
    // A running runner is whichever binary its supervisor started, and an
    // upgrade in place does not disturb it — `install.sh` replaces the file
    // while launchd goes on running the one it opened. That is the correct
    // behaviour, since a review may be in flight, but it means the version
    // reviewing your code can quietly be months behind the one you just
    // installed. Nothing else on the machine notices.
    if (holder && holder.version !== VERSION) {
      // The fact is always worth printing and is stated without deciding which
      // side is behind — running an older `engwire` against a newer runner is
      // the same observation from the other end.
      // Terse, bounded, and with the remedy on the line below rather than
      // beside it. A version is whatever somebody tagged, and this line and the
      // runner line above are the only two places one reaches the report
      // uninspected — so the report that bounds every other line it prints
      // should not be pushed past the edge by a long prerelease, and truncation
      // is a better failure than wrapping the line telling you your runner is
      // stale.
      console.log(fit(`Version   runner ${holder.version}, this engwire ${VERSION}`, ROW));
      const remedy = versionRemedy();
      if (remedy) console.log(`${" ".repeat(AGE + 2)}${remedy}`);
    }
    // The other half of "is it working". The runner line above says a process
    // is alive, which is not the same as it getting anywhere: a runner held
    // since Tuesday because `gh` is signed in as somebody else looks exactly
    // like one working through a quiet queue, and the queued rows below look
    // the same under both.
    //
    // An age, and no verdict. Whether a gap is too long depends on
    // `poll_interval`, and reading the config here would give `status` a second
    // opinion about a file it does not own — so it shows the fact and leaves
    // the reader, who knows what they set, to judge it. Shown for a stopped
    // runner too, where it says when this installation last did anything.
    const polled = store.lastPoll();
    console.log(`Polled    ${polled === null ? "never" : ago(polled)}`);
    // Current work gets a place of its own, because the table below cannot
    // keep one for it: those rows are ordered by activity and capped, so
    // fifteen requests arriving during a twenty-minute review push the review
    // itself off the report — the single row answering the question the reader
    // opened the command with. "Running" on the first line says a process is
    // alive; this says what it is spending its one execution slot on.
    // Only while a runner holds the lock. A row still marked running under a
    // stopped runner is the wreckage of a crash — `recoverInterrupted` settles
    // it on the next start — and calling that current work would be this
    // report's own kind of lie. The table below still shows the row.
    const current = running
      ? store.activeRuns().find((run) => run.status === "running")
      : undefined;
    if (current) {
      console.log(
        // "claimed", not "started": `claimNext` stamps this the moment the run
        // leaves the queue, and the checkout comes after — a first clone of a
        // large repository can spend minutes there before Claude is reached at
        // all. "Started 9m ago" would make that read as nine minutes of review,
        // in the one line somebody opens this report at 2am to understand.
        `Review    ${identify(current.repo, current.pullNumber, WHERE)} claimed ${ago(current.startedAt ?? current.createdAt)}`,
      );
    }
    // The answer to "why is nothing happening", and it costs a line.
    for (const line of logsNote(p.logsDir)) console.log(line);

    const runs = store.recentRuns(15);
    if (runs.length === 0) {
      console.log("");
      // Not "no requests seen": a draft held under `skip_drafts` is observed
      // and deliberately left unrecorded, so Engwire can have seen one and have
      // nothing to show. What is empty is the history, and that is what to say.
      console.log("No review history yet.");
      return 0;
    }
    console.log("");
    // Under the status column, which is where a detail's own line belongs.
    const indent = " ".repeat(AGE + 2);
    for (const run of runs) {
      const where = identify(run.repo, run.pullNumber, WHERE);
      const row = `${ago(asOf(run)).padStart(AGE)}  ${run.status.padEnd(STATUS)} ${pad(where, WHERE)} ${fit(plain(run.title), TITLE)}`;
      const detail = run.detail ? (REASONS.get(run.detail) ?? plain(run.detail)) : null;
      // A detail with room left on the row rides along — a dismissal reason
      // beside a short title usually has it. Anything longer takes its own
      // line, indented under the status it belongs to, rather than being
      // wrapped mid-word by the terminal through the one part of the row that
      // was trying to explain something. Bounded there too: a `git` error
      // arrives as long as `git` felt like making it, and the whole of it is in
      // the log this report already names.
      if (detail === null) console.log(row);
      else if (Bun.stringWidth(row) + 2 + Bun.stringWidth(detail) <= ROW) {
        console.log(`${row}  ${detail}`);
      } else console.log(`${row}\n${indent}${fit(detail, ROW - indent.length)}`);
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
