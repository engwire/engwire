/**
 * @file Turning GitHub into `ReviewRequest[]`.
 *
 * Two GitHub concepts get conflated easily and must not be. `requested_reviewers`
 * is *state* — GitHub clears a reviewer from it the moment they submit a review,
 * so it can never tell you that a review was requested twice. The
 * `review_requested` issue events are the durable record, each with its own id.
 *
 * Search discovers candidates cheaply, a direct pull-request read verifies the
 * current state, and the issue events supply identity. The two reads per open
 * candidate are affordable at one reviewer's scale.
 *
 * Team review requests are unsupported: the event carries
 * `requested_team` instead of `requested_reviewer`, and answering them means
 * resolving the reviewer's team memberships first.
 */

import type { ReviewRequest } from "../review/model.ts";
import type { Gh } from "./gh.ts";

type SearchHit = {
  number: number;
  repository: { nameWithOwner: string };
};

type PullDetail = {
  headRefOid: string;
  isDraft: boolean;
  title: string;
  isCrossRepository: boolean;
  closed: boolean;
  /** Users have a `login`; a requested *team* is an entry without one. */
  reviewRequests: { login?: string }[];
};

type IssueEvent = {
  id: number;
  event: string;
  created_at: string;
  requested_reviewer?: { login: string } | null;
  requested_team?: { slug: string } | null;
};

/**
 * Open pull requests that currently list the user as a requested reviewer.
 *
 * GitHub Search exposes at most 1,000 results. A lower limit would silently stop
 * looking partway down a reviewer's queue, and since `gh` stops when results
 * run out, asking for the ceiling costs nothing in the normal case of a
 * handful.
 */
async function candidates(gh: Gh, limit: number): Promise<SearchHit[]> {
  return gh.json<SearchHit[]>([
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    `--limit=${limit}`,
    "--json",
    "repository,number",
  ]);
}

async function pullDetail(gh: Gh, repo: string, number: number): Promise<PullDetail> {
  return gh.json<PullDetail>([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "headRefOid,isDraft,title,isCrossRepository,closed,reviewRequests",
  ]);
}

/**
 * The issue events for a pull request, which is where `review_requested` lives.
 *
 * The timeline carries those entries too, along with every commit, comment,
 * review and cross-reference — none of which this reads, on a call made once
 * per candidate on every poll. What the two cost and how far they agree is
 * measured in `docs/experiments.md`.
 *
 * `--paginate` because a pull request's history runs past one page, and without
 * `--jq` it merges those pages into a single array, so one parse is correct on
 * the `gh` the README requires.
 */
async function issueEvents(gh: Gh, repo: string, number: number): Promise<IssueEvent[]> {
  return gh.json<IssueEvent[]>([
    "api",
    "--paginate",
    `repos/${repo}/issues/${number}/events?per_page=100`,
  ]);
}

export async function discoverReviewRequests(
  gh: Gh,
  options: {
    login: string;
    /** ISO 8601. Requests older than this are not this installation's business. */
    since: string;
    /** Defaults to GitHub Search's 1,000-result ceiling. */
    limit?: number;
  },
): Promise<ReviewRequest[]> {
  const hits = await candidates(gh, options.limit ?? 1000);

  // Compared as instants, not as text. The watermark is `Date.toISOString()`
  // and carries milliseconds; GitHub's timestamps stop at the second, and `Z`
  // sorts after `.`, so `"…10:00:00Z" >= "…10:00:00.500Z"` is true as strings
  // while the event is half a second older. That is the one window where a
  // request predating authorization could slip through.
  const since = Date.parse(options.since);

  // One pull request at a time: `gh` is a subprocess as well as an API client,
  // and fanning fifty candidates out at once would put a hundred of both in
  // flight from a laptop, which is a good way to meet GitHub's secondary rate
  // limits.
  //
  // Within one, state before history, never both at once. The two reads answer
  // different questions — `pr view` whether a review is wanted, the events
  // which request it is — and overlapping them can pair state observed after a
  // re-request with history read before it. Engwire would then act on the
  // superseded event and not see the newer one until the next poll, which is
  // one review too many. Read second, the history is never older than the
  // state that admitted it.
  const requests: ReviewRequest[] = [];
  for (const hit of hits) {
    const repo = hit.repository.nameWithOwner;
    const detail = await pullDetail(gh, repo, hit.number);

    // The search index is the stale half of this pair, and reconciliation takes
    // a discovered request as evidence that the pull request is still open and
    // still asking. So the direct read decides both, rather than the hit that
    // started this iteration: a pull request closed or a request withdrawn
    // since the search simply drops out, and any queued run for it is held on
    // the next reconciliation. A dropped candidate costs no second read.
    //
    // It settles the team case a second time too — a requested team has no
    // `login`, so it can never match the reviewer.
    if (detail.closed || !detail.reviewRequests.some((who) => who.login === options.login)) {
      continue;
    }

    const events = await issueEvents(gh, repo, hit.number);
    requests.push(
      ...events
        .filter(
          (event) =>
            event.event === "review_requested" &&
            event.requested_reviewer?.login === options.login &&
            Date.parse(event.created_at) >= since,
        )
        .map((event) => ({
          eventId: String(event.id),
          repo,
          pullNumber: hit.number,
          // The pull request's head *as of this poll*, not the event's
          // `commit_id`, which GitHub leaves null on `review_requested`. If the
          // author pushed between asking and Engwire noticing, the newer
          // revision is what gets reviewed — which is the change the reviewer
          // would open the pull request to, so it is the right answer anyway.
          headSha: detail.headRefOid,
          title: detail.title,
          requestedAt: event.created_at,
          isDraft: detail.isDraft,
          isFork: detail.isCrossRepository,
        })),
    );
  }

  return requests;
}
