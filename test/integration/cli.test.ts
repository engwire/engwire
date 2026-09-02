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
    join(ghDir, "timeline.json"),
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

/** Read until the runner says it is up; anything slower fails the test's clock. */
async function waitForWatching(stream: ReadableStream<Uint8Array>): Promise<void> {
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

      proc.kill("SIGTERM");
      await proc.exited;

      expect(proc.signalCode).toBe("SIGTERM");

      const store = new Store(paths({ ENGWIRE_HOME: home }).dbFile);
      try {
        // Still `running`: the runner died with it rather than recording an
        // outcome nobody observed.
        expect(store.recentRuns()[0]).toMatchObject({ repo: "acme/api", status: "running" });
      } finally {
        store.close();
      }
    },
    30_000,
  );
});
