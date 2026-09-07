import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../config/paths.ts";
import { acquireLock } from "../service/lock.ts";
import { Store } from "../store/store.ts";
import { VERSION } from "../version.ts";
import { ago, logsNote, status, versionRemedy, nothingRunYet } from "./status.ts";

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-status-"));
  home = join(dir, "home");
  process.env.ENGWIRE_HOME = home;
  mkdirSync(paths().dataDir, { recursive: true });
});

afterEach(async () => {
  delete process.env.ENGWIRE_HOME;
  await rm(dir, { recursive: true, force: true });
});

/** Run `status` and return everything it printed, joined. */
async function report(): Promise<string> {
  const log = console.log;
  let said = "";
  console.log = (message: unknown) => {
    said += `${message}\n`;
  };
  try {
    expect(await status()).toBe(0);
    return said;
  } finally {
    console.log = log;
  }
}

/**
 * A queued run, spelling out only what a test actually cares about.
 *
 * The same shape `store.test.ts` uses. Most tests here differ from each other
 * in one field — a hostile title, an old timestamp, a long repository name —
 * and twelve lines of identical scaffolding around it hid which one.
 */
type QueuedSeed = Extract<Parameters<Store["insert"]>[0], { status: "queued" }>;

function seedRun(store: Store, over: Partial<QueuedSeed> = {}): void {
  store.insert({
    id: "run-1",
    eventId: "evt-1",
    repo: "acme/api",
    pullNumber: 42,
    headSha: "a".repeat(40),
    title: "Add widgets",
    skill: "review-pr",
    status: "queued",
    detail: null,
    requestedAt: "2026-08-01T10:00:00Z",
    createdAt: "2026-08-01T10:00:00Z",
    ...over,
  });
}

