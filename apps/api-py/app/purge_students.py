"""Delete every STUDENT from this deployment: ``python -m app.purge_students``.

The narrow counterpart to `app.purge_people`, for the case that actually comes
up. A demonstration cohort has to go; the faculty who were set up alongside it,
their signatures, their upskilling shelf, their governance grants and the
institution itself all have to stay. `app.purge_people` cannot express that —
its verdicts are whole-table (`students: EMPTY`, `users: SURVIVOR`), so it keeps
the Main Admin and nobody else, and running it to clear a cohort deletes every
faculty account on the way through.

WHAT GOES: every account whose role is STUDENT, every row those accounts
produced, every row any staff member wrote ABOUT them (mentor notes, SWOC
entries, the mentor notebook), and the documents, interview audio and call
recordings behind all of it.

WHAT STAYS: every MENTOR, ALUMNI and ADMIN account untouched, their own
records, the institutional hierarchy, the catalogues, the job postings and the
Knowledge Base — everything `app.purge_people` keeps, plus the people it would
have deleted.

**The properties that make it safe to point at production are the same three,
plus one this module needs and `purge_people` does not.**

FIRST, EVERY TABLE HAS A WRITTEN VERDICT — and here a verdict is not two
values but three, because "delete the student rows" is a different sentence in
a table only a student can own (`resumes`) and in a table shared with staff
(`leave_requests`). `STUDENT_VERDICTS` below says which, for all 93 tables, and
an unclassified table ABORTS THE RUN exactly as it does next door. The key set
is checked against `purge_people.VERDICTS`, so the next person to add a model
is stopped by BOTH destructors rather than by the one they happened to read.

SECOND, THE FILES GO BEFORE THE ROWS, for `purge_people`'s reason — a row is
the last pointer to a student's resume and a named student's recorded voice,
and a delete that loses the pointer first leaves bytes nobody can find. The
three stores are destroyed through `purge_people`'s own functions, handed the
subset of rows this purge is taking, never a copy of the logic.

THIRD, IT REFUSES TO TOUCH A NON-STUDENT. The doomed set is `role == STUDENT`
and nothing else, and `_refuse_unless_only_students` proves that against the
database BEFORE a single byte is destroyed — because the one way this module
could be catastrophic is a scope predicate that is wrong about who a row
belongs to, and that mistake must surface while it is still only a refusal.
After the deletes it is checked AGAIN, inside the transaction, so a wrong
verdict on some other table that took an account with it rolls the whole pass
back instead of committing it.

FOURTH — the one `purge_people` has no need of — THE STUDENT'S APPLICATION GOES
WITH THE STUDENT. `registrations` is the only table here holding rows for people
who are not yet anybody, and the office's pending queue must survive a cohort
being cleared. So it is scoped, not emptied: an application that was APPROVED
(it became a student) or that carries a doomed account's address goes; a pending
or rejected application from someone who never became a student stays where the
admin left it. Leaving an approved application behind would be worse than untidy
— `POST /api/register`'s duplicate guard would then refuse that address forever,
and the person it refuses has no account any more to explain why.

DRY RUN IS THE DEFAULT. `--apply` is the only thing that deletes, and the counts
a dry run prints are the counts the real pass acts on.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from .db import Base, SessionLocal
from .models import user as user_model
from .purge_people import (
    CREATED_BY_COLUMNS,
    FILE_COLUMNS,
    KEEP,
    VERDICTS,
    PurgeRefused,
    _tables_in_delete_order,
    destroy_document_files,
    destroy_interview_audio,
    destroy_s3_recordings,
)

# Importing the package registers every model on Base.metadata, for the same
# reason purge_people does it: the verdict check below is only a guard if it
# runs against the WHOLE schema.
from . import models  # noqa: F401

log = logging.getLogger("reep.purge_students")

#: Every row in this table belongs to a student. Used where the owning column is
#: NOT NULL and can only ever name a student — `resumes.student_id`,
#: `interview_sessions.student_id` — and for the children of such tables, whose
#: parent rows are all going anyway (`interview_turns`, `subject_marks`).
ALL = "all"

#: The accounts themselves. One table, one meaning, and it is spelled out rather
#: than written as a scope because `users` is the row every other verdict is
#: ultimately about.
ACCOUNTS = "accounts"


def by_user(column: str) -> tuple[str, str]:
    """Rows owned by an account: delete where that column names a doomed one.
    For every table a student and a staff member can BOTH have rows in."""
    return ("user", column)


def by_email(column: str) -> tuple[str, str]:
    """Rows that name a person by address rather than by id — `mail_logs` keeps
    no foreign key, because the mail it records is often sent to somebody who
    has no account at all."""
    return ("email", column)


def by_parent(table: str, column: str) -> tuple[str, str, str]:
    """Rows reached only through their parent, where the parent is itself
    scoped. Written out rather than inferred: a child whose parent is `ALL` is
    marked `ALL` too, so the only `by_parent` entries here are the four that
    genuinely need the join."""
    return ("via", table, column)


#: What happens to each of the 93 tables. `KEEP` is untouched; `ALL` is emptied;
#: anything else is a scope, and the row survives unless the scope names it.
#: Grouped by the REASON, because the reason is what a reviewer has to check.
STUDENT_VERDICTS: dict[str, object] = {
    # -- the institution: not a person, outlives every intake ----------------
    "colleges": KEEP,
    "departments": KEEP,
    "academic_courses": KEEP,
    "academic_specializations": KEEP,
    "cohorts": KEEP,
    # -- catalogues and configuration the office maintains ------------------
    "approved_certifications": KEEP,
    "certifications": KEEP,
    "courses": KEEP,
    "skills": KEEP,
    "jobs": KEEP,
    "job_import_runs": KEEP,
    "interview_bank_questions": KEEP,
    "placement_criteria": KEEP,
    "registration_rules": KEEP,
    "alert_rule_configs": KEEP,
    "feature_overrides": KEEP,
    "access_groups": KEEP,
    "platform_specializations": KEEP,
    "platform_questions": KEEP,
    "platform_time_limits": KEEP,
    "platform_recording_policies": KEEP,
    # -- the Knowledge Base: approved public policy text, no student in it --
    "knowledge_documents": KEEP,
    "knowledge_chunks": KEEP,
    "redesign_knowledge_namespaces": KEEP,
    "redesign_knowledge_document_versions": KEEP,
    "redesign_knowledge_chunks": KEEP,
    "redesign_knowledge_chunk_embeddings": KEEP,
    "redesign_embedding_models": KEEP,
    "redesign_tenants": KEEP,
    # -- a faculty member's OWN records. The whole point of this module ------
    # `purge_people` empties these; here they are the thing being protected.
    "staff_signatures": KEEP,
    "staff_upskilling_certs": KEEP,
    # -- queues with no person in them --------------------------------------
    # Neither table has a foreign key to `users` and neither names one: the
    # subject is an opaque aggregate id that belongs to whichever tenant wrote
    # it. Guessing which of those ids is a student is how a purge deletes
    # another tenant's pending work, so these are left exactly alone.
    "redesign_outbox_events": KEEP,
    "redesign_domain_jobs": KEEP,
    # -- the accounts -------------------------------------------------------
    "users": ACCOUNTS,
    "students": ALL,
    # `mentors` and `alumni_profiles` belong to people this module protects, so
    # both are scoped rather than kept: a STUDENT-role account holding one is a
    # data error, and `mentors.user_id` carries NO ON DELETE, which would turn
    # that error into a constraint violation that aborts the whole pass. A
    # scope that is normally a no-op costs one count in the report.
    "mentors": by_user("user_id"),
    "alumni_profiles": by_user("user_id"),
    "platform_candidates": by_user("user_id"),
    "redesign_tenant_memberships": by_user("user_id"),
    "access_group_members": by_user("user_id"),
    "capability_grants": by_user("subject_user_id"),
    # -- credentials and the sign-in trail ----------------------------------
    # `login_days.user_id` and `auth_tokens.user_id` are why this module cannot
    # simply delete from `users` and let the database sort it out: the first
    # carries no ON DELETE at all.
    "auth_tokens": by_user("user_id"),
    "login_days": by_user("user_id"),
    "email_verifications": by_parent("registrations", "registration_id"),
    # -- a student's own records: nobody else can hold one of these ----------
    "student_profiles": ALL,
    "student_skills": ALL,
    "student_badges": ALL,
    "student_milestones": ALL,
    "badge_evidence": ALL,
    "skill_claims": ALL,
    "capability_assessments": ALL,
    "academic_gaps": ALL,
    "academic_qualifications": ALL,
    "attendance_records": ALL,
    "subject_marks": ALL,  # child of semester_results
    "semester_results": ALL,
    "enrollments": ALL,
    "lab_sessions": ALL,
    "schedule_items": ALL,
    "mock_attempts": ALL,
    "alerts": ALL,
    "certification_progress": ALL,
    "english_baselines": ALL,
    "english_baseline_sections": ALL,  # child of english_baselines
    "time_ledger_days": ALL,
    "time_ledger_cells": ALL,  # child of time_ledger_days
    "time_sheet_entries": ALL,
    "resumes": ALL,
    "resume_profiles": ALL,
    "uploads": ALL,
    "job_applications": ALL,
    "placement_offers": ALL,
    # -- the application, scoped. See the module docstring, property four ----
    "registrations": ("registrations",),
    "registration_documents": by_parent("registrations", "registration_id"),
    # -- what staff wrote ABOUT a student ------------------------------------
    # These go. Every one of them is keyed on `student_id` NOT NULL, so the row
    # is a note about somebody who will not exist in a moment; keeping it would
    # leave the faculty screens rendering notes against a missing name.
    "mentor_notes": ALL,
    "swoc_entries": ALL,
    "redesign_mentor_notebook_entries": ALL,
    "redesign_mentor_notebook_entry_revisions": ALL,  # child of entries
    "redesign_mentor_notebook_actions": ALL,
    "redesign_mentor_notebook_attachments": ALL,  # child of entries
    # -- leave: BOTH roles apply on this form, so it is scoped ---------------
    "leave_requests": by_user("requester_user_id"),
    # -- recordings and transcripts ------------------------------------------
    "interview_sessions": ALL,
    "interview_turns": ALL,  # child of interview_sessions
    "interview_evaluations": ALL,  # child of interview_sessions
    "interview_consents": by_user("user_id"),
    "platform_call_sessions": by_user("user_id"),
    # -- the assistant: staff use it too -------------------------------------
    "conversations": by_user("owner_user_id"),
    "messages": by_parent("conversations", "conversation_id"),
    "agent_runs": by_user("actor_id"),
    "assistant_feedback": by_parent("agent_runs", "run_id"),
    # -- logs -----------------------------------------------------------------
    "mail_logs": by_email("recipient"),
    # The office's audit trail SURVIVES; only the events a student performed
    # themselves go. An admin's record of approving or editing that student is
    # the office's own history and is not theirs to take away.
    "redesign_audit_events": by_user("actor_user_id"),
    "redesign_api_idempotency_keys": by_user("principal_id"),
}


def check_verdicts() -> None:
    """Every table classified, every named column real, and the same table set
    `purge_people` knows about.

    Pinned by tests/test_purge_students.py so the failure lands in CI rather
    than on a production console. The third check is the one worth explaining:
    a new model classified in one destructor and forgotten in the other is the
    failure this pairing exists to prevent, and it is silent in every other way.
    """
    known = {t.name for t in Base.metadata.sorted_tables} - {"alembic_version"}
    unclassified = sorted(known - set(STUDENT_VERDICTS))
    if unclassified:
        raise PurgeRefused(
            "These tables have no verdict in purge_students.STUDENT_VERDICTS: "
            + ", ".join(unclassified)
            + ". Say for each one whether it is KEEP, ALL, or scoped to the "
            "student who owns it - this purge will not guess."
        )
    stale = sorted(set(STUDENT_VERDICTS) - known)
    if stale:
        raise PurgeRefused(
            "purge_students.STUDENT_VERDICTS names tables that no longer exist: "
            + ", ".join(stale)
            + ". Remove them."
        )
    if set(STUDENT_VERDICTS) != set(VERDICTS):
        drift = sorted(set(STUDENT_VERDICTS) ^ set(VERDICTS))
        raise PurgeRefused(
            "purge_students and purge_people disagree about which tables exist: "
            + ", ".join(drift)
            + ". Both destructors must classify every table."
        )

    for name, verdict in STUDENT_VERDICTS.items():
        columns = Base.metadata.tables[name].columns
        if isinstance(verdict, tuple) and verdict[0] in ("user", "email"):
            if verdict[1] not in columns:
                raise PurgeRefused(f"{name} has no column {verdict[1]!r}.")
        elif isinstance(verdict, tuple) and verdict[0] == "via":
            if verdict[2] not in columns:
                raise PurgeRefused(f"{name} has no column {verdict[2]!r}.")
            if verdict[1] not in Base.metadata.tables:
                raise PurgeRefused(f"{name} names a parent table that does not exist.")


@dataclass(frozen=True)
class Doomed:
    """Who is going, READ ONCE and then held as literal ids.

    Every scope below could have been written as a live subquery over
    `users` — and that would be wrong in a way no test on a fresh database
    would catch. The accounts are deleted near the END of the pass, because
    `users` is a parent of almost everything and the order runs children first;
    any table ordered AFTER it whose scope re-ran that subquery would find no
    students left, match nothing, and leave its rows behind. Silently. Reading
    the set once, before anything is deleted, makes every predicate mean the
    same thing at every point in the pass, whatever the order turns out to be.
    """

    user_ids: tuple[str, ...]
    emails: tuple[str, ...]
    registration_ids: tuple[str, ...]

    def __bool__(self) -> bool:
        return bool(self.user_ids)


def find_doomed(db: Session) -> Doomed:
    """The scope of this whole module, in one place. ROLE, never an address
    typed on a form: a purge that took an email argument would delete the wrong
    person the moment somebody fat-fingered it.

    Both the enum member and its string value are matched, because a row written
    by a migration and a row written by the ORM do not always compare equal.

    The registrations are resolved here too, against the accounts as they are
    now: an application that was APPROVED (it became a student) or that carries
    a doomed account's address. See the module docstring, property four.
    """
    users = Base.metadata.tables["users"]
    rows = db.execute(
        select(users.c.id, users.c.email).where(
            users.c.role.in_((user_model.Role.STUDENT, "STUDENT"))
        )
    ).all()
    user_ids = tuple(r[0] for r in rows)
    emails = tuple(r[1] for r in rows if r[1])

    regs = Base.metadata.tables["registrations"]
    registration_ids = tuple(
        db.execute(
            select(regs.c.id).where(
                or_(
                    regs.c.approved_student_id.is_not(None),
                    # An empty IN renders as a false expression, which is the
                    # right answer when there are no students to match.
                    regs.c.email.in_(emails),
                )
            )
        )
        .scalars()
        .all()
    )
    return Doomed(user_ids=user_ids, emails=emails, registration_ids=registration_ids)


def predicate(name: str, doomed: Doomed):
    """The WHERE clause that selects this table's doomed rows, or None when the
    whole table goes. Raises for a KEPT table, which is a caller's bug.

    A `via` scope stays a subquery on purpose: its parent is always ordered
    AFTER the child (children first), so the parent rows are still there to be
    joined against when the child is deleted, and materialising them too would
    pull whole tables into memory for no gain."""
    table = Base.metadata.tables[name]
    verdict = STUDENT_VERDICTS[name]
    if verdict == KEEP:
        raise PurgeRefused(f"{name} is KEEP and has no doomed rows.")
    if verdict == ALL:
        return None
    if verdict == ACCOUNTS:
        return table.c.id.in_(doomed.user_ids)
    if verdict == ("registrations",):
        return table.c.id.in_(doomed.registration_ids)
    kind = verdict[0]
    if kind == "user":
        return table.c[verdict[1]].in_(doomed.user_ids)
    if kind == "email":
        return table.c[verdict[1]].in_(doomed.emails)
    if kind == "via":
        parent = Base.metadata.tables[verdict[1]]
        parent_where = predicate(verdict[1], doomed)
        inner = select(parent.c.id)
        if parent_where is not None:
            inner = inner.where(parent_where)
        return table.c[verdict[2]].in_(inner)
    raise PurgeRefused(f"{name} has an unreadable verdict {verdict!r}.")


@dataclass
class Plan:
    """What a run would do. A dry run prints this and stops; a real run acts on
    exactly these numbers, so the two can be compared afterwards."""

    doomed: Doomed
    rows: dict[str, int] = field(default_factory=dict)
    files: int = 0
    audio_sessions: int = 0
    s3_objects: int = 0

    @property
    def accounts(self) -> int:
        return len(self.doomed.user_ids)

    @property
    def total_rows(self) -> int:
        return sum(self.rows.values())


def _refuse_unless_only_students(db: Session, doomed: Doomed) -> None:
    """The guard that runs BEFORE anything is destroyed.

    `find_doomed` selects on `role == STUDENT`, so this can only fail if that
    selection is edited — which is exactly the edit that must never reach a
    commit. It reads the rows back BY ID rather than trusting the query that
    produced them, it is cheap, the consequence is checked again after the
    deletes, and it is the difference between a bad predicate being a refusal
    and being a deployment's faculty."""
    if not doomed:
        return
    users = Base.metadata.tables["users"]
    strays = db.execute(
        select(users.c.email, users.c.role)
        .where(users.c.id.in_(doomed.user_ids))
        .where(users.c.role.not_in((user_model.Role.STUDENT, "STUDENT")))
    ).all()
    if strays:
        listed = ", ".join(f"{email} ({role})" for email, role in strays[:10])
        raise PurgeRefused(
            f"{len(strays)} account(s) selected for deletion are not students: "
            f"{listed}. This module deletes STUDENT accounts and nothing else; "
            "nothing was changed."
        )


