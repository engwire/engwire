/**
 * @file `engwire setup` — create or check the local setup.
 *
 * Writes a config if there is none and resolves the absolute paths of `gh` and
 * `claude` (see launchd.ts for why that matters). Prerequisites are checked
 * with the same code `doctor` uses, so "check prerequisites" means the same
 * thing in both places.
 *
 * `--repo` writes an active rule after validating its patterns and skill.
 * Existing configs are never edited. Preflight refusals leave no new config,
 * so they can be repaired and retried; diagnostics run after writing the file.
 *
 * Setup does not start watching. `run` sets the watermark when a runner first
 * starts with a rule configured.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  claudeRootProblem,
  missingSkillProblem,
  skillFile,
  SKILL_INSTALL,
  SKILLS_REPO,
  skillPreflightProblem,
  userSkills,
} from "../claude/skills.ts";
import {
  ConfigError,
  isRepoPattern,
  isSkillName,
  parseConfig,
  REVIEW_SKILL,
  reviewRule,
  starterConfig,
} from "../config/config.ts";
import { absolutePath, paths } from "../config/paths.ts";
import { diagnose } from "./doctor.ts";
import { WATCHING } from "./run.ts";
import { LINUX_DOCS } from "./service.ts";

/**
 * What is wrong with the patterns on the command line, or null.
 *
 * Per-value first, for a message that names the flag the reader typed. Then the
 * rendered rule parsed back, because being able to match is a property of the
 * set rather than of a value: `--repo 'acme/*' --repo 'acme/api'` passes
 * `isRepoPattern` twice and is then refused by the parser, whose own message
 * says why. Validating the rule Engwire is about to write, rather than the
 * values it came from, is what makes the guarantee total.
 */
function repoProblem(repos: string[]): string | null {
  for (const repo of repos) {
    if (!isRepoPattern(repo)) {
      return `--repo ${JSON.stringify(repo)} is not "owner/name", "owner/*" or "*"`;
    }
  }
  try {
    parseConfig(reviewRule(repos));
    return null;
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
}

/**
 * Print the rule and refuse: an existing config is never modified.
 *
 * Non-zero because the operation asked for did not happen. The placement
 * sentence says "should not win" rather than "broader": an earlier narrower or
 * equivalent rule takes these repositories just as effectively.
 */
function refuseToEdit(configFile: string, repos: string[]): number {
  console.error("setup never edits a config that already exists:");
  console.error(`  ${configFile}`);
  console.error("");
  console.error("Add this rule yourself:");
  console.error("");
  for (const line of reviewRule(repos).trimEnd().split("\n")) console.error(line);
  console.error("");
  console.error("Rules use first match; place it before any existing rule that should");
  console.error("not win for these repositories.");
  return 1;
}

/**
 * Whether installing the reviewer is the remedy for this preflight problem.
 *
 * Match the resolver's missing-file message only after validating its root.
 * A separate existence check could confuse an unreadable path with an absent
 * file and recommend reinstalling when a permission is what needs repair.
 */
function answeredByInstalling(problem: string): boolean {
  return claudeRootProblem() === null && problem === missingSkillProblem(REVIEW_SKILL);
}

/**
 * Print the preflight's evidence — as `doctor` prints it — and the install
 * command when, and only when, that is what the evidence calls for.
 */
function refuseWithoutSkill(problem: string): number {
  console.error(`review skill ${REVIEW_SKILL}: ${problem}`);
  if (answeredByInstalling(problem)) {
    console.error("");
    console.error("Install it, then run setup again:");
    console.error(`  ${SKILL_INSTALL}`);
    console.error("");
    console.error(`That helper needs Node; Engwire does not. Installing by hand is`);
    console.error(`documented at ${SKILLS_REPO}.`);
  }
  return 1;
}

/**
 * Wrap comma-separated names without breaking one across lines.
 *
 * The default leaves two columns for `setup`'s indent in an 80-column terminal.
 * Character counts are terminal columns because callers pass ASCII skill names.
 */
export function columns(names: string[], width = 78): string[] {
  const lines: string[] = [];
  for (const [index, name] of names.entries()) {
    const piece = index === names.length - 1 ? name : `${name},`;
    const line = lines.at(-1);
    if (line !== undefined && `${line} ${piece}`.length <= width) {
      lines[lines.length - 1] = `${line} ${piece}`;
    } else {
      lines.push(piece);
    }
  }
  return lines;
}

/** Point to launchd installation on macOS and the systemd guide elsewhere. */
export function backgroundNote(platform: string = process.platform): string[] {
  if (platform === "darwin") {
    return ["  engwire service install  keep it running in the background"];
  }
  return [
    "",
    "Background supervision is macOS-only. To keep it running, put `engwire run`",
    "under your own supervisor. Here is a systemd example:",
    `  ${LINUX_DOCS}`,
  ];
}

/**
 * The skill names a rule could name, or why there is no list to show.
 *
 * Two ways this fails, and neither is an empty list: a configuration root
 * Engwire cannot inspect from a fixed place, and a skills directory that will
 * not list — a permission or a link loop, which `userSkills` rethrows rather
 * than flattening. Answering "you have none" to either sends somebody off to
 * write a skill they already have.
 *
 * The root is asked first because it is what both calls below resolve through:
 * a relative one makes `skillFile` throw exactly like `userSkills`, so the
 * fallback branch is no safer than the branch it stands in for.
 */
function skillListing(): { names: string[] } | { problem: string; reportedAbove: boolean } {
  const problem = claudeRootProblem();
  // `reportedAbove`, because the report carries exactly one of these two: a
  // root Engwire cannot name gets a red `claude root` row, and a directory that
  // will not list gets nothing at all — the root is absolute, so that row is a
  // ✓, and a config this command has only just written names no skill, so no
  // per-skill row went looking either.
  if (problem) return { problem, reportedAbove: true };
  try {
    return { names: userSkills().filter(isSkillName) };
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : String(error),
      reportedAbove: false,
    };
  }
}

