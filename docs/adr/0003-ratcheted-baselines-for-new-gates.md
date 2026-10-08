# 0003. New gates start from a ratcheted baseline, not a big-bang clean-up

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** the quality-gate programme; review by the repository owner

## Context

Every new gate finds existing violations on its first run. The route audit found
29 public operations, 22 authenticated handlers whose session is the whole
answer, 13 untyped JSON answers, 1 status-code deviation and 92 list reads
without paging on 2026-10-08; a new linter or type checker finds far more. Many
of those "violations" cannot be fixed without breaking a contract: changing an
existing route's status code, response shape or parameters breaks the Angular
client, and the installed PWA keeps the previous client alive for a while after
a deploy.

The repository already has the pattern this needs: `check_style_duplicates.py`'s
`KNOWN_DUPLICATES` "ratchets in both directions", and the purge modules refuse a
table nobody classified.

## Decision

A new gate lands **green, with today's violations recorded** as an explicit
baseline, and the baseline **ratchets both ways**:

- a **new** violation fails, with a message saying what rule broke and how to fix
  it;
- a baseline entry that **no longer violates** — fixed, or the code is gone —
  also fails, with "strike it off", so the baseline only shrinks and an exception
  cannot outlive its reason to cover the next thing at the same address.

Each entry carries a one-line reason written after reading the code, and the
lists are kept sorted so a diff shows exactly what moved.

## Alternatives considered

- **Fix everything first, then turn the gate on.** Weeks of churn across every
  router before any protection exists, and for this audit, breaking API changes
  made only to satisfy a check.
- **Turn the gate on as a warning.** A warning on every pull request is read for
  a week and then never; and it protects nothing.
- **A one-way ratchet (only new violations fail).** Fixed entries stay listed
  forever, and when a route is deleted and another mounted at the same path, the
  stale exception silently covers it.

## Consequences

- Gates are useful from the first day and never block on history.
- Every exception list is a visible, reviewable to-do list
  (`apps/api-py/tests/route_audit_exceptions.py` is the first).
- Fixing a recorded violation is a two-line change (the fix and the strike-off),
  which is a feature: the reviewer sees the list shrink.
- Enforced by each gate's own test.
