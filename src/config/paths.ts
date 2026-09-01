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

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
