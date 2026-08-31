/**
 * @file The behaviour the whole product is: a review request becomes a review,
 * exactly once, against the right revision, in a checkout of Engwire's own.
 *
 * Real git and a real SQLite database; `gh` and `claude` are fixture
 * executables, because those are the two boundaries a test cannot cross.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseConfig, type Config } from "../../src/config/config.ts";
import { paths, type Paths } from "../../src/config/paths.ts";
import { git } from "../../src/git/repository.ts";
import { createGh } from "../../src/github/gh.ts";
import { executeRun, type Runtime } from "../../src/review/execute.ts";
import { tickOnce } from "../../src/review/loop.ts";
import { Store } from "../../src/store/store.ts";
import { createOrigin, type Origin } from "../fixtures/repo.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

let dir: string;
let ghDir: string;
let origin: Origin;
let store: Store;
let p: Paths;
let claudeLog: string;

async function writeGitHub(options: {
  sha: string;
  events: unknown[];
  isDraft?: boolean;
  isFork?: boolean;
  closed?: boolean;
  /** Defaults to the reviewer; `[]` is the request withdrawn since the search. */
  reviewRequests?: { login?: string }[];
}) {
  await Bun.write(
    join(ghDir, "search.json"),
    JSON.stringify([{ number: 42, repository: { nameWithOwner: "acme/api" } }]),
  );
  await Bun.write(
    join(ghDir, "pr.json"),
    JSON.stringify({
      headRefOid: options.sha,
      isDraft: options.isDraft ?? false,
      title: "Add widgets",
      isCrossRepository: options.isFork ?? false,
      closed: options.closed ?? false,
      reviewRequests: options.reviewRequests ?? [{ login: "me" }],
    }),
  );
  await Bun.write(join(ghDir, "timeline.json"), JSON.stringify(options.events));
}

function reviewRequest(id: number, at: Date) {
  return {
    id,
    event: "review_requested",
    created_at: at.toISOString(),
    commit_id: null,
    requested_reviewer: { login: "me" },
  };
}

function runtime(config: Config): Runtime {
  return {
    store,
    config,
    paths: p,
    gh: createGh(join(FIXTURES, "gh")),
    login: "me",
    log: () => {},
    cloneUrlFor: () => origin.url,
  };
}

function config(toml = `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n`): Config {
  const parsed = parseConfig(toml);
  parsed.advanced.claudeBin = join(FIXTURES, "claude");
  return parsed;
}

async function claudeInvocations(): Promise<{ argv: string; cwd: string }[]> {
  const file = Bun.file(claudeLog);
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [argv = "", cwd = ""] = line.split("\t");
      return { argv, cwd };
    });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "engwire-e2e-"));
  ghDir = join(dir, "gh");
  claudeLog = join(dir, "claude.log");
  mkdirSync(ghDir, { recursive: true });

  process.env.ENGWIRE_HOME = join(dir, "home");
  process.env.FAKE_GH_DIR = ghDir;
  process.env.FAKE_GH_LOGIN = "me";
  process.env.FAKE_CLAUDE_RECORD = claudeLog;

  origin = await createOrigin(dir);
  p = paths();
  store = new Store(p.dbFile);
  // Watching began an hour ago, so the fixture's requests are in scope.
  store.watchingSince(new Date(Date.now() - 3_600_000));
});

afterEach(async () => {
  store.close();
  delete process.env.ENGWIRE_HOME;
  delete process.env.FAKE_GH_DIR;
  delete process.env.FAKE_GH_LOGIN;
  delete process.env.FAKE_CLAUDE_RECORD;
  await rm(dir, { recursive: true, force: true });
});

