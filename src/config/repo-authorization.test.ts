/**
 * @file Repository matching and shadow detection over a finite set of representative patterns.
 *
 * `repos` authorizes which repositories an agent may review. The grammar has three forms (`*`, `owner/*`, `owner/name`), but unbounded names; these tests enumerate a fixture set covering each form, prefix collisions, literal dots and case folding.
 *
 * Shadow detection is exercised through `parseConfig`: an earlier single-pattern rule subsumes a later one exactly when it matches every repository the later pattern matches in this fixture set.
 */

import { describe, expect, test } from "bun:test";
import { matchesRepo, parseConfig } from "./config.ts";

/** Prefix pairs catch missing anchors; dots catch accidental regex wildcard matching. */
const OWNERS = ["a", "b", "ab", "a.b"];
const NAMES = ["x", "y", "xy", "x.y"];

/** Mixed-case patterns check that matching folds case on both sides. */
const PATTERNS = [
  "*",
  ...OWNERS.map((o) => `${o}/*`),
  ...OWNERS.flatMap((o) => NAMES.map((n) => `${o}/${n}`)),
  "A/*",
  "AB/XY",
];

/**
 * Representative repositories plus probes for case, slash boundaries and literal dots.
 *
 * Discovery supplies `nameWithOwner`; empty components such as `a/` are outside the input contract and are omitted. The malformed `ax` and `a/x/y` probes check that an owner wildcard requires a slash and cannot cross a second one.
 */
const REPOS = [
  ...OWNERS.flatMap((o) => NAMES.map((n) => `${o}/${n}`)),
  "A/X",
  "AB/XY",
  "a/x/y",
  "ax",
  "aXb/x",
  "a/xXy",
];

/** Whether `earlier` matches everything `later` matches in the fixture set. */
function subsumes(earlier: string, later: string): boolean {
  return REPOS.every((repo) => !matchesRepo(later, repo) || matchesRepo(earlier, repo));
}

/** One single-pattern rule per argument, in order. */
function rules(...patterns: string[]): string {
  return patterns
    .map(
      (pattern, index) =>
        `[[review]]\nrepos = ${JSON.stringify([pattern])}\nskill = "review-${index}"\n`,
    )
    .join("\n");
}

/** Count only shadowing errors; an unrelated parse failure must fail the test. */
function refused(toml: string): boolean {
  try {
    parseConfig(toml);
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.includes("can never match")) return true;
    throw error;
  }
}

describe("what a rule authorizes", () => {
  test("the fixture set includes all three pattern forms", () => {
    // Guard against vacuous passes if a generated fixture pool becomes empty.
    expect(PATTERNS.length).toBeGreaterThan(5);
    expect(REPOS.length).toBeGreaterThan(5);
    // Keep all three pattern forms represented.
    expect(PATTERNS).toContain("*");
    expect(PATTERNS.some((pattern) => pattern !== "*" && pattern.endsWith("/*"))).toBe(true);
    expect(PATTERNS.some((pattern) => !pattern.includes("*"))).toBe(true);
  });

  test("an owner wildcard stops at the slash", () => {
    // A rule for one owner reaches that owner and no other, however the two
    // names are spelled relative to each other.
    expect(matchesRepo("a/*", "ab/x")).toBe(false);
    expect(matchesRepo("a/*", "a/x")).toBe(true);
    expect(matchesRepo("ab/*", "ab/x")).toBe(true);
    expect(matchesRepo("a/*", "ax")).toBe(false);
    // And a wildcard is one level, not a prefix: a name carrying its own slash
    // is not a repository under that owner.
    expect(matchesRepo("a/*", "a/x/y")).toBe(false);
  });

  test("matches the expected repositories across the fixture set", () => {
    // Every pattern against every repository, against an independent reading of
    // what each pattern means. Every fixture pair is checked.
    for (const pattern of PATTERNS) {
      for (const repo of REPOS) {
        const [owner = "", name = "", extra] = repo.toLowerCase().split("/");
        const wellFormed = owner !== "" && name !== "" && extra === undefined;
        // Both sides decomposed the same way, by splitting on the slash, so
        // this owes nothing to the implementation's index arithmetic.
        const [patternOwner = "", patternName = ""] = pattern.toLowerCase().split("/");
        const expected =
          pattern === "*"
            ? true
            : patternName === "*"
              ? wellFormed && patternOwner === owner
              : wellFormed && patternOwner === owner && patternName === name;

        expect(matchesRepo(pattern, repo), `${pattern} against ${repo}`).toBe(expected);
      }
    }
  });

  test("a rule is refused exactly when an earlier one already covers it", () => {
    // Check both false rejections and missed shadows.
    for (const first of PATTERNS) {
      for (const second of PATTERNS) {
        expect(refused(rules(first, second)), `${first} then ${second}`).toBe(
          subsumes(first, second),
        );
      }
    }
  });

  test("order is what decides, so the specific rule may come first", () => {
    // The same two patterns, the other way round: `acme/api` before `acme/*` is
    // the arrangement the README tells people to write, and it must parse.
    expect(refused(rules("a/x", "a/*"))).toBe(false);
    expect(refused(rules("a/*", "a/x"))).toBe(true);
  });

  test("a shadow is a shadow however far back the rule that casts it is", () => {
    // Shadow detection must consider all earlier rules, not just the previous one.
    expect(refused(rules("a/*", "b/*", "a/x"))).toBe(true);
    expect(refused(rules("b/*", "ab/*", "a/x"))).toBe(false);
  });
});
