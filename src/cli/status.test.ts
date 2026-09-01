import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.ts";
import { Store } from "../store/store.ts";
import { status } from "./status.ts";

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-status-"));
  home = join(dir, "home");
  process.env.ENGWIRE_HOME = home;
  mkdirSync(paths().dataDir, { recursive: true });
});

afterEach(async () => {
  delete process.env.ENGWIRE_HOME;
  await rm(dir, { recursive: true, force: true });
});

/** Run `status` and return everything it printed, joined. */
async function report(): Promise<string> {
  const log = console.log;
  let said = "";
  console.log = (message: unknown) => {
    said += `${message}\n`;
  };
  try {
    expect(await status()).toBe(0);
    return said;
  } finally {
    console.log = log;
  }
}

describe("status", () => {
  test("a pull request title cannot rewrite the report around it", async () => {
    // Titles are written by whoever opened the pull request, and `status`
    // prints them to a terminal. A title that clears the screen, returns the
    // cursor to the start of the line, or breaks it with a C1 NEL would let a
    // contributor forge the rows above their own. `stripANSI` handles the first
    // and leaves the other two — U+0085 among the 26 C1 characters it passes
    // through — which is what the second pass is for.
    const store = new Store(paths().dbFile);
    store.insert({
      id: "run-1",
      eventId: "evt-1",
      repo: "acme/api",
      pullNumber: 42,
      headSha: "a".repeat(40),
      title: "\u001b[2Jwiped\rforged\u0085next\u009b[31mred",
      skill: "review-pr",
      status: "queued",
      detail: null,
      requestedAt: "2026-08-01T10:00:00Z",
      createdAt: "2026-08-01T10:00:00Z",
    });
    store.close();

    const said = await report();

    // The words survive — this sanitises the output, it does not censor it.
    expect(said).toContain("wiped");
    expect(said).toContain("forged");
    // Only the newlines this capture added: nothing a terminal would act on.
    expect(said.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
