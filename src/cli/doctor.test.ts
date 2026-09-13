import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.ts";
import { Store } from "../store/store.ts";
import { installedPlist, plist } from "../service/launchd.ts";
import { VERSION } from "../version.ts";
import { diagnose, installCommand, releaseNote, serviceChecks, ghVersionProblem } from "./doctor.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-doctor-"));
});

afterEach(async () => {
  chmodSync(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

describe("diagnose", () => {
  test("a data directory the runner could not work in is not a green check", async () => {
    // `service install` installs what this report approves, so a green tick has
    // to mean the runner could run. A data root it cannot write is the failure
    // every other check misses: config, gh, claude and git can all be perfect
    // while the runner dies making its database, once a second, forever.
    //
    // An empty `PATH` keeps this to the question being asked: `gh` and `claude`
    // are simply not found, and nothing is spawned.
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);

    const checks = await diagnose({ ENGWIRE_HOME: join(locked, "home"), PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "data")).toMatchObject({ ok: false });
  });

  test("an absolute Claude root reports where a rule's skill is read from", async () => {
    const checks = await diagnose({ ENGWIRE_HOME: join(dir, "home"), PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "claude root")).toMatchObject({
      ok: true,
      note: `a rule's skill is read from ${join(dir, ".claude", "skills", "<name>", "SKILL.md")}`,
    });
  });

  test("a Claude root Engwire cannot inspect is a row, before any rule names a skill", async () => {
    // The state a fresh `setup` leaves behind: a config with no rules yet, so
    // the per-skill rows that used to be the only thing reading this root do
    // not exist. Everything reported clean, and then `setup` fell over listing
    // the skills — after it had already written the config.
    const checks = await diagnose({
      ENGWIRE_HOME: join(dir, "home"),
      PATH: "",
      HOME: dir,
      CLAUDE_CONFIG_DIR: "relative-root",
    });

    expect(checks.find((check) => check.label === "claude root")).toMatchObject({ ok: false });
    // Not an installation-wide refusal, unlike a relative `ENGWIRE_HOME`: what
    // this breaks is skills, and the rest of the report is still worth having.
    expect(checks.find((check) => check.label === "data")).toMatchObject({ ok: true });
  });

  test("a bad root suppresses the per-skill rows rather than repeating itself", async () => {
    const env = {
      ENGWIRE_HOME: join(dir, "home"),
      PATH: "",
      HOME: dir,
      CLAUDE_CONFIG_DIR: "relative-root",
    };
    mkdirSync(join(dir, "home", "config"), { recursive: true });
    writeFileSync(
      paths(env).configFile,
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[[review]]\nrepos = ["other/*"]\nskill = "review-other"\n`,
    );

    const checks = await diagnose(env);

    expect(checks.find((check) => check.label === "claude root")).toMatchObject({ ok: false });
    // Each resolves through the same root, so they would restate one problem
    // once per rule and bury the row that explains it.
    expect(checks.some((check) => check.label === "skill")).toBe(false);
  });

  test("a bad root does not hide a problem that is not the root", async () => {
    // A reserved name is refused before the root is ever consulted, so it is a
    // second problem rather than the same one twice. Suppressed with the rest,
    // it would stay invisible until the root was fixed — and then be a fresh
    // surprise on the run that was supposed to be the fix.
    const env = {
      ENGWIRE_HOME: join(dir, "home"),
      PATH: "",
      HOME: dir,
      CLAUDE_CONFIG_DIR: "relative-root",
    };
    mkdirSync(join(dir, "home", "config"), { recursive: true });
    writeFileSync(
      paths(env).configFile,
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[[review]]\nrepos = ["other/*"]\nskill = "synced"\n`,
    );

    const checks = await diagnose(env);
    const skills = checks.filter((check) => check.label === "skill");

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ ok: false });
    expect(skills[0]?.note).toContain("synced");
    expect(skills[0]?.note).toContain("reserves");
  });

  test("an owner that is not an account is reported, not withheld", async () => {
    // Read as falsy, this row disappeared entirely: `doctor` called the
    // installation healthy and `service install` approved a runner that
    // refuses to start under it. The advice differs too — there is no
    // `gh auth switch --user ""` to offer, and the binding never moves.
    const { home } = tools(MEASURED_CLAUDE);
    mkdirSync(paths({ ENGWIRE_HOME: home }).dataDir, { recursive: true });
    const store = new Store(paths({ ENGWIRE_HOME: home }).dbFile);
    store.bindReviewer("");
    store.close();

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    const account = checks.find((check) => check.label === "account");
    expect(account?.ok).toBe(false);
    expect(account?.note).toContain("not a GitHub account");
    expect(account?.note).not.toContain("gh auth switch");
    // The way out, which is the only actionable half of a row whose subject
    // matches no account. Asserted here as well as in `cli.test.ts`, because
    // this sentence exists twice — `doctor` reports the state and `run`
    // refuses to start under it — and a command renamed in one of them should
    // not be able to go stale in the other.
    expect(account?.note).toContain("engwire uninstall --yes");
  });

  test("an owner that is not an account is reported without a gh to compare it to", async () => {
    // The state this row exists for is the one where `gh` is *also* broken —
    // an empty answer from a `gh_bin` wrapper is what wrote the owner in the
    // first place. Withheld until GitHub answers, the diagnosis would arrive
    // only after the reviewer had already fixed the thing that caused it.
    const { home } = tools(MEASURED_CLAUDE, "#!/bin/sh\nexit 1\n");
    mkdirSync(paths({ ENGWIRE_HOME: home }).dataDir, { recursive: true });
    const store = new Store(paths({ ENGWIRE_HOME: home }).dbFile);
    store.bindReviewer("");
    store.close();

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "account")).toMatchObject({ ok: false });
  });

  test("a gh that answers with something other than an account is not GitHub being unreachable", async () => {
    // `gh auth status` passed and `gh api user` exited 0, so the network is not
    // what is broken: a wrapper answered instead of `gh`. Reported as an
    // outage, this sent the reviewer to check a connection that works.
    const { home } = tools(
      MEASURED_CLAUDE,
      "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; api) ;; *) echo ok ;; esac\n",
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    const gh = checks.find((check) => check.label === "gh");
    expect(gh?.ok).toBe(false);
    expect(gh?.note).toContain("did not answer with an account");
    expect(gh?.note).not.toContain("could not be reached");
  });

  test("the gh, claude and git probes wait together, not one after the other", async () => {
    // The failure that makes `doctor` slow is a connection that accepts and
    // then says nothing — an ordinary captive portal — and it is the failure
    // most likely to affect more than one binary at once. Run in sequence they
    // add up; measured against the production deadline that is 60s rather than
    // 20s, on the one command somebody types *because* something is wrong.
    //
    // Watched rather than timed. Reading concurrency off the *total* is a proxy
    // that charges every spawn in the run to a margin of one deadline, and a
    // loaded machine spends it: at a 1s deadline this took 2.04s and failed
    // while running perfectly concurrently. What the test actually wants to
    // know is whether they were ever wedged at the same moment, so each stub
    // says when it wedges and the assertion is that all three had, which
    // sequential execution cannot produce however slow the machine is.
    //
    // All three, git included. It was added to the `Promise.all` in the same
    // change that gave it a probe, and with only two markers here that could
    // have been moved back out without a test noticing — which is the exact
    // regression the deadline arithmetic above is about.
    const wedged = {
      gh: join(dir, "gh-wedged"),
      claude: join(dir, "claude-wedged"),
      git: join(dir, "git-wedged"),
    };
    const { home } = tools(
      `#!/bin/sh\ncase "$*" in *--version) echo "9.9.9 (Claude Code)" ;; *) : > ${JSON.stringify(wedged.claude)}; ${HANG} ;; esac\n`,
      `#!/bin/sh\ncase "$1" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) : > ${JSON.stringify(wedged.gh)}; ${HANG} ;; esac\n`,
    );
    // git is resolved from PATH rather than from config, so the stub goes where
    // the other two already live and the report is pointed at that directory.
    writeFileSync(join(dir, "tools", "git"), `#!/bin/sh\n: > ${JSON.stringify(wedged.git)}\n${HANG}\n`, { mode: 0o755 });

    const startedAt = Date.now();
    const diagnosing = diagnose(
      { ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir },
      { probeTimeoutMs: PROBE_DEADLINE },
    );

    // Run in turn, the second binary is not spawned until the first probe's
    // deadline has elapsed — so seeing all three wedged before one deadline is up is
    // the whole property, and it needs no upper bound on the run.
    let wedgedTogether = false;
    while (Date.now() - startedAt < PROBE_DEADLINE) {
      if (Object.values(wedged).every(existsSync)) {
        wedgedTogether = true;
        break;
      }
      await Bun.sleep(10);
    }
    await diagnosing;

    expect(wedgedTogether, "the probes were never wedged at the same time").toBe(true);
    // And they really did stall: a stub that answered at once would satisfy the
    // line above by racing through all three rather than by overlapping.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PROBE_DEADLINE);
  });

  test("a writable data directory is created and reported", async () => {
    const checks = await diagnose({ ENGWIRE_HOME: join(dir, "home"), PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "data")).toMatchObject({
      ok: true,
      note: join(dir, "home", "data"),
    });
  });

  test("the account is not reported when gh could not say who it is", async () => {
    // A ✓ here means the accounts match. With an empty PATH there is no `gh` to
    // ask, so there is nothing to match against — and a green tick beside the
    // red `gh` row would contradict it. The row is withheld rather than turned
    // red, because the `gh` row already says why.
    const env = { ENGWIRE_HOME: join(dir, "home"), PATH: "", HOME: dir };
    mkdirSync(paths(env).dataDir, { recursive: true });
    const store = new Store(paths(env).dbFile);
    store.bindReviewer("alice");
    store.close();

    const checks = await diagnose(env);

    expect(checks.find((check) => check.label === "account")).toBeUndefined();
    expect(checks.find((check) => check.label === "gh")).toMatchObject({ ok: false });
  });

  test("git is judged on the runner's path, not the agent's", async () => {
    // The agent's path carries an absolute `gh_bin`'s directory, because the
    // skill posts by running `gh` by name. `git` is never found that way — the
    // runner spawns it through `absolutePath` — so a `git` living beside the
    // configured `gh` but off PATH exists for the agent and not for the
    // checkout. Judged by the agent's path it is green, and `service install`
    // then approves a setup whose every review dies at `git clone`.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    for (const name of ["gh", "git"]) {
      const bin = join(tools, name);
      writeFileSync(bin, "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n");
      chmodSync(bin, 0o755);
    }
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(join(tools, "gh"))}\n` +
        `claude_bin = ${JSON.stringify(join(tools, "claude"))}\n`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "git")).toMatchObject({ ok: false });
  });

  /** A `claude` that behaves however the case needs, plus a `gh` beside it. */
  function tools(claudeScript: string, ghScript = "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n"): { home: string } {
    const bin = join(dir, "tools");
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, "gh");
    writeFileSync(gh, ghScript);
    chmodSync(gh, 0o755);
    const claude = join(bin, "claude");
    writeFileSync(claude, claudeScript);
    chmodSync(claude, 0o755);

    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(gh)}\nclaude_bin = ${JSON.stringify(claude)}\n`,
    );
    return { home };
  }

  /**
   * How a fixture wedges. Absolute, because the probes run with an empty
   * `PATH` and the shell would not find a bare `sleep`; resolved rather than
   * spelled `/bin/sleep`, which is not where every distribution keeps it.
   */
  const HANG = `${Bun.which("sleep") ?? "/bin/sleep"} 30`;

  /**
   * The deadline the probe tests run against.
   *
   * These cases turn on the difference between a probe that answers at once
   * and one that never answers, so the number has to sit well clear of a
   * shell spawn. At 300ms it did not: a `--version` stub that answers
   * instantly on an idle machine took longer than that under load, was read as
   * stalled, and flipped the assertion — observed once in six runs. Every test
   * below pays it once, against a stub that sleeps for thirty seconds, so
   * widening it costs a second and buys the distinction the tests are about.
   */
  const PROBE_DEADLINE = 2_000;

  /** A `claude` that answers the way 2.1.259 was measured to. */
  const MEASURED_CLAUDE = `#!/bin/sh
case "$*" in
  "--setting-sources user --version") echo "9.9.9 (Claude Code)" ;;
  "--setting-sources "*" --version")  echo "Invalid setting source" >&2; exit 1 ;;
  *--version)                         echo "9.9.9 (Claude Code)" ;;
  "--setting-sources user auth status") echo signed in ;;
  *)                                  exit 1 ;;
esac
`;

  test("a gh that vanishes is not somebody who needs to sign in again", async () => {
    // The same misdirection the timeout rows already avoided, reached by the
    // other non-exit path: with three overlapping booleans, a spawn that never
    // happened scored as a signed-out account and sent the reader to
    // `gh auth login` to fix a binary that was not there.
    const RM = `${Bun.which("rm") ?? "/bin/rm"}`;
    const gh = join(dir, "tools", "gh");
    const { home } = tools(
      MEASURED_CLAUDE,
      `#!/bin/sh\ncase "$1" in --version) ${RM} -f ${JSON.stringify(gh)}; echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir });

    expect(existsSync(gh), "the stub removed itself after answering once").toBe(false);
    const row = checks.find((check) => check.label === "gh");
    expect(row?.ok).toBe(false);
    expect(row?.note).not.toContain("gh auth login");
    // "Did not produce a usable answer", not "did not run": a spawn that never
    // happened and a read that broke share a kind, and only one of them means
    // the process never started.
    expect(row?.note).toContain("did not produce a usable answer");
  });

  test("a claude that vanishes is never read as one that refused the flag", async () => {
    // The same false tick as the hang above, reached the other way. The check
    // wants the second probe to *fail*, and three different things produce a
    // failure: an exit that rejected the flag, a spawn that never happened, and
    // a read that broke. Only the first is evidence. A stub that answers once
    // and then removes itself makes the second spawn `ENOENT`, which scored
    // exactly like a correct refusal until `capture` began reporting whether
    // anything exited at all.
    // Absolute, because the probes run on a filtered PATH that holds only the
    // stub directory — a bare `rm` resolves to nothing and the stub would
    // cheerfully survive, which is how this test first passed for no reason.
    const RM = `${Bun.which("rm") ?? "/bin/rm"}`;
    const gone = join(dir, "tools", "claude");
    const { home } = tools(`#!/bin/sh
case "$*" in
  "--setting-sources user --version") ${RM} -f ${JSON.stringify(gone)}; echo "9.9.9 (Claude Code)" ;;
  *) exit 1 ;;
esac
`);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir });

    // The apparatus first: a stub that survived would make every assertion
    // below a statement about an ordinary refusal.
    expect(existsSync(gone), "the stub removed itself after answering once").toBe(false);
    const claude = checks.find((check) => check.label === "claude");
    expect(claude?.ok).toBe(false);
    // Not the timeout wording either: nothing waited, it just was not there.
    expect(claude?.note).not.toContain("did not answer");
  });

  test("a claude that hangs is never read as one that refused the flag", async () => {
    // The check is `version.ok && !refusal.ok`: the refusal probe wants a
    // *failure*, so a binary that answers the first call and then wedges on the
    // second would score exactly like one that correctly rejected the flag.
    // That tick is the boundary keeping a pull request's own Claude
    // configuration out of the review, and silence must not earn it.
    const { home } = tools(`#!/bin/sh
case "$*" in
  "--setting-sources user --version") echo "9.9.9 (Claude Code)" ;;
  "--setting-sources "*" --version")  ${HANG} ;;
  "--setting-sources user auth status") echo signed in ;;
  *)                                  exit 1 ;;
