import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_INSTALL, skillFile } from "../claude/skills.ts";
import { parseConfig, REVIEW_SKILL } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { WATCHING } from "./run.ts";
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

/**
 * Stand-in tools every check `setup` shares with `doctor` passes, on PATH.
 *
 * A real `gh` and `claude` would make the assertions depend on the machine
 * running the suite — and on a live GitHub call.
 */
function healthyTools(options: { authenticated?: boolean } = {}): string {
  const tools = join(dir, "tools");
  mkdirSync(tools, { recursive: true });
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
  // Simulate a diagnostic failure after setup has written the config.
  const login = options.authenticated === false ? 'echo "not logged in" >&2; exit 1' : "echo alice";
  writeFileSync(
    join(tools, "gh"),
    `#!/bin/sh\ncase "$1" in --version) echo 'gh version 2.31.0 (2023-06-06)' ;; *) ${login} ;; esac\n`,
  );
  writeFileSync(join(tools, "git"), "#!/bin/sh\nexit 0\n");
  for (const name of ["claude", "gh", "git"]) chmodSync(join(tools, name), 0o755);
  process.env.PATH = tools;
  return tools;
}

/** A skill on the filesystem where `userSkills` and the preflight both look. */
function installSkill(name: string): void {
  mkdirSync(dirname(skillFile(name)), { recursive: true });
  writeFileSync(skillFile(name), "---\nname: x\n---\n");
}

/** Run `setup`, keeping stdout and stderr apart: only one of them is a refusal. */
async function run(repos: string[]): Promise<{ code: number; out: string; err: string }> {
  const { log, error } = console;
  let out = "";
  let err = "";
  console.log = (message: unknown) => {
    out += `${message}\n`;
  };
  console.error = (message: unknown) => {
    err += `${message}\n`;
  };
  try {
    return { code: await setup({ repos }), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

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
      expect(await setup({ repos: [] })).toBe(1);
    } finally {
      console.error = error;
    }

    expect(said).toContain("gh is not installed");
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("writes a config the parser accepts, naming the binaries it resolved", async () => {
    // Exercise the handover from setup's discovery to the config every later
    // review and `doctor` read.
    const tools = healthyTools();
    // Enough valid names to wrap, plus one name Engwire rejects in a rule.
    const installed = [
      "accessibility-review",
      "api-review",
      "docs-review",
      "performance-review",
      "security-review",
      "test-review",
    ];
    for (const name of [...installed, "not a skill name"]) installSkill(name);

    const log = console.log;
    let said = "";
    console.log = (message: unknown) => {
      said += `${message}\n`;
    };
    let code: number;
    try {
      code = await setup({ repos: [] });
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

    // A reviewer has to come from somewhere, and Engwire ships none: the one
    // step between a written config and a first review is named here or
    // nowhere a new reader will look.
    expect(said).toContain("https://github.com/engwire/skills");
    expect(said).toContain("cannot tell which of these is a reviewer");

    // The skill list as a terminal receives it: every name a rule could hold and
    // no other, wrapped at the default width and indented by two. Offered as
    // the alternative to copying one, not as an answer to "which of these
    // reviews a pull request" — none of them need.
    const lines = said.split("\n");
    const expected = columns(installed).map((line) => `  ${line}`);
    expect(expected.length).toBeGreaterThan(1);
    // Located by the list itself rather than by the sentence above it: the
    // heading is copy, and rewording it should not fail a test whose subject
    // is that every name a rule could hold is listed, wrapped and indented.
    const first = lines.indexOf(expected[0]!);
    expect(first).toBeGreaterThan(-1);
    expect(lines.slice(first, first + expected.length)).toEqual(expected);
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
      await setup({ repos: [] });
    } finally {
      console.log = log;
    }

    // Not an empty list: "you have none" sends somebody off to write a skill
    // they may already have.
    expect(said).not.toContain("Or write your own at");
    expect(said).toContain("cannot be listed");
    // However the listing fails, the way out of it does not.
    expect(said).toContain("https://github.com/engwire/skills");
    // Pointed at, not repeated. The `claude root` row above has already spent
    // forty words on this exact root, and the listing saying them again puts
    // the same paragraph twice on the one screen somebody is reading to find
    // out what to do next — so presence is not the assertion, count is.
    expect(said).toContain("see \u2717 claude root above");
    // "above" is a claim about the page, so the row has to precede the sentence
    // that sends the reader back to it: the first mark is the row's, not the
    // one inside the sentence, and a guidance block printed before the table
    // would fail this rather than quietly point the wrong way.
    expect(said.indexOf("\u2717 claude root")).toBeLessThan(
      said.indexOf("see \u2717 claude root above"),
    );
    expect(said.split("not an absolute path")).toHaveLength(2);
    // The guidance it exists to print still gets printed. Whether the command
    // *fails* is `doctor`'s row to decide and is asserted there; what this pins
    // is that setup reaches its own last line instead of a stack trace.
    expect(said).toContain("engwire run --once");
    expect(said).toContain("nothing requested before that second is reviewed");
  });

  test("a root with no skills says where one goes, not that there is nothing to name", async () => {
    // The third way the listing can end, and the one a genuinely new machine
    // hits. There is nothing to list, so the answer is the known source and
    // where an owned reviewer would go — and the heading that introduces a
    // list must not print, leaving a sentence with nothing under it.
    const root = join(dir, "empty-claude");
    mkdirSync(join(root, "skills"), { recursive: true });
    // Pinned to the stubs `beforeEach` wrote, for the reason the tests above give.
    process.env.PATH = dir;
    process.env.CLAUDE_CONFIG_DIR = root;

    const log = console.log;
    let said = "";
    console.log = (message: unknown) => {
      said += `${message}\n`;
    };
    try {
      await setup({ repos: [] });
    } finally {
      console.log = log;
    }

    expect(said).toContain("https://github.com/engwire/skills");
    expect(said).toContain(`Or write your own at ${skillFile("<name>")}.`);
    expect(said).not.toContain("Engwire cannot tell");
    expect(said).toContain("nothing requested before that second is reviewed");
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
      await setup({ repos: [] });
    } finally {
      console.log = log;
    }

    expect(said).not.toContain("Or write your own at");
    expect(said).not.toContain("claude root above");
    expect(said).toContain("cannot be listed: ");
    expect(said).toContain("https://github.com/engwire/skills");
    expect(said).toContain("ELOOP");
    expect(said).toContain("nothing requested before that second is reviewed");
  });
});

