"""Interview Engine v3 §7 — who may read an interview record.

THIS FILE EXISTS FOR AGENTS.md RULE 2, and the three cases it exists for are
named as three tests you can find by searching for the word "mentor":

  * test_mentor_in_the_students_group_can_read_the_interview
  * test_mentor_in_a_different_group_gets_404
  * test_mentor_with_no_mentor_group_gets_404_and_never_the_whole_programme

A MENTOR with no `Mentor` group is the account the rule exists to exclude, and
"no group" has been read as "no filter, therefore everybody" in this codebase
before — app/routers/leave.py's header records that exact bug, found by the
2026-08 audit, in which a group-less mentor listed every leave request programme
wide with the reason attached. An interview transcript is the same class of
material: fifteen minutes of a named student's unrehearsed speech, plus a score.

The other axis is horizontal. `_assert_can_access_student` is given the PATH's
student id and can say nothing at all about a session id, so every by-id staff
endpoint re-checks that the row's own subject is that student
(test_a_mentor_cannot_read_another_groups_session_id_through_their_own_student).
Gating on one argument and loading by another is a privilege bug wearing a
correct-looking first line.

And §5.4's split: the student sees every score of their own report, staff see
the same through the group gate, and `raw_response` — the model's private
reasoning about the student — is DIRECTOR/ADMIN only. Three tests pin all three
audiences, because the tempting "simplification" here is one payload with a
conditionally-filled field.

WHY THIS BUILDS ITS OWN APP. The routers are included from `app/main.py`, which
belongs to another step of this rollout, so a test against the shared `client`
fixture would pass or fail on whether that landed rather than on anything about
access control. The app here mounts exactly the two routers under test with
their own declared prefixes, which is also what makes
test_the_routers_are_mounted_at_the_documented_paths a separate, honest check of
the wiring rather than a hidden precondition of everything else.

Sessions are minted directly with `create_session_token` rather than posted
through `POST /api/auth/login`: the claim set IS the input to every gate under
test (`role`, `studentId`, `mentorId`), and building it by hand is the only way
to express "a MENTOR with no group" — a mentor with no `Mentor` row — without
also asserting things about how sign-in composes it.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from conftest import requires_db

from app.db import SessionLocal
from app.models.interview import (
    InterviewConsent,
    InterviewEvaluation,
    InterviewSession,
    InterviewTurn,
)
from app.models.user import Mentor, Role, Student, User
from app.security import SESSION_COOKIE, create_session_token

RAW_RESPONSE = "MODEL-PRIVATE-REASONING-ABOUT-THE-STUDENT"


def _auth(**claims) -> dict:
    """A signed session cookie carrying exactly these claims."""
    return {"Cookie": f"{SESSION_COOKIE}={create_session_token(claims)}"}


@pytest.fixture(scope="module")
def api():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import interview_records

    app = FastAPI()
    app.include_router(interview_records.student_router)
    app.include_router(interview_records.staff_router)
    with TestClient(app) as c:
        yield c


class _World:
    """The cast. Attribute names are the roles the tests read out loud."""


@pytest.fixture
def world():
    """Two mentor groups, a group-less mentor, a director, and one interview
    each for two students who are in DIFFERENT groups.

    Everything is thrown away afterwards. Nothing is borrowed from the dev seed:
    these tests assert on exact list contents, and a seeded student who happened
    to share a mentor would make a passing test meaningless.
    """
    w = _World()
    tag = uuid.uuid4().hex[:8]
    with SessionLocal() as db:

        def _user(label: str, role: Role) -> User:
            u = User(
                email=f"ivacc-{label}-{tag}@bgscet.ac.in",
                name=f"Interview Access {label}",
                role=role,
                password_hash="x",
            )
            db.add(u)
            db.flush()
            return u

        mentor_a_user = _user("mentor-a", Role.MENTOR)
        mentor_b_user = _user("mentor-b", Role.MENTOR)
        # A MENTOR with NO Mentor row: the session carries no mentorId, which is
        # exactly the "no group" state rule 2 is written about.
        groupless_user = _user("mentor-none", Role.MENTOR)
        director_user = _user("director", Role.DIRECTOR)
        student_user = _user("student", Role.STUDENT)
        other_user = _user("other-student", Role.STUDENT)
        # A STUDENT whose user row has no Student row behind it, so their
        # session carries no studentId claim.
        studentless_user = _user("no-student-row", Role.STUDENT)

        mentor_a = Mentor(user_id=mentor_a_user.id)
        mentor_b = Mentor(user_id=mentor_b_user.id)
        db.add_all([mentor_a, mentor_b])
        db.flush()

        student = Student(user_id=student_user.id, mentor_id=mentor_a.id)
        other = Student(user_id=other_user.id, mentor_id=mentor_b.id)
        db.add_all([student, other])
        db.flush()

        started = datetime.now(timezone.utc) - timedelta(minutes=20)
        interview = InterviewSession(
            student_id=student.id,
            specialization="hr",
            status="completed",
            terminal_reason="1000 Interview complete",
            final_phase="wrap_up",
            answers_accepted=5,
            turns_emitted=11,
            turns_persisted=11,
            close_code=1000,
            conn_id=uuid.uuid4().hex[:12],
            started_at=started,
            heartbeat_at=started,
            ended_at=started + timedelta(minutes=14),
        )
        other_interview = InterviewSession(
            student_id=other.id,
            specialization="ba",
            status="completed",
            close_code=1000,
            started_at=started,
            heartbeat_at=started,
        )
        db.add_all([interview, other_interview])
        db.flush()

        db.add_all(
            [
                InterviewTurn(
                    interview_session_id=interview.id,
                    seq=1,
                    speaker="interviewer",
                    phase="opening",
                    content="Tell me about yourself.",
                    transcription_status="not_applicable",
                    provider_turn_id="a:resp_1",
                ),
                InterviewTurn(
                    interview_session_id=interview.id,
                    seq=2,
                    speaker="student",
                    phase="opening",
                    content="I led the campus fintech club.",
                    transcription_status="ok",
                    answer_quality="accepted",
                    counted_as_answer=True,
                    provider_turn_id="u:item_1",
                ),
                # The turn L4 is about: the transcriber never answered, so the
                # content is '' and the STATUS carries the fact. If this row is
                # missing from a transcript payload the table has failed at the
                # one job it was added for.
                InterviewTurn(
                    interview_session_id=interview.id,
                    seq=3,
                    speaker="student",
                    phase="probing",
                    content="",
                    transcription_status="timeout",
                    provider_turn_id="u:item_2",
                ),
            ]
        )
        db.add(
            InterviewEvaluation(
                interview_session_id=interview.id,
                report_status="ok",
                overall_score=68,
                communication_score=71,
                # Left NULL deliberately: a missing score and a zero mean
                # opposite things, and the payload has to be able to carry the
                # difference.
                domain_score=None,
                structure_score=60,
                strengths=["Clear structure", "Concrete examples"],
                improvements=["Quantify outcomes"],
                drill="Rehearse one STAR answer with numbers in it.",
                summary="A solid practice session.",
                raw_response=RAW_RESPONSE,
                model="gpt-realtime",
            )
        )
        db.commit()

        w.mentor_a_user_id = mentor_a_user.id
        w.mentor_b_user_id = mentor_b_user.id
        w.groupless_user_id = groupless_user.id
        w.director_user_id = director_user.id
        w.student_user_id = student_user.id
        w.other_user_id = other_user.id
        w.studentless_user_id = studentless_user.id
        w.mentor_a_id = mentor_a.id
        w.mentor_b_id = mentor_b.id
        w.student_id = student.id
        w.other_student_id = other.id
        w.interview_id = interview.id
        w.other_interview_id = other_interview.id
        user_ids = [
            mentor_a_user.id,
            mentor_b_user.id,
            groupless_user.id,
            director_user.id,
            student_user.id,
            other_user.id,
            studentless_user.id,
        ]
        student_ids = [student.id, other.id]
        mentor_ids = [mentor_a.id, mentor_b.id]

    # Sessions the tests read as each member of the cast.
    w.as_student = _auth(
        userId=w.student_user_id,
        email="s@bgscet.ac.in",
        name="S",
        role="STUDENT",
        studentId=w.student_id,
    )
    w.as_other_student = _auth(
        userId=w.other_user_id,
        email="o@bgscet.ac.in",
        name="O",
        role="STUDENT",
        studentId=w.other_student_id,
    )
    w.as_studentless = _auth(
        userId=w.studentless_user_id,
        email="ns@bgscet.ac.in",
        name="NS",
        role="STUDENT",
    )
    w.as_mentor_in_group = _auth(
        userId=w.mentor_a_user_id,
        email="ma@bgscet.ac.in",
        name="MA",
        role="MENTOR",
        mentorId=w.mentor_a_id,
    )
    w.as_mentor_other_group = _auth(
        userId=w.mentor_b_user_id,
        email="mb@bgscet.ac.in",
        name="MB",
        role="MENTOR",
        mentorId=w.mentor_b_id,
    )
    w.as_mentor_no_group = _auth(
        userId=w.groupless_user_id,
        email="mn@bgscet.ac.in",
        name="MN",
        role="MENTOR",
    )
    w.as_director = _auth(
        userId=w.director_user_id,
        email="d@bgscet.ac.in",
        name="D",
        role="DIRECTOR",
    )

    yield w

    with SessionLocal() as db:
        db.execute(delete(InterviewConsent).where(InterviewConsent.user_id.in_(user_ids)))
        db.execute(
            delete(InterviewSession).where(InterviewSession.student_id.in_(student_ids))
        )
        db.execute(delete(Student).where(Student.id.in_(student_ids)))
        db.execute(delete(Mentor).where(Mentor.id.in_(mentor_ids)))
        db.execute(delete(User).where(User.id.in_(user_ids)))
        db.commit()


def _staff_paths(world) -> list[str]:
    """Every staff read of the one interview, so a test can assert on ALL of
    them instead of on whichever one it remembered."""
    base = f"/api/mentor/students/{world.student_id}/interviews"
    return [base, f"{base}/{world.interview_id}", f"{base}/{world.interview_id}/transcript",
            f"{base}/{world.interview_id}/report"]


# ---------------------------------------------------------------------------
# The student: own record only
# ---------------------------------------------------------------------------


@requires_db
def test_student_sees_their_own_interview(api, world):
    r = api.get("/api/interview/sessions", headers=world.as_student)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [row["id"] for row in rows] == [world.interview_id]
    row = rows[0]
    assert row["specialization"] == "hr"
    assert row["status"] == "completed"
    assert row["answers_accepted"] == 5
    # The scorecard summary comes from the LEFT JOIN, so the history screen
    # needs no second request per interview.
    assert row["report_status"] == "ok"
    assert row["overall_score"] == 68
    # `audio_recorded` is the flag to read; `audio_path` is a server-side
    # location and must not be in the payload at all.
    assert row["audio_recorded"] is False
    assert "audio_path" not in row


@requires_db
def test_student_never_sees_another_students_interview_in_the_list(api, world):
    r = api.get("/api/interview/sessions", headers=world.as_other_student)
    assert r.status_code == 200, r.text
    assert [row["id"] for row in r.json()] == [world.other_interview_id]


@requires_db
@pytest.mark.parametrize("suffix", ["", "/transcript", "/report"])
def test_another_students_session_id_is_404_and_never_403(api, world, suffix):
    """404, not 403 — a 403 would confirm that this id exists, which is the one
    thing an enumeration is trying to learn (conversations.assert_owner sets the
    rule)."""
    r = api.get(
        f"/api/interview/sessions/{world.interview_id}{suffix}",
        headers=world.as_other_student,
    )
    assert r.status_code == 404, r.text


@requires_db
def test_a_student_with_no_student_row_sees_nothing_rather_than_everything(api, world):
    """No `studentId` claim must read as "no interviews", never as "no filter".

    An unfiltered query here would hand one user the whole college's
    transcripts, and it is one forgotten `.where()` away.
    """
    r = api.get("/api/interview/sessions", headers=world.as_studentless)
    assert r.status_code == 200, r.text
    assert r.json() == []
    r = api.get(
        f"/api/interview/sessions/{world.interview_id}", headers=world.as_studentless
    )
    assert r.status_code == 404, r.text


@requires_db
def test_staff_cannot_use_the_students_own_endpoints(api, world):
    """The student endpoints are STUDENT-only. A director reads a student's
    interviews through the staff route, where the group gate lives — not through
    a route that would silently return their own (empty) list."""
    for headers in (world.as_director, world.as_mentor_in_group):
        r = api.get("/api/interview/sessions", headers=headers)
        assert r.status_code == 403, r.text


def test_the_students_own_routes_take_no_student_id():
    """§7.3, pinned structurally rather than by behaviour.

    Not `@requires_db`: this reads the route table and touches no row, and the
    IDOR it guards against is exactly the kind of change someone makes on a
    laptop with no Postgres running.

    The moment a `student_id` appears in one of these paths "for symmetry" with
    the staff routes, every student endpoint is an IDOR waiting for someone to
    forget the filter. A path parameter is easy to add and impossible to notice
    in review, so it is asserted here.
    """
    from app.routers import interview_records

    for route in interview_records.student_router.routes:
        assert "{student_id}" not in route.path, route.path


@requires_db
def test_unauthenticated_requests_are_refused(api, world):
    assert api.get("/api/interview/sessions").status_code == 401
    assert api.get(_staff_paths(world)[0]).status_code == 401


# ---------------------------------------------------------------------------
# AGENTS.md rule 2 — the three cases, by name
# ---------------------------------------------------------------------------


@requires_db
def test_mentor_in_the_students_group_can_read_the_interview(api, world):
    r = api.get(_staff_paths(world)[0], headers=world.as_mentor_in_group)
    assert r.status_code == 200, r.text
    assert [row["id"] for row in r.json()] == [world.interview_id]

    r = api.get(_staff_paths(world)[1], headers=world.as_mentor_in_group)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == world.interview_id

    r = api.get(_staff_paths(world)[2], headers=world.as_mentor_in_group)
    assert r.status_code == 200, r.text
    assert [t["seq"] for t in r.json()] == [1, 2, 3]

    r = api.get(_staff_paths(world)[3], headers=world.as_mentor_in_group)
    assert r.status_code == 200, r.text
    assert r.json()["overall_score"] == 68


@requires_db
def test_mentor_in_a_different_group_gets_404(api, world):
    """mentor_b has a real Mentor group — just not this student's. Every read of
    this student, at every depth, is 404."""
    for path in _staff_paths(world):
        r = api.get(path, headers=world.as_mentor_other_group)
        assert r.status_code == 404, f"{path} -> {r.status_code} {r.text}"


@requires_db
def test_mentor_with_no_mentor_group_gets_404_and_never_the_whole_programme(api, world):
    """THE CASE THE RULE EXISTS FOR.

    A MENTOR with no `Mentor` row has no `mentorId` claim. That must read as
    "sees NOBODY" — not as "no group filter to apply, therefore the whole
    programme". Both students are checked, because the failure mode is not
    "reads the wrong one", it is "reads all of them".
    """
    for path in _staff_paths(world):
        r = api.get(path, headers=world.as_mentor_no_group)
        assert r.status_code == 404, f"{path} -> {r.status_code} {r.text}"

    r = api.get(
        f"/api/mentor/students/{world.other_student_id}/interviews",
        headers=world.as_mentor_no_group,
    )
    assert r.status_code == 404, r.text


@requires_db
def test_director_sees_every_students_interviews(api, world):
    for student_id, interview_id in (
        (world.student_id, world.interview_id),
        (world.other_student_id, world.other_interview_id),
    ):
        r = api.get(
            f"/api/mentor/students/{student_id}/interviews", headers=world.as_director
        )
        assert r.status_code == 200, r.text
        assert [row["id"] for row in r.json()] == [interview_id]


@requires_db
def test_a_student_cannot_reach_the_staff_endpoints_even_for_their_own_record(
    api, world
):
    """`_assert_can_access_student` calls `require_mentor` first, so this is a
    403 about the ROLE and not a 404 about the row."""
    r = api.get(_staff_paths(world)[0], headers=world.as_student)
    assert r.status_code == 403, r.text


@requires_db
def test_a_mentor_cannot_read_another_groups_session_id_through_their_own_student(
    api, world
):
    """The horizontal case, and the reason every by-id staff endpoint checks the
    row's own subject.

    mentor_b legitimately passes the gate for `other_student` — that IS their
    mentee. If the handler then loaded the session id from the path without
    re-checking whose it is, mentor_b would read mentor_a's student's interview
    through a first line that looks perfectly correct.
    """
    base = f"/api/mentor/students/{world.other_student_id}/interviews"
    for suffix in ("", "/transcript", "/report"):
        r = api.get(
            f"{base}/{world.interview_id}{suffix}", headers=world.as_mentor_other_group
        )
        assert r.status_code == 404, f"{suffix or '(detail)'} -> {r.status_code}"


# ---------------------------------------------------------------------------
# §5.4 — what the student sees of their own report, and what staff see
# ---------------------------------------------------------------------------


@requires_db
def test_the_student_sees_every_score_of_their_own_report(api, world):
    """Scores are NOT withheld from the student (§5.4). The model already speaks
    its verdict aloud, and a score the student cannot see while their mentor can
    is a secret file on a student."""
    r = api.get(
        f"/api/interview/sessions/{world.interview_id}/report", headers=world.as_student
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall_score"] == 68
    assert body["communication_score"] == 71
    assert body["structure_score"] == 60
    assert body["strengths"] == ["Clear structure", "Concrete examples"]
    assert body["improvements"] == ["Quantify outcomes"]
    assert body["summary"] == "A solid practice session."
    # NULL survives as null: "the model did not return one" must stay
    # distinguishable from "the model scored this student zero".
    assert body["domain_score"] is None


@requires_db
def test_the_student_never_receives_raw_response(api, world):
    """Not as `null`, not at all — the key's absence is the honest way to say
    "this is not yours to read"."""
    r = api.get(
        f"/api/interview/sessions/{world.interview_id}/report", headers=world.as_student
    )
    assert r.status_code == 200, r.text
    assert "raw_response" not in r.json()
    assert RAW_RESPONSE not in r.text


@requires_db
def test_a_mentor_in_group_reads_the_report_but_not_raw_response(api, world):
    """Both gates, not either. The group gate said which student; it says
    nothing about who may read the model's private reasoning about them."""
    r = api.get(_staff_paths(world)[3], headers=world.as_mentor_in_group)
    assert r.status_code == 200, r.text
    assert r.json()["overall_score"] == 68
    assert "raw_response" not in r.json()
    assert RAW_RESPONSE not in r.text


