import { describe, expect, test } from "bun:test";
import { replacementNotice } from "./service.ts";

describe("replacementNotice", () => {
  test("says nothing when the plist here already names this installation", () => {
    expect(replacementNotice({ whose: "none" })).toEqual([]);
    expect(
      replacementNotice({
        whose: "ours",
        plistPath: "/p",
        executable: "/bin/engwire",
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
