# Specifications

Specifications describe how Engwire is supposed to behave now. Edit a spec when its behavior changes; history belongs in an ADR or Git, not in version-suffixed copies of the spec.

Use a spec for a focused product contract that spans modules or needs more detail than the README or the system-wide overview in [`docs/architecture.md`](../architecture.md). Keep implementation details beside the code when they only help maintain that implementation.

## Naming

Keep this directory flat until it becomes genuinely hard to navigate. Name a spec for the concept it defines:

```text
docs/specs/<slug>.md
```

Prefer `review-runner.md` or `event-semantics.md` over an implementation artifact or a version such as `review-runner-v2.md`.

## Template

Remove sections that add no useful information; an empty heading is not documentation.

```markdown
# <Capability>

## Purpose

<What user or system need this behavior serves.>

## Scope

<What this spec governs and what it deliberately does not.>

## Requirements

<Observable behavior, invariants, and constraints.>

## Failure behavior

<How invalid input, unavailable dependencies, and partial work are handled.>

## Verification

<Tests, experiments, or other evidence that establish the contract.>

## Decisions

<Links to relevant ADRs for rationale. The spec must remain understandable without reading them.>
```
