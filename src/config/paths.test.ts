import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { absolutePath, locationProblem, privateDir } from "./paths.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-paths-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("privateDir", () => {
  test("creates a directory with mode 0700", () => {
    const made = join(dir, "data");
    privateDir(made);

    expect(mode(made)).toBe(0o700);
  });

  test("sets mode 0700 on an existing directory too", () => {
    // `mkdir` applies its mode only to directories it creates.
    const existing = join(dir, "data");
    mkdirSync(existing, { recursive: true });
    chmodSync(existing, 0o755);

    privateDir(existing);

    expect(mode(existing)).toBe(0o700);
  });

  test("leaves a directory reached through a link to whoever owns it", () => {
    // `chmod` follows a link — measured — so this would reach through and
    // tighten a directory somebody moved their data to. Engwire supports that
    // arrangement; it does not own the far end of it.
    const theirs = join(dir, "theirs");
    mkdirSync(theirs, { recursive: true });
    chmodSync(theirs, 0o755);
    symlinkSync(theirs, join(dir, "data"));

    privateDir(join(dir, "data"));

    expect(mode(theirs)).toBe(0o755);
    // And the link is still the route to it. Replacing it with a fresh local
    // directory would leave the target at 0755 too, while quietly undoing the
    // arrangement — Engwire would look like a new installation next to the
    // data it stopped using.
    expect(realpathSync(join(dir, "data"))).toBe(realpathSync(theirs));
  });

  test("leaves a parent it did not create alone", () => {
    // Only the named directory is tightened. `~/.local/share` is the data
    // directory's parent and belongs to more than Engwire, so a helper that
    // walked up would take somebody else's directory with it.
    const shared = join(dir, "shared");
    mkdirSync(shared, { recursive: true });
    chmodSync(shared, 0o755);

    privateDir(join(shared, "engwire"));

    expect(mode(shared)).toBe(0o755);
    expect(mode(join(shared, "engwire"))).toBe(0o700);
  });

  test("creates intermediate directories with mode 0700", () => {
    privateDir(join(dir, "data", "worktrees"));

    expect(mode(join(dir, "data"))).toBe(0o700);
    expect(mode(join(dir, "data", "worktrees"))).toBe(0o700);
  });
});

describe("absolutePath", () => {
  test("drops every entry that names a directory relative to the caller", () => {
    // The working directory can be a checkout of the branch under review, so a
    // relative entry is a directory a contributor controls. The empty field a
    // leading or trailing `:` produces is one of them.
    expect(absolutePath(".:/usr/bin:tools:/bin:")).toBe("/usr/bin:/bin");
    expect(absolutePath(":/usr/bin")).toBe("/usr/bin");
    expect(absolutePath("..:./x:x/y")).toBe("");
  });

  test("an empty PATH stays empty rather than becoming a relative one", () => {
    expect(absolutePath("")).toBe("");
  });
});

describe("paths", () => {
  test.each([
    ["set to nothing", { HOME: "" }],
    ["not set at all", { HOME: undefined }],
  ])("finds an absolute config file when HOME is %s", async (_name, home) => {
    // `homedir()` reads the startup environment, so exercise the fallback in a
    // child. Bun and Node disagree on the empty-HOME case; the measured result
    // and the risk of a relative path are recorded in docs/experiments.md.
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `import { paths } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};
         console.log(paths({}).configFile);`,
      ],
      env: { ...process.env, ...home },
      // Anywhere but here. A child with no usable `HOME` resolves *its own*
      // caches relative to the working directory, so run from the repository
      // this left a `Library/` in it on every suite run — untracked junk in the
      // one place this project reviews its work. It also sharpens the
      // assertion: a relative answer is obviously wrong from a directory that
      // is not the source tree.
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "inherit",
    });
    const [configFile, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(isAbsolute(configFile.trim())).toBe(true);
  });
});

describe("locationProblem", () => {
  test.each([
    ["ENGWIRE_HOME", { ENGWIRE_HOME: "engwire-bob" }],
    ["XDG_DATA_HOME", { XDG_DATA_HOME: "share", HOME: "/Users/dev" }],
    ["XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "cfg", HOME: "/Users/dev" }],
  ])("names %s when it points somewhere relative", (name, env) => {
    // The README offers `ENGWIRE_HOME` as the way to keep a second
    // installation, so a relative one is a thing somebody types, not an exotic
    // environment. Neither answer may move with the working directory, and they
    // move differently: a relative data base is a second installation per
    // directory, while a relative config base changes which automation rules
    // one installation reads. The test below holds those two apart.
    const problem = locationProblem(env);

    expect(problem).toContain(name);
    expect(problem).toContain("absolute path");
  });

  test.each([
    ["absolute throughout", { ENGWIRE_HOME: "/opt/engwire" }],
    ["empty, which falls back like an unset one", { XDG_DATA_HOME: "", HOME: "/Users/dev" }],
  ])("accepts an environment that is %s", (_name, env) => {
    expect(locationProblem(env)).toBeNull();
  });

  test("does not call a relative config directory a second installation", () => {
    // Both refusals are right, but they are not the same fault. With the data
    // directory absolute, the database, the lock and the clones stay at one
    // address: two shells read different rules, they do not answer the same
    // review request twice.
    const problem = locationProblem({
      XDG_CONFIG_HOME: "cfg",
      XDG_DATA_HOME: "/var/lib/engwire",
      HOME: "/Users/dev",
    });

    expect(problem).toContain("XDG_CONFIG_HOME");
    expect(problem).not.toContain("two installations");
  });

  test("blames the variable that decided, not one it shadows", () => {
    // `ENGWIRE_HOME` outranks both XDG bases in `paths`, so an absolute one
    // makes a relative `XDG_DATA_HOME` beside it irrelevant rather than wrong.
    expect(locationProblem({ ENGWIRE_HOME: "/opt/engwire", XDG_DATA_HOME: "share" })).toBeNull();
  });
});