export async function setup(options: { repos: string[] }): Promise<number> {
  const p = paths();
  const { repos } = options;
  const named = repos.length > 0;

  const created = !(await Bun.file(p.configFile).exists());
  // Validate patterns before suggesting a config edit, and refuse an existing
  // config before suggesting a skill install: neither fixes an earlier failure.
  if (named) {
    const problem = repoProblem(repos);
    if (problem) {
      console.error(problem);
      return 1;
    }
    if (!created) return refuseToEdit(p.configFile, repos);
    const skillProblem = skillPreflightProblem(REVIEW_SKILL);
    if (skillProblem) return refuseWithoutSkill(skillProblem);
  }

  if (created) {
    // Only a config being written needs these on PATH — it records their
    // absolute paths. An existing config may name binaries PATH does not
    // reach, which is legitimate, and `diagnose` is the authority on those.
    //
    // Searched with the relative entries removed, because this is the one place
    // that makes a resolution permanent: `setup` run from inside someone's
    // checkout would otherwise write their `gh` into the config and every later
    // review would use it, with `doctor` reporting the absolute path as healthy.
    const where = { PATH: absolutePath() };
    const ghBin = Bun.which("gh", where);
    const claudeBin = Bun.which("claude", where);
    if (!ghBin || !claudeBin) {
      if (!ghBin) console.error("gh is not installed. See https://cli.github.com.");
      if (!claudeBin) console.error("claude is not on PATH. See https://claude.com/claude-code.");
      return 1;
    }

    mkdirSync(dirname(p.configFile), { recursive: true, mode: 0o700 });
    writeFileSync(p.configFile, starterConfig({ ghBin, claudeBin, repos }), { mode: 0o600 });
    console.log(`Wrote ${p.configFile}`);
  }

  // Only a new bare setup deliberately writes no rules. Doctor and service
  // install still require them, as does setup when given --repo.
  const checks = await diagnose(process.env, { allowNoReviewRules: created && !named });
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(11)} ${check.note}`);
  }
  console.log("");
  const ok = checks.every((check) => check.ok);

  if (created && !named) {
    console.log("Engwire is configured but reviewing nothing yet — it starts an agent");
    console.log("on a contributor's code, so which repositories that happens for is");
    console.log(`yours to choose. Uncomment a [[review]] rule in ${p.configFile}.`);
    console.log("");
    // Offer a known reviewer before listing skills whose purpose is unknown.
    // Listing failures must still leave next steps visible after writing config.
    const listing = skillListing();
    console.log("Its `skill` names the Claude Code skill that does the reviewing.");
    console.log("Engwire ships none. Install the one it is built around:");
    console.log("");
    console.log(`  ${SKILL_INSTALL}`);
    console.log("");
    console.log("That helper needs Node; Engwire does not. Installing by hand is");
    console.log(`documented at ${SKILLS_REPO}.`);
    console.log("");
    if ("problem" in listing) {
      // Reuse the failed root row; directory-read failures need their own message.
      console.log(
        listing.reportedAbove
          ? "Installed skills cannot be listed — see ✗ claude root above."
          : `Installed skills cannot be listed: ${listing.problem}`,
      );
    } else if (listing.names.length > 0) {
      console.log("Or name one you already have. Engwire cannot tell which of these is a reviewer:");
      for (const line of columns(listing.names)) console.log(`  ${line}`);
    } else {
      // Safe here and only here: the listing succeeded, so the root `skillFile`
      // resolves through is one Engwire can name.
      console.log(`Or write your own at ${skillFile("<name>")}.`);
    }
    console.log("");
  } else if (!created) {
    console.log(`Config: ${p.configFile}`);
    console.log("");
  }

  console.log("Then:");
  if (created && named) {
    // The config now exists, so repairs go through doctor; repeating setup
    // --repo would refuse instead of checking the repaired prerequisites.
    if (!ok) {
      console.log("  engwire doctor           re-check once the ✗ rows above are fixed");
    }
    console.log("  engwire run              watch for review requests and review them");
  } else {
    // Re-read the edited config and its skill before starting a runner.
    console.log("  engwire doctor           re-check after editing the config");
    console.log("  engwire run --once       one poll, at most one review, then exit");
  }
  for (const line of backgroundNote()) console.log(line);
  console.log("");
  if (created && named) {
    if (!ok) {
      console.log("The config is written and setup never edits one that exists, so fix the");
      console.log("✗ rows above rather than running this again.");
      console.log("");
    }
    // Distinguish the cutoff — the runner's start — from readiness, which can
    // come later, and quote the runner's actual message so the reader is not
    // waiting for a line that never appears. "That second", not "before the
    // runner started": the boundary is floored to the second GitHub reports a
    // request in, so one made earlier in the same second is inside it.
    console.log("Watching begins the second `engwire run` starts, and nothing requested");
    console.log(`before that second is reviewed. It prints \`${WATCHING}\``);
    console.log("once it is ready, so ask for your review after that line.");
  } else {
    console.log("Engwire starts watching the second a runner first starts with a rule");
    console.log("configured, and nothing requested before that second is reviewed.");
  }
  return ok ? 0 : 1;
}
