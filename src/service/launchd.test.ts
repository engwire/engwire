import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.ts";
import { installedPlist, plist, serviceEnvironment } from "./launchd.ts";

describe("plist", () => {
  test("escapes paths, because a plist launchd cannot parse never starts", () => {
    const xml = plist({
      executable: "/Users/a&b/.local/bin/engwire",
      logsDir: "/Users/a&b/logs",
      environment: { PATH: "/usr/bin:/Users/a&b/bin" },
      runTimeoutMs: 20 * 60_000,
    });

    expect(xml).toContain("<string>/Users/a&amp;b/.local/bin/engwire</string>");
    expect(xml).toContain("<string>/usr/bin:/Users/a&amp;b/bin</string>");
    expect(xml).toContain("<string>/Users/a&amp;b/logs/runner.log</string>");
    expect(xml).not.toMatch(/a&b/);
  });

  test("launchd is told to wait longer than a review takes", () => {
    // The default is system-defined, so leaving it out means launchd may SIGKILL
    // a review partway through posting it — the one thing the run states exist
    // to prevent.
    const xml = plist({
      executable: "/bin/engwire",
      logsDir: "/logs",
      environment: { PATH: "/usr/bin" },
      runTimeoutMs: 20 * 60_000,
    });
    expect(xml).toContain("<key>ExitTimeOut</key><integer>1230</integer>");
    // 63 decimal is 0077. Measured against launchd rather than pinned to the
    // generator's own output: both this and the octal-string form produce
    // 0600 files, and the integer is the spelling every version documents.
    expect(xml).toContain("<key>Umask</key><integer>63</integer>");
  });

  test("carries exactly the environment the preflight was given", () => {
    const environment = serviceEnvironment({ PATH: "/usr/bin", ENGWIRE_HOME: "/custom" });
    const xml = plist({
      executable: "/bin/engwire",
      logsDir: "/logs",
      environment,
      runTimeoutMs: 60_000,
    });
    expect(xml).toContain("<key>ENGWIRE_HOME</key><string>/custom</string>");
    expect(xml).toContain("<key>PATH</key><string>/usr/bin</string>");
  });
});

