import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrigin } from "../../test/fixtures/repo.ts";
import { ensureRepository, git } from "./repository.ts";

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
  saved = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM];
  await Bun.write(
    join(dir, "gitconfig"),
    `[credential]\n\thelper = "!printf 'username=inherited\\\\npassword=x\\\\n'"\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  // Deliberately awkward: an apostrophe and a space, both of which a shell
  // would mangle if the helper were not quoted.
  const ghDir = join(dir, "o'brien bin");
  mkdirSync(ghDir, { recursive: true });
  ghBin = join(ghDir, "gh");
  await Bun.write(ghBin, "#!/bin/sh\nprintf 'username=engwire\\npassword=y\\n'\n");
  chmodSync(ghBin, 0o755);

  const origin = await createOrigin(dir);
  await ensureRepository({ url: origin.url, dir: repoDir, ghBin });
});

afterEach(async () => {
  // Assignment would not do: `process.env.X = undefined` stores the *string*
  // "undefined", which git rejects, and every later test in the process
  // inherits it.
  for (const [key, value] of [
    ["GIT_CONFIG_GLOBAL", saved[0]],
    ["GIT_CONFIG_NOSYSTEM", saved[1]],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

/** What the clone itself sets, as opposed to what it inherits. */
async function helpers(key = "credential.https://github.com.helper"): Promise<string[]> {
  const out = await git(["config", "--local", "--get-all", key], repoDir).catch(() => "");
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

describe("ensureRepository", () => {
  test("configures credentials for github.com and for nothing else", async () => {
    // The clone `beforeEach` made came from a path, not github.com.
    expect(await helpers()).toEqual([]);

    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin: "/opt/homebrew/bin/gh" });
    expect(await helpers()).toEqual(["", "!'/opt/homebrew/bin/gh' auth git-credential"]);
    // Under a URL section, never `credential.helper`: an unscoped entry would
    // answer for every host a command inside the worktree reaches.
    expect(await helpers("credential.helper")).toEqual([]);
  });

  test("follows gh when it moves, rather than accumulating helpers", async () => {
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin: "/opt/homebrew/bin/gh" });
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin: "/usr/local/bin/gh" });

    // A clone outlives a Homebrew upgrade. Written once, the helper would name
    // a `gh` that is gone while `doctor` reported the new one as healthy.
    expect(await helpers()).toEqual(["", "!'/usr/local/bin/gh' auth git-credential"]);
  });

  test("a credential helper the user already had cannot answer first", async () => {
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin });

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
    await ensureRepository({ url: GITHUB, dir: repoDir, ghBin });

    // The reset is the reason this needs saying: scoped to the whole clone, it
    // would strip the user's helpers from hosts Engwire has no business
    // touching, and `gh` would be asked for a credential it cannot have.
    expect(await fill("gitlab.example")).toContain("username=inherited");
  });
});
