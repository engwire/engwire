/**
 * @file Review requests and the runs Engwire creates for them.
 *
 * A ReviewRequest is an event that happened; a ReviewRun is what Engwire
 * decided to do about it. Keeping them apart is the whole reason the runner can
 * honour a second review request on an unchanged revision — which GitHub treats
 * as a distinct act, and which a reviewer means literally.
 */

/**
 * One `review_requested` timeline event naming this installation's reviewer.
 *
 * `eventId` is GitHub's own id for the event and is this request's identity.
 * `headSha` is *not* from the event: GitHub leaves `commit_id` null on
 * `review_requested`, so the revision is the pull request's head as it stood
 * when Engwire discovered the request.
 */
export type ReviewRequest = {
  eventId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  title: string;
  /** ISO 8601, from GitHub. The queue is ordered by it. */
  requestedAt: string;
  isDraft: boolean;
  /**
   * The branch lives in a different repository from the base. That is all
   * GitHub tells us — it is not by itself proof that the author lacks write
   * access — but it is exactly the distinction that matters, because the branch
   * came from somewhere the `[[review]]` rule did not name.
   */
  isFork: boolean;
};

export type RunStatus =
  | "queued"
  | "running"
  /**
   * Claude exited successfully. Not "a review was posted": the skill owns that
   * side effect, and Engwire deliberately does not look at GitHub afterwards to
   * find out.
   */
  | "completed"
  | "failed"
  /**
   * The runner died mid-review. Terminal, and deliberately not retried: the
   * skill posts to GitHub, so a half-finished review may already have said
   * something, and Engwire cannot tell. Re-request the review to try again.
   */
  | "interrupted"
  /** A newer review request replaced this one before it started. */
  | "superseded"
  /** Recorded, deliberately not run. `detail` says why. */
  | "dismissed";

/**
 * The statuses a run can end at.
 *
 * `finish` always writes `finished_at`, so it must not be reachable with
 * `queued` or `running` — that would record a row that is both under way and
 * over.
 */
export type TerminalRunStatus = Exclude<RunStatus, "queued" | "running">;

export type ReviewRun = {
  id: string;
  eventId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  title: string;
  skill: string | null;
  status: RunStatus;
  worktreePath: string | null;
  /** ISO 8601 worktree-retention deadline; the reaper ignores null. */
  retainUntil: string | null;
  /**
   * Terminal outcome detail, such as a dismissal or supersession reason or an
   * error.
   */
  detail: string | null;
  /** ISO 8601, from GitHub. */
  requestedAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export function pullKey(of: { repo: string; pullNumber: number }): string {
  return `${of.repo}#${of.pullNumber}`;
}
