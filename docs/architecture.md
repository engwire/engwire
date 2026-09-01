# Architecture

Engwire Runner watches GitHub for review requests addressed to you, checks out a pinned revision, and hands it to your Claude Code review skill. It runs on your laptop, with your `gh` and your Claude subscription. No Engwire server is involved, and no additional service is granted repository access.

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
1. **Every GitHub review-request event produces one durable run and at most one agent invocation.** `UNIQUE(event_id)` in the database, not care taken by the caller. An agent invocation is never retried, because the review posts to GitHub and Engwire cannot tell what has already been said; a claim released before the agent starts has posted nothing, and returns to the queue.
2. **Every review runs against a pinned revision: the latest Engwire observed on the successful poll immediately before the claim that reached the agent.** A queued run follows the pull request's head; claiming snapshots it for that attempt. If the claim reaches the agent, that is the revision reviewed — polling continues while a review is in flight, and none of it moves a target already claimed. If the claim is released before the agent starts, the run returns to the live queue and a later poll may retarget it. Pinning at the last possible poll is what makes the pin worth having — the queue is serial and a review can take twenty minutes, so a run scheduled hours earlier would otherwise comment on code the author has since replaced. It is not "the head at the instant the agent starts": an author can push after the poll, and closing that window would mean another GitHub read at execution for no practical gain. Worktrees are detached checkouts at that exact SHA.
3. **A review is governed by your Claude Code configuration, never the branch under review.** `claude --setting-sources user`. The behaviour was established by experiment against a specific version; `doctor` checks that the flag the boundary depends on is still there.
4. **An agent is only ever started on a branch from the base repository.** Fork pull requests are dismissed.
5. **Engwire never operates in your checkouts.** It clones its own copy of every repository.
6. **A skill passes a preflight immediately before its run is claimed, and again immediately before its agent starts.** Engwire found the rule's `SKILL.md` readable, did not recognize its folder name as reserved, and found its front matter either silent about invocation or using a measured invocable value. This is a recent filesystem observation, not a guarantee that Claude will run the skill. A failure holds only the runs that name that skill, and after the claim it gives the claim and its checkout back rather than spending them. A queued row with no skill at all is the store contradicting itself; it is claimed and then refused by `executeRun`, which is where a malformed row belongs rather than in a check about skills.

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

**Agent support is an execution contract, not a model name.** Claude Code is the supported adapter. Access to another provider's models would not make its CLI supported without the same execution guarantees.

A supported adapter must run unattended in the pinned worktree; receive the repository, pull request and SHA in its review instruction; prevent repository-controlled configuration from silently widening its authority; use the GitHub identity and repository Engwire selected; expose no relative executable search path; capture a transcript and an unambiguous exit result; and stop its ordinary descendant process tree on exit, timeout or runner shutdown. `doctor` verifies the CLI surface Engwire depends on, automated tests cover the boundary Engwire controls, and versioned experiments record CLI behaviour that requires a live agent. Provider support is therefore earned per CLI integration, not implied by access to one of its models.

**A review request is identified by its GitHub timeline event, not by `(repo, pull, sha)`.** `requested_reviewers` is state — GitHub clears you from it the moment you submit a review — so it cannot express "they asked again." The timeline's `review_requested` events can, each with its own id. Identifying a request by revision would swallow a genuine second ask, and a second ask is not a retry.

**The revision comes from the pull request, not the event.** GitHub leaves `commit_id` null on `review_requested` events — verified against live timelines, not assumed — so there is no revision on the event to read. Every successful poll refreshes a queued run from the pull request's current head. Claiming snapshots the latest head observed for that attempt; a claim released before the agent starts returns to the live queue, where a later poll may refresh it again. That is also the revision the reviewer would see on opening the pull request at that poll.

**Claude loads only the reviewer's settings.** `claude --setting-sources user`. The working directory is a pull request, and Claude Code otherwise reads `.claude/settings.json`, project hooks, project skills, `.mcp.json` and `CLAUDE.md` from wherever it starts — while `-p` does not stop to ask whether that directory is trusted. A contributor could therefore ship configuration that executes on the reviewer's machine.

