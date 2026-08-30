/**
 * @file Reading `config.toml`.
 *
 * The file describes outcomes — which repositories get reviewed, by which
 * skill — and nothing about how the runner achieves them. Poll rate, retention
 * and timeouts are tuning parameters with defaults good enough that nobody
 * should have to pick them; they live under `[advanced]` for the case where the
 * default is wrong on one machine, not as part of the product's surface.
 *
 * Validation is hand-written and so is the TOML shape check. A single-binary
 * OSS tool with zero runtime dependencies is worth more than the few lines a
 * schema library would save.
 */

import { isAbsolute } from "node:path";
import { paths } from "./paths.ts";

/** One rule: when these repositories request my review, run this skill. */
export type ReviewAutomation = {
  /** `owner/name`, `owner/*`, or `*`. */
  repos: string[];
  /** Claude Code skill invoked as `/<skill> owner/name#42`. */
  skill: string;
  skipDrafts: boolean;
};

export type Config = {
  reviews: ReviewAutomation[];
  advanced: {
    pollIntervalMs: number;
    /** How long a terminal run's worktree stays on disk for inspection. */
    worktreeTtlMs: number;
    /** How long one review may take before Engwire terminates Claude. */
    runTimeoutMs: number;
    /**
     * Absolute paths matter here: launchd hands a service a minimal PATH, so a
     * `gh` in Homebrew and a `claude` in `~/.local/bin` are both invisible
     * unless named outright. `engwire setup` resolves them.
     */
    ghBin: string;
    claudeBin: string;
  };
};

export class ConfigError extends Error {}

export const DEFAULT_CONFIG_TOML = `# Engwire — automatic local review of pull requests that request your review.
#
# Every rule below answers one question: when a repository asks for my review,
# which Claude Code skill should look at it?
#
# Nothing is reviewed until you uncomment a rule and name the repositories you
# want reviewed. Engwire starts an agent on a contributor's code, so which
# repositories that happens for is a decision worth making yourself.

# [[review]]
# repos = ["your-org/*"]
# skill = "review-pr"
`;

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const DAY = 24 * 3_600_000;

function duration(
  value: unknown,
  field: string,
  options: { min: number; max: number },
): number {
  if (typeof value !== "string") {
    throw new ConfigError(`${field}: expected a duration string like "45s"`);
  }
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  const unit = match ? UNITS[match[2] as string] : undefined;
  if (!match || unit === undefined) {
    throw new ConfigError(
      `${field}: expected a duration like "45s", "20m" or "24h", got ${JSON.stringify(value)}`,
    );
  }
  const ms = Number(match[1]) * unit;
  // Bounded at both ends. A zero poll interval is a busy loop against GitHub
  // and a zero review timeout kills every review on the spot; at the other end
  // a big enough number stops being a number a timer or a Date can hold, and
  // `new Date(Infinity).toISOString()` throws rather than misbehaving visibly.
  if (!Number.isSafeInteger(ms) || ms < options.min || ms > options.max) {
    throw new ConfigError(
      `${field}: must be between ${options.min}ms and ${options.max}ms, got ${value}`,
    );
  }
  return ms;
}

/**
 * An executable setting is either a bare command name or an absolute path.
 *
 * Never a relative path. `gh_bin = "./tools/gh"` would be resolved against
 * whatever directory the process happened to be in — and one of those is a
 * checkout of a pull request, so the setting would name a contributor's file.
 */
function executable(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${field}: expected a command name or absolute path`);
  }
  if (value.includes("/") && !isAbsolute(value)) {
    throw new ConfigError(
      `${field}: ${JSON.stringify(value)} is a relative path; use a command name or an absolute path`,
    );
  }
  return value;
}

function boolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${field}: expected true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

function table(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${field}: expected a table`);
  }
  return value as Record<string, unknown>;
}

/**
 * Refuse keys nobody reads.
 *
 * `skip_draft = false` and `poll_intervall = "10s"` both look like they work
 * and both do nothing. A config file is read once, in the dark, by a background
 * process; a typo in it should be an error at the point of the typo.
 */
function onlyKeys(t: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(t).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${field}: unknown key${unknown.length > 1 ? "s" : ""} ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}. Expected one of: ${allowed.join(", ")}`,
    );
  }
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${field}: expected an array of strings`);
  }
  if (value.length === 0) throw new ConfigError(`${field}: must not be empty`);
  return value as string[];
}

