# Engwire

Reviews the pull requests that ask for your review — on your laptop, with your GitHub account, your Claude subscription, and your own review skill.

```text
Review requested from you
          ↓
   Engwire (your machine)
          ↓
  worktree at that revision
          ↓
   claude -p /review-pr
          ↓
   your skill posts as you
```

GitHub.com only — `GH_HOST` is pinned, so `gh` and the checkout can never disagree about which repository they mean. No new service receives your source code: Engwire drives the Git, `gh` and Claude Code already on your machine. No Engwire server, no bot account, no workflow to commit, no additional credential to your source.

One installation belongs to one GitHub account — the one authenticated when it first ran. Point `ENGWIRE_HOME` somewhere else for a second.

## Install

```sh
curl -fsSL https://engwire.com/install.sh | sh
engwire setup
```

You need [`gh`](https://cli.github.com) (authenticated), [Claude Code](https://claude.com/claude-code), and a user-level review skill. Engwire invokes the configured skill as `/<skill> <repo>#<number> at <sha>` but ships none of its own: what a review reads, says and posts remains the skill's responsibility.

`engwire doctor` reports skills that fail Engwire's preflight. The runner leaves their reviews queued instead of claiming work that Claude can already be shown not to run.

## Agents

| Agent | Status |
| --- | --- |
| Claude Code | Supported |
| Codex | Planned |
| Grok Build | Planned |

Planned agents are product direction, not compatibility promises. An agent becomes supported only after its unattended execution, configuration isolation, GitHub identity, process cleanup and transcript handling have been verified; `doctor` and automated tests guard the parts Engwire can check without a live account.

## Use

```sh
engwire run --once          # one poll, at most one review, then exit
engwire service install     # keep it running in the background (macOS)
engwire status              # what it is doing and what it last did
engwire doctor              # diagnose gh, claude and config
```

Background supervision is macOS-only for now. Linux binaries are published and `engwire run` works there; nothing supervises it yet.

## Configure

`~/.config/engwire/config.toml`:

```toml
[[review]]
repos = ["acme/payments"]
skill = "review-payments"

[[review]]
repos = ["acme/*"]
skill = "review-pr"
```

The first matching rule wins, so put the specific one first — and getting that backwards is an error, not a rule that never runs. `repos` accepts `owner/name`, `owner/*` or `*`, and nothing else; a pattern Engwire cannot read is an error too.

`engwire setup` writes the file with every rule commented out: Engwire starts an agent on a contributor's code, so which repositories that happens for is yours to choose, and `engwire run` refuses to start until you have.

A review request on a draft is held, not dropped: Engwire reviews it once the pull request is marked ready, without you having to ask again. A rule can opt in to reviewing drafts with `skip_drafts = false`.

Pull requests from forks are always skipped, with no way to allow them. A rule names the *base* repository, and anyone can open a pull request into it; matching a rule says the change is proposed somewhere you trust, not that it came from someone you trust.

Unknown keys are an error, not a default — `skip_draft = false` will not quietly leave drafts skipped.

Poll rate, retention and timeouts have defaults you should not have to think about. They live under `[advanced]` for the machine where one of them is wrong.

Engwire starts watching the first time a runner starts with a rule configured; nothing older is ever reviewed. Anything it has already looked at and passed over stays passed over. It does not promise the reverse, though: a request that arrived after that point while the runner was stopped was never recorded, so adding a rule later can pick it up if it is still outstanding.

It polls, so it sees what is still asking for your review when it looks. A request made and withdrawn between two polls may never be seen at all — and a review already queued will not start once the request stops appearing, so withdrawing it, closing the pull request, or reviewing it yourself is enough to stop one that has not begun.

## How it works

Engwire polls GitHub for `review_requested` timeline events naming you. Each event has its own identity, so re-requesting a review of an unchanged commit gets you a second review, because you meant it — though several unseen asks for the same pull request found in one poll are collapsed to the newest, and the rest recorded as superseded. For each accepted request it prepares a detached worktree from its own clone at the latest head seen on the successful poll immediately before the review starts, and runs Claude Code there. Your skill reads the code and posts the review through `gh`. The checkout is kept for a day by default so you can see what Claude saw, then removed.

Claude runs with `--setting-sources user`, so the review is governed by *your* configuration and *your* skill — never by a `.claude/` directory, `CLAUDE.md` or `.mcp.json` the pull request brought with it. `engwire doctor` checks that your Claude Code still supports the flag.

The skill is invoked as `/review-pr acme/api#42 at <sha>`. The checkout is pinned to that revision; if your skill asks GitHub for the diff instead, it sees whatever is current — so treat the checkout and the SHA you were given as authoritative.

Engwire never touches your own checkouts.

See [docs/architecture.md](docs/architecture.md) for the design and [SECURITY.md](SECURITY.md) for the trust model — including what it means to point an agent at a contributor's code.

## Develop

```sh
bun install
bun test          # pure scheduling, real git, real SQLite, fixture gh and claude
bun typecheck
bun run build     # cross-compiled binaries in dist/
```

The scheduling logic in `src/review/reconcile.ts` is pure, and every way this tool could embarrass you — a duplicate review, a review of a replaced revision, a review nobody asked for — is a test over plain objects in `reconcile.test.ts`.

## Support

Bugs and feature requests belong in [GitHub issues](https://github.com/engwire/engwire/issues); anything else, <support@engwire.com>. For a vulnerability, see [SECURITY.md](SECURITY.md) — please do not open a public issue.

## License

MIT
