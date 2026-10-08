# Architecture Decision Records

An ADR is one short file recording **one decision**: the situation that forced
it, what was decided, and what it costs. It exists so that the next person who
wants to undo the decision can read why it was made before they do.

REEP recorded its decisions in `AGENTS.md`'s prose and in commit bodies until
2026-10-08, and much of that reasoning still lives there and stays there. ADRs do
not replace it. They are the index of decisions that **constrain future work** —
the ones a reviewer should be able to cite by number in a pull request.

## When to write one

Write an ADR when a change:

- picks between two designs that both work, and the loser will look attractive
  again later (the "rejected alternative" in the PR template is the seed of one);
- adds, removes or changes a gate, a required check, or a rule in `AGENTS.md`;
- changes a boundary: which module owns a concern, a new process, a new store;
- breaks backward compatibility of the API, the schema or the session.

A bug fix, a refactor that preserves behaviour, or a new screen on existing
patterns does not need one; its commit body is its record.

## Numbering and files

`NNNN-short-title-in-kebab-case.md`, four digits, the next free number, never
reused. Copy [`0000-template.md`](0000-template.md). An ADR is merged in the same
pull request as the change it records, or before it.

## Status

| Status | Meaning |
|---|---|
| **Proposed** | Under review in an open pull request. |
| **Accepted** | Merged; the decision is in force. |
| **Superseded by NNNN** | Replaced by a later ADR. Leave the body as it was and add the pointer — the history is the point. |
| **Deprecated** | No longer in force and not replaced (the thing it governed is gone). |

An accepted ADR is not edited except to change its status line. A changed
decision is a new ADR that supersedes the old one.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-quality-gates-in-existing-ci-jobs.md) | Quality gates are steps in existing CI jobs, plus one standalone secret scan | Accepted |
| [0003](0003-ratcheted-baselines-for-new-gates.md) | New gates start from a ratcheted baseline | Accepted |
| [0004](0004-reversible-migrations-to-a-declared-floor.md) | Migrations are reversible down to a declared rollback floor | Accepted |
| [0005](0005-one-live-session-per-account.md) | One live session per account | Accepted |
| [0006](0006-google-sign-in-roster-is-access-control.md) | Google sign-in, with the roster as the access control | Accepted |
| [0007](0007-student-data-egress-gate.md) | Student data leaves the machine only through the egress gate | Accepted |