describe("setup --repo", () => {
  test("writes the rule, so what comes next is a runner and not an editor", async () => {
    const tools = healthyTools();
    installSkill(REVIEW_SKILL);

    const { code, out } = await run(["acme/*", "other/api"]);

    expect(code).toBe(0);
    const config = parseConfig(await Bun.file(paths().configFile).text());
    expect(config.reviews).toEqual([
      { repos: ["acme/*", "other/api"], skill: REVIEW_SKILL, skipDrafts: true },
    ]);
    expect(config.advanced.ghBin).toBe(join(tools, "gh"));
    // Nothing left to uncomment: a second rule for the same repositories would
    // be shadowed by this one, and the parser refuses that file.
    expect(out).not.toContain("Uncomment a [[review]] rule");
    // The ordering the watermark makes load-bearing: start the runner, wait for
    // the line, then ask for the review. Without it, the most natural way to try
    // a fresh install produces silence for ever.
    expect(out).toContain("engwire run ");
    // Named from the runner that prints it, so a reworded barrier fails here
    // rather than leaving somebody waiting for a line that never appears.
    expect(out).toContain(WATCHING);
    expect(out).toContain("ask for your review after that line");
    // The cutoff precedes readiness if startup waits for GitHub, and includes
    // the whole second in which the first runner starts.
    expect(out).toContain("Watching begins the second `engwire run` starts");
  });

  test("a check that fails after the write sends the reader to doctor, not back here", async () => {
    // Diagnostics run after the write. Retrying setup --repo would refuse the
    // existing file, so the recovery guidance must point to doctor.
    healthyTools({ authenticated: false });
    installSkill(REVIEW_SKILL);

    const { code, out } = await run(["acme/*"]);

    expect(code).toBe(1);
    // Written, valid, and holding the rule that was asked for: the repair is the
    // environment, not the file.
    expect(parseConfig(await Bun.file(paths().configFile).text()).reviews).toEqual([
      { repos: ["acme/*"], skill: REVIEW_SKILL, skipDrafts: true },
    ]);
    expect(out).toContain("✗ gh");
    // Ordered, because which remedy comes first is the whole point: `engwire run`
    // above `engwire doctor` would send somebody to a runner that cannot start.
    // Read off the indented command lines rather than the whole output, which
    // also explains when `engwire run` starts watching — a plain "doctor before
    // run" match over the text passes on that sentence alone, whichever order the
    // commands are in.
    const commands = out.split("\n").filter((line) => line.startsWith("  engwire "));
    const doctor = commands.findIndex((line) => line.includes("engwire doctor"));
    const runner = commands.findIndex((line) => line.includes("engwire run"));
    expect(doctor).toBeGreaterThanOrEqual(0);
    expect(runner).toBeGreaterThan(doctor);
    expect(out).toContain("setup never edits one that exists");
    // The ordering guidance still gets printed: it is about when to ask for a
    // review, which is as true after the repair as before it.
    expect(out).toContain(WATCHING);
  });

  test("a pattern no rule could use leaves no config to repair", async () => {
    healthyTools();
    installSkill(REVIEW_SKILL);

    const { code, err } = await run(["acme/foo*"]);

    expect(code).toBe(1);
    expect(err).toContain("--repo \"acme/foo*\"");
    expect(err).toContain('"owner/name"');
    // The invariant is the pathname, not the directory: `setup` legitimately
    // creates the config's parent. Writing first and failing after would leave a
    // file that makes the re-run refuse — a one-way street out of a state the
    // reader was just told to fix.
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("patterns that are each fine and cannot both matter are refused as a pair", async () => {
    // `isRepoPattern` passes twice here and the rendered rule is still one the
    // parser rejects, because the first pattern covers the second. Validating
    // the rule rather than the values is what makes the guarantee total.
    healthyTools();
    installSkill(REVIEW_SKILL);

    const { code, err } = await run(["acme/*", "acme/api"]);

    expect(code).toBe(1);
    expect(err).toContain("can never match");
    expect(err).toContain("acme/api");
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("a missing reviewer is refused with the one command that installs it", async () => {
    // Engwire ships no skill and never runs the installer itself, so the step
    // between a config and a first review is a command the reader runs — printed
    // here rather than linked, because a link is a second README.
    healthyTools();

    const { code, err } = await run(["acme/*"]);

    expect(code).toBe(1);
    expect(err).toContain(`review skill ${REVIEW_SKILL}`);
    expect(err).toContain(`no SKILL.md at ${skillFile(REVIEW_SKILL)}`);
    expect(err).toContain(SKILL_INSTALL);
    expect(err).toContain("needs Node");
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("a reviewer whose path cannot be read at all is not answered with an install", async () => {
    // The failure an existence check gets wrong: a path that will not resolve
    // answers "false" exactly as an absent one does, and the remedy for the two
    // is not the same. A link loop rather than a `chmod`, because the assertion
    // has to hold for whoever runs the suite — root reads a directory whose mode
    // forbids it.
    healthyTools();
    mkdirSync(dirname(dirname(skillFile(REVIEW_SKILL))), { recursive: true });
    symlinkSync(REVIEW_SKILL, dirname(skillFile(REVIEW_SKILL)));

    const { code, err } = await run(["acme/*"]);

    expect(code).toBe(1);
    expect(err).toContain("ELOOP");
    expect(err).not.toContain(SKILL_INSTALL);
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("a skill disabled by front matter is reported without an install command", async () => {
    // The file is readable; its invocation setting needs repair, not installation.
    healthyTools();
    installSkill(REVIEW_SKILL);
    writeFileSync(skillFile(REVIEW_SKILL), "---\nuser-invocable: false\n---\n");

    const { code, err } = await run(["acme/*"]);

    expect(code).toBe(1);
    expect(err).toContain("user-invocable");
    expect(err).not.toContain(SKILL_INSTALL);
    expect(existsSync(paths().configFile)).toBe(false);
  });

  test("an existing config is printed to, never edited", async () => {
    // The refusal is the feature: somebody's file may hold three rules whose
    // order is the configuration. So the rule goes to the terminal with where it
    // belongs in that order, and the exit status says the ask did not happen.
    healthyTools();
    installSkill(REVIEW_SKILL);
    const existing = '[[review]]\nrepos = ["x/y"]\nskill = "engwire-review"\n';
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(paths().configFile, existing);

    const { code, err } = await run(["acme/*"]);

    expect(code).toBe(1);
    expect(await Bun.file(paths().configFile).text()).toBe(existing);
    expect(err).toContain(paths().configFile);
    expect(err).toContain('repos = ["acme/*"]');
    expect(err).toContain(`skill = "${REVIEW_SKILL}"`);
    // First match, so "broader" would be the wrong word: an earlier narrower or
    // equivalent rule takes these repositories just as effectively.
    expect(err).toContain("first match");
    expect(err).not.toContain("broader");
    // And the block it printed is a rule, not an approximation of one.
    const pasted = err.slice(err.indexOf("[[review]]"), err.indexOf("Rules use first match"));
    expect(parseConfig(pasted).reviews).toEqual([
      { repos: ["acme/*"], skill: REVIEW_SKILL, skipDrafts: true },
    ]);
  });

  test("an unusable pattern is answered before either of the other two refusals", async () => {
    // All three refusals are due at once — unusable pattern, config already
    // there, no reviewer installed — and only the first names something the
    // other two cannot fix. Without this, the contract is unpinned in both
    // directions: every pattern test runs against a fresh config and an
    // installed skill, so hoisting either of those checks above `repoProblem`
    // leaves the suite green while the reader is told to fix the wrong thing.
    healthyTools();
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(paths().configFile, "# mine\n");

    const { code, err } = await run(["acme/foo*"]);

    expect(code).toBe(1);
    expect(err).toContain("--repo \"acme/foo*\"");
    expect(err).not.toContain("never edits a config that already exists");
    expect(err).not.toContain(SKILL_INSTALL);
  });

  test("the skill is checked only after the config that would refuse anyway", async () => {
    // Order matters because each remedy has to be the one that unblocks the
    // reader: offering an install here would promise that `--repo` proceeds
    // afterwards, and it would refuse the existing config just the same.
    healthyTools();
    mkdirSync(dirname(paths().configFile), { recursive: true });
    writeFileSync(paths().configFile, "# mine\n");

    const { code, err } = await run(["acme/*"]);

    expect(code).toBe(1);
    expect(err).toContain("never edits a config that already exists");
    expect(err).not.toContain(SKILL_INSTALL);
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
