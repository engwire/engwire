# Architecture

Engwire watches GitHub for review requests addressed to you, checks out a pinned revision, and hands it to your Claude Code review skill. It runs on your laptop, with your `gh` and your Claude subscription. No Engwire server is involved, and no third party is granted access to the code.

```text
                    GitHub
                      │
                      │ gh
                      ▼
               ┌─────────────┐
               │  Discovery  │  github/reviews.ts
               └──────┬──────┘
                      │
             ReviewRequest[]
                      │
                      ▼
               ┌─────────────┐
 config ──────►│  Reconcile  │◄──── state    review/reconcile.ts (pure)
               └──────┬──────┘
                      │
                 ReviewRun
                      │
                      ▼
              ┌──────────────┐
              │   Execute    │  review/execute.ts
              └──────┬───────┘
                     │
               ┌─────┴─────┐
               ▼           ▼
              git        Claude
               │           │
               └─────┬─────┘
                     ▼
                   GitHub
```

## Invariants

0. **`completed` means Claude exited successfully — not that a review was posted.** The skill owns posting, so that is the strongest fact available, and Engwire does not go looking on GitHub for a stronger one.
1. **Every GitHub review-request event is acted on at most once.** `UNIQUE(event_id)` in the database, not care taken by the caller. Nothing is ever retried, because the review posts to GitHub and Engwire cannot tell what has already been said.
2. **Every review runs against a pinned revision: the latest Engwire observed on the successful poll immediately before the run was claimed.** A queued run follows the pull request's head until it starts, then freezes. Pinning at the last possible moment is what makes the pin worth having — the queue is serial and a review can take twenty minutes, so a run scheduled hours earlier would otherwise comment on code the author has since replaced. It is not "the head at the instant of claiming": an author can push between the poll and the claim, and closing that window would mean another GitHub read at execution for no practical gain. Worktrees are detached checkouts at that exact SHA.
3. **A review is governed by your Claude Code configuration, never the branch under review.** `claude --setting-sources user`. The behaviour was established by experiment against a specific version; `doctor` checks that the flag the boundary depends on is still there.
4. **An agent is only ever started on a branch from the base repository.** Fork pull requests are dismissed.
5. **Engwire never operates in your checkouts.** It clones its own copy of every repository.

## Modules

| Module | Owns |
| --- | --- |
| `cli/` | Command dispatch, and one file per command that needs more than a call |
| `config/` | `config.toml` and where files live |
| `github/` | The only place `gh` is invoked; turns GitHub into `ReviewRequest[]` |
| `review/reconcile.ts` | Every scheduling decision. Pure |
| `review/loop.ts` | Poll, record, execute, reap. The imperative shell |
| `review/execute.ts` | One review, start to finish |
| `git/` | The only place `git` is invoked; bare clones and worktrees |
| `claude/` | The only place `claude` is invoked |
| `store/` | SQLite: one table of runs, plus `meta` for the watermark and the current runner |
| `service/` | The launchd agent, and the single-runner lock |

Process spawning stays at the edges. There is no shared `exec` helper: `gh`, `git` and `claude` want different things from a subprocess, and a common wrapper would grow until it had reimplemented a process library. For the same reason there is no platform-neutral service interface above `launchd.ts` — one implementation does not need an abstraction over it, and `cli/service.ts` makes the macOS check itself.

## Decisions

**Agent support is an execution contract, not a list of brands.** Engwire intends to support Claude Code, Codex and Grok Build. Claude Code is supported today; Codex and Grok Build are planned until their adapters satisfy the same boundary as the current implementation.

A supported adapter must run unattended in the pinned worktree; receive the repository, pull request and SHA in its review instruction; prevent repository-controlled configuration from silently widening its authority; use the GitHub identity and repository Engwire selected; expose no relative executable search path; capture a transcript and an unambiguous exit result; and stop its ordinary descendant process tree on exit, timeout or runner shutdown. `doctor` verifies the CLI surface Engwire depends on, automated tests cover the boundary Engwire controls, and versioned experiments record CLI behaviour that requires a live agent. Provider support is therefore earned per CLI integration, not implied by access to one of its models.

