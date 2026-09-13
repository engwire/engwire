import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { agentPath, claudeEnvironment, reviewPrompt, runClaude } from "./run.ts";

const FAKE = resolve(import.meta.dir, "../../test/fixtures/claude");
const LEAKY = resolve(import.meta.dir, "../../test/fixtures/leaky");
const STUBBORN = resolve(import.meta.dir, "../../test/fixtures/stubborn");
const BUN = process.execPath;

const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "engwire-claude-"));
  scratches.push(dir);
  return dir;
}

/**
 * Change the environment now and hand back the undo — not a scope, despite what
 * a `with` would suggest, because the call under test is `await`ed.
 *
 * `undefined` removes a variable; restoring puts back whatever was there,
 * including nothing. Deleting instead would change the environment for every
 * test after this one, and these are exactly the variables a suite might have
 * been launched with on purpose.
 */
function patchEnv(vars: Record<string, string | undefined>): () => void {
  const before = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  const apply = (entries: Iterable<readonly [string, string | undefined]>) => {
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(Object.entries(vars));
  return () => apply(before);
}

/**
 * Wait for a spawned runner to announce itself, in real time.
 *
 * Counting `Bun.sleep(25)` calls instead would measure sleeps requested rather
 * than time passed: under a loaded suite one can wake far later, and a budget
 * kept in intentions runs out long after the deadline it was protecting.
 *
 * Giving up sends SIGTERM, never SIGKILL. The review is detached into its own
 * process group, and the only thing that takes that group down is the runner's
 * own shutdown path — SIGKILL would remove the one process that knows how,
 * leaving exactly the orphaned tool tree this is trying not to leave behind. If
 * the spawn has not happened yet there is nothing detached to clean up, and the
 * runner exits either way.
 */
async function awaitReady(runner: Bun.Subprocess, path: string, within: number): Promise<void> {
  const startedAt = performance.now();
  const late = () => performance.now() - startedAt > within;
  while (!existsSync(path)) {
    if (late()) break;
    await Bun.sleep(25);
  }
  if (!existsSync(path) || late()) {
    runner.kill("SIGTERM");
    await runner.exited;
    throw new Error(`nothing at ${path} within ${within} ms`);
  }
}

afterAll(async () => {
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

describe("runClaude", () => {
  test("runs the skill in the worktree and captures the transcript", async () => {
    const dir = scratch();
    const log = join(dir, "run.log");

    const result = await runClaude({
      bin: FAKE,
      ghBin: "/usr/bin/gh",
      repo: "acme/api",
      cwd: dir,
      prompt: reviewPrompt("review-pr", "acme/api", 42, "a".repeat(40)),
      timeoutMs: 5_000,
      logPath: log,
    });

    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    const transcript = await Bun.file(log).text();
    // The isolation flag is not optional: without it a pull request could ship
    // `.claude/settings.json` hooks and have them run here.
    expect(transcript).toContain(
      `--setting-sources user -p /review-pr acme/api#42 at ${"a".repeat(40)}`,
    );
    expect(transcript).toContain(dir);
  });

  test("points the skill's gh at the repository under review", async () => {
    // `gh pr review 42` with no `--repo` resolves its target from `GH_REPO`
    // before it infers one, so a stray value in the reviewer's shell would post
    // this review somewhere else entirely.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({ GH_REPO: "someone/else" });
    try {
      await runClaude({
        bin: FAKE,
        ghBin: "/usr/bin/gh",
        repo: "acme/api",
        cwd: dir,
        prompt: "/review-pr acme/api#42",
        timeoutMs: 5_000,
        logPath: log,
      });
    } finally {
      restore();
    }
    expect(await Bun.file(log).text()).toContain("GH_REPO: acme/api");
  });

  test("hands the skill none of the reviewer's own git configuration", async () => {
    // The runner's own git keeps it — `inertOverrides` reads the effective
    // configuration and disables what executes — but that git never runs
    // `diff`, and the skill does. A diff driver is executable configuration a
    // contributor can *select*: `.gitattributes` in the branch names `diff=x`
    // and `diff.x.command` in the reviewer's global config is what runs, on
    // the branch's own content (measured, experiments.md). Cheaper to hand the
    // agent no global configuration at all than to teach this boundary every
    // key that executes.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({
      GIT_CONFIG_GLOBAL: join(dir, "reviewer.gitconfig"),
      GIT_CONFIG_SYSTEM: join(dir, "machine.gitconfig"),
    });
    try {
      await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: log,
      });
    } finally {
      restore();
    }

    // Both scopes, or the title is only half true: a machine-wide diff driver
    // executes on the branch's content exactly as a personal one does.
    const transcript = await Bun.file(log).text();
    expect(transcript).toContain("GIT_CONFIG_GLOBAL: [/dev/null]");
    expect(transcript).toContain("GIT_CONFIG_SYSTEM: [/dev/null]");
  });

  test("keeps the reviewer's Node environment out of the review", async () => {
    // Measured (experiments.md): `NODE_OPTIONS=--require ./x.cjs` loads a file
    // from the working directory before the program runs a line of its own, and
    // a relative `NODE_PATH` puts that directory on the path a bare
    // `require("thing")` resolves against. A review runs Node programs itself —
    // a linter, a test command, `npx` — so this is the `--setting-sources user`
    // boundary being walked around from outside.
    //
    // The sentinel is the part worth having: it is not a variable Node reads,
    // so only dropping the namespace clears it. A list of the two names above
    // would satisfy every other assertion here.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({
      NODE_OPTIONS: "--require ./preload.cjs",
      NODE_PATH: "./mods",
      NODE_ENGWIRE_SENTINEL: "present",
    });
    try {
      await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: log,
      });
    } finally {
      restore();
    }

    // Removed rather than blanked: an empty `NODE_OPTIONS` is harmless, but the
    // namespace is what is refused, not one spelling of one member.
    const transcript = await Bun.file(log).text();
    expect(transcript).toContain("NODE_OPTIONS: [<unset>]");
    expect(transcript).toContain("NODE_PATH: [<unset>]");
    expect(transcript).toContain("NODE_ENGWIRE_SENTINEL: [<unset>]");
  });

  test("keeps the reviewer's dynamic loader settings out of the review", async () => {
    // The bluntest form of the same hazard, and the one that reaches furthest:
    // measured on Debian against an npm-installed claude 2.1.263, a relative
    // `LD_PRELOAD` ran a constructor from the working directory *inside the
    // agent's own process*, before Claude had enforced anything. A second
    // mechanism needs no filename — an empty or relative entry in
    // `LD_LIBRARY_PATH` means the working directory, so the branch answers an
    // ordinary program's ordinary dependency. Two mechanisms and `ld.so`
    // documents more, so the namespace goes, sentinel and all.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({
      LD_PRELOAD: "./libengwire.so",
      LD_LIBRARY_PATH: ":",
      LD_ENGWIRE_SENTINEL: "present",
    });
    try {
      await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: log,
      });
    } finally {
      restore();
    }

    const transcript = await Bun.file(log).text();
    expect(transcript).toContain("LD_PRELOAD: [<unset>]");
    expect(transcript).toContain("LD_LIBRARY_PATH: [<unset>]");
    expect(transcript).toContain("LD_ENGWIRE_SENTINEL: [<unset>]");
  });

  test("drops the loader namespace macOS strips for itself", () => {
    // Asserted on the policy rather than through the fixture, because on Darwin
    // the fixture cannot answer. dyld strips every `DYLD_*` variable before a
    // SIP-protected binary starts — measured, and it takes an invented
    // `DYLD_ENGWIRE_SENTINEL` with it — and `#!/bin/sh` is such a binary, so a
    // transcript row would read `<unset>` with this rule removed. It was: the
    // spawn-based version of this passed against a filter that kept `DYLD_*`.
    //
    // Dropped anyway, because that stripping is a property of the executable
    // rather than of Engwire. It is why the measured signed `claude` was safe
    // and why the npm-installed Linux one was not, and `claude_bin` takes
    // either. Cheaper to own the loader environment than to re-measure every
    // way Claude can be installed.
    const env = claudeEnvironment({
      DYLD_INSERT_LIBRARIES: "./libengwire.dylib",
      DYLD_ENGWIRE_SENTINEL: "present",
      LD_PRELOAD: "./libengwire.so",
      PATH: "/usr/bin",
    });

    expect(Object.keys(env).filter((name) => name.startsWith("DYLD_"))).toEqual([]);
    // The half the transcript above proves, restated here so the two rules are
    // visibly one policy rather than two that drifted.
    expect(Object.keys(env).filter((name) => name.startsWith("LD_"))).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("keeps the reviewer's BASH_ENV out of the review", async () => {
    // Bash runs the file `BASH_ENV` names whenever a non-interactive shell
    // starts, and a review reaches one as soon as it runs a command — measured
    // through the whole path, the `bash` a tool call started read
    // `./engwire-bash-env` out of the working directory. Removing it is the
    // whole fix here: what it names is the file, so with no variable there is
    // no file. `ENV`, the `sh` spelling, is deliberately left alone — same
    // family, measured not to be read by a non-interactive `sh`.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({ BASH_ENV: "./engwire-preload.sh" });
    try {
      await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: log,
      });
    } finally {
      restore();
    }

    expect(await Bun.file(log).text()).toContain("BASH_ENV: [<unset>]");
  });

  test("passes a safe zsh startup directory through rather than renaming it", async () => {
    // Preserve an absolute selector: dropping it could make zsh fall back to
    // a relative HOME. The command preflight owns refusal of relative roots.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({ ZDOTDIR: "/opt/zdot" });
    try {
      await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: log,
      });
    } finally {
      restore();
    }

    expect(await Bun.file(log).text()).toContain("ZDOTDIR: [/opt/zdot]");
  });

  test("keeps an ambient GIT_DIR out of the skill's git", async () => {
    // The runner's own git already drops the repository selectors; the agent's
    // did not. A skill's ordinary `git diff` honours `GIT_DIR` over the worktree
    // it is standing in — so an `engwire run` started from a git hook, which is
    // exactly where git exports one, would have the review read, and a write
    // command modify, the reviewer's own checkout.
    const dir = scratch();
    const log = join(dir, "run.log");
    const restore = patchEnv({ GIT_DIR: "/somewhere/else/.git" });
    try {
      await runClaude({
        bin: FAKE,
        ghBin: "/usr/bin/gh",
        repo: "acme/api",
        cwd: dir,
        prompt: "/review-pr acme/api#42",
        timeoutMs: 5_000,
        logPath: log,
      });
    } finally {
      restore();
    }
    // Removed rather than blanked: git reads an empty value as a repository too.
    expect(await Bun.file(log).text()).toContain("GIT_DIR: [<unset>]");
  });

  test("keeps the transcript readable only by its owner", async () => {
    // It holds a review of private code, so neither the machine's umask nor a
    // directory that happened to exist already decides who can read it.
    const dir = scratch();
    const logs = join(dir, "logs", "runs");
    mkdirSync(logs, { recursive: true });
    chmodSync(logs, 0o755);
    const log = join(logs, "run.log");
    await Bun.write(log, "");
    chmodSync(log, 0o644);

    await runClaude({
      bin: FAKE,
      ghBin: "/usr/bin/gh",
      repo: "acme/api",
      cwd: dir,
      prompt: "/review-pr acme/api#42",
      timeoutMs: 5_000,
      logPath: log,
    });

    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
  });

  test("the transcript says how it ended, not just where it stopped", async () => {
    // The file is the only thing a reviewer opens after the fact, and the agent
    // output above simply stops — so an ordinary finish and a non-zero exit
    // read the same. The status that separates them is in a database nobody is
    // looking at while reading a log.
    const dir = scratch();
    const ok = join(dir, "ok.log");
    await runClaude({
      bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
      prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: ok,
    });

    expect(await Bun.file(ok).text()).toContain("[engwire] claude finished after");

    const bad = join(dir, "bad.log");
    process.env.FAKE_CLAUDE_EXIT = "3";
    try {
      await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 5_000, logPath: bad,
      });
    } finally {
      delete process.env.FAKE_CLAUDE_EXIT;
    }

    expect(await Bun.file(bad).text()).toContain("[engwire] claude exited 3 after");
  });

  test("a timeout says so in the transcript rather than looking like an exit", async () => {
    // A killed `claude` and a `claude` that chose to exit non-zero are the same
    // number to a shell, and the difference is what the reviewer needs.
    const dir = scratch();
    const log = join(dir, "run.log");
    process.env.FAKE_CLAUDE_SLEEP = "5";
    try {
      const result = await runClaude({
        bin: FAKE, ghBin: "/usr/bin/gh", repo: "acme/api", cwd: dir,
        prompt: "/review-pr acme/api#42", timeoutMs: 300, logPath: log,
      });

      expect(result.timedOut).toBe(true);
      // The whole sentence: the elapsed time is the review's, measured after
      // the wait, so attaching it to the deadline would date a ten-minute
      // timeout to whenever the review finally let go.
      expect(await Bun.file(log).text()).toContain(
        "[engwire] claude reached its run_timeout and was stopped; the review ended after",
      );
    } finally {
      delete process.env.FAKE_CLAUDE_SLEEP;
    }
  });

  test("a non-zero exit is a failed review, not a crash", async () => {
    const dir = scratch();
    process.env.FAKE_CLAUDE_EXIT = "3";
    try {
      const result = await runClaude({
        bin: FAKE,
        ghBin: "/usr/bin/gh",
        repo: "acme/api",
        cwd: dir,
        prompt: "/review-pr acme/api#42",
        timeoutMs: 5_000,
        logPath: join(dir, "run.log"),
      });
      expect(result).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    } finally {
      delete process.env.FAKE_CLAUDE_EXIT;
    }
  });

  /**
   * The three ways a review ends, each asserted the same way: a tool left in
   * the review's process group must not still be acting once the run is over.
   *
   * Without the group this is exactly what happens — the grandchild reparents
   * to init and writes a second later — and it would make two of Engwire's
   * promises false at once, since the next review starts while the last one can
   * still post. A descendant that deliberately `setsid`s out of the group is
   * outside what this claims; see the note in `run.ts`.
   */
  for (const [ending, sleep, timeoutMs] of [
    ["the review times out", "30", 150],
    ["Claude exits on its own", "0", 5_000],
  ] as const) {
    test(`kills lingering processes in the review group when ${ending}`, async () => {
      const dir = scratch();
      const marker = join(dir, "leaked.txt");
      Object.assign(process.env, { LEAKY_MARKER: marker, LEAKY_SLEEP: sleep, LEAKY_BUN: BUN });
      try {
        const result = await runClaude({
          bin: LEAKY,
          ghBin: "/usr/bin/gh",
          repo: "acme/api",
          cwd: dir,
          prompt: "ignored",
          timeoutMs,
          logPath: join(dir, "run.log"),
        });
        expect(result.timedOut).toBe(timeoutMs === 150);
      } finally {
        for (const key of ["LEAKY_MARKER", "LEAKY_SLEEP", "LEAKY_BUN"]) delete process.env[key];
      }

      // The leaked tool waits a second before it acts, so this outlasts it.
      await Bun.sleep(1_500);
      expect(existsSync(marker)).toBe(false);
    });
  }

  test("kills lingering processes in the review group when the runner is stopped", async () => {
    // The runner has to be its own process to be signalled the way a terminal
    // or launchd would signal it. The leaked tool ignores SIGTERM, because a
    // runner that re-raised its own termination immediately would pass this
    // against a tool that simply obeyed.
    const dir = scratch();
    const marker = join(dir, "leaked.txt");
    const log = join(dir, "run.log");
    const runner = Bun.spawn({
      cmd: [BUN, resolve(import.meta.dir, "../../test/fixtures/runner.ts"), LEAKY, log],
      cwd: dir,
      env: {
        ...process.env,
        LEAKY_BUN: BUN,
        LEAKY_MARKER: marker,
        LEAKY_IGNORE: "1",
        LEAKY_DELAY: "2000",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    // The tool announces itself once it is ignoring SIGTERM, so the signal
    // lands on a review that is genuinely stubborn.
    await awaitReady(runner, `${marker}.ready`, 10_000);
    runner.kill("SIGTERM");
    await runner.exited;
    expect(runner.signalCode).toBe("SIGTERM");

    await Bun.sleep(2_500);
    expect(existsSync(marker)).toBe(false);
    // And the transcript says which of the endings this was. A signalled
    // `claude` and one that chose to exit non-zero are the same number to a
    // shell, and this file is the only thing anybody opens afterwards — a
    // review that stops because the machine was going down should not read as
    // a review that failed.
    expect(await Bun.file(log).text()).toContain(
      "[engwire] the runner was stopped by SIGTERM; the review ended after",
    );
  });

  test("reports the shutdown that stopped the review, not the deadline it outlived", async () => {
    // Both are true when a machine goes down shortly before a review's
    // deadline: the shutdown stops it, and the run-timeout timer fires anyway
    // while the review is still winding up. Whichever came first is what
    // happened, and the later one must not rewrite it — here, in the one line
    // of the transcript that Engwire writes rather than the agent. The review ignores SIGTERM so the deadline has
    // something to pass while the shutdown is still in progress.
    //
    // The three timings are one ordering, and it has to hold under load or the
    // test asserts about the wrong first cause: readiness gives up well before
    // the deadline it must precede, and the review outlives the deadline it has
    // to be signalled across.
    const dir = scratch();
    const log = join(dir, "run.log");
    const ready = join(dir, "ready.txt");
    const runner = Bun.spawn({
      cmd: [BUN, resolve(import.meta.dir, "../../test/fixtures/runner.ts"), STUBBORN, log],
      cwd: dir,
      env: {
        ...process.env,
        STUBBORN_BUN: BUN,
        STUBBORN_READY: ready,
        STUBBORN_MS: "5000",
        RUNNER_TIMEOUT_MS: "4000",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    // Readiness was 106-289 ms over five runs, so 1.5 s is generous and still
    // nowhere near the 4 s deadline. It has to be real time: a budget counted
    // in sleeps requested would run out after the deadline it is protecting,
    // leaving the timeout as the genuine first cause and this test asserting
    // about a different run than the one it describes.
    await awaitReady(runner, ready, 1_500);
    runner.kill("SIGTERM");
    await runner.exited;

    const transcript = await Bun.file(log).text();
    expect(transcript).toContain("[engwire] the runner was stopped by SIGTERM; the review ended after");
    expect(transcript).not.toContain("run_timeout");
    // Its own deadline: the review deliberately outlives a 4-second one, so the
    // default per-test limit would call a passing test a timeout.
  }, 15_000);

  test("strips every relative entry from the agent's PATH", async () => {
    // The agent's cwd is a checkout of the pull request, so a relative PATH
    // entry is a directory the contributor controls. Verified against a real
    // shell: `.`, a bare subdirectory, and a leading or trailing `:` all
    // execute a file from the checkout.
    expect(agentPath("gh", ".:relative:/usr/bin::/opt/bin:")).toBe("/usr/bin:/opt/bin");
    expect(agentPath("/opt/homebrew/bin/gh", ".:/usr/bin")).toBe("/opt/homebrew/bin:/usr/bin");
    // Already present: prepended once, not duplicated.
    expect(agentPath("/usr/bin/gh", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
    expect(agentPath("gh", "")).toBe("");
  });

  test("hands Claude a PATH that cannot reach the checkout", async () => {
    // The reviewer's own PATH is the threat here, so the test supplies a bad
    // one rather than trusting the machine it runs on to have a good one.
    const dir = scratch();
    await Bun.write(join(dir, "gh"), "#!/bin/sh\necho pwned\n");
    const log = join(dir, "run.log");
    const real = process.env.PATH;
    process.env.PATH = `.:tools:${real}:`;

    try {
      await runClaude({
        bin: FAKE,
        ghBin: "gh",
        repo: "acme/api",
        cwd: dir,
        prompt: "/review-pr acme/api#42",
        timeoutMs: 5_000,
        logPath: log,
      });
    } finally {
      process.env.PATH = real;
    }

    const line = (await Bun.file(log).text())
      .split("\n")
      .find((entry) => entry.startsWith("PATH: "));
    expect(line).toBeDefined();
    const entries = line!.slice(6).split(":");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(isAbsolute(entry)).toBe(true);
  });
});

describe("reviewPrompt", () => {
  test("names the skill and the pull request", () => {
    // The revision is named: a skill reaching for `gh pr diff` would otherwise
    // see whatever GitHub considers current, not the checkout it stands in.
    expect(reviewPrompt("review-payments", "acme/payments", 7, "c".repeat(40))).toBe(
      `/review-payments acme/payments#7 at ${"c".repeat(40)}`,
    );
  });
});
