"""Empty this deployment of PEOPLE: ``python -m app.purge_people``.

Everyone except the Main Admin, everything they did, and every recording of
them — while the institution they belong to (colleges, departments, courses,
specializations, batches) and the content the office maintains (job postings,
catalogues, the assistant's Knowledge Base) are left standing.

It exists because there is no other way to do this. `app.grant_access` creates
and updates accounts and cannot remove one; the Main Admin console deletes
students one batch at a time and has no screen at all for a faculty
account; and the Ops task menu is deliberately a FIXED LIST, because a
free-text command input there is remote code execution on the production
cluster. So a purge that has to happen on production has to be a named task on
that menu, written down, reviewed, and tested — which is this module.

WHAT IT IS FOR: handing a deployment over for real intake after it has been
demonstrated. Seeded logins, test students, voice-test leftovers, every
transcript and every recording made while proving the thing works — gone, in
one audited pass, without touching the institutional shape somebody spent an
afternoon typing in.

**Three properties make it safe to point at production.**

FIRST, EVERY TABLE HAS A WRITTEN VERDICT. `VERDICTS` below names all of them.
A table in the metadata that nobody classified ABORTS THE RUN — it is not
quietly kept (which would leave a student's records behind) and not quietly
emptied (which would destroy a catalogue somebody added last week). The next
person to add a table is made to decide, by a test that fails in CI and by this
module refusing to run. That is the whole reason the verdicts are a dict of 93
entries rather than a pair of prefixes and a `startswith`.

SECOND, THE FILES GO BEFORE THE ROWS. A row is the last pointer to a student's
resume, a faculty member's signature and a named student's recorded voice.
Delete the row first and a failed file delete leaves bytes on the volume that
nobody can find again — the one outcome that cannot be repaired afterwards.
This is `retention._delete_interview_audio`'s reasoning, applied to the other
five stores, and it is why `_destroy_files` runs first and why anything it
could not destroy is reported rather than swallowed.

THIRD, IT REFUSES TO LEAVE NOBODY BEHIND. The survivor is found by role, and
the run aborts unless there is EXACTLY ONE ADMIN. Zero means this deployment
has no Main Admin and the purge would lock every human out of the console
permanently. More than one contradicts the invariant `app.grant_access`
enforces at the other end, and picking one of them here would be this module
guessing which colleague keeps their job. Both are an operator's problem to fix
before the destruction, not during it.

DRY RUN IS THE DEFAULT. `--apply` is the only thing that deletes, and the
counts printed by a dry run are the same counts the real pass acts on. Read
them. `--apply` also demands `--i-understand-this-is-permanent`, because the
one thing a menu cannot express is that the operator meant it.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .db import Base, SessionLocal
from .models import user as user_model

# Importing the package registers every model on Base.metadata. Without it the
# verdict check below would pass against a HALF-POPULATED metadata and the
# purge would skip real tables while reporting success.
from . import models  # noqa: F401

log = logging.getLogger("reep.purge")

KEEP = "keep"
EMPTY = "empty"
SURVIVOR = "survivor"  # `users`: every row but the Main Admin's

#: Every table in the schema, and what happens to it. See the module docstring:
#: a table missing from here stops the run. Grouped by the reason, because the
#: reason is the part a reviewer has to check and a table name is not one.
VERDICTS: dict[str, str] = {
    # -- the institution, which is the point of keeping anything ------------
    # Somebody typed this in. It names no person and outlives every intake.
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
    "job_import_runs": KEEP,  # provenance for the postings above, names no student
    "interview_bank_questions": KEEP,
    "placement_criteria": KEEP,
    "registration_rules": KEEP,
    "alert_rule_configs": KEEP,
    "feature_overrides": KEEP,  # config, not a grant; emptying it would silently change behaviour
    "access_groups": KEEP,  # the shape of the governance groups; their members go
    # -- the voice platform's catalogue (its PEOPLE are below) --------------
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
    # -- the accounts -------------------------------------------------------
    "users": SURVIVOR,
    "students": EMPTY,
    "mentors": EMPTY,
    "alumni_profiles": EMPTY,
    "platform_candidates": EMPTY,
    "redesign_tenant_memberships": EMPTY,
    "access_group_members": EMPTY,
    "capability_grants": EMPTY,  # nobody is left to hold a granted screen
    # -- credentials and sign-in trail --------------------------------------
    "auth_tokens": EMPTY,
    "login_days": EMPTY,
    "email_verifications": EMPTY,
    # -- a student's own records --------------------------------------------
    "student_profiles": EMPTY,
    "student_skills": EMPTY,
    "student_badges": EMPTY,
    "student_milestones": EMPTY,
    "badge_evidence": EMPTY,
    "skill_claims": EMPTY,
    "capability_assessments": EMPTY,
    "academic_gaps": EMPTY,
    "academic_qualifications": EMPTY,
    "attendance_records": EMPTY,
    "subject_marks": EMPTY,
    "semester_results": EMPTY,
    "enrollments": EMPTY,
    "lab_sessions": EMPTY,
    "schedule_items": EMPTY,
    "mock_attempts": EMPTY,
    "alerts": EMPTY,
    "certification_progress": EMPTY,
    "english_baselines": EMPTY,
    "english_baseline_sections": EMPTY,
    "time_ledger_days": EMPTY,
    "time_ledger_cells": EMPTY,
    "time_sheet_entries": EMPTY,
    "resumes": EMPTY,
    "resume_profiles": EMPTY,
    "uploads": EMPTY,
    "job_applications": EMPTY,
    "placement_offers": EMPTY,
    "registrations": EMPTY,
    "registration_documents": EMPTY,
    # -- what staff wrote about them, and staff's own shelf -----------------
    "mentor_notes": EMPTY,
    "swoc_entries": EMPTY,
    "leave_requests": EMPTY,
    "staff_signatures": EMPTY,
    "staff_upskilling_certs": EMPTY,
    "redesign_mentor_notebook_entries": EMPTY,
    "redesign_mentor_notebook_entry_revisions": EMPTY,
    "redesign_mentor_notebook_actions": EMPTY,
    "redesign_mentor_notebook_attachments": EMPTY,
    # -- recordings and transcripts -----------------------------------------
    "interview_sessions": EMPTY,
    "interview_turns": EMPTY,
    "interview_evaluations": EMPTY,
    "interview_consents": EMPTY,
    "platform_call_sessions": EMPTY,
    "conversations": EMPTY,
    "messages": EMPTY,
    "agent_runs": EMPTY,
    "assistant_feedback": EMPTY,
    # -- logs ---------------------------------------------------------------
    "mail_logs": EMPTY,
    "redesign_audit_events": EMPTY,
    "redesign_outbox_events": EMPTY,
    "redesign_domain_jobs": EMPTY,
    "redesign_api_idempotency_keys": EMPTY,
}

#: `table -> column` holding a document_store name. The bytes live on the EFS
#: volume and no database delete touches them, so these are collected and
#: destroyed BEFORE the rows that point at them (see the docstring).
FILE_COLUMNS: dict[str, str] = {
    "uploads": "stored_name",
    "registration_documents": "stored_name",
    "staff_signatures": "stored_name",
    "staff_upskilling_certs": "stored_name",
    "alumni_profiles": "resume_stored_name",
}

#: KEPT tables that point at `users` with no ON DELETE clause. The institution
#: records who created it; that person is about to be deleted and the row must
#: outlive them. Nulled before the accounts go, or the delete fails on an FK
#: and takes the whole transaction with it.
CREATED_BY_COLUMNS: tuple[tuple[str, str], ...] = (
    ("colleges", "created_by_user_id"),
    ("departments", "created_by_user_id"),
    ("academic_courses", "created_by_user_id"),
    ("academic_specializations", "created_by_user_id"),
)


class PurgeRefused(RuntimeError):
    """Raised before anything is destroyed. Always an operator's problem."""