**A review request is identified by its GitHub timeline event, not by `(repo, pull, sha)`.** `requested_reviewers` is state — GitHub clears you from it the moment you submit a review — so it cannot express "they asked again." The timeline's `review_requested` events can, each with its own id. Identifying a request by revision would swallow a genuine second ask, and a second ask is not a retry.

**The revision comes from the pull request, not the event.** GitHub leaves `commit_id` null on `review_requested` events — verified against live timelines, not assumed — so there is no revision on the event to read. Every successful poll refreshes a queued run from the pull request's current head; claiming the run freezes the latest head observed. That is also the revision the reviewer would see on opening the pull request at that poll.

**Claude loads only the reviewer's settings.** `claude --setting-sources user`. The working directory is a pull request, and Claude Code otherwise reads `.claude/settings.json`, project hooks, project skills, `.mcp.json` and `CLAUDE.md` from wherever it starts — while `-p` does not stop to ask whether that directory is trusted. A contributor could therefore ship configuration that executes on the reviewer's machine.

Whether the flag covers *all* of that, rather than only the settings file, is the difference between a claim and a slogan, so it was tested rather than reasoned about. Against Claude Code 2.1.251, in a checkout carrying all four, plain `claude -p` loaded the memory file and the skill and ran a `SessionStart` hook, and discovered the `.mcp.json` server (held for approval); `--setting-sources user` loaded none of them and ran no hook. Since that is the CLI's behaviour and not Engwire's, `doctor` fails when the installed `claude` no longer accepts the flag. That is an interface check, not a repeat of the experiment — it catches the flag disappearing, not its meaning changing. There is deliberately no opt-out for trusted repositories.

**Fork pull requests are dismissed.** `repos` matches the base repository, which is the one the reviewer chose to trust; the branch can come from anyone. Since the next thing Engwire does is start an agent on that branch's contents, the two have to be distinguished, and a `skip_drafts`-style boolean would put the decision in the wrong place. If external review is ever wanted it needs a design, not a flag.

**The skill is told the revision, and cannot be made to honour it.** The worktree is pinned to the SHA Engwire accepted, and the prompt names it — but the skill posts through `gh`, so a skill that asks GitHub for the diff sees whatever is current. Engwire hands over a pinned checkout and a SHA; it deliberately does not own the posting side effect, and so cannot guarantee which revision a review ends up attached to. The invariant is worded for what the boundary can enforce.

**Once a review starts, it finishes.** A newer request replaces an older *queued* one; a running one is left alone. Cancelling would mean killing Claude and deleting the directory it is working in, with no way to know whether it had already posted — and a redundant review is a smaller harm than a truncated one. That also removes a status race, a process tree to tear down, and a half-killed skill still writing to GitHub.

**An interrupted run is terminal.** If the runner dies mid-review, the run is recorded as `interrupted` and never retried. Engwire does not control the idempotency of `claude → gh → GitHub`, so a retry could post a second review of the same pull request. Re-requesting the review on GitHub creates a new event, and a new run.

**One review at a time, not configurable.** Two concurrent reviews of the same repository would race over one bare clone — creating it, fetching into it, adding worktrees to it. This is a background process on a laptop; throughput was never the point, and per-repository serialisation is what a higher number would need first.

**Reconcile decides what should exist; the loop decides how much runs at once.** Withholding a decision for lack of capacity would leave it unrecorded, so the next poll would rediscover it and queue order would depend on polling luck. Concurrency is an execution concern.

