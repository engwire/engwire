/**
 * @file Checkouts a review runs in.
 *
 * One worktree per run, detached at the run's claimed SHA — not its request-time
 * revision, which a queued run follows until it starts.
 * `prepareRevision` is the whole surface the rest of Engwire sees: give it a
 * clone location, a worktree location and that SHA, get back a directory.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureRepository, fetchRevision, git } from "./repository.ts";

export async function prepareRevision(options: {
  sha: string;
  pullNumber: number;
  /** Bare clone location. */
  repoDir: string;
  /** Where the checkout goes. */
  worktreeDir: string;
  /** Where to clone from; the caller decides, so this module never guesses. */
  url: string;
  /** The configured `gh`; git authenticates fetches through it. */
  ghBin: string;
}): Promise<string> {
  // Worktrees hold private source; keep their parent private too.
  await mkdir(dirname(options.worktreeDir), { recursive: true, mode: 0o700 });
  await ensureRepository({
    url: options.url,
    dir: options.repoDir,
    ghBin: options.ghBin,
  });
  await fetchRevision(options.repoDir, options.sha, options.pullNumber);
  await removeWorktree(options.repoDir, options.worktreeDir);
  await git(
    ["worktree", "add", "--detach", "--force", options.worktreeDir, options.sha],
    options.repoDir,
  );
  return options.worktreeDir;
}

/**
 * Remove a worktree and the administrative files git keeps for it.
 *
 * Tolerant of a directory that is already gone: the reaper runs against rows
 * that may describe a checkout the user deleted by hand.
 */
export async function removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  if (existsSync(worktreeDir)) {
    await rm(worktreeDir, { recursive: true, force: true });
  }
  if (existsSync(repoDir)) {
    await git(["worktree", "prune"], repoDir);
  }
}