Whether the flag covers *all* of that, rather than only the settings file, is the difference between a claim and a slogan, so it was tested rather than reasoned about. Against Claude Code 2.1.251, in a checkout carrying all four, plain `claude -p` loaded the memory file and the skill and ran a `SessionStart` hook, and discovered the `.mcp.json` server (held for approval); `--setting-sources user` loaded none of them and ran no hook. Since that is the CLI's behaviour and not Engwire's, `doctor` fails when the installed `claude` no longer accepts the flag. That is an interface check, not a repeat of the experiment — it catches the flag disappearing, not its meaning changing. There is deliberately no opt-out for trusted repositories.

**Fork pull requests are dismissed.** `repos` matches the base repository, which is the one the reviewer chose to trust; the branch can come from anyone. Since the next thing Engwire does is start an agent on that branch's contents, the two have to be distinguished, and a `skip_drafts`-style boolean would put the decision in the wrong place. If external review is ever wanted it needs a design, not a flag.

**Engwire ships no review skill, and holds rather than reviewing without one.** What a review reads, says and posts belongs to a Markdown skill the reviewer owns and can improve without a new Engwire binary. Bundling or generating a default would make Engwire responsible for the review's quality, permissions and posting behaviour while disguising that ownership as user configuration.

Claude Code 2.1.251 was measured with the production invocation because a missing `SKILL.md`, a non-invocable skill, the reserved folder name `synced`, and a skill disabled through `skillOverrides` all exit 0 without performing a review. Without a preflight, Engwire would record those invocations as `completed` and consume an event GitHub will not send again.

The preflight checks only what Engwire can establish from the named skill: its folder name, a readable `SKILL.md`, and whether its front matter leaves it invocable. Claude treats only `true`, `1`, `yes` and `on` (case-insensitively, optionally double-quoted) as true for `user-invocable`; other values and duplicate declarations fail closed. `skillOverrides` remains outside the check because interpreting Claude's settings would duplicate another product's configuration model. Reading Claude's diagnostic output would instead make an unversioned message part of Engwire's correctness boundary, while requiring a success marker would impose a protocol on existing skills.

The first check is immediately before the claim so a known-broken skill does not trigger checkout preparation. The second is immediately before the agent starts because preparing the checkout can clone a repository — minutes of network between an observation and the thing that depends on it. Identity is re-established first there, since it awaits and would otherwise leave the skill observation stale again. Either failure releases the claim back to `queued`: nothing has run and nothing has posted, so the request is still outstanding. The checkout is released with it, since a checkout with no deadline is invisible to the reaper and a directory of private source should not outlive a rule nobody fixes; the bare clone is what makes the next attempt cheap. `setup` lists installed skills, `doctor` diagnoses every configured skill, `run --once` exits non-zero for a failed preflight, and the daemon holds affected runs while continuing to poll. The check is per queued run, so one broken rule does not stop unrelated repositories.

**A cycle is one poll and at most one review.** Draining a backlog after one poll could claim later work from evidence that became stale during an earlier review. The foreground command and daemon therefore use the same cycle: poll, recheck the GitHub account, preflight the next claimable skill, and run at most one review. A backlog receives fresh eligibility evidence before each claim.

**The skill is told the revision, and cannot be made to honour it.** The worktree is pinned to the SHA Engwire accepted, and the prompt names it — but the skill posts through `gh`, so a skill that asks GitHub for the diff sees whatever is current. Engwire hands over a pinned checkout and a SHA; it deliberately does not own the posting side effect, and so cannot guarantee which revision a review ends up attached to. The invariant is worded for what the boundary can enforce.

**Scheduling never cancels a running review.** A newer request replaces an older *queued* one; a running one is left alone. Cancelling in response to GitHub or configuration changes would mean killing Claude with no way to know whether it had already posted, and a redundant review is a smaller harm than a truncated one. Timeouts and runner shutdown still terminate the review through its process-group boundary.