esac
`);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir }, { probeTimeoutMs: PROBE_DEADLINE });

    const claude = checks.find((check) => check.label === "claude");
    expect(claude?.ok).toBe(false);
    expect(claude?.note).toContain("did not answer");
    // And it names the call that stalled. Here that is the *invalid* source
    // probe — the plain `--version` answered a moment earlier, so reporting
    // that one would send somebody to reproduce a command that works.
    expect(claude?.note).toContain("not-a-setting-source");
    expect(claude?.note).not.toContain("--setting-sources user --version did not");
    // And it says so as a thing unknown, not as a Claude Code that needs
    // updating — which is what the reviewer would otherwise go and do.
    expect(claude?.note).not.toContain("check or update Claude Code");
  });

  test("a probe that never answers does not become advice to sign in again", async () => {
    // `!ok` is turned into "run `claude auth login`" everywhere else, and a
    // probe that reported nothing has not established a signed-out account.
    // Sending somebody to re-authenticate a working one is the wrong end of it.
    const { home } = tools(`#!/bin/sh
case "$*" in
  "--setting-sources user --version") echo "9.9.9 (Claude Code)" ;;
  "--setting-sources "*" --version")  echo "Invalid setting source" >&2; exit 1 ;;
  "--setting-sources user auth status") ${HANG} ;;
  *)                                  exit 1 ;;
