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
import { readText } from "../read-text.ts";

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    /**
     * `null` when no exit status is the authoritative account of what happened:
     * a deadline, a caller's shutdown, or a read that failed. The process may
     * well have exited — the point is that its status is not the answer.
     */
    readonly exitCode: number | null,
    /** `gh`'s stderr or Engwire's own failure detail. */
    readonly detail: string,
  ) {
    const how = exitCode === null ? "" : ` (exit ${exitCode})`;
    super(`gh ${args.join(" ")} failed${how}: ${detail.trim()}`);
    this.name = "GhError";
  }
}

/**
 * A successful process exit with unusable JSON or login output.
 *
 * Remains a `GhError` so polling can hold work, but lets startup and diagnostics
 * distinguish a malformed answer from a failed request. A misconfigured
 * `gh_bin` wrapper is one possible cause; the output alone cannot establish it.
 */
export class GhAnswerError extends GhError {
  constructor(args: readonly string[], detail: string) {
    super(args, 0, detail);
    this.name = "GhAnswerError";
  }
}

/**
 * Reject empty, whitespace-bearing, control/format-character and JSON-shaped
 * answers before they can become the installation's persistent identity.
 *
 * This is a shape filter, not GitHub username validation: app identities such
 * as `engwire-agent[bot]` must pass, so only a leading `[` is rejected. A bad
 * acceptance can bind the installation to an identity that matches no review
 * requests; a refusal produces an actionable error instead.
 *
 * Plausible words such as `null`, or another account's name, still pass. This
 * boundary cannot establish that the reported identity is authentic.
 */
export function looksLikeLogin(value: string): boolean {
  return (
    value !== "" &&
    !/[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069{}":,]/.test(value) &&
    !value.startsWith("[")
  );
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
 * A paginated call can make many requests, so two minutes is deliberately
 * generous. It is a failure boundary, not a configuration knob — nothing a
 * reviewer sets reaches it.
 *
 * The default rather than the only value: `doctor` hands its own, shorter one
 * down, because a command somebody is sitting and watching should not spend two
 * minutes on a request that is never going to answer. The poll keeps this one.
 */
export const GH_TIMEOUT_MS = 2 * 60_000;

/**
 * @param options.env The environment `gh` runs in. `GH_TOKEN` can override stored
 * credentials, while `GH_CONFIG_DIR` selects which stored configuration it
 * reads. The environment can therefore decide which account `gh` uses, which
 * is why `service install` checks the one launchd will supply.
 *
 * @param options.timeoutMs Overrides `GH_TIMEOUT_MS` for one client. Not a
 * setting — `GH_TIMEOUT_MS` says why — but not test-only either: `doctor`
 * passes its probe deadline so a watched command answers on its own terms
 * rather than the poll's.
 *
 * @param options.signal Ends a call early. It belongs to the client rather than
 * to each invocation because there is one of each: one `gh` per runner, one
 * shutdown per process. `git` takes its signal per call because it has no such
 * client to hang it on.
 *
 * Optional, where `git`'s is required, because the deadline above already
 * bounds every call — omitting this cannot produce a `gh` that runs forever,
 * only one that cannot be hurried. `cli/run.ts` says what hurrying one buys.
 */
export function createGh(
  bin = "gh",
  options: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Gh {
  const { env = process.env, timeoutMs = GH_TIMEOUT_MS, signal } = options;
  const text = async (args: string[]): Promise<string> => {
    // Refused rather than started, for the reason `git` refuses one: a listener
    // added to an already-aborted signal never fires, so this would spawn a
    // `gh` that nothing is left to hurry and then wait out the whole deadline.
    if (signal?.aborted) throw new GhError(args, null, "stopped before it started");
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
    // Race the complete answer: killing the process need not close pipes held
    // by a descendant (see docs/experiments.md). Cancel reads without awaiting
    // cleanup, so the caller's deadline does not depend on it.
    // SIGKILL stops even a gh_bin wrapper that ignores SIGTERM. Descendants are
    // left alone: a separate process group would also require signal forwarding
    // because terminal signals would no longer reach gh directly.
    // One way to give up, reached by the deadline, by the caller, or by a read
    // that fails. They differ only in what to call it afterwards: the process is
    // killed and the reads are cancelled the same way in every case. A second
    // call is harmless — the kill and the cancels are idempotent, and the first
    // caller's reason is the one that survives.
    const abandoned = Promise.withResolvers<never>();
    const abandon = (detail: string) => {
      proc.kill("SIGKILL");
      out.cancel();
      err.cancel();
      abandoned.reject(new GhError(args, null, detail));
    };
    // A read can reject rather than end, and that is the one way out of the race
    // that leaves `gh` running with its deadline about to be cleared — and it
    // leaves as a bare stream error, which `runLoop` and `accountMatches` both
    // read as a local fault and take the runner down for. It is another way of
    // not getting an answer, so it becomes one. Defensive rather than observed:
    // a subprocess stream ends cleanly even when the process is killed under it.
    const finished = Promise.all([out.text, err.text, proc.exited]).catch(
      (error: unknown): Promise<never> => {
        abandon(`could not read the answer: ${error instanceof Error ? error.message : error}`);
        return abandoned.promise;
      },
    );
    const deadline = setTimeout(() => abandon(`no answer within ${timeoutMs / 1000}s`), timeoutMs);
    deadline.unref();
    const stopped = () => abandon("stopped before it answered");
    signal?.addEventListener("abort", stopped);
    const [stdout, stderr, exitCode] = await Promise.race([
      finished,
      abandoned.promise,
    ]).finally(() => {
      clearTimeout(deadline);
      // Always, not only when it fired. The signal belongs to the runner and
      // outlives every call made with it, so a listener left behind here is one
      // per `gh` invocation for the life of the process — two or three a poll,
      // a minute apart, forever.
      signal?.removeEventListener("abort", stopped);
    });
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
        throw new GhAnswerError(args, `expected JSON, got: ${out.slice(0, 200)}`);
      }
    },
    /**
     * The account `gh` is acting as.
     *
     * An answer has to look like a login, because everything downstream treats
     * this as an identity rather than as a string: it is written to the
     * database once and never changed, discovery matches it against
     * `requested_reviewer.login`, and the runner refuses to start under any
     * other account. An empty one — a `gh_bin` wrapper that exits 0 saying
     * nothing — was recorded as the installation's owner, matched no reviewer
     * so nothing was ever reviewed, and then failed the next run's insert on
     * the primary key: a silent installation that could not be started again
     * even once `gh` was working.
     */
    login: async () => {
      const args = ["api", "user", "--jq", ".login"];
      const answer = (await text(args)).trim();
      if (!looksLikeLogin(answer)) {
        throw new GhAnswerError(args, `expected a GitHub login, got ${JSON.stringify(answer)}`);
      }
      return answer;
    },
  };
}
