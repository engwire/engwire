/**
 * @file The composition root, driven as a process.
 *
 * `engwire run` installs the signal handlers, and `runClaude` re-raises the
 * signal it forwarded once the review's process group is gone. Whether those
 * two agree can only be observed from outside the process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KILL_GRACE_MS } from "../../src/claude/run.ts";
import { paths } from "../../src/config/paths.ts";
import { Store } from "../../src/store/store.ts";
import { createOrigin, type Origin } from "../fixtures/repo.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
/**
 * The CLI under test: the source tree, or the compiled binary when one is
 * named.
 *
 * What ships is a single file produced by `bun build --compile`, and every
 * other test in this repository runs the source. Signals, process groups and
 * SQLite are exactly the things that could behave differently once the runtime
 * is embedded, and they are exactly what this file exercises — so CI points
 * this at `dist/` and runs it a second time.
 */
const CLI = process.env.ENGWIRE_TEST_BIN
  ? [process.env.ENGWIRE_TEST_BIN]
  : ["bun", resolve(import.meta.dir, "../../src/main.ts")];

let dir: string;
let ghDir: string;
let home: string;
let claudeLog: string;
let origin: Origin;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "engwire-cli-"));
  ghDir = join(dir, "gh");
  home = join(dir, "home");
  claudeLog = join(dir, "claude.log");
  mkdirSync(ghDir, { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "config.toml"),
    `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n\n` +
      `[advanced]\ngh_bin = "${join(FIXTURES, "gh")}"\nclaude_bin = "${join(FIXTURES, "claude")}"\n`,
  );
  mkdirSync(join(dir, "claude", "skills", "review-pr"), { recursive: true });
  writeFileSync(
    join(dir, "claude", "skills", "review-pr", "SKILL.md"),
    "---\nname: review-pr\n---\n\nReview it.\n",
  );
  origin = await createOrigin(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Nothing outstanding on GitHub: the runner starts, polls and waits. */
function noWork(): void {
  writeFileSync(join(ghDir, "search.json"), "[]");
}

/**
 * One outstanding request, and a git that quietly resolves `acme/api` to the
 * fixture origin.
 *
 * The rewrite lives in the child's own global git config, so the runner still
 * computes exactly the URL it computes in production — this is git's own test
 * seam rather than an escape hatch in Engwire.
 */
function oneRequest(): string {
  writeFileSync(
    join(ghDir, "search.json"),
    JSON.stringify([{ number: 42, repository: { nameWithOwner: "acme/api" } }]),
  );
  writeFileSync(
    join(ghDir, "pr.json"),
    JSON.stringify({
      headRefOid: origin.sha,
      isDraft: false,
      title: "Add widgets",
      isCrossRepository: false,
      closed: false,
      reviewRequests: [{ login: "me" }],
    }),
  );
  writeFileSync(
    join(ghDir, "events.json"),
    JSON.stringify([
      {
        id: 1,
        event: "review_requested",
        created_at: new Date().toISOString(),
        commit_id: null,
        requested_reviewer: { login: "me" },
      },
    ]),
  );

  const gitconfig = join(dir, "gitconfig");
  writeFileSync(
    gitconfig,
    `[url "${origin.url}"]\n\tinsteadOf = https://github.com/acme/api.git\n`,
  );

  // Watching began before the request, which is otherwise older than the
  // watermark the first runner writes.
  const store = new Store(paths({ ENGWIRE_HOME: home }).dbFile);
  store.watchingSince(new Date(Date.now() - 3_600_000));
  store.close();

  return gitconfig;
}

function start(
  env: Record<string, string> = {},
  args: string[] = ["run"],
  /** Piped only where a test reads it: an unread pipe is a child that blocks. */
  captureStderr = false,
) {
  return Bun.spawn({
    cmd: [...CLI, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: captureStderr ? "pipe" : "inherit",
    env: {
      ...process.env,
      ENGWIRE_HOME: home,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      FAKE_GH_DIR: ghDir,
      FAKE_GH_LOGIN: "me",
      FAKE_CLAUDE_RECORD: claudeLog,
      ...env,
    },
  });
}

/** Read through the watching announcement, retaining earlier startup messages. */
async function waitForWatching(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  try {
    while (!seen.includes("watching review requests")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`runner exited before watching: ${seen}`);
      seen += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return seen;
}

/** The agent records itself before it blocks, so the file is the marker. */
async function waitForAgent(): Promise<void> {
  while (!(existsSync(claudeLog) && readFileSync(claudeLog, "utf8").length > 0)) {
    await Bun.sleep(20);
  }
}

describe("engwire run", () => {
  test(
    "an idle runner asked to stop exits as stopped, not as finished",
    async () => {
      // 143 is 128 + SIGTERM. Exiting 0 would tell launchd, and anyone
      // scripting this, that the run completed.
      noWork();
      const proc = start();
      await waitForWatching(proc.stdout);

      proc.kill("SIGTERM");

      expect(await proc.exited).toBe(143);
    },
    20_000,
  );

  test(
    "an interrupt during a gh call exits as stopped, not as a GitHub failure",
    async () => {
      // `--once` awaits `gh` directly, so the shutdown signal now reaches an
      // invocation already in flight and it comes back as a rejection rather
      // than as the `aborted` check the surrounding code used to rely on. The
      // daemon has its own answer to that — `waitForLogin` returns, `runLoop`
      // treats it as a poll with no answer — and this command has none, so a
      // Ctrl-C during the login would otherwise be reported as a GitHub error
      // and exit 1. 130 is 128 + SIGINT, and the exit status is an API.
      noWork();
      const started = join(dir, "gh-login-started");
      const proc = start({ FAKE_GH_HANG_LOGIN: started }, ["run", "--once"]);

      // The `gh` is up and blocked, so the signal lands inside it.
      while (!existsSync(started)) await Bun.sleep(20);
      proc.kill("SIGINT");

      expect(await proc.exited).toBe(130);
    },
    20_000,
  );

  test(
    "a fresh installation says where its watching starts, once",
    async () => {
      // A command that prints nothing at all is indistinguishable from one that
      // never ran, and this is the command someone types right after editing
      // config.toml — so the runner that sets the watermark says where it put
      // it. Only that one: the boundary never moves again.
      noWork();
      const first = start({}, ["run", "--once"]);
      const [firstOut, firstCode] = await Promise.all([
        new Response(first.stdout).text(),
        first.exited,
      ]);

      expect(firstCode).toBe(0);
      expect(firstOut).toContain("polling once for me");
      expect(firstOut).toContain("watching from now");

      // Said once, ever: the watermark is fixed at the first runner, and a
      // notice repeated every poll is a notice nobody reads.
      const second = start({}, ["run", "--once"]);
      const [secondOut, secondCode] = await Promise.all([
        new Response(second.stdout).text(),
        second.exited,
      ]);

      expect(secondCode).toBe(0);
      expect(secondOut).toContain("polling once for me");
      expect(secondOut).not.toContain("watching from now");
    },
    20_000,
  );

  test(
    "a GitHub failure in one-shot mode is an answer, not a stack trace",
    async () => {
      // No search fixture, so the fake `gh` exits non-zero — a rate limit or an
      // expired token looks the same from here. The daemon waits those out;
      // this is the command someone runs to find out whether their setup works,
      // and it should say what went wrong and stop.
      const proc = start({}, ["run", "--once"], true);
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("gh search");
      expect(stderr).not.toContain("GhError:");
    },
    20_000,
  );

  test(
    "a runner that starts during a GitHub outage waits for it to end",
    async () => {
      // Startup invocation failures must recover in the same daemon. The
      // malformed-answer test below pins the exception to that retry policy.
      noWork();
      writeFileSync(
        join(home, "config", "config.toml"),
        readFileSync(join(home, "config", "config.toml"), "utf8") + 'poll_interval = "5s"\n',
      );
      const askedAt = Date.now();
      const proc = start({ FAKE_GH_FAIL_LOGIN_ONCE: join(dir, "gh-failed-once") }, ["run"]);

      const said = await waitForWatching(proc.stdout);

      // It waited a poll interval before asking again. Without that the retry
      // is immediate, and a laptop that is offline for an hour spends it
      // spawning `gh` as fast as the machine allows — the busy loop this
      // function exists to avoid, which recovering-in-the-end cannot see.
      // Config's floor for `poll_interval` is 5s, so this is the cheapest
      // version of that wait. Startup time is included, so sufficiently heavy
      // load could hide a missing retry delay.
      expect(Date.now() - askedAt).toBeGreaterThanOrEqual(4_500);

      // Named the outage on the way, so the wait is not a silent one.
      expect(said).toContain("waiting for GitHub");
      // And said where watching starts before it started waiting, because that
      // is when the watermark was written. Announcing it after the account is
      // known would name a boundary as far past the real one as the outage was
      // long. One ordered match rather than two indexes: a missing line indexes
      // to -1, which is less than everything.
      expect(said).toMatch(/watching from now[\s\S]*waiting for GitHub/);

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(143);
    },
    20_000,
  );

  test(
    "a gh that answers with something other than an account is not waited out",
    async () => {
      // Only the daemon waits, so only the daemon can wait forever — `--once`
      // asks `gh` once and reports. A `gh_bin` wrapper that dropped `--jq`
      // answers the whole JSON document, exits 0, and will go on answering it
      // every poll for as long as anybody leaves the runner up: nothing about
      // that repairs itself, and the retry that is right for an outage is
      // wrong here. Before this it was worse than a wait — the empty answer
      // was recorded as the installation's owner.
      noWork();
      const proc = start({ FAKE_GH_LOGIN: '{"login":"me"}' }, ["run"], true);
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("expected a GitHub login");
    },
    20_000,
  );

  test(
    "a stop during the first login is not reported as GitHub being unreachable",
    async () => {
      // The runner's `gh` carries the shutdown, so a Ctrl-C waiting on the
      // first login comes back as a failed `gh` call — indistinguishable from
      // the outage this loop exists to wait out. Reported, it is the last line
      // a runner prints on its way to a clean exit, and it names a problem with
      // GitHub that never happened.
      noWork();
      const started = join(dir, "gh-login-started");
      const proc = start({ FAKE_GH_HANG_LOGIN: started }, ["run"], true);

      while (!existsSync(started)) await Bun.sleep(20);
      proc.kill("SIGINT");
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(130);
      expect(stdout + stderr).not.toContain("waiting for GitHub");
      // The watermark was written before this runner ever reached GitHub, and
      // it is written once — so a runner that dies here without saying where
      // watching starts leaves nobody to say it later.
      expect(stdout).toContain("watching from now");
    },
    20_000,
  );

  test(
    "an installation bound to something that is not an account says how to get out",
    async () => {
      // An owner that is not an account matches no reviewer, and the binding is
      // written once and never moved: an installation that does nothing and
      // cannot be talked out of it. `gh.login()` refuses such an answer now, so
      // this branch exists only to be the way out of a database already holding
      // one — and being the way out is the whole of its job, since no `gh auth
      // switch` can match an owner that is not an account. `doctor` reports the
      // same state, but this is the command someone runs when nothing happens.
      noWork();
      const store = new Store(paths({ ENGWIRE_HOME: home }).dbFile);
      try {
        store.bindReviewer("");
      } finally {
        store.close();
      }

      const proc = start({}, ["run", "--once"], true);
      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("is not a GitHub account");
      // The recoverable half: without it the reader is told they are stuck.
      expect(stderr).toContain("engwire uninstall --yes");
      // And not the advice for an ordinary account mismatch, which cannot help.
      expect(stderr).not.toContain("gh is authenticated as");
    },
    20_000,
  );

  test(
    "a runner stopped mid-review ends with the review, and leaves it recoverable",
    async () => {
      // The composition this exists to protect. `runClaude` takes the review's
      // process group down and then re-raises the signal, which ends the runner
      // only if the CLI's own handler has already stepped aside. Swallowed, the
      // runner would unwind normally and file the killed review as an ordinary
      // failure — spending a request that startup recovery would otherwise
      // reopen as `interrupted`.
      const gitconfig = oneRequest();
      const proc = start({ GIT_CONFIG_GLOBAL: gitconfig, FAKE_CLAUDE_SLEEP: "30" });
      await waitForAgent();

      const askedAt = Date.now();
      proc.kill("SIGTERM");
      await proc.exited;
      const took = Date.now() - askedAt;

      expect(proc.signalCode).toBe("SIGTERM");

      // The runner's own teardown, not the whole grace it is allowed. This
      // agent dies on the signal, so forward it, notice the group is gone,
      // re-raise should finish in milliseconds; reaching `KILL_GRACE_MS` would
      // mean the runner had stopped noticing the exit and was leaning on the
      // SIGKILL escalation instead. `launchd.test.ts` holds the other half —
      // `ExitTimeOut`'s headroom stays above the same grace — because a bound
      // that size is one this test's own timeout would reach first.
      expect(took, `shutdown took ${took}ms of a ${KILL_GRACE_MS}ms grace`).toBeLessThan(
        KILL_GRACE_MS,
      );

      const store = new Store(paths({ ENGWIRE_HOME: home }).dbFile);
      try {
        // Still `running`: the runner died with it rather than recording an
        // outcome nobody observed.
        const run = store.recentRuns()[0];
        expect(run).toMatchObject({ repo: "acme/api", status: "running" });

        // Which is exactly why the transcript has to say so itself. The row
        // stays `running` deliberately, so nothing in the database explains
        // this log — and the agent's own output just stops, the same way it
        // stops on a clean finish. `runClaude` writes one line for each of the
        // four endings; the other three are pinned in `claude/run.test.ts`,
        // and this is the only place the signalled one can be reached.
        const transcript = await Bun.file(paths({ ENGWIRE_HOME: home }).runLog(run!.id)).text();
        expect(transcript).toContain("[engwire] the runner was stopped by SIGTERM");
      } finally {
        store.close();
      }
    },
    30_000,
  );
});

describe("engwire doctor", () => {
  test(
    "doctor exits when it is done, not when its probe deadlines elapse",
    async () => {
      // Both ways this broke were about the event loop rather than the await,
      // so neither is visible in process: a ref'd timer left every healthy
      // probe holding the loop for the whole deadline (measured: a 0.07s
      // `doctor` became a 20s one), and a read nobody cancelled kept the
      // command alive until a descendant let go of the pipe (measured: 40s
      // against a 20s deadline). The race resolving is not the process
      // exiting, which is why this spawns one.
      const startedAt = Date.now();
      const proc = start({}, ["doctor"]);
      const report = await new Response(proc.stdout).text();

      await proc.exited;

      // Rows only a finished probe can produce, because a `doctor` that fell
      // over before spawning anything would also exit well inside the deadline
      // — and pass a test that only watched the clock. The exit status cannot
      // stand in for them: the fixture `gh` is not authenticated, so a healthy
      // run here reports that and exits 1.
      expect(report).toContain("✓ claude auth");
      expect(report).toContain("✓ git ");
      // Comfortably under the production deadline, and nowhere near a multiple
      // of it: the fixture binaries answer at once, so anything approaching
      // 20s means something is being waited on that already has its answer.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    },
    30_000,
  );
});
