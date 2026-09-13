import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../config/paths.ts";
import { Store } from "../store/store.ts";
import { main } from "./index.ts";

/**
 * Everything in this file that reaches outside a test, restored after each one.
 *
 * The helpers below restore their own in a `finally`, and that is still the
 * useful immediate cleanup — but a helper that *times out* never reaches it,
 * which is how a leaked `GH_CONFIG_DIR` once turned an unrelated `run --once`
 * assertion into a refusal two tests later. This is the net under that, so it
 * has to name every global the file touches rather than the two that bit first:
 * a leftover empty `PATH` or a replaced `console.error` poisons the next test
 * just as thoroughly, only less legibly.
 *
 * `delete` for what was unset, not an empty string: `PATH=""` is a different
 * environment from no `PATH` at all, and this file is about environments.
 */
const AMBIENT = ["PATH", "ENGWIRE_HOME", "GH_CONFIG_DIR", "ZDOTDIR"] as const;
const ambient = Object.fromEntries(AMBIENT.map((name) => [name, process.env[name]]));
const consoles = { log: console.log, error: console.error };
afterEach(() => {
  for (const name of AMBIENT) {
    const value = ambient[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  console.log = consoles.log;
  console.error = consoles.error;
});

/**
 * The dispatcher's whole job is the grammar, so what is asserted is the
 * refusal, not just the exit code: a command that ran and failed also returns
 * 1, and letting that count would pass a dispatcher that no longer refuses
 * anything. `ENGWIRE_HOME` points nowhere for the same reason — a regression
 * here must not reach a real config, or the runner it starts.
 */
async function dispatch(argv: string[]): Promise<{ code: number; said: string }> {
  const log = console.log;
  const error = console.error;
  const home = process.env.ENGWIRE_HOME;
  let said = "";
  console.log = () => {};
  console.error = (message: unknown) => {
    said += `${message}\n`;
  };
  process.env.ENGWIRE_HOME = join(tmpdir(), "engwire-dispatch-nowhere");
  try {
    return { code: await main(argv), said };
  } finally {
    console.log = log;
    console.error = error;
    if (home === undefined) delete process.env.ENGWIRE_HOME;
    else process.env.ENGWIRE_HOME = home;
  }
}

/** The same capture, pointed somewhere relative. */
async function dispatchFromRelative(argv: string[]): Promise<{ code: number; said: string }> {
  const error = console.error;
  const log = console.log;
  const home = process.env.ENGWIRE_HOME;
  let said = "";
  console.error = (message: unknown) => {
    said += `${message}\n`;
  };
  console.log = (message: unknown) => {
    said += `${message}\n`;
  };
  process.env.ENGWIRE_HOME = "engwire-relative";
  try {
    return { code: await main(argv), said };
  } finally {
    console.error = error;
    console.log = log;
    if (home === undefined) delete process.env.ENGWIRE_HOME;
    else process.env.ENGWIRE_HOME = home;
  }
}

/** The same capture again, this time with gh's configuration root pointed somewhere relative. */
async function dispatchFromRelativeGhRoot(argv: string[]): Promise<{ code: number; said: string }> {
  const error = console.error;
  const log = console.log;
  const configDir = process.env.GH_CONFIG_DIR;
  let said = "";
  console.error = (message: unknown) => {
    said += `${message}\n`;
  };
  console.log = (message: unknown) => {
    said += `${message}\n`;
  };
  // Engwire's own location stays absolute, so a refusal here is the gh root
  // failing on its own terms rather than `locationProblem` answering again.
  const path = process.env.PATH;
  const home = process.env.ENGWIRE_HOME;
  process.env.GH_CONFIG_DIR = "gh-relative";
  // Nowhere to look and nothing to find. `doctor` is one of the commands under
  // test and it starts programs — with the machine's real PATH it probes the
  // developer's own `claude` and `git` under the production deadline, which is
  // slow, machine-dependent, and once timed the test out *before its `finally`
  // ran*, leaving GH_CONFIG_DIR set for everything after it.
  process.env.PATH = "";
  process.env.ENGWIRE_HOME = join(tmpdir(), "engwire-dispatch-nowhere");
  try {
    return { code: await main(argv), said };
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (home === undefined) delete process.env.ENGWIRE_HOME;
    else process.env.ENGWIRE_HOME = home;
    console.error = error;
    console.log = log;
    if (configDir === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = configDir;
  }
}

/** The same capture again, with zsh's startup directory pointed somewhere relative. */
async function dispatchFromRelativeZdotdir(argv: string[]): Promise<{ code: number; said: string }> {
  const error = console.error;
  const log = console.log;
  const zdotdir = process.env.ZDOTDIR;
  let said = "";
  console.error = (message: unknown) => {
    said += `${message}\n`;
  };
  console.log = (message: unknown) => {
    said += `${message}\n`;
  };
  const path = process.env.PATH;
  const home = process.env.ENGWIRE_HOME;
  process.env.ZDOTDIR = "zdot-relative";
  // Nowhere to look and nothing to find. `doctor` is one of the commands under
  // test and it starts programs — with the machine's real PATH it probes the
  // developer's own `claude` and `git` under the production deadline, which is
  // slow, machine-dependent, and once timed the test out *before its `finally`
  // ran*, leaving ZDOTDIR set for everything after it.
  process.env.PATH = "";
  process.env.ENGWIRE_HOME = join(tmpdir(), "engwire-dispatch-nowhere");
  try {
    return { code: await main(argv), said };
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (home === undefined) delete process.env.ENGWIRE_HOME;
    else process.env.ENGWIRE_HOME = home;
    console.error = error;
    console.log = log;
    if (zdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = zdotdir;
  }
}

describe("which guard each command actually needs", () => {
  // Both roots, and both through a *valid* invocation. Only the gh half was
  // pinned before, so putting `zshStartupProblem` back on `status` was a
  // mutation no test could see: the other zsh case here is `status nonsense`,
  // which returns at grammar validation before any guard runs.
  test.each([
    ["a relative gh configuration root", dispatchFromRelativeGhRoot, "GH_CONFIG_DIR"],
    ["a relative zsh startup directory", dispatchFromRelativeZdotdir, "ZDOTDIR"],
  ])("status is not stopped by %s, which it never uses", async (_case, dispatch, named) => {
    // `status` reads a database and a lock and starts nothing, so neither root
    // is its business. One gate asking all three questions refused it for both.
    const { said } = await dispatch(["status"]);

    // The refusal sentence, not the variable name: what matters is that it
    // answered as `status`, and a future `status` that legitimately mentions an
    // environment variable should not fail an environment-policy test.
    expect(said).not.toContain("Set " + named + " to an absolute path");
  });

  test("an argument error is reported as one, not as an environment problem", async () => {
    // The gate used to sit in front of the whole switch, so a typo in a shell
    // with a relative root was answered with a lecture about `ZDOTDIR`.
    const { code, said } = await dispatchFromRelativeZdotdir(["status", "nonsense"]);

    expect(code).toBe(1);
    expect(said).toContain("Usage: engwire status");
    expect(said).not.toContain("ZDOTDIR");
  });
});

describe("a zsh startup directory the working directory decides", () => {
  test("run refuses rather than resolving it to an absolute path", async () => {
    // The correction that replaced a pin. Resolving it would have stopped the
    // directory moving and kept whatever it already pointed at — measured, a
    // `.zshenv` a branch shipped ran in a zsh started from somewhere else once
    // the path was pinned. zsh reads that file on every invocation, so the
    // review's first tool call is enough.
    const { code, said } = await dispatchFromRelativeZdotdir(["run"]);

    expect(code).toBe(1);
    expect(said).toContain("ZDOTDIR");
    expect(said).toContain("absolute path");
  });
});

describe("a gh configuration root the working directory decides", () => {
  test("run refuses before anything reaches gh", async () => {
    // The runner borrows the reviewer's authenticated CLI, and that directory
    // holds both the credentials a review posts with and aliases that can be
    // shell commands. Resolved from the working directory it is contributor
    // content the moment Engwire is started from a checkout — so this is
    // refused rather than pinned absolutely, which would name the branch's own
    // copy just as faithfully.
    const { code, said } = await dispatchFromRelativeGhRoot(["run"]);

    expect(code).toBe(1);
    expect(said).toContain("GH_CONFIG_DIR");
    expect(said).toContain("absolute path");
  });

  test("doctor is not refused at the door", async () => {
    // Same division as a relative installation location, for the same reason:
    // the command that exists to say what is wrong has to be able to run. What
    // it then *says* about the root is `doctor`'s business and is asserted in
    // `doctor.test.ts`, which has stand-in binaries to say it about; here the
    // question is only whether the dispatcher let it start.
    const { said } = await dispatchFromRelativeGhRoot(["doctor"]);

    expect(said).not.toContain("Set GH_CONFIG_DIR to an absolute path");
    expect(said.trim().split("\n").length).toBeGreaterThan(1);
  });
});

describe("a relative installation location", () => {
  /**
   * The commands that answer without an installation to answer for.
   *
   * `doctor` reports the problem, `uninstall` inventories before refusing to
   * delete at an address that moves, and `service uninstall` stops a job whose
   * label and plist are one per user rather than one per installation — the one
   * command somebody with a relative location may most need. Everything else
   * must refuse, and this list is spelled here rather than imported so that a
   * command quietly added to the dispatcher's allowlist has to be argued for
   * twice.
   */
  const WITHOUT_INSTALLATION = new Set([
    "doctor",
    "uninstall",
    "service uninstall",
    // `service install` refuses this too, one layer in and against a better
    // environment: the plist's, built by `serviceEnvironment()`, which is what
    // decides which installation the job supervises rather than which one this
    // shell would reach. Guarding it out here as well put an environment
    // complaint in front of the macOS-only answer on Linux. `service.test.ts`
    // holds `servicePathProblems` to refusing a relative `ENGWIRE_HOME`.
    "service install",
  ]);

  test("every command the usage text promises either refuses or is exempt", async () => {
    // Derived from the help rather than hardcoded, because the guard in
    // `dispatch` is an allowlist and an allowlist fails open: a command added
    // to the switch and forgotten there gets a per-cwd installation with no
    // test failing and no output changing — which is the original bug, one
    // level up. Both `service` actions had no coverage at all until this, and
    // they are read whole: the two want opposite answers.
    const { said: help } = await invoke(["help"]);
    const promised = new Set(
      [...help.matchAll(/^ {2}engwire ([a-z]+(?: [a-z]+)?)/gm)].map((match) => match[1]!),
    );

    expect(promised.size).toBeGreaterThan(4);
    // Every exemption has to name a command the help actually promises, and
    // something has to be left over to assert on: an exemption that matches
    // nothing is a claim no test checks, and exempting the lot would otherwise
    // leave the loop below asserting nothing at all.
    for (const exempt of WITHOUT_INSTALLATION) expect([...promised]).toContain(exempt);
    expect(promised.size).toBeGreaterThan(WITHOUT_INSTALLATION.size);

    for (const command of promised) {
      // Before dispatching, not after: `uninstall` reaches for the machine's
      // real launchd job, and `service uninstall` would remove it.
      if (WITHOUT_INSTALLATION.has(command)) continue;
      const { code, said } = await dispatchFromRelative(command.split(" "));

      expect(code, `${command} should refuse a relative location`).toBe(1);
      expect(said, `${command} should name the variable`).toContain("ENGWIRE_HOME");
      expect(said).toContain("absolute path");
    }
  });

  test("doctor reports it instead of refusing to look", async () => {
    // The command whose job is to say what is wrong must not be the one that
    // cannot start. It is the whole diagnosis, though: every other check is
    // about a path this could not work out, beginning with which config file.
    const { code, said } = await dispatchFromRelative(["doctor"]);

    expect(code).toBe(1);
    expect(said).toContain("ENGWIRE_HOME");
    // Exactly one line: not the first of a list whose every other entry is
    // about a path that could not be worked out. The service row is the one
    // that would otherwise still go looking, beside a data directory that is a
    // different directory in every shell.
    expect(said.trim().split("\n")).toHaveLength(1);
    expect(said).not.toContain("gh");
  });

  test("help still answers, because it describes the program not the install", async () => {
    const { code, said } = await dispatchFromRelative(["--help"]);

    expect(code).toBe(0);
    expect(said).toContain("engwire setup");
  });
});

/** A temporary installation for tests that must reach persisted state. */
let installed: string | undefined;
let home: string | undefined;

afterEach(async () => {
  // Restore the caller's environment; other tests share this process.
  if (installed === undefined) return;
  await rm(installed, { recursive: true, force: true });
  installed = undefined;
  if (home === undefined) delete process.env.ENGWIRE_HOME;
  else process.env.ENGWIRE_HOME = home;
});

function install(): void {
  home = process.env.ENGWIRE_HOME;
  installed = mkdtempSync(join(tmpdir(), "engwire-main-"));
  process.env.ENGWIRE_HOME = installed;
}

/** Capture a command without replacing its installation. */
async function invoke(argv: string[]): Promise<{ code: number; said: string }> {
  const log = console.log;
  const error = console.error;
  let said = "";
  console.log = (message: unknown) => {
    said += `${message}\n`;
  };
  console.error = console.log;
  try {
    return { code: await main(argv), said };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("main", () => {
  test("every command and flag the usage text promises is one the dispatcher accepts", async () => {
    // The two drift apart in the direction that matters: a command removed
    // from dispatch but left in the help is one a reader will type and be told
    // does not exist, and a flag the dispatcher takes but the help omits is one
    // nobody finds. Each is given an argument it cannot take, so the grammar
    // answers without the command running — and that refusal names the flags
    // the command accepts, which is the second statement to compare the help
    // against.
    // `invoke` rather than `dispatch`: the help text goes to stdout, which the
    // dispatcher harness deliberately swallows.
    const { said: help } = await invoke(["help"]);
    const promised = [
      ...help.matchAll(/^ {2}engwire ([a-z]+(?: [a-z]+)?)((?: \[--[a-z-]+\])*)/gm),
    ].map((match) => ({ command: match[1]!, flags: match[2]!.trim() }));

    expect(promised.length).toBeGreaterThan(4);
    for (const { command, flags } of promised) {
      const { code, said } = await dispatch([...command.split(" "), "--not-a-flag"]);

      expect(code).toBe(1);
      expect(said).toContain("Usage:");
      expect(said).not.toContain("Unknown command");
      expect(said.match(/\[--[a-z-]+\]/g)?.join(" ") ?? "").toBe(flags);
    }
  });

  test("a runner with no rules refuses, rather than dismissing the whole queue", async () => {
    // The refusal is a data-loss guard, not tidiness. A dismissal is permanent,
    // so a first poll with nothing configured would record every outstanding
    // request as `no_automation` and never reconsider one of them.
    install();
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(paths().configFile, "# nothing configured yet\n");

    const { code, said } = await invoke(["run", "--once"]);

    expect(code).toBe(1);
    expect(said).toContain("No [[review]] rules");
    expect(said).toContain(paths().configFile);
    // Nothing was even opened, let alone written: the check precedes the store.
    expect(existsSync(paths().dbFile)).toBe(false);
  });

  test("a runner refuses to start under an account that does not own the queue", async () => {
    // Otherwise `gh auth switch` plus a restart would execute work accepted as
    // one person and post it as another. The message has to name the account
    // this installation belongs to, because that is the way back.
    install();
    const gh = join(installed!, "gh");
    writeFileSync(gh, "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n");
    chmodSync(gh, 0o755);
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(
      paths().configFile,
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(gh)}\n`,
    );
    const store = new Store(paths().dbFile);
    store.bindReviewer("bob");
    store.close();

    const { code, said } = await invoke(["run", "--once"]);

    expect(code).toBe(1);
    expect(said).toContain("watches review requests for bob");
    expect(said).toContain("authenticated as alice");
    expect(said).toContain("gh auth switch --user bob");
  });

  test("a typo in the config is a sentence, not a stack trace", async () => {
    // The one line saying what is wrong is the whole value of the message, and
    // a stack trace buries it. `run --once` is the command someone types to
    // find out whether their setup works.
    install();
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(paths().configFile, '[[review]]\nrepos = ["acme/*"]\nskil = "review-pr"\n');

    const { code, said } = await invoke(["run", "--once"]);

    expect(code).toBe(1);
    expect(said).toContain("unknown key");
    expect(said).toContain("skil");
    expect(said).not.toMatch(/\n\s+at |ConfigError:/);
  });

  test("a newer database is reported without a stack trace", async () => {
    install();
    new Store(paths().dbFile).close();
    const db = new Database(paths().dbFile);
    db.exec("PRAGMA user_version = 999");
    db.close();

    const { code, said } = await invoke(["status"]);

    expect(code).toBe(1);
    expect(said).toContain("schema 999");
    expect(said).toContain("Upgrade Engwire");
    expect(said).not.toMatch(/\n\s+at |DatabaseTooNewError:/);
  });

  test("help and version are the commands that answer without doing anything", async () => {
    for (const argv of [[], ["help"], ["--help"], ["version"], ["--version"]]) {
      expect(await dispatch(argv)).toMatchObject({ code: 0 });
    }
  });

  test("an argument the command does not define is refused, not ignored", async () => {
    // Both halves matter. A flag nobody defined must not be read as its
    // absence — `engwire run --dry-run` would otherwise start a real runner —
    // and an extra argument must not be silently dropped, which is the same
    // mistake with a quieter ending.
    for (const argv of [
      ["run", "--dry-run"],
      ["run", "--once", "--once"],
      ["run", "--once", "extra"],
      ["setup", "extra"],
      ["status", "extra"],
      ["doctor", "extra"],
      ["service"],
      ["service", "start"],
      ["service", "install", "--now"],
      ["help", "extra"],
      ["--version", "extra"],
      ["bogus"],
    ]) {
      const { code, said } = await dispatch(argv);
      expect(code).toBe(1);
      expect(said).toMatch(/^(Usage: engwire|Unknown command)/);
    }
  });

  test("usage marks the commands that only work on one platform", async () => {
    // The list is the same everywhere on purpose, so the platform has to be on
    // the line. Both `service` commands exit 1 off macOS; unmarked, the only
    // way to find that out is to run one. "(launchd)" was not the mark — it
    // answers "how", and the reader is asking "does this apply to me".
    // `dispatch` above captures only stderr, which is what every other case
    // here asserts on; usage goes to stdout.
    const log = console.log;
    let said = "";
    console.log = (message: unknown) => {
      said += `${message}\n`;
    };
    let code: number;
    try {
      code = await main(["help"]);
    } finally {
      console.log = log;
    }

    expect(code).toBe(0);
    for (const line of said.split("\n")) {
      if (!line.includes("engwire service ")) continue;
      expect(line).toContain("(macOS)");
    }
    // Both of them, so a passing loop cannot mean it matched nothing.
    expect(said).toContain("engwire service install");
    expect(said).toContain("engwire service uninstall");
  });
});
