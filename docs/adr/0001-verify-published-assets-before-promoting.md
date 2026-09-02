# ADR-0001: Verify published assets before promoting a release

- Status: Accepted
- Date: 2026-09-02
- Supersedes: —

## Context

Engwire is installed with a command people pipe into a shell, so the artifact that ends up on a machine is whatever GitHub is serving at the release URL. Three things about that path cannot be established by building successfully:

- The binaries are cross-compiled. All four come from one runner, so the Intel Mac and the ARM Linux artifacts are never executed by the job that produces them; without something else running them, the first machine to do so is a user's.
- The installer derives asset names from `uname` and the workflow uploads names derived from its build targets. The two agree by inspection, in different languages, and would keep agreeing right up until they didn't.
- `install.sh` is itself a release asset. The documented command fetches the copy GitHub serves, not the copy in the repository, and only the published one can return a 404.

What needed proving was therefore not "the build worked" but "the documented install command, run against the published release, produces a binary that starts on that platform". Reaching the published release is what constrains the shape: a draft release is invisible without a token and its assets are not at the URL the installer uses, while a published release is at that URL for anybody.

That looked like it forced a choice. GitHub's release immutability takes effect when a release is published, and its own documentation is in two minds about what that means: the immutable-releases page lists the protections as the tag and the assets, while the release-management page says "you can only edit the title and release notes after a release is published". Under the second reading a published prerelease could never be promoted, and verifying a public candidate would be incompatible with immutable assets — for software whose install path is literally remote code execution. So it was measured rather than read ([experiments.md](../experiments.md)): an immutable published prerelease accepts `prerelease=false` and `make_latest=legacy`, while asset replacement and tag movement are refused. There was no trade-off to make.

## Decision

Release immutability is enabled on the repository. A tag publishes a **prerelease**. Four runners — one per artifact — then install that release the way a person would: the published `install.sh`, the published asset, fetched by tag, with no checkout and no token. Only once every artifact has started on its own platform is the prerelease flag cleared, and promotion uses `make_latest=legacy` so it never drags `latest` backwards.

Verification fetches by tag rather than by `latest`, so it proves this candidate rather than whatever `latest` currently resolves to, and each runner cross-checks `uname` against the artifact it was assigned so a mis-pointed matrix entry fails instead of verifying one artifact twice.

## Consequences

- `releases/latest/download/` keeps serving whatever stable release already exists while a candidate is unproven, so promotion is the only thing that puts a version on the normal installation path and it never puts an unverified one there.
- The candidate is public. It can be fetched by tag while verification is still running: the guarantee is that every artifact is executed on its own platform before it reaches the normal installation path, not that none can be fetched beforehand.
- Published assets cannot be replaced, so the four runners prove the bytes that stay published and not merely the bytes that were published. For an already-published version, someone with write access can still delete the release and deny access to it, but cannot put different bytes under that tag: a tag that has carried an immutable release can never carry another. Deletion permits denial, not substitution. That is a property of versions already published, not a claim about repository write access in general — which can still publish a new one.
- A failed verification spends the version. The assets cannot be repaired and the tag cannot be repointed, and deleting the failed release does not free its tag name for another, so the fix ships as the next version while the candidate stays a prerelease and never reaches the normal installation path.
- Promotion rests on measured behaviour rather than a documented contract, and the documentation is not on its side. Should GitHub tighten this to match its release-management page, the workflow fails closed: the promotion call errors, the candidate remains an immutable prerelease, and nothing reaches the normal installation path. The remedy then is the draft shape below, at the cost this decision declines to pay today.
- Immutability applies only to releases published after it is enabled, which is why it is on before the first tag rather than after the first users.
- It freezes the tag only for as long as the release exists, so it does not replace the `v*` ruleset barring updates and deletions. The two cover different halves and the repository keeps both.
- Nothing is transported between jobs, so what verification runs is what GitHub serves. The cost is that `publish` rebuilds rather than reusing preflight's artifacts, and Bun's compiler is not byte-reproducible, so those are not the same files. Preflight proves the semantics on both host families; verification proves the exact published bytes on all four targets.

## Alternatives considered

- **Draft release, attach, verify with a token, publish once.** GitHub's recommended shape for immutable releases, and it does buy one real property this design gives up: an unverified candidate is never publicly fetchable. Rejected because that matters less here than exercising the exact anonymous installation path before promotion — the candidate is a prerelease and never becomes `latest` — and because it costs the thing verification exists for. A draft's assets are not at the installer's URL, so `install.sh` cannot be run against them without adding a URL seam to a production script, and the asset-name contract goes back to being asserted rather than executed. It also needs a repository token in the job whose whole point is to receive exactly what a user receives.
- **Verify the artifacts on the runner that built them, then upload.** Rejected: it proves bytes on a disk rather than bytes GitHub serves, leaves the asset-name contract with the installer untested, and still cannot execute three of the four artifacts.
- **Publish stable immediately, smoke-test the public path afterwards.** Rejected: a failure would already have moved `latest` onto a broken release, and the only remedy is a new version while people are installing the broken one.
- **Trust the build.** Rejected: no job executes three of the four artifacts, which is the whole gap.