def _scoped(stmt, name: str, doomed: Doomed):
    """Apply a table's scope to a statement, or leave it alone when the whole
    table goes. One place, so a count and its delete can never disagree."""
    where = predicate(name, doomed)
    return stmt if where is None else stmt.where(where)


def build_plan(db: Session) -> Plan:
    check_verdicts()
    doomed = find_doomed(db)
    _refuse_unless_only_students(db, doomed)
    plan = Plan(doomed=doomed)

    for table in _tables_in_delete_order():
        if STUDENT_VERDICTS.get(table.name, KEEP) == KEEP:
            continue
        n = db.scalar(_scoped(select(func.count()).select_from(table), table.name, doomed))
        if n:
            plan.rows[table.name] = int(n)

    for name, column in FILE_COLUMNS.items():
        if STUDENT_VERDICTS[name] == KEEP:
            continue  # a faculty signature and upskilling certificate stay
        table = Base.metadata.tables[name]
        col = table.c[column]
        stmt = select(func.count()).select_from(table).where(col.is_not(None))
        plan.files += int(db.scalar(_scoped(stmt, name, doomed)) or 0)

    # Every interview_sessions row is a student's, so the audio sweep is the
    # whole table — the same sweep purge_people does, for the same reason.
    sessions = Base.metadata.tables["interview_sessions"]
    plan.audio_sessions = int(db.scalar(select(func.count()).select_from(sessions)) or 0)

    calls = Base.metadata.tables["platform_call_sessions"]
    plan.s3_objects = int(
        db.scalar(
            _scoped(
                select(func.count())
                .select_from(calls)
                .where(calls.c.recording_s3_key.is_not(None)),
                "platform_call_sessions",
                doomed,
            )
        )
        or 0
    )
    return plan