describe("serviceEnvironment", () => {
  test("carries where to look, drops what to log in with", () => {
    // Both halves matter. Without ENGWIRE_HOME the service reads a different
    // config than the one `service install` just approved; with GH_TOKEN the
    // preflight approves a credential the service will never be given.
    const env = serviceEnvironment({
      PATH: "/usr/bin",
      ENGWIRE_HOME: "/custom",
      XDG_CONFIG_HOME: "/custom/config",
      GH_TOKEN: "secret",
      GH_CONFIG_DIR: "/tmp/gh",
      CLAUDE_CONFIG_DIR: "/tmp/claude",
      ANTHROPIC_API_KEY: "secret",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      ENGWIRE_HOME: "/custom",
      XDG_CONFIG_HOME: "/custom/config",
      // Where `gh` keeps its logins and where Claude keeps its skills — not
      // logins. Dropped, the service reads the default roots: a different
      // GitHub account, and a different review skill from the one the
      // foreground runner just proved.
      GH_CONFIG_DIR: "/tmp/gh",
      CLAUDE_CONFIG_DIR: "/tmp/claude",
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("installedPlist", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engwire-plist-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A plist as `install` would have written it, for a named installation. */
  function installed(environment: Record<string, string>): string {
    const file = join(dir, "com.engwire.local.plist");
    writeFileSync(
      file,
      plist({
        executable: "/bin/engwire",
        logsDir: join(dir, "logs"),
        environment,
        runTimeoutMs: 20 * 60_000,
      }),
    );
    return file;
  }

  // Every character `xml()` escapes, and text that already looks like an
  // entity: unescaping the ampersand first would read this one back as a `<`.
  const AWKWARD = join("/Users", `a&b <c> "d" 'e' &lt;f&gt;`);

  test("recognises the installation it was installed for", () => {
    // The environment is the only record of which installation the job serves,
    // and it has to survive the XML escaping it was written with.
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: AWKWARD });

    expect(installedPlist(paths({ ENGWIRE_HOME: AWKWARD }).dataDir, file)).toMatchObject({
      whose: "ours",
      executable: "/bin/engwire",
    });
  });

  test("another installation's job is named, not claimed", () => {
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "theirs") });

    expect(installedPlist(join(dir, "ours", "data"), file)).toMatchObject({
      whose: "theirs",
      supervises: paths({ ENGWIRE_HOME: join(dir, "theirs") }).dataDir,
    });
  });

  test("a job that locates no installation is not adopted by the one asking", () => {
    // `paths()` falls back to this process's own home for anything an
    // environment omits, so a dict naming none of the locating variables would
    // resolve to whoever asked and be answered `ours`.
    const file = installed({ PATH: "/usr/bin" });

    expect(installedPlist(paths().dataDir, file)).toMatchObject({ whose: "theirs", supervises: null });
  });

  test("a commented-out key is not the answer launchd would give", () => {
    // launchd parses XML and skips the comment; a regex over the raw text would
    // take the first match and name an installation with total confidence.
    const live = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") });
    const file = join(dir, "commented.plist");
    writeFileSync(
      file,
      readFileSync(live, "utf8").replace(
        "<dict>",
        `<dict>\n<!--\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ENGWIRE_HOME</key>\n    <string>${join(dir, "stale")}</string>\n  </dict>\n-->`,
      ),
    );

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject({
      whose: "ours",
    });
  });

  test("a plist under another label is not ours, whatever its environment says", () => {
    // `uninstall` boots out Engwire's own label, so claiming a job by its
    // environment alone would offer to stop something this never installed.
    const live = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") });
    const file = join(dir, "relabelled.plist");
    writeFileSync(
      file,
      readFileSync(live, "utf8").replace("com.engwire.local", "com.example.something-else"),
    );

    // And it names no installation: saying a foreign job supervises the one
    // asking is worse than saying nothing about it.
    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject(
      { whose: "theirs", supervises: null },
    );
  });

  test("a dictionary inside the environment cannot pass its keys up", () => {
    // The environment capture stops at the first `</dict>`, so a nested one
    // would otherwise hand `ENGWIRE_HOME` up as though the job had declared it.
    const live = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") });
    const file = join(dir, "nested-environment.plist");
    writeFileSync(
      file,
      readFileSync(live, "utf8").replace(
        `<key>ENGWIRE_HOME</key><string>${join(dir, "live")}</string>`,
        `<key>Metadata</key>\n    <dict>\n      <key>ENGWIRE_HOME</key><string>${join(dir, "live")}</string>\n    </dict>`,
      ),
    );

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject(
      { whose: "theirs", supervises: null },
    );
  });

  test("a key that comes round after the head, however spelled, ends the answer", () => {
    // The recognizer matches the head; the rest of the root dictionary could
    // repeat one of the three keys ownership turns on. Which one launchd would
    // honour is not something measured here, so neither is claimed — and a key
    // this cannot read plainly ends the answer too, because a reader that
    // decodes XML resolves `La&#98;el`, `<![CDATA[Label]]>` and
    // `<key x="">Label</key>` all to the same `Label`.
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") }), "utf8");
    const asking = paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir;

    for (const [name, extra] of [
      ["second-label.plist", "<key>Label</key><string>com.example.foreign</string>"],
      [
        "second-environment.plist",
        `<key>EnvironmentVariables</key>\n  <dict>\n    <key>ENGWIRE_HOME</key><string>${join(dir, "elsewhere")}</string>\n  </dict>`,
      ],
      [
        "second-program.plist",
        `<key>ProgramArguments</key>\n  <array>\n    <string>/opt/other/engwire</string>\n    <string>run</string>\n  </array>`,
      ],
      ["entity-label.plist", "<key>La&#98;el</key><string>com.example.foreign</string>"],
      ["cdata-label.plist", "<key><![CDATA[Label]]></key><string>com.example.foreign</string>"],
      ["attributed-label.plist", `<key xml:space="preserve">Label</key><string>com.example.foreign</string>`],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, live.replace("<key>RunAtLoad</key>", `${extra}\n  <key>RunAtLoad</key>`));

      expect(installedPlist(asking, file)).toMatchObject({ whose: "theirs", supervises: null });
    }
  });

  test("an environment holding anything but pairs is not this document", () => {
    // Three ways the body stops being the flat dictionary `plist()` writes: a
    // key that repeats, which `Object.entries` cannot produce; markup trailing
    // the last pair, which the pair scan would otherwise walk past; and a key
    // spelled as an entity, which repeats one of the others to a reader that
    // decodes it.
    const home = `<key>ENGWIRE_HOME</key><string>${join(dir, "live")}</string>`;
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") }), "utf8");
    const asking = paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir;

    for (const [name, body] of [
      ["repeated.plist", `${home}\n    ${home}`],
      ["trailing.plist", `${home}\n    <array><string>run</string></array>`],
      // The same key to launchd, a different string here — so the repeat above
      // is only caught while both are spelled the way the generator spells them.
      ["entity.plist", `${home}\n    <key>ENGWIRE&#95;HOME</key><string>${join(dir, "theirs")}</string>`],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, live.replace(home, body));

      expect(installedPlist(asking, file)).toMatchObject({ whose: "theirs", supervises: null });
    }
  });

  test("a variable that does not decide where data lives locates nothing", () => {
    // `XDG_CONFIG_HOME` moves the config and leaves `dataDir` on the fallback,
    // so a plist naming only that one still says nothing about whose it is.
    const file = installed({ PATH: "/usr/bin", XDG_CONFIG_HOME: join(dir, "config") });

    expect(installedPlist(paths().dataDir, file)).toMatchObject({
      whose: "theirs",
      supervises: null,
    });
  });

  test("a variable set to nothing locates nothing either", () => {
    // `serviceEnvironment` carries an empty value as an empty value, and
    // `paths()` falls back on one — so "present" is not the question.
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: "", HOME: "" });

    expect(installedPlist(paths().dataDir, file)).toMatchObject({
      whose: "theirs",
      supervises: null,
    });
  });

  test("a nested dictionary cannot speak for the root job", () => {
    // Searching per key finds each one anywhere the document holds it, so a
    // plist whose *root* label is foreign could be claimed on the strength of
    // values buried in some inner dict.
    const file = join(dir, "nested.plist");
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Metadata</key>
  <dict>
    <key>Label</key><string>com.engwire.local</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/engwire</string>
      <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ENGWIRE_HOME</key><string>${join(dir, "live")}</string>
    </dict>
  </dict>
  <key>Label</key><string>com.example.foreign</string>
</dict>
</plist>
`,
    );

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject(
      { whose: "theirs", supervises: null },
    );
  });

  test("a job invoked as anything but the runner is not the runner", () => {
    // `install` writes exactly `<executable> run`. A plist that starts the
    // binary some other way is not the background job this reports on.
    const live = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") });
    const file = join(dir, "other-command.plist");
    writeFileSync(file, readFileSync(live, "utf8").replace("<string>run</string>", "<string>status</string>"));

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject(
      { whose: "theirs", supervises: null },
    );
  });

  test("a program named without a path is not a program this can check", () => {
    // `Bun.which` on a bare name searches the PATH of whoever is diagnosing,
    // which is not the one launchd hands the job.
    const live = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") });
    const file = join(dir, "relative.plist");
    writeFileSync(file, readFileSync(live, "utf8").replace("<string>/bin/engwire</string>", "<string>engwire</string>"));

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject(
      { whose: "theirs", supervises: null },
    );
  });

  test("a plist that cannot be read is somebody else's, not a crash", () => {
    // `doctor` asks this, and so does `service install` — the command someone
    // runs when the installed service is the thing that is wrong.
    const file = join(dir, "com.engwire.local.plist");
    mkdirSync(file);

    expect(installedPlist(paths().dataDir, file)).toMatchObject({ whose: "theirs", supervises: null });
  });

  test("nothing to say about a plist that is not there", () => {
    expect(installedPlist(paths().dataDir, join(dir, "absent.plist"))).toEqual({ whose: "none" });
  });
});
