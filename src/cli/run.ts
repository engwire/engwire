/**
 * @file `engwire run` — the runner itself.
 */

import { skillPreflightProblem } from "../claude/skills.ts";
import { loadConfig, type Config } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { cloneUrl } from "../git/repository.ts";
import { createGh, GhAnswerError, GhError, looksLikeLogin, type Gh } from "../github/gh.ts";
import type { Runtime } from "../review/execute.ts";
import { runLoop, sleep, tickOnce } from "../review/loop.ts";
import { acquireLock, LockedError } from "../service/lock.ts";
import { Store } from "../store/store.ts";
import { VERSION } from "../version.ts";

/**
 * Retry startup invocation failures at the poll interval so a runner can boot
 * offline. Malformed successful answers and local failures escape; shutdown
 * returns null. Log the outage once while waiting.
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
      // Cancellation of an in-flight call is shutdown, not a GitHub outage.
      if (error instanceof GhError && signal.aborted) return null;
      // A spawn failure or malformed successful answer needs attention, not
      // indefinite retries. A misconfigured gh_bin wrapper is one possible cause.
      if (error instanceof GhAnswerError || !(error instanceof GhError)) throw error;
      if (!reported) {
        log(`waiting for GitHub: ${error.message}`);
        reported = true;
      }
    }
    await sleep(intervalMs, signal);
  }
  return null;
}

/**
 * The rules a runner is allowed to act on, or the refusal.
 *
 * Refusing rather than starting is deliberate: dismissals are permanent, so a
 * runner with no rules would quietly record every outstanding request as
 * `no_automation` and never reconsider it.
 */
function usable(config: Config, configFile: string): boolean {
  if (config.reviews.length > 0) return true;
  console.error(`No [[review]] rules in ${configFile}. Add one naming the repositories to review.`);
  return false;
}

export async function run(options: { once: boolean }): Promise<number> {
  const p = paths();
  // Read twice, and the second one is the one that authorizes work.
  //
  // This first read is side-effect-free refusal: a missing or broken config
  // fails here without creating a data directory or a lock, which is what keeps
  // a kept supervisor job from rebuilding an installation somebody removed.
  if (!usable(await loadConfig(p.configFile), p.configFile)) return 1;

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
    // The authoritative read, under the lock. `engwire uninstall` holds this
    // same lock while it removes the configuration — config first, precisely so
    // a runner cannot get past this line — so a snapshot taken before the lock
    // must not be what a review runs on. Without it, a runner that read a good
    // config, lost the race for the lock, and resumed afterwards would review
    // on behalf of an installation that is gone.
    const config = await loadConfig(p.configFile);
    if (!usable(config, p.configFile)) return 1;
    store = new Store(p.dbFile);
    // Interrupt in-flight calls too, including the identity check immediately
    // before the agent starts; otherwise shutdown waits for gh's deadline.
    const gh = createGh(config.advanced.ghBin, { signal: controller.signal });
    // Before GitHub is consulted, because none of it needs GitHub and all of it
    // is about this process starting. Waiting first would mean a runner that
    // booted offline began watching whenever the network returned — losing
    // every request made in between — while `status` showed the previous
    // process's pid and a crashed run stayed `running`.
    const startedAt = new Date();
    store.recordRunner({
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      version: VERSION,
    });
    // Pass the exact start time so the returned watermark can identify the
    // first runner. Announce it beside the write: GitHub may remain unreachable
    // long afterwards, but requests made from this boundary are eligible.
    if (store.watchingSince(startedAt) === startedAt.toISOString()) {
      log("watching from now — review requests made earlier are not reviewed");
    }
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
      // No `gh auth switch` can match an owner that is not an account, and the
      // binding is written once and never moved, so the advice below it would
      // name a command nobody can run. Only reachable for a database already
      // holding such an owner: `gh.login()` refuses that answer now.
      if (!looksLikeLogin(owner)) {
        console.error(
          `This Engwire installation is bound to ${JSON.stringify(owner)}, which is not a GitHub account, so nothing can ever match it.`,
        );
        console.error(
          "Point ENGWIRE_HOME at a fresh installation, or remove this one with `engwire uninstall --yes`.",
        );
        return 1;
      }
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

    // Before either mode, because "it ran and found nothing" and "it never ran"
    // are the same silence, and `run --once` is the command someone types to
    // tell those apart.
    runtime.log(
      options.once
        ? `engwire ${VERSION} polling once for ${login}`
        : `engwire ${VERSION} watching review requests for ${login}`,
    );

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

    await runLoop(runtime);
    runtime.log("stopped");
    return shutdownCode;
  } catch (error) {
    // In-flight gh cancellation rejects before the between-step checks,
    // especially in --once. Preserve 130/143 on shutdown, even if an independent
    // gh failure coincides with it; ordinary outages and local errors still fail.
    if (error instanceof GhError && controller.signal.aborted) return shutdownCode;
    throw error;
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
