"""The production purge: everyone but the Main Admin, and everything they did.

The load-bearing test here is `test_the_delete_order_survives_every_foreign_key`,
and it is written the way it is on purpose. `app.purge_people` is correct only
if its delete order satisfies 93 real foreign keys — several of which carry no
ON DELETE clause at all (`login_days.user_id`, `mentors.user_id`,
`students.user_id`, and the four `created_by_user_id` columns on the
institutional spine, which point at rows that are about to be deleted from
tables that are being KEPT). A synthetic fixture graph would prove the order
against the constraints somebody remembered to reproduce. So instead the test
runs the REAL delete against the REAL schema and the data that is actually
there, inside a transaction it rolls back — which is why `_delete_rows` is
factored out of `execute` without a commit.

`test_every_table_has_a_verdict` is the other half, and it is the one that will
fail for someone who has never read this file: add a table, and the purge stops
until you have said in `VERDICTS` whether it holds people or catalogue. That is
deliberate. The alternative — a prefix rule, or a default — is how a purge
either leaves a student's records behind or destroys the badge catalogue.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from conftest import requires_db

from app import purge_people
from app.db import Base, SessionLocal
from app.models.user import Role, User


def test_every_table_has_a_verdict():
    """No database needed, so this one runs everywhere and is the guard that
    actually catches the next person adding a model."""
    purge_people.check_verdicts()  # raises PurgeRefused naming the offenders


def test_the_verdicts_cover_the_whole_schema_exactly():
    known = {t.name for t in Base.metadata.sorted_tables} - {"alembic_version"}
    assert set(purge_people.VERDICTS) == known
    # The institution is kept, the people are not. Spot-check both directions so
    # a mass find-and-replace cannot flip every verdict and stay green.
    assert purge_people.VERDICTS["cohorts"] == purge_people.KEEP
    assert purge_people.VERDICTS["colleges"] == purge_people.KEEP
    assert purge_people.VERDICTS["knowledge_chunks"] == purge_people.KEEP
    assert purge_people.VERDICTS["students"] == purge_people.EMPTY
    assert purge_people.VERDICTS["mentors"] == purge_people.EMPTY
    assert purge_people.VERDICTS["interview_sessions"] == purge_people.EMPTY
    assert purge_people.VERDICTS["messages"] == purge_people.EMPTY
    assert purge_people.VERDICTS["users"] == purge_people.SURVIVOR


def test_every_file_backed_table_is_emptied_not_kept():
    """A KEPT table whose rows point at stored files would leave those files
    orphaned on the volume with nothing left to find them by."""
    for name in purge_people.FILE_COLUMNS:
        assert purge_people.VERDICTS[name] == purge_people.EMPTY, name


def test_the_created_by_columns_are_all_on_kept_tables():
    """The nulling pass exists only for KEPT tables. A column listed here whose
    table is emptied anyway is a leftover that will confuse the next reader."""
    for name, column in purge_people.CREATED_BY_COLUMNS:
        assert purge_people.VERDICTS[name] == purge_people.KEEP, name
        assert column in Base.metadata.tables[name].c


@requires_db
def test_the_delete_order_survives_every_foreign_key():
    """THE REAL DELETE, ROLLED BACK. If any table is deleted before something
    that references it, Postgres raises here and this test fails — which is the
    only way to learn that before a production console does."""
    users = Base.metadata.tables["users"]
    kept_before = {}
    with SessionLocal() as db:
        plan = purge_people.build_plan(db)
        for name, verdict in purge_people.VERDICTS.items():
            if verdict == purge_people.KEEP:
                kept_before[name] = db.scalar(
                    select(func.count()).select_from(Base.metadata.tables[name])
                )
        try:
            purge_people._null_created_by(db, plan)
            purge_people._delete_rows(db, plan)

            # Exactly one account, and it is the Main Admin.
            assert db.scalar(select(func.count()).select_from(users)) == 1
            survivor = db.scalar(select(users.c.id))
            assert survivor == plan.survivor_id
            assert db.scalar(select(users.c.role)) in (Role.ADMIN, "ADMIN")

            # Every EMPTY table is empty.
            for name, verdict in purge_people.VERDICTS.items():
                if verdict == purge_people.EMPTY:
                    n = db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
                    assert n == 0, f"{name} still holds {n} row(s)"

            # Every KEPT table is untouched. This is the half that makes the
            # purge usable: an office that has to retype its whole hierarchy
            # afterwards will simply not run it.
            for name, before in kept_before.items():
                after = db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
                assert after == before, f"{name} lost rows: {before} -> {after}"
        finally:
            db.rollback()


@requires_db
def test_the_plan_counts_what_the_delete_deletes():
    """A dry run an operator reads and then acts on is only useful if the two
    passes agree. Same session, same transaction: plan, delete, compare."""
    with SessionLocal() as db:
        plan = purge_people.build_plan(db)
        before = {
            name: db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
            for name in plan.rows
        }
        try:
            purge_people._null_created_by(db, plan)
            purge_people._delete_rows(db, plan)
            for name, planned in plan.rows.items():
                # users keeps one row; every other planned table goes to zero.
                expected = 1 if name == "users" else 0
                after = db.scalar(select(func.count()).select_from(Base.metadata.tables[name]))
                assert after == expected
                assert before[name] - after == planned, name
        finally:
            db.rollback()


@requires_db
def test_it_refuses_when_the_main_admin_is_not_exactly_one(make_user):
    """Zero admins would lock every human out of the console; two would make
    this module pick which colleague keeps their account. Both refuse, and
    both refusals name the problem."""
    with SessionLocal() as db:
        try:
            # Two: add a second ADMIN and watch it refuse by count.
            db.add(
                User(
                    id="purge-test-second-admin",
                    email="second.admin@bgscet.ac.in",
                    name="Second Admin",
                    password_hash="google-only",
                    role=Role.ADMIN,
                )
            )
            db.flush()
            with pytest.raises(purge_people.PurgeRefused) as exc:
                purge_people.find_survivor(db)
            assert "ADMIN accounts exist" in str(exc.value)
            assert "second.admin@bgscet.ac.in" in str(exc.value)

            # Zero: demote every admin and watch it refuse the other way.
            # DEMOTED, not deleted — deleting them here trips
            # `login_days_user_id_fkey`, which is exactly the no-ON-DELETE
            # constraint `_delete_rows` orders around, and this test is about
            # the refusal rather than the order.
            users = Base.metadata.tables["users"]
            db.execute(
                users.update().where(users.c.role == Role.ADMIN).values(role=Role.MENTOR)
            )
            with pytest.raises(purge_people.PurgeRefused) as exc:
                purge_people.find_survivor(db)
            assert "No ADMIN account" in str(exc.value)
        finally:
            db.rollback()


@requires_db
def test_a_dry_run_changes_nothing(make_user):
    """`main()` with no flags must be readable by an operator who is not yet
    sure, and must leave the deployment exactly as it found it."""
    with SessionLocal() as db:
        before = db.scalar(select(func.count()).select_from(Base.metadata.tables["users"]))

    assert purge_people.main([]) == 0

    with SessionLocal() as db:
        after = db.scalar(select(func.count()).select_from(Base.metadata.tables["users"]))
    assert after == before


@requires_db
def test_the_receipt_actually_writes():
    """`_stamp` swallows its own failure so a purge that worked is not reported
    as failed by its receipt -- which means a broken receipt is SILENT, and the
    receipt is the only record left that the deployment was emptied at all
    (the sweep empties the audit table immediately before it). So it is written
    for real here, read back, and removed."""
    audit = Base.metadata.tables["redesign_audit_events"]
    with SessionLocal() as db:
        plan = purge_people.build_plan(db)
        plan.rows = {"users": 11}
        purge_people._stamp(db, plan)  # commits its own row

    try:
        with SessionLocal() as db:
            row = db.execute(
                select(audit.c.id, audit.c.action, audit.c.after_json, audit.c.actor_user_id)
                .where(audit.c.entity_type == "deployment", audit.c.action == "PURGE")
                .order_by(audit.c.occurred_at.desc())
            ).first()
            assert row is not None, "the purge left no record of itself"
            assert row.actor_user_id == plan.survivor_id
            assert row.after_json["kept_account"] == plan.survivor_email
            assert row.after_json["rows_deleted"] == 11
            written_id = row.id
    finally:
        with SessionLocal() as db:
            db.execute(audit.delete().where(audit.c.id == written_id))
            db.commit()


def test_apply_alone_is_refused():
    """The second flag is the whole confirmation. --apply on its own must not
    delete anything, and must say why it did not."""
    assert purge_people.main(["--apply"]) == 2