esac
`);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir }, { probeTimeoutMs: PROBE_DEADLINE });

    // The flag check still passed on its own evidence; only auth stalled.
    expect(checks.find((check) => check.label === "claude")).toMatchObject({ ok: true });
    const auth = checks.find((check) => check.label === "claude auth");
    expect(auth?.ok).toBe(false);
    expect(auth?.note).toContain("did not answer within");
    expect(auth?.note).not.toContain("claude auth login");
  });

  test("a gh that hangs is reported as silent, not as signed out", async () => {
    const { home } = tools(
      MEASURED_CLAUDE,
      `#!/bin/sh\ncase "$1" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) ${HANG} ;; esac\n`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir }, { probeTimeoutMs: PROBE_DEADLINE });

    const gh = checks.find((check) => check.label === "gh");
    expect(gh?.ok).toBe(false);
    expect(gh?.note).toContain("did not answer within");
    expect(gh?.note).not.toContain("gh auth login");
  });

  test("a gh that hangs on --version is not reported as an old gh", async () => {
    // `ghVersionProblem("")` reads "Engwire needs 2.31.0 or newer", which sends
    // the reviewer to install a `gh` that is already current. A wedged
    // `gh_bin` wrapper is the likelier reason nothing came back.
    const { home } = tools(MEASURED_CLAUDE, `#!/bin/sh\ncase "$1" in --version) ${HANG} ;; *) echo alice ;; esac\n`);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir }, { probeTimeoutMs: PROBE_DEADLINE });

    const version = checks.find((check) => check.label === "gh version");
    expect(version?.ok).toBe(false);
    expect(version?.note).toContain("did not answer within");
    expect(version?.note).not.toContain("2.31.0 or newer");
  });

  test("a gh that stalls past `auth status` still answers to the probe deadline", async () => {
    // `auth status` reads stored credentials and returns; `gh api user` and the
    // release lookup after it reach the network, and they run through `gh`'s own
    // two-minute deadline rather than `capture`'s. Left there, one unreachable
    // request holds `doctor`, `setup` and `service install` for two minutes
    // apiece — the wait the probe deadline exists to end. Measured: 60.4s
    // against a 0.5s deadline before, 0.8s after.
    const { home } = tools(
      MEASURED_CLAUDE,
      `#!/bin/sh\ncase "$*" in\n  "--version") echo 'gh version 2.31.0 (2023-06-06)' ;;\n  "auth status") echo ok ;;\n  *) ${HANG} ;;\nesac\n`,
    );

    const startedAt = Date.now();
    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir }, { probeTimeoutMs: PROBE_DEADLINE });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(checks.find((check) => check.label === "gh")).toMatchObject({ ok: false });
  }, 30_000);

  test("a claude that still validates --setting-sources is green", async () => {
    const { home } = tools(MEASURED_CLAUDE);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "claude")).toMatchObject({
      ok: true,
      note: expect.stringContaining("9.9.9"),
    });
    // The fake makes the unguarded auth invocation fail.
    expect(checks.find((check) => check.label === "claude auth")).toMatchObject({ ok: true });
  });

  test("a claude that refuses the flag outright is not green either", async () => {
    // Refusing an invalid value proves nothing unless Engwire's valid invocation
    // also succeeds.
    const { home } = tools(
      `#!/bin/sh
case "$*" in
  "--setting-sources "*" --version") exit 1 ;;
  *--version)                        echo "9.9.9 (Claude Code)" ;;
  "--setting-sources user auth status") echo signed in ;;
  *)                                 exit 1 ;;
esac
`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "claude")).toMatchObject({ ok: false });
  });

  test("a claude that takes any setting source at all is not green", async () => {
    // `--version` tolerates unknown flags, so accepting the nonsense setting
    // source models a CLI that no longer recognises the flag.
    const { home } = tools(
      `#!/bin/sh
case "$*" in
  *--version)    echo "9.9.9 (Claude Code)" ;;
  "--setting-sources user auth status") echo signed in ;;
  *)             exit 1 ;;
esac
`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: "", HOME: dir });

    expect(checks.find((check) => check.label === "claude")).toMatchObject({ ok: false });
  });

  /** A `claude` that behaves the way 2.1.257 was measured to. */
  const WORKING_CLAUDE = `#!/bin/sh
case "$*" in
  "--setting-sources user --version") echo "9.9.9 (Claude Code)" ;;
  "--setting-sources "*" --version")  exit 1 ;;
  "--setting-sources user auth status") echo signed in ;;
  *)                                  exit 1 ;;
esac
`;

  test("a broken config does not stop the rest of the report", async () => {
    // This is the command someone runs *because* something is wrong. A config
    // it cannot parse has to become one red row, not the end of the report —
    // otherwise the one typo hides whatever else is also broken.
    const { home } = tools(WORKING_CLAUDE);
    writeFileSync(join(home, "config", "config.toml"), "[[review]\nrepos = oops\n");

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir });

    expect(checks.find((check) => check.label === "config")).toMatchObject({ ok: false });
    // And everything it would have reported anyway is still reported.
    for (const label of ["gh", "claude", "git", "data"]) {
      expect(checks.find((check) => check.label === label)).toBeDefined();
    }
  });

  test("being unreachable is not the same problem as being signed out", async () => {
    // Reporting a network failure as a login problem sends someone to fix
    // something that is not broken.
    const signedInButOffline = `#!/bin/sh
case "$*" in
  "auth status") exit 0 ;;
  *)             echo "could not resolve host" >&2; exit 1 ;;
esac
`;
    const { home } = tools(WORKING_CLAUDE, signedInButOffline);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir });
    const gh = checks.find((check) => check.label === "gh");

    expect(gh).toMatchObject({ ok: false });
    expect(gh?.note).toContain("could not be reached");
    expect(gh?.note).not.toContain("gh auth login");
  });

  test("an installation bound to another account says whose it is", async () => {
    // The runner refuses to start under an account that does not own the queue,
    // so the report has to name the one it does — and the way back.
    const { home } = tools(WORKING_CLAUDE);
    const env = { ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir };
    mkdirSync(paths(env).dataDir, { recursive: true });
    const store = new Store(paths(env).dbFile);
    store.bindReviewer("bob");
    store.close();

    const checks = await diagnose(env);
    const account = checks.find((check) => check.label === "account");

    expect(account).toMatchObject({ ok: false });
    expect(account?.note).toContain("belongs to bob");
    expect(account?.note).toContain("gh auth switch --user bob");
  });

  test("the report opens with which engwire this is, whether or not gh answered", async () => {
    // A bug report starts with a version, and the row is not a claim about
    // GitHub: with no `gh` to ask there is nothing to compare against, so the
    // version stands bare rather than the row going missing or red.
    const checks = await diagnose({ ENGWIRE_HOME: join(dir, "home"), PATH: "", HOME: dir });

    expect(checks[0]).toEqual({ label: "engwire", ok: true, note: VERSION });
  });

  test("a newer release is named beside the version that is running", async () => {
    // Still a ✓: an older Engwire works, and `service install` refuses on any
    // failed check — a release nobody has installed yet must not be a reason
    // not to run the one they have.
    const { home } = tools(
      WORKING_CLAUDE,
      `#!/bin/sh
case "$*" in
  --version) echo 'gh version 2.31.0 (2023-06-06)' ;;
  "api repos/engwire/engwire/releases/latest --jq .tag_name") echo v99.0.0 ;;
  *) echo alice ;;
esac
`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir });

    expect(checks[0]).toEqual({ label: "engwire", ok: true, note: `${VERSION} — 99.0.0 is out` });
  });

  test("a release is only looked up once gh has answered for the account", async () => {
    // Signed out, the `gh` row already says why nothing was compared. A `gh`
    // that would still answer the release call proves the guard is the gate,
    // not the fixture.
    const { home } = tools(
      WORKING_CLAUDE,
      `#!/bin/sh
case "$*" in
  --version) echo 'gh version 2.31.0 (2023-06-06)' ;;
  "auth status") exit 1 ;;
  "api repos/engwire/engwire/releases/latest --jq .tag_name") echo v99.0.0 ;;
  *) echo alice ;;
esac
`,
    );

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: dir });

    expect(checks[0]).toEqual({ label: "engwire", ok: true, note: VERSION });
  });

  test("probing a setup does not hand claude the reviewer's loader settings", async () => {
    // Claude has two spawn sites and one boundary. The Linux measurement is
    // literally `LD_PRELOAD=./libprobe.so claude --version` — a constructor from
    // the working directory, running inside the agent's own process before it
    // enforces anything — and `--version` is what this command runs. A policy
    // private to `runClaude` would have left the sharper caller open, and
    // `doctor` is the one typed from wherever the reviewer is standing.
    // `DYLD_*` is deliberately not among them. Darwin strips that whole
    // namespace before a SIP-protected binary starts and `#!/bin/sh` is one, so
    // a row here would read `[unset]` with the rule removed — a test that cannot
    // fail. Namespace membership is asserted directly in `environment.test.ts`.
    const recorded = join(dir, "probe-env");
    const { home } = tools(`#!/bin/sh
printf '%s\n' "LD_PRELOAD=[\${LD_PRELOAD-unset}]" "NODE_OPTIONS=[\${NODE_OPTIONS-unset}]" "BASH_ENV=[\${BASH_ENV-unset}]" >> ${JSON.stringify(recorded)}
${MEASURED_CLAUDE.split("\n").slice(1).join("\n")}`);

    const checks = await diagnose({
      ENGWIRE_HOME: home,
      PATH: join(dir, "tools"),
      HOME: dir,
      LD_PRELOAD: "./libengwire.so",
      NODE_OPTIONS: "--require ./engwire.cjs",
      BASH_ENV: "./engwire-bash-env",
    });

    // The probe ran, or an empty recording would pass this on its own.
    expect(checks.find((check) => check.label === "claude")).toMatchObject({ ok: true });
    const seen = readFileSync(recorded, "utf8");
    expect(seen).toContain("LD_PRELOAD=[unset]");
    expect(seen).toContain("NODE_OPTIONS=[unset]");
    expect(seen).toContain("BASH_ENV=[unset]");
  });

  test("probing a setup does not hand gh the reviewer's loader settings either", async () => {
    // `createGh` filters its own spawn, but `doctor` reaches `gh` twice more
    // through `capture` — `--version` and `auth status` — and those went out
    // with the environment as found. `gh --version` is a measured target of a
    // relative `LD_PRELOAD`, so this was the same hole as Claude's in the same
    // command. `setup` and `service install` run this code too.
    //
    // `DYLD_*` is deliberately not among them. Darwin strips that whole
    // namespace before a SIP-protected binary starts and `#!/bin/sh` is one, so
    // a row here would read `[unset]` with the rule removed — a test that cannot
    // fail. Namespace membership is asserted directly in `environment.test.ts`.
    const recorded = join(dir, "gh-probe-env");
    const { home } = tools(
      MEASURED_CLAUDE,
      `#!/bin/sh
printf '%s\n' "$* LD_PRELOAD=[\${LD_PRELOAD-unset}] NODE_OPTIONS=[\${NODE_OPTIONS-unset}] BASH_ENV=[\${BASH_ENV-unset}]" >> ${JSON.stringify(recorded)}
case "$1" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac
`,
    );

    const checks = await diagnose({
      ENGWIRE_HOME: home,
      PATH: join(dir, "tools"),
      HOME: dir,
      LD_PRELOAD: "./libengwire.so",
      NODE_OPTIONS: "--require ./engwire.cjs",
      BASH_ENV: "./engwire-bash-env",
    });

    // Both probes ran, or an empty recording would pass this on its own.
    expect(checks.find((check) => check.label === "gh")).toMatchObject({ ok: true });
    const seen = readFileSync(recorded, "utf8");
    expect(seen).toContain("--version LD_PRELOAD=[unset]");
    expect(seen).toContain("auth status LD_PRELOAD=[unset]");
    expect(seen).not.toContain("libengwire.so");
    expect(seen).not.toContain("engwire.cjs");
    expect(seen).not.toContain("engwire-bash-env");
  });

  test("a gh configuration root the checkout could have supplied is not probed through", async () => {
    // Pinning it absolutely would name the branch's own directory just as
    // faithfully; the origin is the fault, so the probe does not run at all.
    // `HOME` empty is the shape that hides — it reads as no setting and means
    // "here" — and `ENGWIRE_HOME` keeps Engwire's own location out of it, so
    // this is the gh root failing on its own and not `locationProblem` again.
    const { home } = tools(MEASURED_CLAUDE);
    const marker = join(dir, "gh-ran");
    writeFileSync(
      join(dir, "tools", "gh"),
      `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\necho alice\n`,
    );
    chmodSync(join(dir, "tools", "gh"), 0o755);

    const checks = await diagnose({ ENGWIRE_HOME: home, PATH: join(dir, "tools"), HOME: "" });

    const gh = checks.find((check) => check.label === "gh");
    expect(gh?.ok).toBe(false);
    expect(gh?.note).toContain("HOME");
    expect(existsSync(marker)).toBe(false);
  });

  test("the git probe is not handed a pin production git never gets", async () => {
    // The inverse of the row above, and the reason both are needed. The shared
    // probe primitive used to add `GH_HOST=github.com` to every diagnostic
    // child, so the row claiming "it ran in the environment Engwire starts it
    // in" was running git in one Engwire never starts it in. A wrapper keyed on
    // an ordinary `GH_HOST` makes the difference visible: production git keeps
    // whatever the environment says, so the probe must too.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    writeFileSync(
      join(tools, "git"),
      `#!/bin/sh\n[ "\${GH_HOST-}" = "example.invalid" ] || { echo "GH_HOST=[\${GH_HOST-unset}]" >&2; exit 3; }\necho "git version 0.0.0-stub"\n`,
      { mode: 0o755 },
    );
    // The gh stub wants the opposite: every `gh` Engwire starts is pinned to
    // github.com, ambient `GH_HOST` or not, so this one refuses to answer under
    // any other host. One environment, two opposite expectations, which is what
    // makes the pin's new home observable in both directions.
    writeFileSync(
      join(tools, "gh"),
      `#!/bin/sh\n[ "\${GH_HOST-}" = "github.com" ] || { echo "GH_HOST=[\${GH_HOST-unset}]" >&2; exit 3; }\ncase "$1" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(tools, "claude"), MEASURED_CLAUDE, { mode: 0o755 });
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(join(tools, "gh"))}\nclaude_bin = ${JSON.stringify(join(tools, "claude"))}\n`,
    );

    const checks = await diagnose({
      ENGWIRE_HOME: home,
      PATH: tools,
      HOME: dir,
      GH_HOST: "example.invalid",
    });

    expect(checks.find((check) => check.label === "git")).toMatchObject({ ok: true });
    // And gh still gets the pin, which is the half that must not be lost in
    // taking it away from everyone else.
    expect(checks.find((check) => check.label === "gh")).toMatchObject({ ok: true });
  });

  test("a git that cannot start in Engwire's environment is not a green git", async () => {
    // Found is not runnable. Every `git` Engwire starts loses the ambient
    // `GIT_*` and the loader and interpreter selectors, so a wrapper that
    // needed one of those works in the shell that typed `doctor` and fails in
    // every review — and `service install` gates on this row, so a ✓ approves a
    // background runner that cannot check anything out.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    writeFileSync(
      join(tools, "git"),
      // Stands in for a wrapper that needs something production strips. A
      // `GIT_*` variable rather than a `NODE_*` one on purpose: `capture` drops
      // the startup-code namespaces itself, so a stub keyed on those would pass
      // whether or not `gitEnvironment` was consulted. Only the `GIT_*` rule
      // distinguishes them, and that rule is the reason this probe exists.
      `#!/bin/sh\n[ -z "\${GIT_EXEC_PATH-}" ] && { echo "needs GIT_EXEC_PATH" >&2; exit 3; }\necho "git version 0.0.0-stub"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(tools, "gh"), "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n", { mode: 0o755 });
    writeFileSync(join(tools, "claude"), MEASURED_CLAUDE, { mode: 0o755 });
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(join(tools, "gh"))}\nclaude_bin = ${JSON.stringify(join(tools, "claude"))}\n`,
    );
    // In the diagnosed environment, not this process's: the probe has to be
    // given the variable in order to be seen stripping it. Set on `process.env`
    // instead, the stub failed because the variable was never there at all, and
    // the test passed without exercising `gitEnvironment` at all.
    const checks = await diagnose({
      ENGWIRE_HOME: home,
      PATH: tools,
      HOME: dir,
      GIT_EXEC_PATH: "/opt/git-core",
    });

    const git = checks.find((check) => check.label === "git");
    expect(git?.ok).toBe(false);
    // The path is not the answer here; why it will not run is.
    expect(git?.note).toContain("did not run in the environment Engwire starts it in");
  });

  test("a claude root this report cannot reason about stops the claude probe", async () => {
    // The same shape as the zsh gate, one step weaker in evidence and just as
    // easy to get right: `--setting-sources user` makes this root the scope
    // Claude reads, and a relative one resolves from wherever `doctor` was
    // typed. Nothing here proves a checkout can run code through it — what it
    // does prove is that the report no longer probes through a root it is about
    // to mark unusable. gh and git are unaffected, which is what keeps this
    // from being the zsh gate wearing a different hat.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    const ran = join(dir, "claude-ran");
    writeFileSync(join(tools, "claude"), `#!/bin/sh\necho ran >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
    writeFileSync(join(tools, "gh"), "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n", { mode: 0o755 });
    // git has to be present, or "git is unaffected" would be satisfied by a git
    // that was never there to affect — which is what this test asserted before.
    const gitRan = join(dir, "git-ran");
    writeFileSync(join(tools, "git"), `#!/bin/sh\necho ran >> ${JSON.stringify(gitRan)}\necho "git version 0.0.0-stub"\n`, { mode: 0o755 });
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(join(tools, "gh"))}\nclaude_bin = ${JSON.stringify(join(tools, "claude"))}\n`,
    );

    const checks = await diagnose({
      ENGWIRE_HOME: home,
      PATH: tools,
      HOME: dir,
      CLAUDE_CONFIG_DIR: "claude-relative",
    });

    expect(existsSync(ran), "claude was not started").toBe(false);
    expect(checks.find((check) => check.label === "claude root")).toMatchObject({ ok: false });
    expect(checks.find((check) => check.label === "claude")?.note).toContain("claude root above");
    // Only Claude's probe is gated by Claude's root — the other two ran, which
    // is the asymmetry that separates this from the zsh gate.
    expect(existsSync(gitRan), "git was started").toBe(true);
    expect(checks.find((check) => check.label === "gh")).toMatchObject({ ok: true });
    expect(checks.find((check) => check.label === "git")).toMatchObject({ ok: true });
  });

  test("a zsh startup directory the working directory could choose stops every probe", async () => {
    // `doctor` used to report this and probe anyway, on the grounds that
    // `claude --version` starts no shell. That is a property of the Claude that
    // was measured, not of the configuration: `claude_bin`, `gh_bin` and a
    // PATH-resolved `git` are any executable, and `#!/usr/bin/env zsh` starts a
    // shell before the wrapper's first line — which then reads `.zshenv` from a
    // directory resolved against wherever `doctor` was typed.
    //
    // Every stand-in here records that it ran. The assertion is that none did.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    const ran = join(dir, "a-probe-ran");
    for (const name of ["gh", "claude", "git"]) {
      writeFileSync(join(tools, name), `#!/bin/sh\necho ran >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });
    }
    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(join(tools, "gh"))}\nclaude_bin = ${JSON.stringify(join(tools, "claude"))}\n`,
    );

    const checks = await diagnose({
      ENGWIRE_HOME: home,
      PATH: tools,
      HOME: dir,
      ZDOTDIR: "zdot-relative",
    });

    expect(existsSync(ran), "no program was started").toBe(false);
    expect(checks.find((check) => check.label === "zsh startup")).toMatchObject({ ok: false });
    // Red rather than absent, and each says it was found but not run — a
    // missing row would read as "nothing to check here".
    for (const label of ["gh", "claude", "git"]) {
      const row = checks.find((check) => check.label === label);
      expect(row?.ok, `${label} must not be green`).toBe(false);
      expect(row?.note, `${label} must say why`).toContain("not run");
    }
  });

  test("probing a setup is not a way to execute the checkout it runs in", async () => {
    // Resolving the binary safely is only half of it. An absolute `claude` can
    // be a script, and `#!/usr/bin/env node` hands the interpreter straight
    // back to PATH — so a probe spawned with the caller's own `.` on it runs a
    // file from the working directory, which for a command someone types can be
    // the checkout under review. `doctor` would then be the thing that executes
    // it, having been written to detect exactly this.
    const tools = join(dir, "tools");
    const here = join(dir, "checkout");
    mkdirSync(tools, { recursive: true });
    mkdirSync(here, { recursive: true });
    const gh = join(tools, "gh");
    writeFileSync(gh, "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n");
    chmodSync(gh, 0o755);
    // The interpreter exists only in the working directory.
    const marker = join(dir, "executed");
    const interpreter = join(here, "engwire-probe");
    // Redirection, not `touch`: the probe inherits the poisoned PATH, on
    // which no external command resolves.
    writeFileSync(interpreter, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
    chmodSync(interpreter, 0o755);
    const claude = join(tools, "claude");
    writeFileSync(claude, "#!/usr/bin/env engwire-probe\n");
    chmodSync(claude, 0o755);

    const home = join(dir, "home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "config.toml"),
      `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
        `[advanced]\ngh_bin = ${JSON.stringify(gh)}\nclaude_bin = ${JSON.stringify(claude)}\n`,
    );

    const cwd = process.cwd();
    process.chdir(here);
    let checks;
    try {
      checks = await diagnose({ ENGWIRE_HOME: home, PATH: ".", HOME: dir });
    } finally {
      process.chdir(cwd);
    }

    // Both halves, because an absent marker alone would also describe a
    // `doctor` that stopped probing Claude altogether: the configured binary
    // was tried, its interpreter was not reachable on a filtered path, and the
    // one in this directory was not run instead.
    expect(checks.find((check) => check.label === "claude")).toMatchObject({ ok: false });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("serviceChecks", () => {
  /** A plist as `service install` would have written it, for a named home. */
  function installed(executable: string, home = join(dir, "home")): string {
    const file = join(dir, "com.engwire.local.plist");
    writeFileSync(
      file,
      plist({
        executable,
        logsDir: join(dir, "logs"),
        environment: { PATH: "/usr/bin", ENGWIRE_HOME: home },
      }),
    );
    return file;
  }

  const here = () => paths({ ENGWIRE_HOME: join(dir, "home") }).dataDir;

  test("reports the program the plist pins", () => {
    // Round-tripped through the generator with a path that has to survive XML
    // escaping: a plist is written escaped, and a reader that forgets that
    // would report a path nobody has.
    const executable = join(dir, "a&b", "engwire");
    mkdirSync(join(dir, "a&b"));
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);

    expect(serviceChecks(installedPlist(here(), installed(executable)))).toEqual([
      { label: "service", ok: true, note: `runs ${executable}` },
    ]);
  });

  test("a service pointing at a binary that is gone is not a green check", () => {
    const check = serviceChecks(installedPlist(here(), installed(join(dir, "removed", "engwire"))))[0];

    expect(check).toMatchObject({ label: "service", ok: false });
    expect(check?.note).toContain("missing or not executable");
    expect(check?.note).toContain("engwire service install");
  });

  test("another installation's service is reported, not blamed on this one", () => {
    // A foreign service is useful context, but must not fail this installation.
    const file = installed(join(dir, "gone", "engwire"), join(dir, "other-home"));

    expect(serviceChecks(installedPlist(here(), file))).toEqual([
      {
        label: "service",
        ok: true,
        note: `supervises ${paths({ ENGWIRE_HOME: join(dir, "other-home") }).dataDir}, not this installation`,
      },
    ]);
  });

  test("a service that does not say whose it is counts as another's", () => {
    // An unclaimable plist must not fail this installation's report.
    const file = join(dir, "unreadable.plist");
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>${join(dir, "gone", "engwire")}</string>
    <string>run</string>
  </array>
</dict>
</plist>
`,
    );

    expect(serviceChecks(installedPlist(here(), file))).toEqual([
      {
        label: "service",
        ok: true,
        note: "a service plist is here that does not say which installation it belongs to",
      },
    ]);
  });

  test("nothing to say when no service is installed", () => {
    expect(serviceChecks(installedPlist(here(), join(dir, "absent.plist")))).toEqual([]);
  });
});

