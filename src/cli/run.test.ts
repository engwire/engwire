/**
 * @file The one thing about `engwire run` that is a contract rather than copy:
 * when it says it is watching.
 *
 * In process, because the ordering this pins is only a fact at the instant the
 * line is emitted. Observed from outside — after the process has moved on — a
 * watermark is on disk whichever side of the announcement it was written on, so
 * the reversal that costs somebody their first review still passes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "../config/paths.ts";
import { Store } from "../store/store.ts";
import { run, WATCHING } from "./run.ts";

const FIXTURES = resolve(import.meta.dir, "../../test/fixtures");

let dir: string;
let restore: Record<string, string | undefined>;

/** A configured installation with nothing outstanding on GitHub. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-run-"));
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "config.toml"),
    `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
      `[advanced]\ngh_bin = "${join(FIXTURES, "gh")}"\nclaude_bin = "${join(FIXTURES, "claude")}"\n`,
  );
  mkdirSync(join(dir, "claude", "skills", "review-pr"), { recursive: true });
  writeFileSync(join(dir, "claude", "skills", "review-pr", "SKILL.md"), "---\nname: review-pr\n---\n");
  mkdirSync(join(dir, "gh"), { recursive: true });
  writeFileSync(join(dir, "gh", "search.json"), "[]");

  restore = {
    ENGWIRE_HOME: process.env.ENGWIRE_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    FAKE_GH_DIR: process.env.FAKE_GH_DIR,
    FAKE_GH_LOGIN: process.env.FAKE_GH_LOGIN,
  };
  process.env.ENGWIRE_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  process.env.FAKE_GH_DIR = join(dir, "gh");
  process.env.FAKE_GH_LOGIN = "me";
});

afterEach(async () => {
  for (const [name, value] of Object.entries(restore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("engwire run", () => {
  test("the cutoff is on disk before the line that tells a reader to go ahead", async () => {
    // `setup` and the README tell the reader to wait for this line and then ask
    // for their review, which makes it a barrier: a boundary written after it
    // would be later than the request it is supposed to admit, and that request
    // would never be reviewed — the exact silence this sequence removes.
    //
    // `established` is the store's own answer to "did I just create this", so
    // the observation needs no second copy of what the watermark looks like.
    // False means the runner had already written it when it spoke.
    const log = console.log;
    // A property rather than a variable: assignment inside the interceptor is
    // invisible to the compiler's narrowing, which would then read the
    // assertions below as comparisons against `null`.
    const atReadiness: { established?: boolean } = {};
    console.log = (message: unknown) => {
      if (atReadiness.established !== undefined) return;
      if (!String(message).includes(WATCHING)) return;
      const store = new Store(paths().dbFile);
      try {
        atReadiness.established = store.watchingSince().established;
      } finally {
        store.close();
      }
    };
    let code: number;
    try {
      code = await run({ once: true });
    } finally {
      console.log = log;
    }

    expect(code).toBe(0);
    // Printed at all — otherwise the assertion below it is vacuous.
    expect(atReadiness.established).toBeDefined();
    expect(atReadiness.established).toBe(false);
  });

  test("First review quotes the phrase this prints, character for character", async () => {
    // The constant keeps `run`, `setup` and the tests spelling the barrier one
    // way; the README spells it out in prose, where First review tells somebody
    // to wait for it. Reword the constant without this and every check stays
    // green while the instruction names a line that never arrives.
    //
    // First review's own command block, not the whole file and not the whole
    // section: the phrase appears under Use as well, and again in the prose
    // under the block, so anything wider goes on passing after the one line the
    // reader actually follows stops naming the barrier. Both ends of the slice
    // are checked, since a renamed heading would otherwise quietly widen it to
    // the rest of the README.
    const readme = await Bun.file(resolve(import.meta.dir, "../../README.md")).text();
    const start = readme.indexOf("## First review");
    const end = readme.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const commands = readme.slice(start, end).match(/```sh\n([\s\S]*?)```/)?.[1];

    expect(commands).toContain(`\`${WATCHING}\``);
  });
});
