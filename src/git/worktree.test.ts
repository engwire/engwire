import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrigin, type Origin } from "../../test/fixtures/repo.ts";
import { git } from "./repository.ts";
import { prepareRevision, removeWorktree } from "./worktree.ts";

let dir: string;
let origin: Origin;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "engwire-git-"));
  origin = await createOrigin(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function where(name = "run-1") {
  return {
    pullNumber: 42,
    repoDir: join(dir, "repos", "acme", "api.git"),
    worktreeDir: join(dir, "worktrees", name),
    url: origin.url,
    ghBin: "gh",
  };
}

describe("prepareRevision", () => {
  test("checks out the exact claimed revision", async () => {
    const path = await prepareRevision({ ...where(), sha: origin.sha });

    expect(path).toBe(where().worktreeDir);
    expect(await Bun.file(join(path, "README.md")).text()).toBe("# widgets\n");
    expect((await git(["rev-parse", "HEAD"], path)).trim()).toBe(origin.sha);
  });

  test("reuses the clone for a second revision of the same repository", async () => {
    await prepareRevision({ ...where("run-1"), sha: origin.sha });
    const second = await prepareRevision({ ...where("run-2"), sha: origin.secondSha });

    expect(await Bun.file(join(second, "README.md")).text()).toBe("# widgets, revised\n");
    // Both checkouts coexist: superseding one review must not disturb another.
    expect(existsSync(where("run-1").worktreeDir)).toBe(true);
  });

  test("a rerun over an existing checkout replaces it", async () => {
    await prepareRevision({ ...where(), sha: origin.sha });
    await Bun.write(join(where().worktreeDir, "scratch.txt"), "left behind");

    await prepareRevision({ ...where(), sha: origin.sha });
    expect(existsSync(join(where().worktreeDir, "scratch.txt"))).toBe(false);
  });

  test("never touches the origin repository", async () => {
    const before = await git(["rev-parse", "HEAD"], origin.url);
    await prepareRevision({ ...where(), sha: origin.sha });
    expect(await git(["rev-parse", "HEAD"], origin.url)).toBe(before);
  });
});

describe("removeWorktree", () => {
  test("removes the checkout and git's record of it", async () => {
    const { repoDir, worktreeDir } = where();
    await prepareRevision({ ...where(), sha: origin.sha });

    await removeWorktree(repoDir, worktreeDir);

    expect(existsSync(worktreeDir)).toBe(false);
    expect(await git(["worktree", "list", "--porcelain"], repoDir)).not.toContain(worktreeDir);
  });

  test("tolerates a checkout the user already deleted", async () => {
    const { repoDir, worktreeDir } = where();
    await prepareRevision({ ...where(), sha: origin.sha });
    await rm(worktreeDir, { recursive: true, force: true });

    await removeWorktree(repoDir, worktreeDir);
    expect(existsSync(worktreeDir)).toBe(false);
  });
});