**One installation, one GitHub identity.** The queue is a list of decisions made on one person's behalf, and no run row names them — so an installation records the account of its first runner and refuses to start under another. `doctor` reports the same mismatch, and `service install` therefore refuses too: approving a service the runner is certain to reject would be the opposite of a preflight. Otherwise `gh auth switch` plus a restart would execute work accepted as Alice and post it as Bob. A second account is a second `ENGWIRE_HOME`.

**Identity is checked before discovery and before every claim, never after either.** `gh auth switch` can also move the account while the runner is up. `--review-requested=@me` means whichever account `gh` is using *now*, while the timeline filter uses the one the runner started with — so polling under a switched account would search someone else's pull requests and could persist an old request of the reviewer's found in one of their timelines. And claiming moves a row to `running` while `failed` is terminal, so a check after the claim would let a GitHub outage permanently consume a review that never started. Checked first, an outage just leaves the work queued for the next tick — which is what "a GitHub failure is survivable" has to mean for work already discovered, not only for discovery.

**One poll's decisions are applied atomically.** Enqueueing a newer request and superseding the queued run it replaces are one answer written twice, and reconciliation emits them in that order. A crash in between would leave both queued — and no later poll could repair it, because the newer event is recorded by then and never looks fresh again. `Store.transaction` is the whole of the fix; log lines are emitted after the commit, since a log line is a claim that something happened.

**Nothing in the agent's search path is relative to the pull request.** Claude's working directory is a checkout of the branch under review, so a relative `PATH` entry — `.`, a bare `tools`, or the empty string a leading or trailing `:` produces — is a directory the contributor controls, and a skill running `gh` by name would find their file. Measured against a real shell, all four forms execute from the checkout. The agent's `PATH` is therefore filtered to absolute entries, and a relative `gh_bin` is refused at parse time. This is the executable half of the boundary `--setting-sources user` draws for configuration.

**Rows are never deleted.** A run row is a few hundred bytes. Keeping them forever is what makes the unique-event-id invariant durable, and it makes "why didn't you review my PR?" answerable — dismissals are recorded with their reason.

**Watching begins at authorization, not installation.** `setup` writes a config and checks prerequisites; it does not start the clock. The first runner to start with a `[[review]]` rule configured does. Installing Engwire authorizes nothing — naming a repository is what permits an agent to run on someone's branch — so that is the moment the watermark belongs to, and it is what makes the next decision true rather than aspirational.

**A draft is held, not dismissed — the one request deliberately left unrecorded.** Marking a draft ready does not re-request the reviewers it already had. Measured against live timelines: of ten reviewers requested while a pull request was a draft, eight received no fresh `review_requested` event when it became ready — the events that do fire are for code owners and newly added reviewers. Recording a dismissal would therefore consume the only event Engwire is ever going to see, and the review would be dropped in silence, which is the worst failure this product has. Leaving it unrecorded only repeats the timeline read discovery already performs each poll; the request waits until the pull request is ready, is withdrawn, or closes. A held request still supersedes an older queued run for the same pull request — that run is answering a question this one replaced, and letting it proceed would review the pull request now and again once it is ready.

**A queued run may start only on positive, current evidence that it is still wanted.** Being in the queue is not that evidence: it records what was true when the decision was made. Three things follow.

Losing repository authorization revokes a queued run outright, because that is a permanent withdrawal of permission. But a pull request that has gone back to draft, or has vanished from discovery altogether, cannot be dismissed the same way — the request is already recorded, and GitHub may never re-request the reviewer, so consuming it would lose the review for good. Such a run is *held*: the one decision with no durable effect, saying only that this row is ineligible this cycle and will be reconsidered next poll. `skip_drafts` therefore means "do not run an agent on a draft", not "the draft state at the moment we happened to schedule it".

Discovery returns open pull requests that currently request this reviewer, so a queued run whose pull request is absent from a poll has had its request withdrawn, been closed, or already been reviewed by hand. Every reading says do not start it — and it may also be nothing worse than GitHub's search index lagging, which is why absence holds rather than dismisses. The cost of a held run is a poll of delay; the cost of a wrong one is a review nobody asked for. This does mean a genuinely abandoned request stays queued and inert rather than becoming terminal, which is the price of not inventing certainty the search result cannot give.

