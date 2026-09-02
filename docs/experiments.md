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