describe("a review request, end to end", () => {
  test("becomes one review, in Engwire's own checkout, at the requested revision", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });

    await tickOnce(runtime(config()));

    const runs = store.recentRuns();
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({
      repo: "acme/api",
      pullNumber: 42,
      headSha: origin.sha,
      skill: "review-pr",
      status: "completed",
      eventId: "1",
    });

    const invocations = await claudeInvocations();
    expect(invocations.length).toBe(1);
    // The revision is in the prompt as well as the checkout: a skill that asks
    // GitHub for the diff would otherwise see whatever is current now.
    expect(invocations[0]?.argv).toBe(
      `--setting-sources user -p /review-pr acme/api#42 at ${origin.sha}`,
    );

    // It ran in a worktree Engwire owns, checked out at the requested commit.
    // realpath both sides: the shell reports a physical path, and macOS puts
    // temporary directories behind a symlink.
    const cwd = invocations[0]?.cwd ?? "";
    expect(cwd.startsWith(realpathSync(dirname(p.worktreeDir("any"))))).toBe(true);
    expect((await git(["rev-parse", "HEAD"], cwd)).trim()).toBe(origin.sha);
  });

  test("polling again does not review it a second time", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });

    await tickOnce(runtime(config()));
    await tickOnce(runtime(config()));

    expect(store.recentRuns().length).toBe(1);
    expect(await claudeInvocations()).toHaveLength(1);
  });

  test("a second request on the same commit is a second review", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });
    await tickOnce(runtime(config()));

    // GitHub clears a reviewer from `requested_reviewers` once they review, so
    // the ask arriving again is a new event, and a new question to answer.
    await writeGitHub({
      sha: origin.sha,
      events: [reviewRequest(1, new Date(Date.now() - 1000)), reviewRequest(2, new Date())],
    });
    await tickOnce(runtime(config()));

    const runs = store.recentRuns();
    expect(runs.map((run) => run.eventId).sort()).toEqual(["1", "2"]);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
    expect(await claudeInvocations()).toHaveLength(2);
  });

  test("a repository no rule names is recorded and left alone", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });

    await tickOnce(
      runtime(config(`[[review]]\nrepos = ["other/*"]\nskill = "review-pr"\n`)),
    );

    expect(store.recentRuns()[0]).toMatchObject({
      status: "dismissed",
      detail: "no_automation",
    });
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("a draft is held, then reviewed once it is ready", async () => {
    // Nothing is recorded while it is a draft: marking one ready does not
    // re-request the reviewers it already had, so a dismissal would consume the
    // only event that will ever arrive.
    const requested = reviewRequest(1, new Date());
    await writeGitHub({ sha: origin.sha, isDraft: true, events: [requested] });

    await tickOnce(runtime(config()));

    expect(store.recentRuns()).toHaveLength(0);
    expect(await claudeInvocations()).toHaveLength(0);

    // The same event, once the pull request is ready.
    await writeGitHub({ sha: origin.sha, isDraft: false, events: [requested] });
    await tickOnce(runtime(config()));

    expect(store.recentRuns()[0]).toMatchObject({ status: "completed", eventId: "1" });
    expect(await claudeInvocations()).toHaveLength(1);
  });

  test("a claimed run with no skill recorded is refused, not guessed at", async () => {
    // A skill decides what an authenticated agent does, so a row that has lost
    // one is a state to stop on rather than fill in.
    //
    // `insert` requires a queued decision to carry its rule's skill, so the cast
    // models a malformed or migrated row that bypassed that type boundary. The
    // type stops normal writes; the guard stops the row being acted on.
    store.insert({
      id: "skill-less",
      eventId: "77",
      repo: "acme/api",
      pullNumber: 42,
      headSha: origin.sha,
      title: "Broken row",
      skill: null as unknown as string,
      status: "queued",
      detail: null,
      requestedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    // Claim directly because reconciliation repairs the row from the current
    // rule before it can be claimed; the guard exists for a malformed row that
    // reached `running` some other way.
    const claimed = store.claimNext();
    expect(claimed?.id).toBe("skill-less");

    await executeRun(runtime(config()), claimed!);

    expect(store.get("skill-less")).toMatchObject({ status: "failed" });
    expect(store.get("skill-less")?.detail).toContain("no skill");
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("a pull request from a fork is recorded and left alone", async () => {
    // Matching `acme/*` says the change is proposed somewhere trusted, not that
    // it came from someone trusted.
    await writeGitHub({
      sha: origin.sha,
      isFork: true,
      events: [reviewRequest(1, new Date())],
    });

    await tickOnce(runtime(config()));

    expect(store.recentRuns()[0]).toMatchObject({ status: "dismissed", detail: "fork" });
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("a failing review is recorded as failed, with its transcript kept", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });
    process.env.FAKE_CLAUDE_EXIT = "2";
    try {
      await tickOnce(runtime(config()));
    } finally {
      delete process.env.FAKE_CLAUDE_EXIT;
    }

    const run = store.recentRuns()[0];
    expect(run).toMatchObject({ status: "failed", detail: "claude exited 2" });
    expect(existsSync(p.runLog(run!.id))).toBe(true);
  });

  /** A queued review whose request is still visible, and therefore eligible. */
  async function queueRun(id: string, eventId: number) {
    store.insert({
      id,
      eventId: String(eventId),
      repo: "acme/api",
      pullNumber: 42,
      headSha: origin.sha,
      title: "Add widgets",
      skill: "review-pr",
      status: "queued",
      detail: null,
      requestedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(eventId, new Date())] });
  }

  test("holds queued work while gh is a different account, and resumes after", async () => {
    // `gh auth switch` can move the active account underneath a queued review.
    // The work waits rather than being consumed: it was accepted on one
    // person's behalf and nothing about it has been done yet.
    await queueRun("held", 50);

    process.env.FAKE_GH_LOGIN = "someone-else";
    try {
      await tickOnce(runtime(config()));
    } finally {
      process.env.FAKE_GH_LOGIN = "me";
    }

    expect(store.get("held")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(0);

    await tickOnce(runtime(config()));

    expect(store.get("held")).toMatchObject({ status: "completed" });
    expect(await claudeInvocations()).toHaveLength(1);
  });

  test("a GitHub outage does not consume work already queued", async () => {
    // The identity check runs before the run is claimed, so an outage leaves it
    // queued. Checked after the claim, `failed` is terminal and the review
    // would be gone for good without Claude ever starting.
    await queueRun("outage", 51);

    process.env.FAKE_GH_FAIL_LOGIN = "1";
    try {
      await tickOnce(runtime(config()));
    } finally {
      delete process.env.FAKE_GH_FAIL_LOGIN;
    }

    expect(store.get("outage")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(0);

    await tickOnce(runtime(config()));
    expect(store.get("outage")).toMatchObject({ status: "completed" });
  });

  test("does not discover anything while gh is a different account", async () => {
    // `--review-requested=@me` means whoever gh is now, so polling under a
    // switched account would search someone else's pull requests and could
    // persist an old request of ours found in one of their timelines.
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });

    process.env.FAKE_GH_LOGIN = "someone-else";
    try {
      await tickOnce(runtime(config()));
    } finally {
      process.env.FAKE_GH_LOGIN = "me";
    }

    expect(store.recentRuns()).toHaveLength(0);
  });

  test("a checkout that failed halfway is still reclaimable", async () => {
    // The path is written down before git touches the disk: a crash in between
    // would otherwise leave a directory no reaper can see.
    await writeGitHub({ sha: "0".repeat(40), events: [reviewRequest(1, new Date())] });

    await tickOnce(runtime(config()));

    const run = store.recentRuns()[0];
    expect(run?.status).toBe("failed");
    expect(run?.detail).toContain("checkout failed");
    expect(run?.retainUntil).not.toBeNull();
  });

  test("a queued review stops if its repository leaves the config", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });
    store.insert({
      id: "stale-run",
      eventId: "99",
      repo: "acme/removed",
      pullNumber: 7,
      headSha: origin.sha,
      title: "Old work",
      skill: "review-pr",
      status: "queued",
      detail: null,
      requestedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    await tickOnce(runtime(config(`[[review]]\nrepos = ["acme/api"]\nskill = "review-pr"\n`)));

    expect(store.get("stale-run")).toMatchObject({
      status: "dismissed",
      detail: "no_automation",
    });
  });

  test("the checkout is reclaimed once its retention elapses", async () => {
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });

    const immediate = config();
    immediate.advanced.worktreeTtlMs = 0;
    await tickOnce(runtime(immediate));

    const run = store.recentRuns()[0];
    expect(run?.status).toBe("completed");
    expect(run?.worktreePath).toBeNull();
    expect(existsSync(p.worktreeDir(run!.id))).toBe(false);
    // The transcript outlives the checkout — it is what the reviewer reads.
    expect(existsSync(p.runLog(run!.id))).toBe(true);
  });
});
