# Experiments

Some of what Engwire relies on is a property of another system — Claude Code, git, GitHub — rather than of Engwire, so it was established by running that system instead of by reading its documentation. Everything recorded here is load-bearing, expensive to re-derive, impossible to verify from inside a unit test, and free to change under you.

These are recipes, so re-running one against a new version is an afternoon's work rather than a reconstruction.

## Does a checkout run anything?

SECURITY.md says Engwire checks out a revision and does not execute it. A checkout is git operating on content someone else wrote, and git has several ways to run a command while it works — so whether that sentence holds is a property of git, not a decision Engwire makes. Measured on git 2.54.0, through `ensureRepository` and `prepareRevision` themselves, against an origin carrying the vectors below.

The checkout recipes below drive a single `git worktree add`, which is how the vectors were found. What Engwire runs now is `worktree add --no-checkout` followed by `reset --hard`, for the reason in the last of them — so re-running these against the current code means running both halves.

**Repository-local configuration and hooks do not travel.** A `filter.evil.smudge` defined in the origin's own config, a `.git/hooks/post-checkout`, and a `core.hooksPath` set locally all failed to run, and the clone's config held nothing beyond what `clone` writes. Clone transfers refs and objects, not configuration and not hooks.

**`post-checkout` fires, from two independent sources.** `git worktree add` runs it, with the new worktree as its working directory. A *relative* `core.hooksPath`, which a reviewer may well have set globally to share hooks across their own repositories, resolves next to the bare clone rather than inside the worktree: `.githooks` means `<clone>/.githooks`, a path the branch cannot write to. But an *absolute* one is the reviewer's own script, and it ran in the contributor's checkout — a hook written for repositories its author trusts, meeting one they have not read. Since git 2.54 a hook can also be configured outright, as `hook.<name>.command` with `hook.<name>.event = post-checkout`, and that source is not covered by `core.hooksPath` at all: with the hook path pointed at `/dev/null` the configured command still ran, and `git show HEAD:file` from inside it read the branch's own blobs. `hook.<name>.enabled = false` is git's documented way to switch one off, keyed by the hook's own name rather than by the event — `hook.post-checkout.enabled = false` reads `post-checkout` as a name and disables nothing.

**`core.fsmonitor` runs a program too.** Git documents a non-boolean value as the pathname of a hook, and `worktree add` refreshes the index through it: the script ran in the new worktree, with the same reach as the others. Empty rather than `false` disables it, since git through 2.35.1 reads a boolean-looking value there as a pathname — measured inert on 2.54.0, including where the reviewer had set it to `true`.

Engwire's clones carry no hooks of their own, so disabling both hook sources loses no Engwire-owned behaviour.

**Filters were the exception.** A committed `.gitattributes` naming `filter=evil` activates a `filter.evil.smudge` defined in the *reviewer's global* config, and it ran during checkout with the file's contents on its stdin. A contributor cannot choose *what* runs — the command is configuration the reviewer wrote for their own reasons — but they choose whether it runs and on what content. This is not hypothetical: the machine these measurements were taken on has `git-lfs 3.7.1` installed, and a user-level `git lfs install` defines `filter.lfs.smudge`, `clean`, `process` and `required = true` globally.

`inertOverrides` in `git/repository.ts` now supplies targeted overrides to clone, fetch and both checkout operations, finding executable configuration by name because git has no wildcard override. Re-run against the same arena, nothing executes.

**The checkout answers to a second repository.** A plain `git worktree add` does the checkout in a child process with `GIT_DIR` set to the *new worktree's* gitdir, `<clone>/worktrees/<name>`. Config the reviewer scoped to that path is invisible from the bare clone: `[includeIf "gitdir:**/worktrees/**"]` matches the one and not the other, and a smudge filter behind such an include ran with every override in place, because the enumeration never saw it. So the worktree is created with `--no-checkout` and filled by a separate `reset --hard`, each overridden against the gitdir it runs in. That split also changes which hooks fire: `post-checkout` no longer runs at all, while `reference-transaction` fires in both halves and `post-index-change` in the second — so those are the events worth pinning a test to.

What the measurements settled about the shape of the fix:

