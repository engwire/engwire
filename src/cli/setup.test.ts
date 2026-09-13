import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skillFile } from "../claude/skills.ts";
import { parseConfig } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { backgroundNote, columns, setup } from "./setup.ts";

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
    writeFileSync(join(tools, "gh"), "#!/bin/sh\ncase \"$1\" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) echo alice ;; esac\n");
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

  test.each([
    ["relative", "claude-config"],
    ["empty, which is not the same as unset", ""],
  ])("a Claude root that is %s is said, not thrown", async (_name, root) => {
    // This runs *after* the config has been written, so throwing leaves
    // somebody half set up and reading a stack trace where the three lines
    // telling them what to do next should be. Both call sites are affected:
    // `userSkills` and the `skillFile` fallback resolve through the same root,
    // so the branch that stands in for an empty list is no safer than the one
    // it replaces.
    //
    // Pinned to the stubs `beforeEach` wrote, because `setup` bails before it
    // ever reaches the listing when `gh` or `claude` is missing: judged by the
    // machine's own PATH this test would pass here and fail on any runner
    // without Claude Code installed, and spend a live GitHub call when it did
    // pass.
    process.env.PATH = dir;
    process.env.CLAUDE_CONFIG_DIR = root;

    const log = console.log;
    let said = "";
    console.log = (message: unknown) => {
      said += `${message}\n`;
    };
    try {
      await setup();
    } finally {
      console.log = log;
    }

    // Not an empty list: "you have none" sends somebody off to write a skill
    // they may already have.
    expect(said).not.toContain("none here can go");
    expect(said).toContain("cannot be read");
    // Pointed at, not repeated. The `claude root` row above has already spent
    // forty words on this exact root, and the listing saying them again puts
    // the same paragraph twice on the one screen somebody is reading to find
    // out what to do next — so presence is not the assertion, count is.
    expect(said).toContain("see the \u2717 above");
    expect(said.split("not an absolute path")).toHaveLength(2);
    // The guidance it exists to print still gets printed. Whether the command
    // *fails* is `doctor`'s row to decide and is asserted there; what this pins
    // is that setup reaches its own last line instead of a stack trace.
    expect(said).toContain("engwire run --once");
    expect(said).toContain("Requests made before that are not reviewed");
  });

  test("a skills directory that will not list says why, having no row to point at", async () => {
    // The other way the listing fails, and the report treats the two
    // differently: a relative root gets a red `claude root` row, so the test
    // above can be pointed at it. This one leaves every row green — the root
    // is absolute, and a config `setup` has only just written names no skill,
    // so nothing went looking in the directory — and "see the ✗ above" would
    // send the reader hunting for a mark that is not there.
    //
    // A link loop rather than a `chmod`, because the assertion has to hold for
    // whoever runs the suite: root reads a directory whose mode forbids it, and
    // CI is not always somebody else.
    const root = join(dir, "unreadable-claude");
    mkdirSync(root, { recursive: true });
    symlinkSync("skills", join(root, "skills"));
    // Pinned to the stubs `beforeEach` wrote, for the reason the test above
    // gives: judged by the machine's own PATH this would not reach the listing.
    process.env.PATH = dir;
    process.env.CLAUDE_CONFIG_DIR = root;

    const log = console.log;
    let said = "";
    console.log = (message: unknown) => {
      said += `${message}\n`;
    };
    try {
      // Not a throw. `userSkills` rethrows this rather than flattening it to an
      // empty list, and it is reached after the config has been written — so
      // uncaught it leaves somebody half set up, reading a stack trace instead
      // of the three lines telling them what to do next.
      await setup();
    } finally {
      console.log = log;
    }

    expect(said).not.toContain("none here can go");
    expect(said).not.toContain("see the ✗ above");
    expect(said).toContain("cannot be read: ");
    expect(said).toContain("ELOOP");
    expect(said).toContain("Requests made before that are not reviewed");
  });
});

describe("backgroundNote", () => {
  test("macOS is offered the command Engwire actually ships", () => {
    expect(backgroundNote("darwin")).toEqual([
      "  engwire service install  keep it running in the background",
    ]);
  });

  test("everywhere else is pointed at the unit rather than left guessing", () => {
    // `engwire service install` is launchd-only and exits 1 elsewhere, so
    // offering it here would end setup by handing someone an error. Saying
    // nothing — the earlier behaviour — left the last question unanswered on
    // the one platform where the answer is not a command Engwire ships.
    const lines = backgroundNote("linux");

    expect(lines.join("\n")).not.toContain("engwire service install");
    expect(lines.join("\n")).toContain("docs/linux.md");
    // Inside the 80 columns the rest of setup's prose is written to.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
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