**Shutdown starts no new work and orphans no current work.** The signal is checked after every awaited step before the agent, including checkout preparation and the final identity check; a claim that has not reached Claude is released. If a review is already running, the runner forwards the signal to its process group, waits through the cleanup grace period, and then re-raises the signal. launchd's shutdown timeout is longer than Engwire's review timeout and cleanup allowance so the supervisor does not cut that sequence short.

**An interrupted run is terminal.** If the runner dies mid-review, the run is recorded as `interrupted` and never retried. Engwire does not control the idempotency of `claude → gh → GitHub`, so a retry could post a second review of the same pull request. Re-requesting the review on GitHub creates a new event, and a new run.

**One review at a time, not configurable.** Two concurrent reviews of the same repository would race over one bare clone — creating it, fetching into it, adding worktrees to it. This is a background process on a laptop; throughput was never the point, and per-repository serialisation is what a higher number would need first.

**One installation, one GitHub identity.** The queue is a list of decisions made on one person's behalf, and no run row names them — so an installation records the account of its first runner and refuses to start under another. `doctor` reports the same mismatch, and `service install` therefore refuses too: approving a service the runner is certain to reject would be the opposite of a preflight. Otherwise `gh auth switch` plus a restart would execute work accepted as Alice and post it as Bob. A second account is a second `ENGWIRE_HOME`.

**The runner lock is a held SQLite transaction, not a lock file.** The kernel releases it when the process dies, so there is no stale-file protocol or PID-reuse race. With one runner per installation, every row still marked `running` at startup belonged to the dead lock holder and can be marked `interrupted`.

**Identity is checked before discovery, before every claim, and once more before the agent starts.** `gh auth switch` can also move the account while the runner is up. `--review-requested=@me` means whichever account `gh` is using *now*, while the timeline filter uses the one the runner started with — so polling under a switched account would search someone else's pull requests and could persist an old request of the reviewer's found in one of their timelines. An outage before the claim leaves the work queued and avoids preparing a checkout for a review that cannot safely start. The third check closes the longer window opened by checkout preparation: a first clone can take minutes, during which a switched account would make the skill post in somebody else's name. Since the agent has not started, that late failure can give the claim back rather than spend it.

**No program Engwire runs is ever found relative to a working directory.** A relative `PATH` entry — `.`, a bare `tools`, or the empty string a leading or trailing `:` produces — names a directory relative to the process's own cwd, and measured against a real shell all four forms execute from it. For the agent that directory is a checkout of the branch under review, so a skill running `gh` by name would find the contributor's file; but the runner's cwd is wherever the reviewer typed the command, which can be that same checkout — so `git` while a checkout is prepared, a bare `gh_bin` during discovery, and the binaries `setup` records permanently into `config.toml` need the property too. `absolutePath` is the single definition, applied at every point a program is resolved or spawned — `launchctl` excepted, as a component of macOS rather than a dependency anyone chooses, named absolutely instead; `Bun.spawn` resolves a bare command through the `PATH` it is handed, which is what makes passing it a fix rather than a tidy-up. A relative `gh_bin` is refused at parse time. This is the executable half of the boundary `--setting-sources user` draws for configuration.

**Watching begins at authorization, not installation.** `setup` writes a config and checks prerequisites; it does not start the clock. The first runner to start with a `[[review]]` rule configured does. Installing Engwire authorizes nothing — naming a repository is what permits an agent to run on someone's branch — so that is the moment the watermark belongs to, and it is what makes the next decision true rather than aspirational.

**A draft is held, not dismissed — the one request deliberately left unrecorded.** Marking a draft ready does not re-request the reviewers it already had. Measured against live timelines: of ten reviewers requested while a pull request was a draft, eight received no fresh `review_requested` event when it became ready — the events that do fire are for code owners and newly added reviewers. Recording a dismissal would therefore consume the only event Engwire is ever going to see, and the review would be dropped in silence, which is the worst failure this product has. Leaving it unrecorded only repeats the timeline read discovery already performs each poll; the request waits until the pull request is ready, is withdrawn, or closes. A held request still supersedes an older queued run for the same pull request — that run is answering a question this one replaced, and letting it proceed would review the pull request now and again once it is ready.

**A queued run may start only on positive, current evidence that it is still wanted.** Being in the queue is not that evidence: it records what was true when the decision was made. Three things follow.

