import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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
});