@requires_db
def test_a_director_reads_raw_response(api, world):
    r = api.get(_staff_paths(world)[3], headers=world.as_director)
    assert r.status_code == 200, r.text
    assert r.json()["raw_response"] == RAW_RESPONSE


@requires_db
def test_report_is_404_while_no_evaluation_row_exists(api, world):
    """A row is written on EVERY terminal path, including 'unavailable', so a
    missing row means the interview has not finished — a different sentence from
    "the report failed", and the client needs to be able to tell them apart."""
    r = api.get(
        f"/api/mentor/students/{world.other_student_id}/interviews/"
        f"{world.other_interview_id}/report",
        headers=world.as_director,
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# The transcript
# ---------------------------------------------------------------------------


@requires_db
def test_the_transcript_keeps_a_turn_whose_transcription_failed(api, world):
    """L4, from the read side. `content = ''` with a status saying why is the
    entire reason `interview_turns` exists; a payload that dropped it would make
    the record agree with the bug."""
    r = api.get(
        f"/api/interview/sessions/{world.interview_id}/transcript",
        headers=world.as_student,
    )
    assert r.status_code == 200, r.text
    turns = r.json()
    assert [t["seq"] for t in turns] == [1, 2, 3]
    blank = turns[2]
    assert blank["content"] == ""
    assert blank["transcription_status"] == "timeout"
    assert blank["answer_quality"] is None
    assert turns[1]["counted_as_answer"] is True
    assert turns[0]["speaker"] == "interviewer"


@requires_db
def test_a_soft_deleted_interview_is_gone_for_the_student_and_for_staff(api, world):
    """`retention.purge_expired` stamps `deleted_at` and REDACTS the turn text in
    the same step, so a soft-deleted interview is a hollowed-out record on its
    way to a hard delete. Serving it would put an empty transcript in front of a
    mentor with nothing to say why it is empty."""
    with SessionLocal() as db:
        row = db.get(InterviewSession, world.interview_id)
        row.deleted_at = datetime.now(timezone.utc)
        db.commit()

    # The student's own routes.
    assert api.get("/api/interview/sessions", headers=world.as_student).json() == []
    for suffix in ("", "/transcript", "/report"):
        r = api.get(
            f"/api/interview/sessions/{world.interview_id}{suffix}",
            headers=world.as_student,
        )
        assert r.status_code == 404, f"{suffix or '(detail)'} -> {r.status_code}"

    # And BOTH staff audiences, at every depth. A director is checked as well as
    # a mentor because the exclusion lives in the shared loader rather than in
    # the gate — a DIRECTOR passes every access check there is, so if the
    # `deleted_at IS NULL` filter were ever dropped from one of these queries,
    # the director is the caller who would still see the hollowed-out row.
    for headers in (world.as_director, world.as_mentor_in_group):
        for path in _staff_paths(world)[1:]:
            r = api.get(path, headers=headers)
            assert r.status_code == 404, f"{path} -> {r.status_code} {r.text}"
        assert api.get(_staff_paths(world)[0], headers=headers).json() == []


# ---------------------------------------------------------------------------
# Consent — a row, not a localStorage key
# ---------------------------------------------------------------------------


def _live_consents(user_id: str) -> list[InterviewConsent]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(InterviewConsent).where(
                    InterviewConsent.user_id == user_id,
                    InterviewConsent.revoked_at.is_(None),
                )
            ).all()
        )


