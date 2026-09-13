/**
 * @file `engwire setup` — create or check the local setup.
 *
 * Writes a config if there is none and resolves the absolute paths of `gh` and
 * `claude` (see launchd.ts for why that matters). Prerequisites are checked
 * with the same code `doctor` uses, so "check prerequisites" means the same
 * thing in both places.
 *
 * It deliberately does not start the watch. Running setup authorizes
 * nothing, and this command writes a config with no rules in it, so there is
 * no moment here for a watermark to belong to: `run` sets it when a runner
 * first starts with a rule configured.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeRootProblem, skillFile, userSkills } from "../claude/skills.ts";
import { isSkillName, starterConfig } from "../config/config.ts";
import { absolutePath, paths } from "../config/paths.ts";
import { diagnose } from "./doctor.ts";
import { LINUX_DOCS } from "./service.ts";

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
function skillListing(): { names: string[] } | { problem: string; reported: boolean } {
  const problem = claudeRootProblem();
  // `reported`, because the report above carries exactly one of these two: a
  // root Engwire cannot name gets a red `claude root` row, and a directory that
  // will not list gets nothing at all — the root is absolute, so that row is a
  // ✓, and a config this command has only just written names no skill, so no
  // per-skill row went looking either.
  if (problem) return { problem, reported: true };
  try {
    return { names: userSkills().filter(isSkillName) };
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : String(error),
      reported: false,
    };
  }
}

export async function setup(): Promise<number> {
  const p = paths();

  const created = !(await Bun.file(p.configFile).exists());
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
    writeFileSync(p.configFile, starterConfig({ ghBin, claudeBin }), { mode: 0o600 });
    console.log(`Wrote ${p.configFile}`);
  }

  // A fresh install has no review rules on purpose, so their absence is not a
  // failed setup. `doctor` and `service install` still treat it as fatal,
  // because a runner with no rules cannot do anything.
  const checks = await diagnose(process.env, { requireReviewRules: !created });
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(11)} ${check.note}`);
  }
  console.log("");

  if (created) {
    // Only on a fresh config. Saying this over an existing file with three
    // active rules in it would simply be false.
    console.log("Engwire is configured but reviewing nothing yet — it starts an agent");
    console.log("on a contributor's code, so which repositories that happens for is");
    console.log(`yours to choose. Uncomment a [[review]] rule in ${p.configFile}.`);
    console.log("");
    // Engwire ships no skill. Offer installed names the config accepts without
    // inventing what a review should do or handing someone an invalid value.
    // Listing failures must still leave the next steps visible after writing config.
    const listing = skillListing();
    if ("problem" in listing) {
      // Reuse the failed root row; directory-read failures need their own message.
      console.log("Its `skill` names a Claude Code skill of yours. Which ones you have");
      console.log(
        listing.reported ? "cannot be read — see the ✗ above." : `cannot be read: ${listing.problem}`,
      );
    } else if (listing.names.length > 0) {
      console.log("Its `skill` names one of yours:");
      for (const line of columns(listing.names)) console.log(`  ${line}`);
    } else {
      // Safe here and only here: the listing succeeded, so the root `skillFile`
      // resolves through is one Engwire can name.
      console.log("Its `skill` names a Claude Code skill of yours, and none here can go");
      console.log(`in a rule yet — Engwire ships no reviewer. Create ${skillFile("<name>")}.`);
    }
  } else {
    console.log(`Config: ${p.configFile}`);
  }

  console.log("");
  console.log("Then:");
  // Re-read the edited config and its skill before starting a runner.
  console.log("  engwire doctor           re-check after editing the config");
  console.log("  engwire run --once       one poll, at most one review, then exit");
  for (const line of backgroundNote()) console.log(line);
  console.log("");
  console.log("Engwire starts watching when a runner first starts with a rule");
  console.log("configured. Requests made before that are not reviewed.");
  return checks.every((check) => check.ok) ? 0 : 1;
}
