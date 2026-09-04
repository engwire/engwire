# Engwire

Reviews the pull requests that ask for your review — on your laptop, with your GitHub account, your Claude subscription, and your own review skill. No Engwire account required.

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

GitHub.com only — `GH_HOST` is pinned, so `gh` and the checkout can never disagree about which repository they mean. No new service receives your source code: Engwire drives the Git, `gh` and Claude Code already on your machine. The local workflow needs no Engwire-hosted service, no bot account, no workflow to commit, and no additional credential to your source.

One installation belongs to one GitHub account — the one authenticated when it first ran. Point `ENGWIRE_HOME` somewhere else for a second. On macOS, only one installation per user runs in the background: launchd keeps one job under a fixed label, so `engwire service install` in a second installation replaces the first one's service and says so.

## Requirements

You need [`gh`](https://cli.github.com) 2.31 or newer (authenticated), [Claude Code](https://claude.com/claude-code), and a user-level review skill. Engwire invokes the configured skill as `/<skill> <repo>#<number> at <sha>` but ships none of its own: what a review reads, says and posts remains the skill's responsibility.

`engwire doctor` reports skills that fail Engwire's preflight. The runner leaves their reviews queued instead of claiming work that Claude can already be shown not to run.

## Install

Published releases install with:

```sh
curl -fsSL https://engwire.com/install.sh | sh
```

That redirects to the latest release's installer, which is also reachable directly at `github.com/engwire/engwire/releases/latest/download/install.sh`. One binary into `~/.local/bin`.

`ENGWIRE_PREFIX` puts it elsewhere and `ENGWIRE_VERSION` pins a release — on the right of the pipe, where the installer runs, not the left, where only `curl` would see them:

```sh
curl -fsSL https://engwire.com/install.sh | ENGWIRE_VERSION=0.1.0 sh
```

macOS 13+ and Linux with glibc 2.17+, Intel and ARM. The x64 builds require AVX2 — Haswell-era Intel or newer, Excavator or newer on AMD. Those are Bun's own floors, since the binary carries its runtime; Alpine and other musl distributions are not supported yet. The installer runs what it downloaded before replacing anything, so a machine outside that range fails with nothing lost. Upgrading is the same command; it replaces the binary without disturbing a review in flight, and a background service picks the new one up on the next `engwire service install`.

## Use

```sh
engwire setup               # check prerequisites and write a starter config
engwire run --once          # one poll, at most one review, then exit
engwire service install     # keep it running in the background (macOS)
engwire status              # what it is doing and what it last did
engwire doctor              # diagnose the local setup
```

Run `engwire setup` first to check prerequisites and write a starter config. Background supervision is macOS-only; on Linux, run `engwire run` directly under your preferred supervisor.

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

Engwire polls GitHub for `review_requested` issue events naming you. Each event has its own identity, so re-requesting a review of an unchanged commit gets you a second review, because you meant it — though several unseen asks for the same pull request found in one poll are collapsed to the newest, and the rest recorded as superseded. For each accepted request it prepares a detached worktree from its own clone at the latest head seen on the successful poll immediately before the review starts, and runs Claude Code there. Your skill reads the code and posts the review through `gh`. The checkout is kept for a day by default so you can see what Claude saw, then removed.

Claude runs with `--setting-sources user`, so the review is governed by *your* configuration and *your* skill — never by a `.claude/` directory, `CLAUDE.md` or `.mcp.json` the pull request brought with it. `engwire doctor` checks that your Claude Code still validates the flag; [docs/experiments.md](docs/experiments.md) records how to verify that it still enforces the boundary.

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

`bun run engwire <command>` runs any of the commands above straight from the source tree, so trying a change out does not need a build.

The scheduling logic in `src/review/reconcile.ts` is pure, and every way this tool could embarrass you — a duplicate review, a review of a replaced revision, a review nobody asked for — is a test over plain objects in `reconcile.test.ts`.

### Releases

A release is a `v*` tag on `main` whose version matches `package.json`; the workflow refuses anything else. The version is ordinary code — it moves on a branch and goes through review like everything else, and the tag comes after it has landed:

```sh
bun pm version patch --no-git-tag-version   # when the version needs to move
# commit, review, merge as usual

VERSION=X.Y.Z   # what package.json says on origin/main

git fetch --no-tags origin main &&
git tag -a "v$VERSION" -m "v$VERSION" FETCH_HEAD &&
git push origin "v$VERSION"
```

`--no-git-tag-version`, always, and the tag goes on `FETCH_HEAD` rather than on your local `main`: left to itself `bun pm version` tags whichever branch you happen to be on, and a local `main` that has drifted ahead survives `git pull --ff-only` without a word. The `&&` is load-bearing too — `git tag` refuses a name that already exists, and a pasted block that carried on regardless would push the old tag instead of the new one. Once pushed, a `v*` tag can be neither moved nor deleted — including one the workflow then refuses for not being on `main` — so a wrong tag is answered by the next version, never by repointing.

The tag is what publishes: it rebuilds the binaries and attaches them with `install.sh`, then installs that candidate the way you would — the published installer, one runner per binary — and promotes it only once every artifact has started on its own platform. Nothing else cuts a release. [docs/specs/releases.md](docs/specs/releases.md) is the contract in full.

## Support

Bugs and feature requests belong in [GitHub issues](https://github.com/engwire/engwire/issues); anything else, <support@engwire.com>. For a vulnerability, see [SECURITY.md](SECURITY.md) — please do not open a public issue.

## License

MIT
