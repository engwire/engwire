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
 *
 * The `\n` before it is bare on purpose. A `\r?` there would take the carriage
 * return off the last declaration in a CRLF file, so one `\r` would be removed
 * here and a second by the value normalisation — two of them read as one line
 * ending, and only for the last line in the block. Left in, the rule holds
 * everywhere: one `\r` is the line ending, and any others stay in the value.
 */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\n---[ \t]*(?:\r?\n|$)/;

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
 *
 * `[^\n]*` rather than `.`, which stops at a `\r` or a U+2028 while `$` matches
 * before one — so `user-invocable: true\rgarbage` would read as a tidy `true`
 * and the rest of the author's line would be discarded unseen. A newline is the
 * only separator here; everything else stays in the value, where it is refused.
 */
const DECLARATION = /^[ \t]*(["']?)user-invocable(["']?)[ \t]*:([^\n]*)$/gm;

/**
 * Values Engwire accepts as keeping a skill invocable, matched exactly. Claude
 * accepts more measured spellings, but generalising from them risks
 * claiming and spending a review request if one stops working.
 */
const INVOCABLE = new Set(["true", "1", "yes", "on"]);

/**
 * A measured reserved folder name. Claude returned success without invoking a
 * valid skill at this path, so the runner must reject it before claiming work.
 */
const RESERVED = "synced";

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
  // Remove one CR from a CRLF line ending, then only the spaces and tabs Claude
  // was measured to ignore. Quotes, comments and other Unicode whitespace stay
  // in the value and therefore fail closed.
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const value = line.replace(/^[ \t]+|[ \t]+$/g, "");
  return INVOCABLE.has(value)
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
