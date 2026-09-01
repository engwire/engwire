/**
 * @file `engwire run` — the runner itself.
 */

import { skillPreflightProblem } from "../claude/skills.ts";
import { loadConfig } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { cloneUrl } from "../git/repository.ts";
import { createGh, GhError, type Gh } from "../github/gh.ts";
import type { Runtime } from "../review/execute.ts";
import { runLoop, sleep, tickOnce } from "../review/loop.ts";
import { acquireLock, LockedError } from "../service/lock.ts";
import { Store } from "../store/store.ts";
import { VERSION } from "../version.ts";

/**
 * Resolve the GitHub account, waiting rather than exiting.
 *
 * A laptop that boots without a network would otherwise take the runner down
 * before the polling loop — which handles exactly this failure gracefully —
 * exists at all, and launchd would restart it into the same wall until it
 * throttled. Inside the loop a GitHub outage is a logged tick; it should not be
 * fatal ten lines earlier. Returns null if shutdown was requested while waiting.
 */
async function waitForLogin(
  gh: Gh,
  intervalMs: number,
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<string | null> {
  let reported = false;
  while (!signal.aborted) {
    try {
      return await gh.login();
    } catch (error) {
      // Only a failed `gh` invocation is worth waiting out. A `gh` that cannot
      // be spawned at all is a misconfigured path, and retrying it once a
      // minute forever would hide that behind "waiting for GitHub".
      if (!(error instanceof GhError)) throw error;
      if (!reported) {
        log(`waiting for GitHub: ${error.message}`);
        reported = true;
      }
    }
    await sleep(intervalMs, signal);
  }
  return null;
}

export async function run(options: { once: boolean }): Promise<number> {
  const p = paths();
  const config = await loadConfig(p.configFile);

  // Refusing here rather than starting is deliberate: dismissals are permanent,
  // so a runner with no rules would quietly record every outstanding request as
  // `no_automation` and never reconsider it.
  if (config.reviews.length === 0) {
    console.error(
      `No [[review]] rules in ${p.configFile}. Add one naming the repositories to review.`,
    );
    return 1;
  }

  let release: () => void;
  try {
    release = acquireLock(p.lockFile);
  } catch (error) {
    if (error instanceof LockedError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

  const controller = new AbortController();
  /**
   * The first signal wins, and takes these handlers with it: `runClaude`
   * re-raises the signal it forwarded once the review's process group is gone,
   * and nothing may still be catching it by then. What is left is the shell's
   * 128 + signal number, because exiting 0 would say the run finished.
   */
  let shutdownCode = 0;
  const stop = (signal: NodeJS.Signals) => {
    shutdownCode ||= signal === "SIGINT" ? 130 : 143;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Opening the database is inside the try, not before it: it can fail on a
  // database this process cannot read, and `run` returns to a caller — one that
  // caught the error would hold the runner lock for the life of the process.
  let store: Store | null = null;
  try {
    store = new Store(p.dbFile);
    const gh = createGh(config.advanced.ghBin);
    // Before GitHub is consulted, because none of it needs GitHub and all of it
    // is about this process starting. Waiting first would mean a runner that
    // booted offline began watching whenever the network returned — losing
    // every request made in between — while `status` showed the previous
    // process's pid and a crashed run stayed `running`.
    store.recordRunner({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: VERSION,
    });
    // Reached only after the config was found to have rules, which is what
    // makes this the moment watching begins.
    store.watchingSince();
    // Once, here, where "this process just started" is known. Anything the
    // database still calls `running` belongs to a runner that is gone.
    store.recoverInterrupted(
      new Date(Date.now() + config.advanced.worktreeTtlMs).toISOString(),
    );

    const login = options.once
      ? await gh.login()
      : await waitForLogin(gh, config.advanced.pollIntervalMs, controller.signal, log);
    if (login === null) return shutdownCode;
    // Ctrl-C during the login call: `runLoop` would notice, `--once` would not.
    if (controller.signal.aborted) return shutdownCode;

    const owner = store.bindReviewer(login);
    if (owner !== login) {
      console.error(
        `This Engwire installation watches review requests for ${owner}, but gh is authenticated as ${login}.`,
      );
      console.error(
        `Switch back with \`gh auth switch --user ${owner}\`, or point ENGWIRE_HOME at a separate installation.`,
      );
      return 1;
    }

    const runtime: Runtime = {
      store,
      config,
      paths: p,
      gh,
      login,
      log,
      cloneUrlFor: cloneUrl,
      signal: controller.signal,
    };

    if (options.once) {
      await tickOnce(runtime);
      if (shutdownCode) return shutdownCode;
      // Exit status is an API. The loop holds a repository whose skill Claude
      // will not run and keeps the request queued, which is right for a daemon
      // — launchd would restart an exiting one into the same wall — but a
      // foreground run that reviewed nothing because the setup is broken has
      // not succeeded, and this is the command someone runs to find out.
      let ok = true;
      for (const skill of new Set(config.reviews.map((rule) => rule.skill))) {
        const problem = skillPreflightProblem(skill);
        if (!problem) continue;
        console.error(`review skill ${skill}: ${problem}`);
        ok = false;
      }
      return ok ? 0 : 1;
    }

    runtime.log(`engwire ${VERSION} watching review requests for ${runtime.login}`);
    await runLoop(runtime);
    runtime.log("stopped");
    return shutdownCode;
  } finally {
    // Removed on every path, not only the signalled one: `run` returns to a
    // caller, and a listener left behind would catch a signal meant for
    // whatever runs next.
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // The lock is the runner's claim on this installation; releasing it is what
    // must happen even if closing the database does not.
    try {
      store?.close();
    } finally {
      release();
    }
  }
}
