/**
 * @file `engwire service install` / `uninstall`.
 *
 * Its own file because installing is not dispatch: it decides what to
 * supervise, refuses a setup that would not run, and has to reason about an
 * environment other than its own.
 */

import { loadConfig } from "../config/config.ts";
import { LOCATORS, locatesData, paths } from "../config/paths.ts";
import { isAbsolute } from "node:path";
import * as launchd from "../service/launchd.ts";
import { diagnose } from "./doctor.ts";

/** Return platform guidance separately so it can be tested on either platform. */
export function unsupportedNote(action: string): string[] {
  return [
    `engwire service ${action} is available only on macOS. Run \`engwire run\` under your platform's supervisor:`,
    LINUX_DOCS,
  ];
}

function unsupported(action: string): number {
  for (const line of unsupportedNote(action)) console.error(line);
  return 1;
}

/** Installed binaries need a web URL because no checkout is required. */
export const LINUX_DOCS = "https://github.com/engwire/engwire/blob/main/docs/linux.md";

/**
 * Path settings that will not retain their meaning in a service plist.
 *
 * The plist preserves no working directory, so every carried root must be
 * absolute and non-empty. It must also name a data directory explicitly;
 * falling back to the reader's process would make Engwire adopt an
 * unidentifiable service as its own.
 */
const ROOTS = [
  "HOME",
  "ENGWIRE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "GH_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
] as const;

export function servicePathProblems(environment: Record<string, string>): string[] {
  const problems = ROOTS.filter((name) => name in environment && !isAbsolute(environment[name] ?? ""))
    .map((name) =>
      environment[name] === ""
        ? `${name} is set to nothing`
        : `${name}=${environment[name]} is relative`,
    );
  // Do not report a missing locator when an invalid one already explains it.
  if (!locatesData(environment) && !LOCATORS.some((name) => name in environment)) {
    problems.push(`nothing here names a data directory: ${LOCATORS.join(", ")}`);
  }
  return problems;
}

/**
 * What `install` says when the existing plist named another installation.
 *
 * Describe the plist snapshot, not the job displaced: another install could
 * replace it before this one reaches launchctl.
 */
export function replacementNotice(previous: launchd.InstalledPlist): string[] {
  if (previous.whose !== "theirs") return [];
  return [
    previous.supervises === null
      ? "The service here was not one this installation could identify."
      : `The service here was configured for ${previous.supervises}.`,
    "One Engwire job runs under one label, so this installation now owns it.",
  ];
}

export async function serviceInstall(): Promise<number> {
  if (process.platform !== "darwin") return unsupported("install");

  // Running from source means `process.execPath` is the Bun binary, and
  // installing *that* would give launchd `bun run` with no script. Bun answers
  // this directly; sniffing the executable's name got it wrong both ways — a
  // compiled binary that happens to be called `bun` is perfectly installable,
  // and a Bun runtime installed under another name is not.
  if (!Bun.isStandaloneExecutable) {
    console.error(
      "engwire service install needs an installed engwire binary; it cannot supervise a source checkout.",
    );
    return 1;
  }

  // One environment object, used for all three: what the plist will carry, what
  // the preflight subprocesses run in, and which config file `paths()` resolves.
  // Diagnosing the installing shell instead would approve credentials the
  // service never sees and a config file it never reads.
  const environment = launchd.serviceEnvironment();

  // Before the preflight, because this is not a question about whether the setup
  // works — it is whether the record about to be written means anything.
  const problems = servicePathProblems(environment);
  if (problems.length > 0) {
    console.error("Not installing — these service path settings are not usable:\n");
    for (const row of problems) console.error(`✗ ${row}`);
    console.error("\nThe plist carries these values verbatim, and nothing in it preserves the");
    console.error("directory you are standing in — so a relative one has no settled meaning");
    console.error("once this shell is gone, and a data directory the plist never names is a");
    console.error("job Engwire cannot recognise as its own. A relative value wants an");
    console.error("absolute spelling of the same location; an empty one can simply be unset;");
    console.error(`and one of ${LOCATORS.join(", ")} has to name the installation.`);
    return 1;
  }

  const failed = (await diagnose(environment)).filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error("Not installing — the background runner would not work:\n");
    for (const check of failed) console.error(`✗ ${check.label.padEnd(11)} ${check.note}`);
    console.error(
      "\nBackground review needs authentication that outlives a shell: `gh auth login`",
    );
    console.error("and `claude auth login` store credentials; exported tokens do not.");
    return 1;
  }

  const p = paths(environment);
  const config = await loadConfig(p.configFile);
  const previous = launchd.installedPlist(p.dataDir);
  await launchd.install({
    executable: process.execPath,
    logsDir: p.logsDir,
    environment,
    runTimeoutMs: config.advanced.runTimeoutMs,
  });
  // The plist pins this exact binary, which may go stale after an upgrade.
  console.log(`Installed ${launchd.plistPath()} — runs ${process.execPath}`);
  for (const line of replacementNotice(previous)) console.log(line);
  console.log("Reinstall after editing config.toml; a running service does not reload it.");
  return 0;
}

export async function serviceUninstall(): Promise<number> {
  if (process.platform !== "darwin") return unsupported("uninstall");
  await launchd.uninstall();
  console.log("Uninstalled");
  return 0;
}
