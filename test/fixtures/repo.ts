/**
 * @file A stand-in for a repository on GitHub.
 *
 * Real git, not a mock: git is fast, and the parts of it Engwire depends on —
 * bare clones, detached worktrees, pruning — are exactly the parts a mock would
 * get wrong.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/git/repository.ts";

/**
 * The signal fixture setup passes to `git`.
 *
 * Never aborted: building a repository out of local objects is not the review
 * path, and a deadline here would only add a way for a slow machine to fail a
 * test about something else. Named rather than inlined so that a test which
 * does want to stop a git has to say so.
 */
export const NO_DEADLINE = new AbortController().signal;

export type Origin = { url: string; sha: string; secondSha: string };

/**
 * Builds the origin with the developer's own git configuration out of the way.
 *
 * Hermetic first: the fixture is eight git commands, and every one of them
 * currently answers to whatever the machine running the tests has configured.
 * A `commit.gpgsign` there signs each commit — and a passphrase-protected key
 * turns the suite into a pinentry prompt nobody asked for. Faster as a side
 * effect, and measurably: about 470ms of setup becomes about 150ms, per test,
 * across the three files that build one.
 *
 * `/dev/null` rather than unset, because `git()` keeps an absolute config
 * selector and answers anything else with `/dev/null` — the same rule
 * production runs under, and unset would have let the machine's own global
 * config back in.
 */
async function hermetically<T>(build: () => Promise<T>): Promise<T> {
  const saved = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM] as const;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    return await build();
  } finally {
    for (const [name, value] of [
      ["GIT_CONFIG_GLOBAL", saved[0]],
      ["GIT_CONFIG_SYSTEM", saved[1]],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function createOrigin(dir: string): Promise<Origin> {
  return hermetically(() => buildOrigin(dir));
}

async function buildOrigin(dir: string): Promise<Origin> {
  const work = join(dir, "work");
  const bare = join(dir, "origin.git");
  mkdirSync(work, { recursive: true });

  await git(["init", "-b", "main"], work, NO_DEADLINE);
  await git(["config", "user.email", "test@example.com"], work, NO_DEADLINE);
  await git(["config", "user.name", "Test"], work, NO_DEADLINE);

  await Bun.write(join(work, "README.md"), "# widgets\n");
  await git(["add", "."], work, NO_DEADLINE);
  await git(["commit", "-m", "first"], work, NO_DEADLINE);
  const sha = (await git(["rev-parse", "HEAD"], work, NO_DEADLINE)).trim();

  await Bun.write(join(work, "README.md"), "# widgets, revised\n");
  await git(["commit", "-am", "second"], work, NO_DEADLINE);
  const secondSha = (await git(["rev-parse", "HEAD"], work, NO_DEADLINE)).trim();

  await git(["clone", "--bare", work, bare], dir, NO_DEADLINE);
  return { url: bare, sha, secondSha };
}
