import { describe, expect, test } from "bun:test";
import { plist, serviceEnvironment } from "./launchd.ts";

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
