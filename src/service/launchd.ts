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
import { locatesData, paths, privateDir, resolveDeepest } from "../config/paths.ts";
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
 *
 * A carriage return needs one more thing, and it is the reason this is a
 * function rather than the escaper itself. XML normalises a literal `CR` to
 * `LF` before anything reads the document, so a path carrying one would reach
 * launchd as a *different* path than the one written — the preflight approving
 * one directory and the service running against another. Written as a
 * character reference it is content rather than a line end, and survives
 * intact. Nothing else moves: `LF` and tab are already what a reader sees.
 */
const xml = (text: string): string => Bun.escapeHTML(text).replaceAll("\r", "&#13;");

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

/**
 * launchd's shutdown allowance, measured from SIGTERM (docs/experiments.md).
 *
 * Leave headroom over the longer timed path: the agent's termination grace, or
 * worktree pruning plus git's termination grace. They do not run sequentially
 * after a stop: preparation cannot start an agent once aborted, and the loops
 * skip further reaping. launchd.test.ts checks this fixed budget against those
 * modules' deadlines without coupling the plist generator to them.
 *
 * Recursive directory removal has no deadline, so this is an allowance, not a
 * guarantee that cleanup finishes. If launchd kills the runner first, startup
 * marks remaining running rows interrupted rather than invoking the agent again.
 */
const EXIT_TIMEOUT_SECONDS = 90;

