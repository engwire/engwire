# ADR-0003: Withdraw the workflow format's compatibility promise until a workflow API ships

- Status: Accepted
- Date: 2026-09-09
- Supersedes: [ADR-0002](0002-pin-the-workflow-file-format-before-a-loader.md), in part — its grow-only compatibility decision

## Context

[ADR-0002](0002-pin-the-workflow-file-format-before-a-loader.md) pinned `src/workflows/workflow.schema.json` before any loader existed, and accepted a consequence with it: "from the moment this lands, third parties can write files against a format with no consumer, and every file the schema accepts is owed compatibility." Its grow-only rule required later keys to be optional and existing constraints never to tighten. Tests pinned the `required` arrays; broader compatibility remained a schema-review obligation.

That reasoning holds once Engwire offers the format as a supported contract for authors. It has not, and the facts that say so are Engwire's own rather than a claim about what nobody on the internet has written: nothing reads a workflow, `config.toml` alone decides what starts a review, the `$id` URL does not serve the schema, there is no `engwire add`, and nothing offers the format to external authors as something to rely on. The only workflow file Engwire maintains against the schema is this repository's sample. The schema, that sample and the sketch in [explorations/extensions.md](../explorations/extensions.md) are all visible — the repository is public — but visibility is not support, and what ADR-0002 was really protecting against was the format acquiring authors *by accident*, before anyone read it as a contract. Someone copying an artifact nobody offered them does not create one.

Meanwhile [product.md](../product.md) puts a public workflow API outside current scope and states the opposite rule for this stage: the format that a real second routine needs is unknown until a second routine exists, and a constraint accepted now is one the first loader has to design around. A promise made to nobody, that constrains the only party who will ever have to keep it, is a cost with no beneficiary. The repository is also explicitly green-field, which is the general form of the same argument.

Leaving both statements standing was the actual defect: `architecture.md` now says compatibility is not guaranteed, while an Accepted ADR says every accepted file is owed it. The next schema change would have had two instructions.

## Decision

The workflow file format is **experimental until Engwire publishes a supported workflow API. Compatibility is not guaranteed** — a later schema may tighten a constraint, rename or remove a key, or replace the format outright.

Everything else ADR-0002 decided stands: the schema exists, it keeps its `$id`, it is validated with Ajv in tests only, and the shape it chose remains the shape. What is withdrawn is the obligation to keep accepting what it accepts, and with it the grow-only rule and the reason the test pins `required` arrays as a compatibility guard rather than as an ordinary assertion about the current format.

Before Engwire publishes a supported workflow API it has to choose and record that API's compatibility and versioning contract. Grow-only is a candidate, not a reservation; until then none is promised.

## Consequences

- The first loader may change the format to fit a real routine instead of designing around a guess. This is the whole point.
- Anyone writing a workflow file today is writing against a moving target. Engwire's own sample moves with the schema and nothing else is owed compatibility, which is why the exploration doc and `architecture.md` both say so in the same words.
- The test may still pin `required` arrays, but as a description of the format rather than as a guard on a promise. A schema change that alters them is now a decision to make, not a rule being broken.
- Serving the schema at its `$id`, shipping workflow installation, or documenting the format as something external authors may rely on are each author-facing steps, and each needs this ADR revisited first.

## Alternatives considered

- **Keep the promise.** It is cheap while the format has three required keys, and honouring it costs nothing until it does. Rejected because the cost is not paid now, it is paid by the first loader that finds the format wrong — exactly when the format is finally understood, and exactly when a workaround is most expensive.
- **Delete the schema and the sample.** Consistent, and it removes the ambiguity by removing the artifact. Rejected because ADR-0002's other reasoning survives: the schema documents a considered shape and its test keeps the sample honest, which is worth more than the nothing that replaces it.
- **Mark ADR-0002 `Superseded` in full.** Rejected as inaccurate. Its schema choices are still in force; only its grow-only compatibility decision is not, and saying the whole decision is void would lose the reasoning behind everything the format still does.
