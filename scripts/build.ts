/**
 * @file Cross-compiled release binaries.
 *
 * One binary per platform from one source tree, and every installer places that
 * same binary — otherwise behaviour drifts between the paths users take. The
 * release workflow gzips them; the `.gz` is what it publishes.
 */

import { $ } from "bun";
import { rm } from "node:fs/promises";

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

/**
 * Each binary beside the target that compiles it. Keep the pairs explicit so
 * the installer test can compare its independent `uname` mapping before a tag
 * is spent; deriving names from targets would leave swapped pairs undetectable.
 * The release publishes each name with `.gz` appended.
 */
export const BINARIES = [
  { target: "bun-darwin-arm64", name: "engwire-darwin-arm64" },
  { target: "bun-darwin-x64", name: "engwire-darwin-x64" },
  { target: "bun-linux-arm64", name: "engwire-linux-arm64" },
  { target: "bun-linux-x64", name: "engwire-linux-x64" },
] as const;

// Importing this file asks what the build emits; running it builds.
if (import.meta.main) {
  const version = (await Bun.file("package.json").json()).version as string;

  // The smoke test must not pass on a host binary left by an earlier build.
  await rm("dist", { recursive: true, force: true });

  for (const { target, name } of BINARIES) {
    console.log(`building ${name}`);
    await $`bun build --compile --minify ${AUTOLOAD_OFF} --target=${target} --outfile=dist/${name} src/main.ts`;
  }

  // The compiled binary is smoke-tested here rather than in CI so a local build
  // gets the same answer. `VERSION` is inlined from package.json at compile
  // time, so a binary that will not start, or that disagrees about which
  // release it is, fails the build that produced it instead of the install that
  // unwrapped it.
  const host = `engwire-${process.platform}-${process.arch}`;
  const reported = (await $`./dist/${host} --version`.text()).trim();
  if (reported !== version) {
    throw new Error(`dist/${host} reports ${reported}, expected ${version}`);
  }

  console.log(`\nengwire ${version} → dist/`);
}
