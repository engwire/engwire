import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGh, GH_TIMEOUT_MS, GhError } from "./gh.ts";

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
echo "$GH_HOST"
`,
);
chmodSync(bin, 0o755);

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("createGh", () => {
  test("pins GH_HOST over whatever the caller's environment says", async () => {
    const gh = createGh(bin, { PATH: process.env.PATH, GH_HOST: "github.acme.example" });
    expect((await gh.text(["api", "user"])).trim()).toBe("github.com");
  });

  test("a non-zero gh is a GhError carrying what went wrong", async () => {
    // The type the loop's outage policy is keyed on: a `GhError` waits for the
    // next poll, anything else takes the runner down.
    const gh = createGh(bin, { PATH: process.env.PATH });
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
    const gh = createGh(bin, { PATH: process.env.PATH }, 1_000);
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
    const gh = createGh(bin, { PATH: process.env.PATH });
    const error = await gh.text(["signal"]).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("ended by SIGTERM");
  });

  test("wraps invalid JSON in a GhError", async () => {
    // A bare `SyntaxError` would be treated as a local failure.
    const gh = createGh(bin, { PATH: process.env.PATH });
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
      const poisoned = createGh("gh", { PATH: `.:${join(dir, "nowhere")}` });
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
      expect((await createGh("gh", { PATH: dir }).text(["api", "user"])).trim()).toBe("github.com");
    } finally {
      process.chdir(cwd);
    }
  });
});
