import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.ts";
import { setup } from "./setup.ts";

let dir: string;
let cwd: string;
let path: string | undefined;

/** A `gh` and a `claude` sitting in the directory the command is typed from. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-setup-"));
  for (const name of ["gh", "claude"]) {
    const bin = join(dir, name);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
  }
  mkdirSync(join(dir, "home"), { recursive: true });
  cwd = process.cwd();
  path = process.env.PATH;
  process.chdir(dir);
  process.env.ENGWIRE_HOME = join(dir, "home");
});

afterEach(async () => {
  process.chdir(cwd);
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  delete process.env.ENGWIRE_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("setup", () => {
  test("a binary beside the caller is never written into the config", async () => {
    // `setup` is where a resolution becomes permanent: the absolute path it
    // records is what every later review runs, and `doctor` would report it as
    // healthy. Run from inside a checkout by someone with `.` on their PATH,
    // resolving `gh` the ambient way would commit that branch's `gh` to the
    // configuration.
    process.env.PATH = ".";
    const error = console.error;
    let said = "";
    console.error = (message: unknown) => {
      said += `${message}\n`;
    };
    try {
      expect(await setup()).toBe(1);
    } finally {
      console.error = error;
    }

    expect(said).toContain("gh is not installed");
    expect(existsSync(paths().configFile)).toBe(false);
  });
});
