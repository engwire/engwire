import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
  // Restored, not deleted: a suite run under a deliberate `GIT_CONFIG_GLOBAL`
  // would otherwise lose it after the first test that sets one.
  if (globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = globalConfig;
  delete process.env.GIT_DIR;
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

const globalConfig = process.env.GIT_CONFIG_GLOBAL;

/**
 * A reviewer's own git configuration, without touching theirs.
 *
 * `git()` hands the runner's environment to every subprocess, so this is the
 * same inheritance a real checkout has — which is the whole point: what is
 * under test is that the branch cannot reach it.
 */
function reviewerGlobalConfig(contents: string): void {
  const file = join(dir, "reviewer.gitconfig");
  writeFileSync(file, contents);
  process.env.GIT_CONFIG_GLOBAL = file;
}

/** An origin whose `.gitattributes` points each file at one of the named filters. */
async function originNaming(...filters: string[]): Promise<string> {
  const work = join(dir, "hostile");
  await git(["init", "-b", "main", work], dir);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "T"], work);
  const attributes = filters.map((filter) => `${filter}.txt filter=${filter}\n`);
  await Bun.write(join(work, ".gitattributes"), attributes.join(""));
  for (const filter of filters) {
    await Bun.write(join(work, `${filter}.txt`), "content\n");
  }
  await git(["add", "-A"], work);
  await git(["commit", "-m", "hostile"], work);
  return work;
}

/**
 * Hook events a checkout actually fires, measured rather than assumed.
 *
 * Not `post-checkout`: `worktree add --no-checkout` followed by `reset` never
 * fires it, so a hook on that event would assert nothing.
 */
const FIRING_EVENTS = ["reference-transaction", "post-index-change"];

/** A shell command that leaves `<dir>/<name>` behind and passes content through. */
function marker(name: string): string {
  return `sh -c "echo ran > ${join(dir, name)}; cat"`;
}

