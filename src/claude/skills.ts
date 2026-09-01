/** @file Discovery and preflight checks for the reviewer's Claude Code skills. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * `--setting-sources user` is the boundary, so user scope is the only scope
 * that counts — a skill checked into the branch under review is deliberately
 * not loaded, and one from a plugin is not what a rule names.
 *
 * That skills follow `CLAUDE_CONFIG_DIR` is inferred from the CLI's treatment
 * of the rest of that root, so a failed check names the exact path inspected
 * rather than claiming more.
 *
 * What is validated is the resolved root, not the variable it came from: either
 * source can be relative, and Claude resolves a relative root from the pull
 * request it runs in rather than from wherever the runner started. Throwing is
 * what keeps listing and preflight from answering about different directories.
 *
 * `env` is an argument for the same reason it is one in `paths()` — `service
 * install` asks what the *service* will see, not what this shell sees.
 */
function skillsDir(env: Record<string, string | undefined>): string {
  const root = env.CLAUDE_CONFIG_DIR ?? join(env.HOME || homedir(), ".claude");
  if (!isAbsolute(root)) {
    throw new Error(
      `Claude's configuration root is not an absolute path (${JSON.stringify(root)}); Claude resolves it from the directory it runs in, which is the pull request`,
    );
  }
  return join(root, "skills");
}

/** The path Claude uses to identify an installed skill. Throws on a root this cannot inspect. */
export function skillFile(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(skillsDir(env), name, "SKILL.md");
}

/**
 * The block a `SKILL.md` declares things about itself in. The closing `---` has
 * to be a line of its own: `---oops` ending the block early would put the rest
 * of the declarations outside it, where they read as no declaration at all.
 */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A file that opens a block `FRONT_MATTER` cannot close is one this cannot read. */
const OPENS_FRONT_MATTER = /^---\r?\n/;

/**
 * Match the key spellings Claude honors, including a quoted key and whitespace
 * before the colon. The key stays case-sensitive because other casings were not
 * established as declarations.
 *
 * Recognition is deliberately broader than acceptance, in both directions a
 * declaration can be unreadable: the value is the rest of the line, and the
 * quotes around the key are captured rather than required to match or to be
 * the measured character. A pattern that only matched measured spellings would
 * read `user-invocable: banana split`, `"user-invocable: true` or
 * `'user-invocable': true` as no declaration at all — and no declaration means
 * invocable. Whether the value or the key is the unmeasured part, it is
 * `frontMatterProblem` that refuses it.
 */
const DECLARATION = /^[ \t]*(["']?)user-invocable(["']?)[ \t]*:(.*)$/gm;

/**
 * Values measured to keep a skill invocable by name. Claude does not treat this
 * as a YAML boolean; anything outside this set is conservatively rejected.
 */
const INVOCABLE = new Set(["true", "1", "yes", "on"]);

/**
 * A measured reserved folder name. Claude returned success without invoking a
 * valid skill at this path, so the runner must reject it before claiming work.
 */
const RESERVED = "synced";

/**
 * The declared value, normalized only where Claude was measured indifferent: a
 * matching pair of double quotes, since `"true"` was measured invocable.
 * `'true'` was never measured either way, so it is left as it is and refused
 * with everything else unmeasured.
 *
 * A trailing `# comment` is deliberately left in for the same reason. YAML
 * would strip it; whether Claude does was never measured, and the readings
 * disagree exactly where being wrong is expensive — an unmeasured spelling held
 * is a line in `doctor`, one claimed is a review request spent on nothing.
 */
function declaredValue(line: string): string {
  const value = line.trim();
  const quoted = /^"([\s\S]*)"$/.exec(value);
  return quoted ? (quoted[1] ?? "") : value;
}

/**
 * What the front matter says that would stop Claude invoking this skill by
 * name, or null. Unknown values, malformed key quoting, duplicate declarations
 * and a block that never closes all fail closed — each is a spelling Claude was
 * never measured to honour, and the cost of guessing wrong is a spent request.
 */
function frontMatterProblem(source: string): string | null {
  const block = FRONT_MATTER.exec(source);
  if (!block) {
    return OPENS_FRONT_MATTER.test(source)
      ? "opens a front-matter block that never closes on a line of its own, so what it declares cannot be read"
      : null;
  }
  const declarations = [...(block[1] ?? "").matchAll(DECLARATION)];
  if (declarations.length === 0) return null;
  const only = "only true, 1, yes or on keeps a skill invocable";
  if (declarations.length > 1) return `declares user-invocable more than once; ${only}`;
  const [, open = "", close = "", raw = ""] = declarations[0] ?? [];
  // Only an unquoted or double-quoted key was measured. Single quotes are as
  // unestablished as a mismatched pair, and reading either as a declaration
  // Claude honours would normalize unmeasured syntax into a measured `true`.
  if (open !== close || open === "'") {
    return `quotes the key as ${open}user-invocable${close}, which is not a spelling Claude was measured to honour`;
  }
  const value = declaredValue(raw);
  return INVOCABLE.has(value.toLowerCase())
    ? null
    : `declares user-invocable: ${JSON.stringify(value)}; ${only}`;
}

/**
 * What Engwire can establish against this skill before running it: the name is
 * reserved, the configuration root is relative, the file is missing or
 * unreadable, or its front matter does not leave it invocable. Null means none
 * of those — never that Claude will run it.
 *
 * `skillOverrides: "off"` can still disable a skill that passes this check. It
 * is deliberately excluded: interpreting Claude's settings would duplicate
 * another product's configuration model. Front matter is checked because it is
 * local to the file already being read and a non-invocable skill fails silently.
 *
 * The returned string is evidence, not a verdict: `doctor` prints it as-is.
 */
export function skillPreflightProblem(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (name.toLowerCase() === RESERVED) {
    return `${name} is a folder name Claude Code reserves, so it is skipped rather than run`;
  }
  // The root is resolved here rather than guarded separately: `skillsDir`
  // refuses one it cannot inspect, and this is where that becomes evidence.
  let file: string;
  try {
    file = skillFile(name, env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    // Absent and unreadable are different problems with different fixes.
    // Reporting a permission error as "no SKILL.md" sends someone to reinstall
    // a file that is already there.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return `no SKILL.md at ${file}`;
    return `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const problem = frontMatterProblem(source);
  return problem === null ? null : `${file} ${problem}`;
}

/**
 * Every skill on the filesystem at user scope — what `setup` can list as
 * already present, without writing one for them.
 *
 * Not filtered to review or invocable skills: nothing declares its purpose, and
 * this list makes no validity claim. A missing skills directory is empty.
 *
 * The entry's own type is deliberately not consulted. Skills are commonly
 * symlinks into a dotfiles repository, and a `Dirent` reports `lstat`, so
 * filtering on `isDirectory()` would hide linked skills.
 */
export function userSkills(env: Record<string, string | undefined> = process.env): string[] {
  const dir = skillsDir(env);
  try {
    return readdirSync(dir)
      .filter((entry) => existsSync(join(dir, entry, "SKILL.md")))
      .sort();
  } catch (error) {
    // No skills directory is an empty list; a directory that cannot be read is
    // not, and answering "you have none" would send someone to write a skill
    // they already have.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}
