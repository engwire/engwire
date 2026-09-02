/**
 * @file What `install.sh` refuses, which the release pipeline cannot show.
 *
 * `verify` installs every published release on its own platform, but it only
 * ever asks a correct release for its own asset — the installer's refusals are
 * reachable only by handing it something wrong, so they would stay green with
 * the checks deleted. `curl` is stubbed on `PATH`, which is a seam the script
 * already has; nothing is added to it for the sake of being tested.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "../../install/install.sh");

/** Records the URL and serves what the test says, not what GitHub would. */
const CURL = `#!/bin/sh
out=""
for arg in "$@"; do
  case "$arg" in https://*) echo "$arg" >> "$ENGWIRE_TEST_URLS" ;; esac
done
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
cp "$ENGWIRE_TEST_ASSET" "$out"
`;

/** What `install.sh` derives from `uname` on the machine running the test. */
const ASSET = `engwire-${process.platform}-${process.arch}.gz`;
const RELEASES = "https://github.com/engwire/engwire/releases";

const PREVIOUS = "#!/bin/sh\necho previous\n";

describe("install.sh", () => {
  /** A prefix holding a working install, and a release serving `asset`. */
  async function machine(asset: string) {
    const dir = mkdtempSync(join(tmpdir(), "engwire-install-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "prefix"));

    await Bun.write(join(dir, "bin", "curl"), CURL);
    chmodSync(join(dir, "bin", "curl"), 0o755);
    await Bun.write(join(dir, "prefix", "engwire"), PREVIOUS);
    chmodSync(join(dir, "prefix", "engwire"), 0o755);

    // The installer decompresses and chmods what it downloads, so the asset is
    // just a gzipped file that happens to be a shell script.
    await Bun.write(join(dir, "engwire"), asset);
    await Bun.$`gzip -9 ${join(dir, "engwire")}`.quiet();

    return dir;
  }

  async function install(version: string, dir: string): Promise<{ said: string; code: number }> {
    const proc = Bun.spawn({
      cmd: ["sh", installer],
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        HOME: dir,
        ENGWIRE_PREFIX: join(dir, "prefix"),
        ENGWIRE_VERSION: version,
        ENGWIRE_TEST_ASSET: join(dir, "engwire.gz"),
        ENGWIRE_TEST_URLS: join(dir, "urls"),
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
      const { code } = await install("latest", dir);

      expect(code).toBe(0);
      expect(fetched(dir)).toBe(`${RELEASES}/latest/download/${ASSET}`);
      expect(installed(dir)).toBe(reports("0.2.0"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a download that is not the version it asked for", async () => {
    // A pin names a URL, and a URL is not a promise about what is behind it —
    // so the binary is asked which version it is before it is kept.
    const dir = await machine(reports("0.1.1"));
    try {
      const { said, code } = await install("0.1.0", dir);

      expect(code).toBe(1);
      expect(said).toContain("Asked for Engwire 0.1.0, but the download reports 0.1.1.");
      expect(installed(dir)).toBe(PREVIOUS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps the working binary when the download will not start", async () => {
    const dir = await machine("#!/bin/sh\nexit 1\n");
    try {
      const { code } = await install("latest", dir);

      expect(code).not.toBe(0);
      expect(installed(dir)).toBe(PREVIOUS);
      expect(existsSync(join(dir, "prefix", "engwire"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