def _destroy_files(db: Session, plan: Plan) -> list[str]:
    """Bytes first, rows after — the subset of each store that belongs to the
    students going. The three destroyers are `purge_people`'s own."""
    documents: list[tuple[str, str]] = []
    for name, column in FILE_COLUMNS.items():
        if STUDENT_VERDICTS[name] == KEEP:
            continue
        col = Base.metadata.tables[name].c[column]
        stmt = _scoped(select(col).where(col.is_not(None)), name, plan.doomed)
        documents += [(name, stored) for (stored,) in db.execute(stmt).all()]

    sessions = Base.metadata.tables["interview_sessions"]
    audio = db.execute(select(sessions.c.id, sessions.c.audio_path)).all()

    calls = Base.metadata.tables["platform_call_sessions"]
    keys = [
        key
        for (key,) in db.execute(
            _scoped(
                select(calls.c.recording_s3_key).where(
                    calls.c.recording_s3_key.is_not(None)
                ),
                "platform_call_sessions",
                plan.doomed,
            )
        ).all()
    ]

    return (
        destroy_document_files(documents)
        + destroy_interview_audio(audio)
        + destroy_s3_recordings(keys)
    )


def _null_created_by(db: Session, plan: Plan) -> None:
    """The institution records who created it, and those four columns carry no
    ON DELETE. A student cannot reach the screens that write them, so this is
    normally a no-op — but "normally" is not a constraint, and the failure it
    prevents aborts the whole pass."""
    for name, column in CREATED_BY_COLUMNS:
        table = Base.metadata.tables[name]
        db.execute(
            update(table)
            .where(table.c[column].in_(plan.doomed.user_ids))
            .values(**{column: None})
        )


