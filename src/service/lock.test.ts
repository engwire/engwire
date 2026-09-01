import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, isLocked, LockedError } from "./lock.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-lock-"));
  file = join(dir, "nested", "runner.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("a second holder is refused, and the first can hand it back", () => {
    const release = acquireLock(file);
    expect(isLocked(file)).toBe(true);
    expect(() => acquireLock(file)).toThrow(LockedError);

    release();
    expect(isLocked(file)).toBe(false);
    acquireLock(file)();
  });

  test("nothing holds a lock that was never taken", () => {
    expect(isLocked(file)).toBe(false);
  });

  test("a runner that dies without releasing does not strand the lock", async () => {
    // The whole reason this is a transaction and not a file: there is no stale
    // lock to detect, because the kernel drops it when the process does.
    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../../test/fixtures/hold-lock.ts"),
        file,
      ],
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("held");

    expect(isLocked(file)).toBe(true);
    expect(() => acquireLock(file)).toThrow(LockedError);

    holder.kill("SIGKILL");
    await holder.exited;

    expect(isLocked(file)).toBe(false);
  });
});
