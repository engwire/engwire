/**
 * @file What `verify` structurally cannot show about `install.sh`.
 *
 * `verify` exercises one valid artifact on each platform in an empty prefix.
 * These tests supply invalid downloads and existing installs, and compare the
 * build and installer mappings before a tag is spent. They stub only commands
 * the installer already resolves through `PATH`.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BINARIES } from "../../scripts/build.ts";

const installer = resolve(import.meta.dir, "../../install/install.sh");

/** Records how it was called and serves what the test says, not what GitHub would. */
const CURL = `#!/bin/sh
printf '%s\\n' "$@" > "$ENGWIRE_TEST_ARGS"
out=""
for arg in "$@"; do
  case "$arg" in https://*) echo "$arg" >> "$ENGWIRE_TEST_URLS" ;; esac
done
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
printf %s "$out" > "$ENGWIRE_TEST_STAGED"
cp "$ENGWIRE_TEST_ASSET" "$out"
`;

/** Makes every supported platform reachable from either test host. */
const UNAME = `#!/bin/sh
case "$1" in
  -s) echo "$ENGWIRE_TEST_OS" ;;
  -m) echo "$ENGWIRE_TEST_ARCH" ;;
esac
`;

/**
 * Records whether the old binary still exists when `mv` is called, distinguishing
 * one rename from an unlink followed by a rename. Check the invariant's pathname
 * rather than an operand position so adding a flag cannot change the meaning.
 */
const MV = `#!/bin/sh
[ -e "$ENGWIRE_PREFIX/engwire" ] && printf present > "$ENGWIRE_TEST_MV" || printf absent > "$ENGWIRE_TEST_MV"
# Run the real utility without encoding its host-specific path.
command -p mv "$@"
`;

/**
 * Every machine a release supports: what `uname` answers there, the target that
 * compiles for it, and the asset both the build and the installer must name.
 */
const PLATFORMS = [
  { os: "Darwin", arches: ["arm64", "aarch64"], target: "bun-darwin-arm64", asset: "engwire-darwin-arm64.gz" },
  { os: "Darwin", arches: ["x86_64", "amd64"], target: "bun-darwin-x64", asset: "engwire-darwin-x64.gz" },
  { os: "Linux", arches: ["arm64", "aarch64"], target: "bun-linux-arm64", asset: "engwire-linux-arm64.gz" },
  { os: "Linux", arches: ["x86_64", "amd64"], target: "bun-linux-x64", asset: "engwire-linux-x64.gz" },
];

/** What `install.sh` derives from `uname` on the machine running the test. */
const ASSET = `engwire-${process.platform}-${process.arch}.gz`;
const HOST_OS = process.platform === "darwin" ? "Darwin" : "Linux";
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x86_64";
const RELEASES = "https://github.com/engwire/engwire/releases";

