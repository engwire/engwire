import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skillFile } from "../claude/skills.ts";
import { parseConfig } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { columns, setup } from "./setup.ts";

let dir: string;
let cwd: string;
/** Environment this suite mutates; tests share one process. */
let restore: Record<string, string | undefined>;

/** A `gh` and a `claude` sitting in the directory the command is typed from. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engwire-setup-"));
  for (const name of ["gh", "claude"]) {
    const bin = join(dir, name);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
  }
  mkdirSync(join(dir, "home"), { recursive: true });
  cwd = process.cwd();
  restore = {
    PATH: process.env.PATH,
    ENGWIRE_HOME: process.env.ENGWIRE_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.chdir(dir);
  process.env.ENGWIRE_HOME = join(dir, "home");
  // Isolate skill discovery from the machine running the suite.
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
});

afterEach(async () => {
  process.chdir(cwd);
  for (const [name, value] of Object.entries(restore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("setup", () => {
  test("a binary beside the caller is never written into the config", async () => {
    // `setup` is where a resolution becomes permanent: the absolute path it
    // records is what every later review runs, and `doctor` would report it as
    // healthy. Run from inside a checkout by someone with `.` on their PATH,
    // resolving `gh` the ambient way would commit that branch's `gh` to the
    // configuration.
    process.env.PATH = ".";
    const error = console.error;
    let said = "";
    console.error = (message: unknown) => {
      said += `${message}\n`;
    };
    try {
      expect(await setup()).toBe(1);
    } finally {
      console.error = error;
    }

    expect(said).toContain("gh is not installed");
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("writes a config the parser accepts, naming the binaries it resolved", async () => {
    // Exercise the handover from setup's discovery to the config every later
    // review and `doctor` read.
    const tools = join(dir, "tools");
    mkdirSync(tools, { recursive: true });
    // Exercise the same Claude checks `setup` shares with `doctor`.
    writeFileSync(
      join(tools, "claude"),
      `#!/bin/sh
case "$*" in
  "--setting-sources user --version")   echo "9.9.9 (Claude Code)" ;;
  "--setting-sources "*" --version")    exit 1 ;;
  "--setting-sources user auth status") echo signed in ;;
  *)                                    exit 1 ;;
esac
`,
    );
    writeFileSync(join(tools, "gh"), "#!/bin/sh\necho alice\n");
    writeFileSync(join(tools, "git"), "#!/bin/sh\nexit 0\n");
    for (const name of ["claude", "gh", "git"]) chmodSync(join(tools, name), 0o755);
    process.env.PATH = tools;
    // Enough valid names to wrap, plus one name Engwire rejects in a rule.
    const installed = [
      "accessibility-review",
      "api-review",
      "docs-review",
      "performance-review",
      "security-review",
      "test-review",
    ];
    for (const name of [...installed, "not a skill name"]) {
      // Through `skillFile`, so the test cannot disagree with `userSkills`
      // about where a skill lives.
      mkdirSync(dirname(skillFile(name)), { recursive: true });
      writeFileSync(skillFile(name), "---\nname: x\n---\n");
    }

    const log = console.log;
    let said = "";
    console.log = (message: unknown) => {
      said += `${message}\n`;
    };
    let code: number;
    try {
      code = await setup();
    } finally {
      console.log = log;
    }

    expect(code).toBe(0);
    const written = await Bun.file(paths().configFile).text();
    const config = parseConfig(written);
    // No rules: naming a repository is the reviewer's decision, not setup's.
    expect(config.reviews).toEqual([]);
    // Absolute, and the ones just resolved — a background service does not
    // inherit the PATH this ran with.
    expect(config.advanced.ghBin).toBe(join(tools, "gh"));
    expect(config.advanced.claudeBin).toBe(join(tools, "claude"));

    // The skill list as a terminal receives it: every name a rule could hold and
    // no other, wrapped at the default width and indented by two.
    const lines = said.split("\n");
    const first = lines.indexOf("Its `skill` names one of yours:") + 1;
    expect(first).toBeGreaterThan(0);
    const listed = lines.slice(first, lines.indexOf("", first));

    expect(listed.length).toBeGreaterThan(1);
    expect(listed).toEqual(columns(installed).map((line) => `  ${line}`));
    expect(said).not.toContain("not a skill name");
  });
});

describe("columns", () => {
  test("fills each line and never breaks a name across two", () => {
    const names = [
      "accessibility-review",
      "api-review",
      "docs-review",
      "performance-review",
      "security-review",
      "test-review",
    ];

    const lines = columns(names, 40);

    // Every name survives, in order, and each is whole on the line it lands on.
    expect(lines.join(" ").split(/,\s*/)).toEqual(names);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("a name wider than the column gets a line rather than a truncation", () => {
    const long = "a-skill-name-longer-than-any-sensible-column";

    expect(columns([long], 20)).toEqual([long]);
  });

  test("the default width leaves room for the two spaces setup adds", () => {
    const names = Array.from({ length: 20 }, (_, i) => `skill-number-${i}`);

    for (const line of columns(names)) expect(line.length).toBeLessThanOrEqual(78);
  });

  test("nothing to say about no skills", () => {
    expect(columns([])).toEqual([]);
  });
});
