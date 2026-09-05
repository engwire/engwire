/**
 * @file Engwire's direct `gh` API boundary.
 *
 * Engwire deliberately has no GitHub credentials of its own: it borrows the
 * reviewer's authenticated CLI. That means no additional token to issue and no
 * additional service granted repository access, which is why Engwire's GitHub
 * API calls funnel through here rather than through an HTTP client. Git invokes
 * `gh auth git-credential` separately when a clone needs credentials.
 */

import { absolutePath } from "../config/paths.ts";

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    /** `null` for a timeout, even if the process exited before its pipes closed. */
    readonly exitCode: number | null,
    /** `gh`'s stderr or Engwire's own failure detail. */
    readonly detail: string,
  ) {
    const how = exitCode === null ? "" : ` (exit ${exitCode})`;
    super(`gh ${args.join(" ")} failed${how}: ${detail.trim()}`);
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
 * How long Engwire waits for a `gh` invocation to produce a complete answer.
 *
 * A paginated call can make many requests, so the fixed two-minute deadline is
 * deliberately generous. It is a failure boundary, not a configuration knob.
 */
export const GH_TIMEOUT_MS = 2 * 60_000;

/**
 * Read a stream to the end, with a way to give up on it.
 *
 * Keep the reader so the deadline can cancel it; `Response.text()` does not
 * expose its reader. A descendant can keep a killed process's pipes open.
 * Cancellation discards buffered output that the caller will no longer use.
 */
function readText(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  let chunks: Uint8Array[] | null = [];
  const text = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || chunks === null) break;
      chunks.push(value);
    }
    // Avoid allocating a combined buffer for output discarded after a timeout.
    return chunks === null ? "" : new TextDecoder().decode(Buffer.concat(chunks));
  })();
  return {
    text,
    cancel: () => {
      chunks = null;
      void reader.cancel().catch(() => {});
    },
  };
}

/**
 * @param env The environment `gh` runs in. `GH_TOKEN` can override stored
 * credentials, while `GH_CONFIG_DIR` selects which stored configuration it
 * reads. The environment can therefore decide which account `gh` uses, which
 * is why `service install` checks the one launchd will supply.
 * @param timeoutMs A test seam. Production never passes it; `GH_TIMEOUT_MS`
 * says why it is not a setting.
 */
export function createGh(
  bin = "gh",
  env: Record<string, string | undefined> = process.env,
  timeoutMs = GH_TIMEOUT_MS,
): Gh {
  const text = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // `gh_bin` may legitimately be a bare `gh`, and `Bun.spawn` resolves one
      // through the PATH it is handed — so this is what decides which `gh`
      // discovery runs, not the shell the reviewer started the runner from.
      env: { ...env, PATH: absolutePath(env.PATH), ...GITHUB_ENV },
    });
    const out = readText(proc.stdout);
    const err = readText(proc.stderr);
    const finished = Promise.all([out.text, err.text, proc.exited]);
    // Race the complete answer: killing the process need not close pipes held
    // by a descendant (see docs/experiments.md). Cancel reads without awaiting
    // cleanup, so the caller's deadline does not depend on it.
    // SIGKILL stops even a gh_bin wrapper that ignores SIGTERM. Descendants are
    // left alone: a separate process group would also require signal forwarding
    // because terminal signals would no longer reach gh directly.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        proc.kill("SIGKILL");
        out.cancel();
        err.cancel();
        reject(new GhError(args, null, `no answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      deadline.unref();
    });
    const [stdout, stderr, exitCode] = await Promise.race([finished, expired]).finally(() =>
      clearTimeout(deadline),
    );
    // Name the signal when `gh` produced no diagnostic of its own.
    // Trimmed, not merely non-empty: a wrapper that writes a newline and is
    // then signalled would otherwise win this test with stderr that `GhError`
    // trims away again, leaving the one failure a bare exit code cannot explain
    // with nothing at all to explain it.
    const reason = stderr.trim() || (proc.signalCode ? `ended by ${proc.signalCode}` : "");
    if (exitCode !== 0) throw new GhError(args, exitCode, reason);
    return stdout;
  };

  return {
    text,
    json: async <T,>(args: string[]): Promise<T> => {
      const out = await text(args);
      try {
        return JSON.parse(out) as T;
      } catch {
        // Keep unusable `gh` output inside the recoverable boundary; a bare
        // `SyntaxError` is treated as a local fault. Cap the detail for logs.
        throw new GhError(args, 0, `expected JSON, got: ${out.slice(0, 200)}`);
      }
    },
    login: async () => (await text(["api", "user", "--jq", ".login"])).trim(),
  };
}
