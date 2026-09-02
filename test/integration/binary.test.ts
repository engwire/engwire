/**
 * @file Properties of the compiled artifact, not of the source.
 *
 * A standalone Bun executable is not the source tree with a wrapper: it carries
 * its own runtime, and that runtime reads things from the directory it is
 * launched in. Those behaviours cannot be observed by running `src/main.ts`, so
 * these tests only mean anything against a built binary and skip otherwise —
 * CI's build job points `ENGWIRE_TEST_BIN` at `dist/` and runs them there.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Resolved once, here: each test runs the binary from a directory of its own,
// so a relative `dist/…` would be looked for underneath that instead.
const binary = process.env.ENGWIRE_TEST_BIN
  ? resolve(process.env.ENGWIRE_TEST_BIN)
  : undefined;

describe.skipIf(binary === undefined)("the compiled binary", () => {
  /** A directory carrying both autoloads, as a checkout could. */
  async function hostileCwd(): Promise<{ dir: string; marker: string }> {
    const dir = mkdtempSync(join(tmpdir(), "engwire-cwd-"));
    const marker = join(dir, "preloaded");
    await Bun.write(
      join(dir, "preload.ts"),
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    await Bun.write(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await Bun.write(join(dir, ".env"), `ENGWIRE_HOME=${join(dir, "hijacked")}\n`);
    return { dir, marker };
  }

  async function run(args: string[], dir: string): Promise<{ said: string; code: number }> {
    const proc = Bun.spawn({
      cmd: [binary as string, ...args],
      cwd: dir,
      // A home of its own, and no `ENGWIRE_HOME` — an autoloaded `.env` cannot
      // be observed overriding a variable that is already set.
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { said: out + err, code };
  }

  test("does not load bunfig.toml from the directory it is run in", async () => {
    // `bunfig.toml` carries a `preload` list, and a standalone executable
    // autoloads it from the working directory unless compiled not to. Engwire's
    // working directory is wherever the reviewer typed the command, which this
    // codebase already assumes can be a checkout of the branch under review —
    // so this would execute a contributor's code before `main` ever ran, ahead
    // of every boundary Engwire puts up afterwards.
    const { dir, marker } = await hostileCwd();
    try {
      const { said, code } = await run(["--version"], dir);

      expect(code).toBe(0);
      expect(said.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not load .env from the directory it is run in", async () => {
    // The other half, and it needs a command that shows where it is looking:
    // `--version` reads nothing from the environment, so it would pass with
    // dotenv autoload left on. Asking a runner to start without a config names
    // the file it went looking for, and that path comes from `ENGWIRE_HOME`.
    const { dir } = await hostileCwd();
    try {
      const { said, code } = await run(["run", "--once"], dir);

      // The refusal, not a crash that happened to mention the path.
      expect(code).toBe(1);
      expect(said).toContain(join(dir, ".config", "engwire", "config.toml"));
      expect(said).not.toContain("hijacked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