export function plist(options: {
  executable: string;
  logsDir: string;
  /** Exactly what `service install` diagnosed against. */
  environment: Record<string, string>;
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
    Allow time to terminate a review or finish worktree cleanup after SIGTERM.
    This fixed shutdown budget is independent of the configured review timeout;
    it does not guarantee completion of directory removal, which has no deadline.
  -->
  <key>ExitTimeOut</key><integer>${EXIT_TIMEOUT_SECONDS}</integer>
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
  | {
      whose: "ours";
      plistPath: string;
      executable: string;
      /** Stops and removes the job, or false if this installation can no longer claim it. */
      remove: () => Promise<boolean>;
    }
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
  let source: Uint8Array;
  try {
    // Bytes, not text: `readable` decodes them the way an XML processor must,
    // and a lenient decode here would have already lost the difference.
    source = readFileSync(plistFile);
  } catch (error) {
    // Absent is no plist, which is not quite no service: a job stays loaded
    // after somebody deletes the file describing it, and only launchd can be
    // asked about that — `jobState`, where the difference matters. Present and
    // unreadable is a plist this cannot identify, which the rule above makes
    // somebody else's. Neither may throw: `service install` asks this, and it
    // is the command that repairs a service.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { whose: "none" };
    return { whose: "theirs", plistPath: plistFile, supervises: null };
  }
  const generated = parseGenerated(source);
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
  if (supervises === null || !sameDirectory(supervises, dataDir)) {
    return { whose: "theirs", plistPath: plistFile, supervises };
  }
  return {
    whose: "ours",
    plistPath: plistFile,
    executable: generated.executable,
    remove: async () => {
      // `bootout` names the label, not the file this answer came from. Between
      // the two, another installation's `service install` can replace both the
      // plist and the job under that one label — and stopping *that* runner is
      // the thing this whole question exists to prevent. Re-reading does not
      // close the window; only a lock shared across installations could, and
      // `install` deliberately does not take one. It does close the wide part:
      // without this, the answer is from before a listing was printed and a
      // confirmation was typed.
      if (installedPlist(dataDir, plistFile).whose !== "ours") return false;
      // The file this answer came from, not the default one: the second
      // parameter exists so a test can point at a plist of its own, and a
      // removal that ignored it would boot the label out and delete the plist
      // of whatever service the machine running the tests actually has.
      await uninstall(plistFile);
      return true;
    },
  };
}

/**
 * Whether two paths name one data directory.
 *
 * An installation *is* its data directory, not its spelling, and the two can
 * differ: `/tmp` is a symlink to `/private/tmp` on macOS, and `service install`
 * records whatever `ENGWIRE_HOME` said at install time while `uninstall` reads
 * whatever it says now. Getting this wrong is expensive in one direction —
 * Engwire would refuse to stop its own service, and then delete the data that
 * service is still running against.
 *
 * Equal strings avoid the filesystem. Resolution cannot throw because
 * `service install` also uses this while repairing a broken service.
 */
function sameDirectory(a: string, b: string): boolean {
  return a === b || resolveDeepest(a) === resolveDeepest(b);
}

/**
 * Match the head of the generated root dictionary — the three keys ownership
 * turns on — rather than finding each independently, which could combine values
 * from nested dictionaries. What follows it is read pair by pair below.
 */
/** Characters XML 1.0 cannot hold at all: the C0 controls bar tab, LF and CR, and the non-characters. */
const ILLEGAL = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

/**
 * A comment where a comment may go: between elements, never inside a tag.
 *
 * The lookaround is the point. Stripping comments by their own syntax alone is
 * a rewrite, and a rewrite can manufacture a document that was never there —
 * `<pl<!--x-->ist version="1.0">` becomes the exact prolog below, out of a file
 * no XML reader accepts and launchd would never have loaded.
 *
 * The start of the document is not such a place. XML puts the declaration
 * before anything else, so a comment ahead of it means the `<?xml ...?>` that
 * follows is not a declaration at all — and taking the comment out would make
 * one appear.
 */
const GAP_COMMENT = /(?<=[>\t\n ])<!--(?:[^-]|-(?!-))*-->(?=[<\t\n ]|$)/g;

/**
 * The bytes as an XML processor would receive them, or `null` for a file no XML
 * processor would accept.
 *
 * Comments go because a commented-out key is not a key, and the file is read to
 * learn what launchd would make of it. Both halves of that are narrower than
 * they look: `--` cannot appear inside a comment, and a comment cannot appear
 * inside a tag, so only a comment that is both goes.
 *
 * The character check is the other half of the same idea. `\s` in a regex and
 * `trim()` each count a vertical tab, which XML cannot contain at all, and a
 * handful of Unicode spaces, which XML does not treat as whitespace — so the
 * structural gaps below name the ones XML allows, and text outside XML's
 * character range ends the answer here.
 */
function readable(bytes: Uint8Array): string | null {
  let source: string;
  try {
    // Fatal, because the lenient decode this used to get from `readFileSync`
    // turns a byte no UTF-8 document may contain into `U+FFFD` — a perfectly
    // legal character that then flows through every check below. A file whose
    // bytes are not the encoding it declares is one launchd rejects, and this
    // must not read an identity out of it.
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Line ends before anything else, as a processor does: a raw carriage return
  // is an `LF` to every XML reader and would otherwise be a different path here
  // from the one launchd hands the job.
  const text = source.replace(/\r\n?/g, "\n");
  if (ILLEGAL.test(text)) return null;
  return text.replace(GAP_COMMENT, "");
}

const PROLOG = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`;

const GENERATED =
  /^<dict>[ \t\n]*<key>Label<\/key>[ \t\n]*<string>([^<]*)<\/string>[ \t\n]*<key>ProgramArguments<\/key>[ \t\n]*<array>[ \t\n]*<string>([^<]*)<\/string>[ \t\n]*<string>run<\/string>[ \t\n]*<\/array>[ \t\n]*<key>EnvironmentVariables<\/key>[ \t\n]*<dict>([^]*?)<\/dict>/;

/** Nothing, or the whitespace XML leaves between elements once line ends are normalised. */
const GAP = /^[ \t\n]*$/;

/** A key name, spelled plainly — never an entity, a character reference, or anything else to decode. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What may follow the environment: the pairs `plist()` writes, then the close.
 *
 * Match value types, not exact values: a different ExitTimeOut or log location
 * does not change which installation owns the job. An unrecognised key or
 * value type makes ownership unknown.
 */
const TAIL_PAIR =
  /<key>([A-Za-z_][A-Za-z0-9_]*)<\/key>[ \t\n]*(?:<(true|false)\/>|<(integer)>-?\d+<\/integer>|<(string)>([^<]*)<\/string>)/g;

/** What closes the root dictionary, with nothing of the document left over. */
const CLOSE = /^[ \t\n]*<\/dict>[ \t\n]*<\/plist>[ \t\n]*$/;

/**
 * The root keys this version writes after the environment, each beside the kind
 * of value it writes there.
 *
 * Flexible about values and about which of these are present; closed about
 * meanings it does not have. The kind is one of those meanings rather than one
 * of those values: `Umask` going from 63 to 18 is the same setting differently
 * configured, while `Umask` going from an integer to a string is a spelling
 * this has never assigned a meaning to and launchd may well read as another. A key outside this set is one whose effect on the
 * job cannot be accounted for — `launchd.plist(5)` documents keys that decide
 * which executable actually runs and what the filesystem looks like to it — so
 * a document carrying one can identify this installation while describing a job
 * that is not it. That is the false ownership everything here exists to
 * prevent, and no denylist reaches the end of it.
 *
 * The set only ever grows, which is the direction that matters: a later version
 * adds its key here and still recognises every plist an earlier one wrote. The
 * reverse — an older binary meeting a newer plist — fails closed, which for an
 * ownership gate is the answer to want.
 *
 * The three the head established are deliberately absent: meeting one again
 * means the document disagrees with itself, and which one launchd would honour
 * is not measured.
 */
const TAIL_KEYS = new Map<string, readonly string[]>([
  ["RunAtLoad", ["true", "false"]],
  ["KeepAlive", ["true", "false"]],
  ["ExitTimeOut", ["integer"]],
  ["Umask", ["integer"]],
  ["StandardOutPath", ["string"]],
  ["StandardErrorPath", ["string"]],
]);

/** What a plist says it is: which job, which program, and for which installation. */
function parseGenerated(
  bytes: Uint8Array,
): { label: string; executable: string; environment: Record<string, string> } | null {
  const plist = readable(bytes);
  if (plist === null) return null;
  // Nothing is interpolated into the prolog, so there is nothing to be lenient
  // about: a document that opens differently is not this generator's, and
  // `<plist version=>` is not a document launchd would load at all.
  if (!plist.startsWith(PROLOG)) return null;
  const root = plist.slice(PROLOG.length);
  const match = GENERATED.exec(root);
  if (!match) return null;
  // The head is matched, but the rest of the root dictionary could repeat one
  // of the three keys ownership turns on. Whether launchd then takes the first,
  // the last, or refuses the file has not been measured here, so a document
  // that repeats one is not a document this will answer about.
  // The rest of the root dictionary, held to the rule the environment body is
  // already held to: the pairs `plist()` writes, and nothing else. A document
  // carrying anything else is not one this wrote, may be one launchd refuses to
  // load, and would then be a record of a job it does not describe. Truncation,
  // stray markup and a key spelled as an entity, a CDATA section or an
  // attributed tag all fail here together — one rule instead of a list of them
  // — and `TAIL_KEYS` then decides which names those pairs may carry.
  const tail = root.slice(match[0].length);
  let past = 0;
  for (const pair of tail.matchAll(TAIL_PAIR)) {
    // Nothing but whitespace between one pair and the next, so stray markup has
    // nowhere to sit. The environment body below is read the same way.
    if (!GAP.test(tail.slice(past, pair.index))) return null;
    // The kind is part of the meaning, not part of the value, so it is checked
    // beside the name: `Umask` as a string is a spelling nothing here has
    // assigned a meaning to and launchd may well read as another.
    const kind = pair[2] ?? pair[3] ?? pair[4];
    if (!TAIL_KEYS.get(pair[1] as string)?.includes(kind as string)) return null;
    // And the spelling rule the environment values are held to: `a & b` and
    // `&bogus;` are not XML the generator could have written, and a reader that
    // decodes them would not agree with this one about the document.
    if (pair[5] !== undefined && unxml(pair[5]) === null) return null;
    past = pair.index + pair[0].length;
  }
  // The close, and nothing after it. A document that simply stops is not one
  // `plist()` wrote, and an identity read out of a fragment would let it
  // authorize a bootout of whatever job is behind the label.
  if (!CLOSE.test(tail.slice(past))) return null;
  const executable = unxml(match[2] as string);
  // `install` records an absolute path and never revisits it. A bare name would
  // resolve against the PATH of whoever is diagnosing, which need not be the
  // one recorded for the service.
  if (executable === null || !isAbsolute(executable)) return null;
  // `plist()` writes a flat dictionary of pairs. The capture above stops at the
  // first `</dict>`, so a nested one would otherwise hand its keys up as though
  // they were the job's own: require the whole body to be pairs and whitespace.
  const body = match[3] ?? "";
  const environment: Record<string, string> = {};
  let read = 0;
  for (const pair of body.matchAll(/<key>([^<]*)<\/key>[ \t\n]*<string>([^<]*)<\/string>/g)) {
    if (!GAP.test(body.slice(read, pair.index))) return null;
    const key = pair[1] as string;
    // Same rule, and the same reason: `ENGWIRE&#95;HOME` is a second
    // `ENGWIRE_HOME` to launchd, and a different string to the check below.
    if (!KEY_NAME.test(key)) return null;
    // `Object.entries` cannot produce the same key twice, so one that repeats
    // did not come from here.
    if (key in environment) return null;
    const value = unxml(pair[2] as string);
    if (value === null) return null;
    environment[key] = value;
    read = pair.index + pair[0].length;
  }
  if (!GAP.test(body.slice(read))) return null;
  const label = unxml(match[1] as string);
  if (label === null) return null;
  return { label, executable, environment };
}

