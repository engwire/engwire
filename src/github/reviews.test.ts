import { describe, expect, test } from "bun:test";
import type { Gh } from "./gh.ts";
import { discoverReviewRequests } from "./reviews.ts";

const SHA = "c".repeat(40);

function gh(events: unknown[], detail: Record<string, unknown> = {}): Gh {
  const responses: Record<string, unknown> = {
    search: [{ number: 42, repository: { nameWithOwner: "acme/api" } }],
    view: {
      headRefOid: SHA,
      isDraft: false,
      title: "Add widgets",
      isCrossRepository: false,
      closed: false,
      reviewRequests: [{ login: "me" }],
      ...detail,
    },
    events,
  };

  return {
    text: async () => "",
    login: async () => "me",
    json: async <T,>(args: string[]) => {
      const key = args[0] === "search" ? "search" : args[0] === "pr" ? "view" : "events";
      return responses[key] as T;
    },
  };
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: 100,
    event: "review_requested",
    created_at: "2026-08-01T10:00:00Z",
    requested_reviewer: { login: "me" },
    // Live GitHub leaves this null on review_requested, which is why
    // the revision has to come from the pull request instead.
    commit_id: null,
    ...over,
  };
}

describe("discoverReviewRequests", () => {
  const since = "2026-01-01T00:00:00Z";

  test("maps a review request onto the pull request's head", async () => {
    const requests = await discoverReviewRequests(gh([event()]), { login: "me", since });

    expect(requests).toEqual([
      {
        eventId: "100",
        repo: "acme/api",
        pullNumber: 42,
        // Not from the event: GitHub leaves commit_id null on review_requested.
        headSha: SHA,
        title: "Add widgets",
        requestedAt: "2026-08-01T10:00:00Z",
        isDraft: false,
        isFork: false,
      },
    ]);
  });

  test("reports every request, not just the current one", async () => {
    const requests = await discoverReviewRequests(
      gh([
        event({ id: 1, created_at: "2026-08-01T10:00:00Z" }),
        event({ id: 2, created_at: "2026-08-03T10:00:00Z" }),
      ]),
      { login: "me", since },
    );
    expect(requests.map((r) => r.eventId)).toEqual(["1", "2"]);
  });

  test("ignores requests for other people and for teams", async () => {
    const requests = await discoverReviewRequests(
      gh([
        event({ id: 1, requested_reviewer: { login: "someone-else" } }),
        event({ id: 2, requested_reviewer: null, requested_team: { slug: "platform" } }),
      ]),
      { login: "me", since },
    );
    expect(requests).toEqual([]);
  });

  test("ignores other issue events", async () => {
    const requests = await discoverReviewRequests(
      gh([event({ id: 1, event: "review_request_removed" }), event({ id: 2, event: "labeled" })]),
      { login: "me", since },
    );
    expect(requests).toEqual([]);
  });

  test("reads all issue events, at the maximum page size", async () => {
    // `--paginate` is the whole of the guarantee that a request on a later page
    // is seen at all: GitHub caps a page at 100 entries, and a pull request
    // busy enough to need a second one can still be asking for a review.
    const calls: string[][] = [];
    const responses = gh([event({ id: 1 })]);
    const recording: Gh = {
      ...responses,
      json: async <T,>(args: string[]) => {
        calls.push(args);
        return responses.json<T>(args);
      },
    };

    await discoverReviewRequests(recording, { login: "me", since });

    expect(calls).toContainEqual([
      "api",
      "--paginate",
      "repos/acme/api/issues/42/events?per_page=100",
    ]);
  });

  test("ignores requests made before this installation existed", async () => {
    const requests = await discoverReviewRequests(gh([event({ created_at: "2025-01-01T00:00:00Z" })]), {
      login: "me",
      since: "2026-01-01T00:00:00Z",
    });
    expect(requests).toEqual([]);
  });

  test("compares against the watermark as an instant, not as text", async () => {
    // The watermark carries milliseconds and GitHub's timestamps do not, and
    // "Z" sorts after "." — so this event is lexically newer and actually half
    // a second older.
    const earlier = gh([event({ created_at: "2026-08-01T10:00:00Z" })]);
    expect(
      await discoverReviewRequests(earlier, { login: "me", since: "2026-08-01T10:00:00.500Z" }),
    ).toEqual([]);

    const later = gh([event({ created_at: "2026-08-01T10:00:01Z" })]);
    expect(
      await discoverReviewRequests(later, { login: "me", since: "2026-08-01T10:00:00.500Z" }),
    ).toHaveLength(1);
  });

  test("drops a pull request the search found but that has since closed", async () => {
    // Search is indexed and lags; `pr view` is live and already being called.
    const requests = await discoverReviewRequests(gh([event()], { closed: true }), {
      login: "me",
      since,
    });
    expect(requests).toEqual([]);
  });

  test("drops a pull request whose request has since been withdrawn", async () => {
    const withdrawn = gh([event()], { reviewRequests: [] });
    expect(await discoverReviewRequests(withdrawn, { login: "me", since })).toEqual([]);

    // A requested team has no `login`, so it cannot stand in for the reviewer.
    const teamOnly = gh([event()], { reviewRequests: [{ __typename: "Team", slug: "platform" }] });
    expect(await discoverReviewRequests(teamOnly, { login: "me", since })).toEqual([]);
  });

  test("does not read the history of a pull request the current state rejects", async () => {
    // Ordering as a test. Reading both at once can pair state observed after a
    // re-request with history read before it, so the history must be fetched
    // only once the state has said its events are wanted.
    const base = gh([event()], { closed: true });
    const gated: Gh = {
      ...base,
      json: async <T,>(args: string[]) => {
        if (args[0] === "api") throw new Error("the events were read too early");
        return base.json<T>(args);
      },
    };

    expect(await discoverReviewRequests(gated, { login: "me", since })).toEqual([]);
  });
});