describe("status", () => {
  test("a pull request title cannot rewrite the report around it", async () => {
    // Titles are written by whoever opened the pull request, and `status`
    // prints them to a terminal. A title that clears the screen, returns the
    // cursor to the start of the line, or breaks it with a C1 NEL would let a
    // contributor forge the rows above their own. `stripANSI` handles the first
    // and leaves the other two — U+0085 among the 26 C1 characters it passes
    // through — which is what the second pass is for.
    const store = new Store(paths().dbFile);
    seedRun(store, {
      title: "\u001b[2Jwiped\rforged\u0085next\u009b[31mred",
    });
    store.close();

    const said = await report();

    // The words survive — this sanitises the output, it does not censor it.
    expect(said).toContain("wiped");
    expect(said).toContain("forged");
    // Only the newlines this capture added: nothing a terminal would act on.
    expect(said.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("a title cannot reverse the line it is printed on", async () => {
    // The other half of the same attack, and `stripANSI` sees none of it: a
    // bidirectional override reorders what a terminal draws after it, so a
    // title can display as words nobody wrote — including a repository or a
    // status the reader is about to trust. The joiner an ordinary emoji is
    // built from is deliberately left alone, so a family survives intact.
    const store = new Store(paths().dbFile);
    seedRun(store, {
      title: "fix \u202erev\u202c \u2066iso\u2069 \u061calm \u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
    });
    store.close();

    const said = await report();

    // The whole `Bidi_Control` set. U+061C is the one that does not live beside
    // the others, and a set missing a member is a filter with a way through it.
    expect(said).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    // Censoring the reordering characters, not the emoji that merely joins.
    expect(said).toContain("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}");
  });

  test("a title of emoji is measured as a terminal draws it, not in pieces", async () => {
    // Width is not additive over the parts of a character: `\u2764` is one
    // column and the variation selector after it is none, but together they are
    // the two-column `\u2764\ufe0f` a keyboard actually produces. Summed a
    // piece at a time, thirty of them read as thirty and print as sixty — the
    // same table-breaking overflow the CJK case below is about, arrived at from
    // the opposite direction.
    const store = new Store(paths().dbFile);
    seedRun(store, {
      title: "\u2764\ufe0f".repeat(30),
    });
    store.close();

    const said = await report();
    const row = said.split("\n").find((line) => line.includes("acme/api#42"))!;

    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(110);
    expect(row).toContain("\u2026");
  });

  test("dates every row and says where the runner's own output is", async () => {
    // A finished run is dated by its outcome, not by when it was queued: the
    // two can be twenty minutes apart, and only one of them answers "is this
    // report stale?".
    const store = new Store(paths().dbFile);
    seedRun(store, {
      title: "Fix the thing",
      requestedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });
    store.claimNext({ now: new Date(Date.now() - 90 * 60_000) });
    store.finish("run-1", "completed", null);
    store.close();

    const said = await report();

    expect(said).toContain("just now");
    expect(said).not.toContain("3h ago");
    expect(said).toContain(paths().logsDir);
  });

  test("the age column descends, whatever order the rows arrived in", async () => {
    // The test above dates one row by its outcome; this is what that costs if
    // the list is still ordered by arrival. A review asked for two hours ago
    // and finished just now is the most recent thing here, and printed under a
    // request that has only been sitting for thirty minutes it makes the one
    // column the reader scans read as unsorted — so the report's own claim,
    // that it says whether anything has happened lately, stops being legible.
    const store = new Store(paths().dbFile);
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    for (const [id, when] of [
      ["old", minutesAgo(120)],
      ["new", minutesAgo(30)],
    ] as const) {
      seedRun(store, {
        id,
        eventId: `evt-${id}`,
        pullNumber: id === "old" ? 1 : 2,
        title: `The ${id} one`,
        requestedAt: when,
        createdAt: when,
      });
    }
    // The oldest request is claimed first, and finishes last.
    expect(store.claimNext({ now: new Date(Date.now() - 60 * 60_000) })?.id).toBe("old");
    store.finish("old", "completed", null);
    store.close();

    const said = await report();
    // Lower case, so the trailer's "Queued work follows…" is not a row.
    const rows = said.split("\n").filter((line) => /\b(queued|completed)\b/.test(line));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("completed");
    expect(rows[0]).toContain("just now");
    expect(rows[1]).toContain("queued");
    expect(rows[1]).toContain("30m ago");
  });

  test("says when a poll last got through, so a wedged runner is visible", async () => {
    // The runner row says a process is alive, which is not the same as it
    // getting anywhere: one held since Tuesday because `gh` is signed in as
    // somebody else reads exactly like one working through a quiet queue, and
    // the rows below look the same under both. Without this line the two states
    // are the same report.
    const store = new Store(paths().dbFile);
    store.recordPoll(new Date(Date.now() - 2 * 86_400_000));
    store.close();

    expect(await report()).toContain("Polled    2d ago");
  });

  test("a poll that has never happened says so rather than looking recent", async () => {
    // A fresh installation, and the state a runner sits in while it waits for
    // GitHub to answer for the first time. "just now" would be a claim that
    // something worked.
    new Store(paths().dbFile).close();

    expect(await report()).toContain("Polled    never");
  });

  test("two repositories sharing a long prefix do not print as the same row", async () => {
    // A provider family — `-aws`, `-gcp` — is a naming convention, not bad
    // luck, and the tail is the whole of what tells them apart. Cut there, both
    // pull requests print identically in the column that exists to say which
    // one this is, and the reader has no way to tell which is stuck.
    const store = new Store(paths().dbFile);
    for (const [n, repo] of [
      "acme/cluster-api-provider-aws",
      "acme/cluster-api-provider-gcp",
    ].entries()) {
      seedRun(store, {
        id: `run-${n}`,
        eventId: `evt-${n}`,
        repo,
        title: "Bump the provider",
      });
    }
    store.close();

    const said = await report();
    const rows = said.split("\n").filter((line) => line.includes("Bump the provider"));

    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toBe(rows[1]);
    // Specifically the half that differs, rather than merely differing
    // somewhere: the owner they share is not what the reader is looking for.
    expect(said).toContain("-aws#42");
    expect(said).toContain("-gcp#42");
  });

  test("the review being run now cannot be pushed off the report", async () => {
    // The table is ordered by activity and capped, so a review that started
    // twenty minutes ago sits below everything queued or dismissed since —
    // and polling deliberately continues while it runs. Past the cap it is
    // gone, and "Runner running" says a process is alive, not what it is
    // spending its one execution slot on.
    const store = new Store(paths().dbFile);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    seedRun(store, {
      id: "run-current",
      eventId: "evt-current",
      title: "The one actually being reviewed",
      requestedAt: at(21),
      createdAt: at(21),
    });
    // Through the transition the runner uses, so the row is running for the
    // reason a real one is and carries the started_at the report reads.
    store.claimNext({ now: new Date(Date.now() - 20 * 60_000) });
    for (let n = 0; n < 15; n++) {
      store.insert({
        id: `run-${n}`,
        eventId: `evt-${n}`,
        repo: "acme/web",
        pullNumber: n,
        headSha: "b".repeat(40),
        title: "Arrived while that one was running",
        skill: null,
        status: "dismissed",
        detail: "no_automation",
        requestedAt: at(10),
        createdAt: at(10),
      });
    }
    store.close();

    const release = acquireLock(paths().lockFile);
    let said: string;
    try {
      said = await report();
    } finally {
      release();
    }

    // Evicted from the table, which is the ordering working as intended.
    expect(said).not.toContain("The one actually being reviewed");
    // And still named, because that is the question this report opens with.
    expect(said).toContain("Review    acme/api#42 claimed 20m ago");
  });

  test("a review left running by a crash is not called current work", async () => {
    // The lock is what says a runner is alive. Without it a row still marked
    // running is wreckage the next start clears up, and announcing it as the
    // thing being reviewed now would invent the one fact this line exists to
    // give. The row itself is still history, and still shown as such.
    const store = new Store(paths().dbFile);
    seedRun(store, {
      id: "run-orphan",
      eventId: "evt-orphan",
      title: "Interrupted by a crash",
    });
    store.claimNext();
    store.close();

    // No lock taken: nothing is running.
    const said = await report();

    expect(said).toContain("Runner    stopped");
    expect(said).not.toContain("Review    ");
    expect(said).toContain("Interrupted by a crash");
  });

  test("a long repository name cannot shift the column beside it", async () => {
    const store = new Store(paths().dbFile);
    for (const [n, repo] of ["acme/api", "kubernetes-sigs/cluster-api-provider-aws"].entries()) {
      seedRun(store, {
        id: `run-${n}`,
        eventId: `evt-${n}`,
        repo,
        pullNumber: 12345,
        title: "Same title",
      });
    }
    store.close();

    const said = await report();
    const rows = said.split("\n").filter((line) => line.includes("Same title"));

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.indexOf("Same title"))).size).toBe(1);
    // Whatever the name gave up, the pull number is still there — a row that
    // has lost it identifies nothing.
    for (const row of rows) expect(row).toContain("#12345");
  });

  test("names the version the running runner is actually on", async () => {
    // An upgrade replaces the binary on disk and leaves the supervised process
    // running the one it opened — deliberately, since a review may be in
    // flight. The consequence is a runner that can be months behind the
    // `engwire` you just typed, which nothing else on the machine reports.
    const store = new Store(paths().dbFile);
    store.recordRunner({ pid: 4242, startedAt: new Date().toISOString(), version: "0.0.1" });
    store.close();

    const release = acquireLock(paths().lockFile);
    try {
      const said = await report();

      expect(said).toContain("running 0.0.1");
      expect(said).toContain(`runner 0.0.1, this engwire ${VERSION}`);
      // No remedy from a source checkout, which is what a test run is:
      // `service install` refuses one, so suggesting it would be advice that
      // cannot be taken.
      expect(said).not.toContain("engwire service install");
    } finally {
      release();
    }
  });

  test("a runner on this version is not worth a word", async () => {
    const store = new Store(paths().dbFile);
    store.recordRunner({ pid: 4242, startedAt: new Date().toISOString(), version: VERSION });
    store.close();

    const release = acquireLock(paths().lockFile);
    try {
      const said = await report();

      expect(said).toContain(`running ${VERSION}`);
      expect(said).not.toContain("the runner is on");
    } finally {
      release();
    }
  });

  test("a note rides along, a sentence gets its own line", async () => {
    // The row's columns already total 93 at their widest. A detail long enough
    // to push past the terminal is wrapped mid-word by the terminal, through
    // the one part of the row that was trying to explain something.
    const store = new Store(paths().dbFile);
    for (const [n, title] of ["Add idempotency keys to the refund endpoint", "Bump deps"].entries()) {
      seedRun(store, {
        id: `run-${n}`,
        eventId: `evt-${n}`,
        repo: "acme/payments-platform",
        pullNumber: 1284 + n,
        title,
        requestedAt: `2026-08-0${n + 1}T10:00:00Z`,
        createdAt: `2026-08-0${n + 1}T10:00:00Z`,
      });
    }
    const claimed = store.claimNext()!;
    store.finish(claimed.id, "completed", "no transcript written; the review may not have run");
    store.finish("run-1", "dismissed", "superseded_by_newer");
    store.close();

    const said = await report();
    const lines = said.split("\n");

    // The sentence is on a line of its own, indented under the status column.
    expect(said).toContain("\n          no transcript written");
    // The short reason still rides on the end of its row.
    expect(lines.some((line) => line.includes("Bump deps  replaced by a newer request"))).toBe(
      true,
    );
    // And nothing per-run runs away with the terminal — continuation lines
    // included, which is where an unbounded `git` error would have gone. Paths
    // are exempt: they cannot be broken, and there is one per report rather
    // than one per row.
    const perRun = lines.filter((line) => !line.startsWith("Logs") && line.trim() !== "");
    expect(perRun.length).toBeGreaterThan(2);
    for (const line of perRun) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(110);
  });

  test("a full title sends even the shortest reason to its own line", async () => {
    // The threshold is arithmetic, not intent: a full row is 93 columns, so the
    // shortest dismissal reason needs 111 and the longest 122 — all of them
    // past `ROW`. A comment claiming any of them rides along beside a full
    // title was wrong by one column, and only a short title ever proved it.
    const store = new Store(paths().dbFile);
    seedRun(store, {
      title: "Add idempotency keys to the refund endpoint and backfill the ledger",
    });
    store.finish("run-1", "dismissed", "no_automation");
    store.close();

    const said = await report();
    const lines = said.split("\n");
    const row = lines.find((line) => line.includes("acme/api#42"))!;

    expect(Bun.stringWidth(row)).toBe(93);
    expect(row).not.toContain("no matching rule");
    expect(said).toContain("\n          no matching rule");
  });

  test("a title measured in characters would take the columns after it", async () => {
    // `.length` and a terminal disagree exactly where a table falls apart: CJK
    // is two columns per character, so forty of them is eighty, and every
    // column to the right of the title moves.
    const store = new Store(paths().dbFile);
    seedRun(store, {
      title: "修复退款端点的幂等性问题并补充测试用例以及文档说明和更多的内容".repeat(2),
    });
    store.close();

    const said = await report();
    const row = said.split("\n").find((line) => line.includes("acme/api#42"))!;

    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(110);
    expect(row).toContain("\u2026");
  });

  test("a long failure message is bounded on its own line too", async () => {
    // `git` writes as much as it feels like, and the whole of it is in the log
    // this report already names.
    const store = new Store(paths().dbFile);
    seedRun(store);
    store.claimNext();
    store.finish("run-1", "failed", `checkout failed: ${"fatal: something went wrong. ".repeat(12)}`);
    store.close();

    const said = await report();

    const continuation = said.split("\n").find((line) => line.startsWith("          checkout"))!;

    // The bound `ROW` actually enforces, not a number loose enough to pass
    // whatever the code happens to do: ten columns of indent and no more than
    // the rest of the row.
    expect(Bun.stringWidth(continuation)).toBeLessThanOrEqual(110);
    expect(continuation).toContain("\u2026");
  });
});