/**
 * The inverse of `xml()`, or `null` for text `xml()` could not have written.
 *
 * `xml()` emits six references and nothing else, so anything further to decode —
 * `&#47;` for a slash, `&apos;` for an apostrophe — is text launchd's XML
 * reader and this one would read differently, and what they would disagree
 * about is which installation a plist names. The key names above decline to be
 * decoded for that reason; this is the same rule from the value side, and
 * round-tripping through the generator is the whole of it.
 *
 * Ampersands last, or an escaped entity unescapes twice.
 */
function unxml(text: string): string | null {
  const decoded = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#13;/g, "\r")
    .replace(/&amp;/g, "&");
  return xml(decoded) === text ? decoded : null;
}

/** Where a user agent lives. Darwin only, and `getuid` is always there. */
const userDomain = (): string => `gui/${process.getuid!()}`;

export async function install(options: {
  executable: string;
  logsDir: string;
  environment: Record<string, string>;
}): Promise<void> {
  const file = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  privateDir(options.logsDir);
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
  // Bytes to put back, or `null` for none — absent and unreadable are the same
  // answer here, because the rename has already replaced whatever was there and
  // unreadable bytes were never available to restore. Not a reason to refuse
  // the command either: this is what someone runs when the installed service is
  // the thing that is wrong.
  let previous: Buffer | null;
  try {
    previous = readFileSync(file);
  } catch {
    previous = null;
  }
  // Two `service install`s at once are not supported: they share this pathname
  // and the label they bootstrap, so one can end up loading the other's plist.
  // A laptop command someone types is not worth a cross-installation lock.
  //
  // Uninstall re-reads ownership immediately before bootout, which narrows but
  // cannot close the race without a shared lock. The residual is documented in
  // `docs/specs/service-ownership.md`.
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
    // Nothing to put back means the record goes. Leaving it would be worse than
    // the loaded job with nothing describing it: the plist on disk would be
    // this installation's while the job behind the label is still whoever's it
    // was, and `uninstall` reads that plist and believes it. A job with no
    // record is the orphan `jobState` exists to find, and nothing claims one.
    else rmSync(file, { force: true });
  };

  try {
    await runLaunchctl(["bootout", `${userDomain()}/${LABEL}`], bootoutSaysAbsent);
  } catch (error) {
    // The old job is still loaded and still running; only the file changed.
    restore();
    throw error;
  }

  try {
    await runLaunchctl(["bootstrap", userDomain(), file], never);
  } catch (error) {
    restore();
    // The bootout above succeeded, so the old job is unloaded; loading it again
    // is best effort and deliberately silent. Whatever just refused the new
    // plist may refuse this too, and the original failure is the one to report.
    if (previous) await runLaunchctl(["bootstrap", userDomain(), file], never).catch(() => {});
    throw error;
  }
}

