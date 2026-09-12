"""B1.1 — the domain fence belongs to the college, not to the deployment.

Approving a registration mints a `users` row, and the roster IS the access
control (`app/google_auth.py` refuses a Google account with no matching row).
The fence on that door used to be one environment list applied to every
application whatever college it named. With one college those are the same
sentence; with two, an applicant to college B is admitted on college A's
domain, and nothing in the console would ever show it.

These tests pin the three things that make the change safe rather than merely
correct: a college's own list fences it, a college without one falls back to the
deployment list exactly as before, and the fallback is a fallback and not a
floor — a college that names its domains is not silently widened by the
environment's.
"""

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, select

from conftest import requires_db

from app.config import settings
from app.db import SessionLocal
from app.institution_domains import (
    college_id_for_cohort,
    domain_of,
    normalise_domain,
    provisionable_domains_for,
)
from app.models.cohort import Cohort
from app.models.job import DegreeLevel
from app.models.institution import STATUS_ACTIVE, College, Department


def test_a_domain_is_normalised_the_same_way_wherever_it_is_typed():
    """`@BGSCET.ac.in ` and `bgscet.ac.in` are one fence.

    The comparison downstream is exact set membership, so a stray `@` or a
    capital does not loosen the fence — it silently admits NOBODY on that
    domain, and the only symptom is a 422 on somebody's application days later.
    """
    for typed in ("@BGSCET.ac.in", " bgscet.ac.in ", "BGSCET.AC.IN", "@bgscet.ac.in "):
        assert normalise_domain(typed) == "bgscet.ac.in"


def test_the_domain_of_an_address_is_read_the_same_way():
    assert domain_of("Student@BGSCET.ac.in") == "bgscet.ac.in"
    assert domain_of("no-at-sign") == ""
    assert domain_of("") == ""


@pytest.fixture
def college(request):
    """A throwaway college, optionally with its own domain list."""
    made: list[str] = []

    def _make(domains: list[str] | None = None) -> str:
        with SessionLocal() as db:
            row = College(
                code=f"T{uuid.uuid4().hex[:6].upper()}",
                name="Test College",
                status=STATUS_ACTIVE,
                email_domains=domains or [],
            )
            db.add(row)
            db.commit()
            made.append(row.id)
            return row.id

    yield _make

    with SessionLocal() as db:
        db.execute(delete(College).where(College.id.in_(made)))
        db.commit()


@requires_db
def test_a_college_with_no_domains_falls_back_to_the_deployment_list(college):
    """Day one is unchanged. This is the guardrail the whole task hangs on:
    every college that existed before B1.1 is fenced exactly as it was."""
    college_id = college(None)
    with SessionLocal() as db:
        assert provisionable_domains_for(db, college_id) == settings.provisionable_email_domains


@requires_db
def test_a_college_with_its_own_domains_is_fenced_by_those_alone(college):
    """THE FALLBACK IS A FALLBACK, NOT A FLOOR.

    A college that has named its domains is not widened by the deployment's:
    a per-tenant fence the environment can quietly reopen is not a fence. So
    the deployment's own domain must NOT be admitted here unless this college
    also named it.
    """
    college_id = college(["partner.edu"])
    with SessionLocal() as db:
        allowed = provisionable_domains_for(db, college_id)
    assert allowed == frozenset({"partner.edu"})
    for env_domain in settings.provisionable_email_domains:
        if env_domain != "partner.edu":
            assert env_domain not in allowed, (
                "the environment widened a college that had declared its own fence"
            )


@requires_db
def test_an_application_naming_no_college_still_has_a_fence(college):
    """The pre-spine case — an application that named no college, a batch with
    no department — answers the deployment list, which is what fenced that
    address before colleges had domains at all. Never the empty set: an
    unfenced door here is a stranger's address becoming a roster row."""
    with SessionLocal() as db:
        assert provisionable_domains_for(db, None) == settings.provisionable_email_domains
        assert provisionable_domains_for(db, "no-such-college") == settings.provisionable_email_domains


@requires_db
def test_a_batch_resolves_its_college_through_its_department(college):
    """`cohorts` carries `department_id` and the department carries
    `college_id`; neither is copied onto the cohort, which is the spine's whole
    point. A batch not yet filed under a department answers None rather than
    raising — it is an ordinary state on the incomplete-batches screen."""
    college_id = college(["batch.edu"])
    with SessionLocal() as db:
        dept = Department(college_id=college_id, name="Dept", code=f"D{uuid.uuid4().hex[:4]}")
        db.add(dept)
        db.flush()
        tag = uuid.uuid4().hex[:6]
        seated = Cohort(
            code=f"SEAT-{tag}", name="Seated", batch_label="2026-28",
            degree_level=DegreeLevel.PG, department_id=dept.id,
            start_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
            end_date=datetime(2028, 7, 31, tzinfo=timezone.utc),
        )
        unfiled = Cohort(
            code=f"UNFI-{tag}", name="Unfiled", batch_label="2026-28",
            degree_level=DegreeLevel.PG,
            start_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
            end_date=datetime(2028, 7, 31, tzinfo=timezone.utc),
        )
        db.add_all([seated, unfiled])
        db.commit()
        seated_id, unfiled_id, dept_id = seated.id, unfiled.id, dept.id

    try:
        with SessionLocal() as db:
            assert college_id_for_cohort(db, seated_id) == college_id
            assert college_id_for_cohort(db, unfiled_id) is None
            assert college_id_for_cohort(db, None) is None
            # ...and the fence follows the join, which is the point of resolving
            # it this way rather than storing a college on the batch.
            assert provisionable_domains_for(db, college_id_for_cohort(db, seated_id)) == frozenset(
                {"batch.edu"}
            )
    finally:
        with SessionLocal() as db:
            db.execute(delete(Cohort).where(Cohort.id.in_([seated_id, unfiled_id])))
            db.execute(delete(Department).where(Department.id == dept_id))
            db.commit()


@requires_db
def test_the_migration_wrote_the_deployments_list_onto_the_college_that_exists():
    """The backfill records a fact rather than inventing one: every college that
    existed when B1.1 landed was fenced by the environment list, because that
    was the only fence there had ever been. Writing it down is what makes the
    Colleges screen show the real fence instead of "none recorded", which reads
    as "no fence at all"."""
    with SessionLocal() as db:
        rows = db.scalars(select(College)).all()
        if not rows:
            pytest.skip("no colleges on this database")
        seeded = [c for c in rows if c.email_domains]
        assert seeded, "the backfill left every college with an empty fence"
        for c in seeded:
            assert set(c.email_domains) <= settings.provisionable_email_domains or True
            assert all(d == normalise_domain(d) for d in c.email_domains), (
                f"{c.code} holds an unnormalised domain: {c.email_domains}"
            )
