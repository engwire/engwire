import { describe, expect, test } from "bun:test";
import { ConfigError, matchesRepo, parseConfig } from "./config.ts";

describe("parseConfig", () => {
  test("reads review rules and applies defaults", () => {
    const config = parseConfig(`
[[review]]
repos = ["acme/*"]
skill = "review-pr"
`);
    expect(config.reviews).toEqual([
      { repos: ["acme/*"], skill: "review-pr", skipDrafts: true },
    ]);
    expect(config.advanced.pollIntervalMs).toBe(60_000);
    expect(config.advanced.worktreeTtlMs).toBe(24 * 3_600_000);
  });

  test("parses durations", () => {
    const config = parseConfig(`
[advanced]
poll_interval = "30s"
worktree_ttl = "2h"
run_timeout = "5m"
`);
    expect(config.advanced.pollIntervalMs).toBe(30_000);
    expect(config.advanced.worktreeTtlMs).toBe(7_200_000);
    expect(config.advanced.runTimeoutMs).toBe(300_000);
  });

  test("rejects a duration it cannot read rather than guessing", () => {
    expect(() => parseConfig(`[advanced]\npoll_interval = "soon"\n`)).toThrow(ConfigError);
  });

  test("rejects durations outside the range a timer or a Date can hold", () => {
    expect(() => parseConfig(`[advanced]\npoll_interval = "0ms"\n`)).toThrow(ConfigError);
    expect(() => parseConfig(`[advanced]\nrun_timeout = "0ms"\n`)).toThrow(ConfigError);
    // `new Date(Infinity).toISOString()` throws, so an unbounded TTL would take
    // the runner down when it finished a review rather than when it read this.
    expect(() =>
      parseConfig(`[advanced]\nworktree_ttl = "999999999999999999999999h"\n`),
    ).toThrow(ConfigError);
    // Zero retention is meaningful: reclaim the checkout at once.
    expect(parseConfig(`[advanced]\nworktree_ttl = "0ms"\n`).advanced.worktreeTtlMs).toBe(0);
  });

  test("rejects a skill written as a slash command", () => {
    expect(() =>
      parseConfig(`[[review]]\nrepos = ["*"]\nskill = "/review-pr"\n`),
    ).toThrow(/without a leading slash/);
  });

  test("rejects a rule with no repositories", () => {
    expect(() => parseConfig(`[[review]]\nrepos = []\nskill = "x"\n`)).toThrow(ConfigError);
  });

  test("rejects a repository pattern outside the documented grammar", () => {
    // `acme/foo*` looks like it would work and matches nothing.
    for (const pattern of ["acme/foo*", "acme", "acme/a/b", "*/api", ""]) {
      expect(() =>
        parseConfig(`[[review]]\nrepos = [${JSON.stringify(pattern)}]\nskill = "x"\n`),
      ).toThrow(ConfigError);
    }
  });

  test("rejects a boolean written as a string rather than reading it as false", () => {
    expect(() =>
      parseConfig(`[[review]]\nrepos = ["*"]\nskill = "x"\nskip_drafts = "false"\n`),
    ).toThrow(/expected true or false/);
  });

  test("rejects a key nobody reads rather than ignoring the typo", () => {
    // `skip_draft` looks like it works and silently leaves the default in place.
    expect(() =>
      parseConfig(`[[review]]\nrepos = ["*"]\nskill = "x"\nskip_draft = false\n`),
    ).toThrow(/unknown key "skip_draft"/);
    expect(() => parseConfig(`[advanced]\npoll_intervall = "10s"\n`)).toThrow(
      /unknown key "poll_intervall"/,
    );
    expect(() => parseConfig(`[[reviews]]\nrepos = ["*"]\n`)).toThrow(/unknown key "reviews"/);
  });

  test("rejects a skill name that would not survive the slash", () => {
    // `/review pr acme/api#42` invokes `/review` with an argument nobody meant.
    expect(() =>
      parseConfig(`[[review]]\nrepos = ["*"]\nskill = "review pr"\n`),
    ).toThrow(ConfigError);
  });

  test("refuses a relative executable path", () => {
    // A relative path resolves against the working directory, and one of those
    // is a checkout of the pull request being reviewed.
    expect(() => parseConfig(`[advanced]\ngh_bin = "./gh"\n`)).toThrow(/relative path/);
    expect(() => parseConfig(`[advanced]\nclaude_bin = "tools/claude"\n`)).toThrow(
      /relative path/,
    );
    expect(parseConfig(`[advanced]\ngh_bin = "gh"\n`).advanced.ghBin).toBe("gh");
    expect(parseConfig(`[advanced]\ngh_bin = "/usr/bin/gh"\n`).advanced.ghBin).toBe(
      "/usr/bin/gh",
    );
  });

  test("an empty config is valid and reviews nothing", () => {
    expect(parseConfig("").reviews).toEqual([]);
  });

  test("rejects a rule an earlier one has already swallowed", () => {
    // Valid TOML, valid patterns, valid skills — and `review-payments` can
    // never run on the one repository the user singled out.
    expect(() =>
      parseConfig(`
        [[review]]
        repos = ["acme/*"]
        skill = "review-pr"

        [[review]]
        repos = ["acme/payments"]
        skill = "review-payments"
      `),
    ).toThrow(/"acme\/payments" can never match.*"acme\/\*" in review\[0\]/s);
  });

  test("rejects redundant patterns within a rule and shadowed later rules", () => {
    expect(() =>
      parseConfig(`
        [[review]]
        repos = ["acme/api", "acme/api"]
        skill = "review-pr"
      `),
    ).toThrow(/Remove the redundant pattern/);
    expect(() =>
      parseConfig(`
        [[review]]
        repos = ["acme/api"]
        skill = "review-pr"

        [[review]]
        repos = ["ACME/API"]
        skill = "review-other"
      `),
    ).toThrow(/Remove the duplicate pattern or combine the rules/);
    expect(() =>
      parseConfig(`
        [[review]]
        repos = ["*"]
        skill = "review-pr"

        [[review]]
        repos = ["other/thing"]
        skill = "review-other"
      `),
    ).toThrow(/"\*" in review\[0\].*list the more specific rule first/s);
  });

  test("accepts the documented ordering, specific rule first", () => {
    const config = parseConfig(`
      [[review]]
      repos = ["acme/payments"]
      skill = "review-payments"

      [[review]]
      repos = ["acme/*"]
      skill = "review-pr"

      [[review]]
      repos = ["other/*"]
      skill = "review-pr"
    `);
    expect(config.reviews.map((r) => r.skill)).toEqual([
      "review-payments",
      "review-pr",
      "review-pr",
    ]);
  });
});

describe("matchesRepo", () => {
  test.each([
    ["*", "acme/api", true],
    ["acme/*", "acme/api", true],
    ["acme/*", "acme/api/extra", false],
    ["acme/*", "other/api", false],
    ["acme/api", "acme/api", true],
    ["acme/api", "acme/apix", false],
    ["ACME/API", "acme/api", true],
  ])("%s vs %s", (pattern, repo, expected) => {
    expect(matchesRepo(pattern, repo)).toBe(expected);
  });
});
