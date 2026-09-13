/**
 * @file Command dispatch.
 *
 * Hand-rolled because the command grammar is small and exact; an argument
 * parser would otherwise be the only runtime dependency in the project.
 */

import { ConfigError } from "../config/config.ts";
import { zshStartupProblem } from "../environment.ts";
import { locationProblem, paths } from "../config/paths.ts";
import { ghConfigProblem, GhError } from "../github/gh.ts";
import { DatabaseTooNewError } from "../store/store.ts";

import { VERSION } from "../version.ts";
import { doctor } from "./doctor.ts";
import { run } from "./run.ts";
import { serviceInstall, serviceUninstall } from "./service.ts";
import { installedService } from "../service/launchd.ts";
import { setup } from "./setup.ts";
import { status } from "./status.ts";
import { uninstall } from "./uninstall.ts";

/**
 * Every command, on every platform — a usage list that changed shape by machine
 * would make two people reading the same output disagree about what exists.
 *
 * Every flag those commands take, too. A flag the dispatcher accepts and this
 * list omits is one nobody finds, and each refusal below prints the command's
 * grammar, so `index.test.ts` has two statements of it to compare.
 *
 * The two launchd-only ones are marked instead. "(macOS)" rather than
 * "(launchd)": the reader deciding whether a line applies to them is answering
 * a platform question, and only somebody who already knows launchd is macOS
 * could read the jargon as that answer. Unmarked, the round trip is running the
 * command to be told it exits 1 anywhere else.
 */
const USAGE = `Engwire ${VERSION} — review the pull requests that ask for your review

Usage
  engwire setup              Check prerequisites and write a starter config
  engwire run [--once]       Watch for review requests and review them
  engwire status             Runner state and recent reviews
  engwire doctor             Diagnose the local setup
  engwire service install    Run in the background (macOS)
  engwire service uninstall  Stop running in the background (macOS)
  engwire uninstall [--yes]  Preview or remove this installation's data, config and service

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

/** Print a refusal and answer 1, or answer null when there is nothing to refuse. */
function refuse(problem: string | null): number | null {
  if (problem === null) return null;
  console.error(problem);
  return 1;
}

/**
 * The refusal every command that opens a database or writes a config makes.
 *
 * A relative installation address is a second installation per working
 * directory, so the commands that act on one cannot start. `doctor` and
 * `uninstall` need it in hand instead: one reports it as the failed check it
 * is, the other prints the inventory and then refuses the removal, because
 * deleting an address that moves would delete whatever happens to sit there
 * now. `help` and `version` do not depend on an installation existing.
 */
function refuseRelativeLocation(): number | null {
  return refuse(locationProblem());
}

/**
 * The two further refusals a *review* needs, which is why they are not on the
 * gate above.
 *
 * They have different scopes and lumping them together got that wrong: gh's
 * configuration root decides which account posts and what its aliases run, and
 * zsh's startup directory decides what the review's first shell executes.
 * Neither is a question `status` has to answer — it reads a database and a lock
 * and starts nothing — and neither should stop `setup`, whose whole job is to
 * report what is wrong rather than to fail at the door. `diagnose` reports
 * both: an unsafe gh root blocks gh probes, and an unsafe zsh startup root
 * blocks every tool probe.
 *
 * Both are refusals rather than repairs. Resolving a relative one to an
 * absolute path stops it moving and pins whatever it was already pointing at —
 * which, when a command is run from a checkout, is content the branch supplied.
 */
function refuseUnsafeReviewRoots(): number | null {
  return refuse(ghConfigProblem() ?? zshStartupProblem());
}

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  // Each guard sits inside the case that needs it, after the arguments have
  // been checked: a gate in front of the whole switch answered `engwire status
  // nonsense` with an environment complaint instead of the syntax error, and
  // gave `service install` an irrelevant one on the platform where the answer
  // is "this is macOS-only". What keeps a new command from quietly skipping the
  // guard is not the shape of this function — it is `index.test.ts`, which
  // derives the commands from the help text and holds each to refusing or to
  // being deliberately exempt.
  switch (command) {
    case "setup":
      if (!noArgs(rest)) return usageError("engwire setup");
      return refuseRelativeLocation() ?? setup();
    case "run": {
      const once = rest.length === 1 && rest[0] === "--once";
      if (!once && !noArgs(rest)) return usageError("engwire run [--once]");
      // The only command that both acts on the installation and starts a review,
      // so the only one that answers all three questions.
      return refuseRelativeLocation() ?? refuseUnsafeReviewRoots() ?? run({ once });
    }
    case "status":
      if (!noArgs(rest)) return usageError("engwire status");
      return refuseRelativeLocation() ?? status();
    case "doctor":
      return noArgs(rest) ? doctor() : usageError("engwire doctor");
    case "service": {
      const [action, ...flags] = rest;
      if (flags.length > 0) return usageError("engwire service <install|uninstall>");
      // Neither action is guarded here. `serviceInstall` asks the environment
      // *launchd* will supply, which is the one that decides what the job
      // supervises — and it asks after the macOS-only check, so somebody on
      // Linux gets the answer to the question they asked. `uninstall` boots out
      // one label and deletes the plist beside it, both fixed per user and
      // neither read from `paths()`; somebody whose shell points somewhere
      // relative is exactly who may need to stop the job that is running.
      if (action === "install") return serviceInstall();
      if (action === "uninstall") return serviceUninstall();
      return usageError("engwire service <install|uninstall>");
    }
    case "uninstall": {
      // Confirmed by a word, not by a prompt: this is the one command that
      // deletes a directory of private source, and it has to behave the same
      // whether or not anyone is watching the terminal.
      const yes = rest.length === 1 && rest[0] === "--yes";
      if (!yes && !noArgs(rest)) return usageError("engwire uninstall [--yes]");
      return uninstall({ confirmed: yes, ...(await installedService(paths().dataDir)) });
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