export function parseConfig(source: string): Config {
  let raw: Record<string, unknown>;
  try {
    raw = table(Bun.TOML.parse(source), "config");
  } catch (error) {
    throw new ConfigError(
      `config.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  onlyKeys(raw, ["review", "advanced"], "config");

  const reviewEntries = raw.review === undefined ? [] : raw.review;
  if (!Array.isArray(reviewEntries)) {
    throw new ConfigError("review: expected one or more [[review]] tables");
  }

  const reviews = reviewEntries.map((entry, index): ReviewAutomation => {
    const t = table(entry, `review[${index}]`);
    onlyKeys(t, ["repos", "skill", "skip_drafts"], `review[${index}]`);
    if (typeof t.skill !== "string" || t.skill.length === 0) {
      throw new ConfigError(`review[${index}].skill: expected a skill name`);
    }
    if (t.skill.startsWith("/")) {
      // The config names a skill; Engwire writes the slash. Accepting both
      // would mean two spellings of one value in every user's file.
      throw new ConfigError(
        `review[${index}].skill: write the skill name without a leading slash`,
      );
    }
    if (!SKILL_NAME.test(t.skill)) {
      // `review pr` would be sent as `/review pr acme/api#42`, which invokes
      // `/review` with an argument nobody meant.
      throw new ConfigError(
        `review[${index}].skill: ${JSON.stringify(t.skill)} is not a skill name`,
      );
    }
    const repos = stringList(t.repos, `review[${index}].repos`);
    for (const pattern of repos) {
      if (!REPO_PATTERN.test(pattern)) {
        throw new ConfigError(
          `review[${index}].repos: ${JSON.stringify(pattern)} is not "owner/name", "owner/*" or "*"`,
        );
      }
    }
    return {
      repos,
      skill: t.skill,
      skipDrafts: boolean(t.skip_drafts, `review[${index}].skip_drafts`, true),
    };
  });

  const advanced = raw.advanced === undefined ? {} : table(raw.advanced, "advanced");
  onlyKeys(
    advanced,
    ["poll_interval", "worktree_ttl", "run_timeout", "gh_bin", "claude_bin"],
    "advanced",
  );

  return {
    reviews,
    advanced: {
      pollIntervalMs:
        advanced.poll_interval === undefined
          ? 60_000
          : duration(advanced.poll_interval, "advanced.poll_interval", {
              min: 5_000,
              max: DAY,
            }),
      worktreeTtlMs:
        advanced.worktree_ttl === undefined
          ? 24 * 3_600_000
          // Zero is allowed: reclaiming the checkout immediately is a choice.
          : duration(advanced.worktree_ttl, "advanced.worktree_ttl", { min: 0, max: 365 * DAY }),
      runTimeoutMs:
        advanced.run_timeout === undefined
          ? 20 * 60_000
          : duration(advanced.run_timeout, "advanced.run_timeout", { min: 1_000, max: DAY }),
      ghBin: executable(advanced.gh_bin, "advanced.gh_bin", "gh"),
      claudeBin: executable(advanced.claude_bin, "advanced.claude_bin", "claude"),
    },
  };
}

export async function loadConfig(file = paths().configFile): Promise<Config> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) {
    throw new ConfigError(`No config at ${file}. Run \`engwire setup\` first.`);
  }
  return parseConfig(await handle.text());
}

/**
 * Skill names as Claude Code spells them: what can follow a slash and still be
 * one word.
 */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * The whole `repos` grammar: `owner/name`, `owner/*`, or `*`.
 *
 * Checked at parse time so a near-miss like `acme/foo*` is a config error
 * rather than a rule that silently matches nothing.
 */
const REPO_PATTERN = /^(\*|[A-Za-z0-9._-]+\/(\*|[A-Za-z0-9._-]+))$/;

/** `acme/*` matches any repository in `acme`; `*` matches every repository. */
export function matchesRepo(pattern: string, repo: string): boolean {
  const p = pattern.toLowerCase();
  const r = repo.toLowerCase();
  if (p === "*" || p === r) return true;
  if (!p.endsWith("/*")) return false;
  const owner = p.slice(0, -1); // keeps the trailing slash
  return r.startsWith(owner) && !r.slice(owner.length).includes("/");
}
