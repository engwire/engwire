import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrigin, NO_DEADLINE } from "../../test/fixtures/repo.ts";
import { ensureRepository, git, gitFailureMessage } from "./repository.ts";

let dir: string;
let repoDir: string;
let ghBin: string;
let saved: (string | undefined)[];

// A github.com URL over a clone that already exists: the credential path runs,
// the network does not.
const GITHUB = "https://github.com/acme/api.git";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "engwire-repo-"));
  repoDir = join(dir, "repos", "acme", "api.git");

  // These tests are about what Engwire configures, and one of them is about a
  // helper it must override — so the machine's own git configuration has to be
  // out of the picture, not merely assumed absent.
  // PATH with them: two tests below put a stand-in `git` in front of the real
  // one, and leaking that into the rest of the process would be a long debug.
  saved = [
    process.env.GIT_CONFIG_GLOBAL,
    process.env.GIT_CONFIG_SYSTEM,
    process.env.PATH,
    process.env.GIT_CONFIG_NOSYSTEM,
  ];
  await Bun.write(
    join(dir, "gitconfig"),
    `[credential]\n\thelper = "!printf 'username=inherited\\\\npassword=x\\\\n'"\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";

  // Deliberately awkward: an apostrophe and a space, both of which a shell
  // would mangle if the helper were not quoted.
  const ghDir = join(dir, "o'brien bin");
  mkdirSync(ghDir, { recursive: true });
  ghBin = join(ghDir, "gh");
  await Bun.write(ghBin, "#!/bin/sh\nprintf 'username=engwire\\npassword=y\\n'\n");
  chmodSync(ghBin, 0o755);

  const origin = await createOrigin(dir);
  await ensureRepository({ url: origin.url, dir: repoDir, ghBin, signal: NO_DEADLINE });
});

afterEach(async () => {
  // Assignment would not do: `process.env.X = undefined` stores the *string*
  // "undefined", which git rejects, and every later test in the process
  // inherits it.
  for (const [key, value] of [
    ["GIT_CONFIG_GLOBAL", saved[0]],
    ["GIT_CONFIG_SYSTEM", saved[1]],
    ["GIT_CONFIG_NOSYSTEM", saved[3]],
    ["PATH", saved[2]],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

/** What the clone itself sets, as opposed to what it inherits. */
async function helpers(key = "credential.https://github.com.helper"): Promise<string[]> {
  const out = await git(["config", "--local", "--get-all", key], repoDir, NO_DEADLINE).catch(() => "");
  return out === "" ? [] : out.replace(/\n$/, "").split("\n");
}

/** What git would use for `host`, given everything the clone can see. */
async function fill(host: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", repoDir, "credential", "fill"],
    // Explicit, and load-bearing: an omitted `env` is the environment this
    // process started with, so the `GIT_CONFIG_GLOBAL` set above would not
    // reach git and the fake global helper would be invisible.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: new TextEncoder().encode(`protocol=https\nhost=${host}\n\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  return await new Response(proc.stdout).text();
}

describe("which git runs", () => {
  test("a relative PATH entry cannot put the checkout's own git in front", async () => {
    // `git()` runs with its cwd inside the tree under review — `inertOverrides`
    // reads that repository's config, and `reset --hard` writes it — so a
    // relative entry on the runner's PATH resolves against a directory the
    // contributor controls. Measured, not assumed: with `PATH=".:/usr/bin"` and
    // a cwd holding a `git`, `Bun.spawn(["git"])` ran the one in the cwd.
    //
    // `absolutePath()` is what removes it, and it is tested on its own in
    // `paths.test.ts`. What is missing there, and here until now, is that this
    // boundary *uses* it: the two tests below hand `git` a stand-in through an
    // absolute entry, so both pass just as well against the ambient PATH.
    const checkout = join(dir, "checkout");
    const ran = join(dir, "checkout-git-ran");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "git"), `#!/bin/sh\necho ran > "${ran}"\n`, { mode: 0o755 });
    // Relative first, so an unfiltered PATH finds it before the real one, with
    // the machine's own entries behind it so a filtered PATH still finds git.
    process.env.PATH = `.:${saved[2] ?? ""}`;

    const said = await git(["--version"], checkout, NO_DEADLINE);

    expect(existsSync(ran), "the checkout's git was executed").toBe(false);
    expect(said).toContain("git version");
  });
});

