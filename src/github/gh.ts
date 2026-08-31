/**
 * @file Engwire's direct `gh` API boundary.
 *
 * Engwire deliberately has no GitHub credentials of its own: it borrows the
 * reviewer's authenticated CLI. That means no additional token to issue and no
 * additional service granted repository access, which is why Engwire's GitHub
 * API calls funnel through here rather than through an HTTP client. Git invokes
 * `gh auth git-credential` separately when a clone needs credentials.
 */

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GhError";
  }
}

export type Gh = {
  text: (args: string[]) => Promise<string>;
  json: <T>(args: string[]) => Promise<T>;
  /** The account whose review requests this installation answers. */
  login: () => Promise<string>;
};

/**
 * Engwire is a GitHub.com tool, and says so by pinning the host rather than
 * checking it.
 *
 * `gh` resolves its host from `GH_HOST` or its own config, while Engwire's
 * clone URLs are `https://github.com/...` unconditionally. Left ambient, those
 * two can disagree: discovery finds `acme/api` on an enterprise host while the
 * checkout is a different `acme/api` on github.com. Overriding the variable at
 * the subprocess boundary is a smaller thing to reason about than validating
 * every caller's environment.
 */
export const GITHUB_ENV = { GH_HOST: "github.com" } as const;

/**
 * @param env The environment `gh` runs in. `GH_TOKEN` can override stored
 * credentials, while `GH_CONFIG_DIR` selects which stored configuration it
 * reads. The environment can therefore decide which account `gh` uses, which
 * is why `service install` checks the one launchd will supply.
 */
export function createGh(bin = "gh", env: Record<string, string | undefined> = process.env): Gh {
  const text = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, ...GITHUB_ENV },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new GhError(args, exitCode, stderr);
    return stdout;
  };

  return {
    text,
    json: async <T,>(args: string[]) => JSON.parse(await text(args)) as T,
    login: async () => (await text(["api", "user", "--jq", ".login"])).trim(),
  };
}
