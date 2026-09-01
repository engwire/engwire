import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.ts";
import { Store } from "../store/store.ts";
import { diagnose } from "./doctor.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-doctor-"));
});

afterEach(async () => {
  chmodSync(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe("diagnose", () => {
  test("a data directory the runner could not work in is not a green check", async () => {
    // `service install` installs what this report approves, so a green tick has
    // to mean the runner could run. A data root it cannot write is the failure
    // every other check misses: config, gh, claude and git can all be perfect
    // while the runner dies making its database, once a second, forever.
    //
    // An empty `PATH` keeps this to the question being asked: `gh` and `claude`
    // are simply not found, and nothing is spawned.
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);

    const checks = await diagnose({ ENGWIRE_HOME: join(locked, "home"), PATH: "" });

    expect(checks.find((check) => check.label === "data")).toMatchObject({ ok: false });
  });

  test("a writable data directory is created and reported", async () => {
    const checks = await diagnose({ ENGWIRE_HOME: join(dir, "home"), PATH: "" });

    expect(checks.find((check) => check.label === "data")).toMatchObject({
      ok: true,
      note: join(dir, "home", "data"),
    });
  });

  test("the account is not reported when gh could not say who it is", async () => {
    // A ✓ here means the accounts match. With an empty PATH there is no `gh` to
    // ask, so there is nothing to match against — and a green tick beside the
    // red `gh` row would contradict it. The row is withheld rather than turned
    // red, because the `gh` row already says why.
    const env = { ENGWIRE_HOME: join(dir, "home"), PATH: "" };
    mkdirSync(paths(env).dataDir, { recursive: true });
    const store = new Store(paths(env).dbFile);
    store.bindReviewer("alice");
    store.close();

    const checks = await diagnose(env);

    expect(checks.find((check) => check.label === "account")).toBeUndefined();
    expect(checks.find((check) => check.label === "gh")).toMatchObject({ ok: false });
  });

  test("git is judged on the runner's path, not the agent's", async () => {
    // The agent's path carries an absolute `gh_bin`'s directory, because the
    // skill posts by running `gh` by name. `git` is never found that way — the
    // runner spawns it through `absolutePath` — so a `git` living beside the
    // configured `gh` but off PATH exists for the agent and not for the
    // checkout. Judged by the agent's path it is green, and `service install`
    // then approves a setup whose every review dies at `git clone`.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    for (const name of ["gh", "git"]) {
      const bin = join(tools, name);
      writeFileSync(bin, "#!/bin/sh\necho alice\n");
      chmodSync(bin, 0o755);
    }
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(join(tools, "gh"))}\n` +
        `claude_bin = ${JSON.stringify(join(tools, "claude"))}\n`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "" });

    expect(checks.find((check) => check.label === "git")).toMatchObject({ ok: false });
  });

  test("probing a setup is not a way to execute the checkout it runs in", async () => {
    // Resolving the binary safely is only half of it. An absolute `claude` can
    // be a script, and `#!/usr/bin/env node` hands the interpreter straight
    // back to PATH — so a probe spawned with the caller's own `.` on it runs a
    // file from the working directory, which for a command someone types can be
    // the checkout under review. `doctor` would then be the thing that executes
    // it, having been written to detect exactly this.
    const tools = join(dir, "tools");
    const here = join(dir, "checkout");
    mkdirSync(tools, { recursive: true });
    mkdirSync(here, { recursive: true });
    const gh = join(tools, "gh");
    writeFileSync(gh, "#!/bin/sh\necho alice\n");
    chmodSync(gh, 0o755);
    // The interpreter exists only in the working directory.
    const marker = join(dir, "executed");
    const interpreter = join(here, "engwire-probe");
    // Redirection, not `touch`: the probe inherits the poisoned PATH, on
    // which no external command resolves.
    writeFileSync(interpreter, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    chmodSync(interpreter, 0o755);
    const claude = join(tools, "claude");
    writeFileSync(claude, "#!/usr/bin/env engwire-probe\n");
    chmodSync(claude, 0o755);

    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(gh)}\nclaude_bin = ${JSON.stringify(claude)}\n`,
    );

    const cwd = process.cwd();
    process.chdir(here);
    let checks;
    try {
      checks = await diagnose({ ENGWIRE_HOME: home, PATH: "." });
    } finally {
      process.chdir(cwd);
    }

    // Both halves, because an absent marker alone would also describe a
    // `doctor` that stopped probing Claude altogether: the configured binary
    // was tried, its interpreter was not reachable on a filtered path, and the
    // one in this directory was not run instead.
    expect(checks.find((check) => check.label === "claude")).toMatchObject({ ok: false });
    expect(existsSync(marker)).toBe(false);
  });
});
