/**
 * @file `engwire uninstall` — take Engwire back off this machine.
 *
 * The paths depend on `ENGWIRE_HOME` and the XDG variables, so the command
 * resolves them exactly as the runner does. The plain invocation inventories
 * them and removes nothing; `--yes` performs the removal.
 */

import { lstatSync, readlinkSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { paths, resolveDeepest } from "../config/paths.ts";
import type { InstalledPlist, JobState } from "../service/launchd.ts";
import { acquireLock, LockedError } from "../service/lock.ts";

/**
 * Said by both invocations, because both are answering for the same thing: what
 * this installation has here. A kept service may have been listed directly
 * above it — foreign, or an orphan launchd still has — so the sentence speaks
 * for what this installation owns rather than for the machine.
 */
const NOTHING = "Nothing here belongs to this installation: no service it can claim, no data, no config.";

/**
 * Whether anything is at this path, a link with nothing behind it included.
 *
 * `existsSync` says no to a dangling one, which would let the listing report an
 * empty machine while `removeTree` still has an entry to unlink and name.
 */
function entryAt(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    // A regular file partway along the path: nothing is at this one either.
    // Everything else — unreadable, a loop, a disk answering badly — is a
    // failure to look, and this command's first job is saying what is still on
    // the disk. Reporting an empty machine because it could not see is the one
    // answer worth a stack trace.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Whether anything is at this path, a link with nothing behind it included. */
function present(path: string): boolean {
  return entryAt(path) !== undefined;
}

/**
 * Whether the two removal roots, resolved by `entry`, are one tree or one
 * inside the other.
 *
 * The XDG bases can arrange either. Removing the outer root silently consumes
 * the inner one, while a single root cannot preserve the promised order between
 * removing configuration and removing the lock pathname.
 */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

/**
 * A path with its ancestors resolved and its own last component left alone.
 *
 * The same split `removeTree` works to: a link above the root is how the path
 * is spelled and is followed, while a link *at* the root stands in for the
 * directory and is not. Comparing the spellings instead would miss two roots
 * that overlap only once an aliased ancestor is followed — and canonicalising
 * the last component too would resolve exactly the link this command has
 * promised not to look through.
 */
function entry(path: string): string {
  return join(resolveDeepest(dirname(path)), basename(path));
}

/**
 * Whether removing the config tree would take the lock's real location with it.
 *
 * `overlaps` leaves a root symlink unresolved because removal unlinks it. The
 * lock asks where `acquireLock` actually writes, so it is fully resolved. If
 * that location is inside the config tree, removing config would let another
 * runner create an independent lock at the same pathname.
 */
function configConsumesLock(root: string, lockFile: string): boolean {
  const lock = resolveDeepest(lockFile);
  return lock === root || lock.startsWith(`${root}${sep}`);
}

/**
 * Whether the runner lock is reached through a symlink.
 *
 * `configConsumesLock` above asks where the lock lives, and answers from
 * `resolveDeepest` — which cannot see past a link whose target does not exist
 * yet: it climbs to the parent and re-appends the name, reporting the link's
 * own path. A link can therefore put the lock outside the model the removal
 * order is built on, and nothing here has to know what SQLite makes of one to
 * say that is not a position to delete from.
 *
 * Rather than a cleverer resolver, the entry itself: Engwire only ever creates
 * `runner.lock` as a database, so a link there is somebody's arrangement this
 * command cannot account for, and the honest answer is to say so.
 */
function lockIsLinked(lockFile: string): boolean {
  return entryAt(lockFile)?.isSymbolicLink() === true;
}

/**
 * Whether the lock could not be taken because there is nowhere to take one.
 *
 * `acquireLock` builds the data directory before it opens anything, and
 * `mkdirSync` answers a regular file — or a link with nothing behind it — with
 * `EEXIST`, measured because `ENOTDIR` is the likelier guess and the wrong one.
 * Nothing a runner could be using is behind either, so this is the one lock
 * failure `uninstall` walks through rather than dying on a stack trace with the
 * service already stopped.
 */
function rootCannotHoldALock(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Remove one of the two directories this installation owns.
 *
 * A root that is a symlink is unlinked and reported, never followed: its target
 * may be moved Engwire data or an unrelated directory, and resolving before
 * deletion would introduce a race. A symlink above the root remains part of the
 * path's spelling and is followed; otherwise installations beneath aliased
 * ancestors would be impossible to remove.
 */
function removeTree(path: string): string | null {
  // Asked again here, and by the same reading the listing used: a root beneath
  // a regular file is as absent as one never made, and both `lstatSync` and
  // `rmSync` answer that with `ENOTDIR` rather than a shrug. Without this the
  // config root could throw on the way out — after the data directory had
  // already gone, which is the worst moment for this command to stop talking.
  const at = entryAt(path);
  if (at === undefined) return null;
  // `lstat`, so the link itself was examined rather than its target, and a link
  // with nothing behind it is still a link.
  const names = at.isSymbolicLink() ? readlinkSync(path) : null;
  if (names !== null) {
    rmSync(path, { force: true });
    return `${path} is a link to ${names} — the link is gone, and nothing was removed through it`;
  }
  rmSync(path, { recursive: true, force: true });
  return null;
}

export async function uninstall(options: {
  confirmed: boolean;
  /**
   * The machine's launchd job and whose it is. Passed in rather than reached
   * for: the label is one per user, so a test run and the reviewer's own
   * service are the same job to `launchctl`.
   */
  service: InstalledPlist;
  /**
   * What launchd says about a job no plist describes — the one fact about the
   * service that cannot be read off the disk, and the one that decides whether
   * "Removed." is the whole truth. `absent` when a plist was found: a job with
   * a record is not an orphan, and launchd is not asked about it.
   */
  job: JobState;
}): Promise<number> {
  const p = paths();
  const configDir = dirname(p.configFile);
  // Two questions with one answer, because the answer is the same sentence: the
  // two roots cannot be removed one after the other and have the order mean
  // what this command says it means.
  const configRoot = entry(configDir);
  const entangled =
    overlaps(entry(p.dataDir), configRoot) || configConsumesLock(configRoot, p.lockFile);
  // Relative roots move with the caller's working directory. Inventory remains
  // useful, but a confirmed removal must not act on that unstable identity.
  const adrift = !isAbsolute(p.dataDir) || !isAbsolute(configDir);
  const linkedLock = lockIsLinked(p.lockFile);
  // One ordered list, read twice: the plain invocation prints the `short` line
  // of the first that applies, and a confirmed run prints its `long` one. Two
  // lists is how a preview and a refusal come to name different reasons for the
  // same machine.
  const refusal = [
    adrift && {
      short: [
        "Removing it is not possible while those paths are relative: their location",
        "depends on the directory this command is run from.",
      ],
      long: [
        "Those paths are relative, so their location depends on the directory this",
        "command is run from — and removing them would delete whatever happens to sit",
        "there now. Nothing was touched. Replace the relative base with an absolute",
        // "The same location", because any other absolute path is a different
        // installation: the data would still be wherever this was pointing, and
        // the next run would report an empty machine and remove nothing.
        "spelling of the same location, then run this again.",
      ],
    },
    entangled && {
      short: [
        "Removing it is not possible while those two paths are one tree, one is",
        "inside the other, or one reaches into the other through a link.",
      ],
      long: [
        "Those two paths are one tree, one is inside the other, or one reaches",
        "into the other through a link, so removing them separately is not",
        "something this can do: one removal would swallow the other — or the lock",
        "held over it — and what it reported afterwards would not match what",
        "happened. Nothing was touched. Untangle the two paths, then run this",
        "again.",
        // No further advice, on purpose. "Point XDG_DATA_HOME somewhere else"
        // moves the installation rather than untangling this one, and on macOS
        // changes the very directory the plist is matched against — turning
        // this machine's own service foreign. "Stop the service" is worse: the
        // one named above may be supervising somebody else's installation,
        // which this command exists to leave alone. What needs stopping is a
        // question the ordinary run answers, once the layout lets it get there.
      ],
    },
    linkedLock && {
      short: ["Removing it is not possible while the runner lock is a symlink."],
      long: [
        `The runner lock ${p.lockFile} is a symlink, and taking it would follow`,
        "that link — so the lock this command holds would live somewhere it has",
        "not accounted for, and removing the config could delete it out from",
        "under itself. Engwire never makes this a link. Nothing was touched.",
        "",
        "A runner may be holding the lock at the far end right now, and replacing",
        "the link would leave the next attempt locking a different file from the",
        "one it has to wait for. Stop that runner — and anything that may start it",
        "again, or it will be holding the old file while this holds the new one.",
        "Once it stays stopped, remove the link and run this again.",
      ],
    },
  ].find((one) => one !== false) || null;
  // Only a job this installation can claim, which the type already guarantees:
  // `theirs` carries no way to remove it.
  const service = options.service.whose === "ours" ? options.service : null;
  const plist = service?.plistPath ?? null;
  // A job launchd said it has, and one it would not answer about, are both
  // reasons to leave the label alone — but only the first may be called loaded.
  const orphaned = options.job !== "absent";
  // A kept job that could still be supervising *this* installation: any orphan,
  // and a plist that cannot say which installation it supervises. Not one that
  // names another installation's data directory — that job holds *that*
  // installation's lock, so it is neither what is keeping this one nor
  // something to warn about here. Read twice: once for what a held lock means,
  // and once for what a finished run has to say on its way out.
  const mayRestartThisRunner =
    orphaned ||
    (options.service.whose === "theirs" && options.service.supervises === null);

  // Looked at once each: two adjacent observations of the same path can
  // disagree, and the listing and the verdict have to be talking about one
  // machine.
  const dataHere = present(p.dataDir);
  const configHere = present(configDir);
  const hadRoots = dataHere || configHere;
  const targets = [
    { label: "Service", path: plist !== null && present(plist) ? plist : null },
    { label: "Data", path: dataHere ? p.dataDir : null },
    { label: "Config", path: configHere ? configDir : null },
  ].filter((target) => target.path !== null);

  for (const target of targets) console.log(`${target.label.padEnd(9)} ${target.path}`);
  // Listed but never removed: deleting the running binary is a trick, not a
  // feature, and whoever installed it chose where it went.
  // `Bun.isStandaloneExecutable` is the only reliable way to tell an installed
  // engwire from a source checkout, where `process.execPath` is the Bun runtime
  // and must not be suggested to anybody.
  if (Bun.isStandaloneExecutable) console.log(`Binary    ${process.execPath} (kept)`);
  if (options.service.whose === "theirs") {
    const whose =
      options.service.supervises === null
        ? "cannot say which installation it supervises"
        : `supervises ${options.service.supervises}`;
    console.log(`Service   ${options.service.plistPath} (kept — ${whose})`);
  }
  // The `theirs` rule above, reached from the other side: a job this cannot
  // claim is named and left, never booted out. `jobState` carries where the
  // state comes from. Engwire reaches it two ways — a `service install` that
  // could not restore the plist it replaced, and somebody with `rm` — and needs
  // neither story to answer for it.
  if (options.job === "loaded") {
    console.log("Service   loaded, and nothing on disk describes it (kept)");
  } else if (options.job === "unknown") {
    // Not "loaded": `launchctl` refused the question, which is short of
    // evidence that a job is there. It is still reason enough to keep away
    // from the label, and that is what the line has to say without saying more.
    console.log("Service   launchd would not say whether a job is loaded (kept)");
  }

  if (!options.confirmed) {
    console.log("");
    if (targets.length === 0) {
      console.log(NOTHING);
      return 0;
    }
    console.log("Data holds Engwire's own clones of every repository it has reviewed, the");
    console.log("transcripts of those reviews, and its record of what it has already seen.");
    console.log("");
    if (refusal) for (const line of refusal.short) console.log(line);
    else console.log("Remove this installation: engwire uninstall --yes");
    return 0;
  }

  // Listing is never unsafe, so a refusal waits until something is about to
  // happen — and then it is the same one the listing just named.
  if (refusal) {
    console.error("");
    for (const line of refusal.long) console.error(line);
    return 1;
  }

  // First, and whether or not a plist was listed above: `bootout` is what stops
  // a running service, and the file can go between the read that claimed it and
  // this line. A job loaded with no plist at all never reaches here — that is
  // the one named above, unidentifiable and so not this command's to boot out.
  //
  // False when this installation can no longer claim the job — `remove` re-asks
  // whose it is before booting anything out, and another installation taking
  // the label is only one way to lose it. Nothing was stopped then, and nothing
  // may be reported as stopped.
  const stopped = service ? await service.remove() : false;
  if (service && !stopped) {
    // Two reasons for the same `false`, and they want opposite things: another
    // installation holding the label now means this installation's data is safe
    // to delete, while a plist that simply vanished means the job it described
    // may still be loaded — the orphan case, which nobody asked launchd about
    // because the first read found a plist. Deleting under that job leaves
    // launchd restarting a runner onto a data directory that is gone.
    //
    // Rather than a second ownership model, hand the question back to the one
    // that already answers it: another run reads the plist fresh, and a foreign
    // one, an unreadable one or none at all each get their own answer.
    console.error("");
    console.error("The launchd job could no longer be claimed when the time came, so it was");
    console.error("left alone — another installation may hold the label now, or the plist may");
    console.error("simply be gone, in which case its job could still be loaded. Nothing was");
    console.error("removed. Run this again: the next run reads the service fresh and can say");
    console.error("which it is.");
    return 1;
  }

  // Held, not probed. A foreground `engwire run` could start in the moment
  // between asking whether one is running and deleting the answer, and would
  // then be reviewing from a database this command has already called gone.
  // Taking the lock both proves no runner is live and keeps it that way.
  let left: string[] = [];
  // Held, not probed, still. Asking whether the data directory could hold a
  // lock and only then taking one is the same shape this rejects: between the
  // question and the answer a runner starts, and its data goes out from under
  // it. So the attempt is the question, and the answer is read off the failure.
  let release: (() => void) | null = null;
  try {
    release = acquireLock(p.lockFile);
  } catch (error) {
    if (rootCannotHoldALock(error)) release = null;
    else if (error instanceof LockedError) {
      console.error("");
      if (mayRestartThisRunner) {
        console.error("A runner is still running, and the service above was kept — it may be");
        console.error("what restarts it. `engwire service uninstall` stops that job.");
      } else if (stopped) {
        console.error("A runner is still running — stop it and run this again. Its service is");
        console.error("already removed, so nothing here will start it back up.");
      } else {
        // Nothing was removed, so nothing may be said to have been. Off macOS
        // that is the ordinary case rather than the empty one: `installedPlist`
        // only ever reads a launchd plist, so a systemd unit — or whatever else
        // is keeping this runner alive — is invisible here and will put it
        // straight back. Claiming a service was removed would send someone into
        // the same retry loop the branch above exists to prevent.
        console.error("A runner is still running — stop it and run this again. Engwire removed");
        console.error("no service of its own here, so if something supervises that runner, stop");
        console.error("that too.");
      }
      return 1;
    } else throw error;
  }

  try {
    // Config first, data last, whether or not a lock was taken — one order, for
    // two reasons that want the same thing.
    //
    // A held transaction survives its file being unlinked but does not survive
    // the *pathname*: recreate the directory and a second runner takes an
    // independent lock at the same path, measured. So the data root goes last,
    // keeping that pathname real for as long as this holds it, and the config
    // goes first, because a runner that cannot read one never reaches the lock.
    // Where no lock could be taken at all, the malformed data root is the only
    // thing standing in for one, and last is where that belongs too.
    left = [configDir, p.dataDir].map(removeTree).filter((why) => why !== null);
  } finally {
    release?.();
  }

  console.log("");
  // `--yes` over an installation that was never here removed nothing, and the
  // plain invocation already says so. A bare "Removed." is the same overclaim
  // this command spends the rest of its output avoiding. A claimed service
  // counts even when no plist was listed: `remove` boots the job out either
  // way, and that is something happening.
  for (const why of left) console.log(why);
  const removed = left.length === 0 ? "Removed." : "Removed the rest.";
  console.log(!stopped && !hadRoots ? NOTHING : removed);
  // "Kept", not "still running": only an orphan is a job launchd was asked
  // about. A foreign plist is a file, and a file outlives its job — the one
  // left behind by a hand-deleted install is a plist with nothing loaded.
  if (options.service.whose === "theirs" || orphaned) {
    if (mayRestartThisRunner) {
      // A possibility, not a fact: an unidentifiable job may be this
      // installation's own, and so may an orphan be. Not stopped anyway,
      // because the thing on the
      // other end may equally be another installation's runner in the middle of
      // a review, and nothing here can tell. So it is named for what it might
      // do, and the last word is the reader's.
      console.log("The service above was kept, and it may be this installation's own — it can");
      console.log("start a runner here again. `engwire service uninstall` removes it.");
    } else {
      console.log("The service above was kept: `engwire service uninstall` removes it.");
    }
  }
  return 0;
}
