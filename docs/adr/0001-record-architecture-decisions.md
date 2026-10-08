# 0001. Record architecture decisions as ADRs

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** the quality-gate programme; review by the repository owner

## Context

REEP's design reasoning is unusually well written down — `AGENTS.md` explains
nearly every guard in the codebase, usually with the incident that produced it —
but it is written as one long narrative organised by subsystem. Three things are
hard to do with it: cite one decision by name in a pull request, see which
decisions are still in force and which were superseded (the leave chain,
"Option B", the DIRECTOR role all changed in place, with "SUPERSEDED" paragraphs
left inline), and find the decision before finding the subsystem. The PR
template already asked about rule 1, rule 2 and the schema; it did not ask "is
this the right approach", and there was nowhere to record the answer.

## Decision

Keep a numbered series of Architecture Decision Records in `docs/adr/`, one
decision per file, in the format of [`0000-template.md`](0000-template.md), with
the status values and the "when to write one" rule in [`README.md`](README.md).
The PR template's "Design and approach" section asks whether a change needs one.
`AGENTS.md` remains the operating manual; an ADR that records a decision already
described there cites the section and adds no rationale of its own.

## Alternatives considered

- **Keep using `AGENTS.md` alone.** It is read by every agent and human, which is
  its strength; but a 2,000-line narrative cannot carry a status per decision,
  and appending ever more "SUPERSEDED" notes makes it harder to read for the
  thing it is best at.
- **Decisions in pull request descriptions only.** They are not versioned with
  the code and are not where the next reader looks.

## Consequences

- A reviewer can ask "which ADR?" and an author can answer with a number.
- One more place to keep in step with `AGENTS.md`. The rule that limits the cost:
  an ADR records the decision and points at the prose; it does not restate it.
- Enforced by nothing but review; the PR template prompts for it.
