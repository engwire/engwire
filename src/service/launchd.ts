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
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { locatesData, paths } from "../config/paths.ts";
import { isAbsolute, join } from "node:path";

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

/**
 * Which installation the service plist belongs to.
 *
 * Engwire installs one job under one fixed label in the user's launchd domain,
 * while `ENGWIRE_HOME` can point at several installations — so "is this job
 * mine?" has to be asked before anything reports on it.
 *
 * An installation *is* its data directory: the queue, the runner lock and the
 * worktrees all key on that, so two environments resolving to the same one are
 * the same installation however their config roots differ.
 *
 * Not necessarily the job launchd currently has loaded: `install` replaces the
 * plist before booting out the old job.
 *
 * A plist that does not say whose it is counts as another's. The job it
 * describes may be a runner in the middle of a review, and `engwire service
 * uninstall` remains the command that removes the user's job without asking
 * whose it is.
 */
export type InstalledPlist =
  | { whose: "none" }
  | { whose: "ours"; plistPath: string; executable: string }
  | { whose: "theirs"; plistPath: string; supervises: string | null };

/**
 * @param dataDir The installation asking.
 * @param plistFile The plist to read. Defaults to the fixed per-user path on
 * macOS and to no plist elsewhere. An explicit path works on any platform for
 * tests.
 */
export function installedPlist(
  dataDir: string,
  plistFile: string | null = process.platform === "darwin" ? plistPath() : null,
): InstalledPlist {
  if (plistFile === null) return { whose: "none" };
  let source: string;
  try {
    source = readFileSync(plistFile, "utf8");
  } catch (error) {
    // Absent is no plist, which is not quite no service: a job stays loaded
    // after somebody deletes the file describing it, and only launchd can be
    // asked about that. Present and unreadable is a plist this cannot identify,
    // which the rule above makes somebody else's. Neither may throw: `service
    // install` asks this, and it is the command that repairs a service.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { whose: "none" };
    return { whose: "theirs", plistPath: plistFile, supervises: null };
  }
  // Ignore commented-out keys before matching the generated document shape.
  const plist = source.replace(/<!--[\s\S]*?-->/g, "");
  const generated = parseGenerated(plist);
  // The label is the job `uninstall` boots out, so only a plist carrying it
  // describes something this could act on — and nothing else gets an
  // installation identity. Reporting that a foreign job "supervises" this
  // installation is worse than reporting nothing about it.
  if (!generated || generated.label !== LABEL) {
    return { whose: "theirs", plistPath: plistFile, supervises: null };
  }
  // An environment that locates nothing would resolve through `paths()`'s own
  // fallbacks to the *asking* installation and read as `ours` — the one answer
  // this must not give about a job it cannot identify.
  const supervises = locatesData(generated.environment) ? paths(generated.environment).dataDir : null;
  if (supervises !== dataDir) return { whose: "theirs", plistPath: plistFile, supervises };
  return {
    whose: "ours",
    plistPath: plistFile,
    executable: generated.executable,
  };
}

/**
 * Match the head of the generated root dictionary — the three keys ownership
 * turns on — rather than finding each independently, which could combine values
 * from nested dictionaries. What follows is read only to check that none of
 * those three keys comes round again.
 */
const GENERATED =
  /^<\?xml[^>]*\?>\s*<!DOCTYPE[^>]*>\s*<plist[^>]*>\s*<dict>\s*<key>Label<\/key>\s*<string>([^<]*)<\/string>\s*<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>run<\/string>\s*<\/array>\s*<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/;

/** A key name, spelled plainly — never an entity, a character reference, or anything else to decode. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The three the head established. Meeting one again means the document disagrees with itself. */
const OWNERSHIP = new Set(["Label", "ProgramArguments", "EnvironmentVariables"]);

/** What a plist says it is: which job, which program, and for which installation. */
function parseGenerated(
  plist: string,
): { label: string; executable: string; environment: Record<string, string> } | null {
  const match = GENERATED.exec(plist);
  if (!match) return null;
  // The head is matched, but the rest of the root dictionary could repeat one
  // of the three keys ownership turns on. Whether launchd then takes the first,
  // the last, or refuses the file has not been measured here, so a document
  // that repeats one is not a document this will answer about.
  const tail = plist.slice(match[0].length);
  for (const [, name = ""] of tail.matchAll(/<key\b[^>]*>([\s\S]*?)<\/key>/g)) {
    // Attributes and all, because the name is whatever a reader would take from
    // between the tags: `<key x="">Label</key>` says `Label`. So do
    // `<key><![CDATA[Label]]></key>` and `<key>La&#98;el</key>`, but this reader
    // decodes neither, so rather than learn to, it declines to answer about a
    // document that spells a key anything but plainly.
    if (!KEY_NAME.test(name) || OWNERSHIP.has(name)) return null;
  }
  const executable = unxml(match[2] as string);
  // `install` records an absolute path and never revisits it. A bare name would
  // resolve against the PATH of whoever is diagnosing, which is not the one
  // launchd hands the job.
  if (!isAbsolute(executable)) return null;
  // `plist()` writes a flat dictionary of pairs. The capture above stops at the
  // first `</dict>`, so a nested one would otherwise hand its keys up as though
  // they were the job's own: require the whole body to be pairs and whitespace.
  const body = match[3] ?? "";
  const environment: Record<string, string> = {};
  let read = 0;
  for (const pair of body.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    if (body.slice(read, pair.index).trim() !== "") return null;
    const key = pair[1] as string;
    // Same rule, and the same reason: `ENGWIRE&#95;HOME` is a second
    // `ENGWIRE_HOME` to launchd, and a different string to the check below.
    if (!KEY_NAME.test(key)) return null;
    // `Object.entries` cannot produce the same key twice, so one that repeats
    // did not come from here.
    if (key in environment) return null;
    environment[key] = unxml(pair[2] as string);
    read = pair.index + pair[0].length;
  }
  if (body.slice(read).trim() !== "") return null;
  return { label: unxml(match[1] as string), executable, environment };
}

/** The inverse of `xml()`. Ampersands last, or an escaped entity unescapes twice. */
function unxml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
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
  // Bytes to put back, `null` for nothing to put back, and `undefined` for a
  // plist that is there and unreadable. Three different rollbacks: collapsing
  // the last two would delete this user's only plist while its job is
  // still loaded. Not a reason to refuse the command either — this is what
  // someone runs when the installed service is the thing that is wrong.
  let previous: Buffer | null | undefined;
  try {
    previous = readFileSync(file);
  } catch (error) {
    previous = (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  // Two `service install`s at once are not supported: they share this pathname
  // and the label they bootstrap, so one can end up loading the other's plist.
  // A laptop command someone types is not worth a cross-installation lock.
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
  // put back when its bytes could be read.
  const restore = () => {
    if (previous) writeFileSync(file, previous, { mode: 0o600 });
    else if (previous === null) rmSync(file, { force: true });
    // Unreadable: no bytes to put back, and removing the plist just written
    // would leave a loaded job with nothing on disk describing it at all.
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
