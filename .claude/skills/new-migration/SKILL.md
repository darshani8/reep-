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
   step in ci.yml's `api` job walks the chain on a scratch database, in
   segments cut at each revision whose downgrade refuses, and runs every other
   downgrade. It fails unless the catalogue (tables, columns, defaults,
   indexes, constraints, enum types and values, comments) matches at each
   segment's BOTTOM after the downgrades -- so a reverse that restores the wrong
   default fails even though the re-upgrade would overwrite it -- and at its TOP
   after the re-upgrade, and unless `alembic check` is clean. Two things are
   deliberately not compared: column ORDER (a reverse of DROP COLUMN can only
   append), and the leftovers declared in `KEPT_ON_DOWNGRADE`.
   - Drop what you create, enum TYPES included. Autogenerate drops a table and
     leaves its type, so a re-upgrade after a rollback fails with `type ...
     already exists` -- eighteen early revisions did exactly that until the
     round trip found it.
   - A downgrade that is only `pass` or a bare `raise` fails
     `tests/test_migration_reversibility.py` unless the revision is in
     `IRREVERSIBLE` in `apps/api-py/migrations/reversibility.py`, with the
     reason in words. "Nobody wrote it" is not a reason. Real ones: the reverse
     would have to GUESS (which MENTOR rows were DIRECTOR), would re-issue
     access a person revoked, or would undo what Postgres cannot.
   - `"raises"` refuses and cuts the chain: nothing is rolled back THROUGH it,
     and if it is the newest it is the floor a production rollback can reach.
     Prefer `"no-op"` when the upgrade is safe to run twice over what the no-op
     leaves (`ADD VALUE IF NOT EXISTS`, an `UPDATE ... WHERE` that matches
     nothing the second time); the round trip proves that claim.
   - A real downgrade that cannot remove everything -- an enum VALUE (Postgres
     has no DROP VALUE), an extension, a rescue table -- declares the leftover
     in `KEPT_ON_DOWNGRADE`. Both lists are ratchets: give a listed revision a
     real downgrade, or make a declared leftover disappear, and CI makes you
     strike it off.
   - Never edit an applied migration's `upgrade()`.
7. **Verify** on your own database (never a shared one -- the round trip
   creates and drops `<name>_roundtrip`, and refuses a non-dev `ENV`, any
   non-loopback host or hostaddr, and a database named like production):
   ```
   python -m alembic upgrade head && python -m alembic check
   python -m pytest -q tests/test_migration_reversibility.py
   python ../../tools/ci/check_migration_roundtrip.py --plan   # segments, read-only
   python ../../tools/ci/check_migration_roundtrip.py          # the CI step itself
   ```
   A failure prints the alembic traceback naming the revision, or a diff of
   the catalogue: `-` lines are what the round trip lost, `+` what it left.
8. If the table holds people's data, give it a verdict in
   `app/purge_people.py` `VERDICTS` and `app/purge_students.py`
   `STUDENT_VERDICTS` — the tests refuse an unclassified table.