/** @param file The plist to delete. Defaults to the fixed per-user path. */
export async function uninstall(file = plistPath()): Promise<void> {
  // Only "it was not loaded" is tolerable. Any other failure may mean the
  // service is still running, and removing its plist and reporting success
  // would leave a supervised process nobody can find.
  await runLaunchctl(["bootout", `${userDomain()}/${LABEL}`], bootoutSaysAbsent);
  rmSync(file, { force: true });
}

/**
 * What launchd has to say about Engwire's job.
 *
 * Deleting a plist by hand leaves its job loaded, so `uninstall` must not infer
 * absence from the file alone. This is asked only when no plist was found.
 */
async function jobState(): Promise<JobState> {
  if (process.platform !== "darwin") return "absent";
  const { exitCode, stderr } = await launchctl(["print", `${userDomain()}/${LABEL}`]);
  return printSays(exitCode, stderr);
}

/**
 * The service on this machine: whose plist describes it, and — only when none
 * does — what launchd says about a job anyway.
 *
 * A present plist settles ownership even when Engwire cannot identify it;
 * launchd is asked only when no plist exists.
 */
export async function installedService(
  dataDir: string,
): Promise<{ service: InstalledPlist; job: JobState }> {
  const service = installedPlist(dataDir);
  return { service, job: service.whose === "none" ? await jobState() : "absent" };
}