describe("prepareRevision", () => {
  test("a branch cannot point the checkout at a filter the reviewer configured", async () => {
    // `.gitattributes` travels with the branch; the filter it names is defined
    // in the reviewer's own config, so a contributor chooses whether it runs
    // and on what content. A user-level `git lfs install` defines one.
    // The branch is authored on the contributor's machine, where the filter
    // does not exist; the reviewer's configuration only enters at checkout.
    //
    // Two filters rather than one: a disabled `process` does not fall back to
    // the `smudge` beside it, so a single driver could only ever prove whichever
    // of the two git reached first. Both names carry an `=`, which a subsection
    // may legally contain and which `-c key=value` would misparse.
    const work = await originNaming("smudge=x", "process=x");
    const sha = (await git(["rev-parse", "HEAD"], work)).trim();
    reviewerGlobalConfig(
      `[filter "smudge=x"]\n\tsmudge = ${marker("smudge-ran")}\n\trequired = true\n` +
        `[filter "process=x"]\n\tprocess = ${marker("process-ran")}\n\trequired = true\n`,
    );

    const path = await prepareRevision({ ...where(), url: work, sha });

    // `required = true` is what `git-lfs` sets, and disabling a required filter
    // without disabling the requirement fails the checkout outright rather than
    // falling back — so the content assertions cover that third override.
    expect(await Bun.file(join(path, "smudge=x.txt")).text()).toBe("content\n");
    expect(await Bun.file(join(path, "process=x.txt")).text()).toBe("content\n");
    expect(existsSync(join(dir, "smudge-ran"))).toBe(false);
    expect(existsSync(join(dir, "process-ran"))).toBe(false);
  });

  test("a checkout does not run the programs the reviewer keeps for their own repositories", async () => {
    // None of these needs anything committed to invoke it. Both halves of the
    // checkout fire hooks — `reference-transaction` when the worktree's HEAD is
    // written, `post-index-change` when the index is — from a script on disk
    // and, since git 2.54, from config as well, which `core.hooksPath` does not
    // reach. `core.fsmonitor` is a third: git documents a non-boolean value as
    // the pathname of a hook. All of them are the reviewer's own scripts, and
    // all would run with somebody else's branch as their working directory.
    const hooks = join(dir, "reviewer-hooks");
    for (const event of FIRING_EVENTS) {
      // `cat` first: git writes the transaction to the hook's stdin, and a hook
      // that never reads it dies of SIGPIPE — which for `reference-transaction`
      // aborts the operation rather than merely failing this assertion.
      await Bun.write(
        join(hooks, event),
        `#!/bin/sh\ncat > /dev/null\necho ran > ${join(dir, "hook-ran")}\n`,
      );
      await Bun.$`chmod +x ${join(hooks, event)}`.quiet();
    }
    const events = FIRING_EVENTS.map((event) => `\tevent = ${event}\n`).join("");

    // Establish the clone before installing the reviewer's executable config,
    // so the assertions isolate the checkout; `reference-transaction` also
    // fires while cloning.
    await prepareRevision({ ...where("run-1"), sha: origin.sha });
    reviewerGlobalConfig(
      `[core]\n\thooksPath = ${hooks}\n\tfsmonitor = ${marker("fsmonitor-ran")}\n` +
        `[hook "tidy=x"]\n${events}\tcommand = ${marker("confighook-ran")}\n`,
    );

    await prepareRevision({ ...where("run-2"), sha: origin.sha });

    expect(existsSync(join(dir, "hook-ran"))).toBe(false);
    expect(existsSync(join(dir, "confighook-ran"))).toBe(false);
    expect(existsSync(join(dir, "fsmonitor-ran"))).toBe(false);
  });

  test("acquiring the repository does not run the reviewer's hooks either", async () => {
    // `reference-transaction` fires on every clone and every fetch, before any
    // tree exists — so a repository Engwire has not seen before would run the
    // reviewer's hooks while it was still being downloaded. Nothing is checked
    // out yet, but the script is one written for repositories its author chose.
    const hooks = join(dir, "reviewer-hooks");
    const hook = join(hooks, "reference-transaction");
    await Bun.write(hook, `#!/bin/sh\ncat > /dev/null\necho ran > ${join(dir, "hook-ran")}\n`);
    await Bun.$`chmod +x ${hook}`.quiet();
    reviewerGlobalConfig(
      `[core]\n\thooksPath = ${hooks}\n` +
        `[hook "audit=x"]\n\tevent = reference-transaction\n\tcommand = ${marker("confighook-ran")}\n`,
    );

    await prepareRevision({ ...where(), sha: origin.sha });

    expect(existsSync(join(dir, "hook-ran"))).toBe(false);
    expect(existsSync(join(dir, "confighook-ran"))).toBe(false);
  });

  test("a filter the reviewer scoped to worktrees is disabled like any other", async () => {
    // `includeIf` is evaluated against the gitdir of whichever repository the
    // command runs in, and the checkout half runs in the worktree — whose gitdir
    // is `<clone>/worktrees/<name>`, a path a reviewer can single out and one
    // the bare clone does not match. Config reached this way is invisible to
    // anything enumerating the clone, which is why the checkout is overridden
    // against its own gitdir rather than the clone's.
    const work = await originNaming("scoped");
    const sha = (await git(["rev-parse", "HEAD"], work)).trim();
    const scoped = join(dir, "worktrees-only.gitconfig");
    writeFileSync(
      scoped,
      `[filter "scoped"]\n\tsmudge = ${marker("scoped-ran")}\n\trequired = true\n`,
    );
    reviewerGlobalConfig(`[includeIf "gitdir:**/worktrees/**"]\n\tpath = ${scoped}\n`);

    const path = await prepareRevision({ ...where(), url: work, sha });

    expect(await Bun.file(join(path, "scoped.txt")).text()).toBe("content\n");
    expect(existsSync(join(dir, "scoped-ran"))).toBe(false);
  });

  test("an exported GIT_DIR does not aim the checkout somewhere else", async () => {
    // git honours `GIT_DIR` over the working directory, so a run started from a
    // git hook — or from a shell that exports it — would otherwise build the
    // worktree inside whichever repository the reviewer was standing in.
    const decoy = join(dir, "decoy.git");
    await git(["init", "--bare", decoy], dir);
    process.env.GIT_DIR = decoy;

    const path = await prepareRevision({ ...where(), sha: origin.sha });

    expect((await git(["rev-parse", "HEAD"], path)).trim()).toBe(origin.sha);
    expect(await git(["worktree", "list", "--porcelain"], decoy)).not.toContain(path);
  });

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