Evidence is per cycle, not carried forward. A poll that fails claims nothing at all — keeping the previous cycle's answer would stop an outage promoting work judged ineligible, but would still let work last seen as eligible start long after that observation stopped being current, and those are the same mistake in opposite directions. Compared with a review that can run for twenty minutes, waiting for the next poll is the smaller cost; starting on stale evidence risks an unwanted review. This also subsumes any "has this process ever polled" rule: a restart simply has no successful cycle yet.

**The other reasons to pass are permanent, for three different reasons.** `fork` cannot stop being true of a pull request. `superseded_by_newer` cannot stop being true once a later request exists. `no_automation` *can* — configuration changes — and stays recorded anyway, by policy: adding a rule should not resurrect an old request and produce a surprise review of a month-old pull request. Only draft is non-sticky, because readiness is expected lifecycle progression rather than a change of mind.

**Dismissals are permanent, and that is the whole of the guarantee.** A request Engwire has recorded — as `no_automation`, as a fork — stays recorded, and adding a rule does not reconsider it. What it does *not* promise is that a rule only ever sees the future: a request made after the watermark while the runner happened to be stopped was never recorded, so adding a rule later can pick it up if it is still outstanding. Per-rule activation timestamps would close that, at the cost of rule identity, wildcards, ordering and persistence — none of which v0 has earned. A surprise review of a month-old pull request is worse than a missed one you can re-request. This is also why `engwire run` refuses to start with no rules configured: it would otherwise dismiss every outstanding request on its first poll.

**The runner lock is a SQLite transaction, not a lock file.** A lock file needs a protocol for the crashed holder — read the pid, decide it is dead, delete the file, take it — and every version of that protocol races: two runners can agree a lock is stale, and the second can delete the one the first just took. A held `BEGIN IMMEDIATE` has no stale case. The kernel owns it and releases it when the process dies, so crash recovery needs no pid liveness check at all: anything still marked `running` at startup belongs to a process that is gone. `bun:sqlite` was already a dependency.

**`status` reads the lock for liveness and the database for detail.** Which pid is running is a row in `meta`, written after the lock is taken. It is only ever displayed when the lock is actually held, so a row left behind by a crash is never shown.

**The queue is ordered by GitHub's event time.** One poll discovers a batch of requests and writes them within the same millisecond, so a local timestamp cannot order them. `requested_at` can, and it is the order the reviewer was actually asked in. Those timestamps resolve only to the second, so the tie-break compares event ids as the integers GitHub sends — lexicographically, `"9"` sorts after `"10"`.

**The configured `gh` is the one the skill gets.** An absolute `gh_bin` has its directory prepended to the agent's `PATH`; a bare `"gh"` is already resolved through it. `gh_bin` exists precisely so it can name a binary `PATH` does not reach, and the skill posts by running `gh` by name; without this, discovery and cloning would work and the review would fail at the last step.

**A runner waits for GitHub rather than exiting, but records itself first.** Inside the loop an outage is a logged tick, so it should not be fatal ten lines earlier — a laptop that boots offline would otherwise be restarted by launchd into the same wall until it throttled. The watermark, the runner row and crash recovery are all written *before* that wait, because none of them needs GitHub: otherwise a runner that booted offline would begin watching whenever the network happened to return, losing every request made in between.

**A failed `gh` invocation is survivable; local failures are not.** The poll's catch is typed on `GhError`, which means exactly "the `gh` command exited non-zero" — an outage, a rate limit, an expired token. Retrying all of those is a reasonable daemon policy and needs no taxonomy built out of stderr strings. A failed SQLite write or a bug in reconciliation is a different kind of thing, and logging it once a minute forever would keep a broken runner alive and quiet, so it takes the runner down. The same rule holds inside cleanup: a checkout that will not delete is retried, a database that has stopped working is not caught. Since `executeRun` handles expected checkout and agent failures, a rejection escaping it means the runner is broken and is rethrown rather than filed as one more failed review.