def _delete_rows(db: Session, plan: Plan) -> None:
    """Every doomed row, children first, accounts last.

    SEPARATE FROM `execute` AND WITHOUT A COMMIT, for `purge_people`'s reason:
    the only honest way to test a delete order against the real foreign keys is
    to run it against the real schema and roll back, which a function that
    commits cannot offer.
    """
    for table in _tables_in_delete_order():
        if STUDENT_VERDICTS.get(table.name, KEEP) == KEEP:
            continue
        db.execute(_scoped(delete(table), table.name, plan.doomed))


def execute(db: Session, plan: Plan) -> list[str]:
    """Destroy. One transaction for the rows, so the deployment is either purged
    of students or untouched; the files are gone before it opens, because a
    filesystem has no transaction to join.

    The survivor count is taken before and compared after, INSIDE the
    transaction. `_refuse_unless_only_students` has already proven the doomed
    set; this proves the consequence, and a wrong verdict anywhere else that
    took an account with it rolls the pass back rather than committing it."""
    users = Base.metadata.tables["users"]
    survivors_before = db.scalar(
        select(func.count()).select_from(users).where(users.c.id.not_in(plan.doomed.user_ids))
    )

    failures = _destroy_files(db, plan)
    _null_created_by(db, plan)
    _delete_rows(db, plan)

    survivors_after = db.scalar(select(func.count()).select_from(users))
    if survivors_after != survivors_before:
        db.rollback()
        raise PurgeRefused(
            f"Refusing to commit: {survivors_before} non-student account(s) "
            f"existed and {survivors_after} remain. The row deletes were rolled "
            "back. Stored files for the students in the plan were already "
            "destroyed - that step cannot join the transaction - so read the "
            "counts above before running anything else."
        )

    db.commit()
    return failures


