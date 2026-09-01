import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillFile, skillPreflightProblem, userSkills } from "./skills.ts";

const scratches: string[] = [];

/** A Claude configuration directory, and skills written into it. */
function claudeConfig(): {
  env: { CLAUDE_CONFIG_DIR: string };
  write: (name: string, source: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "engwire-skills-"));
  scratches.push(dir);
  return {
    env: { CLAUDE_CONFIG_DIR: dir },
    write(name, source) {
      mkdirSync(join(dir, "skills", name), { recursive: true });
      writeFileSync(join(dir, "skills", name, "SKILL.md"), source);
    },
  };
}

const SKILL = "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview it.\n";

afterAll(async () => {
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

describe("skillFile", () => {
  test("resolves the user skill path from CLAUDE_CONFIG_DIR", () => {
    expect(skillFile("review-pr", { HOME: "/home/dev" })).toBe(
      "/home/dev/.claude/skills/review-pr/SKILL.md",
    );
    // Skills following Claude's relocated configuration root is an inference;
    // see `skills.ts`.
    expect(skillFile("review-pr", { HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/opt/cc" })).toBe(
      "/opt/cc/skills/review-pr/SKILL.md",
    );
  });
});

describe("skillPreflightProblem", () => {
  test("a skill is its SKILL.md, not its directory", () => {
    // Measured, because it decides what the check can claim: with
    // `skills/engwire-probe/SKILL.md` in place, `/engwire-probe` ran; with the
    // directory present and empty, the same invocation printed
    // `Unknown command: /engwire-probe` — and exited 0.
    const { env, write } = claudeConfig();
    write("review-pr", SKILL);
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, "skills", "review-bare"), { recursive: true });

    expect(skillPreflightProblem("review-pr", env)).toBeNull();
    expect(skillPreflightProblem("review-bare", env)).toContain("no SKILL.md at");
    expect(skillPreflightProblem("never-written", env)).toContain("no SKILL.md at");
  });

  test("only the values the CLI reads as true leave a skill invocable", () => {
    // The silent failure, and the reason existence alone is not the predicate:
    // with `user-invocable: false` the production invocation printed *nothing
    // at all* and exited 0 — no `Unknown command`, no transcript, a `completed`
    // run and no review.
    //
    // Each value below was measured one at a time. `banana` is the one that
    // settles the shape: the field is not a boolean, so anything the CLI does
    // not read as true is false, and a list of false spellings would have
    // passed `0` and every typo.
    const { env, write } = claudeConfig();
    const invocable = (value: string) => {
      write("review-pr", `---\nname: review-pr\nuser-invocable: ${value}\n---\n`);
      return skillPreflightProblem("review-pr", env) === null;
    };

    for (const yes of ["true", "True", "TRUE", "1", "yes", "Yes", "on", "ON", '"true"']) {
      expect(invocable(yes)).toBe(true);
    }
    for (const no of ["false", "FALSE", "no", "off", "n", "0", "f", "banana", '"false"']) {
      expect(invocable(no)).toBe(false);
    }
    // Only the double-quoted pair was measured. `'true'` is YAML's true and
    // very likely Claude's, but likely is what this check exists not to accept.
    expect(invocable("'true'")).toBe(false);
    // A value with a space in it is the fail-open this shape exists to prevent:
    // matched loosely it is a false spelling, matched strictly it is no
    // declaration at all — and no declaration means invocable.
    expect(invocable('"banana split"')).toBe(false);
    expect(invocable("banana split")).toBe(false);
    // Whether Claude coerces a YAML comment or the whole scalar was never
    // measured, so neither spelling is read as true: held is a line in
    // `doctor`, while a wrong yes is a review request spent on nothing.
    expect(invocable("true # the reviewer keeps this on")).toBe(false);
    expect(invocable('"true # x"')).toBe(false);
    // One matching pair of quotes comes off, and a lone quote is not a pair.
    expect(invocable('"true')).toBe(false);
    // A trailing YAML comment is part of the line, and was measured silent too.
    expect(invocable("false # model only")).toBe(false);
    // As was the key with nothing after it.
    write("review-pr", "---\nname: review-pr\nuser-invocable:\n---\n");
    expect(skillPreflightProblem("review-pr", env)).toContain("user-invocable");
    // A skill that never mentions the field is invocable.
    write("review-pr", SKILL);
    expect(skillPreflightProblem("review-pr", env)).toBeNull();
  });

  test("a declaration the CLI honours is a declaration this reads", () => {
    // Each of these left the invocation silent, so a pattern that only accepted
    // the tidy spelling would have read the file as saying nothing — and passed
    // a skill Claude will not run.
    const { env, write } = claudeConfig();
    const held = (frontMatter: string) => {
      write("review-pr", `---\nname: review-pr\n${frontMatter}\n---\n`);
      return skillPreflightProblem("review-pr", env) !== null;
    };

    expect(held("user-invocable : false")).toBe(true);
    expect(held('"user-invocable": false')).toBe(true);
    // Measured: declared twice, `true` then `false`, the skill did not run — so
    // reading the first declaration and passing would be exactly wrong.
    expect(held("user-invocable: true\nuser-invocable: false")).toBe(true);
    // Two agreeing declarations are still not an answer this can read.
    expect(held("user-invocable: true\nuser-invocable: true")).toBe(true);

    // Quoting the key on one side only is the dangerous direction of the same
    // rule: read loosely it is a `true` nobody measured, read strictly it is no
    // declaration at all, and both readings would pass the skill.
    expect(held('"user-invocable: true')).toBe(true);
    expect(held("'user-invocable\": true")).toBe(true);
    // A matching pair of single quotes is no more measured than a mismatched
    // one; both are read as a declaration, and neither as one Claude honours.
    expect(held("'user-invocable': true")).toBe(true);
  });

  test("a delimiter prefix does not end the front matter", () => {
    // `---oops` is not a closing delimiter, so the block runs on to the real
    // one and the declaration inside it is read. A pattern that stopped at the
    // prefix would end the block early, leaving `false` outside what was
    // parsed — where a skill reads as having declared nothing.
    const { env, write } = claudeConfig();
    write("review-pr", "---\nname: review-pr\n---oops\nuser-invocable: false\n---\n\nReview it.\n");

    expect(skillPreflightProblem("review-pr", env)).toContain("user-invocable");
  });

  test("a block that never closes is not a block that said nothing", () => {
    // The declaration is there to be read, and the file is malformed in a way
    // nobody measured Claude against. Reading it as an absent declaration would
    // pass exactly the skill it is trying to disable.
    const { env, write } = claudeConfig();
    write("review-pr", "---\nname: review-pr\nuser-invocable: false\n\nReview it.\n");

    expect(skillPreflightProblem("review-pr", env)).toContain("never closes");

    // A file that opens no block declares nothing, which is not the same thing.
    write("review-pr", "Review it.\n");
    expect(skillPreflightProblem("review-pr", env)).toBeNull();
  });

  test("a reserved folder name is not a review target, however valid the file", () => {
    // Measured: with a valid `skills/synced/SKILL.md` in place, both `/synced`
    // and `/Synced` printed `Unknown command:` and exited 0. `config.toml`
    // accepts the name, so nothing else would catch it.
    const { env, write } = claudeConfig();
    write("synced", SKILL);
    write("Synced", SKILL);

    expect(skillPreflightProblem("synced", env)).toContain("reserves");
    expect(skillPreflightProblem("Synced", env)).toContain("reserves");
  });

  test("a relative configuration root is not a place this can check", () => {
    // Engwire runs in its own directory and Claude runs in the pull request, so
    // a relative root names two places — and the one checked here would not be
    // the one the review reads.
    const relative = "is not an absolute path";
    expect(skillPreflightProblem("review-pr", { CLAUDE_CONFIG_DIR: "~/.claude" })).toContain(
      relative,
    );
    // Set but empty is the same unanswerable question: Engwire would inspect
    // the default root while Claude may resolve an empty root against its own
    // working directory, and a wrong yes here is a spent review request.
    expect(skillPreflightProblem("review-pr", { CLAUDE_CONFIG_DIR: "" })).toContain(relative);
    // The root is what has to be absolute, not one of the two variables it can
    // come from — `HOME` reaches the same path by the other route.
    expect(skillPreflightProblem("review-pr", { HOME: "relative" })).toContain(relative);
  });

  test("unreadable is not the same problem as absent", () => {
    // Both hold the run, but they send the reviewer to different fixes: told
    // "no SKILL.md", someone reinstalls a skill that is already there.
    const { env } = claudeConfig();
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, "skills", "review-pr", "SKILL.md"), {
      recursive: true,
    });

    const problem = skillPreflightProblem("review-pr", env);
    expect(problem).toContain("could not read");
    expect(problem).not.toContain("no SKILL.md");
  });

  test("looks at the front matter and not the body", () => {
    // A skill that documents the flag is not disabled by having written it
    // down; the front matter is where the file declares things about itself.
    const { env, write } = claudeConfig();
    write("review-pr", `${SKILL}\nNever set \`user-invocable: false\` on a review skill.\n`);

    expect(skillPreflightProblem("review-pr", env)).toBeNull();
  });
});

