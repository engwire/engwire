/**
 * @file Checkouts for review runs.
 *
 * One worktree per run, detached at the run's claimed SHA — not its request-time
 * revision, which a queued run follows until it starts.
 * `prepareRevision` is the whole surface the rest of Engwire sees: give it a
 * clone location, a worktree location and that SHA, get back a directory.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureRepository, fetchRevision, git, inertOverrides } from "./repository.ts";

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
  // Created empty, then filled — two commands rather than one, because they run
  // against two different repositories as far as git's configuration is
  // concerned. A plain `worktree add` does the checkout in a child process whose
  // gitdir is the *new worktree's*, so config the reviewer scoped to that gitdir
  // is invisible from the clone Engwire enumerated and none of it gets
  // overridden. A measured smudge filter behind
  // `[includeIf "gitdir:**/worktrees/**"]` ran. Splitting the checkout lets each
  // half be overridden against the gitdir that will actually do the work.
  await git(
    [
      ...(await inertOverrides(options.repoDir)),
      "worktree",
      "add",
      "--detach",
      "--force",
      "--no-checkout",
      options.worktreeDir,
      options.sha,
    ],
    options.repoDir,
  );
  // The revision is named again rather than inherited from the `HEAD` the line
  // above left behind: this is the command that writes the tree, so this is
  // where being wrong about the revision should fail. `--no-recurse-submodules`
  // because `submodule.recurse` is the reviewer's setting to make, and honouring
  // it here would have the branch's own `.gitmodules` choose which servers a
  // checkout contacts.
  await git(
    [
      ...(await inertOverrides(options.worktreeDir)),
      "reset",
      "--hard",
      "--no-recurse-submodules",
      options.sha,
    ],
    options.worktreeDir,
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