describe("before anything has run", () => {
  test("a stopped runner is not sent to a log directory that does not exist", async () => {
    // `service install` is what creates it, so on a machine that has only been
    // set up there is nothing at that path to read — and the line would stand
    // between the reader and the only one here that is a next step.
    const said = await report();

    expect(said).toContain("Runner    stopped");
    expect(said).not.toContain("Logs");
    expect(said).toContain("engwire setup");
  });

  test("a runner that is up says where its output goes, having written nothing else", async () => {
    // The state least likely to explain itself: holding the lock with no
    // database yet, so every row below is missing and its own output is the
    // only account of why.
    const release = acquireLock(paths().lockFile);
    try {
      const said = await report();

      expect(said).toContain("Runner    running");
      expect(said).toContain(paths().logsDir);
      // And not sent to a command the lock will refuse: `run --once` takes the
      // runner lock, which this runner is holding. Advice that cannot be taken
      // is worse than none in the one report somebody reads to get unstuck.
      expect(said).not.toContain("run --once");
      expect(said).toContain("No review history yet.");
    } finally {
      release();
    }
  });

  test("a stopped runner that has been set up is still offered the one poll", async () => {
    // The other side of the line above: with nothing holding the lock, that
    // command is exactly the next step, and this is the state it is for.
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(paths().configFile, "");

    const said = await report();

    expect(said).toContain("Runner    stopped");
    expect(said).toContain("run --once");
  });
});