@requires_db
def test_consent_reports_the_version_the_server_is_asking_for(api, world):
    """The client cannot post a grant without knowing the current version
    string, and this is the endpoint it already calls."""
    from app.config import settings

    r = api.get("/api/interview/consent", headers=world.as_student)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "version": settings.interview_consent_version,
        "consent": None,
    }


@requires_db
def test_consent_grant_read_and_withdrawal(api, world):
    from app.config import settings

    body = {
        "version": settings.interview_consent_version,
        "scope_live_ai": True,
        "scope_store_transcript": True,
        "scope_store_audio": False,
    }
    r = api.post("/api/interview/consent", json=body, headers=world.as_student)
    assert r.status_code == 201, r.text
    granted = r.json()
    assert granted["scope_live_ai"] is True
    assert granted["scope_store_audio"] is False
    # The audit fields are recorded but not handed back to the browser that
    # supplied them.
    assert "source_ip_hash" not in granted and "user_agent" not in granted

    r = api.get("/api/interview/consent", headers=world.as_student)
    assert r.json()["consent"]["id"] == granted["id"]

    r = api.delete("/api/interview/consent", headers=world.as_student)
    assert r.status_code == 200, r.text
    assert r.json()["consent"] is None
    assert api.get("/api/interview/consent", headers=world.as_student).json()[
        "consent"
    ] is None
    # Revocation stamps the row; it never deletes it. The historical fact that
    # consent WAS given is what the interviews conducted under it depend on.
    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(InterviewConsent).where(
                    InterviewConsent.user_id == world.student_user_id
                )
            ).all()
        )
    assert len(rows) == 1 and rows[0].revoked_at is not None


