/**
 * @file What a spawned git inherits.
 *
 * Two rules, one file: the `GIT_*` namespace every caller drops, and the
 * configuration policy `git()` puts back on top of it. `doctor` reads the
 * second to probe the git it found under the environment git will be given,
 * which is why it takes an environment rather than reading this process's.
 */

import { isAbsolute } from "node:path";
import { withoutStartupCodeVariables } from "../environment.ts";

/**
 * Drop every inherited `GIT_*` variable so ambient repository selectors and
 * executable overrides cannot outrank the caller's cwd and PATH.
 *
 * Use the namespace rather than a list: `GIT_EXEC_PATH`, `GIT_SSH_COMMAND` and
 * `GIT_ASKPASS` select programs as well as the familiar repository selectors
 * selecting directories. Measurements are in docs/experiments.md.
 *
 * Other variables, including HOME, stay. Each caller owns its config policy:
 * Engwire's git restores selected config-file controls and neutralises
 * executable keys; the agent disables global and system config for its diffs.
 */
export function withoutGitVariables(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

/**
 * Remove ambient Git overrides, then restore the reviewer's config-file policy.
 * `inertOverrides` enumerates and neutralises that same effective configuration.
 *
 * Relative file selectors could read a branch's committed `.gitconfig` from
 * the worktree. Replace them, and empty selectors, with `/dev/null`: dropping
 * them would fall back to config the caller had not selected. Keep
 * `GIT_CONFIG_NOSYSTEM` verbatim so a disabled system file stays disabled.
 * These behaviours are measured in docs/experiments.md.
 *
 * `GIT_CONFIG_COUNT` and its KEY/VALUE pairs stay removed: they inject config
 * values rather than select files.
 *
 * Exported, and taking the environment rather than reading it, so `doctor` can
 * probe the git it found under the environment git will actually get without
 * keeping a second copy of this rule — and so `service install` can ask the
 * same question about the environment launchd will supply.
 */
export function gitEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  // The startup-code selectors go first and for a reason of their own: git runs
  // with a cwd inside a clone of the branch, and a relative `LD_PRELOAD` was
  // measured to run a constructor inside `git --version` on both platforms.
  // That is upstream of every config control below — it happens before git
  // reads a byte of configuration.
  const kept = withoutStartupCodeVariables(withoutGitVariables(env));
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const) {
    const value = env[name];
    if (value !== undefined) kept[name] = isAbsolute(value) ? value : "/dev/null";
  }
  const noSystem = env.GIT_CONFIG_NOSYSTEM;
  if (noSystem !== undefined) kept.GIT_CONFIG_NOSYSTEM = noSystem;
  return kept;
}
