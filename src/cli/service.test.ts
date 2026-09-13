import { describe, expect, test } from "bun:test";
import { LINUX_DOCS, replacementNotice, servicePathProblems, unsupportedNote } from "./service.ts";

describe("replacementNotice", () => {
  test("says nothing when the plist here already names this installation", () => {
    expect(replacementNotice({ whose: "none" })).toEqual([]);
    expect(
      replacementNotice({
        whose: "ours",
        plistPath: "/p",
        executable: "/bin/engwire",
        remove: async () => true,
      }),
    ).toEqual([]);
  });

  test("names the installation the plist here was configured for", () => {
    const said = replacementNotice({
      whose: "theirs",
      plistPath: "/p",
      supervises: "/other/data",
    });

    expect(said[0]).toContain("/other/data");
    expect(said.join(" ")).toContain("this installation now owns it");
  });

  test("an unidentifiable plist is still reported", () => {
    const said = replacementNotice({ whose: "theirs", plistPath: "/p", supervises: null });

    expect(said[0]).toContain("not one this installation could identify");
  });
});

describe("unsupportedNote", () => {
  test("sends the reader somewhere rather than only saying no", () => {
    // launchd is the only supervisor Engwire implements, so this is the whole
    // of what a Linux user gets from `engwire service`. Naming the action and
    // then stopping would leave them to guess what "your platform's
    // supervisor" means; the page is the part they can act on.
    const said = unsupportedNote("install");

    expect(said[0]).toContain("engwire service install");
    expect(said[0]).toContain("only on macOS");
    expect(said).toContain(LINUX_DOCS);
  });
});

describe("servicePathProblems", () => {
  const HOME = "/Users/someone";

  test("a value the service would resolve from its own directory is refused", () => {
    // The plist carries these verbatim and preserves no working directory, so a
    // relative one has no settled meaning once the installing shell is gone.
    // Every root that decides identity or configuration, not just Engwire's
    // own two.
    for (const [name, value] of [
      ["HOME", "home"],
      ["ENGWIRE_HOME", "."],
      ["XDG_CONFIG_HOME", "cfg"],
      ["XDG_DATA_HOME", "../data"],
      ["GH_CONFIG_DIR", ".gh"],
      ["CLAUDE_CONFIG_DIR", ".claude"],
    ] as const) {
      expect(servicePathProblems({ PATH: "/usr/bin", HOME, [name]: value })).toContain(
        `${name}=${value} is relative`,
      );
    }
  });

  test("a root set to nothing is refused, whoever else names the data directory", () => {
    // `paths` falls past an empty value, but other programs may interpret one
    // differently. Every present root therefore follows the same absolute rule.
    expect(servicePathProblems({ PATH: "/usr/bin", HOME: "", XDG_DATA_HOME: "/data" })).toEqual([
      "HOME is set to nothing",
    ]);
    expect(servicePathProblems({ PATH: "/usr/bin", HOME, GH_CONFIG_DIR: "" })).toEqual([
      "GH_CONFIG_DIR is set to nothing",
    ]);
  });

  test("an environment that names no data directory is refused too", () => {
    // `paths` would fall back to the process's own home and produce something
    // absolute; `locatesData` refuses that fallback, because a plist naming no
    // installation must not resolve to whichever one is asking. Writing it
    // anyway would mean installing a service Engwire reads back as foreign.
    expect(servicePathProblems({ PATH: "/usr/bin" })).toEqual([
      "nothing here names a data directory: ENGWIRE_HOME, XDG_DATA_HOME, HOME",
    ]);
    // Said once. The locator is there and unusable, which the row above already
    // reports; a second sentence would read as a second fault.
    expect(servicePathProblems({ PATH: "/usr/bin", HOME: "" })).toEqual(["HOME is set to nothing"]);
    expect(servicePathProblems({ PATH: "/usr/bin", ENGWIRE_HOME: "." })).toEqual([
      "ENGWIRE_HOME=. is relative",
    ]);
  });

  test("the ordinary environment has nothing to say", () => {
    expect(servicePathProblems({ PATH: "/usr/bin", HOME, GH_CONFIG_DIR: `${HOME}/.config/gh` })).toEqual(
      [],
    );
  });
});
