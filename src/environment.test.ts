import { describe, expect, test } from "bun:test";
import { withoutStartupCodeVariables, zshStartupProblem } from "./environment.ts";

describe("withoutStartupCodeVariables", () => {
  test("drops the namespaces that run code before a program starts", () => {
    // Namespaces rather than the names measured: `ld.so` documents `LD_AUDIT`
    // besides the two mechanisms confirmed, and `NODE_*` grows with every Node
    // release. The sentinels are invented names — a filter written as a list of
    // findings would keep them, which is the mistake this shape avoids.
    const env = withoutStartupCodeVariables({
      NODE_OPTIONS: "--require ./x.cjs",
      NODE_ENGWIRE_SENTINEL: "present",
      LD_PRELOAD: "./libengwire.so",
      LD_ENGWIRE_SENTINEL: "present",
      DYLD_INSERT_LIBRARIES: "./libengwire.dylib",
      DYLD_ENGWIRE_SENTINEL: "present",
      BASH_ENV: "./engwire-bash-env",
      PATH: "/usr/bin",
      HOME: "/Users/dev",
    });

    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  test("keeps the shell selector it was measured not to need", () => {
    // `ENV` is the proof the list above is a measurement rather than a hunch:
    // same idea, same family, and a non-interactive `sh` was measured not to
    // read it. `ZDOTDIR` stays for a different reason — dropping it hands the
    // job to `HOME`, so `zshStartupProblem` refuses instead.
    const env = withoutStartupCodeVariables({ ENV: "./engwire-env", ZDOTDIR: "/opt/zdot" });

    expect(env).toEqual({ ENV: "./engwire-env", ZDOTDIR: "/opt/zdot" });
  });
});

describe("zshStartupProblem", () => {
  // The unsafe value is exactly a non-empty relative one, whichever variable
  // supplied it. Refused rather than resolved: what a relative value resolves
  // against is the directory Engwire was started in, which can be the checkout
  // under review — measured, a `.zshenv` the branch shipped ran in a zsh
  // started from somewhere else entirely once the path had been pinned.
  test.each([
    ["a relative ZDOTDIR", { ZDOTDIR: "zdot", HOME: "/Users/dev" }, "ZDOTDIR"],
    ["a relative HOME with no ZDOTDIR", { HOME: "home" }, "HOME"],
  ])("refuses %s", (_case, env, blamed) => {
    const problem = zshStartupProblem(env);

    expect(problem).toContain(blamed);
    expect(problem).toContain("absolute path");
  });

  test.each([
    ["an absolute ZDOTDIR over an unsafe HOME", { ZDOTDIR: "/opt/zdot", HOME: "home" }],
    ["an absolute HOME with no ZDOTDIR", { HOME: "/Users/dev" }],
    // Measured safe, and the rows that keep this from becoming "anything
    // relative-looking is refused": zsh consults `HOME` only when `ZDOTDIR` is
    // unset, so an empty `ZDOTDIR` shadows even a dangerous `HOME`, and neither
    // empty value read anything from the working directory.
    ["an empty ZDOTDIR over an unsafe HOME", { ZDOTDIR: "", HOME: "home" }],
    ["an empty HOME with no ZDOTDIR", { HOME: "" }],
    ["neither set at all", {}],
  ])("accepts %s", (_case, env) => {
    expect(zshStartupProblem(env)).toBeNull();
  });
});
