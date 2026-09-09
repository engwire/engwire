/**
 * @file Where Engwire keeps its files.
 *
 * XDG layout on every platform, macOS included. Developers expect `~/.config`
 * and `~/.local/share` more than `~/Library/Application Support`, and one
 * layout means one set of paths to document, test and uninstall. `ENGWIRE_HOME`
 * relocates all configuration and state, which is how the tests get a
 * disposable installation.
 *
 * A function rather than module constants: the environment is an argument, so a
 * test can point one case somewhere else without the import order deciding —
 * and so `service install` can ask where the *service* will look, which is not
 * necessarily where the installing shell looks.
 *
 * It also owns the executable search path used for review tooling.
 */

import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * A `PATH` with nothing relative left in it, used whenever review tooling is
 * resolved or spawned.
 *
 * A relative entry — `.`, a bare `tools`, or the empty string a leading or
 * trailing `:` produces — names a directory relative to the *working* directory,
 * and a working directory here may be contributor-controlled: the agent's is a
 * checkout of the branch under review, and the runner's is wherever the reviewer
 * happened to be standing when they typed the command, which can be that same
 * checkout. Measured against a real shell, all four forms execute from it.
 *
 * One definition is shared by `git`, `gh`, the agent, and the binaries `setup`
 * writes into the config. `Bun.spawn` resolves a bare command through the
 * `PATH` it is *given*, so handing this to a subprocess is what closes the
 * boundary, not merely what tidies it.
 */
export function absolutePath(path = process.env.PATH ?? ""): string {
  return path.split(":").filter(isAbsolute).join(":");
}

/**
 * A path with the deepest ancestor `realpath` can resolve resolved, and the
 * rest re-appended.
 *
 * `realpathSync` needs the whole path to exist, and Engwire's directories often
 * do not — before the first run, and after anything removes them. Resolving
 * only whole paths would leave an installation reached through a symlinked
 * ancestor unable to recognise its own service exactly then: it would call the
 * job foreign, leave it loaded, and still report the uninstall as done.
 *
 * Every failure climbs, not only a missing path, because this is used only for
 * comparison and must not throw while diagnosing a broken installation. A path
 * with no resolvable ancestor comes back as written. The result must never be
 * used as a path to act on.
 */
