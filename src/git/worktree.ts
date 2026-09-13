/**
 * @file Checkouts for review runs.
 *
 * One worktree per run, detached at the run's claimed SHA — not its request-time
 * revision, which a queued run follows until it starts.
 * `prepareRevision` is the whole surface the rest of Engwire sees: give it a
 * clone location, a worktree location and that SHA, get back a directory.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { privateDir } from "../config/paths.ts";
import { ensureRepository, fetchRevision, git, GitAborted, inertOverrides } from "./repository.ts";

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
  /**
   * Stops the checkout: the caller's shutdown, its deadline, or both.
   *
   * One signal for the whole preparation rather than a budget per command. The
   * caller is waiting on "a directory at this SHA", not on any of the dozen-odd
   * commands that produce one — and per-command budgets would have to be loose
   * enough for a first clone, which makes them meaningless for the `cat-file`
   * beside it.
   */
  signal: AbortSignal;
}): Promise<string> {
  // Worktrees hold a contributor's source tree, so their parent gets the
  // private-directory policy.
  privateDir(dirname(options.worktreeDir));
  await ensureRepository({
    url: options.url,
    dir: options.repoDir,
    ghBin: options.ghBin,
    signal: options.signal,
  });
  await fetchRevision(options.repoDir, options.sha, options.pullNumber, options.signal);
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
      ...(await inertOverrides(options.repoDir, options.signal)),
      "worktree",
      "add",
      "--detach",
      "--force",
      "--no-checkout",
      options.worktreeDir,
      options.sha,
    ],
    options.repoDir,
    options.signal,
  );
  // The revision is named again rather than inherited from the `HEAD` the line
  // above left behind: this is the command that writes the tree, so this is
  // where being wrong about the revision should fail. It is also a network
  // command despite reading like a local one — the clone is blobless, so
  // writing the tree is what fetches the file contents, and it is as capable of
  // stalling as the `fetch` above. `--no-recurse-submodules`
  // because `submodule.recurse` is the reviewer's setting to make, and honouring
  // it here would have the branch's own `.gitmodules` choose which servers a
  // checkout contacts.
  await git(
    [
      ...(await inertOverrides(options.worktreeDir, options.signal)),
      "reset",
      "--hard",
      "--no-recurse-submodules",
      options.sha,
    ],
    options.worktreeDir,
    options.signal,
  );
  return options.worktreeDir;
}

/**
 * Deadline for local `git worktree prune`; git's kill grace follows expiry.
 * Recursive removal is uncancellable, so this does not bound removeWorktree.
 * Exported so the launchd shutdown-allowance test includes this wait as well
 * as git's grace. Cleanup finishes independently of the caller's shutdown.
 */
export const PRUNE_ABORT_MS = 60_000;

/**
 * Remove a worktree and the administrative files git keeps for it.
 *
 * Tolerant of a directory that is already gone: the reaper runs against rows
 * that may describe a checkout the user deleted by hand.
 *
 * Takes no caller signal, deliberately, though every `git` needs one. The two
 * steps are not equally interruptible: the removal cannot be stopped once it
 * starts, so a shutdown could only ever land between them — with the checkout
 * deleted and the clone still holding an administrative entry naming it, and
 * the caller told the removal failed when it is the bookkeeping that did. The
 * pair is small and local, so it runs to the end and callers stop *between*
 * worktrees instead. Its own ceiling keeps that from being an unbounded git.
 */
export async function removeWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  if (existsSync(worktreeDir)) {
    await rm(worktreeDir, { recursive: true, force: true });
  }
  if (existsSync(repoDir)) {
    // The ceiling is this function's own, so its expiry is reported as this
    // function's own failure. Left as a `GitAborted`, it would reach
    // `executeRun` — which calls this from `prepareRevision` — as the caller's
    // cancellation, and be filed against a `checkout_timeout` that has not
    // elapsed or a shutdown nobody asked for.
    await git(["worktree", "prune"], repoDir, AbortSignal.timeout(PRUNE_ABORT_MS)).catch(
      (error: unknown) => {
        if (!(error instanceof GitAborted)) throw error;
        throw new Error(`git worktree prune in ${repoDir} exceeded ${PRUNE_ABORT_MS}ms`);
      },
    );
  }
}
