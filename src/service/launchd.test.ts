import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config/paths.ts";
import { bootoutSaysAbsent, installedPlist, plist, printSays, serviceEnvironment } from "./launchd.ts";

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
    // Exactly, which is what the name claims and what two `toContain`s cannot
    // show: a `plist` that serialized anything of its own — or that a later
    // change let through from the ambient environment — would satisfy them
    // both. `serviceEnvironment` is what decides the contents, and the test
    // below holds it to dropping credentials; this one holds `plist` to adding
    // nothing on the way out.
    const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1];
    const pairs = [...(dict ?? "").matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)];

    expect(pairs.map((pair) => [pair[1], pair[2]])).toEqual([
      ["PATH", "/usr/bin"],
      ["ENGWIRE_HOME", "/custom"],
    ]);
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

  test("one data directory reached two ways is one installation", () => {
    // An installation is its data directory, not its spelling. `/tmp` is a
    // symlink to `/private/tmp` on macOS, and `service install` records what
    // `ENGWIRE_HOME` said then while `uninstall` reads what it says now — so
    // refusing to claim the job here would leave Engwire's own service running
    // against data it is about to delete.
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(join(real, "data"), { recursive: true });
    symlinkSync(real, link);
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: real });

    expect(installedPlist(paths({ ENGWIRE_HOME: link }).dataDir, file)).toMatchObject({
      whose: "ours",
    });
  });

  test("two spellings agree even after the data directory is gone", () => {
    // The data directory is gone while a symlinked ancestor is not, which is
    // every installation between `service install` and its first run, and any
    // whose data something has since taken. An installation that cannot
    // recognise its own service in that state leaves the job loaded and still
    // reports the uninstall as done.
    const real = join(dir, "cleared");
    const link = join(dir, "cleared-link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    // The parent is there; `data` beneath it is not, exactly as after a wipe.
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: real });

    expect(installedPlist(paths({ ENGWIRE_HOME: link }).dataDir, file)).toMatchObject({
      whose: "ours",
    });
  });

  test("two spellings of one unresolvable path are still one installation", () => {
    // A symlink loop under a directory reached two ways. Nothing about the tail
    // resolves, from either side — so the climb stops at the aliased ancestor
    // and re-appends the rest, and the two come out equal because they *are*
    // one path. Swapping a canonical ancestor for the one written does not move
    // a path, which is why a failed resolution is safe to climb past whatever
    // caused it, and why the answer here is `ours` rather than a shrug.
    const real = join(dir, "real");
    mkdirSync(real, { recursive: true });
    symlinkSync(join(real, "loop"), join(real, "loop"));
    symlinkSync(real, join(dir, "alias"));
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(real, "loop") });

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "alias", "loop") }).dataDir, file)).toMatchObject({
      whose: "ours",
    });
  });

  test("different directories stay foreign, resolved or not", () => {
    // Resolving must not collapse two installations into one. Neither of these
    // exists, so both come back as written — and as written they differ.
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "gone") });

    expect(installedPlist(join(dir, "also-gone", "data"), file)).toMatchObject({
      whose: "theirs",
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

  test("the keys this version writes may be absent, reordered or changed", () => {
    // Flexible about the ones it understands: none of them decides ownership,
    // and holding a plist to an exact rendering would cost an installation its
    // own service the first time a value moved.
    const home = join(dir, "live");
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
    const asking = paths({ ENGWIRE_HOME: home }).dataDir;

    for (const [name, made] of [
      ["dropped.plist", live.replace("<key>RunAtLoad</key><true/>\n", "")],
      ["revalued.plist", live.replace("<key>Umask</key><integer>63</integer>", "<key>Umask</key><integer>18</integer>")],
      [
        "reordered.plist",
        live
          .replace("<key>RunAtLoad</key><true/>\n", "")
          .replace("<key>KeepAlive</key><true/>", "<key>KeepAlive</key><true/>\n  <key>RunAtLoad</key><true/>"),
      ],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, made);

      expect(installedPlist(asking, file)).toMatchObject({ whose: "ours" });
    }
  });

  test("a key written as a kind this version does not write it as", () => {
    // The other half of "closed about meanings": which kind of value a key
    // carries is one of them. Changing 63 to 18 is the same setting configured
    // differently; changing an integer to a string is a spelling nothing here
    // has assigned a meaning to, and launchd may read as another.
    const home = join(dir, "live");
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
    const asking = paths({ ENGWIRE_HOME: home }).dataDir;

    for (const [name, from, to] of [
      ["boolean-as-string.plist", "<key>RunAtLoad</key><true/>", "<key>RunAtLoad</key><string>true</string>"],
      [
        "string-as-boolean.plist",
        `<key>StandardOutPath</key><string>${join(dir, "logs", "runner.log")}</string>`,
        "<key>StandardOutPath</key><true/>",
      ],
      ["integer-as-string.plist", "<key>Umask</key><integer>63</integer>", "<key>Umask</key><string>63</string>"],
    ] as const) {
      const file = join(dir, name);
      const made = live.replace(from, to);
      expect(made).not.toBe(live);
      writeFileSync(file, made);

      expect(installedPlist(asking, file)).toMatchObject({ whose: "theirs", supervises: null });
    }
  });

  test("a root key this version has no meaning for ends the answer", () => {
    // `Program` is the case that decided this: launchd.plist(5) documents keys
    // that choose the executable and the filesystem the job sees, so a document
    // can identify this installation in the head and describe a different job
    // in the tail. Nothing here can weigh a key it has never heard of, and a
    // denylist would only ever be as long as somebody's imagination.
    const home = join(dir, "live");
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
    const asking = paths({ ENGWIRE_HOME: home }).dataDir;

    for (const [name, extra] of [
      ["program.plist", "<key>Program</key><string>/tmp/something-else</string>"],
      ["root-directory.plist", "<key>RootDirectory</key><string>/tmp/elsewhere</string>"],
      ["unknown.plist", "<key>FutureSetting</key><string>whatever</string>"],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, live.replace("<key>RunAtLoad</key>", `${extra}\n  <key>RunAtLoad</key>`));

      expect(installedPlist(asking, file)).toMatchObject({ whose: "theirs", supervises: null });
    }
  });

  test("a file no XML processor would accept is not read for an identity", () => {
    // Three ways a file stops being the document it looks like, all settled
    // before the shape is examined. Each one would otherwise leave a plist
    // claiming this installation while the job behind the shared label is
    // whatever was loaded from something else.
    const home = join(dir, "live");
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
    const asking = paths({ ENGWIRE_HOME: home }).dataDir;

    // XML puts the declaration first, so a comment ahead of it means the
    // `<?xml ...?>` after it is not one — and removing the comment would make
    // a declaration appear that was never there.
    const leading = join(dir, "leading-comment.plist");
    writeFileSync(leading, `<!--x-->${live}`);
    expect(installedPlist(asking, leading)).toMatchObject({ whose: "theirs" });

    // A byte no UTF-8 document may contain. A lenient decode turns it into
    // `U+FFFD`, which is legal XML and sails through everything below.
    const badBytes = join(dir, "bad-utf8.plist");
    const withTail = live.replace(
      "<key>RunAtLoad</key>",
      "<key>StandardOutPath</key><string>ok.</string>\n  <key>RunAtLoad</key>",
    );
    const bytes = Buffer.from(withTail, "utf8");
    bytes[withTail.indexOf("ok.") + 2] = 0xff;
    writeFileSync(badBytes, bytes);
    expect(installedPlist(asking, badBytes)).toMatchObject({ whose: "theirs" });
  });

  test("a carriage return survives the round trip, written as a reference", () => {
    // XML normalises a literal CR to LF before anything reads the document, so
    // writing one would hand launchd a different directory than the preflight
    // approved. Written as a character reference it is content, not a line end.
    const home = join(dir, `cr${String.fromCharCode(13)}b`);
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: home });

    expect(readFileSync(file, "utf8")).toContain("&#13;");
    expect(installedPlist(paths({ ENGWIRE_HOME: home }).dataDir, file)).toMatchObject({
      whose: "ours",
    });
  });

  test("a plist whose line endings were converted is still this one", () => {
    // The structural half of the same rule. XML normalises CRLF to LF before
    // parsing, so a generated file that went through something that rewrote its
    // line endings is the same document to launchd — and has to be to this too,
    // or an ordinary copy would cost an installation its own service.
    const home = join(dir, "live");
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
    const file = join(dir, "crlf.plist");
    writeFileSync(file, live.replaceAll("\n", `${String.fromCharCode(13)}\n`));

    expect(installedPlist(paths({ ENGWIRE_HOME: home }).dataDir, file)).toMatchObject({
      whose: "ours",
    });
  });

  test("a carriage return left literal is the line end XML says it is", () => {
    // The other half: a plist carrying the raw character names one directory to
    // a reader taking it literally and another to launchd, so the installation
    // spelled with the CR must not claim that job.
    const home = join(dir, `cr${String.fromCharCode(13)}b`);
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
    const file = join(dir, "literal-cr.plist");
    writeFileSync(file, live.replaceAll("&#13;", String.fromCharCode(13)));

    expect(installedPlist(paths({ ENGWIRE_HOME: home }).dataDir, file)).toMatchObject({
      whose: "theirs",
    });
  });

  test("a document that does not open the way this one writes them is not ours", () => {
    // Nothing is interpolated into the prolog, so a difference there is not a
    // variation — it is another document. `<plist version=>` is also not one
    // launchd would load, which makes an identity read out of it a claim about
    // a job that was never described by this file.
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") }), "utf8");
    const asking = paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir;

    for (const [name, from, to] of [
      ["broken-open.plist", '<plist version="1.0">', "<plist version=>"],
      ["no-doctype.plist", "<!DOCTYPE plist PUBLIC", "<!DOCTYPE plist SYSTEM"],
      // `--` cannot appear inside an XML comment, so this is not one — and a
      // lenient strip would have let it hide whatever it wrapped.
      ["bad-comment.plist", "<key>RunAtLoad</key>", "<!-- -- --><key>RunAtLoad</key>"],
      // Individually a fine comment, but a comment cannot sit inside a tag —
      // and taking it out would reconstruct the exact prolog from a file no XML
      // reader accepts. Removing comments is a rewrite, and a rewrite must not
      // be able to produce a document that was never there.
      ["comment-in-tag.plist", '<plist version="1.0">', '<pl<!--x-->ist version="1.0">'],
      // Vertical tab: whitespace to a JavaScript regex, and a character XML
      // cannot hold at all.
      ["vertical-tab.plist", "<dict>", `<dict>${String.fromCharCode(11)}`],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, live.replace(from, to));

      expect(installedPlist(asking, file)).toMatchObject({ whose: "theirs", supervises: null });
    }
  });

  test("markup the generator does not write ends the answer", () => {
    // Not just truncation: anything past the environment that is not a pair
    // `plist()` writes. launchd may refuse such a file outright, and then it
    // describes no job at all while still carrying an identity this would read.
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") }), "utf8");
    const asking = paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir;

    for (const [name, extra] of [
      ["garbage.plist", "<garbage>"],
      ["unclosed.plist", "<key>RunAtLoad</key><string>yes"],
      ["stray-text.plist", "nothing in particular"],
      ["nested.plist", "<key>Sockets</key><dict><key>x</key><string>y</string></dict>"],
      // Shape alone would pass these: the string arm accepts any run without a
      // `<`. They are held to the spelling the generator writes, the same way
      // environment values are — a raw ampersand is not XML, and `&bogus;` is
      // something a reader would decode and this one would not.
      ["raw-amp.plist", "<key>StandardOutPath</key><string>a & b</string>"],
      ["bogus-entity.plist", "<key>StandardOutPath</key><string>&bogus;</string>"],
      // A control character inside a value: legal to every pattern here, and
      // not a character XML can hold. Caught before any shape is looked at.
      [
        "control-char.plist",
        `<key>StandardOutPath</key><string>ok${String.fromCharCode(1)}</string>`,
      ],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, live.replace("<key>RunAtLoad</key>", `${extra}\n  <key>RunAtLoad</key>`));

      expect(installedPlist(asking, file)).toMatchObject({ whose: "theirs", supervises: null });
    }
  });

  test("a document that stops after the environment is not a document", () => {
    // The recognizer anchors the head, so a file cut off right after the
    // environment dictionary matches everything it looks at. It is still not
    // what `plist()` writes — a truncated write, a partial copy — and an
    // identity read out of a fragment is enough to authorize booting out
    // whatever job is behind the label.
    const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: join(dir, "live") }), "utf8");
    const end = live.indexOf("</dict>", live.indexOf("EnvironmentVariables")) + "</dict>".length;
    const file = join(dir, "truncated.plist");
    writeFileSync(file, live.slice(0, end));

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject({
      whose: "theirs",
      supervises: null,
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

  test("a value spelled with anything more to decode is not this document", () => {
    // The key rule from the value side, and this is the side ownership turns
    // on. An XML reader resolves `&#47;` to a slash and `&apos;` to an
    // apostrophe; this one knows only the five entities `plist()` writes. A
    // plist spelled that way therefore names one directory to launchd and
    // another here — and the installation living at the literal spelling would
    // read the job as its own and boot out a runner it does not supervise.
    for (const [name, home] of [
      ["slash.plist", join(dir, "a&#47;b")],
      ["apostrophe.plist", join(dir, "a&apos;b")],
    ] as const) {
      const live = readFileSync(installed({ PATH: "/usr/bin", ENGWIRE_HOME: home }), "utf8");
      const file = join(dir, name);
      // Back to the spelling launchd would decode: writing this name escaped
      // the one ampersand that makes it an entity.
      writeFileSync(file, live.replace(home.replace("&", "&amp;"), home));

      expect(installedPlist(paths({ ENGWIRE_HOME: home }).dataDir, file)).toMatchObject({
        whose: "theirs",
        supervises: null,
      });
    }
  });

  test("a relative base locates no installation", () => {
    // The plist preserves no working directory, so `engwire-data` has no settled
    // meaning once the shell that wrote it is gone. Unknown, not ours — the
    // same answer as a plist that names nothing at all.
    const file = installed({ PATH: "/usr/bin", ENGWIRE_HOME: "engwire-data" });

    expect(installedPlist(paths({ ENGWIRE_HOME: join(dir, "live") }).dataDir, file)).toMatchObject({
      whose: "theirs",
      supervises: null,
    });
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
    // which need not be the PATH recorded for the service.
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

describe("printSays", () => {
  test("nothing short of the measured answer counts as absent", () => {
    // The exit codes are measured in docs/experiments.md; this is Engwire's
    // reading of them, and the reading is what `uninstall` bets "Removed." on.
    expect(printSays(0, "")).toBe("loaded");
    // Absence is concluded from the measured pair and nothing less.
    const missing = 'Could not find service "com.engwire.local" in domain for user gui: 501';
    expect(printSays(113, missing)).toBe("absent");
    expect(printSays(113, "something else entirely")).toBe("unknown");
    expect(printSays(1, missing)).toBe("unknown");
    // `bootout`'s code for the same absence, from the command that did not
    // produce it. Sharing one predicate between the two would read this as a
    // job that is gone.
    expect(printSays(3, "Boot-out failed: 3: No such process")).toBe("unknown");
    // A question that could not be asked is not an answer — and is no longer
    // reported as though it were one.
    expect(printSays(1, "Bad request.")).toBe("unknown");
  });
});

describe("bootoutSaysAbsent", () => {
  const ABSENT = "Boot-out failed: 3: No such process";

  test("nothing short of the measured answer excuses a failed bootout", () => {
    // The one failure `uninstall` walks through, and walking through it deletes
    // the plist of whatever is on the other end. Half an answer is not one:
    // both mistakes here leave a job loaded with nothing on disk naming it,
    // which is the state the rest of this file exists to notice.
    expect(bootoutSaysAbsent(3, ABSENT)).toBe(true);
    expect(bootoutSaysAbsent(3, "Boot-out failed: 5: Input/output error")).toBe(false);
    // `print`'s code for the same absence, from the command that did not
    // produce it — the reason the two predicates are not one.
    expect(bootoutSaysAbsent(113, ABSENT)).toBe(false);
    expect(bootoutSaysAbsent(1, "Bad request.")).toBe(false);
  });
});
