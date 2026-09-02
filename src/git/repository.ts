/**
 * @file Engwire's own copy of a repository.
 *
 * The reviewer's checkout is off limits — it has uncommitted work, hooks, and a
 * branch they care about, and a review must never be the reason any of that
 * moves. Engwire keeps its own bare clone per repository and builds worktrees
 * from it, so reviews do not disturb the owner's working copies.
 *
 * How that clone is kept cheap — bare, blobless, single-revision fetches — is
 * this module's business alone. Nothing above it names a git flag.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { absolutePath } from "../config/paths.ts";

/** Not exported: nothing discriminates on a failed `git`, unlike `GhError`. */
class GitError extends Error {
  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Empty value passed to unambiguous config keys through `--config-env`. */
export const GIT_INERT = "ENGWIRE_GIT_INERT";

/**
 * @param cwd Required, not optional: every git Engwire runs works in a
 * directory it created, and the process's own can be a checkout of the branch
 * under review. Naming it at every call is what keeps that true by
 * construction rather than by convention.
 */
export async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // `git` is resolved through this PATH, not the ambient one — a review run
    // from inside a contributor's checkout must not find their `git` — and the
    // helpers git reaches for itself, `ssh` among them, inherit the same rule.
    env: {
      ...process.env,
      PATH: absolutePath(),
      GIT_TERMINAL_PROMPT: "0",
      [GIT_INERT]: "",
      // Dropped rather than inherited: each of these names a repository, and
      // git honours them over the working directory. An `engwire run` started
      // from a git hook, or from a shell that exports `GIT_DIR`, would
      // otherwise aim every command below at the reviewer's own checkout —
      // which is the one thing Engwire promises never to touch. `cwd` is only
      // a guarantee once nothing outranks it.
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new GitError(args, exitCode, stderr);
  return stdout;
}

/**
 * Return the key to blank so one executable config entry cannot run.
 *
 * The keys git reaches are named by the reviewer, not by Engwire, and there is
 * no wildcard override — so each has to be found in the effective config:
 *
 * - a filter driver's `smudge` or `process`, which a committed `.gitattributes`
 *   activates by naming the filter. `required` goes with them — git-lfs marks
 *   its filter required, and a required filter whose commands are disabled
 *   fails the checkout outright rather than falling back. `clean` is the
 *   check-in direction and measurably does not run here, so it is left alone.
 * - a hook configured as `hook.<name>.command`, git 2.54's alternative to a
 *   script on disk. `core.hooksPath` does not cover these; `enabled` is the
 *   documented way to switch one off, and it is keyed by the hook's own name
 *   rather than by the event it answers.
 *
 * An empty value serves both: it disables a driver, and reads as false for
 * `enabled`.
 */
function inertKey(key: string): string | undefined {
  if (/^filter\..*\.(smudge|process|required)$/.test(key)) return key;
  const hook = /^hook\.(.+)\.event$/.exec(key);
  return hook ? `hook.${hook[1]}.enabled` : undefined;
}

/**
 * Arguments that stop git running a reviewer-configured program.
 *
 * These overrides are targeted rather than replacing the global config because
 * blobless fetches still need the reviewer's proxy and credential settings. The
 * executable keys, measured behaviour and residual boundary are recorded in
 * `docs/experiments.md`.
 *
 * @param dir The repository whose effective configuration the command will use.
 */
export async function inertOverrides(dir: string): Promise<string[]> {
  // Listing names succeeds on an empty result, where matching them in git does
  // not — so a `git` that fails here fails the command it guards, rather than
  // being read as "nothing to disable". Values are never asked for: they can
  // contain newlines, and only the keys are needed.
  const keys = (await git(["config", "--name-only", "--list"], dir)).split("\n");
  const overrides = new Set(keys.map(inertKey).filter((key) => key !== undefined));
  return [
    // `--config-env` rather than `-c`, because a subsection name may contain an
    // `=` that `-c` would misparse into a different key. The two fixed keys
    // below have no such ambiguity.
    ...[...overrides].map((key) => `--config-env=${key}=${GIT_INERT}`),
    "-c",
    "core.hooksPath=/dev/null",
    // Empty rather than `false`: git documents versions through 2.35.1 as
    // reading a boolean-looking value here as the hook's pathname. Measured
    // inert on 2.54.0, including where the reviewer had set it to `true`.
    "-c",
    "core.fsmonitor=",
  ];
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

  const parent = dirname(options.dir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = `${options.dir}.incoming`;
  await rm(staging, { recursive: true, force: true });
  try {
    // Run from the directory just created, not from wherever the runner was
    // started — which can be a checkout of the branch under review. `clone` is
    // a command git runs without a repository, so measurably it does not honour
    // the surrounding one's config, but that is git's semantics to change and
    // this is the only `git` Engwire runs outside a directory of its own.
    await git(
      [
        ...(await inertOverrides(parent)),
        "clone",
        "--bare",
        "--filter=blob:none",
        ...cloneAuth(options.ghBin, github),
        options.url,
        staging,
      ],
      parent,
    );
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

/**
 * Idempotent: replaces whatever the clone's config held with the current answer.
 *
 * Rewritten on every use rather than once at clone time, because the helper
 * embeds an absolute `gh` path and `gh` moves with a Homebrew upgrade. A clone
 * made months ago would otherwise keep invoking a binary that is gone, while
 * `doctor` reported the new one as healthy.
 */
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

  const inert = await inertOverrides(dir);
  try {
    await git([...inert, "fetch", "--no-tags", "--filter=blob:none", "origin", sha], dir);
  } catch {
    await git(
      [
        ...inert,
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
