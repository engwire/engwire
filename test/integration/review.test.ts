/**
 * @file The behaviour the whole product is: a review request becomes a review,
 * exactly once, against the right revision, in a checkout of Engwire's own.
 *
 * Real git and a real SQLite database; `gh` and `claude` are fixture
 * executables, because those are the two boundaries a test cannot cross.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseConfig, type Config } from "../../src/config/config.ts";
import { paths, type Paths } from "../../src/config/paths.ts";
import { git } from "../../src/git/repository.ts";
import { createGh } from "../../src/github/gh.ts";
import { executeRun, type Runtime } from "../../src/review/execute.ts";
import { runLoop, tickOnce } from "../../src/review/loop.ts";
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

/**
 * Two repositories, each with an outstanding request of its own; `first` is the
 * one asked for earlier, so the queue order is the test's rather than the
 * clock's. `"same instant"` leaves the event ids as the only thing separating
 * them. One `pr view` answers for both, which is all these cases need.
 */
async function writeTwoRepos(
  first: "acme/api" | "acme/legacy" | "same instant",
  events = { api: 1, legacy: 2 },
): Promise<void> {
  const earlier = new Date(Date.now() - 60_000);
  const later = new Date();
  const at = (repo: "acme/api" | "acme/legacy") =>
    first === "same instant" ? later : first === repo ? earlier : later;
  await writeGitHub({ sha: origin.sha, events: [] });
  await Bun.write(
    join(ghDir, "search.json"),
    JSON.stringify([
      { number: 42, repository: { nameWithOwner: "acme/api" } },
      { number: 7, repository: { nameWithOwner: "acme/legacy" } },
    ]),
  );
  await Bun.write(
    join(ghDir, "timeline-acme-api.json"),
    JSON.stringify([reviewRequest(events.api, at("acme/api"))]),
  );
  await Bun.write(
    join(ghDir, "timeline-acme-legacy.json"),
    JSON.stringify([reviewRequest(events.legacy, at("acme/legacy"))]),
  );
}

/** `acme/api` names a skill that is not installed; `acme/legacy` names one that is. */
const ONE_BROKEN_RULE =
  `[[review]]\nrepos = ["acme/api"]\nskill = "not-installed"\n\n` +
  `[[review]]\nrepos = ["acme/legacy"]\nskill = "review-pr"\n`;

/** Both repositories, each with its own skill. `acme/legacy` is matched first. */
const TWO_RULES =
  `[[review]]\nrepos = ["acme/legacy"]\nskill = "review-legacy"\n\n` +
  `[[review]]\nrepos = ["acme/*"]\nskill = "review-pr"\n`;

/** A skill of the reviewer's own, in the configuration directory of this test. */
function installSkill(name: string): string {
  const skills = join(dir, "claude", "skills", name);
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "SKILL.md"), `---\nname: ${name}\n---\n\nReview it.\n`);
  return skills;
}

