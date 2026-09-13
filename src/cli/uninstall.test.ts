import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { paths } from "../config/paths.ts";
import { acquireLock } from "../service/lock.ts";
import type { InstalledPlist, JobState } from "../service/launchd.ts";
import { uninstall } from "./uninstall.ts";

/**
 * Whether this volume spells one directory two ways. macOS is case-insensitive
 * by default and APFS can be formatted either way, so the alias below is a real
 * layout here and not a layout at all on a case-sensitive checkout.
 */
const ALIASES_CASE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "engwire-case-"));
  try {
    mkdirSync(join(probe, "Probe"));
    return existsSync(join(probe, "probe"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let dir: string;
let home: string | undefined;
let plistFile: string;
let removed: number;
/** A second installation taking the label between the answer and the bootout. */
let changedHands: boolean;
let service: InstalledPlist;
let job: JobState;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-uninstall-"));
  plistFile = join(dir, "com.engwire.local.plist");
  // Put back rather than dropped: the suite shares one process, and somebody
  // running it under their own `ENGWIRE_HOME` would otherwise have every later
  // file resolve the default installation instead.
  home = process.env.ENGWIRE_HOME;
  process.env.ENGWIRE_HOME = join(dir, "home");
  // Never the real one: a launchd label is one per user, so a test that reached
  // for `launchd.uninstall()` would boot out whatever service the machine
  // running the tests actually has.
  removed = 0;
  changedHands = false;
  job = "absent";
  // Supervising this installation, which is the ordinary case.
  service = {
    whose: "ours",
    plistPath: plistFile,
    executable: join(dir, "engwire"),
    remove: async () => {
      if (changedHands) return false;
      removed += 1;
      return true;
    },
  };
});

afterEach(async () => {
  if (home === undefined) delete process.env.ENGWIRE_HOME;
  else process.env.ENGWIRE_HOME = home;
  await rm(dir, { recursive: true, force: true });
});

/** An installation with something to lose. */
function install(): { dataDir: string; configDir: string } {
  const p = paths();
  const configDir = dirname(p.configFile);
  mkdirSync(p.dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(p.configFile, "");
  writeFileSync(plistFile, "");
  return { dataDir: p.dataDir, configDir };
}

async function run(confirmed: boolean): Promise<{ code: number; said: string }> {
  const log = console.log;
  const error = console.error;
  let said = "";
  const capture = (message: unknown) => {
    said += `${message}\n`;
  };
  console.log = capture;
  console.error = capture;
  try {
    return { code: await uninstall({ confirmed, service, job }), said };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("uninstall", () => {
  test("says what is on the machine and removes none of it", async () => {
    const { dataDir, configDir } = install();

    const { code, said } = await run(false);

    expect(code).toBe(0);
    for (const path of [plistFile, dataDir, configDir]) expect(said).toContain(path);
    expect(said).toContain("engwire uninstall --yes");
    // The whole point of the plain invocation: it is also how someone finds out
    // what Engwire is keeping, and finding out must cost nothing.
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(configDir)).toBe(true);
    expect(removed).toBe(0);
  });

  test("a claimable job with no plist left is not previewed as nothing", async () => {
    // The supplied ownership answer still requires action even though no plist
    // can be listed. Confirmation will call remove(), which revalidates it.
    const { code, said } = await run(false);

    expect(code).toBe(0);
    expect(said).not.toContain("Nothing here belongs");
    expect(said).toContain("engwire uninstall --yes");
    // And no data was described: there is none, and this command is read by
    // people whose installation is already in pieces.
    expect(said).not.toContain("Data holds Engwire's own clones");
  });

  test("--yes over an installation that was never here does nothing at all", async () => {
    // Acquiring a lock here would create the absent data directory, or fail
    // if its parent were unwritable, despite there being nothing to remove.
    service = { whose: "none" };

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(said).toBe(
      "Nothing here belongs to this installation: no service it can claim, no data, no config.\n",
    );
    expect(existsSync(paths().dataDir)).toBe(false);
  });

  test("an installation that was never here says so, and says only that", async () => {
    // Clear the fixture's claimed service too: no inventory and no claim means
    // one sentence, with no leading separator.
    service = { whose: "none" };

    const { code, said } = await run(false);

    expect(code).toBe(0);
    expect(said).toBe(
      "Nothing here belongs to this installation: no service it can claim, no data, no config.\n",
    );
  });

  test("--yes removes the service, the data and the config", async () => {
    const { dataDir, configDir } = install();

    const { code } = await run(true);

    expect(code).toBe(0);
    expect(removed).toBe(1);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(configDir)).toBe(false);
  });

  test("a runner still holding the lock keeps its data", async () => {
    // Only a foreground `engwire run` reaches here — the service was stopped a
    // moment ago. Deleting the database under a live runner would leave it
    // reviewing from state this command has already called gone.
    const { dataDir } = install();
    const release = acquireLock(paths().lockFile);
    try {
      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("still running");
      expect(existsSync(dataDir)).toBe(true);
      // The service is stopped first and stays stopped: a supervisor that
      // restarts the runner would make the retry fail the same way forever.
      expect(removed).toBe(1);
    } finally {
      release();
    }
  });

  test("a supervisor Engwire cannot see is not called already removed", async () => {
    // Off macOS `installedPlist` only ever answers `none`, so a runner kept
    // alive by a systemd unit reaches the plain branch with nothing removed.
    // Telling that person their service is already gone is both false and the
    // retry loop the foreign branch exists to prevent: the unit puts the runner
    // back before they can run this again.
    const { dataDir } = install();
    service = { whose: "none" };
    const release = acquireLock(paths().lockFile);
    try {
      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).not.toContain("already removed");
      expect(said).toContain("service of its own");
      expect(existsSync(dataDir)).toBe(true);
    } finally {
      release();
    }
  });

  test("a service supervising another installation is left alone", async () => {
    // `ENGWIRE_HOME` is how someone runs a second installation, and the launchd
    // label is one per user — so the job this plist describes may belong to the
    // first. Stopping it while deleting only the second's files is the opposite
    // of what was asked for, and it would take down a runner mid-review.
    const { dataDir, configDir } = install();
    service = {
      whose: "theirs",
      plistPath: plistFile,
      supervises: join(dir, "somebody-elses", "data"),
    };

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(removed).toBe(0);
    expect(said).toContain("supervises");
    expect(said).toContain("engwire service uninstall");
    // A plist is a file, and nobody asked launchd whether its job is loaded —
    // `jobState` is only asked when no plist describes one. Saying it was
    // left running would be a fact this command does not have.
    expect(said).not.toContain("running");
    // This installation's own files still go.
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(configDir)).toBe(false);
  });

  test("a loaded job with no plist is named and left running", async () => {
    // Reached after a `service install` that could not restore the plist it
    // replaced, and by anybody with `rm`. Either way the only record of the
    // service is launchd's, and not answering "Removed." over a runner that is
    // still supervised is the one thing this command owes.
    install();
    service = { whose: "none" };
    job = "loaded";

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(removed).toBe(0);
    expect(said).toContain("nothing on disk describes it");
    expect(said).toContain("engwire service uninstall");
    // Kept is not the whole story: an orphan may be this installation's
    // own, so it can put a runner back here after everything it reviews from
    // is gone. Named as a possibility, because it is one — and left running,
    // because the alternative is booting out a job that may be somebody
    // else's runner mid-review.
    expect(said).toContain("start a runner here again");
  });

  test("a job launchd would not answer about is doubted, not announced", async () => {
    // The third state exists so this line can stop short of the second. Keeping
    // away from a label Engwire is unsure about is right; telling somebody a
    // service is loaded on that same evidence is the overclaim the foreign
    // plist above already taught this command not to make.
    install();
    service = { whose: "none" };
    job = "unknown";

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(said).not.toContain("nothing on disk describes it");
    expect(said).toContain("would not say");
    expect(said).toContain("engwire service uninstall");
    // Unsure it is there is still reason enough to warn about what it may do.
    expect(said).toContain("start a runner here again");
  });

  test("a lock held under a job left loaded says what to stop first", async () => {
    // The ordinary advice is to stop the runner and try again, which a
    // supervisor makes untrue: it puts the runner straight back, and every
    // retry fails on the same lock.
    install();
    service = { whose: "none" };
    job = "loaded";
    const release = acquireLock(paths().lockFile);
    try {
      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("engwire service uninstall");
      expect(said).not.toContain("already removed");
    } finally {
      release();
    }
  });

  test("a lock held under an unidentifiable service names it as the suspect", async () => {
    // A plist that cannot be parsed may be this installation's own, edited
    // past recognition — so the job it describes may be the very thing putting
    // the runner back, and "stop it and run this again" would never come true.
    install();
    service = { whose: "theirs", plistPath: plistFile, supervises: null };
    const release = acquireLock(paths().lockFile);
    try {
      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("stops that job");
      expect(removed).toBe(0);
    } finally {
      release();
    }
  });

  test("a foreign service is not blamed for holding this installation's lock", async () => {
    // It supervises another data directory, so it holds that installation's
    // lock rather than this one's. Naming it as the thing to stop would send
    // somebody to boot out a runner that is neither in the way nor theirs.
    const { dataDir } = install();
    service = {
      whose: "theirs",
      plistPath: plistFile,
      supervises: join(dir, "somebody-elses", "data"),
    };
    const release = acquireLock(paths().lockFile);
    try {
      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).not.toContain("stops that job");
      expect(said).toContain("service of its own");
      // Nothing of this installation's went either: the lock still holds.
      expect(existsSync(dataDir)).toBe(true);
      expect(removed).toBe(0);
    } finally {
      release();
    }
  });

  test("a job that cannot be claimed stops the run before anything is deleted", async () => {
    // `bootout` names the label, not the plist this answered from, so `remove`
    // re-checks and declines. Two reasons produce that one `false`, and they
    // want opposite things: another installation holding the label leaves this
    // installation's data safe to delete, while a plist that simply vanished
    // may have left its job loaded — deleting under that one has launchd
    // restarting a runner onto a data directory that is gone. Nothing here can
    // tell them apart, and the next run can, so nothing goes.
    const { dataDir, configDir } = install();
    changedHands = true;

    const { code, said } = await run(true);

    expect(code).toBe(1);
    expect(said).toContain("could no longer be claimed");
    expect(said).toContain("Run this again");
    expect(removed).toBe(0);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(configDir)).toBe(true);
    expect(said).not.toContain("Removed.");
  });

  test("a kept orphan is not followed by a sentence denying it", async () => {
    // Nothing of this installation's is left, but launchd still has a job —
    // and the summary is about what this installation can claim, not about what
    // the machine has. "No service" two lines under "Service loaded" is the kind
    // of contradiction that makes someone stop believing the rest of the output.
    service = { whose: "none" };
    job = "loaded";

    const { code, said } = await run(false);

    expect(code).toBe(0);
    expect(said).toContain("nothing on disk describes it");
    expect(said).toContain("belongs to this installation");
    expect(said).not.toContain("no service, data or config");
  });

  test("a lock symlink that resolves to itself is refused, not crashed into", async () => {
    // Resolution must tolerate a cycle long enough for the lock-entry check
    // to report the actionable refusal rather than throwing ELOOP.
    const p = paths();
    mkdirSync(p.dataDir, { recursive: true });
    mkdirSync(dirname(p.configFile), { recursive: true });
    writeFileSync(p.configFile, "");
    symlinkSync(p.lockFile, p.lockFile);

    const { code, said } = await run(false);

    expect(code).toBe(0);
    expect(said).toContain("the runner lock is a symlink");
  });

  test("a symlinked removal root is unlinked and reported, not followed", async () => {
    // `rmSync` unlinks a link rather than descending it, so without this the
    // command printed "Removed." while every clone stayed at the other end.
    // Following instead would be worse: nothing here can tell a volume somebody
    // moved the data to from a directory the link merely names, and `rm -rf`
    // through one naming `~` is not an uninstall. So it is unlinked and said.
    // Both roots, because both are removed the same way and only one of them
    // was ever pinned: the data directory is the one somebody moves to another
    // volume, and the config directory is the one they share between machines.
    const p = paths();
    for (const root of [p.dataDir, dirname(p.configFile)]) {
      const elsewhere = join(dir, `another-volume-${basename(root)}`);
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, "a-clone"), "private source");
      mkdirSync(dirname(root), { recursive: true });
      symlinkSync(elsewhere, root);

      const { code, said } = await run(true);

      expect(code).toBe(0);
      expect(existsSync(root)).toBe(false);
      // Not deleted behind the user's back, and not silently either.
      expect(existsSync(join(elsewhere, "a-clone"))).toBe(true);
      expect(said).toContain("nothing was removed through it");
      expect(said).toContain(elsewhere);
      // And the verdict agrees with the line above it.
      expect(said).toContain("Removed the rest.");
    }
  });

  test("a data root that is not a directory is removed rather than crashed on", async () => {
    // The lock is made inside the data directory, so `acquireLock` creates that
    // directory first — and cannot, where a file already is. Before this the
    // command died on `ENOTDIR` with a stack trace, having already stopped the
    // service. Nothing a runner could be holding is behind a regular file, so
    // there is nothing for the lock to protect and it is simply not taken.
    const p = paths();
    mkdirSync(dirname(p.dataDir), { recursive: true });
    writeFileSync(p.dataDir, "not a directory");
    mkdirSync(dirname(p.configFile), { recursive: true });
    writeFileSync(p.configFile, "");

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(said).not.toContain("ENOTDIR");
    expect(existsSync(p.dataDir)).toBe(false);
    expect(existsSync(dirname(p.configFile))).toBe(false);
  });

  test("a symlinked ancestor is spelling, not a redirection", async () => {
    // The other side of the contract, and the one a reader trips over: only the
    // root itself is refused. `ENGWIRE_HOME` reached through a link still names
    // a directory Engwire made and filled, which is why ownership resolves both
    // spellings to one installation. Refusing these too would leave every
    // installation under an aliased ancestor undeletable — on macOS `$TMPDIR`
    // is one, so it would be most of them.
    const real = join(dir, "real-home");
    const link = join(dir, "linked-home");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    process.env.ENGWIRE_HOME = link;
    const p = paths();
    mkdirSync(p.dataDir, { recursive: true });
    writeFileSync(join(p.dataDir, "a-clone"), "private source");

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(said).not.toContain("the link is gone");
    expect(said).toContain("Removed.");
    expect(existsSync(join(real, "data"))).toBe(false);
  });

  test("a root with nothing behind it is still an entry that is here", async () => {
    // `existsSync` calls a dangling link absent, while removal still has an
    // entry to unlink. Listing and removal must both use `lstat` here.
    const p = paths();
    mkdirSync(dirname(p.dataDir), { recursive: true });
    symlinkSync(join(dir, "never-existed"), p.dataDir);

    const { code, said } = await run(false);

    expect(code).toBe(0);
    expect(said).toContain(p.dataDir);
    expect(said).not.toContain("belongs to this installation");
  });

  test("the data root goes last, since it is where the lock lives", async () => {
    // Two reasons, one order. A held transaction outlives its file but not its
    // pathname — recreate the directory and another runner locks the same path
    // independently — so the data root goes last, and the config goes first
    // because a runner that cannot read one never reaches the lock. With a
    // dangling data root there is no lock at all, and then that root is the
    // only thing standing in for one, which wants the same order.
    const p = paths();
    mkdirSync(dirname(p.dataDir), { recursive: true });
    symlinkSync(join(dir, "never-existed"), p.dataDir);
    mkdirSync(dirname(dirname(p.configFile)), { recursive: true });
    symlinkSync(join(dir, "never-existed-either"), dirname(p.configFile));

    const { code, said } = await run(true);

    expect(code).toBe(0);
    // Each removal names itself as it happens, so the report is the order.
    const reported = (root: string) => said.indexOf(`${root} is a link`);
    expect(reported(dirname(p.configFile))).toBeGreaterThan(-1);
    expect(reported(dirname(p.configFile))).toBeLessThan(reported(p.dataDir));
    expect(existsSync(p.dataDir)).toBe(false);
  });

  test("a path it could not look at is not reported as empty", async () => {
    // `existsSync` answers false for "no" and for "could not tell", and this
    // command's first job is saying what private source is still on the disk.
    // An unreadable directory is a failure to look, and the loud version of
    // that beats an inventory that quietly reads as clean.
    const p = paths();
    const closed = dirname(p.dataDir);
    mkdirSync(closed, { recursive: true });
    chmodSync(closed, 0o000);
    try {
      await expect(run(false)).rejects.toThrow();
    } finally {
      chmodSync(closed, 0o700);
    }
  });

  test("a runner lock reached through a link is refused", async () => {
    // A link can put the lock outside the pathname model the removal order is
    // built on, and `resolveDeepest` cannot see where when the target does not
    // exist yet. Engwire never makes this a link, so the entry itself is the
    // answer — no need to know what anything downstream makes of one.
    const p = paths();
    mkdirSync(p.dataDir, { recursive: true });
    writeFileSync(join(p.dataDir, "a-clone"), "private source");
    symlinkSync(join(dir, "somewhere-else", "actual.lock"), p.lockFile);

    const plain = await run(false);
    expect(plain.code).toBe(0);
    expect(plain.said).toContain("runner lock is a symlink");

    const { code, said } = await run(true);

    expect(code).toBe(1);
    expect(said).toContain("is a symlink");
    // The refusal comes before the lock is ever taken, so a runner may be
    // holding the far end right now — and replacing the link would leave the
    // next attempt locking a different file from the one it must wait for.
    // Saying "replace it" without that is advice to delete data under a live
    // runner, which is the thing this guard exists to prevent — and stopping a
    // supervised runner is not stopping it, which is the distinction the held-
    // lock branch already makes.
    expect(said).toContain("Stop that runner");
    expect(said).toContain("anything that may start it");
    // Before the service is stopped, and before anything is deleted.
    expect(removed).toBe(0);
    expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
  });

  test("the listing and the refusal name the same reason", async () => {
    // Two conditions at once, and one ordered list deciding which is reported.
    // Read from two lists the preview and the refusal drifted apart, and named
    // different reasons for the same machine.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "both");
    process.env.XDG_DATA_HOME = join(dir, "both");
    try {
      const p = paths();
      mkdirSync(p.dataDir, { recursive: true });
      symlinkSync(join(dir, "never-existed"), p.lockFile);

      const plain = await run(false);
      const confirmed = await run(true);

      expect(plain.code).toBe(0);
      expect(confirmed.code).toBe(1);
      // Entangled roots outrank a linked lock in both, because they are one
      // list. The lock line must not be the one either of them reaches for.
      expect(plain.said).toContain("one tree");
      expect(confirmed.said).toContain("one tree");
      expect(plain.said).not.toContain("runner lock is a symlink");
      expect(confirmed.said).not.toContain("Engwire never makes this a link");
      expect(removed).toBe(0);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("relative roots are refused before anything is deleted", async () => {
    // `ENGWIRE_HOME=.` targets `data` and `config` beneath whichever directory
    // the caller happens to be in, so it is not a stable installation identity.
    process.env.ENGWIRE_HOME = relative(process.cwd(), join(dir, "home"));
    const p = paths();
    mkdirSync(p.dataDir, { recursive: true });
    writeFileSync(join(p.dataDir, "a-clone"), "private source");

    const plain = await run(false);
    expect(plain.code).toBe(0);
    expect(plain.said).toContain("relative");

    const { code, said } = await run(true);

    expect(code).toBe(1);
    // The shared rule's own sentence, and this command's consequence after it:
    // the refusal quotes the cause rather than restating it, so a second cause
    // arrives explained instead of mislabelled.
    expect(said).toContain("which is a relative path");
    expect(said).toContain("would delete whatever happens to sit");
    expect(removed).toBe(0);
    expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
  });

  test("roots nested inside each other are refused, not half-removed", async () => {
    // The XDG bases are independent, so one can be set inside the other, and
    // then the outer removal takes the inner root with it before the inner pass
    // ever looks. Everything this command says about order and about naming
    // what it kept is written for two separate trees, so a layout that is not
    // two separate trees gets a sentence rather than a partial uninstall.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "root");
    process.env.XDG_DATA_HOME = join(dir, "root", "engwire", "data");
    try {
      const p = paths();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, "a-clone"), "private source");

      // Listing is never unsafe, and answering "what is Engwire keeping here?"
      // is half of why this is a command at all.
      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain(p.dataDir);
      expect(plain.said).toContain("inside the other");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      // Nothing stopped and nothing deleted: the refusal comes before both.
      expect(removed).toBe(0);
      expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("the config root nested inside the data root is refused as well", async () => {
    // Config physically beneath data, with the lock outside the config tree.
    // Either resolved overlap or entry identity has to refuse two trees that are
    // one, whichever of them sees it first.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_DATA_HOME = join(dir, "root");
    process.env.XDG_CONFIG_HOME = join(dir, "root", "engwire", "cfg");
    try {
      const p = paths();
      mkdirSync(p.dataDir, { recursive: true });
      mkdirSync(dirname(p.configFile), { recursive: true });
      writeFileSync(join(p.dataDir, "a-clone"), "private source");
      writeFileSync(p.configFile, "");

      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain("inside the other");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      expect(removed).toBe(0);
      // Both roots, because a removal that ran before the refusal took either
      // one of them, and the one that is nested is the one a partial run would
      // reach first.
      expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
      expect(existsSync(p.configFile)).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("a data root whose entry sits in the config tree is refused", async () => {
    // A data root spelled inside the config tree and linking out of it, so the
    // lock resolves nowhere near config and that question is satisfied. What
    // still objects is that removing config unlinks the data root's own entry.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "cfg");
    process.env.XDG_DATA_HOME = join(dir, "cfg", "engwire", "store");
    try {
      const p = paths();
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, "a-clone"), "private source");
      mkdirSync(dirname(p.dataDir), { recursive: true });
      symlinkSync(elsewhere, p.dataDir);
      mkdirSync(dirname(p.configFile), { recursive: true });
      writeFileSync(p.configFile, "");

      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain("inside the other");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      expect(removed).toBe(0);
      // The link itself, not only what it points at: removing the config tree
      // would unlink the data root while leaving the target untouched, which a
      // sentinel at the far end cannot see.
      expect(lstatSync(p.dataDir).isSymbolicLink()).toBe(true);
      expect(existsSync(p.configFile)).toBe(true);
      expect(existsSync(join(elsewhere, "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("a config root that is itself a link, with the data root spelled through it", async () => {
    // Resolving the data root's ancestors hides that its path crosses the
    // config symlink. Unlinking config first would strand the private clones
    // and let the now-missing data path look successfully removed.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "cfg");
    process.env.XDG_DATA_HOME = join(dir, "cfg", "engwire", "store");
    try {
      const p = paths();
      const configDir = dirname(p.configFile);
      const target = join(dir, "target");
      mkdirSync(join(target, "store", "engwire"), { recursive: true });
      writeFileSync(join(target, "store", "engwire", "a-clone"), "private source");
      writeFileSync(join(target, "config.toml"), "");
      mkdirSync(dirname(configDir), { recursive: true });
      symlinkSync(target, configDir);

      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain("inside the other");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      expect(removed).toBe(0);
      expect(lstatSync(configDir).isSymbolicLink()).toBe(true);
      expect(existsSync(join(target, "store", "engwire", "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("a data root that resolves into the config tree without being spelled there", async () => {
    // What the resolved comparison is for, and the only shape that isolates it.
    // Two links: the data root's parent points into the config tree, and the
    // data root itself points back out — so the spelling is nowhere near config,
    // `resolveDeepest` follows both and puts the lock outside it, and the only
    // thing that sees the entanglement is `entry`, which resolves the parent and
    // leaves the root's own name alone. Removing config would take that name.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "cfg");
    process.env.XDG_DATA_HOME = join(dir, "outside", "link");
    try {
      const p = paths();
      const configDir = dirname(p.configFile);
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, "a-clone"), "private source");
      mkdirSync(join(configDir, "inner"), { recursive: true });
      writeFileSync(p.configFile, "");
      mkdirSync(join(dir, "outside"), { recursive: true });
      symlinkSync(join(configDir, "inner"), join(dir, "outside", "link"));
      // The data root's own last component, which `entry` leaves alone and
      // `resolveDeepest` follows: the whole difference between the two answers.
      symlinkSync(elsewhere, join(configDir, "inner", "engwire"));

      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain("inside the other");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      expect(removed).toBe(0);
      expect(lstatSync(p.dataDir).isSymbolicLink()).toBe(true);
      expect(existsSync(p.configFile)).toBe(true);
      expect(existsSync(join(elsewhere, "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test.skipIf(!ALIASES_CASE)(
    "a data root linking into differently cased config is refused for the lock",
    async () => {
      // The two roots really are separate here, by spelling and by entry — what
      // is not separate is the lock. `acquireLock` writes through the link, so
      // the real file sits inside the config tree under a casing no string
      // comparison matches, and the config pass would delete the pathname this
      // command is holding. Measured: it reported the link as gone with nothing
      // removed through it, while the config pass had already taken everything
      // at the far end.
      const before = { ...process.env };
      delete process.env.ENGWIRE_HOME;
      process.env.XDG_CONFIG_HOME = join(dir, "cfg");
      process.env.XDG_DATA_HOME = join(dir, "outside");
      try {
        const p = paths();
        mkdirSync(join(dir, "cfg", "Engwire", "store"), { recursive: true });
        writeFileSync(p.configFile, "");
        writeFileSync(join(dir, "cfg", "Engwire", "store", "a-clone"), "private source");
        mkdirSync(join(dir, "outside"), { recursive: true });
        symlinkSync(join(dir, "cfg", "Engwire", "store"), p.dataDir);

        const { code, said } = await run(true);

        expect(code).toBe(1);
        expect(said).toContain("would swallow");
        expect(removed).toBe(0);
        expect(existsSync(join(dir, "cfg", "Engwire", "store", "a-clone"))).toBe(true);
        expect(existsSync(p.configFile)).toBe(true);
      } finally {
        for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        Object.assign(process.env, before);
      }
    },
  );

  test.skipIf(!ALIASES_CASE)(
    "a config root under a differently cased data root is refused as well",
    async () => {
      // The mirror of the case above, and the reason entry identity is asked
      // both ways round: here it is the *data* root whose casing differs, with
      // config nested below it. Nothing is stranded — the data pass swallows
      // config — but a removal that reports two separate trees when there was
      // one is the thing this refusal exists to stop saying.
      const before = { ...process.env };
      delete process.env.ENGWIRE_HOME;
      process.env.XDG_DATA_HOME = join(dir, "x");
      process.env.XDG_CONFIG_HOME = join(dir, "x", "Engwire", "cfg");
      try {
        const p = paths();
        mkdirSync(join(dir, "x", "Engwire"), { recursive: true });
        mkdirSync(dirname(p.configFile), { recursive: true });
        writeFileSync(p.configFile, "");
        writeFileSync(join(p.dataDir, "a-clone"), "private source");

        const { code, said } = await run(true);

        expect(code).toBe(1);
        expect(said).toContain("would swallow");
        expect(removed).toBe(0);
        expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
        expect(existsSync(p.configFile)).toBe(true);
      } finally {
        for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        Object.assign(process.env, before);
      }
    },
  );

  test.skipIf(!ALIASES_CASE)(
    "a config root the data root reaches through under another casing is refused",
    async () => {
      // String comparisons miss this alias. The ancestor walk must recognise
      // the same entry by device and inode before config deletion takes data too.
      const before = { ...process.env };
      delete process.env.ENGWIRE_HOME;
      process.env.XDG_CONFIG_HOME = join(dir, "cfg");
      process.env.XDG_DATA_HOME = join(dir, "cfg", "Engwire", "store");
      try {
        const p = paths();
        // On disk as `Engwire`; `paths()` always spells it `engwire`.
        mkdirSync(join(dir, "cfg", "Engwire"), { recursive: true });
        mkdirSync(p.dataDir, { recursive: true });
        writeFileSync(join(p.dataDir, "a-clone"), "private source");
        writeFileSync(p.configFile, "");

        const plain = await run(false);
        expect(plain.code).toBe(0);
        expect(plain.said).toContain("inside the other");

        const { code, said } = await run(true);

        expect(code).toBe(1);
        expect(said).toContain("would swallow");
        expect(removed).toBe(0);
        expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
        expect(existsSync(p.configFile)).toBe(true);
      } finally {
        for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        Object.assign(process.env, before);
      }
    },
  );

  test("a data root linked into the config tree is refused", async () => {
    // `overlaps` leaves a root symlink unresolved, which is right for removal —
    // the link is unlinked, not followed. The lock is the other question:
    // `acquireLock` follows it, so the real `runner.lock` lives inside the
    // config tree, and the config removal that goes first precisely to keep a
    // runner out would delete the pathname this command is holding. A runner
    // starting a moment later locks the same path independently.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    process.env.XDG_DATA_HOME = join(dir, "data");
    try {
      const p = paths();
      const configDir = dirname(p.configFile);
      mkdirSync(join(configDir, "data"), { recursive: true });
      writeFileSync(join(configDir, "data", "a-clone"), "private source");
      mkdirSync(dirname(p.dataDir), { recursive: true });
      symlinkSync(join(configDir, "data"), p.dataDir);

      // Neither spelling contains the other, so the overlap rule alone says
      // these are two separate trees.
      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain("through a link");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      expect(removed).toBe(0);
      expect(existsSync(join(configDir, "data", "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("one directory serving as both roots is refused too", async () => {
    // A single recursive delete cannot guarantee that configuration disappears
    // before the lock pathname.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "both");
    process.env.XDG_DATA_HOME = join(dir, "both");
    try {
      const p = paths();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, "a-clone"), "private source");

      // The plain invocation describes the same shape it will refuse. "One is
      // inside the other" on its own says nothing about a single directory
      // serving as both, which is the layout in front of the reader here.
      const plain = await run(false);
      expect(plain.code).toBe(0);
      expect(plain.said).toContain("one tree");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("one tree");
      expect(removed).toBe(0);
      expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("nesting reached through an aliased ancestor is nesting", async () => {
    // Neither spelling starts with the other, so comparing the strings says
    // these are disjoint. Follow the link above them — which `removeTree`
    // does, deliberately, on its way to deleting the config tree — and the
    // data directory is inside it.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    const real = join(dir, "real");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(dir, "alias"));
    process.env.XDG_CONFIG_HOME = join(dir, "alias");
    process.env.XDG_DATA_HOME = join(real, "engwire", "data");
    try {
      const p = paths();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, "a-clone"), "private source");

      const { code, said } = await run(true);

      expect(code).toBe(1);
      expect(said).toContain("would swallow");
      expect(removed).toBe(0);
      expect(existsSync(join(p.dataDir, "a-clone"))).toBe(true);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("a config root blocked by a regular file does not strand the data", async () => {
    // The listing already calls this absent — `present` reads `ENOTDIR` as
    // "nothing is at this path" — and deletion has to agree. `lstatSync` and
    // `rmSync` both raise `ENOTDIR` beneath a regular file, so disagreeing here
    // meant throwing on the config root with the data directory already gone:
    // a half-finished uninstall delivered as a stack trace.
    //
    // The XDG variables rather than `ENGWIRE_HOME`, because that is what puts
    // the two roots under separate parents. Sharing one, a blocked parent stops
    // the lock before anything is deleted, which is a different story with a
    // better ending.
    const before = { ...process.env };
    delete process.env.ENGWIRE_HOME;
    process.env.XDG_DATA_HOME = join(dir, "xdg-data");
    process.env.XDG_CONFIG_HOME = join(dir, "xdg-config");
    try {
      const p = paths();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, "a-clone"), "private source");
      writeFileSync(join(dir, "xdg-config"), "a regular file where a directory belongs");

      const { code, said } = await run(true);

      expect(code).toBe(0);
      expect(said).toContain("Removed.");
      expect(existsSync(p.dataDir)).toBe(false);
    } finally {
      for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  test("a root pointing at its own ancestor takes nothing above it", async () => {
    // The case that decided the contract: resolving this one would have turned
    // `uninstall` into `rm -rf` on the directory the installation lives in.
    const p = paths();
    const ancestor = dirname(dirname(p.dataDir));
    writeFileSync(join(ancestor, "unrelated.txt"), "somebody else's file");
    mkdirSync(dirname(p.dataDir), { recursive: true });
    symlinkSync(ancestor, p.dataDir);

    const { code, said } = await run(true);

    expect(code).toBe(0);
    // The link goes; what it pointed at does not.
    expect(existsSync(p.dataDir)).toBe(false);
    expect(existsSync(join(ancestor, "unrelated.txt"))).toBe(true);
    expect(said).toContain("nothing was removed through it");
  });

  test("a verdict with no inventory above it does not open with a blank line", async () => {
    // The mock refuses revalidation with no inventory printed. The error must
    // stand alone, without a separator intended for preceding inventory rows.
    changedHands = true;

    const { code, said } = await run(true);

    expect(code).toBe(1);
    expect(said.startsWith("The launchd job could no longer be claimed")).toBe(true);
  });

  test("--yes still reports a removal when a service was claimed", async () => {
    // The mock reports successful removal despite an empty inventory. Count
    // that result; real remove() revalidates the plist before it can succeed.
    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(removed).toBe(1);
    expect(said).toContain("Removed.");
  });

  test("a service that cannot be identified is left alone, and named", async () => {
    // A plist this cannot parse — hand-edited, or written by something else
    // under Engwire's label — says nothing about whose job it is. Unknown is
    // not ours: the thing on the other end may be another installation's
    // runner, and may be in the middle of a review. Removing the user's
    // launchd job without asking whose it is remains available as
    // `engwire service uninstall`.
    install();
    service = {
      whose: "theirs",
      plistPath: plistFile,
      supervises: null,
    };

    const { code, said } = await run(true);

    expect(code).toBe(0);
    expect(removed).toBe(0);
    expect(said).toContain("cannot say which installation");
    expect(said).toContain("engwire service uninstall");
    // A plist that cannot name its installation may well be naming this one —
    // hand-editing a plist past recognition is how that happens.
    expect(said).toContain("start a runner here again");
  });
});