**The reaper runs only while nothing is being reviewed.** Reclaiming a checkout runs `git worktree prune` against a bare clone that a starting review is about to fetch into. "One review at a time" is about one git mutator at a time, so cleanup waits for an idle tick; retaining a checkout for one more poll interval is safer than racing those mutations.

**Discovery is serial across pull requests.** Fanning fifty search results out at once would put a hundred `gh` subprocesses and API calls in flight from a laptop. The two calls for one pull request still overlap; at the scale this sees, nothing else is worth the rate limit risk.

**Invalid configuration is an error, including keys nobody reads.** `skip_draft = false` and `poll_intervall = "10s"` both look like they work. A config file is read once, in the dark, by a background process. There is no `claude_args` passthrough for the same reason: it would make every future Claude CLI flag an Engwire feature, including the ones that undo the isolation above.

**`service install` refuses a setup that would not run, judged in launchd's environment.** launchd relaunches what it supervises, and `engwire run` exits on a missing config or an unauthenticated `gh` — so installing over a broken setup buys a start/stop loop until launchd throttles it. The preflight is `doctor`, run against the environment the plist actually provides rather than the installing shell's: `gh` and `claude` both prefer environment credentials to stored ones, so a `GH_TOKEN` exported in a terminal would otherwise approve exactly the setup that is about to fail. Those variables are deliberately not copied into the plist — background review needs authentication that outlives a shell. Reinstalling is how a running service picks up an edited config; there is no reload.

**launchd is told how long a review takes.** `ExitTimeOut` defaults to a system-defined value, so stopping the service mid-review could SIGKILL Claude partway through posting — undoing "once a review starts, it finishes" from the outside. The plist carries `run_timeout` plus a grace period.

**The credential helper is rewritten on every use of a clone.** It embeds an absolute `gh` path, and `gh` moves; a clone made months ago would otherwise keep invoking a binary that is gone while `doctor` reports the new one as healthy.

**The run's boundary is a process group, not a process.** A review is `claude` plus every tool it starts, so `runClaude` spawns it detached and signals the group — on timeout, and again once the agent exits, because a leaked tool can still call `gh`. Without this the run row would mean "Engwire stopped waiting" while the review it describes was still able to post, and "one review at a time" would be false. The cost is that Ctrl-C no longer reaches the agent through the terminal, so the runner forwards its own SIGINT and SIGTERM down and then waits on the same terms as a timeout: re-raising immediately would leave a tool that ignores SIGTERM running with nothing left to escalate against it. The group is where ordinary leakage stops, not a sandbox — a descendant that calls `setsid` is outside it, and `--setting-sources user` plus the skill's `allowed-tools` are what actually bound an agent.

**Hard authorization is declarative; probabilistic reasoning happens only where it cannot widen the scope it runs in.** A rule is what permits an agent to check out and read someone else's branch, so it is decided by a pure function before Claude starts.

The tempting justification — that the material being governed must never take part in the decision about it — proves too much. Spam filters, malware scanners and static analysers all read untrusted input to decide what happens to it, and Engwire's own review skill reads the diff. The line that actually holds is about authority, not about who reads what. The skill may be prose because by the time it runs the repository is already authorized, and nothing it concludes can add a repository to the set Engwire may enter. A model asked at review time whether a review may run would sit above that line.

Today that would buy nothing anyone has asked for, while costing reproducibility, tests over plain objects, independence from model versions, and a definite answer to "why did Engwire run here?" A model may one day help *author* a policy — proposing typed rules a person approves — but what it emits is still this file, and `parseConfig` is still the authority. Humans or a model may write the policy; only deterministic code interprets it.

