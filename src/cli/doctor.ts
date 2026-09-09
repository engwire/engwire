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
import { absolutePath, locationProblem, paths, privateDir } from "../config/paths.ts";
import { agentPath, claudeEnvironment, SETTING_SOURCES } from "../claude/run.ts";
import { claudeRootProblem, skillFile, skillPreflightProblem } from "../claude/skills.ts";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createGh, ghConfigProblem, GhAnswerError, GITHUB_ENV, looksLikeLogin } from "../github/gh.ts";
import { withoutStartupCodeVariables, zshStartupProblem } from "../environment.ts";
import { gitEnvironment } from "../git/environment.ts";
import { readText } from "../read-text.ts";
import { installedPlist, type InstalledPlist } from "../service/launchd.ts";
import { Store } from "../store/store.ts";
import { VERSION } from "../version.ts";

type Check = { label: string; ok: boolean; note: string };

/**
 * @param env The environment the checked tools should run in. Defaults to this
 * process's; `service install` passes the one `serviceEnvironment()` builds.
 */
export async function diagnose(
  env: Record<string, string | undefined> = process.env,
  options: { requireReviewRules?: boolean; probeTimeoutMs?: number } = {},
): Promise<Check[]> {
  // A test seam: production never passes it. `createGh`'s `timeoutMs` is not
  // one — this is what production hands it. The constant on `PROBE_TIMEOUT_MS`
  // says why neither is a setting.
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  // Resolved from the same environment the tools will run in: `ENGWIRE_HOME`
  // and the XDG variables decide which config file this is even talking about.
  //
  // A relative one ends the diagnosis rather than joining it: every check below
  // is about a path this could not work out, starting with which config file it
  // is even talking about. `service install` runs this against the environment
  // launchd will supply, so this also refuses to approve a job that would keep
  // its installation wherever launchd happened to start it.
  const misplaced = locationProblem(env);
  // The version rides along even here — especially here. The row below carries
  // it because "which Engwire is diagnosing" is what a bug report opens with,
  // and an installation with no address is exactly the state one gets filed
  // from; it would otherwise be the one report that arrives without a version.
  if (misplaced) return [{ label: "engwire", ok: false, note: `${VERSION} — ${misplaced}` }];
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
  // The same environment `runClaude` builds, for the same reason: the loader
  // and interpreter selectors it drops are read before `claude` runs a line of
  // its own, so `claude --version` from the wrong directory is the whole attack
  // rather than a weaker version of it. `runClaude`'s gh and git pins are not
  // here — this probes an installation, it does not review with one.
  const agentEnv = { ...claudeEnvironment(env), PATH: agentWhere.PATH };
  const ghBin = Bun.which(ghName, runnerWhere);
  const claudeName = config?.advanced.claudeBin ?? "claude";
  const claudeBin = Bun.which(claudeName, agentWhere);

  const gitBin = Bun.which("git", runnerWhere);

  // Check roots before spawning. Any configured binary may be a zsh wrapper,
  // so an unsafe zsh startup root blocks every probe, including --version.
  // An unsafe gh root blocks its probes to avoid reading checkout credentials.
  const ghConfigIssue = ghBin === null ? null : ghConfigProblem(env);
  const zshStartup = zshStartupProblem(env);
  // Claude's own root joins them for the same reason, one step weaker. Nothing
  // here establishes that a relative `CLAUDE_CONFIG_DIR` runs a checkout's
  // code — what is established is that `--setting-sources user` makes that root
  // the scope Claude reads, and that Engwire already calls a relative one a
  // root it cannot reason about. Probing through a root this report is about to
  // mark unusable is the part that has no defence.
  const claudeRootIssue = claudeRootProblem(env);

  // Independent tool checks run concurrently; rows retain their display order.
  // Each tool chains its own probes, so the total wait is bounded by the
  // longest chain (up to four gh probes), not by a single probe deadline.
  const [gh, claudeRows, gitProblem] = await Promise.all([
    ghBin && ghConfigIssue === null && zshStartup === null
      ? // The host pin travels with the probes it belongs to, exactly as
        // `createGh` carries it for every `gh` the runner starts. Neither the
        // Claude nor the git probe gets it, because neither is given one in
        // production.
        ghProbes(ghBin, { ...runnerEnv, ...GITHUB_ENV }, probeTimeoutMs)
      : null,
    claudeBin && claudeRootIssue === null && zshStartup === null
      ? claudeChecks(claudeBin, agentEnv, probeTimeoutMs)
      : null,
    gitBin && zshStartup === null
      ? gitStartProblem(gitBin, { ...gitEnvironment(env), PATH: runnerWhere.PATH }, probeTimeoutMs)
      : null,
  ]);

  const account = gh?.login ?? null;
  const latest = gh?.latest ?? null;
  if (gh) {
    checks.push(...gh.checks);
  } else {
    checks.push({
      label: "gh",
      ok: false,
      // `ghConfigIssue` is null whenever the binary is missing, so the errand this
      // sends someone on is always the one that comes first.
      note: ghConfigIssue ?? (ghBin ? NOT_PROBED : notFound(ghName, "https://cli.github.com", p.configFile)),
    });
  }

  // Before the rows that depend on it, and unconditionally: everything Engwire
  // knows about a skill it reads from under this root, and until a `[[review]]`
  // rule names one nothing else looks at it at all — so a fresh `setup` used to
  // report a clean bill of health and then fall over listing the skills.
  //
  // A ✓ promises only that the root is a path Engwire can inspect from a fixed
  // place. Whether Claude reads the same one, and what it does with a relative
  // root of its own, is not measured here.
  checks.push({
    label: "claude root",
    ok: claudeRootIssue === null,
    note: claudeRootIssue ?? `a rule's skill is read from ${skillFile("<name>", env)}`,
  });

  checks.push({
    label: "zsh startup",
    ok: zshStartup === null,
    note: zshStartup ?? "no relative zsh startup directory reaches a program Engwire starts",
  });

  if (claudeRows) {
    checks.push(...claudeRows);
  } else {
    checks.push({
      label: "claude",
      ok: false,
      note: !claudeBin
        ? notFound(claudeName, "https://claude.com/claude-code", p.configFile)
        : claudeRootIssue !== null
          ? "found, but not run — the claude root above is not one this report can reason about, and it is the scope `--setting-sources user` reads"
          : NOT_PROBED,
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
  // A row that only restates the root above is dropped rather than repeated
  // once per rule — but the check is what it reports, not what it resolves
  // through: a reserved name is refused before the root is ever consulted, so a
  // bad root must not be what hides `skill = "synced"` until the day it is fixed.
  for (const skill of new Set(config?.reviews.map((rule) => rule.skill) ?? [])) {
    const problem = skillPreflightProblem(skill, env);
    if (claudeRootIssue !== null && problem === claudeRootIssue) continue;
    checks.push({
      label: "skill",
      ok: problem === null,
      note: problem ? `${skill} — ${problem}` : `${skill} — SKILL.md found`,
    });
  }

  // Engwire clones and checks out with the system `git`; a missing one fails
  // every review at the same point, well after the reviewer has stopped
  // watching. Found is not the same as runnable, though, and this is the row
  // where the difference bites: Engwire’s Git commands filter ambient
  // `GIT_*` (restoring config-file selectors) and loader/interpreter selectors.
  // A wrapper that needs a stripped variable can work in the shell and fail in every
  // review. A ✓ here would then approve a background service that cannot check
  // anything out.
  checks.push({
    label: "git",
    ok: gitBin !== null && zshStartup === null && gitProblem === null,
    note:
      gitBin === null
        ? "not found on PATH"
        : zshStartup !== null
          ? NOT_PROBED
          : (gitProblem ?? gitBin),
  });

  // Compare the queue owner without changing its binding. A mismatch would
  // make the runner refuse to start, so it must also fail service preflight.
  if (await Bun.file(p.dbFile).exists()) {
    const store = new Store(p.dbFile);
    try {
      // Against `null`, not truthiness. An owner that is not a login is
      // exactly the state worth reporting — and read as falsy it withheld the
      // row entirely, so `doctor` called the installation healthy and approved
      // a `service install` for a runner that refuses to start under it.
      const owner = store.reviewerLogin();
      if (owner !== null && !looksLikeLogin(owner)) {
        // Reported without waiting for `gh` to say who it is, unlike the
        // comparison below: this owner matches no account, so there is nothing
        // to compare it against — and the `gh` that cannot answer is the very
        // thing that wrote it. No `gh auth switch --user ` to offer either;
        // the binding is written once and never moved.
        checks.push({
          label: "account",
          ok: false,
          note: `this installation is bound to ${JSON.stringify(owner)}, which is not a GitHub account, so nothing can ever match it — point ENGWIRE_HOME at a fresh installation, or remove this one with \`engwire uninstall --yes\``,
        });
      } else if (owner !== null && account !== null) {
        // Only when `gh` actually answered. The bar for a ✓ is "this would work
        // right now", and an unreachable or unfindable `gh` leaves nothing to
        // compare the owner against — the red `gh` row above already says why,
        // and a green tick beside it would contradict it.
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
    privateDir(p.dataDir);
    accessSync(p.dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
    checks.push({ label: "data", ok: true, note: p.dataDir });
  } catch (error) {
    checks.push({
      label: "data",
      ok: false,
      note: `${p.dataDir} — ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  // First: which Engwire is diagnosing is the row a bug report opens with. Always
  // a ✓ — an older Engwire works, and `service install` refuses on any failed
  // check, so a release nobody has installed yet must not stop the one they have.
  return [{ label: "engwire", ok: true, note: releaseNote(VERSION, latest) }, ...checks];
}

/**
 * Build the diagnostic row for an installed service plist.
 *
 * Kept out of `diagnose` because `service install` uses that function as its
 * preflight and is about to replace the plist.
 */
export function serviceChecks(service: InstalledPlist): Check[] {
  if (service.whose === "none") return [];
  // Report a foreign plist without making this installation's doctor fail.
  if (service.whose === "theirs") {
    return [
      {
        label: "service",
        ok: true,
        note:
          service.supervises === null
            ? "a service plist is here that does not say which installation it belongs to"
            : `supervises ${service.supervises}, not this installation`,
      },
    ];
  }
  // `Bun.which` also rejects an absolute path that is not executable.
  const ok = Bun.which(service.executable) !== null;
  return [
    {
      label: "service",
      ok,
      note: ok
        ? `runs ${service.executable}`
        : `runs ${service.executable}, which is missing or not executable — run \`engwire service install\` to point it at this one`,
    },
  ];
}

export async function doctor(): Promise<number> {
  // Asked here as well as inside `diagnose`, because the service checks go
  // looking for a plist beside the data directory — and a relative one names a
  // different directory for every shell it is read from, which is the thing
  // being reported rather than somewhere to go looking.
  const misplaced = locationProblem();
  const checks = [
    ...(await diagnose()),
    ...(misplaced ? [] : serviceChecks(installedPlist(paths().dataDir))),
  ];
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(11)} ${check.note}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

/**
 * Release-shaped and nothing else, decided before `Bun.semver.order` sees it:
 * that accepts `1.2` and `v1.0.0` and throws on `alice`, and a doctor row must
 * not nag on any of them.
 */
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * The `engwire` row's note: this version, and the newer release if there is one.
 *
 * Compared as numbers, not strings: "0.10.0" sorts before "0.9.0" as text. The
 * tag's `v` is dropped because a version is what people have in hand;
 * `install.sh` makes the same move. Anything unreadable on either side leaves
 * the version bare rather than nagging on a guess.
 *
 * A source checkout is never "the latest release": it carries the last released
 * number until the next bump while the tree moves on, and ahead of a release it
 * is not behind one. Nor is it told how to install — the installer would replace
 * nothing that is running, and `git pull` is not Engwire's to suggest.
 */
export function releaseNote(
  current: string,
  latestTag: string | null,
  standalone = Bun.isStandaloneExecutable,
): string {
  const latest = (latestTag ?? "").replace(/^v/, "");
  if (!SEMVER.test(current) || !SEMVER.test(latest)) return current;
  const order = Bun.semver.order(latest, current);
  if (order < 0) return current;
  if (order === 0) return standalone ? `${current} — the latest release` : current;
  return `${current} — ${latest} is out${standalone ? `: ${installCommand()}` : ""}`;
}

/**
 * The README's install command, pointed at where this binary actually lives.
 *
 * `install.sh` writes to `~/.local/bin` unless `ENGWIRE_PREFIX` says otherwise,
 * so for a binary installed anywhere else the bare command would leave a second
 * one behind and the old one running, on PATH and in the plist alike. The prefix
 * is spelled out only when it is not the installer's default, so the common case
 * reads exactly as the README does.
 */
export function installCommand(execPath = process.execPath, home = homedir()): string {
  const prefix = dirname(execPath);
  const where = prefix === join(home, ".local", "bin") ? "" : `ENGWIRE_PREFIX=${quoted(prefix)} `;
  return `curl -fsSL https://engwire.com/install.sh | ${where}sh`;
}

/**
 * One shell word, whatever the path has in it.
 *
 * A directory may legitimately contain a quote — `/opt/alice's tools` — and
 * naked, that ends the quoting halfway through and leaves the reader a command
 * their shell refuses. Single quotes take everything literally except the quote
 * itself, so that one character is closed, escaped and reopened, and nothing
 * else needs a rule.
 */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The oldest `gh` whose `api --paginate` Engwire can read.
 *
 * Without `--jq`, `gh` merges paginated responses into one array only from
 * 2.31.0 ([cli/cli#7190]); before that the pages arrive as concatenated JSON
 * documents and a single `JSON.parse` refuses them. Discovery reads every
 * candidate's issue events that way on each poll.
 *
 * A version rather than a probe, unlike the `--setting-sources` check above,
 * because there is nothing to ask offline: the behaviour differs only on a
 * response that actually spans pages. That is also what makes it worth a row —
 * a pull request whose history fits one page parses on either version, so an
 * unsupported `gh` looks healthy right up until somebody's busy pull request,
 * which is the failure a preflight exists to move forward. Measured, with the
 * output of both versions, in docs/experiments.md.
 */
const GH_FLOOR = "2.31.0";

/**
 * `gh version 2.98.0 (2026-08-20)`, and a dev build's `2.40.0-1-gabc` too.
 *
 * The suffix is dropped rather than ordered, which accepts one thing it should
 * not: a prerelease of the floor itself, `2.31.0-rc.1`, precedes 2.31.0 and may
 * not carry the change. Distinguishing that from `2.40.0-1-gabc` — a build
 * *after* its release, and the far likelier one to meet — means guessing which
 * suffix convention produced it, and guessing wrong rejects a working `gh`.
 * A release candidate of one specific June 2023 version is the narrower risk.
 */
const GH_VERSION = /\bgh version (\d+)\.(\d+)\.(\d+)/;

/**
 * What is wrong with this `gh` version, or null.
 *
 * An unreadable version is refused rather than assumed current: the whole point
 * of the row is that the failure it prevents does not show up until it is
 * expensive, and "could not tell" is not evidence that it will not happen.
 */
export function ghVersionProblem(versionOutput: string): string | null {
  const found = GH_VERSION.exec(versionOutput);
  if (!found) {
    return `could not read a version from \`gh --version\`; Engwire needs ${GH_FLOOR} or newer`;
  }
  const version = found.slice(1, 4).join(".");
  if (Bun.semver.order(version, GH_FLOOR) >= 0) return null;
  // Named the way the rows beside it name a missing tool: a preflight that
  // fails without saying where to go is a preflight the reader cannot act on,
  // and this is the one row whose remedy is not `engwire` anything.
  return `${version} is too old — Engwire needs ${GH_FLOOR} or newer, or a busy pull request fails to read its history; see https://cli.github.com`;
}

/**
 * The `gh` rows, plus the release this installation would upgrade to.
 *
 * One function because the two are ordered with respect to each other and not
 * to anything else: the release lookup runs only once GitHub has answered, so
 * that signed out or offline the `gh` row already says why rather than a second
 * row repeating it. `releases/latest` is what `install.sh` fetches
 * (docs/specs/releases.md); a repository with no release yet fails the same way
 * an outage does, and neither is a fact about this installation.
 *
 * On the probe deadline rather than `gh`'s own, which is sized for a paginated
 * call and would let one unreachable request hold a watched command for two
 * minutes.
 */
async function ghProbes(
  bin: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ checks: Check[]; login: string | null; latest: string | null }> {
  const gh = await ghChecks(bin, env, timeoutMs);
  const latest =
    gh.login === null
      ? null
      : await createGh(bin, { env, timeoutMs })
          .text(["api", "repos/engwire/engwire/releases/latest", "--jq", ".tag_name"])
          .then((tag) => tag.trim(), () => null);
  return { ...gh, latest };
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
  timeoutMs: number,
): Promise<{ checks: Check[]; login: string | null }> {
  // Before authentication, because it is a property of the binary rather than
  // of the account, and it stays worth reporting when `gh auth login` is what
  // the reviewer has to do first.
  const versionProbe = await capture(bin, ["--version"], env, timeoutMs);
  // Same rule as the rows below: silence is not an old `gh`. Still a ✗ — the
  // version was not confirmed either way — but "go and install a newer one" is
  // the wrong errand for a binary that never answered, and the likeliest reason
  // `gh --version` wedges is a `gh_bin` wrapper, not the version behind it.
  const versionProblem =
    versionProbe.kind !== "exit"
      ? silence(bin, "--version", versionProbe, timeoutMs)
      : versionProbe.ok
        ? ghVersionProblem(versionProbe.stdout)
        : // A non-zero exit establishes nothing about the version, so the
          // "install a newer one" errand is not this row's to give.
          `\`${bin} --version\` failed`;
  const version: Check[] = versionProblem
    ? [{ label: "gh version", ok: false, note: versionProblem }]
    : [];

  const auth = await capture(bin, ["auth", "status"], env, timeoutMs);
  if (auth.kind !== "exit" || !auth.ok) {
    return {
      checks: [
        ...version,
        {
          label: "gh",
          ok: false,
          // "Run `gh auth login`" is advice only an exit has earned: a probe
          // that timed out, or never started, did not report a signed-out
          // account — it reported nothing. Sending somebody to re-authenticate
          // a working account is the wrong end of a wedged or missing `gh`.
          note:
            auth.kind === "exit"
              ? "not authenticated — run `gh auth login`"
              : silence(bin, "auth status", auth, timeoutMs),
        },
      ],
      login: null,
    };
  }
  try {
    // Same deadline as the probes around it: this reaches the network, and
    // `gh`'s own two minutes would undo every bound the probes just imposed.
    const login = await createGh(bin, { env, timeoutMs }).login();
    return {
      checks: [...version, { label: "gh", ok: true, note: `authenticated as ${login} (${bin})` }],
      login,
    };
  } catch (error) {
    return {
      checks: [
        ...version,
        {
          label: "gh",
          ok: false,
          // The same rule the docblock above states, applied to the third
          // outcome: `auth status` passed and something exited 0, so GitHub is
          // not what is broken. Naming the binary points at the `gh_bin` that
          // answered instead of sending the reviewer to check a working network.
          note:
            error instanceof GhAnswerError
              ? `signed in, but ${bin} did not answer with an account: ${error.detail}`
              : `signed in, but GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
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
  timeoutMs: number,
): Promise<Check[]> {
  // `--version` tolerates unknown flags and their values, so success alone does
  // not prove this flag exists. Requiring an invalid value to fail does. Read
  // only exit codes so a reworded diagnostic does not break the runner.
  const version = await capture(bin, [...SETTING_SOURCES, "--version"], env, timeoutMs);
  const refusal = await capture(bin, ["--setting-sources", NOT_A_SOURCE, "--version"], env, timeoutMs);
  // The refusal probe wants a *failure*, and only an exit is one. A `claude`
  // that vanished between the two calls, or whose output could not be read,
  // produces the same "not ok" as one that correctly rejected the flag — and
  // this is the tick that keeps a pull request's own Claude configuration out of
  // the review, so it must be earned by something the binary actually said.
  const validatesSettingSources =
    version.kind === "exit" && version.ok && refusal.kind === "exit" && !refusal.ok;
  const auth = await capture(bin, [...SETTING_SOURCES, "auth", "status"], env, timeoutMs);
  // Carried with the arguments that produced it: when the *refusal* probe is the
  // one that stalled, reporting `--version` names a call that had just answered.
  const silent: { probe: { kind: "timeout" | "unanswered" }; args: string } | null =
    version.kind !== "exit"
      ? { probe: version, args: SETTING_SOURCES.join(" ") + " --version" }
      : refusal.kind !== "exit"
        ? { probe: refusal, args: `--setting-sources ${NOT_A_SOURCE} --version` }
        : null;

  return [
    {
      label: "claude",
      ok: validatesSettingSources,
      note:
        version.kind === "exit" && validatesSettingSources
          ? `${version.stdout.trim() || "installed"} (${bin})`
          : silent
            ? `${silence(bin, silent.args, silent.probe, timeoutMs)}, so whether it still validates --setting-sources is unknown`
            : `could not confirm ${bin} still validates --setting-sources, which is how Engwire keeps a pull request's own Claude configuration out of the review — check or update Claude Code`,
    },
    {
      label: "claude auth",
      ok: auth.kind === "exit" && auth.ok,
      // Same rule as `gh` above: silence is not a signed-out account.
      note:
        auth.kind !== "exit"
          ? silence(bin, "auth status", auth, timeoutMs)
          : auth.ok
            ? "signed in"
            : "not signed in — run `claude auth login`",
    },
  ];
}

/**
 * Whether the `git` this report found starts at all in the environment Engwire
 * will hand it.
 *
 * Through `gitEnvironment` rather than a copy of it, so there is nothing here
 * to drift out of agreement with the spawn that matters. Not through `git()`
 * itself, which resolves the binary through this process's own PATH: that is
 * the right answer for the runner and the wrong one for a report that may be
 * describing the environment launchd will supply instead of this shell.
 *
 * `--version` because it is the cheapest thing git can be asked that still
 * requires the process to start, which is the whole question.
 */
async function gitStartProblem(
  bin: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string | null> {
  const ran = await capture(bin, ["--version"], env, timeoutMs);
  if (ran.kind === "exit" && ran.ok) return null;
  return ran.kind === "exit"
    ? "found, but it did not run in the environment Engwire starts it in — a wrapper that needs something Engwire strips fails here and in every review"
    : `found, but ${silence(bin, "--version", ran, timeoutMs)}`;
}

/**
 * What a probe that never exited is worth saying, and what it is not worth
 * claiming.
 *
 * "Did not produce a usable answer" rather than "did not run", because
 * `unanswered` is a spawn that never happened *and* a read that broke — and in
 * the second the process may have run perfectly well. The decision is the same
 * either way, so the union keeps them together; the sentence a person reads
 * should not assert the half that was not established.
 */
function silence(bin: string, args: string, probe: { kind: "timeout" | "unanswered" }, timeoutMs: number): string {
  return probe.kind === "timeout"
    ? `\`${bin} ${args}\` did not answer within ${timeoutMs / 1000}s`
    : `\`${bin} ${args}\` did not produce a usable answer`;
}

/** What a row says when the binary was found and deliberately not started. */
const NOT_PROBED =
  "found, but not run — the zsh startup directory is one a working directory could choose, and starting any program can start a shell";

/**
 * How long one probe gets to answer.
 *
 * A failure boundary, not a knob, for the same reason as `gh`'s: what is being
 * asked here is a version, an already-stored credential, or one unpaginated API
 * call, and no answer worth waiting on takes this long. Generous anyway,
 * because some of them reach the network.
 *
 * It bounds the `gh` calls `diagnose` makes through `createGh` as well as the
 * `capture` probes: `GH_TIMEOUT_MS` is sized for a paginated poll that nobody
 * is watching, and one unreachable request under it would hold a command
 * somebody *is* watching for two minutes.
 *
 * `doctor`, `setup` and `service install` all run these, and all three are
 * commands somebody is sitting and watching. Before this they could sit there
 * forever: a wedged `gh` or `claude` was awaited with no deadline at all.
 */
const PROBE_TIMEOUT_MS = 20_000;

/** A read that failed, distinct from the deadline's `null`: not a timeout. */
const UNREADABLE = "unreadable" as const;

/**
 * What one diagnostic probe can come back with.
 *
 * A union rather than flags, because the flags admitted states that cannot
 * happen and every caller had to remember which combination meant what. Three
 * outcomes, and each caller needs a different one of them: the version checks
 * read `stdout`, the authentication checks may only give login advice for an
 * exit that reported a signed-out account, and the setting-sources check wants
 * a *non-zero* exit as the thing it is looking for — so silence must never
 * score as a refusal.
 *
 * `unanswered` covers a spawn that never happened and a read that broke. No
 * caller distinguishes them, and both mean no usable exit result was obtained,
 * even if the process itself exited.
 */
type Probe =
  | { kind: "exit"; ok: boolean; stdout: string }
  | { kind: "timeout" }
  | { kind: "unanswered" };

/**
 * Run one diagnostic probe.
 */
async function capture(
  bin: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Probe> {
  try {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      stdin: "ignore",
      stdout: "pipe",
      // Only stdout is read, and an unread pipe is a child that blocks once it
      // fills.
      stderr: "ignore",
      // Filter startup selectors at the shared boundary for direct probes.
      // Even --version can load code from cwd (see docs/experiments.md).
      // Keep GH_HOST on gh probes only: Git must be checked without a host pin,
      // matching the environment its production boundary supplies.
      env: withoutStartupCodeVariables(env),
    });
    // Held rather than handed to `Response.text()`, which locks the stream and
    // leaves nothing to cancel. Killing a process need not close a pipe a
    // descendant still holds — measured, and `read-text.ts` carries the fact —
    // so every branch below cancels the read rather than awaiting it, and the
    // race is against the deadline rather than against the process.
    const out = readText(proc.stdout);
    const answered = Promise.all([out.text, proc.exited]);
    // `null` as the sentinel: it cannot collide with the tuple the read
    // produces, and it narrows where a plain `symbol` does not.
    //
    // An explicit timer rather than `Bun.sleep`, whose timer is referenced: the
    // loser of this race is never awaited, so one written that way held the
    // runtime for the whole deadline after every row had printed
    // (docs/experiments.md). Both halves are deliberate — `clearTimeout` for the
    // answer that arrives, and `unref` so a path that misses it cannot keep a
    // finished command alive.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), timeoutMs);
      deadline.unref();
    });
    // A failed read is caught here rather than by the outer `catch`, where the
    // process is out of scope and could not be killed.
    const finished = await Promise.race([answered, expired])
      .catch(() => UNREADABLE)
      .finally(() => clearTimeout(deadline));
    if (finished === null || finished === UNREADABLE) {
      proc.kill("SIGKILL");
      out.cancel();
      return finished === null ? { kind: "timeout" } : { kind: "unanswered" };
    }
    const [stdout, exitCode] = finished;
    return { kind: "exit", ok: exitCode === 0, stdout };
  } catch {
    // Only `Bun.spawn` itself, which leaves nothing behind to clean up.
    return { kind: "unanswered" };
  }
}

/** `configFile` comes from the caller's environment, which may not be this one. */
function notFound(name: string, url: string, configFile: string): string {
  return name.includes("/")
    ? `${name} is not an executable — fix it in ${configFile}`
    : `not found — see ${url}`;
}
