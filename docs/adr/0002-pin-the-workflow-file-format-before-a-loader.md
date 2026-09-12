# ADR-0002: Pin the workflow file format before a loader exists

- Status: Accepted; grow-only compatibility decision superseded by [ADR-0003](0003-withdraw-the-workflow-formats-compatibility-promise.md)
- Date: 2026-09-05
- Supersedes: —

## Context

The extension roadmap in the engwire monorepo — private at the time of writing, so restated here rather than linked — already fixes the outer shape: any Git repository may publish extensions under `.engwire/`, workflows are declarative JSON at `.engwire/workflows/<name>.json` with a canonical schema at `https://engwire.com/schemas/workflow.json`, the file name is the workflow's name and is not repeated inside, names are lowercase kebab-case, and having a repository's `.engwire/` on disk never activates it — execution resolves from Engwire's installed state, not the working directory. Its example workflow also fixes the vocabulary, by example rather than schema: `title`, `description`, `on` as `{ <source>: { event } }`, and `steps` as `{ uses: "<plugin>.<action>", with? }`. None of that is renegotiated here.

What the roadmap leaves open is everything the example does not settle — which keys are required, how many of each are allowed, whether unknown keys are tolerated, the exact name grammar, how the format evolves — and whether to settle it before or after a loader exists. Nothing in the runner reads a workflow; `config.toml` alone decides what starts a review. But the file shape is public the moment one repository publishes one, and from then on every reader owes it compatibility. A loader is Engwire's own code and can arrive whenever it is ready; a published file cannot be taken back.

## Decision

`src/workflows/workflow.schema.json` is the schema, identified by the roadmap's `$id`, and a test holds it to `.engwire/workflows/review-request.json`, a sample this repository publishes. Within the roadmap's outer shape, this repository chose:

- **One trigger, one or more steps, a title.** `on` has exactly one source, and that source has an `event`, a non-empty string — what an event may be called past that is the source's business, since `review_requested` is GitHub's vocabulary and not Engwire's; `steps` is never empty. `title` is required and `description` optional, and both are one line with no edge whitespace, because both are what listings print. An empty string is refused rather than read as absent: omitting the optional key is already the way to say nothing, and neither rule could be added after the first file is published.
- **`$schema`, if present, is the `$id`.** A file pointing at another schema is another format, and this one refuses it rather than guessing.
- **Unknown keys are an error** at every level the schema owns, as in `config.toml`. `with` is open in its contents but is an object: only the capability knows its input names, and something still has to say that input names are what it holds.
- **One name grammar** — the roadmap's kebab-case, pinned to a leading letter and single hyphens — for trigger sources, both halves of `uses`, and the file name. A JSON Schema cannot see file names, so only this repository's test checks that half until a loader does. Plugin names are one flat namespace.
- **Grow-only.** A key added later is optional, so a newer schema accepts every older file; an older schema refuses a newer file once that file actually uses a key it has never heard of, through the unknown-key rule above — the answer `store/` already gives a newer database, by version stamp rather than shape. Adding a required key breaks this compatibility, so the test pins the `required` arrays as well as validating existing examples. Never tightening a constraint that already shipped is the other half, and it stays a rule for schema review — a boundary case in the test catches the usual first slip, but mechanising the rule means a subsumption checker, which the first real schema edit can argue for if it wants one.
- **Validated with Ajv in tests only.** The binary keeps zero runtime dependencies and `config.toml` its hand-written checks. The schema sits beside its test under `src/workflows/`, where the loader will go.

## Consequences

- From the moment this lands, third parties can write files against a format with no consumer, and every file the schema accepts is owed compatibility. The asymmetry is the point: a constraint that turns out too strict can be loosened and a missing concept can arrive as an optional key, but nothing the schema already accepts can be made invalid later. Over-restriction costs an edit; over-permission is permanent.
- This repository now carries exactly the contributor-controlled `.engwire/` the roadmap warns must never be loaded from a working directory. The loader that eventually reads workflows inherits that rule with the format.
- Until engwire.com serves the schema at its `$id`, a `$schema` line does nothing for an editor out of the box; an author has to map the URL to a local copy. The `$id` is the roadmap's URL, so it never has to move.
- The sample mirrors the trigger the runner acts on today, in a format nothing executes, so it can drift from the runner unnoticed — it already omits the skill every `[[review]]` rule requires. Its job is to hold the schema to an example, not to document the runner.
- Ajv is the first development dependency that is a library rather than tooling. It sets no precedent for validating `config.toml` with one.

## Alternatives considered

- **Wait for the loader.** The honest case for waiting: pinning first means guessing what a loader will need, and whatever this schema accepts today has to stay acceptable. Rejected because the format is three required keys and both repairs are cheap: a constraint that turns out too strict can be loosened, and a concept nobody anticipated arrives as an optional key — while waiting means the first loader's convenient file becomes the format, public before anyone read it as a contract.
- **Several triggers per workflow, or open trigger objects.** Rejected as guesses about needs no source has yet. Both are additive to allow later.
- **Scope plugin names by publisher, as `owner/plugin`.** Rejected for now: it decides an ecosystem question before there is an ecosystem, and a flat namespace can gain a scoped form later without losing the flat one.
- **No validator; assert the shape by hand in the test.** Rejected because a schema nobody runs is unverified text, and the test's job is to prove what an author's editor will do with the file.
