/**
 * @file Engwire's own copy of a repository.
 *
 * The reviewer's checkout is off limits — it has uncommitted work, hooks, and a
 * branch they care about, and a review must never be the reason any of that
 * moves. Engwire keeps its own bare clone per repository and builds worktrees
 * from it, so a review is invisible to the machine's owner.
 *
 * How that clone is kept cheap — bare, blobless, single-revision fetches — is
 * this module's business alone. Nothing above it names a git flag.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export class GitError extends Error {
  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
  return stdout;
}

/** The HTTPS URL Engwire clones, and the one `gh` resolves from inside a worktree. */
export function cloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * Scoped to github.com rather than to the clone as a whole.
 *
 * A bare `credential.helper` would answer for every host a command inside the
 * worktree reaches, and the empty entry that precedes it would suppress the
 * user's own helpers for those hosts too. Engwire authenticates to exactly one
 * host, so it configures exactly one: a URL section overrides github.com and
 * leaves the rest of the user's credential configuration untouched.
 */
const HELPER_KEY = "credential.https://github.com.helper";

/**
 * The credential helper Engwire writes into its own clones.
 *
 * Engwire never holds a token: it shells out to `gh` each time git needs one.
 * Whatever `gh_bin` names is what the helper runs — an absolute path when the
 * config gives one, which matters because git runs the helper through a shell
 * whose `PATH` under launchd may not have the user's `gh` on it. Quoted,
 * because a home directory can contain a space.
 */
function credentialHelper(ghBin: string): string {
  return `!'${ghBin.replaceAll("'", `'\\''`)}' auth git-credential`;
}

/**
 * Ensure a bare clone exists at `dir`, cloning from `url` if it does not.
 *
 * Blobless: history metadata is cheap, file contents are fetched on demand.
 *
 * The credential helper is passed to `clone` rather than configured after it,
 * so the very first fetch is authenticated — otherwise a private repository
 * would only clone for someone who had already set up git credentials by hand.
 * `clone -c` also persists it, so the lazy blob fetches a checkout triggers are
 * authenticated too. The empty helper before it resets the list for github.com:
 * git tries helpers in order until one answers, and a helper inherited from the
 * user's global config could otherwise answer first, as an account that is not
 * the one `engwire doctor` checked.
 *
 * The clone lands beside its destination and is renamed into place. A crash
 * halfway through would otherwise leave a directory that exists, is not a
 * repository, and is treated as one by every later review.
 *
 * The helper is rewritten on every call, not only on the first. It embeds an
 * absolute path, and `gh` moves — a Homebrew upgrade, a reinstall — so a clone
 * made months ago would otherwise keep invoking a `gh` that is no longer there
 * while `doctor` reports the new one as healthy.
 */
export async function ensureRepository(options: {
  url: string;
  dir: string;
  ghBin: string;
}): Promise<void> {
  const github = options.url.startsWith("https://github.com/");

  if (existsSync(options.dir)) {
    if (github) await configureCredentials(options.dir, options.ghBin);
    return;
  }

  await mkdir(dirname(options.dir), { recursive: true, mode: 0o700 });
  const staging = `${options.dir}.incoming`;
  await rm(staging, { recursive: true, force: true });
  try {
    await git(["clone", "--bare", "--filter=blob:none", ...cloneAuth(options.ghBin, github), options.url, staging]);
    await rename(staging, options.dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function cloneAuth(ghBin: string, github: boolean): string[] {
  return github
    ? ["-c", `${HELPER_KEY}=`, "-c", `${HELPER_KEY}=${credentialHelper(ghBin)}`]
    : [];
}

/** Idempotent: replaces whatever the clone's config held with today's answer. */
async function configureCredentials(dir: string, ghBin: string): Promise<void> {
  await git(["config", "--unset-all", HELPER_KEY], dir).catch(() => {});
  await git(["config", "--add", HELPER_KEY, ""], dir);
  await git(["config", "--add", HELPER_KEY, credentialHelper(ghBin)], dir);
}

/**
 * Fetch one revision into the clone.
 *
 * By SHA first, which GitHub allows and which gets exactly the revision the run
 * was claimed at. Falling back to `refs/pull/N/head` covers the case where the
 * server refuses an arbitrary SHA; that ref is guaranteed to exist, though it
 * may already have moved past the revision under review — which the caller
 * detects, because the checkout is by SHA and simply fails.
 */
export async function fetchRevision(
  dir: string,
  sha: string,
  pullNumber: number,
): Promise<void> {
  // Already here: a second review of the same revision, or a revision the last
  // fetch happened to bring along. Cheap to check, and it removes a network
  // round trip from the common case of re-reviewing a pull request.
  if (await hasRevision(dir, sha)) return;

  try {
    await git(["fetch", "--no-tags", "--filter=blob:none", "origin", sha], dir);
  } catch {
    await git(
      [
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "origin",
        `+refs/pull/${pullNumber}/head:refs/engwire/pull/${pullNumber}`,
      ],
      dir,
    );
  }
}

async function hasRevision(dir: string, sha: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${sha}^{commit}`], dir);
    return true;
  } catch {
    return false;
  }
}