describe("userSkills", () => {
  test("lists user skills without guessing their purpose", () => {
    const { env, write } = claudeConfig();
    write("review-pr", SKILL);
    write("create-pr", SKILL);
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, "skills", "half-written"), { recursive: true });

    // A skill kept in a dotfiles repository and symlinked in is still a skill;
    // filtering Dirents to directories would exclude it.
    const elsewhere = mkdtempSync(join(tmpdir(), "engwire-dotfiles-"));
    scratches.push(elsewhere);
    mkdirSync(join(elsewhere, "review-linked"));
    writeFileSync(join(elsewhere, "review-linked", "SKILL.md"), SKILL);
    symlinkSync(
      join(elsewhere, "review-linked"),
      join(env.CLAUDE_CONFIG_DIR, "skills", "review-linked"),
    );

    // Sorted, and unfiltered: nothing in a skill declares that it reviews code.
    expect(userSkills(env)).toEqual(["create-pr", "review-linked", "review-pr"]);
    // No skills directory at all is the same answer as an empty one.
    expect(userSkills({ CLAUDE_CONFIG_DIR: "/nonexistent/engwire" })).toEqual([]);

    // A directory that cannot be read is not. Answering "you have none" would
    // send someone to write a skill they already have. A self-referential
    // symlink is an ELOOP whatever the process's privileges are.
    const broken = mkdtempSync(join(tmpdir(), "engwire-loop-"));
    scratches.push(broken);
    symlinkSync("skills", join(broken, "skills"));
    expect(() => userSkills({ CLAUDE_CONFIG_DIR: broken })).toThrow();

    // Nor is a root the preflight refuses. Listing skills from a directory
    // Claude will not read would offer a name that can never pass.
    expect(() => userSkills({ CLAUDE_CONFIG_DIR: "relative" })).toThrow("absolute");
    expect(() => userSkills({ CLAUDE_CONFIG_DIR: "" })).toThrow("absolute");
    expect(() => userSkills({ HOME: "relative" })).toThrow("absolute");
  });
});
