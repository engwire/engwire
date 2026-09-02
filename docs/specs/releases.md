# Releases

## Purpose

Engwire is a compiled single-file binary that people install with one piped command. This is the contract between the tag a maintainer pushes and the binary that ends up on somebody's machine.

## Scope

Covers what a release is, the artifacts it carries, and what each stage of the pipeline proves. Installing and upgrading are the [README](../../README.md); what the binary does once installed is [architecture.md](../architecture.md).

## Requirements

**A release is a `v*` tag and nothing else.** No manual upload, no branch build. The tag has to match `package.json`, be reachable from `main`, and carry no channel suffix — `promote` clears the prerelease flag unconditionally, so a `v1.0.0-rc.1` would be turned into an ordinary release and made eligible for `latest`.

**`v*` tags are append-only, and published assets are frozen.** A repository ruleset bars tag updates and deletions once a tag is pushed, including one whose workflow fails and publishes nothing — a wrong tag is answered by the next version, never by repointing. Release immutability then holds the assets: they cannot be replaced or added to after publication, and a tag that has carried an immutable release can never carry another. Someone with write access can still delete a release and take a version away; they cannot put different bytes under it.

**One artifact per platform, named the same way by everyone.** `engwire-<os>-<arch>.gz` for `darwin`/`linux` × `arm64`/`x64`, plus `install.sh`, so `releases/latest/download/install.sh` is a stable URL. That installer is a bootstrapper, not half of a matched pair — `ENGWIRE_VERSION` has it fetch an older binary on purpose, and even an ordinary install can see `latest` move between fetching the script and fetching the asset — so it stays backward compatible instead. Only `verify` fetches installer and asset by the same tag, which is stricter than any real install. The artifact name is derived independently by `scripts/build.ts` from its build targets and by `install.sh` from `uname`; that duplication is deliberate — a cross-language manifest would be more machinery than the drift is worth — and it is the verification stage that catches the two disagreeing.

**Gzipped, with no checksum.** Compression materially reduces the download every install and upgrade pays. `install.sh` says why a checksum from the same origin over the same TLS would add nothing — that argument belongs where somebody auditing the installer will read it.

**The binary knows which release it is.** `--version` reports the version compiled in from `package.json`, which is what lets the build, the verification and the installer all check the same fact from different sides. `ENGWIRE_VERSION` is held to it, so pinning names the version installed rather than only the URL fetched.

**The binary reads no configuration from the directory it is run in.** A standalone Bun executable otherwise autoloads `.env` and `bunfig.toml` from its working directory, and Engwire's working directory may be a checkout of the branch under review. `scripts/build.ts` compiles the autoloads out and records why.

## Failure behavior

A version mismatch, a channel suffix, or a tag that is not on `main` stops the pipeline before anything is published; the tag is spent, and the next attempt is the next version.

If the release is published without immutability — the repository setting was off, and it never reaches back to a release already published — the pipeline stops there. That candidate is public and mutable: it is not promoted, and it is not reused either, since somebody may already have fetched those bytes. Restore the setting and cut the next version.

A failed verification spends the version. The candidate stays a prerelease; its assets cannot be repaired, its tag cannot be repointed, and deleting the release does not free the tag name for another one — so the fix ships as the next version. `releases/latest/download/` goes on serving whatever stable release already exists, so the documented install command is unaffected. The candidate remains publicly fetchable by tag — the guarantee is that every artifact is executed on its own platform before it reaches the normal installation path, not that none can be fetched beforehand.

The installer replaces nothing until the replacement has started: it stages inside the destination directory, decompresses, runs `--version`, checks it against a pin if one was given, and only then renames. A download that will not run on the machine, or that reports the wrong version, fails with the previous install intact. Because the swap is a rename, a runner already going keeps the binary it started with and finishes the review it may be in the middle of.

## Verification

`preflight` runs the typechecker, the suite, the build and the compiled integration tests on both host families whose compiled behaviour can differ; `publish` runs once on one machine, so a Darwin-only regression would otherwise reach a release on the strength of a Linux run. A release establishes its own evidence rather than borrowing the branch CI run for the same commit, which may be older than the tag, still going, or long expired.

`test/integration/binary.test.ts` is part of that. It pins the autoload properties against a compiled binary — one test each for the two autoloads that default on — and skips where there is no artifact to inspect, so it runs against preflight's own builds. Those are not the bytes that ship: `publish` builds again and Bun's compiler is not byte-reproducible. Preflight proves compiled semantics on both host families; `verify` proves the exact published bytes on all four targets.

`verify` installs the published release on one runner per artifact, with no checkout and no token, and each runner cross-checks `uname` against the artifact it was assigned. See [ADR-0001](../adr/0001-verify-published-assets-before-promoting.md).

`test/integration/install.test.ts` covers what `verify` structurally cannot. A correct release only ever asks the installer for its own asset, so every refusal the installer makes — a download that will not start, one that reports a version other than the one pinned — is reachable only by handing it something wrong.

## Decisions

- [ADR-0001](../adr/0001-verify-published-assets-before-promoting.md) — verify published assets before promoting a release.