Losing repository authorization revokes a queued run outright, because that is a permanent withdrawal of permission. But a pull request that has gone back to draft, or has vanished from discovery altogether, cannot be dismissed the same way — the request is already recorded, and GitHub may never re-request the reviewer, so consuming it would lose the review for good. Such a run is *held*: the one decision with no durable effect, saying only that this row is ineligible this cycle and will be reconsidered next poll. `skip_drafts` therefore means "do not run an agent on a draft", not "the draft state at the moment we happened to schedule it".

Discovery returns open pull requests that currently request this reviewer, so a queued run whose pull request is absent from a poll has had its request withdrawn, been closed, or already been reviewed by hand. Every reading says do not start it — and it may also be nothing worse than GitHub's search index lagging, which is why absence holds rather than dismisses. The cost of a held run is a poll of delay; the cost of a wrong one is a review nobody asked for. This does mean a genuinely abandoned request stays queued and inert rather than becoming terminal, which is the price of not inventing certainty the search result cannot give.

Evidence is per cycle, not carried forward. A poll that fails claims nothing at all — keeping the previous cycle's answer would stop an outage promoting work judged ineligible, but would still let work last seen as eligible start long after that observation stopped being current, and those are the same mistake in opposite directions. Compared with a review that can run for twenty minutes, waiting for the next poll is the smaller cost; starting on stale evidence risks an unwanted review. This also subsumes any "has this process ever polled" rule: a restart simply has no successful cycle yet.

**The other reasons to pass are permanent, for three different reasons.** `fork` cannot stop being true of a pull request. `superseded_by_newer` cannot stop being true once a later request exists. `no_automation` *can* — configuration changes — and stays recorded anyway, by policy: adding a rule should not resurrect an old request and produce a surprise review of a month-old pull request. Only draft is non-sticky, because readiness is expected lifecycle progression rather than a change of mind.

**Dismissals are permanent, and that is the whole of the guarantee.** A request Engwire has recorded — as `no_automation`, as a fork — stays recorded, and adding a rule does not reconsider it. What it does *not* promise is that a rule only ever sees the future: a request made after the watermark while the runner happened to be stopped was never recorded, so adding a rule later can pick it up if it is still outstanding. Per-rule activation timestamps would close that, at the cost of rule identity, wildcards, ordering and persistence that the current policy does not need. A surprise review of a month-old pull request is worse than a missed one you can re-request. This is also why `engwire run` refuses to start with no rules configured: it would otherwise dismiss every outstanding request on its first poll.

**A failed `gh` invocation is survivable; local failures are not.** The poll's catch is typed on `GhError`, which means exactly "the `gh` command exited non-zero" — an outage, a rate limit, an expired token. Retrying all of those is a reasonable daemon policy and needs no taxonomy built out of stderr strings. A failed SQLite write or a bug in reconciliation is a different kind of thing, and logging it once a minute forever would keep a broken runner alive and quiet, so it takes the runner down. The same rule holds inside cleanup: a checkout that will not delete is retried, a database that has stopped working is not caught. Since `executeRun` handles expected checkout and agent failures, a rejection escaping it means the runner is broken and is rethrown rather than filed as one more failed review.

**There is no `claude_args` passthrough.** It would make every future Claude CLI flag an Engwire feature, including the ones that undo the isolation above. Configuration describes outcomes — which repositories, which skill — and never how the runner reaches them.

**`service install` refuses a setup that would not run, judged in launchd's environment.** Background failures are otherwise unattended: a missing config takes the runner down for launchd to restart, while unavailable GitHub leaves it waiting without reviewing anything. The preflight is `doctor`, run against the environment the plist actually provides rather than the installing shell's: `gh` and `claude` both prefer environment credentials to stored ones, so a `GH_TOKEN` exported in a terminal would otherwise approve exactly the setup that is about to fail. Those variables are deliberately not copied into the plist — background review needs authentication that outlives a shell. Reinstalling is how a running service picks up an edited config; there is no reload.