def _stamp(db: Session, plan: Plan) -> None:
    """One audit row, so the deployment's history records that its students were
    removed and roughly what went with them. Best-effort: a purge that worked
    must not be reported as failed because its own receipt would not write.

    The actor is the Main Admin when there is exactly one, and NULL otherwise —
    this module has no opinion about how many office accounts a deployment has,
    and inventing one to fill a nullable column would put a name against an act
    they may not have performed."""
    try:
        from .models.redesign import AuditEvent

        users = Base.metadata.tables["users"]
        admins = db.execute(
            select(users.c.id).where(users.c.role.in_((user_model.Role.ADMIN, "ADMIN")))
        ).scalars().all()
        actor = admins[0] if len(admins) == 1 else None

        db.add(
            AuditEvent(
                actor_user_id=actor,
                entity_type="deployment",
                entity_id="students",
                action="PURGE_STUDENTS",
                after_json={
                    "purged_at": datetime.now(timezone.utc).isoformat(),
                    "accounts_deleted": plan.accounts,
                    "rows_deleted": plan.total_rows,
                    "tables_touched": sorted(plan.rows),
                    "files_deleted": plan.files,
                    "audio_sessions_swept": plan.audio_sessions,
                    "s3_objects_deleted": plan.s3_objects,
                },
            )
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("Purge completed but its audit row could not be written: %s", exc)
        db.rollback()


def _report(db: Session, plan: Plan, *, applied: bool) -> None:
    head = "STUDENTS PURGED" if applied else "DRY RUN - nothing was deleted"
    log.info("%s", head)
    if not plan.accounts:
        log.info("This deployment holds no STUDENT accounts. Nothing to delete.")
        return
    log.info("Student accounts deleted: %d", plan.accounts)
    for name in sorted(plan.rows, key=lambda k: (-plan.rows[k], k)):
        log.info("  %-45s %8d row(s)", name, plan.rows[name])
    log.info("  %-45s %8d row(s)  TOTAL", "", plan.total_rows)
    log.info(
        "Stored files: %d document(s), %d interview session(s) swept for audio, "
        "%d S3 recording(s).",
        plan.files,
        plan.audio_sessions,
        plan.s3_objects,
    )

    # The accounts that SURVIVE, by role and by name. This is the half an
    # operator is actually anxious about, and a count they can compare against
    # the console afterwards is worth more than the list of kept tables.
    users = Base.metadata.tables["users"]
    remaining = db.execute(
        select(users.c.role, func.count())
        .where(users.c.id.not_in(plan.doomed.user_ids))
        .group_by(users.c.role)
    ).all()
    if remaining:
        # `getattr(role, "name", role)` because the column comes back as the
        # enum member, and an operator reading "1 Role.ADMIN" has to work out
        # that nothing is wrong.
        log.info(
            "Accounts kept: %s",
            ", ".join(
                f"{count} {getattr(role, 'name', role)}"
                for role, count in sorted(remaining, key=lambda r: str(r[0]))
            ),
        )
    kept = sorted(n for n, v in STUDENT_VERDICTS.items() if v == KEEP)
    log.info("Tables not touched at all (%d): %s", len(kept), ", ".join(kept))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.purge_students",
        description=(
            "Delete every STUDENT account and everything those accounts "
            "produced, including what staff wrote about them and every "
            "transcript, document and recording. Faculty, alumni and the Main "
            "Admin are untouched, as are the institution and the catalogues."
        ),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete. Without this the run reports and changes nothing.",
    )
    parser.add_argument(
        "--i-understand-this-is-permanent",
        dest="understood",
        action="store_true",
        help="Required with --apply. There is no undo and no soft-delete here.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    if args.apply and not args.understood:
        log.error(
            "--apply also needs --i-understand-this-is-permanent. This deletes "
            "production records outright: there is no soft-delete, no undo, and "
            "the documents and audio are removed from the volume as well."
        )
        return 2

    try:
        with SessionLocal() as db:
            plan = build_plan(db)
            if not args.apply:
                _report(db, plan, applied=False)
                log.info("Re-run with --apply --i-understand-this-is-permanent to do it.")
                return 0
            # The report reads the surviving accounts, so it is composed while
            # the doomed ones are still there to be excluded from the count.
            failures = execute(db, plan)
            _stamp(db, plan)
            _report(db, plan, applied=True)
            if failures:
                log.error(
                    "%d stored file(s) could not be destroyed and their rows are "
                    "now gone, so the bytes are no longer discoverable from the "
                    "database: %s",
                    len(failures),
                    ", ".join(failures[:20]) + (" ..." if len(failures) > 20 else ""),
                )
                return 1
    except PurgeRefused as exc:
        log.error("%s", exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
