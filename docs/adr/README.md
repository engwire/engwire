# Architecture decision records

ADRs preserve why Engwire made a consequential, durable choice, including the constraints and rejected alternatives that would otherwise disappear from the current design. They are historical records, not the source of truth for current behavior; [`docs/architecture.md`](../architecture.md) and [`docs/specs/`](../specs/) must remain understandable without them.

Write an ADR when a decision crosses module boundaries, establishes a lasting constraint, or would be expensive to reverse. A local implementation detail or an obvious choice does not need ceremony.

## Naming and lifecycle

Use four digits and name the decision, not merely its topic:

```text
docs/adr/<NNNN>-<decision-slug>.md
```

For example, `0012-snapshot-pr-head-on-claim.md` says more than `0012-revisions.md`. Allocate the next unused number and never reuse one.

An ADR starts as `Proposed`, then becomes `Accepted` or `Rejected`. After acceptance, fix only errors that do not change the recorded decision, such as typos or broken links. If the decision changes, add a new ADR with status `Accepted`, mark the old one `Superseded by ADR-NNNN`, and link the two.

Do not manufacture a retrospective ADR from existing architecture prose unless the original context, decision, and alternatives can be recovered accurately. A neat fiction is still fiction.

## Template

```markdown
# ADR-NNNN: <Decision>

- Status: Proposed
- Date: YYYY-MM-DD
- Supersedes: —

## Context

<The forces, constraints, and problem that require a decision.>

## Decision

<The choice being made.>

## Consequences

<Benefits, costs, risks, and follow-up constraints.>

## Alternatives considered

<Plausible options and why they were not chosen.>
```