describe("nothingRunYet", () => {
  test("a machine with no config is sent to setup", () => {
    expect(nothingRunYet(false)).toContain("engwire setup");
  });

  test("a machine that has been set up is sent forward, not back", () => {
    // The database is missing from the moment `setup` finishes until the first
    // runner starts, so this line greets everybody who has just been told setup
    // succeeded. Naming `setup` again there is the one way a first run stalls
    // with every line above it reporting success.
    const said = nothingRunYet(true);

    expect(said).not.toContain("engwire setup");
    expect(said).toContain("engwire run --once");
  });
});

describe("the version row", () => {
  test("stays inside the report's width whatever somebody tagged", async () => {
    // Asked of the report rather than of a line rebuilt here. The previous
    // version of this test assembled the row itself and then guessed which
    // versions might exist, which is how it went on passing while an ordinary
    // pair of prereleases — `0.1.0-beta.123` beside `0.1.0-beta.124` — printed
    // at 112 columns. A date-stamped one reached 130.
    const store = new Store(paths().dbFile);
    store.recordRunner({
      pid: 4242,
      startedAt: new Date().toISOString(),
      // Not a plausible tag: a bound that only holds for versions somebody
      // guessed at is not a bound. Both the runner line and the version line
      // interpolate this straight in, so this is what makes them prove it.
      version: `1.0.0-${"a".repeat(100)}`,
    });
    store.close();

    const release = acquireLock(paths().lockFile);
    try {
      const said = await report();

      expect(said).toContain("1.0.0-aaa");
      // The two lines that interpolate a version, not every line in the
      // report: the `Logs` path is a filesystem path this deliberately does not
      // bound, and it runs within fifteen columns of the limit on this machine
      // — so a longer `TMPDIR` would fail this on something it is not about.
      const lines = said.split("\n");
      for (const label of ["Runner", "Version"]) {
        const line = lines.find((candidate) => candidate.startsWith(label));
        expect(Bun.stringWidth(line ?? ""), line).toBeLessThanOrEqual(110);
        expect(line, `no ${label} line to bound`).toBeDefined();
      }
    } finally {
      release();
    }
  });
});

