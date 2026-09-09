"""Governance: capability grants, access groups and student feature overrides.

The properties pinned here are the ones whose failure is SILENT — the endpoint
still returns 200, the console still renders, and the damage is somebody seeing a
student they should not, or a feature nobody can explain being off.

  * A capability never widens rule 2. It decides WHICH SCREENS; rule 2 decides
    WHICH STUDENTS. Both must pass, and no grant relaxes the second.
  * The baseline takes nothing away. Introducing deny-by-default grants must not
    remove a mentor's own mentee log on the deploy that ships them.
  * The reason floor is enforced in the API, not only in the form.
  * The most specific feature override wins, so an exception for one student does
    not require deleting the rule covering their whole specialization.
  * A STUDENT reaches none of it.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from conftest import requires_db

from app.db import SessionLocal
from app.governance import (
    ROLE_BASELINE,
    capabilities_for,
    feature_enabled,
    granted_capabilities,
)
from app.models.governance import (
    CAPABILITIES,
    AccessGroup,
    AccessGroupMember,
    CapabilityGrant,
    CapabilityScope,
    FeatureOverride,
    FeatureScope,
    SubjectKind,
)
from app.models.user import Role

GOV = "/api/admin/governance"
REASON = "Needed for the December placement review; presenting cohort readiness."


@pytest.fixture
def admin(make_user):
    """The Main Admin - the only account Governance admits."""
    return make_user(f"gov-adm-{uuid.uuid4().hex[:4]}", Role.ADMIN)


@pytest.fixture
def mentor(make_user):
    return make_user(f"gov-men-{uuid.uuid4().hex[:4]}", Role.MENTOR)


@pytest.fixture
def cleanup():
    """Governance rows are not owned by make_user, so they outlive it."""
    made: dict[str, list[str]] = {"grants": [], "groups": [], "overrides": []}
    yield made
    with SessionLocal() as db:
        for gid in made["grants"]:
            row = db.get(CapabilityGrant, gid)
            if row is not None:
                db.delete(row)
        for oid in made["overrides"]:
            row = db.get(FeatureOverride, oid)
            if row is not None:
                db.delete(row)
        for gid in made["groups"]:
            db.query(AccessGroupMember).filter(AccessGroupMember.group_id == gid).delete()
            row = db.get(AccessGroup, gid)
            if row is not None:
                db.delete(row)
        db.commit()


# --------------------------------------------------------------------------- #

def test_the_catalogue_is_code_and_every_key_is_unique() -> None:
    """No database needed: the catalogue is a constant, and a duplicate key would
    make `CAPABILITIES_BY_KEY` silently shorter than the tuple it came from —
    one capability shadowing another with a different scope."""
    keys = [c.key for c in CAPABILITIES]
    assert len(keys) == len(set(keys)), "duplicate capability key"
    programme = {c.key for c in CAPABILITIES if c.scope is CapabilityScope.PROGRAMME}
    # These four cannot be narrowed by a mentor group — they are cross-cohort by
    # nature, and mislabelling one SCOPED would hand over the programme while the
    # console painted it green.
    for key in ("admin.analytics", "admin.exports", "admin.institution", "admin.mentors"):
        assert key in programme, f"{key} must be PROGRAMME scope"


def test_the_baseline_takes_nothing_away_from_a_mentor() -> None:
    """A deny-by-default rollout would have removed every mentor's own mentee log
    on the deploy that shipped it. The baseline is what stops that."""
    mentor_caps = ROLE_BASELINE["MENTOR"]
    assert "mentor.mentees" in mentor_caps
    assert "student.records" in mentor_caps
    # ...and the programme-wide set is NOT inherited: that is what a grant is for.
    assert "admin.analytics" not in mentor_caps
    assert "admin.exports" not in mentor_caps
    assert ROLE_BASELINE["DIRECTOR"] >= mentor_caps
    assert ROLE_BASELINE["STUDENT"] == frozenset()


@requires_db
def test_a_student_reaches_none_of_it(client, make_user) -> None:
    stu = make_user(f"gov-stu-{uuid.uuid4().hex[:4]}")
    for method, path in (
        ("get", f"{GOV}/catalogue"),
        ("get", f"{GOV}/hierarchy"),
        ("get", f"{GOV}/staff"),
        ("get", f"{GOV}/grants"),
        ("get", f"{GOV}/groups"),
        ("get", f"{GOV}/features"),
    ):
        r = getattr(client, method)(path, headers=stu.headers)
        assert r.status_code == 403, f"{path} let a STUDENT in: {r.status_code}"
    r = client.post(f"{GOV}/grants", headers=stu.headers,
                    json={"capability": "admin.analytics", "user_ids": [], "reason": REASON})
    assert r.status_code == 403


@requires_db
def test_a_reason_below_the_floor_is_refused_by_the_api(client, admin, mentor, cleanup) -> None:
    """The floor is in the API, not only the form. A second client, a script or a
    curl must not be able to write an unauditable grant."""
    r = client.post(f"{GOV}/grants", headers=admin.headers,
                    json={"capability": "admin.analytics", "user_ids": [mentor.user_id], "reason": "ok"})
    assert r.status_code == 422, r.text
    assert "20 characters" in r.text

    r = client.post(f"{GOV}/grants", headers=admin.headers,
                    json={"capability": "admin.analytics", "user_ids": [mentor.user_id], "reason": REASON})
    assert r.status_code == 201, r.text
    cleanup["grants"] += [g["id"] for g in r.json()]


@requires_db
def test_one_request_grants_to_several_people(client, admin, make_user, cleanup) -> None:
    """The console's multi-select, and one audit row per person rather than one
    for the batch — "why does Dr. Rao hold this" must be answerable from a row
    she is named in."""
    a = make_user(f"gov-a-{uuid.uuid4().hex[:4]}", Role.MENTOR)
    b = make_user(f"gov-b-{uuid.uuid4().hex[:4]}", Role.MENTOR)
    r = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "admin.analytics", "user_ids": [a.user_id, b.user_id], "reason": REASON})
    assert r.status_code == 201, r.text
    rows = r.json()
    cleanup["grants"] += [g["id"] for g in rows]
    assert len(rows) == 2
    assert {g["subject_id"] for g in rows} == {a.user_id, b.user_id}
    assert all(g["reason"] == REASON for g in rows), "the batch reason is copied onto every row"
    assert all(g["scope"] == "PROGRAMME" for g in rows)

    # Re-granting is a no-op, not a duplicate: two live rows for one pair make
    # revocation a question of which one.
    again = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "admin.analytics", "user_ids": [a.user_id], "reason": REASON})
    assert again.status_code == 201 and again.json() == []


@requires_db
def test_a_grant_adds_a_screen_and_a_group_hands_it_to_its_members(
    client, admin, mentor, make_user, cleanup
) -> None:
    with SessionLocal() as db:
        assert "admin.analytics" not in granted_capabilities(db, mentor.user_id)

    r = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "admin.analytics", "user_ids": [mentor.user_id], "reason": REASON})
    cleanup["grants"] += [g["id"] for g in r.json()]

    with SessionLocal() as db:
        held = capabilities_for(db, {"userId": mentor.user_id, "role": "MENTOR"})
        assert "admin.analytics" in held, "the grant did not take effect"
        assert "mentor.mentees" in held, "the baseline was lost when a grant appeared"

    # Now the group path: a second mentor inherits by joining, with no grant of
    # their own. That is the reason groups exist.
    grp = client.post(f"{GOV}/groups", headers=admin.headers,
                      json={"name": f"Coordinators {uuid.uuid4().hex[:6]}"})
    assert grp.status_code == 201, grp.text
    gid = grp.json()["id"]
    cleanup["groups"].append(gid)

    r = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "admin.exports", "group_ids": [gid], "reason": REASON})
    cleanup["grants"] += [g["id"] for g in r.json()]

    joiner = make_user(f"gov-join-{uuid.uuid4().hex[:4]}", Role.MENTOR)
    with SessionLocal() as db:
        assert "admin.exports" not in granted_capabilities(db, joiner.user_id)

    add = client.post(f"{GOV}/groups/{gid}/members", headers=admin.headers,
                      json={"user_ids": [joiner.user_id], "reason": REASON})
    assert add.status_code == 200, add.text

    with SessionLocal() as db:
        assert "admin.exports" in granted_capabilities(db, joiner.user_id), \
            "joining the group did not hand over its capability"


@requires_db
def test_a_grant_never_widens_which_students_a_mentor_reaches(
    client, admin, mentor, make_user, cleanup
) -> None:
    """THE SAFETY PROPERTY. A capability decides which SCREENS; rule 2 decides
    which STUDENTS. `mentor` here has no Mentor group at all — the account rule 2
    exists to exclude — and holding a student-record capability must not give
    them a single student.
    """
    stu = make_user(f"gov-out-{uuid.uuid4().hex[:4]}")
    r = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "student.records", "user_ids": [mentor.user_id], "reason": REASON})
    cleanup["grants"] += [g["id"] for g in r.json()]

    with SessionLocal() as db:
        assert "student.records" in capabilities_for(db, {"userId": mentor.user_id, "role": "MENTOR"})

    # Rule 2 is unmoved: the groupless mentor still reaches nobody. Asserted
    # through the real endpoint, because that is where the gate actually runs.
    listing = client.get("/api/mentor/mentees", headers=mentor.headers)
    assert listing.status_code == 200
    assert listing.json() == [], "a capability handed a groupless mentor a mentee"

    sid = None
    with SessionLocal() as db:
        from app.models.user import Student
        row = db.query(Student).filter(Student.user_id == stu.user_id).one_or_none()
        sid = row.id if row else None
    if sid:
        notes = client.get(f"/api/mentor/students/{sid}/notes", headers=mentor.headers)
        assert notes.status_code == 404, "a capability reached a student outside the mentor's group"


@requires_db
def test_a_revoked_grant_stops_working_and_the_row_survives(
    client, admin, mentor, cleanup
) -> None:
    r = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "admin.placement", "user_ids": [mentor.user_id], "reason": REASON})
    gid = r.json()[0]["id"]
    cleanup["grants"].append(gid)

    with SessionLocal() as db:
        assert "admin.placement" in granted_capabilities(db, mentor.user_id)

    rev = client.post(f"{GOV}/grants/{gid}/revoke", headers=admin.headers,
                      json={"reason": "Moved off the placement cell to full-time teaching."})
    assert rev.status_code == 200, rev.text

    with SessionLocal() as db:
        assert "admin.placement" not in granted_capabilities(db, mentor.user_id)
        row = db.get(CapabilityGrant, gid)
        assert row is not None, "the grant was deleted; who held it in March is now unanswerable"
        assert row.revoked_at is not None and row.revoke_reason

    # Revoking twice is a conflict, not a second silent success.
    again = client.post(f"{GOV}/grants/{gid}/revoke", headers=admin.headers,
                        json={"reason": "Moved off the placement cell to full-time teaching."})
    assert again.status_code == 409


@requires_db
def test_the_most_specific_feature_override_wins(make_user, cleanup) -> None:
    """Switch the voice interviewer off for a cohort, back on for one student in
    it. Both rules stay; the student-level one wins. Deleting the broader rule to
    make the exception would turn the feature on for everyone else in the cohort.
    """
    from app.models.cohort import Cohort
    from app.models.job import DegreeLevel
    from app.models.user import Student

    stu = make_user(f"gov-feat-{uuid.uuid4().hex[:4]}")
    with SessionLocal() as db:
        student = db.query(Student).filter(Student.user_id == stu.user_id).one()
        tag = uuid.uuid4().hex[:6]
        cohort = Cohort(
            code=f"GOV-{tag}", name=f"gov-batch-{tag}", batch_label="2024-26",
            degree_level=DegreeLevel.PG,
            start_date=datetime(2024, 8, 1, tzinfo=timezone.utc),
            end_date=datetime(2026, 6, 30, tzinfo=timezone.utc),
        )
        db.add(cohort)
        db.flush()
        student.cohort_id = cohort.id
        db.commit()
        sid, cid = student.id, cohort.id

    with SessionLocal() as db:
        assert feature_enabled(db, sid, "student.assistant") is True, "features are on by default"

        off = FeatureOverride(feature="student.assistant", scope=FeatureScope.COHORT,
                              target_id=cid, enabled=False, reason=REASON)
        db.add(off)
        db.commit()
        cleanup["overrides"].append(off.id)

    with SessionLocal() as db:
        assert feature_enabled(db, sid, "student.assistant") is False, "the cohort rule did not apply"

        back = FeatureOverride(feature="student.assistant", scope=FeatureScope.STUDENT,
                               target_id=sid, enabled=True, reason=REASON)
        db.add(back)
        db.commit()
        cleanup["overrides"].append(back.id)

    with SessionLocal() as db:
        assert feature_enabled(db, sid, "student.assistant") is True, \
            "the student-level exception lost to the cohort rule"
        # And the broader rule is still there for everyone else.
        assert db.get(FeatureOverride, cleanup["overrides"][0]) is not None

    with SessionLocal() as db:
        for oid in cleanup["overrides"]:
            row = db.get(FeatureOverride, oid)
            if row:
                db.delete(row)
        db.commit()
        student = db.get(Student, sid)
        if student:
            student.cohort_id = None
        db.commit()
        c = db.get(Cohort, cid)
        if c:
            db.delete(c)
        db.commit()
    cleanup["overrides"].clear()


@requires_db
def test_a_granted_capability_opens_the_analytics_endpoints(client, admin, mentor, cleanup) -> None:
    """THE WIRING. Until this, a grant was recorded and nothing checked it — a
    mentor granted Analytics was still stopped by role at the API, at the route
    guard and in the nav. This pins the API half end to end, and the fact that
    it takes effect WITHOUT a new sign-in: capabilities are resolved live, not
    carried in the cookie, so the session minted before the grant sees it.
    """
    # Before: a mentor is refused, and /me says they hold no admin capability.
    r = client.get("/api/director/analytics-summary", headers=mentor.headers)
    assert r.status_code == 403, r.text
    me = client.get("/api/auth/me", headers=mentor.headers).json()
    assert "admin.analytics" not in me["capabilities"]
    assert "mentor.mentees" in me["capabilities"], "the baseline must be reported too"

    r = client.post(f"{GOV}/grants", headers=admin.headers, json={
        "capability": "admin.analytics", "user_ids": [mentor.user_id], "reason": REASON})
    assert r.status_code == 201, r.text
    cleanup["grants"] += [g["id"] for g in r.json()]

    # After, on the SAME cookie: the endpoint opens and /me reports it.
    r = client.get("/api/director/analytics-summary", headers=mentor.headers)
    assert r.status_code == 200, r.text
    me = client.get("/api/auth/me", headers=mentor.headers).json()
    assert "admin.analytics" in me["capabilities"]

    # An admin never needed a grant — the baseline carries it.
    assert client.get("/api/director/analytics-summary", headers=admin.headers).status_code == 200


@requires_db
def test_interview_audio_is_a_capability_a_director_must_be_granted(client, admin, make_user, cleanup) -> None:
    """The recording gate: ADMIN by baseline, DIRECTOR only by explicit grant.

    interview_records.py had `_DEVELOPERS = {"ADMIN"}` and a docstring refusing
    to widen to require_director - every placement account would then hold the
    most sensitive bytes REEP stores. That asymmetry must SURVIVE the move to a
    capability, which is why DIRECTOR's baseline excludes exactly this one.

    404, not 200, is the pass signal past the gate: the session id here is
    invented, and the route answers 404 for "no such recording" identically to
    "not a real id", by design. What matters is that 403 becomes 404 - the gate
    opened - and that it does so for the Main Admin with no grant and for a
    DIRECTOR only after one, which only the Main Admin can give.
    """
    from app.models.user import Student

    director = make_user(f"gov-dir-{uuid.uuid4().hex[:4]}", Role.DIRECTOR)
    stu = make_user(f"gov-aud-{uuid.uuid4().hex[:4]}")
    with SessionLocal() as db:
        sid = db.query(Student).filter(Student.user_id == stu.user_id).one().id
    url = f"/api/mentor/students/{sid}/interviews/{uuid.uuid4().hex}/audio"

    # A director, ungranted: refused - and told what to ask for.
    r = client.get(url, headers=director.headers)
    assert r.status_code == 403, r.text
    assert "Interview audio" in r.text and "Governance" in r.text

    # The Main Admin, no grant: through on the baseline.
    assert client.get(url, headers=admin.headers).status_code == 404

    # A director cannot grant it to themselves - Governance is the Main Admin's.
    body = {"capability": "admin.interview_audio", "user_ids": [director.user_id], "reason": REASON}
    r = client.post(f"{GOV}/grants", headers=director.headers, json=body)
    assert r.status_code == 403 and "Main Admin" in r.text, r.text
    r = client.post(f"{GOV}/grants", headers=admin.headers, json=body)
    assert r.status_code == 201, r.text
    cleanup["grants"] += [g["id"] for g in r.json()]

    # Same cookie, no re-login: the gate now opens for the director too.
    assert client.get(url, headers=director.headers).status_code == 404
    assert "admin.interview_audio" in client.get("/api/auth/me", headers=director.headers).json()["capabilities"]


@requires_db
def test_governance_is_the_main_admins_alone(client, admin, mentor, make_user, cleanup) -> None:
    """REEP has one Main Admin, and deciding what faculty may see is that
    account's instrument alone. A DIRECTOR holds every console screen by
    baseline and is still refused here, by name - so the console never grows a
    second hand that can widen access."""
    director = make_user(f"gov-dir-{uuid.uuid4().hex[:4]}", Role.DIRECTOR)
    body = {"capability": "admin.analytics", "user_ids": [mentor.user_id], "reason": REASON}
    for who in (director, mentor):
        r = client.post(f"{GOV}/grants", headers=who.headers, json=body)
        assert r.status_code == 403 and "Main Admin" in r.text, r.text
        assert client.get(f"{GOV}/catalogue", headers=who.headers).status_code == 403
    r = client.post(f"{GOV}/grants", headers=admin.headers, json=body)
    assert r.status_code == 201, r.text
    cleanup["grants"] += [g["id"] for g in r.json()]