@dataclass
class Plan:
    """What a run would do. A dry run prints this and stops; a real run acts on
    exactly these numbers, so the two can be compared afterwards."""

    survivor_id: str
    survivor_email: str
    rows: dict[str, int] = field(default_factory=dict)
    files: int = 0
    audio_sessions: int = 0
    s3_objects: int = 0

    @property
    def total_rows(self) -> int:
        return sum(self.rows.values())


def _tables_in_delete_order():
    """Children first. `sorted_tables` is topological with parents first, which
    is the order to CREATE in; deleting wants the reverse."""
    return list(reversed(Base.metadata.sorted_tables))


def check_verdicts() -> None:
    """Every table classified, and no verdict for a table that is gone.

    Pinned by tests/test_purge_people.py so the failure lands in CI rather than
    on a production console at the moment somebody is trying to hand a
    deployment over.
    """
    known = {t.name for t in Base.metadata.sorted_tables}
    unclassified = sorted(known - set(VERDICTS) - {"alembic_version"})
    if unclassified:
        raise PurgeRefused(
            "These tables have no verdict in purge_people.VERDICTS: "
            + ", ".join(unclassified)
            + ". Classify each one KEEP or EMPTY before this can run - the purge "
            "will not guess."
        )
    stale = sorted(set(VERDICTS) - known)
    if stale:
        raise PurgeRefused(
            "purge_people.VERDICTS names tables that no longer exist: "
            + ", ".join(stale)
            + ". Remove them."
        )