@requires_db
def test_regranting_supersedes_the_old_row_instead_of_editing_it(api, world):
    """A grant is a row and a row is never edited: `interview_sessions.
    consent_id` pins the grant that was live when an interview opened, and
    mutating it would rewrite the answer for every interview pointing at it."""
    from app.config import settings

    def _post(**scopes):
        return api.post(
            "/api/interview/consent",
            json={"version": settings.interview_consent_version, **scopes},
            headers=world.as_student,
        )

    first = _post(
        scope_live_ai=True, scope_store_transcript=False, scope_store_audio=False
    )
    assert first.status_code == 201, first.text
    second = _post(
        scope_live_ai=True, scope_store_transcript=True, scope_store_audio=False
    )
    assert second.status_code == 201, second.text
    assert second.json()["id"] != first.json()["id"]

    live = _live_consents(world.student_user_id)
    assert [row.id for row in live] == [second.json()["id"]]
    assert live[0].scope_store_transcript is True
    with SessionLocal() as db:
        superseded = db.get(InterviewConsent, first.json()["id"])
        assert superseded is not None and superseded.revoked_at is not None
        # The superseded row still says exactly what the student agreed to at
        # the time, which is the whole point of keeping it.
        assert superseded.scope_store_transcript is False


@requires_db
def test_consent_refuses_a_version_this_server_does_not_know(api, world):
    """A stale cached SPA must not be able to grant against copy the student
    never saw — the one job a version string has."""
    r = api.post(
        "/api/interview/consent",
        json={
            "version": "1999-01",
            "scope_live_ai": True,
            "scope_store_transcript": True,
            "scope_store_audio": False,
        },
        headers=world.as_student,
    )
    assert r.status_code == 422, r.text
    assert _live_consents(world.student_user_id) == []


