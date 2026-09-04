/**
 * @file `engwire service install` / `uninstall`.
 *
 * Its own file because installing is not dispatch: it decides what to
 * supervise, refuses a setup that would not run, and has to reason about an
 * environment other than its own.
 */

import { loadConfig } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import * as launchd from "../service/launchd.ts";
import { diagnose } from "./doctor.ts";

/**
 * launchd is the only supervisor, so this is the only place that knows it.
 *
 * A platform-neutral service layer over one implementation would add an
 * abstraction without hiding any current variation.
 */
function unsupported(action: string): number {
  console.error(
    `engwire service ${action} is available only on macOS. Run \`engwire run\` under your platform's supervisor.`,
  );
  return 1;
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
