# Security

## What Engwire can reach

Engwire holds no credentials of its own. It invokes your authenticated `gh` and your Claude Code installation as subprocesses, so it can do exactly what you can do, and revoking its access means revoking theirs.

It listens on no port and accepts no inbound connection. Everything it does is outbound, initiated by its own polling.

## What runs in a worktree

A worktree contains a contributor's code. Engwire does not build it, install its dependencies, or execute it — it checks out a revision and starts Claude Code in that directory.

These guarantees are specific to each agent integration. Claude Code is the only supported agent today. Codex and Grok Build remain planned until their configuration and process boundaries have equivalent verification; their presence on the machine does not make Engwire use them.

Engwire starts Claude with `--setting-sources user`, so the session loads your settings, your hooks and your skills — not the ones checked into the branch. There is no way to turn this off.

This was measured, not assumed, against Claude Code 2.1.251. In a checkout carrying a project `CLAUDE.md`, a project skill, a project `.mcp.json` and a `SessionStart` hook, plain `claude -p` loaded the memory file and the skill and ran the hook; the `.mcp.json` server was discovered but held for approval. The same invocation with `--setting-sources user` loaded none of the four and the hook did not run. Because that is a property of the CLI rather than of Engwire, `engwire doctor` fails if the installed `claude` no longer accepts the flag.

Claude's `PATH` is filtered to absolute directories. Its working directory is the checkout, so any relative entry — `.`, a bare `tools`, or the empty field a leading or trailing `:` produces — would be a directory the contributor controls, and a skill running `gh` by name would find their file rather than yours. All four forms were confirmed to execute from the working directory before this was written. Configuration cannot reintroduce it: a relative `gh_bin` or `claude_bin` is a config error.

Pull requests from forks are skipped outright. A `[[review]]` rule names a base repository, and anyone can open a pull request into one — so matching a rule is not evidence that the branch's author is trusted, and the branch's contents are what an agent is about to read.

What that does *not* prevent is influence through the code itself. Claude reads the diff, and a pull request can attempt prompt injection in source, comments, or documentation. Engwire does not defend against this on the agent's behalf: the tools the agent may use are your Claude Code configuration, not Engwire's. Configure your review skill with the narrowest `allowed-tools` that lets it do its job, and remember that a branch in the base repository is only as trustworthy as the people who can push to it.

The review is a process group, and Engwire ends the group rather than the `claude` process alone — when the review times out, when the agent exits, and when the runner itself is stopped, which it does not finish doing until the review has stopped too. A tool that outlives the agent therefore does not outlive the run, which is what makes "one review at a time" true; measured rather than assumed, because without the group a grandchild reparents to init and goes on working.

This covers an ordinary tool tree, not a program determined to escape one: a descendant that calls `setsid` leaves the group and is beyond anything Engwire signals. Process groups are tidy-up, not a sandbox — `allowed-tools`, above, is the boundary that matters.

## What Engwire will not touch

Your own checkouts. Engwire clones every repository into its own data directory and builds worktrees there. It never runs a git command in a directory it did not create.

## Reporting

Report a vulnerability privately, either through [GitHub Security Advisories](https://github.com/engwire/engwire/security/advisories/new) on this repository or to <security@engwire.com> if you would rather not use GitHub. Please do not open a public issue.