/** Loaded, not there, or a question launchd would not answer. */
export type JobState = "loaded" | "absent" | "unknown";

/**
 * How `launchctl print` is read, given how it exited.
 *
 * Only the measured code-and-message pair means absent; everything else is
 * unknown. Calling an uncertain job absent could leave a supervised runner
 * behind after uninstall. See `docs/experiments.md`.
 */
export function printSays(exitCode: number, stderr: string): JobState {
  if (exitCode === 0) return "loaded";
  if (exitCode === 113 && /could not find service/i.test(stderr)) return "absent";
  return "unknown";
}

/**
 * Whether `launchctl bootout` failed because the job was not there.
 *
 * This is the one failed bootout uninstall may proceed through, so both halves
 * of launchd's measured answer are required. See `docs/experiments.md`.
 */
export const bootoutSaysAbsent = (exitCode: number, stderr: string): boolean =>
  exitCode === 3 && /no such process/i.test(stderr);

const never = (): boolean => false;

/**
 * Run `launchctl` and hand back what it said.
 *
 * Two callers want different things from a failure: `runLaunchctl` treats
 * anything but success as one, while `jobState` reads the failure itself as the
 * answer. So this reports and does not judge.
 */
async function launchctl(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    // Absolute, not resolved: `launchctl` is part of macOS rather than a
    // dependency the reviewer chooses, so there is no PATH question to get
    // right. `service install` is also a command typed from wherever someone
    // is standing, which can be a contributor's checkout.
    cmd: ["/bin/launchctl", ...args],
    stdin: "ignore",
    // `print` dumps the job description to stdout, which nobody here needs.
    // stderr is read because that is where launchd puts the answer about a
    // label it does not have — and an unread pipe is a child that blocks once
    // it fills.
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
}

/** Run `launchctl`, tolerating only the caller's known failure case. */
async function runLaunchctl(
  args: string[],
  tolerate: (exitCode: number, stderr: string) => boolean,
): Promise<void> {
  const { exitCode, stderr } = await launchctl(args);
  if (exitCode !== 0 && !tolerate(exitCode, stderr)) {
    throw new Error(`launchctl ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}