function runtime(config: Config, signal = new AbortController().signal): Runtime {
  return {
    store,
    config,
    paths: p,
    gh: createGh(join(FIXTURES, "gh")),
    login: "me",
    log: () => {},
    cloneUrlFor: () => origin.url,
    signal,
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
  // The reviewer's own skills, in a directory of this test's own: a rule names
  // a skill, and the runner refuses to claim work against one that is not
  // installed. Left to the machine's real `~/.claude`, every test here would
  // pass or hold depending on who ran it.
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  installSkill("review-pr");
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
  delete process.env.CLAUDE_CONFIG_DIR;
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

  test("the daemon holds the repository whose skill is missing, and reviews the other", async () => {
    // Fault isolation, through the loop the service actually runs: one rule
    // whose skill is not there holds the repositories that rule names, and
    // leaves every other review alone. A global fail-stop would turn a typo in
    // an unrelated rule into an outage. The held request is the older one, so
    // without the hold it is the review this cycle would claim.
    await writeTwoRepos("acme/legacy");

    const controller = new AbortController();
    const rt = runtime(config(TWO_RULES), controller.signal);
    // One cycle: the loop does not await the review it starts, so the review
    // finishing is what says the cycle is done.
    rt.log = (message) => {
      if (message.startsWith("completed ")) controller.abort();
    };

    await runLoop(rt);

    const byRepo = new Map(store.recentRuns().map((run) => [run.repo, run]));
    expect(byRepo.get("acme/api")).toMatchObject({ status: "completed", skill: "review-pr" });
    expect(byRepo.get("acme/legacy")).toMatchObject({
      status: "queued",
      skill: "review-legacy",
    });

    const invocations = await claudeInvocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toContain("/review-pr acme/api#42");
  });

  test("one cycle is one review, however much is queued", async () => {
    // `run --once` is documented as one poll and at most one review. Draining
    // the queue instead would claim the second run on the first poll's
    // evidence, which is hours old by the time a backlog reaches it.
    await writeTwoRepos("acme/api");
    installSkill("review-legacy");

    await tickOnce(runtime(config(TWO_RULES)));

    const byRepo = new Map(store.recentRuns().map((run) => [run.repo, run]));
    expect(byRepo.get("acme/api")).toMatchObject({ status: "completed" });
    expect(byRepo.get("acme/legacy")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(1);
  });

  test("the daemon takes the preflight after its last identity check, not before", async () => {
    // Same window as the `tickOnce` case below, in the loop the service runs.
    // `acme/legacy` is the older request, so it is what this cycle would claim
    // — and its skill disappears while the final `gh` call is in flight.
    await writeTwoRepos("acme/legacy");
    installSkill("review-legacy");

    const controller = new AbortController();
    const rt = runtime(config(TWO_RULES), controller.signal);
    const gh = rt.gh;
    let logins = 0;
    rt.gh = {
      ...gh,
      login: async () => {
        const account = await gh.login();
        if (++logins === 2) {
          rmSync(join(dir, "claude", "skills", "review-legacy"), {
            recursive: true,
            force: true,
          });
        }
        return account;
      },
    };
    rt.log = (message) => {
      if (message.startsWith("completed ")) controller.abort();
    };

    await runLoop(rt);

    const byRepo = new Map(store.recentRuns().map((run) => [run.repo, run]));
    expect(byRepo.get("acme/legacy")).toMatchObject({ status: "queued" });
    expect(byRepo.get("acme/api")).toMatchObject({ status: "completed" });
    const invocations = await claudeInvocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toContain("/review-pr acme/api#42");
  });

  test("a skill deleted while the identity check is in flight is not claimed", async () => {
    // The preflight is the last thing before the claim precisely because of
    // this window: taken before the `gh` subprocess that verifies the account,
    // it would answer about a filesystem that then had that subprocess's worth
    // of time to change — and the run would be claimed against a skill Claude
    // no longer has, exit 0, and be recorded `completed`.
    await queueRun("racing", 53);

    const rt = runtime(config());
    const gh = rt.gh;
    let logins = 0;
    rt.gh = {
      ...gh,
      login: async () => {
        const account = await gh.login();
        // The second call is the one immediately before the claim.
        if (++logins === 2) rmSync(join(dir, "claude", "skills", "review-pr"), {
          recursive: true,
          force: true,
        });
        return account;
      },
    };

    await tickOnce(rt);

    expect(store.get("racing")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("a skill that disappears while the checkout is prepared is not reviewed", async () => {
    // The window the pre-claim check cannot cover, and the reason the check is
    // taken twice: `prepareRevision` clones on first use of a repository, so
    // minutes of network can separate the claim from the agent that needs the
    // skill. `cloneUrlFor` is called as the checkout begins, which makes the
    // disappearance deterministic without a test-only seam.
    await queueRun("racing-checkout", 55);

    const rt = runtime(config());
    rt.cloneUrlFor = () => {
      rmSync(join(dir, "claude", "skills", "review-pr"), { recursive: true, force: true });
      return origin.url;
    };

    await tickOnce(rt);

    // Given back, not failed: nothing ran and nothing posted, so the request is
    // still outstanding and the next poll holds it.
    // The claim is back and the checkout is gone: this tick's reaper found the
    // deadline the release left on it. Private source does not wait on a rule
    // nobody is going to fix.
    expect(store.get("racing-checkout")).toMatchObject({
      status: "queued",
      startedAt: null,
      worktreePath: null,
    });
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("a poll taken while a review was running cannot be claimed from", async () => {
    // Polling continues during a review, deliberately. But what such a poll
    // sees was seen while that review could still change GitHub: it posts, and
    // the request it answers stops being outstanding. So a cycle that began
    // busy reconciles and waits — the claim belongs to a poll taken with
    // nothing running.
    await writeTwoRepos("acme/api", { api: 9, legacy: 10 });

    const controller = new AbortController();
    const rt = runtime(config(), controller.signal);
    rt.config.advanced.pollIntervalMs = 1;

    let releasePoll = () => {};
    const suspended = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let searches = 0;
    const gh = rt.gh;
    rt.gh = {
      ...gh,
      json: async <T,>(args: string[]) => {
        if (args[0] === "search") {
          searches += 1;
          // The second cycle's poll overlaps the first review and is released
          // by its completion; the third is where the loop stops, before it
          // can legitimately claim what the second could not.
          if (searches === 2) await suspended;
          if (searches === 3) controller.abort();
        }
        return gh.json<T>(args);
      },
    };
    rt.log = (message) => {
      if (message.startsWith("completed ")) releasePoll();
    };

    await runLoop(rt);

    const byRepo = new Map(store.recentRuns().map((run) => [run.repo, run]));
    expect(byRepo.get("acme/api")).toMatchObject({ status: "completed" });
    // Never claimed at all, rather than claimed and given back: a run released
    // before its agent keeps the checkout and the cleanup deadline that
    // claiming it created, so those are what tell the two apart.
    expect(byRepo.get("acme/legacy")).toMatchObject({
      status: "queued",
      worktreePath: null,
      retainUntil: null,
    });
    expect(await claudeInvocations()).toHaveLength(1);
  });

  test("a review that breaks while the next poll is suspended stops the runner", async () => {
    // The loop does not await the review it starts, so a rejection can land
    // anywhere in the next cycle — including while its poll is waiting on
    // GitHub. Noticed only at the top of the iteration after that, the runner
    // would claim one more review first, then throw and leave it running,
    // unawaited, and free to post.
    await writeTwoRepos("acme/api", { api: 9, legacy: 10 });

    const controller = new AbortController();
    const rt = runtime(config(), controller.signal);
    rt.config.advanced.pollIntervalMs = 1;

    // A store that fails while writing the outcome is the one failure
    // `executeRun` does not model, so it is what a rejection escaping it looks
    // like. It lands after a real checkout and a real agent, which is what puts
    // it inside the next poll rather than before it.
    const failure = new Error("the database stopped answering");
    let releasePoll = () => {};
    const suspended = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const shim: Store = Object.create(store);
    shim.finish = () => {
      releasePoll();
      throw failure;
    };
    rt.store = shim;

    let polls = 0;
    const gh = rt.gh;
    rt.gh = {
      ...gh,
      json: async <T,>(args: string[]) => {
        // A search is what starts a cycle; the timeline reads that follow are
        // the same one still going. The second cycle waits for the review the
        // first started to break.
        if (args[0] === "search" && ++polls === 2) await suspended;
        return gh.json<T>(args);
      },
    };

    await expect(runLoop(rt)).rejects.toThrow(failure);

    const byRepo = new Map(store.recentRuns().map((run) => [run.repo, run]));
    expect(byRepo.get("acme/legacy")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(1);
  });

  test("a shutdown asked for while the checkout is prepared does not start the agent", async () => {
    // `runClaude` can forward a signal to a review that is already running;
    // this is the window before there is one to forward to. Starting here
    // commits the next twenty minutes to work launchd is already counting down
    // to kill, and `ExitTimeOut` then has to wait all of it out.
    await queueRun("racing-shutdown", 57);

    const controller = new AbortController();
    const rt = runtime(config(), controller.signal);
    rt.cloneUrlFor = () => {
      controller.abort();
      return origin.url;
    };

    await tickOnce(rt);

    // The claim is back and the checkout carries its cleanup deadline. It is
    // not reclaimed here: a cycle that has been asked to stop does not stay to
    // run `git worktree prune`, and the next start's first idle tick will.
    expect(store.get("racing-shutdown")).toMatchObject({ status: "queued", startedAt: null });
    expect(store.get("racing-shutdown")?.retainUntil).not.toBeNull();
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("a cycle asked to stop before it claims claims nothing", async () => {
    // `run --once` is one cycle, and Ctrl-C during its poll has to mean the
    // same thing there as it does in the daemon.
    await queueRun("stopped-early", 58);
    const controller = new AbortController();
    controller.abort();

    await tickOnce(runtime(config(), controller.signal));

    expect(store.get("stopped-early")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("an account switched while the checkout is prepared does not review", async () => {
    // The same window as the skill above, for the other piece of evidence the
    // claim rests on. `gh auth switch` here would have the skill post the
    // review as whoever `gh` is now — a request accepted on someone else's
    // behalf, answered in their name.
    await queueRun("racing-account", 56);

    const rt = runtime(config());
    rt.cloneUrlFor = () => {
      process.env.FAKE_GH_LOGIN = "someone-else";
      return origin.url;
    };

    try {
      await tickOnce(rt);
    } finally {
      process.env.FAKE_GH_LOGIN = "me";
    }

    expect(store.get("racing-account")).toMatchObject({
      status: "queued",
      startedAt: null,
      worktreePath: null,
    });
    expect(await claudeInvocations()).toHaveLength(0);
  });

  test("the run preflighted is the run claimed when only the event id orders them", async () => {
    // The scan stops at the first queued run whose skill passes, because that
    // is the row `claimNext` takes — an invariant two Store queries hold by
    // sorting alike. Both requests arrive in the same instant, so only the
    // event id separates them, and "9" sorts after "10" unless it is compared
    // as a number. Were the two queries to disagree, this preflights 10 and
    // claims 9.
    await writeTwoRepos("same instant", { api: 9, legacy: 10 });

    await tickOnce(runtime(config(ONE_BROKEN_RULE)));

    const byRepo = new Map(store.recentRuns().map((run) => [run.repo, run]));
    expect(byRepo.get("acme/api")).toMatchObject({ status: "queued", skill: "not-installed" });
    expect(byRepo.get("acme/legacy")).toMatchObject({ status: "completed" });
    const invocations = await claudeInvocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toContain("/review-pr acme/legacy#7");
  });

  test("a rule naming an uninstalled skill reviews nothing and consumes nothing", async () => {
    // The one failure a review cannot report: `claude -p` prints
    // `Unknown command:` for a skill it does not have and exits 0, which would
    // be recorded as a completed review of a request GitHub will not send
    // again. So the skill is checked before the claim, and the run waits.
    await writeGitHub({ sha: origin.sha, events: [reviewRequest(1, new Date())] });

    await tickOnce(
      runtime(config(`[[review]]\nrepos = ["acme/*"]\nskill = "not-installed"\n`)),
    );

    expect(store.recentRuns()[0]).toMatchObject({ status: "queued", skill: "not-installed" });
    expect(await claudeInvocations()).toHaveLength(0);

    // Installed, and the same queued run is claimed on the next tick.
    mkdirSync(join(dir, "claude", "skills", "not-installed"), { recursive: true });
    writeFileSync(
      join(dir, "claude", "skills", "not-installed", "SKILL.md"),
      "---\nname: not-installed\n---\n",
    );
    await tickOnce(
      runtime(config(`[[review]]\nrepos = ["acme/*"]\nskill = "not-installed"\n`)),
    );

    expect(store.recentRuns()[0]).toMatchObject({ status: "completed", eventId: "1" });
    expect(await claudeInvocations()).toHaveLength(1);
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
  async function queueRun(
    id: string,
    eventId: number,
    over: { skill?: string; pullNumber?: number; requestedAt?: string } = {},
  ) {
    store.insert({
      id,
      eventId: String(eventId),
      repo: "acme/api",
      pullNumber: over.pullNumber ?? 42,
      headSha: origin.sha,
      title: "Add widgets",
      skill: over.skill ?? "review-pr",
      status: "queued",
      detail: null,
      requestedAt: over.requestedAt ?? new Date().toISOString(),
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

  test("an account switched during the poll is noticed before the claim", async () => {
    // The interval the first check cannot cover. A poll takes seconds, and
    // `gh auth switch` inside them would have the review post as whoever gh is
    // now — spending a request that was accepted on someone else's behalf.
    await queueRun("switched", 52);

    const rt = runtime(config());
    const polling = rt.gh;
    rt.gh = {
      ...polling,
      json: async <T,>(args: string[]) => {
        const result = await polling.json<T>(args);
        process.env.FAKE_GH_LOGIN = "someone-else";
        return result;
      },
    };

    try {
      await tickOnce(rt);
    } finally {
      process.env.FAKE_GH_LOGIN = "me";
    }

    expect(store.get("switched")).toMatchObject({ status: "queued" });
    expect(await claudeInvocations()).toHaveLength(0);
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
