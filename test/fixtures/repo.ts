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

export type Origin = { url: string; sha: string; secondSha: string };

export async function createOrigin(dir: string): Promise<Origin> {
  const work = join(dir, "work");
  const bare = join(dir, "origin.git");
  mkdirSync(work, { recursive: true });

  await git(["init", "-b", "main"], work);
  await git(["config", "user.email", "test@example.com"], work);
  await git(["config", "user.name", "Test"], work);

  await Bun.write(join(work, "README.md"), "# widgets\n");
  await git(["add", "."], work);
  await git(["commit", "-m", "first"], work);
  const sha = (await git(["rev-parse", "HEAD"], work)).trim();

  await Bun.write(join(work, "README.md"), "# widgets, revised\n");
  await git(["commit", "-am", "second"], work);
  const secondSha = (await git(["rev-parse", "HEAD"], work)).trim();

  await git(["clone", "--bare", work, bare], dir);
  return { url: bare, sha, secondSha };
}