@requires_db
def test_consent_requires_every_scope_to_be_stated(api, world):
    """No defaults. Defaulting a missing scope to False would silently record a
    refusal the student never made, on the row that is the evidence of what they
    agreed to."""
    from app.config import settings

    r = api.post(
        "/api/interview/consent",
        json={
            "version": settings.interview_consent_version,
            "scope_live_ai": True,
            "scope_store_transcript": True,
        },
        headers=world.as_student,
    )
    assert r.status_code == 422, r.text


@requires_db
def test_only_a_student_can_grant_consent(api, world):
    from app.config import settings

    r = api.post(
        "/api/interview/consent",
        json={
            "version": settings.interview_consent_version,
            "scope_live_ai": True,
            "scope_store_transcript": True,
            "scope_store_audio": False,
        },
        headers=world.as_director,
    )
    assert r.status_code == 403, r.text


@requires_db
def test_withdrawal_covers_a_grant_carrying_an_older_version(api, world):
    """"I withdraw" is about the person, not about a version string. A live
    grant left behind under last term's version is the kind of half-revocation
    that makes a consent record worthless."""
    with SessionLocal() as db:
        db.add(
            InterviewConsent(
                user_id=world.student_user_id,
                version="1999-01",
                scope_live_ai=True,
                scope_store_transcript=True,
                scope_store_audio=False,
            )
        )
        db.commit()
    assert len(_live_consents(world.student_user_id)) == 1

    r = api.delete("/api/interview/consent", headers=world.as_student)
    assert r.status_code == 200, r.text
    assert _live_consents(world.student_user_id) == []


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