describe("releaseNote", () => {
  test("a newer release is out, and an installed binary is told how to get it", () => {
    const note = releaseNote("0.1.0", "v0.2.0", true);

    expect(note).toContain("0.1.0");
    expect(note).toContain("0.2.0 is out");
    expect(note).toContain("install.sh");
  });

  test("a source checkout is told about the release, not the installer", () => {
    // `curl | sh` would install a binary beside a checkout that keeps running
    // from source; saying so would be advice that changes nothing.
    const note = releaseNote("0.1.0", "v0.2.0", false);

    expect(note).toContain("0.2.0 is out");
    expect(note).not.toContain("install.sh");
  });

  test("the latest release says so", () => {
    expect(releaseNote("0.2.0", "v0.2.0", true)).toBe("0.2.0 — the latest release");
  });

  test("a checkout at the released number is not called the release", () => {
    // `package.json` keeps the last released version until the next bump while
    // main moves on, so the equal case says nothing about which code this is.
    expect(releaseNote("0.2.0", "v0.2.0", false)).toBe("0.2.0");
  });

  test("a build ahead of the last release is not nagged", () => {
    // The ordinary state of a source checkout between releases.
    expect(releaseNote("0.3.0", "v0.2.0", true)).toBe("0.3.0");
  });

  test("versions are compared as numbers", () => {
    // "0.10.0" sorts before "0.9.0" as text, which would report a downgrade as
    // an upgrade — and the reverse as current.
    expect(releaseNote("0.9.0", "v0.10.0", true)).toContain("0.10.0 is out");
    expect(releaseNote("0.10.0", "v0.9.0", true)).toBe("0.10.0");
  });

  test("nothing to compare against leaves the version bare", () => {
    // No release yet, an outage, and a `gh` that answered with something other
    // than a tag all mean the same thing here: not a fact about this install.
    for (const latest of [null, "", "alice", "v1.2", "1.2.3-rc.1"]) {
      expect(releaseNote("0.1.0", latest, true)).toBe("0.1.0");
    }
  });
});

