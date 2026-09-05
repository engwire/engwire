import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../config/paths.ts";
import { Store } from "../store/store.ts";
import { main } from "./index.ts";

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
