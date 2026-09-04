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
import { skillFile, userSkills } from "../claude/skills.ts";
import { isSkillName, starterConfig } from "../config/config.ts";
import { absolutePath, paths } from "../config/paths.ts";
import { diagnose } from "./doctor.ts";

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
    const skills = userSkills().filter(isSkillName);
    if (skills.length > 0) {
      console.log("Its `skill` names one of yours:");
      for (const line of columns(skills)) console.log(`  ${line}`);
    } else {
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
  if (process.platform === "darwin") {
    console.log("  engwire service install  keep it running in the background");
  }
  console.log("");
  console.log("Engwire starts watching when a runner first starts with a rule");
  console.log("configured. Requests made before that are not reviewed.");
  return checks.every((check) => check.ok) ? 0 : 1;
}