**A config predicate has to be mechanically decidable before the review agent starts.** The test for adding a field: can Engwire settle it from bounded, side-effect-free facts, without asking a model what anything means? The changed file list, an author's login and the base branch pass. "Is this change security-sensitive?" does not — that needs semantic judgment, the repository is already authorized by the time anything could read the code, and the skill is where a model already reads the diff. Routing by what a change *means* belongs in the skill's prose, not in a second classifier standing in front of it.

What the test turns on is mechanics, not provenance. Changed paths come from the contributor's own change and are still perfectly usable, because fetching a file list is not the same act as starting an agent with tools inside the checkout. Without the test every support request becomes a field, until the file has accidentally reimplemented workflow `if:` expressions.

**Until it is claimed, a queued run is live; after, it is frozen.** Everything the run will execute — repository authorization, draft eligibility, the revision, the skill — is re-derived from the current configuration and the current pull request on every poll. Losing authorization revokes it, a draft holds it, a push retargets it, and a rule that now names a different skill changes which skill it will use. Claiming ends that: the SHA and skill are fixed, and the review finishes without cancellation. Splitting it this way avoids the confusing middle ground where some queued properties are live and others are snapshots of when the row happened to be written.

Withdrawing the *GitHub* review request does not cancel a queued run either, but it does stop it starting: the run is held for as long as the pull request no longer appears among those requesting this reviewer. Cancelling outright would need certainty the candidate search cannot supply — it clears the same state when you submit a review by hand — so the run stays recorded and inert instead.

**Polling sees what is still being asked when it looks.** Discovery starts from the pull requests that currently request the reviewer, then reads their timelines. A request made and withdrawn — or answered by someone else — entirely between two polls is never observed at all. Exact event capture would need a webhook, and therefore a relay with access to the code, which is the one thing this design exists to avoid.

**Shutdown does not start work.** `runLoop` re-checks the abort signal after polling and again before sleeping, because a poll takes seconds and the review it would start can take twenty minutes. Without that, `service install` — which stops the old service first — could begin a review launchd is already counting down to SIGKILL.

**The repository is pinned, not validated.** `GH_HOST` is set for every `gh` Engwire runs and, with `GH_REPO`, for Claude — so a skill that posts with a plain `gh pr review 42` posts to the repository the checkout came from. `gh` reads both from the environment before it infers anything, and clone URLs are `https://github.com/...` unconditionally: left ambient, they could send the review to `acme/api` on an enterprise host, or to whatever the reviewer's shell last exported. A skill that names a repository itself still wins; this only fixes the default. Setting the variables is a smaller thing to reason about than checking every caller's environment.

**Absolute paths for `gh` and `claude`.** launchd gives an agent a minimal `PATH`, so a Homebrew `gh` and a `~/.local/bin/claude` are both invisible to it. `engwire setup` records absolute paths and the plist carries the installing shell's `PATH`.

## Not built yet

A localhost UI, a self-updater, Linux and Windows service adapters, npm distribution, release checksums, per-repository concurrency, reviewing fork pull requests, cancelling a queued run when its GitHub review request is withdrawn, retention for run transcripts and the launchd log, and team review requests. If a `paths` predicate is ever added it should be named for what it does — `changed_paths`, matching a rule when the pull request changes a matching file — because it selects which requests trigger a rule and does not narrow what the agent may read; the repository stays the access boundary. One hard line: nothing probabilistic may ever widen the authorization envelope — a model cannot add a repository an agent may enter. Short of that, a predicate DSL, Boolean `when` expressions, and semantic conditions a model has to interpret are out of scope until a demonstrated need is worth losing deterministic routing for. That is a product judgement, not a law; it is recorded so the next person changing it knows which part is which. Each deferred item has a place to go — `src/server/` beside `review/`, `service/systemd.ts` beside `launchd.ts` — and none is stubbed out in advance.
