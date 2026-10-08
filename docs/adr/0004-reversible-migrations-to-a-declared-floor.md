# 0004. Migrations are reversible down to a declared rollback floor

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** the quality-gate programme; review by the repository owner

## Context

`docs/deployment-process.md` §9.3 lists `alembic downgrade` last among the ways
to undo a bad migration, and says why: the downgrade bodies had never been
exercised against a database, and at least one head revision's downgrade failed
on exactly the state its upgrade existed to permit. A downgrade nobody has run is
a comment, not a rollback plan. At the same time, some migrations genuinely
cannot be reversed: a data repair whose "before" state is not recorded, a
Postgres enum value that cannot be dropped without recreating the type
(`AGENTS.md` keeps `Role.DIRECTOR` for that reason), a migration whose
`downgrade()` deliberately raises (`7c4e0b21d9aa`, because nothing records which
MENTOR rows used to be DIRECTOR).

## Decision

CI applies every migration and then **downgrades to a declared floor revision
and upgrades back to head** on a real Postgres, in the API job's step
"Migrations roll back (downgrade to the floor, then up again)"
(`tools/ci/check_migration_roundtrip.py`,
`apps/api-py/tests/test_migration_reversibility.py`). Every revision above the
floor must round-trip. A revision that cannot is listed in an `IRREVERSIBLE`
mapping with the reason, and the pull request says how production would recover
instead (roll forward, or restore — `deployment-process.md` §9.3). The floor only
moves up.

## Alternatives considered

- **Require every migration since the first to reverse.** Several historical
  revisions cannot, by design; fixing them now buys nothing for the revisions
  that will actually be rolled back, which are the recent ones.
- **Forbid downgrades entirely and only ever roll forward.** Roll-forward is the
  right first answer in production, and stays so. But an untested downgrade path
  also breaks local development and the per-run test databases `AGENTS.md`
  recommends, and a forward-only rule gives authors no reason to think about the
  reverse at all.

## Consequences

- A new migration needs a working `downgrade()` or an explicit, reasoned entry in
  `IRREVERSIBLE` — the PR template's "Schema" section asks.
- A downgrade that passes CI still does not restore DATA a migration dropped; the
  roll-forward-first advice in `deployment-process.md` is unchanged.
- The API job takes longer by one downgrade/upgrade cycle.
- Enforced by the round-trip step; the floor and the mapping change only by
  review (ADR 0003's ratchet applies).