def test_the_routers_are_mounted_at_the_documented_paths():
    """If `app/main.py` includes these routers, it must do so with NO extra
    prefix.

    Both routers declare their full `/api/...` path (the shape
    app/routers/interview.py uses), while the domain routers next to them in
    main.py declare `/mentor` and are mounted with `prefix="/api"`. Copying that
    line for `staff_router` serves it at `/api/api/mentor/...`: every request
    404s, nothing raises, and the only symptom is a mentor screen that is
    permanently empty.

    Conditional on purpose. `app/main.py` belongs to another step of this
    rollout, so before it lands there is nothing to assert and this must not be
    the test that fails for a reason outside its own subject. The moment ONE of
    these paths appears, all of them are required — which is exactly the state a
    mis-prefixed include produces.

    ASK THE OPENAPI DOCUMENT, NOT `app.routes`. On this FastAPI version
    `include_router` does not flatten the sub-routes into `app.routes`; it
    appends one `fastapi.routing._IncludedRouter` per include, and that object
    carries no `.path` at all. A set built from `app.routes` therefore comes back
    as `{""}` plus the four doc routes, `expected & mounted` is empty, and this
    test skips itself with a message blaming another agent's file while the
    endpoints are being served perfectly. It did exactly that on its first run.
    `app.openapi()["paths"]` is the version-independent answer to "what does this
    app actually serve", which is the question being asked.
    """
    from app.main import app
    from app.routers import interview_records

    expected = {
        route.path
        for router in (
            interview_records.student_router,
            interview_records.staff_router,
        )
        for route in router.routes
    }
    served = set(app.openapi()["paths"])
    if not (expected & served):
        pytest.skip(
            "app/main.py does not include the interview_records routers yet "
            "(step 7 of the rollout owns that file). Nothing to check."
        )
    assert expected <= served, sorted(expected - served)
    assert not any(path.startswith("/api/api/") for path in served)