describe("the configuration a git is allowed to find", () => {
  test("a relative config selector cannot be answered by the checkout", async () => {
    // `GIT_CONFIG_GLOBAL` is resolved against the process's working directory
    // — measured — and every git here runs in a directory Engwire chose, one of
    // them a checkout of the branch under review. Honoured relative, a
    // committed `.gitconfig` becomes the reviewer's "global" configuration, and
    // the branch is then configuring the command reading it.
    await Bun.write(join(repoDir, ".gitconfig"), "[branchsupplied]\n\tmarker = yes\n");
    process.env.GIT_CONFIG_GLOBAL = ".gitconfig";

    const answered = await git(["config", "--get", "branchsupplied.marker"], repoDir, NO_DEADLINE)
      .then((value) => value.trim())
      .catch(() => null);

    expect(answered, "the checkout's own .gitconfig was read as global").toBeNull();
  });

  test("a selector it cannot honour is refused, not dropped", async () => {
    // Dropping the variable is not the same as declining the file it names:
    // git falls back to its ordinary global config under `HOME`, which is
    // deliberately still passed through — so a checkout would answer to
    // configuration the caller's own git was never reading. Narrowing is the
    // only direction this filter is allowed to move.
    const home = join(dir, "elsewhere-home");
    mkdirSync(home, { recursive: true });
    await Bun.write(join(home, ".gitconfig"), "[fellback]\n\tmarker = yes\n");
    await Bun.write(join(repoDir, ".gitconfig"), "[branchsupplied]\n\tmarker = yes\n");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = ".gitconfig";

    try {
      const read = (key: string) =>
        git(["config", "--get", key], repoDir, NO_DEADLINE).then(
          (value) => value.trim(),
          () => null,
        );

      expect(await read("branchsupplied.marker"), "the checkout's .gitconfig was read").toBeNull();
      expect(await read("fellback.marker"), "the home global config replaced it").toBeNull();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test("a system file the caller switched off stays off", async () => {
    // `GIT_CONFIG_NOSYSTEM` is the boolean that suppresses the system file.
    // Dropped while the selector beside it is restored, Engwire would read a
    // file the caller's own git deliberately does not — widening what reaches a
    // checkout rather than narrowing it, and the acknowledged `url.*.insteadOf`
    // residual lives in exactly that configuration.
    await Bun.write(join(dir, "system.gitconfig"), "[systemset]\n\tmarker = yes\n");
    process.env.GIT_CONFIG_SYSTEM = join(dir, "system.gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    const answered = await git(["config", "--get", "systemset.marker"], repoDir, NO_DEADLINE)
      .then((value) => value.trim())
      .catch(() => null);

    expect(answered, "a system file the caller had switched off was read").toBeNull();
  });

  test("an absolute one is still the reviewer's to set", async () => {
    // The other half, and why this is not simply dropped: `inertOverrides`
    // reads the effective configuration and disables what executes, so which
    // file that configuration comes from is inside a boundary that exists. A
    // blobless checkout still needs the proxy and credential settings there.
    await Bun.write(join(dir, "elsewhere.gitconfig"), "[reviewerset]\n\tmarker = yes\n");
    process.env.GIT_CONFIG_GLOBAL = join(dir, "elsewhere.gitconfig");

    const answered = await git(["config", "--get", "reviewerset.marker"], repoDir, NO_DEADLINE);

    expect(answered.trim()).toBe("yes");
  });
});

describe("a failing git", () => {
  test("leads with the cause, not with Engwire's own flags", async () => {
    // `engwire status` gives a run's detail a hundred columns, and every git
    // Engwire runs carries the inert-config overrides in front of its
    // subcommand — so ordered the other way round, all hundred went to
    // `--config-env=…` and the reviewer never saw why the checkout failed.
    // The shape `ensureRepository` actually builds: overrides first, then the
    // subcommand. A bare `clone` would pass this test without proving anything.
    const error = await git(
      [
        "--config-env=filter.lfs.smudge=ENGWIRE_GIT_INERT",
        "--config-env=filter.lfs.process=ENGWIRE_GIT_INERT",
        "--config-env=filter.lfs.required=ENGWIRE_GIT_INERT",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--bare",
        "https://127.0.0.1:1/nope.git",
        join(dir, "x"),
      ],
      dir,
      NO_DEADLINE,
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    const message = (error as Error).message;
    // The subcommand, so the line says which git failed...
    expect(message.startsWith("git clone failed (exit ")).toBe(true);
    // ...and the first hundred columns carry the cause rather than flags or
    // the progress git printed before it.
    expect(message.slice(0, 100)).not.toContain("--config-env");
    expect(message.slice(0, 100)).not.toContain("Cloning into");
    expect(message.slice(0, 100)).toMatch(/fatal:|error:|could not/i);
    // The whole command is still there, behind the answer.
    expect(message).toContain("https://127.0.0.1:1/nope.git");
  });
});

describe("gitFailureMessage", () => {
  test("prefers the fatal line over the remediation git prints after it", () => {
    // git's actual output for a repository it will not touch. The last line is
    // the fix to run, not the reason — leading with it buries the cause.
    const message = gitFailureMessage(
      ["-c", "core.hooksPath=/dev/null", "status"],
      128,
      "fatal: detected dubious ownership in repository at '/repo'\n" +
        "To add an exception for this directory, call:\n\n" +
        "\tgit config --global --add safe.directory /repo\n",
    );

    expect(message.startsWith("git status failed (exit 128): fatal: detected dubious ownership")).toBe(
      true,
    );
    // The remediation is kept, behind the cause rather than in front of it.
    expect(message).toContain("safe.directory /repo");
  });

  test("the last named line wins, because git closes with the one that stopped it", () => {
    // A required filter that would not run: git reports each subprocess problem
    // as its own `error:` and then closes with the `fatal:` that summarises
    // them. Reading the first would put a broken pipe in the run's `detail`
    // where the answer is which file and which filter — and `status` gives that
    // detail one line.
    const message = gitFailureMessage(
      ["reset", "--hard", "0f1e2d3"],
      128,
      "error: external filter 'lfs' failed 1\n" +
        "error: external filter 'lfs' failed\n" +
        "fatal: data.bin: smudge filter lfs failed\n",
    );

    expect(message).toContain("): fatal: data.bin: smudge filter lfs failed");
    // Kept, behind the cause, rather than dropped for not being chosen.
    expect(message).toContain("external filter 'lfs' failed 1");
  });

  test("falls back to the last line when git names no fatal", () => {
    const message = gitFailureMessage(["clone", "x"], 1, "something went wrong\n");

    expect(message).toContain("): something went wrong");
  });

  test("names the subcommand past flags that take an operand", () => {
    // `-C <path>` and `-c <key=value>` both put a non-flag where the naive scan
    // would read a subcommand.
    expect(gitFailureMessage(["-C", "/tmp/x", "status"], 1, "fatal: nope").startsWith("git status")).toBe(true);
    expect(gitFailureMessage(["-c", "a.b=c", "fetch"], 1, "fatal: nope").startsWith("git fetch")).toBe(true);
  });

  test("says something even when git said nothing", () => {
    expect(gitFailureMessage(["clone", "x"], 9, "   \n\n")).toContain("no output (exit 9)");
  });
});

describe("ensureRepository", () => {
  test("configures credentials for github.com and for nothing else", async () => {
    // The clone `beforeEach` made came from a path, not github.com.
    expect(await helpers()).toEqual([]);

    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin: "/opt/homebrew/bin/gh", signal: NO_DEADLINE });
    expect(await helpers()).toEqual(["", "!'/opt/homebrew/bin/gh' auth git-credential"]);
    // Under a URL section, never `credential.helper`: an unscoped entry would
    // answer for every host a command inside the worktree reaches.
    expect(await helpers("credential.helper")).toEqual([]);
  });

  test("follows gh when it moves, rather than accumulating helpers", async () => {
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin: "/opt/homebrew/bin/gh", signal: NO_DEADLINE });
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin: "/usr/local/bin/gh", signal: NO_DEADLINE });

    // A clone outlives a Homebrew upgrade. Written once, the helper would name
    // a `gh` that is gone while `doctor` reported the new one as healthy.
    expect(await helpers()).toEqual(["", "!'/usr/local/bin/gh' auth git-credential"]);
  });

  test("a credential helper the user already had cannot answer first", async () => {
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin, signal: NO_DEADLINE });

    // Git asks helpers in order until one answers, so without the empty entry
    // that resets the list, the inherited helper would supply the credential and
    // Engwire would push as an account `doctor` never checked. This also proves
    // the quoting: git ran the helper through a shell to reach a path holding
    // an apostrophe and a space.
    const answer = await fill("github.com");
    expect(answer).toContain("username=engwire");
    expect(answer).not.toContain("username=inherited");
  });

  test("leaves every other host to the user's own configuration", async () => {
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin, signal: NO_DEADLINE });

    // The reset is the reason this needs saying: scoped to the whole clone, it
    // would strip the user's helpers from hosts Engwire has no business
    // touching, and `gh` would be asked for a credential it cannot have.
    expect(await fill("gitlab.example")).toContain("username=inherited");
  });
});