describe("install.sh", () => {
  /** An empty prefix and served asset; `installed` stages a working 0.1.0. */
  async function machine(asset: string, options: { installed?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "engwire-install-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "prefix"));

    await Bun.write(join(dir, "bin", "curl"), CURL);
    chmodSync(join(dir, "bin", "curl"), 0o755);
    await Bun.write(join(dir, "bin", "uname"), UNAME);
    chmodSync(join(dir, "bin", "uname"), 0o755);
    await Bun.write(join(dir, "bin", "mv"), MV);
    chmodSync(join(dir, "bin", "mv"), 0o755);
    if (options.installed) {
      await Bun.write(join(dir, "prefix", "engwire"), reports("0.1.0"));
      chmodSync(join(dir, "prefix", "engwire"), 0o755);
    }

    // The installer decompresses and chmods what it downloads, so the asset is
    // just a gzipped file that happens to be a shell script.
    await Bun.write(join(dir, "engwire"), asset);
    await Bun.$`gzip -9 ${join(dir, "engwire")}`.quiet();

    return dir;
  }

  async function install(
    version: string,
    dir: string,
    /**
     * What this machine looks like. `os` and `arch` default to the one the test
     * is running on; the prefix is off `PATH` unless a test puts it there,
     * which is the shape a first install actually finds.
     */
    host: { os?: string; arch?: string; prefixOnPath?: boolean } = {},
  ): Promise<{ said: string; code: number }> {
    const pathEntries = [join(dir, "bin"), ...(host.prefixOnPath ? [join(dir, "prefix")] : [])];
    const proc = Bun.spawn({
      cmd: ["sh", installer],
      env: {
        PATH: `${pathEntries.join(":")}:${process.env.PATH ?? ""}`,
        HOME: dir,
        ENGWIRE_PREFIX: join(dir, "prefix"),
        ENGWIRE_VERSION: version,
        ENGWIRE_TEST_ASSET: join(dir, "engwire.gz"),
        ENGWIRE_TEST_URLS: join(dir, "urls"),
        ENGWIRE_TEST_ARGS: join(dir, "curl-args"),
        ENGWIRE_TEST_STAGED: join(dir, "staged"),
        ENGWIRE_TEST_MV: join(dir, "renamed-onto"),
        ENGWIRE_TEST_OS: host.os ?? HOST_OS,
        ENGWIRE_TEST_ARCH: host.arch ?? HOST_ARCH,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { said: out + err, code };
  }

  const reports = (version: string) => `#!/bin/sh\necho ${version}\n`;
  const installed = (dir: string) => readFileSync(join(dir, "prefix", "engwire"), "utf8");
  const fetched = (dir: string) => readFileSync(join(dir, "urls"), "utf8").trim();
  const curlArgs = (dir: string) => readFileSync(join(dir, "curl-args"), "utf8").trim().split("\n");

  test("asks for an artifact the build actually produces, on every platform", async () => {
    // Ask the build what it emits instead of deriving the names a third way.
    // The release workflow appends `.gz` to each file in `dist/`.
    const emits = BINARIES.map(({ target, name }) => `${target} → ${name}.gz`).sort();
    const supported = PLATFORMS.map((p) => `${p.target} → ${p.asset}`).sort();

    // Compare target/name pairs in both directions; a set of names would miss
    // swapped binaries or an artifact the installer cannot request.
    expect(emits, "the build and install.sh disagree about what a release carries").toEqual(
      supported,
    );

    for (const { os, arches, asset } of PLATFORMS) {
      for (const arch of arches) {
        // Exercise every accepted `uname -m` spelling, not just canonical names.
        const dir = await machine(reports("0.1.0"));
        try {
          await install("0.1.0", dir, { os, arch });

          expect(fetched(dir).split("/").pop(), `${os}/${arch} asked for the wrong artifact`).toBe(
            asset,
          );
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
    // Eight end-to-end installs approach Bun's five-second default under load.
  }, 20_000);

  test("follows the redirect an asset URL is answered with", async () => {
    // Measured: an asset URL answers 302 to a separate release-assets host
    // (experiments.md). `-f` does not fail on a 3xx, so a `curl` without `-L`
    // exits 0 having written nothing — the installer would then fall over in
    // `gzip`, complaining about the wrong thing, and every test here would
    // still pass because the stub serves whatever it is asked for. Hence one
    // assertion about how `curl` was called rather than what it returned.
    const dir = await machine(reports("0.2.0"));
    try {
      await install("0.2.0", dir);

      const args = curlArgs(dir);
      const follows = args.some(
        (arg) => arg === "--location" || (/^-[a-zA-Z]+$/.test(arg) && arg.includes("L")),
      );
      expect(follows, `curl must follow redirects: ${args.join(" ")}`).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("says nothing about PATH when the prefix is already on it", async () => {
    // The other outcome of the same two-branch decision. Advice that is always
    // printed is advice nobody reads, and here it would be wrong: telling
    // somebody whose shell already resolves `engwire` to go and configure it is
    // how a correct install ends up looking like a broken one.
    const dir = await machine(reports("0.2.0"));
    try {
      const { said, code } = await install("0.2.0", dir, { prefixOnPath: true });

      expect(code).toBe(0);
      // The same tail as a first install, minus the one line: silence is the
      // contract, so anything said in its place — even a reassuring "PATH is
      // already configured" — is the regression this is here to catch.
      expect(said).toEndWith(
        `Installed engwire 0.2.0 at ${join(dir, "prefix", "engwire")}\n` +
          "\nNext: engwire setup\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a machine no release is built for", async () => {
    // The other half of the table: every accepted `uname` spelling maps to an
    // artifact, and everything else has to stop here. `verify` cannot reach
    // this either — it only ever runs on the four machines a release targets —
    // and a default case that guessed would download an arbitrary artifact and
    // hand somebody a binary their kernel refuses.
    const refused: Array<[string, string, string]> = [
      ["FreeBSD", "x86_64", "Unsupported OS: FreeBSD. Engwire supports macOS and Linux."],
      ["Linux", "riscv64", "Unsupported architecture: riscv64"],
    ];
    for (const [os, arch, complaint] of refused) {
      const dir = await machine(reports("0.2.0"));
      try {
        const { said, code } = await install("0.2.0", dir, { os, arch });

        expect(code, `${os}/${arch} was not refused`).toBe(1);
        expect(said).toContain(complaint);
        expect(existsSync(join(dir, "urls")), "fetched a release for a machine it cannot run on").toBe(
          false,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("installs the version it was asked for", async () => {
    const dir = await machine(reports("0.1.1"));
    try {
      const { code } = await install("0.1.1", dir);

      expect(code).toBe(0);
      expect(fetched(dir)).toBe(`${RELEASES}/download/v0.1.1/${ASSET}`);
      expect(installed(dir)).toBe(reports("0.1.1"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("takes that version with or without the leading v", async () => {
    const dir = await machine(reports("0.1.1"));
    try {
      const { code } = await install("v0.1.1", dir);

      expect(code).toBe(0);
      expect(fetched(dir)).toBe(`${RELEASES}/download/v0.1.1/${ASSET}`);
      expect(installed(dir)).toBe(reports("0.1.1"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("asks latest for no version in particular", async () => {
    // The URL every README and every upgrade uses, and the one the release
    // workflow never exercises: verification installs by tag. Nothing to compare
    // the version against either, and `set -u` would end the script if the
    // comparison were reached with no version to hold the download to.
    const dir = await machine(reports("0.2.0"));
    try {
      const { said, code } = await install("latest", dir);

      expect(code).toBe(0);
      expect(fetched(dir)).toBe(`${RELEASES}/latest/download/${ASSET}`);
      expect(installed(dir)).toBe(reports("0.2.0"));
      // What arrived, not what was asked for. This is the only path where the
      // two differ, and it is the one nearly every install takes: echoing the
      // selector back would greet most users with "Installed engwire latest".
      expect(said).toContain("Installed engwire 0.2.0 at ");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a download that is not the version it asked for", async () => {
    // A pin names a URL, and a URL is not a promise about what is behind it —
    // so the binary is asked which version it is before it is kept. Installed
    // first, because what the refusal protects is the working binary already
    // there.
    const dir = await machine(reports("0.1.1"), { installed: true });
    try {
      const { said, code } = await install("0.1.0", dir);

      expect(code).toBe(1);
      expect(said).toContain("Asked for Engwire 0.1.0, but the download reports 0.1.1.");
      expect(installed(dir)).toBe(reports("0.1.0"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a first install ends by saying what to do next", async () => {
    const dir = await machine(reports("0.1.1"));
    try {
      const { said, code } = await install("0.1.1", dir);

      expect(code).toBe(0);
      // The whole tail, in order, rather than three things said somewhere. The
      // `PATH` line is the half that has no other witness: a prefix nothing
      // resolves through would otherwise end with `Next: engwire setup` and a
      // shell that cannot find `engwire` to run it with.
      expect(said).toEndWith(
        `Installed engwire 0.1.1 at ${join(dir, "prefix", "engwire")}\n` +
          `Add ${join(dir, "prefix")} to your PATH.\n` +
          "\nNext: engwire setup\n",
      );
      expect(said).not.toContain("Running in the background?");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an upgrade on macOS is offered the command Engwire ships", async () => {
    const dir = await machine(reports("0.1.1"), { installed: true });
    try {
      const { said, code } = await install("0.1.1", dir, { os: "Darwin", arch: "arm64" });

      expect(code).toBe(0);
      expect(said).toContain("Running in the background?");
      expect(said).toContain("engwire service install");
      expect(said).not.toContain("systemctl");
      expect(said).not.toContain("Next: engwire setup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an upgrade on Linux is not sent to a launchd-only command", async () => {
    // Force Linux so this guard also runs on macOS.
    const dir = await machine(reports("0.1.1"), { installed: true });
    try {
      const { said, code } = await install("0.1.1", dir, { os: "Linux", arch: "x86_64" });

      expect(code).toBe(0);
      expect(said).toContain("Running in the background?");
      expect(said).toContain("Restart your supervisor to pick this up, e.g.");
      expect(said).toContain("systemctl --user restart engwire");
      expect(said).not.toContain("engwire service install");
      expect(said).not.toContain("Next: engwire setup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an upgrade replaces the file rather than writing through it", async () => {
    // A runner started from this path has the old binary mapped, and an
    // upgrade may land in the middle of a review. Writing the destination in
    // place keeps the inode that process is executing, while a rename replaces
    // the pathname and leaves the old executable whole, so the review finishes
    // on the binary it started with. The inode is what tells the two apart.
    const dir = await machine(reports("0.2.0"), { installed: true });
    try {
      const before = statSync(join(dir, "prefix", "engwire")).ino;

      const { code } = await install("0.2.0", dir);

      expect(code).toBe(0);
      expect(statSync(join(dir, "prefix", "engwire")).ino).not.toBe(before);
      // And the old binary was still there when the rename was asked for. A new
      // inode is also what `rm` then `mv` leaves behind, and that opens exactly
      // the window this design exists to close: between the two, the pathname a
      // supervisor restarts from names nothing at all.
      expect(readFileSync(join(dir, "renamed-onto"), "utf8")).toBe("present");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stages the download inside the prefix, not somewhere else on disk", async () => {
    // The rename above is only atomic within one filesystem. Staged in the
    // system temp directory, `mv` onto a `$HOME` that is a separate mount
    // degrades to copy-and-delete, and an upgrade interrupted midway leaves a
    // truncated binary where a working one used to be — which is the failure
    // staging here exists to make impossible rather than unlikely.
    const dir = await machine(reports("0.2.0"));
    try {
      await install("0.2.0", dir);

      expect(readFileSync(join(dir, "staged"), "utf8")).toStartWith(join(dir, "prefix") + "/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a directory where the binary belongs", async () => {
    // `mv` onto a directory means "into", not "over": it moves the file inside
    // and exits 0, so the installer would announce a version it had installed
    // to `$PREFIX/engwire/engwire`, which is on nobody's `PATH`. Refused before
    // the download, since nothing about the answer depends on it.
    const dir = await machine(reports("0.2.0"));
    mkdirSync(join(dir, "prefix", "engwire"));
    try {
      const { said, code } = await install("0.2.0", dir);

      expect(code).toBe(1);
      expect(said).toContain(`${join(dir, "prefix", "engwire")} is a directory.`);
      expect(said).not.toContain("Installed engwire");
      expect(existsSync(join(dir, "prefix", "engwire", "engwire"))).toBe(false);
      // Before the download, not merely before the rename: nothing about the
      // answer depends on what is at the other end of the URL.
      const asked = existsSync(join(dir, "urls"));
      expect(asked, "fetched a release for an install it had already refused").toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps the working binary when the replacement will not run", async () => {
    const dir = await machine("#!/bin/sh\nexit 1\n", { installed: true });
    try {
      const { code } = await install("latest", dir);

      expect(code).not.toBe(0);
      expect(installed(dir)).toBe(reports("0.1.0"));
      expect(existsSync(join(dir, "prefix", "engwire"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
