import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGh, GH_TIMEOUT_MS, GhAnswerError, GhError } from "./gh.ts";

// A local gh stub exercises environment pinning and subprocess failures.
// These tests make no GitHub requests.
const dir = mkdtempSync(join(tmpdir(), "engwire-gh-"));
const bin = join(dir, "gh");
writeFileSync(
  bin,
  `#!/bin/sh
[ "$1" = "fail" ] && { echo "could not resolve host" >&2; exit 4; }
[ "$1" = "hang" ] && { echo $$ > "${dir}/hang.pid"; trap "" TERM; sleep 5 & wait; }
[ "$1" = "signal" ] && { echo >&2; kill -TERM $$; sleep 5; }
# A wrapper that exits 0 saying nothing, or saying something that is not a
# login. Tested for being set rather than non-empty, since empty is the case
# that matters most and a plain -n cannot tell it from unset.
[ -n "\${FAKE_GH_ANSWER+set}" ] && { printf '%s' "$FAKE_GH_ANSWER"; exit 0; }
echo "$GH_HOST"
`,
);
chmodSync(bin, 0o755);

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("createGh", () => {
  test("pins GH_HOST over whatever the caller's environment says", async () => {
    const gh = createGh(bin, { env: { PATH: process.env.PATH, GH_HOST: "github.acme.example" } });
    expect((await gh.text(["api", "user"])).trim()).toBe("github.com");
  });

  test("a non-zero gh is a GhError carrying what went wrong", async () => {
    // The type the loop's outage policy is keyed on: a `GhError` waits for the
    // next poll, anything else takes the runner down.
    const gh = createGh(bin, { env: { PATH: process.env.PATH } });
    const error = await gh.text(["fail"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect(error).toMatchObject({ args: ["fail"], exitCode: 4 });
    expect((error as GhError).message).toContain("could not resolve host");
  });

  test("the production deadline is two minutes", () => {
    expect(GH_TIMEOUT_MS).toBe(2 * 60_000);
  });

  test("a gh past its deadline is a GhError, and the gh itself is stopped", async () => {
    // The stub ignores SIGTERM and leaves a child holding its pipes for five
    // seconds. The one-second deadline allows time to write the pid file while
    // requiring the call to return before that child closes the pipes.
    // Remove an earlier invocation's pid before starting this one.
    const pidfile = join(dir, "hang.pid");
    rmSync(pidfile, { force: true });
    const gh = createGh(bin, { env: { PATH: process.env.PATH }, timeoutMs: 1_000 });
    const error = await gh.text(["hang"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("no answer within 1s");
    expect((error as GhError).exitCode).toBeNull();

    // The caller does not wait for the kill to finish. Poll ps for termination;
    // kill(pid, 0) also succeeds for zombies awaiting reaping.
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    let state = "alive";
    for (let attempt = 0; attempt < 50 && state !== "" && !state.startsWith("Z"); attempt++) {
      if (attempt > 0) await Bun.sleep(20);
      state = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
    }

    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  test("reports signal termination when stderr says nothing", async () => {
    const gh = createGh(bin, { env: { PATH: process.env.PATH } });
    const error = await gh.text(["signal"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("ended by SIGTERM");
  });

  test("wraps invalid JSON in a GhError", async () => {
    // A bare `SyntaxError` would be treated as a local failure.
    const gh = createGh(bin, { env: { PATH: process.env.PATH } });
    const error = await gh.json(["api", "user"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("expected JSON");
    expect((error as GhError).message).toContain("github.com");
  });

  test("a bare gh is never resolved from the working directory", async () => {
    // The runner is a command someone types, so its working directory can be a
    // contributor's checkout — and `gh_bin` is legitimately a bare `gh`. With
    // `.` on their PATH, a `gh` committed to that branch would run the moment
    // discovery polls, before any review has been decided on. `Bun.spawn`
    // resolves a bare command through the PATH it is handed, so handing it a
    // filtered one is what closes this.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const poisoned = createGh("gh", { env: { PATH: `.:${join(dir, "nowhere")}` } });
      const error = await poisoned.text(["api", "user"]).then(
        () => null,
        (thrown: unknown) => thrown,
      );

      // Not found, rather than found and executed: the fixture `gh` sitting in
      // this very directory prints on success, so a pass here is the absence of
      // that.
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("gh");
      // The same call with the relative entry honoured is what this prevents.
      const honoured = await createGh("gh", { env: { PATH: dir } }).text(["api", "user"]);
      expect(honoured.trim()).toBe("github.com");
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("a gh the caller stops", () => {
  test("refuses to start once the caller has already stopped", async () => {
    // The same reason `git` refuses one: a listener added to an aborted signal
    // never fires, so this would spawn a `gh` nothing could hurry and then wait
    // out the full deadline — during a shutdown, which is when it costs most.
    const pidfile = join(dir, "hang.pid");
    rmSync(pidfile, { force: true });
    const gh = createGh(bin, { env: { PATH: process.env.PATH }, signal: AbortSignal.abort() });

    const error = await gh.text(["hang"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("stopped before it started");
    expect(existsSync(pidfile)).toBe(false);
  });

  test("returns when stopped, instead of waiting out the deadline", async () => {
    // The gap this closes: `runLoop` checks for a shutdown after every awaited
    // step, but the identity check runs immediately before the agent spawns, so
    // a `gh` already in flight would otherwise hold the stop for the whole of
    // GH_TIMEOUT_MS. The production deadline is deliberately left in place here
    // — two minutes is what the call would take without the signal.
    const pidfile = join(dir, "hang.pid");
    rmSync(pidfile, { force: true });
    const controller = new AbortController();
    const gh = createGh(bin, { env: { PATH: process.env.PATH }, signal: controller.signal });
    const running = gh.text(["hang"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    // The stub is up, so the abort has a process to reach rather than racing it.
    while (!existsSync(pidfile)) await Bun.sleep(10);
    const startedAt = Date.now();
    controller.abort();
    const error = await running;

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("stopped before it answered");
    expect((error as GhError).exitCode).toBeNull();
    // That it returns at all, and quickly. What this does *not* prove is that
    // the reads were cancelled: `abandon` rejects the race directly, so the
    // call comes back at the same speed either way. Measured, and further than
    // this file — deleting the cancels leaves the entire suite green, so
    // nothing at this call site holds them to account and `read-text.test.ts`
    // is where that happens.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("login", () => {
  test.each([
    ["nothing at all", ""],
    ["only whitespace", "   \n"],
    ["something with a space in it", "not a login\n"],
    // A wrapper that dropped the `--jq` and handed back the body.
    ["a whole JSON object", '{"login":"alice","id":1}\n'],
    ["a quoted string", '"alice"\n'],
    // The empty answer in a costume: no whitespace and no object punctuation,
    // so only the opening bracket tells it apart from a name.
    ["an empty JSON array", "[]\n"],
    ["a one-element JSON array", "[123]\n"],
    // The one that arrives by accident: a wrapper that lets colour through.
    // It carries no space, no JSON punctuation and no leading bracket, so only
    // the control characters themselves tell it from a name — and bound, it
    // matches no reviewer and cannot be undone.
    ["an account wrapped in colour codes", "\u001b[32malice\u001b[0m\n"],
    ["an account carrying a C1 line break", "al\u0085ice\n"],
  ])("refuses a gh that answers %s", async (_name, answer) => {
    // This value is an identity, not a string: it is written to the database
    // once and never moved, discovery matches it against
    // `requested_reviewer.login`, and the runner refuses to start under any
    // other account. An empty one was recorded as the owner, matched no
    // reviewer so nothing was ever reviewed, and then failed the next run's
    // insert on the primary key — a silent installation that could not be
    // started again even after `gh` was fixed.
    const gh = createGh(bin, { env: { PATH: process.env.PATH, FAKE_GH_ANSWER: answer } });

    const error = await gh.login().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    // A `GhError`, so `accountMatches` still holds a review rather than taking
    // the runner down mid-checkout — but its own type, because this is not an
    // outage: waiting cannot repair a `gh_bin` wrapper, and both `run` and
    // `doctor` would otherwise report it as GitHub being unreachable.
    expect(error).toBeInstanceOf(GhAnswerError);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("expected a GitHub login");
  });

  test.each([
    ["an ordinary login, hyphens and all", "octo-cat-99"],
    // Refusing this is why the rule is drawn around response shapes rather
    // than around GitHub's username grammar: a token-authenticated app answers
    // with a name that grammar rejects, and this repository's own pull
    // requests are opened by one.
    ["a token-authenticated app", "engwire-agent[bot]"],
  ])("accepts %s", async (_name, answer) => {
    const gh = createGh(bin, {
      env: { PATH: process.env.PATH, FAKE_GH_ANSWER: `${answer}\n` },
    });

    expect(await gh.login()).toBe(answer);
  });
});
