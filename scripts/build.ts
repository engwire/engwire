/**
 * @file Cross-compiled release binaries.
 *
 * One artifact per platform from one source tree, and every installer places
 * that same artifact — otherwise behaviour drifts between the paths users take.
 */

import { $ } from "bun";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

/**
 * The binary reads no configuration from the directory it is run in.
 *
 * A standalone Bun executable autoloads `.env` and `bunfig.toml` from its
 * working directory, and `bunfig.toml` has a `preload` list whose scripts run
 * before the program does. Engwire's working directory is wherever the reviewer
 * typed the command, which the rest of this codebase already assumes can be a
 * checkout of the branch under review — so left on, a committed `bunfig.toml`
 * executes contributor code before any of Engwire's own boundaries apply.
 * Measured: a `preload` in the cwd printed before `--version` did.
 *
 * All four are explicit so the property does not depend on Bun's defaults.
 */
const AUTOLOAD_OFF = [
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
];

const version = (await Bun.file("package.json").json()).version as string;

for (const target of TARGETS) {
  const name = `engwire-${target.replace("bun-", "")}`;
  console.log(`building ${name}`);
  await $`bun build --compile --minify ${AUTOLOAD_OFF} --target=${target} --outfile=dist/${name} src/main.ts`;
}

// The compiled binary is smoke-tested here rather than in CI so a local build
// gets the same answer. `VERSION` is inlined from package.json at compile time,
// so a binary that will not start, or that disagrees about which release it is,
// fails the build that produced it instead of the install that unwrapped it.
const host = `engwire-${process.platform}-${process.arch}`;
const reported = (await $`./dist/${host} --version`.text()).trim();
if (reported !== version) {
  throw new Error(`dist/${host} reports ${reported}, expected ${version}`);
}

console.log(`\nengwire ${version} → dist/`);