- **`required` has to be overridden too.** With the check-out-side commands disabled, a filter still marked required does not fall back to unfiltered content — `fatal: .gitattributes: smudge filter evil failed`, exit 128, no worktree. Since `git-lfs` marks its filter required, disabling the commands alone would have broken the checkout of every LFS repository.
- **An empty value is enough to disable a driver**, reads as false for `required`, and leaves content byte-identical to having no filter at all.
- **A disabled `process` does not fall back to a `smudge` beside it**, so each key has to be overridden on its own account rather than one standing in for the rest.
- **Only the check-out direction reaches.** A filter defining nothing but `clean` did not run as the tree was written, so the overrides cover `smudge`, `process` and `required` and leave `clean` as the reviewer set it.
- **`GIT_DIR` outranks the working directory.** `git -C <dir>` with `GIT_DIR` exported operates on `$GIT_DIR`, so naming a cwd guarantees nothing on its own; `git()` drops `GIT_DIR` and its relatives from the environment it hands to git, and keeps everything else.
- **`-c` cannot express every key.** A subsection name may legally contain an `=`, and `-c <name>=<value>` splits on the first one: against a real `[filter "a=b"]` the argument `-c filter.a=b.smudge=` set `filter.a` instead and the smudge ran. `--config-env=<name>=<var>` splits on the last `=` and takes the value from the environment, which blocked it — and it exits 128 if the variable is missing, so a mistake there is loud rather than silent.
- **Targeted beats blanket.** `GIT_CONFIG_GLOBAL=/dev/null` would also work, but the clone is blobless, so the checkout still fetches blobs and still needs whatever proxy and credential settings the reviewer's configuration carries.

The cost is that a file which really is an LFS pointer stays a pointer in the checkout.

**Acquiring the repository runs hooks too.** `reference-transaction` fires on every clone and every fetch, from both hook sources, before any tree exists — a hook of the reviewer's, running while a repository they have never read is downloaded. So the same overrides go on `clone` and `fetch` rather than on the checkout alone. One residual, stated rather than closed: a clone has no configuration of its own to enumerate, so config the reviewer scoped by `includeIf` to Engwire's own clone path is invisible to it. Nothing in a branch can ask for that, and every other form is covered.

What none of this covers, and is not meant to: once Claude is running in that directory, a skill can execute whatever its `allowed-tools` permit. The claim measured here is narrower — what *Engwire's own* git does.

## Is the timeline worth what it costs?

Discovery wants one thing from a pull request's history: its `review_requested` entries, and their ids. Two endpoints carry them. `issues/<n>/timeline` is a superset that interleaves every commit, comment, review and cross-reference; `issues/<n>/events` carries the events and nothing else. Engwire reads one of them once per candidate on every poll, so this is a per-minute cost rather than a one-off.

Measured with `gh` 2.98.0:

```sh
gh api --paginate 'repos/oven-sh/bun/issues/30412/timeline?per_page=100' | wc -c   # 6,049 KB
gh api --paginate 'repos/oven-sh/bun/issues/30412/events?per_page=100'   | wc -c   #   375 KB
```

1,663 timeline entries against 305 events — 17 API pages against 4, at `per_page=100`. That pull request is alive and still collecting comments, so the figures move; the ratio is the durable half.

`--paginate` merging REST pages into one JSON array is a property of `gh` rather than a given, and it has a floor. Measured against both sides of it, with a page size small enough to force three pages:

```sh
gh api --paginate 'repos/cli/cli/issues/14259/events?per_page=5' | jq length
# gh 2.30.0 -> 5, 5, 2   three concatenated arrays; `JSON.parse` throws
# gh 2.31.0 -> 12        one array
```