def find_survivor(db: Session) -> tuple[str, str]:
    """The one account that lives. Found by ROLE, never by an address typed on
    a form: a purge that took an email argument would delete everybody the
    moment somebody fat-fingered it."""
    rows = db.execute(
        select(user_model.User.id, user_model.User.email).where(
            user_model.User.role == user_model.Role.ADMIN
        )
    ).all()
    if not rows:
        raise PurgeRefused(
            "No ADMIN account exists on this deployment, so there is nobody for "
            "the purge to keep and it would lock every human out of the console. "
            "Create the Main Admin first (Ops task > grant-access, role ADMIN)."
        )
    if len(rows) > 1:
        listed = ", ".join(e for _, e in rows)
        raise PurgeRefused(
            f"{len(rows)} ADMIN accounts exist ({listed}). There is exactly one "
            "Main Admin by design, and this module will not pick which of them "
            "survives. Demote the others to MENTOR first."
        )
    return rows[0][0], rows[0][1]


def build_plan(db: Session) -> Plan:
    check_verdicts()
    survivor_id, survivor_email = find_survivor(db)
    plan = Plan(survivor_id=survivor_id, survivor_email=survivor_email)

    for table in _tables_in_delete_order():
        verdict = VERDICTS.get(table.name)
        if verdict == KEEP or verdict is None:
            continue
        if verdict == SURVIVOR:
            n = db.scalar(
                select(func.count()).select_from(table).where(table.c.id != survivor_id)
            )
        else:
            n = db.scalar(select(func.count()).select_from(table))
        if n:
            plan.rows[table.name] = int(n)

    for name, column in FILE_COLUMNS.items():
        col = Base.metadata.tables[name].c[column]
        plan.files += int(
            db.scalar(select(func.count()).select_from(Base.metadata.tables[name]).where(col.is_not(None))) or 0
        )
    plan.audio_sessions = int(
        db.scalar(select(func.count()).select_from(Base.metadata.tables["interview_sessions"])) or 0
    )
    calls = Base.metadata.tables["platform_call_sessions"]
    plan.s3_objects = int(
        db.scalar(select(func.count()).select_from(calls).where(calls.c.recording_s3_key.is_not(None))) or 0
    )
    return plan


def _destroy_files(db: Session, plan: Plan) -> list[str]:
    """Bytes first, rows after. Returns what could NOT be destroyed; each one is
    logged as it happens, because a list of forty names at the end is not how an
    operator finds the one volume that is mounted read-only."""
    from .document_store import delete as delete_stored

    failures: list[str] = []

    for name, column in FILE_COLUMNS.items():
        table = Base.metadata.tables[name]
        col = table.c[column]
        for (stored,) in db.execute(select(col).where(col.is_not(None))).all():
            try:
                delete_stored(stored)
            except FileNotFoundError:
                pass  # already gone is the outcome we wanted
            except Exception as exc:  # noqa: BLE001 — reported, never fatal
                log.error("Could not delete %s file %s: %s", name, stored, exc)
                failures.append(f"{name}:{stored}")

    # Interview audio through its own store, for EVERY session and never only
    # the ones whose row admits to having audio — retention._delete_interview_audio
    # documents why the filesystem is the authority here, not the columns.
    try:
        from .interview_audio import delete_session_audio
    except ImportError:  # a slim image without the store
        delete_session_audio = None  # type: ignore[assignment]
    if delete_session_audio is not None:
        sessions = Base.metadata.tables["interview_sessions"]
        for sid, path in db.execute(select(sessions.c.id, sessions.c.audio_path)).all():
            try:
                delete_session_audio(sid, path)
            except Exception as exc:  # noqa: BLE001
                log.error("Could not delete interview audio for %s: %s", sid, exc)
                failures.append(f"interview_audio:{sid}")

    # Platform call recordings in S3. No bucket configured means the platform
    # never uploaded anything, and that is a normal deployment, not an error.
    try:
        from .voice_platform.storage.s3 import recording_store
    except ImportError:
        recording_store = None  # type: ignore[assignment]
    if recording_store is not None:
        store = recording_store()
        if store is not None:
            calls = Base.metadata.tables["platform_call_sessions"]
            keys = db.execute(
                select(calls.c.recording_s3_key).where(calls.c.recording_s3_key.is_not(None))
            ).all()
            for (key,) in keys:
                try:
                    store.delete(key)
                except Exception as exc:  # noqa: BLE001
                    log.error("Could not delete S3 recording %s: %s", key, exc)
                    failures.append(f"s3:{key}")
        elif plan.s3_objects:
            log.warning(
                "%d call session(s) name an S3 recording but no recordings bucket "
                "is configured here, so those objects were NOT deleted. Their rows "
                "are about to go, which makes the objects undiscoverable - set "
                "PLATFORM_RECORDINGS_BUCKET and run again if they matter.",
                plan.s3_objects,
            )
    return failures


