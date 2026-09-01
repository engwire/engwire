/**
 * @file Running Engwire under launchd — the only supervisor Engwire knows.
 *
 * The one detail that catches everyone: launchd gives an agent a minimal PATH,
 * so a `gh` in Homebrew and a `claude` in `~/.local/bin` are both invisible to
 * it. The plist carries the PATH from the shell that installed the service, and
 * `engwire setup` records absolute paths in the config as well — two belts,
 * because the failure mode is a runner that starts cleanly and then fails every
 * review with "command not found".
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.engwire.local";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/**
 * A plist is XML, and everything interpolated into one here comes from the
 * environment or the filesystem: an `&` in any of it would produce a file
 * launchd refuses to parse.
 *
 * `Bun.escapeHTML` is named for HTML but escapes exactly the five characters
 * XML reserves, and its `&#x27;` for an apostrophe is a numeric reference XML
 * accepts. Non-ASCII is left alone, so a home directory like `/Users/José`
 * survives — checked, because a mangled path is a service that never starts.
 */
const xml = Bun.escapeHTML;

/**
 * The environment the service will run in — one object, used three ways.
 *
 * It is written into the plist, it is what `service install` diagnoses against,
 * and it is what resolves the paths that preflight inspects. Keeping those
 * three in one place is the difference between "preflight uses the environment
 * the service gets" being true and being a comment two implementations have to
 * keep aligned.
 *
 * Two kinds of variable, treated differently. Configuration roots —
 * `ENGWIRE_HOME`, the XDG paths, `GH_CONFIG_DIR`, `CLAUDE_CONFIG_DIR` — are
 * carried, because their contents *are* the configuration and the account the
 * service will use. Credentials — `GH_TOKEN`, `ANTHROPIC_API_KEY` — are
 * deliberately dropped rather than copied: both tools prefer them to anything
 * stored, so carrying them would put a shell secret in a plist, and diagnosing
 * with them would approve exactly the setup that is about to fail. Background
 * review needs authentication that outlives a shell.
 *
 * An empty value is carried as an empty value. A function whose contract is
 * "the environment the service will see" should not turn a variable that is
 * set into one that is absent; the checks downstream fail closed on it.
 */
const CARRIED = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "ENGWIRE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "GH_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
] as const;

export function serviceEnvironment(
  from: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = { PATH: from.PATH ?? "/usr/bin:/bin" };
  for (const key of CARRIED) {
    const value = from[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function plist(options: {
  executable: string;
  logsDir: string;
  /** Exactly what `service install` diagnosed against. */
  environment: Record<string, string>;
  /** Upper bound used to leave enough time for review shutdown and cleanup. */
  runTimeoutMs: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.executable)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(options.environment)
    .map(([key, value]) => `\n    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!--
    Without this, launchd's wait between SIGTERM and SIGKILL is whatever the
    system decides, so it may kill the runner before the review process group
    has received the signal and completed cleanup. Bounded by Engwire's own
    review timeout plus a grace period, because zero means infinity here and
    would stall shutdown.
  -->
  <key>ExitTimeOut</key><integer>${Math.ceil(options.runTimeoutMs / 1000) + 30}</integer>
  <!--
    63 is decimal for 0077 — the log holds private repository names and review
    errors. Written as an integer because that is the form every version of
    launchd.plist(5) documents; the octal-string form works on current macOS
    (measured) but is a newer spelling.
  -->
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(options.logsDir, "runner.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(options.logsDir, "runner.log"))}</string>
</dict>
</plist>
`;
}

/** Where a user agent lives. Darwin only, and `getuid` is always there. */
const userDomain = (): string => `gui/${process.getuid!()}`;

export async function install(options: {
  executable: string;
  logsDir: string;
  environment: Record<string, string>;
  runTimeoutMs: number;
}): Promise<void> {
  const file = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(options.logsDir, { recursive: true, mode: 0o700 });
  chmodSync(options.logsDir, 0o700);
  // `Umask` in the plist only governs files launchd creates. An existing
  // `runner.log` — from an older install, a stray `touch`, a restore — is
  // opened as it is, and it holds repository names and review errors.
  const log = join(options.logsDir, "runner.log");
  closeSync(openSync(log, "a", 0o600));
  chmodSync(log, 0o600);
  // Written beside the plist and renamed over it: a failure partway through —
  // a full disk is the ordinary one — would otherwise leave a working service
  // described by a truncated file. The rename is atomic within the directory,
  // so the old plist is either replaced or untouched.
  //
  // launchd refuses a plist that is group- or world-writable, and an existing
  // one keeps whatever mode it already had, so set it rather than assume it.
  const previous = existsSync(file) ? readFileSync(file) : null;
  const pending = `${file}.new`;
  try {
    writeFileSync(pending, plist(options), { mode: 0o600 });
    chmodSync(pending, 0o600);
    renameSync(pending, file);
  } finally {
    rmSync(pending, { force: true });
  }

  // Reinstalling is how a running service picks up an edited config, so from
  // here on the file on disk no longer describes what is loaded. Either
  // launchctl call can fail, and the plist that described the old install is
  // put back when one does.
  const restore = () => {
    if (previous) writeFileSync(file, previous, { mode: 0o600 });
    else rmSync(file, { force: true });
  };

  try {
    await launchctl(["bootout", `${userDomain()}/${LABEL}`], tolerateAbsent);
  } catch (error) {
    // The old job is still loaded and still running; only the file changed.
    restore();
    throw error;
  }

  try {
    await launchctl(["bootstrap", userDomain(), file], never);
  } catch (error) {
    restore();
    // The bootout above succeeded, so the old job is unloaded; loading it again
    // is best effort and deliberately silent. Whatever just refused the new
    // plist may refuse this too, and the original failure is the one to report.
    if (previous) await launchctl(["bootstrap", userDomain(), file], never).catch(() => {});
    throw error;
  }
}

export async function uninstall(): Promise<void> {
  // Only "it was not loaded" is tolerable. Any other failure may mean the
  // service is still running, and removing its plist and reporting success
  // would leave a supervised process nobody can find.
  await launchctl(["bootout", `${userDomain()}/${LABEL}`], tolerateAbsent);
  rmSync(plistPath(), { force: true });
}

/** `launchctl bootout` on a job that is not loaded: `3: No such process`. */
const tolerateAbsent = (exitCode: number, stderr: string): boolean =>
  exitCode === 3 || /no such process/i.test(stderr);

const never = (): boolean => false;

async function launchctl(
  args: string[],
  tolerate: (exitCode: number, stderr: string) => boolean,
): Promise<void> {
  const proc = Bun.spawn({
    // Absolute, not resolved: `launchctl` is part of macOS rather than a
    // dependency the reviewer chooses, so there is no PATH question to get
    // right. `service install` is also a command typed from wherever someone
    // is standing, which can be a contributor's checkout.
    cmd: ["/bin/launchctl", ...args],
    stdin: "ignore",
    // Only stderr is read, and an unread pipe is a child that blocks once it
    // fills.
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !tolerate(exitCode, stderr)) {
    throw new Error(`launchctl ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}
