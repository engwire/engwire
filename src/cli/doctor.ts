/**
 * @file `engwire doctor` — check the things that actually break.
 *
 * The bar for a ✓ is "this would work right now", not "a string is set". A
 * stale absolute path in `config.toml` is the most likely failure on a machine
 * that has been reinstalled, and reporting it green would send the reviewer
 * looking anywhere else. `service install` runs the same checks before wiring
 * up a background process nobody will be watching interactively.
 */

import { loadConfig, type Config } from "../config/config.ts";
import { absolutePath, paths } from "../config/paths.ts";
import { agentPath, SETTING_SOURCES } from "../claude/run.ts";
import { skillPreflightProblem } from "../claude/skills.ts";
import { accessSync, constants, mkdirSync } from "node:fs";
import { createGh, GITHUB_ENV } from "../github/gh.ts";
import { Store } from "../store/store.ts";

type Check = { label: string; ok: boolean; note: string };

/**
 * @param env The environment the checked tools should run in. Defaults to this
 * process's; `service install` passes the one `serviceEnvironment()` builds.
 */
export async function diagnose(
  env: Record<string, string | undefined> = process.env,
  options: { requireReviewRules?: boolean } = {},
): Promise<Check[]> {
  // Resolved from the same environment the tools will run in: `ENGWIRE_HOME`
  // and the XDG variables decide which config file this is even talking about.
  const p = paths(env);
  const checks: Check[] = [];

  let config: Config | null = null;
  if (await Bun.file(p.configFile).exists()) {
    try {
      config = await loadConfig(p.configFile);
      // A config with no rules is fatal for a runner and expected right after
      // `setup`, which writes one deliberately. Whether it counts is the
      // caller's question, not this one's.
      const rules = config.reviews.length;
      checks.push({
        label: "config",
        ok: rules > 0 || options.requireReviewRules === false,
        note:
          rules > 0
            ? `${rules} rule(s) in ${p.configFile}`
            : `no [[review]] rules in ${p.configFile} — nothing will be reviewed`,
      });
    } catch (error) {
      checks.push({
        label: "config",
        ok: false,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({ label: "config", ok: false, note: "missing — run `engwire setup`" });
  }

  // Looked up on the PATH each program will actually be found through: the
  // environment's own — a service resolves `gh` where launchd will look, not
  // where this shell would — filtered exactly as the code that runs it filters
  // it. A bare `claude` reachable only through a relative PATH entry would
  // otherwise diagnose green and be unfindable during the review. `Bun.which`
  // returns null for an absolute path that is missing or not executable, which
  // is exactly the stale-config case.
  //
  // Two paths, because the runner and the agent have two. The runner finds
  // `gh` and `git` through `absolutePath`; the agent additionally gets an
  // absolute `gh_bin`'s directory, which is what `runClaude` hands it. Judging
  // everything by the agent's path would pass a `git` that exists only beside
  // the configured `gh` and that no checkout will ever find.
  const ghName = config?.advanced.ghBin ?? "gh";
  const runnerWhere = { PATH: absolutePath(env.PATH ?? "") };
  const agentWhere = { PATH: agentPath(ghName, env.PATH ?? "") };
  // The filtered path goes down with the spawn too, not only into the lookup.
  // An absolute binary can still be a script, and `#!/usr/bin/env node` hands
  // the interpreter back to PATH — measured: with `.` on the child's path,
  // `env` runs the working directory's file. `doctor` is a command someone
  // types, so that directory can be the checkout under review, and probing a
  // setup must not be a way to execute it.
  const runnerEnv = { ...env, PATH: runnerWhere.PATH };
  const agentEnv = { ...env, PATH: agentWhere.PATH };
  const ghBin = Bun.which(ghName, runnerWhere);
  let account: string | null = null;
  if (ghBin) {
    const gh = await ghChecks(ghBin, runnerEnv);
    account = gh.login;
    checks.push(...gh.checks);
  } else {
    checks.push({
      label: "gh",
      ok: false,
      note: notFound(ghName, "https://cli.github.com", p.configFile),
    });
  }

  const claudeName = config?.advanced.claudeBin ?? "claude";
  const claudeBin = Bun.which(claudeName, agentWhere);
  if (claudeBin) {
    checks.push(...(await claudeChecks(claudeBin, agentEnv)));
  } else {
    checks.push({
      label: "claude",
      ok: false,
      note: notFound(claudeName, "https://claude.com/claude-code", p.configFile),
    });
  }

  // Every distinct skill the rules name, in rule order. A review *is* the
  // skill, and a skill Claude will not run is the one failure the review cannot
  // report: every version of it exits 0, which Engwire records as completed.
  //
  // A ✓ here says what was checked and no more. Nothing outside the file can be
  // seen from here — `skillOverrides: "off"` in the reviewer's settings
  // disables a skill that passes this — so the green note names the file it
  // found rather than promising a review will run.
  for (const skill of new Set(config?.reviews.map((rule) => rule.skill) ?? [])) {
    const problem = skillPreflightProblem(skill, env);
    checks.push({
      label: "skill",
      ok: problem === null,
      note: problem ? `${skill} — ${problem}` : `${skill} — SKILL.md found`,
    });
  }

  // Engwire clones and checks out with the system `git`; a missing one fails
  // every review at the same point, well after the reviewer has stopped
  // watching.
  const gitBin = Bun.which("git", runnerWhere);
  checks.push(
    gitBin
      ? { label: "git", ok: true, note: gitBin }
      : { label: "git", ok: false, note: "not found on PATH" },
  );

  // The runner refuses to start under an account that does not own the queue,
  // so a green report from a different account would be approving a service
  // that cannot run. Read-only: `doctor` reports, it does not claim.
  if (await Bun.file(p.dbFile).exists()) {
    const store = new Store(p.dbFile);
    try {
      const owner = store.reviewerLogin();
      // Only when `gh` actually answered. The bar for a ✓ is "this would work
      // right now", and an unreachable or unfindable `gh` leaves nothing to
      // compare the owner against — the red `gh` row above already says why,
      // and a green tick beside it would contradict it.
      if (owner && account !== null) {
        const matches = account === owner;
        checks.push({
          label: "account",
          ok: matches,
          note: matches
            ? owner
            : `this installation belongs to ${owner}, but gh is ${account} — run \`gh auth switch --user ${owner}\`, or point ENGWIRE_HOME at a separate installation`,
        });
      }
    } finally {
      store.close();
    }
  }

  // Created and tested, not merely named. `XDG_DATA_HOME` can point somewhere
  // Engwire cannot write while everything else reports green, and the runner
  // would then die making its database — under launchd, once a second until
  // throttling. The directory is Engwire's own, so creating it here costs
  // nothing that `engwire run` would not create moments later.
  try {
    mkdirSync(p.dataDir, { recursive: true, mode: 0o700 });
    accessSync(p.dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
    checks.push({ label: "data", ok: true, note: p.dataDir });
  } catch (error) {
    checks.push({
      label: "data",
      ok: false,
      note: `${p.dataDir} — ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return checks;
}

export async function doctor(): Promise<number> {
  const checks = await diagnose();
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(11)} ${check.note}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

/**
 * "Not signed in" and "GitHub is unreachable" are different problems.
 *
 * `gh auth status` answers the first from stored credentials; `gh api user`
 * answers the second, and identifies the account. Reporting a network failure
 * as a login problem sends the operator to fix something that is not broken.
 */
async function ghChecks(
  bin: string,
  env: Record<string, string | undefined>,
): Promise<{ checks: Check[]; login: string | null }> {
  const auth = await capture(bin, ["auth", "status"], env);
  if (!auth.ok) {
    return {
      checks: [{ label: "gh", ok: false, note: "not authenticated — run `gh auth login`" }],
      login: null,
    };
  }
  try {
    const login = await createGh(bin, env).login();
    return {
      checks: [{ label: "gh", ok: true, note: `authenticated as ${login} (${bin})` }],
      login,
    };
  } catch (error) {
    return {
      checks: [
        {
          label: "gh",
          ok: false,
          note: `signed in, but GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      login: null,
    };
  }
}

const NOT_A_SOURCE = "not-a-setting-source";

/**
 * Locating `claude` is not the same as being able to review with it.
 *
 * Beyond existence, Claude must validate the setting-source flag and be signed
 * in. Validation checks the interface, not its semantics; the latter is the
 * experiment recorded in `docs/experiments.md`. The auth probe carries the flag
 * too because `doctor` may be run from an untrusted checkout.
 */
async function claudeChecks(
  bin: string,
  env: Record<string, string | undefined>,
): Promise<Check[]> {
  // `--version` tolerates unknown flags and their values, so success alone does
  // not prove this flag exists. Requiring an invalid value to fail does. Read
  // only exit codes so a reworded diagnostic does not break the runner.
  const version = await capture(bin, [...SETTING_SOURCES, "--version"], env);
  const refusal = await capture(bin, ["--setting-sources", NOT_A_SOURCE, "--version"], env);
  const validatesSettingSources = version.ok && !refusal.ok;
  const auth = await capture(bin, [...SETTING_SOURCES, "auth", "status"], env);

  return [
    {
      label: "claude",
      ok: validatesSettingSources,
      note: validatesSettingSources
        ? `${version.stdout.trim() || "installed"} (${bin})`
        : `could not confirm ${bin} still validates --setting-sources, which is how Engwire keeps a pull request's own Claude configuration out of the review — check or update Claude Code`,
    },
    {
      label: "claude auth",
      ok: auth.ok,
      note: auth.ok ? "signed in" : "not signed in — run `claude auth login`",
    },
  ];
}

async function capture(
  bin: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      stdin: "ignore",
      stdout: "pipe",
      // Only stdout is read, and an unread pipe is a child that blocks once it
      // fills.
      stderr: "ignore",
      env: { ...env, ...GITHUB_ENV },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** `configFile` comes from the caller's environment, which may not be this one. */
function notFound(name: string, url: string, configFile: string): string {
  return name.includes("/")
    ? `${name} is not an executable — fix it in ${configFile}`
    : `not found — see ${url}`;
}