The change is [cli/cli#7190](https://github.com/cli/cli/pull/7190), released in 2.31.0 (June 2023). Note that `jq` accepts the concatenated form and Engwire's single `JSON.parse` does not, so on a multi-page response an old `gh` fails loudly rather than returning a quietly short list. Only on a multi-page one, though: a history that fits in a single page parses on either version, so an unsupported `gh` can look healthy until the first busy pull request. That is why the README states the floor rather than leaving it to be met.

Cheaper is only free if the entries are the same entries. `UNIQUE(event_id)` is keyed on the id, so a database an earlier Engwire wrote has to go on matching, or the same GitHub request could be treated as fresh after the switch. Compared without normalising the two shapes — a team request carries no `requested_reviewer` and a user request no `requested_team`, and coalescing them would hide precisely the disagreement worth finding:

```sh
select='[.[] | select(.event == "review_requested")
         | {id, node_id, url, created_at, commit_id,
            reviewer: .requested_reviewer.login, team: .requested_team.slug}]
        | sort_by(.id)'
for pr in oven-sh/bun#30412 oven-sh/bun#20000 oven-sh/bun#25000 oven-sh/bun#12000 \
          cli/cli#14259 cli/cli#10000 cli/cli#9000 cli/cli#8000; do
  repo=${pr%%#*}; n=${pr##*#}
  a=$(gh api --paginate "repos/$repo/issues/$n/timeline?per_page=100" | jq -c "$select")
  b=$(gh api --paginate "repos/$repo/issues/$n/events?per_page=100"   | jq -c "$select")
  [ "$a" = "$b" ] && echo "$pr agree" || echo "$pr DIFFER"
done
```

Eight pull requests across two repositories, from 9 to 1,663 timeline entries, holding nine `review_requested` entries between them — five naming a user, four naming a team. Every field in that projection matched on every entry. `node_id` and `url` matching is the part that carries the argument: it makes these two projections of one underlying object rather than two records that happen to agree today. `commit_id` was null on all nine, which is the other thing Engwire leans on — the revision comes from the pull request, never the event.

The other endpoint not taken is GraphQL, which could batch many candidates into one request rather than spending two `gh` subprocesses on each. Its event type cannot supply the REST database id Engwire uses:

```sh
gh api graphql -f query='{
  event: __type(name: "ReviewRequestedEvent") { name fields { name } }
  state: __type(name: "ReviewRequest")        { name fields { name } }
}' --jq '.data[] | "\(.name): \([.fields[].name] | join(" "))"'
# ReviewRequestedEvent: actor createdAt id pullRequest requestedReviewer
# ReviewRequest:        asCodeOwner databaseId id pullRequest requestedReviewer
```

No `databaseId` on `ReviewRequestedEvent`: the node id is all there is, and the REST integer is what `UNIQUE(event_id)`, `BigInt` ordering and `CAST(event_id AS INTEGER)` are built on. `ReviewRequest` has a database id, but it is the current-state object discovery deliberately avoids for identity.

What this does not establish: that the two endpoints agree in general, or that they are obliged to. Nine entries are worth what nine entries are worth, and the claim is about `review_requested` in the cases measured. `events` omits commits, comments and reviews outright, which is the point of it; anything that wants those has to go back to the timeline and pay.

## What GitHub's immutable releases actually freeze

The release pipeline publishes a prerelease, verifies the published assets on four platforms, and then clears the prerelease flag. Whether that survives turning on release immutability was worth knowing before the first tag, because immutability applies only to releases published after it is enabled — never retroactively — so a decision to defer it is a decision to leave every release published in the meantime permanently editable.

The setting is not on the repository object. It has its own endpoint, and `PUT` takes no body:

```sh
gh api repos/OWNER/REPO/immutable-releases          # {"enabled":false,"enforced_by_owner":false}
gh api repos/OWNER/REPO/immutable-releases -X PUT   # enable
```

Measured on a throwaway repository with immutability enabled, against a published prerelease carrying one asset:

| | |
| --- | --- |
| clear the prerelease flag, set `make_latest` | **allowed** — `prerelease: false`, `immutable: true`, becomes `releases/latest` |
| edit the title and notes | allowed |
| delete an asset | `Cannot delete asset from an immutable release` |
| upload another asset | `HTTP 422: Cannot upload assets to an immutable release` |
| move the tag | `[remote rejected] push declined due to repository rule violations` |
| delete the release | allowed, and it frees the tag it was holding |
| create a new release on that same tag | `tag_name was used by an immutable release` |

The last two rows are the interesting pair. Deleting a release is not blocked, so somebody with write access can still take a version away — but they cannot put different bytes back under it, because the tag name is burned for releases from then on. The exposure is denial, not substitution, which is the one that mattered for something installed by piping a script into a shell.

The first row is what the pipeline turns on, and it is worth measuring precisely because GitHub's own documentation disagrees with itself about it. The immutable-releases page lists the protections as the tag and the assets; the release-management page says "you can only edit the title and release notes after a release is published", which would make promotion impossible. The API sides with the first, and the Update Release endpoint still takes `prerelease` and `make_latest`. So the choice between verifying a public candidate and having immutable assets — which looked like a real trade-off — was not one. What this establishes is those two fields and the title and notes, not a general rule that release metadata stays editable, and the pipeline fails closed if it ever changes: promotion errors, and the candidate stays a prerelease that never reaches the normal installation path.

Immutability freezes the tag only while the release exists, so it is not a substitute for a `v*` tag ruleset barring updates and deletions. The two cover different halves and Engwire keeps both.