describe("installCommand", () => {
  test("a binary in the installer's default place gets the README's command", () => {
    expect(installCommand("/Users/alice/.local/bin/engwire", "/Users/alice")).toBe(
      "curl -fsSL https://engwire.com/install.sh | sh",
    );
  });

  test("a binary anywhere else names its prefix, or the upgrade lands beside it", () => {
    // Installed once with `ENGWIRE_PREFIX`, the bare command would write a
    // second binary to `~/.local/bin` and leave this one, on PATH and in the
    // plist, exactly as old as it was.
    expect(installCommand("/opt/engwire/bin/engwire", "/Users/alice")).toBe(
      "curl -fsSL https://engwire.com/install.sh | ENGWIRE_PREFIX='/opt/engwire/bin' sh",
    );
  });

  test("a prefix with a quote in it is still one shell word", () => {
    // `/opt/alice's tools` is a directory somebody can have. Interpolated
    // naked, the quote ends the quoting early and the reader is handed a
    // command their shell will not parse — from the row that exists to tell
    // them how to upgrade.
    const command = installCommand("/opt/alice's tools/engwire", "/Users/alice");

    expect(command).toBe(
      "curl -fsSL https://engwire.com/install.sh | ENGWIRE_PREFIX='/opt/alice'\\''s tools' sh",
    );
    // Not merely different: a shell has to read it back as the original path.
    const echoed = Bun.spawnSync(["sh", "-c", `${command.split("| ")[1]?.replace(/ sh$/, "")} sh -c 'printf %s "$ENGWIRE_PREFIX"'`]);
    expect(echoed.stdout.toString()).toBe("/opt/alice's tools");
  });
});

