/**
 * @file Command dispatch.
 *
 * Hand-rolled because the command grammar is small and exact; an argument
 * parser would otherwise be the only runtime dependency in the project.
 */

import { ConfigError } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { GhError } from "../github/gh.ts";
import { DatabaseTooNewError } from "../store/store.ts";

import { VERSION } from "../version.ts";
import { doctor } from "./doctor.ts";
import { run } from "./run.ts";
import { serviceInstall, serviceUninstall } from "./service.ts";
import { setup } from "./setup.ts";
import { status } from "./status.ts";

const USAGE = `Engwire ${VERSION} — review the pull requests that ask for your review

Usage
  engwire setup              Check prerequisites and write a starter config
  engwire run [--once]       Watch for review requests and review them
  engwire status             Runner state and recent reviews
  engwire doctor             Diagnose the local setup
  engwire service install    Run in the background (launchd)
  engwire service uninstall  Stop running in the background

Config
  ${paths().configFile}
`;

/**
 * Every command's shape is exact: unrecognised arguments are refused, and so
 * are extra ones.
 *
 * `engwire run --dry-run` silently starting a real runner is the surprise a
 * hand-rolled dispatcher earns if it only ever asks whether the flag it knows
 * about is present — and `engwire help nonsense` answering 0 is the same
 * mistake, quieter.
 */
function noArgs(args: string[]): boolean {
  return args.length === 0;
}

function usageError(usage: string): number {
  console.error(`Usage: ${usage}`);
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    // These are expected operational failures with actionable messages, so a
    // stack trace would be noise. Anything else escapes and looks like a bug.
    if (
      error instanceof ConfigError ||
      error instanceof GhError ||
      error instanceof DatabaseTooNewError
    ) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "setup":
      return noArgs(rest) ? setup() : usageError("engwire setup");
    case "run": {
      const once = rest.length === 1 && rest[0] === "--once";
      if (!once && !noArgs(rest)) return usageError("engwire run [--once]");
      return run({ once });
    }
    case "status":
      return noArgs(rest) ? status() : usageError("engwire status");
    case "doctor":
      return noArgs(rest) ? doctor() : usageError("engwire doctor");
    case "service": {
      const [action, ...flags] = rest;
      if (flags.length > 0) return usageError("engwire service <install|uninstall>");
      if (action === "install") return serviceInstall();
      if (action === "uninstall") return serviceUninstall();
      return usageError("engwire service <install|uninstall>");
    }
    case "--version":
    case "version":
      if (!noArgs(rest)) return usageError("engwire version");
      console.log(VERSION);
      return 0;
    case undefined:
    case "--help":
    case "help":
      if (!noArgs(rest)) return usageError("engwire help");
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
  }
}