/**
 * A `git` that never finishes, with a helper of its own that outlives it.
 *
 * The shape of the failure this is about: a `fetch` stalled on a half-open
 * connection, with `gh auth git-credential` still attached to the same stdout.
 * The helper is what makes the test worth having — killing git alone leaves it
 * holding the write end of the pipe, so the drain would go on waiting after the
 * kill that was meant to end the wait.
 *
 * It announces itself by writing `ticks`, which is what the test waits for
 * rather than guessing a delay: a fresh `sh` can take a few hundred
 * milliseconds to reach its first line on a loaded machine, and a fixed sleep
 * that lost that race would pass while proving nothing.
 */
function hungGit(): { ticks: string } {
  const bin = join(dir, "bin");
  const ticks = join(dir, "ticks");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nsh -c 'while :; do echo tick >> "${ticks}"; sleep 0.01; done' &\nsleep 300\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return { ticks };
}

describe("a git that has to be stopped", () => {
  test("refuses to start a command whose deadline has already passed", async () => {
    // Spawning a process only to kill it is a race with nothing to win, and
    // `fetchRevision` depends on this: its `refs/pull` fallback must not open a
    // second network command after the deadline stopped the first.
    const { ticks } = hungGit();

    const failure = await git(["fetch"], dir, AbortSignal.abort()).catch((e: unknown) => e);

    expect((failure as Error).name).toBe("GitAborted");
    expect(existsSync(ticks)).toBe(false);
  });

  test("stops waiting on a descendant that left the process group", async () => {
    // The half a signal cannot deliver. Killing the group closes the pipes its
    // members hold, and the test below leans on exactly that — but what a
    // `fetch` hands off to run later calls `setsid` on the way out, and then
    // nothing here can reach it. Measured before the reads were cancelled: the
    // leader exited immediately, the abort fired at 300ms, and this call had
    // still not returned twenty-five seconds later — a stopped checkout holding
    // the runner's one execution slot exactly as an unstopped one would, which
    // is the failure the signal exists to prevent.
    const bin = join(dir, "bin");
    const detached = join(dir, "detached");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      // `python3` for `setsid`, which macOS does not ship as a command. It
      // announces itself only after leaving the group, so the abort below lands
      // when the pipe is genuinely held by something out of reach — aborting
      // before that, the kill still closes it and this passes either way.
      //
      // Its pid comes with the announcement, renamed into place so the file is
      // never seen half-written. Nothing else can stop this process — that is
      // the whole premise — so the test that started it is the only thing that
      // can clean it up, and a suite that leaks a sleeping process per run is
      // not one to leave behind in a codebase this careful about groups.
      `#!/bin/sh\npython3 -c "import os,time; os.setsid(); open('${detached}.tmp','w').write(str(os.getpid())); os.rename('${detached}.tmp','${detached}'); time.sleep(30)" &\nexit 0\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const controller = new AbortController();
    const running = git(["fetch"], dir, controller.signal).catch((e: unknown) => e);

    // Bounded, and it says which half failed: without this a machine with no
    // `python3` spins here until the runner's own timeout and reports a
    // deadline rather than a missing dependency.
    const upBy = Date.now() + 10_000;
    while (!existsSync(detached)) {
      expect(Date.now(), "the stand-in never left its process group").toBeLessThan(upBy);
      await Bun.sleep(10);
    }
    const startedAt = Date.now();
    controller.abort();
    const failure = await running;

    try {
      expect((failure as Error).name).toBe("GitAborted");
      // Well inside the grace: the point is that it does not wait on the pipe
      // at all, not that it waits a shorter while.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      // Whatever the assertions did. It is out of every group this test or the
      // code under test can signal, so the pid it published is the only handle
      // there is.
      process.kill(Number(readFileSync(detached, "utf8")), "SIGKILL");
    }
    // Longer than bun's 5s default, which is shorter than the two budgets above
    // put together — so on the default the readiness bound could never fire and
    // a missing `python3` reported a bare "timed out after 5000ms" instead of
    // the sentence written for it.
  }, 20_000);

  test("stops a stalled command and the helpers it started, rather than waiting", async () => {
    const { ticks } = hungGit();
    const controller = new AbortController();
    const running = git(["fetch"], dir, controller.signal).catch((e: unknown) => e);

    // The helper is up, so the abort below has both processes to reach.
    while (!existsSync(ticks)) await Bun.sleep(10);
    const startedAt = Date.now();
    controller.abort();
    const failure = await running;

    // That it returns at all is the point. `sleep 300` stands in for a fetch on
    // a connection that is open and silent, and the runner reviews one pull
    // request at a time — so before this, five minutes here was five minutes in
    // which nothing else could be reviewed, and the real case has no ceiling.
    expect((failure as Error).name).toBe("GitAborted");
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    // The helper went with it. Left alive it would still hold the write end of
    // stdout, and the drain this call just escaped would outlive the kill.
    const before = readFileSync(ticks, "utf8").length;
    // Ten of the helper's tick intervals, which is its whole liveness signal.
    await Bun.sleep(100);
    expect(readFileSync(ticks, "utf8").length).toBe(before);
    // As above: the assertion allows ten seconds, so the test has to be given
    // more than bun's five.
  }, 20_000);
});