describe("ghVersionProblem", () => {
  test("the floor and anything above it is fine", () => {
    // 2.31.0 is the release that merged paginated pages into one array; the
    // floor is met, not merely exceeded.
    for (const line of ["gh version 2.31.0 (2023-06-06)", "gh version 2.98.0 (2026-08-20)"]) {
      expect(ghVersionProblem(line)).toBeNull();
    }
    // A newer major, and a minor that only compares correctly as a number:
    // "2.9" sorts after "2.31" as text.
    expect(ghVersionProblem("gh version 3.0.0 (2027-01-01)")).toBeNull();
    expect(ghVersionProblem("gh version 2.9.0 (2022-08-01)")).not.toBeNull();
  });

  test("an older gh is named, with what it costs", () => {
    const problem = ghVersionProblem("gh version 2.30.0 (2023-05-16)");

    expect(problem).toContain("2.30.0");
    expect(problem).toContain("2.31.0");
    // The point of the row: the failure is latent, so the note has to say what
    // goes wrong rather than only that a number is small.
    expect(problem).toContain("history");
    // And where to go. Every other failing row in `doctor` names a command or a
    // page; this is the only one whose answer is not `engwire` anything.
    expect(problem).toContain("https://cli.github.com");
  });

  test("a version it cannot read is refused, not assumed current", () => {
    // "Could not tell" is not evidence that a busy pull request will parse.
    for (const output of ["", "gh: command not found", "version 2.31.0"]) {
      expect(ghVersionProblem(output)).not.toBeNull();
    }
  });

  test("a dev build reports the release it was cut from", () => {
    expect(ghVersionProblem("gh version 2.40.0-1-gabcdef (2024-01-01)")).toBeNull();
  });
});
