import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { agentPath, reviewPrompt, runClaude } from "./run.ts";

const FAKE = resolve(import.meta.dir, "../../test/fixtures/claude");
const LEAKY = resolve(import.meta.dir, "../../test/fixtures/leaky");
const BUN = process.execPath;

const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "engwire-claude-"));
  scratches.push(dir);
  return dir;
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
    process.env.GH_REPO = "someone/else";
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
      delete process.env.GH_REPO;
    }
    expect(await Bun.file(log).text()).toContain("GH_REPO: acme/api");
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
    for (let waited = 0; !existsSync(`${marker}.ready`); waited += 25) {
      if (waited > 10_000) throw new Error("the leaked tool never became ready");
      await Bun.sleep(25);
    }
    runner.kill("SIGTERM");
    await runner.exited;
    expect(runner.signalCode).toBe("SIGTERM");

    await Bun.sleep(2_500);
    expect(existsSync(marker)).toBe(false);
  });

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
