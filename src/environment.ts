/**
 * @file What no subprocess Engwire starts should inherit.
 *
 * Every edge in this project spawns a program while standing somewhere a
 * contributor may control — the review's worktree, or whatever directory
 * `engwire run` was typed in. The variables here are the ones that make an
 * interpreter or a loader read code relative to that directory, at startup or
 * during module resolution. Each edge still owns its Git, GitHub,
 * PATH, deadline and process-group policy; this is only the part they share.
 */

import { isAbsolute } from "node:path";

/**
 * The environment with the startup-code selectors removed.
 *
 * Measured on Debian with `LD_PRELOAD` and on macOS with
 * `DYLD_INSERT_LIBRARIES`: a relative library loaded into `git`, `gh` and
 * Engwire's release binary. The signed Claude tested on macOS stripped
 * `DYLD_*`, but other installation methods need not. See docs/experiments.md.
 *
 * Whole namespaces cover related selectors without maintaining a list of
 * individual names. This also removes benign settings such as `NODE_ENV`,
 * `NODE_EXTRA_CA_CERTS`, heap limits and toolchain library paths, from every
 * edge rather than only the agent's; whoever needs one sets it explicitly on
 * the command they own.
 *
 * `BASH_ENV` names a startup file and is removed. `ENV` stays because the
 * measured non-interactive `sh` did not read it. zsh's directory selector stays
 * too: dropping `ZDOTDIR` falls back to `HOME`, so `zshStartupProblem` checks it
 * separately. Neither this filter nor those measurements establish that every
 * code-loading variable is covered. Filtering children also cannot protect
 * Engwire's own startup; SECURITY.md describes that residual.
 */
export function withoutStartupCodeVariables(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !name.startsWith("NODE_") &&
        !name.startsWith("LD_") &&
        !name.startsWith("DYLD_") &&
        name !== "BASH_ENV",
    ),
  );
}

/**
 * What is wrong with where this environment points zsh, or null.
 *
 * Measured with a `.zshenv` in each candidate directory: `ZDOTDIR` wins when
 * set, including an empty value; otherwise zsh consults `HOME`. Empty values
 * and an absent `HOME` read nothing from the working directory. Refuse only a
 * non-empty relative selector and leave the other values untouched.
 *
 * Dropping `ZDOTDIR` can replace a safe selector with an unsafe `HOME`.
 * Resolving a relative selector to an absolute path is insufficient too: the
 * runner may start in an untrusted checkout, so resolution can pin the branch's
 * own startup file. The experiment confirms that file then runs even from a
 * different directory. See docs/experiments.md for the precedence and pinning
 * probes.
 */
export function zshStartupProblem(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const dir = env.ZDOTDIR ?? env.HOME;
  if (dir === undefined || dir === "" || isAbsolute(dir)) return null;
  // `ZDOTDIR` unset is the only way `HOME` gets asked, so the variable that
  // decided is the one to send someone to.
  const named = env.ZDOTDIR === undefined ? "HOME" : "ZDOTDIR";
  return (
    `${named} is set to ${JSON.stringify(dir)}, a relative path. zsh reads \`.zshenv\` from that ` +
    "directory on every invocation, resolved against wherever the shell itself starts — during a " +
    "review that is the checkout, so the branch would supply the file its first tool call runs. " +
    `Set ${named} to an absolute path.`
  );
}