describe("versionRemedy", () => {
  test("macOS is offered the command that actually restarts the runner", () => {
    expect(versionRemedy(true, "darwin")).toContain("engwire service install");
  });

  test("everywhere else is not handed a launchd-only command", () => {
    // `service install` exits 1 off macOS, so naming it as the remedy for a
    // stale runner would answer a real problem with a command that fails. The
    // supervisor is theirs there, and restarting it is what picks up the new
    // binary.
    const remedy = versionRemedy(true, "linux");

    expect(remedy).not.toContain("engwire service install");
    expect(remedy).toContain("supervisor");
  });

  test("a source checkout is told nothing, because nothing would work", () => {
    // `service install` refuses a source checkout on either platform, so the
    // mismatch is stated bare rather than with advice that cannot be taken.
    for (const platform of ["darwin", "linux"]) {
      expect(versionRemedy(false, platform)).toBe("");
    }
  });
});

describe("logsNote", () => {
  test("macOS is told where launchd put the runner's output", () => {
    // launchd writes `runner.log` into this directory, so the path is the whole
    // answer and a second line would be noise on every report.
    expect(logsNote("/data/logs", "darwin")).toEqual(["Logs      /data/logs"]);
  });

  test("everywhere else is told the directory is not the whole answer", () => {
    // Under systemd the runner's stdout goes to the journal and this directory
    // holds the review transcripts alone — see docs/linux.md.
    const lines = logsNote("/data/logs", "linux");

    expect(lines[0]).toBe("Logs      /data/logs");
    expect(lines[1]).toContain("journalctl --user -u engwire");
    // Indented under the path it qualifies, and inside the same bound as
    // everything else this report prints.
    expect(lines[1]!.startsWith(" ".repeat(10))).toBe(true);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(110);
  });
});

describe("ago", () => {
  const now = Date.parse("2026-08-01T12:00:00Z");

  test("reads as an age at every scale the runner reaches", () => {
    expect(ago("2026-08-01T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-08-01T11:59:00Z", now)).toBe("1m ago");
    expect(ago("2026-08-01T11:01:00Z", now)).toBe("59m ago");
    expect(ago("2026-08-01T11:00:00Z", now)).toBe("1h ago");
    expect(ago("2026-07-31T13:00:00Z", now)).toBe("23h ago");
    expect(ago("2026-07-31T12:00:00Z", now)).toBe("1d ago");
    expect(ago("2025-08-02T12:00:00Z", now)).toBe("364d ago");
    expect(ago("2025-08-01T12:00:00Z", now)).toBe("1y ago");
    // Every answer fits the column the report right-aligns it into.
    expect(ago("2020-01-01T00:00:00Z", now).length).toBeLessThanOrEqual(8);
  });

  test("a clock ahead of ours is not a negative age", () => {
    // `requested_at` comes from GitHub, and a laptop clock drifts. Asked well
    // past a minute as well as inside one: a drift of seconds lands in the
    // "just now" branch whatever the code does about the sign, so only the
    // larger one can tell a handled negative age from an accident.
    expect(ago("2026-08-01T12:00:30Z", now)).toBe("just now");
    expect(ago("2026-08-01T14:00:00Z", now)).toBe("just now");
    expect(ago("2027-08-01T12:00:00Z", now)).toBe("just now");
  });

  test("an unreadable timestamp leaves the column empty rather than lying", () => {
    expect(ago("not a date", now)).toBe("");
  });
});
