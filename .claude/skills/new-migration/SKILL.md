---
name: new-migration
description: Add an Alembic migration to apps/api-py correctly — one head, enum gotchas, indexes on the model, no fake backfills. Use whenever a model under apps/api-py/app/models/ changes.
---

# Adding a migration

1. **Change the model first** (`apps/api-py/app/models/`). A new module must be
   imported in `app/models/__init__.py` or autogenerate never sees it.
2. **Start from one head**: `cd apps/api-py && python -m alembic heads` must
   print exactly one row. Pull `main` first if not.
3. **Generate**: `python -m alembic revision --autogenerate -m "<what>"`, then
   read the file line by line — autogenerate is a draft.
4. **Fix the known traps** (AGENTS.md "Alembic enum gotchas"):
   - new enum column on an existing table → `CREATE TYPE` first;
   - new table reusing an existing enum → `postgresql.ENUM(..., name='x', create_type=False)`;
   - JSON columns are `JSONB`, never `JSON`;
   - every index the migration creates is also declared on the model (partial
     indexes with the same `postgresql_where`), or `alembic check` will ask to
     drop it forever;
   - a `server_default` goes on the model too.
5. **Backfills tell the truth.** Never stamp `now()` on history that happened
   earlier; NULL meaning "not recorded" is honest. Repair data before adding a
   unique constraint over it.
6. **Write a real `downgrade()`.** CI runs it: the "Migrations roll back"
   step in ci.yml's `api` job downgrades every revision above the FLOOR (the
   newest one whose downgrade refuses), upgrades again, and fails unless the
   catalogue is identical and `alembic check` is clean. A downgrade must undo
   EXACTLY what its upgrade did -- every index, enum type, default and comment
   -- or the second `upgrade head` trips over the leftovers.
   - A downgrade that is only `pass` or a bare `raise` fails
     `tests/test_migration_reversibility.py` unless the revision is in
     `IRREVERSIBLE` in `apps/api-py/migrations/reversibility.py`, with the
     reason in words. "Nobody wrote it" is not a reason. Real ones: the reverse
     would have to GUESS (which MENTOR rows were DIRECTOR), would re-issue
     access a person revoked, or would undo what Postgres cannot (an enum
     value cannot be dropped).
   - `"raises"` refuses, and becomes the new floor -- nothing under it is
     exercised any more, so it costs coverage; prefer `"no-op"` when the
     upgrade is safe to run twice over what the no-op leaves (`ADD VALUE IF
     NOT EXISTS`, an `UPDATE ... WHERE` that matches nothing the second time).
     The round trip proves that claim.
   - The ratchet runs both ways: give a listed revision a real downgrade and
     the test makes you strike it off.
   - Never edit an applied migration's `upgrade()`.
7. **Verify** on your own database (never a shared one -- the round trip drops
   things, and it refuses a non-dev `ENV`, a non-loopback host and a database
   named like production):
   ```
   python -m alembic upgrade head && python -m alembic check
   python -m pytest -q tests/test_migration_reversibility.py
   python ../../tools/ci/check_migration_roundtrip.py --plan   # what it will roll back
   python ../../tools/ci/check_migration_roundtrip.py          # the CI step itself
   ```
   A failure prints the alembic traceback naming the revision, or a diff of
   the catalogue: `-` lines are what the round trip lost, `+` what it left.
8. If the table holds people's data, give it a verdict in
   `app/purge_people.py` `VERDICTS` and `app/purge_students.py`
   `STUDENT_VERDICTS` — the tests refuse an unclassified table.