export function resolveDeepest(path: string): string {
  const missing: string[] = [];
  for (let head = path; ; ) {
    try {
      return join(realpathSync(head), ...missing);
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Create a directory recursively, and set the named directory's mode to `0700`
 * unless that name is a link.
 *
 * `mkdir` leaves an existing directory's mode unchanged, so the explicit
 * `chmod` also covers restored directories and older installations. Only the
 * named directory is tightened; newly created parents receive the `mkdir` mode,
 * which a umask can subtract from but never add to, while existing parents may
 * be shared, and a named directory that is itself a link is left to whoever it
 * belongs to.
 *
 * This changes POSIX mode bits, not inherited ACLs — a directory created under
 * a parent carrying a granting one is one another local user can still list,
 * and the first run makes `~/.local/share/engwire` under whatever
 * `~/.local/share` already has.
 */
export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Never through a link. `chmod` follows one — measured — so this would set
  // the mode of a directory somebody moved elsewhere and linked back from, and
  // that directory is theirs to decide about. `uninstall` reads a removal root
  // the same way: a link at the entry stands in for the directory rather than
  // being it.
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  chmodSync(path, 0o700);
}

export type Paths = {
  configFile: string;
  dataDir: string;
  dbFile: string;
  lockFile: string;
  logsDir: string;
  runLog: (runId: string) => string;
  /** Bare clone backing every worktree for `owner/name`. */
  repoDir: (repo: string) => string;
  worktreeDir: (runId: string) => string;
};

export function paths(env: Record<string, string | undefined> = process.env): Paths {
  const home = env.ENGWIRE_HOME;
  const configDir = home
    ? join(home, "config")
    : join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "engwire");
  const dataDir = home
    ? join(home, "data")
    : join(
        env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"),
        "engwire",
      );

  const logsDir = join(dataDir, "logs");

  return {
    configFile: join(configDir, "config.toml"),
    dataDir,
    dbFile: join(dataDir, "engwire.db"),
    lockFile: join(dataDir, "runner.lock"),
    logsDir,
    runLog: (runId) => join(logsDir, "runs", `${runId}.log`),
    repoDir: (repo) => join(dataDir, "repos", `${repo}.git`),
    worktreeDir: (runId) => join(dataDir, "worktrees", runId),
  };
}

/**
 * What is wrong with where this environment points Engwire, or null.
 *
 * Asked of the answers rather than of the variables, so a route added later
 * cannot slip past it. Both answers have to hold still: an installation is its
 * data directory, and a relative one is a different directory from every
 * working directory — so the lock, the database and the watermark that make
 * "one runner, one queue, one identity" true would each be per-cwd. A relative
 * *config* directory is the smaller fault and a separate sentence, because what
 * moves is which rules and which skill an invocation reads.
 *
 * A problem rather than a throw, because two commands need these paths *in
 * order to* report on them: `uninstall` prints the inventory before refusing to
 * delete anything at an address that moves, and `doctor` exists to say what is
 * wrong. `locatesData` asks a narrower version of this at the launchd boundary,
 * where the question is which installation a job supervises rather than whether
 * one can exist at all.
 */
export function locationProblem(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const p = paths(env);
  // The variable to send someone to, named in the order `paths` reads them;
  // `ENGWIRE_HOME` shadows the rest, so nothing under it is worth blaming. A
  // value has to be truthy to be blamed — an empty one is falsy at every use
  // above and falls through to the same defaults as an unset one. Null when
  // none is at fault: nothing in `env` reaches that, since every relative
  // answer traces to one of the names consulted, but `homedir()` is not from
  // `env`, and naming an unset `HOME` for the home lookup having gone wrong
  // would send the reader to fix the wrong thing.
  const blame = (...consulted: string[]): string | null => {
    const name = (env.ENGWIRE_HOME ? ["ENGWIRE_HOME"] : consulted).find(
      (key) => Boolean(env[key]) && !isAbsolute(env[key] as string),
    );
    return name ? `${name} is set to ${JSON.stringify(env[name])}` : null;
  };

  if (!isAbsolute(p.dataDir)) {
    const blamed =
      blame("XDG_DATA_HOME", "HOME") ??
      `Engwire's data directory works out to ${JSON.stringify(p.dataDir)}`;
    return (
      `${blamed}, which is a relative path. Engwire's database, lock, clones and review ` +
      "transcripts would land wherever each command happened to be run from — so two runs " +
      "from two directories would be two installations, each reviewing the same requests. " +
      "Use an absolute path."
    );
  }

  const configDir = dirname(p.configFile);
  if (!isAbsolute(configDir)) {
    const blamed =
      blame("XDG_CONFIG_HOME", "HOME") ??
      `Engwire's config directory works out to ${JSON.stringify(configDir)}`;
    return (
      `${blamed}, which is a relative path. Which repositories are automated, and with which ` +
      "skill, would then depend on the directory each command happened to be run from. " +
      "Use an absolute path."
    );
  }

  return null;
}

/**
 * What can name the data directory, in the order `paths` reads them.
 *
 * Exported because `service install` reports on the same three, and two
 * spellings of one precedence is how they come to disagree.
 */
export const LOCATORS = ["ENGWIRE_HOME", "XDG_DATA_HOME", "HOME"] as const;

/**
 * Whether the environment identifies a data directory without process
 * fallbacks.
 *
 * Narrower than `locationProblem` above, and they disagree where it matters: an
 * empty environment locates no data directory but is a perfectly good
 * installation, because `homedir()` is a fine default for a shell and no
 * default at all for a plist.
 */
export function locatesData(env: Record<string, string | undefined>): boolean {
  // A relative base depends on a working directory the plist does not preserve,
  // so it cannot identify which installation a service supervises.
  const base = LOCATORS.map((name) => env[name]).find(Boolean);
  return base !== undefined && isAbsolute(base);
}