def _null_created_by(db: Session, plan: Plan) -> None:
    """The institution records who created it. That person is going, and the
    row must outlive them: these four FKs carry no ON DELETE, so without this
    the accounts delete fails on a constraint and takes the pass with it."""
    for name, column in CREATED_BY_COLUMNS:
        table = Base.metadata.tables[name]
        db.execute(
            update(table)
            .where(table.c[column].is_not(None), table.c[column] != plan.survivor_id)
            .values(**{column: None})
        )


def _delete_rows(db: Session, plan: Plan) -> None:
    """Every EMPTY table, children first, then the accounts.

    SEPARATE FROM `execute` AND WITHOUT A COMMIT ON PURPOSE. This is the half
    whose correctness is a property of the ORDER, and the only honest way to
    test an order against 93 real foreign keys is to run it against the real
    schema and roll back — which a function that commits cannot offer.
    tests/test_purge_people.py does exactly that.
    """
    for table in _tables_in_delete_order():
        verdict = VERDICTS.get(table.name)
        if verdict == EMPTY:
            db.execute(delete(table))
        elif verdict == SURVIVOR:
            db.execute(delete(table).where(table.c.id != plan.survivor_id))


def execute(db: Session, plan: Plan) -> list[str]:
    """Destroy. One transaction for the rows, so the database is either purged
    or untouched; the files are gone before it opens, because a filesystem has
    no transaction to join."""
    failures = _destroy_files(db, plan)
    _null_created_by(db, plan)
    _delete_rows(db, plan)
    db.commit()
    return failures


def _stamp(db: Session, plan: Plan) -> None:
    """One audit row, written AFTER the sweep that empties the audit table, so
    the deployment's history starts with the fact that it was emptied and by
    whom. Best-effort: a purge that worked must not be reported as failed
    because its own receipt would not write."""
    try:
        from .models.redesign import AuditEvent

        db.add(
            AuditEvent(
                actor_user_id=plan.survivor_id,
                entity_type="deployment",
                entity_id=plan.survivor_id,
                action="PURGE",
                after_json={
                    "purged_at": datetime.now(timezone.utc).isoformat(),
                    "kept_account": plan.survivor_email,
                    "rows_deleted": plan.total_rows,
                    "tables_emptied": sorted(plan.rows),
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


def _report(plan: Plan, *, applied: bool) -> None:
    head = "PURGED" if applied else "DRY RUN - nothing was deleted"
    log.info("%s", head)
    log.info("Account kept: %s (%s)", plan.survivor_email, plan.survivor_id)
    if not plan.rows:
        log.info("Nothing to delete: this deployment holds no other accounts or records.")
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
    kept = sorted(n for n, v in VERDICTS.items() if v == KEEP)
    log.info("Kept intact (%d tables): %s", len(kept), ", ".join(kept))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.purge_people",
        description=(
            "Delete every account except the Main Admin, everything those "
            "accounts did, and every recording and transcript. Keeps the "
            "institutional hierarchy, the catalogues and the Knowledge Base."
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
            "the audio and documents are removed from the volume as well."
        )
        return 2

    try:
        with SessionLocal() as db:
            plan = build_plan(db)
            if not args.apply:
                _report(plan, applied=False)
                log.info("Re-run with --apply --i-understand-this-is-permanent to do it.")
                return 0
            failures = execute(db, plan)
            _stamp(db, plan)
            _report(plan, applied=True)
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
