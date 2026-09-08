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
