# Experiments

Some of what Engwire relies on is a property of another system — Claude Code, git, GitHub — rather than of Engwire, so it was established by running that system instead of by reading its documentation. Everything recorded here is load-bearing, expensive to re-derive, impossible to verify from inside a unit test, and free to change under you.

These are recipes, so re-running one against a new version is an afternoon's work rather than a reconstruction.

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
