// A runner in its own process, so a test can signal it the way a terminal or
// launchd would and then ask what became of the review.
import { runClaude } from "../../src/claude/run.ts";

await runClaude({
  bin: process.argv[2]!,
  ghBin: "/usr/bin/gh",
  repo: "acme/api",
  cwd: process.cwd(),
  prompt: "ignored",
  timeoutMs: 60_000,
  logPath: process.argv[3]!,
});