**The run's boundary is a process group, not a process.** A review is `claude` plus every tool it starts, so `runClaude` spawns it detached and signals the group — on timeout, and again once the agent exits, because a leaked tool can still call `gh`. Without this the run row would mean "Engwire stopped waiting" while the review it describes was still able to post, and "one review at a time" would be false. The cost is that Ctrl-C no longer reaches the agent through the terminal, so the runner forwards its own SIGINT and SIGTERM down and then waits on the same terms as a timeout: re-raising immediately would leave a tool that ignores SIGTERM running with nothing left to escalate against it. The group is where ordinary leakage stops, not a sandbox — a descendant that calls `setsid` is outside it, and `--setting-sources user` plus the skill's `allowed-tools` are what actually bound an agent.

**Hard authorization is declarative; probabilistic reasoning happens only where it cannot widen the scope it runs in.** A rule is what permits an agent to check out and read someone else's branch, so it is decided by a pure function before Claude starts.

The tempting justification — that the material being governed must never take part in the decision about it — proves too much. Spam filters, malware scanners and static analysers all read untrusted input to decide what happens to it, and Engwire's own review skill reads the diff. The line that actually holds is about authority, not about who reads what. The skill may be prose because by the time it runs the repository is already authorized, and nothing it concludes can add a repository to the set Engwire may enter. A model asked at review time whether a review may run would sit above that line.

Semantic authorization would cost reproducibility, tests over plain objects, independence from model versions, and a definite answer to "why did Engwire run here?" Policy authorship is separate from policy authority: however the file is produced, `parseConfig` remains its deterministic interpreter.

**A config predicate has to be mechanically decidable before the review agent starts.** The test for adding a field: can Engwire settle it from bounded, side-effect-free facts, without asking a model what anything means? The changed file list, an author's login and the base branch pass. "Is this change security-sensitive?" does not — that needs semantic judgment, the repository is already authorized by the time anything could read the code, and the skill is where a model already reads the diff. Routing by what a change *means* belongs in the skill's prose, not in a second classifier standing in front of it.

What the test turns on is mechanics, not provenance. Changed paths come from the contributor's own change and are still perfectly usable, because fetching a file list is not the same act as starting an agent with tools inside the checkout. Without the test every support request becomes a field, until the file has accidentally reimplemented workflow `if:` expressions.

**The claim snapshots what a run will execute; starting the agent makes that snapshot final.** Everything the run will execute — repository authorization, draft eligibility, the revision, the skill — is re-derived from the current configuration and the current pull request on every poll. Losing authorization revokes it, a draft holds it, a push retargets it, and a rule that now names a different skill changes which skill it will use. Claiming ends that: the SHA and skill are fixed for that attempt, and scheduling or configuration changes no longer retarget or cancel it once the agent starts. A claim released before the agent starts — the account or the skill having changed while the checkout was prepared — goes back to being live, and the next poll may retarget it like any other queued run. Splitting it this way avoids the confusing middle ground where some queued properties are live and others are snapshots of when the row happened to be written.

Withdrawing the *GitHub* review request does not cancel a queued run either, but it does stop it starting: the run is held for as long as the pull request no longer appears among those requesting this reviewer. Cancelling outright would need certainty the candidate search cannot supply — it clears the same state when you submit a review by hand — so the run stays recorded and inert instead.

**Polling sees what is still being asked when it looks.** Discovery starts from the pull requests that currently request the reviewer, then reads their timelines. A request made and withdrawn — or answered by someone else — entirely between two polls is never observed at all. Exact event capture would need a webhook, and therefore a relay with access to the code, which is the one thing this design exists to avoid.

**The repository is pinned, not validated.** `GH_HOST` is set for every `gh` Engwire runs and, with `GH_REPO`, for Claude — so a skill that posts with a plain `gh pr review 42` posts to the repository the checkout came from. `gh` reads both from the environment before it infers anything, and clone URLs are `https://github.com/...` unconditionally: left ambient, they could send the review to `acme/api` on an enterprise host, or to whatever the reviewer's shell last exported. A skill that names a repository itself still wins; this only fixes the default. Setting the variables is a smaller thing to reason about than checking every caller's environment.
