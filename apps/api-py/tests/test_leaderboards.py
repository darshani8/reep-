"""The cohort leaderboards -- `GET /api/student/leaderboards?board=` -- and the
two reasons they ranked nobody (2026-09-17).

A student had finished a mock interview, had their skills verified on
Skilling, and had classmates on the roster; the board still read as if no
ranking had been done. Two defects, pinned here:

  * the Skills board counted `student_skills`, a table the Skilling screen's
    verification never writes (a mentor's APPROVE mints an EARNED
    `student_badges` row), and counted its rows verified or not -- so
    "0 skills" against everybody on a live deployment;
  * every board ranked every classmate, at zero, in database order, so the
    ranks under the zeros were arbitrary and changed between cache refreshes,
    and "CGPA 0.00" was drawn against students whose results were never
    recorded.

A student with nothing recorded on a board is not on it now, equal totals
share a rank, and the Skills board counts what the mentor verified. Every
test here hits the seeded dev database like the rest of the suite, so a
cohort is minted per test and the students are `make_user` accounts seated
in it.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from conftest import requires_db
from sqlalchemy import delete, select, update

from app.db import SessionLocal
from app.models.academics import SemesterResult
from app.models.badge import BADGES, StudentBadge, StudentBadgeStatus
from app.models.cohort import Cohort
from app.models.interview import InterviewScoreSummary
from app.models.job import DegreeLevel
from app.models.user import Student


@pytest.fixture
def cohort(make_user):
    """A batch of its own, and a factory that seats a fresh STUDENT account in it.

    Depends on `make_user` so this fixture tears down FIRST: the students are
    unseated and the batch deleted before `make_user` deletes the accounts,
    which keeps `students.cohort_id` from pointing at a row that is gone.
    """
    tag = uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        row = Cohort(
            code=f"LB-{tag}",
            name="2026-28",
            batch_label="2026-28",
            degree_level=DegreeLevel.PG,
            start_date=now - timedelta(days=60),
            end_date=now + timedelta(days=600),
        )
        db.add(row)
        db.commit()
        cohort_id = row.id

    def _seat(label: str):
        account = make_user(f"lb-{label}-{tag[:4]}")
        with SessionLocal() as db:
            student = db.scalar(select(Student).where(Student.user_id == account.user_id))
            student.cohort_id = cohort_id
            db.commit()
            account.student_id = student.id
        return account

    yield _seat

    with SessionLocal() as db:
        db.execute(update(Student).where(Student.cohort_id == cohort_id).values(cohort_id=None))
        db.execute(delete(Cohort).where(Cohort.id == cohort_id))
        db.commit()


def _earn(db, student_id: str, how_many: int) -> None:
    """Exactly what `_award` writes when a mentor approves the claim."""
    for badge in BADGES[:how_many]:
        db.add(
            StudentBadge(
                student_id=student_id,
                badge_code=badge.code,
                status=StudentBadgeStatus.EARNED,
                points_awarded=badge.points,
                earned_at=datetime.now(timezone.utc),
            )
        )


def _board(client, account, board: str) -> dict:
    r = client.get(f"/api/student/leaderboards?board={board}", headers=account.headers)
    assert r.status_code == 200, r.text
    return r.json()


@requires_db
def test_the_skills_board_counts_what_the_mentor_verified(client, cohort):
    """Two verified skills, one, and none: ranks 1 and 2, and a third student
    who is not on the board at all."""
    two, one, none = cohort("two"), cohort("one"), cohort("none")
    with SessionLocal() as db:
        _earn(db, two.student_id, 2)
        _earn(db, one.student_id, 1)
        db.commit()

    body = _board(client, two, "skills")
    assert body["opted_out"] is False
    assert body["cohort_size"] == 2, "the student holding nothing was counted as ranked"
    assert [(r["rank"], r["student_id"], r["value_label"]) for r in body["rows"]] == [
        (1, two.student_id, "2 skills"),
        (2, one.student_id, "1 skill"),
    ]
    assert [r["is_me"] for r in body["rows"]] == [True, False]

    # The student with nothing recorded gets the client's "not ranked here
    # yet" card: the same two rows, none of them theirs, and a size of two.
    body = _board(client, none, "skills")
    assert body["cohort_size"] == 2
    assert not any(r["is_me"] for r in body["rows"])
    assert {r["student_id"] for r in body["rows"]} == {two.student_id, one.student_id}


@requires_db
def test_a_legacy_skill_row_no_longer_ranks_anybody(client, cohort):
    """`student_skills` is what the board used to count; a claim sitting there
    unverified must not put a student above one the mentor actually verified."""
    from app.models.skill import Skill, StudentSkill

    verified, claimed = cohort("verified"), cohort("claimed")
    with SessionLocal() as db:
        _earn(db, verified.student_id, 1)
        skill = db.scalar(select(Skill).limit(1))
        if skill is None:
            skill = Skill(slug=f"lb-{uuid.uuid4().hex[:6]}", name="Leaderboard test", category="test")
            db.add(skill)
            db.flush()
        db.add(StudentSkill(student_id=claimed.student_id, skill_id=skill.id, level=3, verified=False))
        db.commit()

    body = _board(client, claimed, "skills")
    assert [r["student_id"] for r in body["rows"]] == [verified.student_id]
    assert body["cohort_size"] == 1


@requires_db
def test_a_finished_mock_interview_ranks_on_the_mocks_board(client, cohort):
    """One completed interview counts; an abandoned one does not, exactly as on
    the home chart (B6.3); a student with neither is not on the board."""
    finished, quit_early, none = cohort("finished"), cohort("quit"), cohort("none")
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.add_all(
            [
                InterviewScoreSummary(
                    student_id=finished.student_id,
                    session_id=None,
                    track_code="hr",
                    started_at=now - timedelta(days=1),
                    status="completed",
                    overall_score=70,
                ),
                InterviewScoreSummary(
                    student_id=quit_early.student_id,
                    session_id=None,
                    track_code="hr",
                    started_at=now - timedelta(days=1),
                    status="abandoned",
                ),
            ]
        )
        db.commit()

    body = _board(client, finished, "mocks")
    assert body["cohort_size"] == 1
    assert [(r["rank"], r["student_id"], r["value_label"], r["is_me"]) for r in body["rows"]] == [
        (1, finished.student_id, "1 mock", True),
    ]
    for bystander in (quit_early, none):
        body = _board(client, bystander, "mocks")
        assert not any(r["is_me"] for r in body["rows"])
        assert body["cohort_size"] == 1


@requires_db
def test_equal_totals_share_a_rank_and_the_next_rank_skips(client, cohort):
    """1, 1, 3 -- and the order inside the tie is by name, so the board is the
    same list on every refresh rather than whatever Postgres returned first."""
    a, b, c = cohort("alpha"), cohort("bravo"), cohort("charlie")
    with SessionLocal() as db:
        _earn(db, a.student_id, 2)
        _earn(db, b.student_id, 2)
        _earn(db, c.student_id, 1)
        db.commit()

    body = _board(client, c, "skills")
    assert [r["rank"] for r in body["rows"]] == [1, 1, 3]
    assert body["cohort_size"] == 3
    tied = [r for r in body["rows"] if r["rank"] == 1]
    assert [r["name"] for r in tied] == sorted((r["name"] for r in tied), key=str.casefold)
    me = next(r for r in body["rows"] if r["is_me"])
    assert me["rank"] == 3, "the student behind a tie is third, not second"


@requires_db
def test_the_vtu_board_never_draws_a_cgpa_for_a_student_with_no_result(client, cohort):
    """A student with no semester result is absent, and a semester filed
    without a CGPA does not hide the last one that had it."""
    scored, blank, none = cohort("scored"), cohort("blank"), cohort("none")
    with SessionLocal() as db:
        db.add_all(
            [
                SemesterResult(student_id=scored.student_id, semester=1, cgpa=7.1),
                SemesterResult(student_id=scored.student_id, semester=2, cgpa=8.25),
                # Semester 3 is on file with no CGPA yet: the latest RECORDED
                # number is semester 2's, not 0.00 and not a crash on None.
                SemesterResult(student_id=scored.student_id, semester=3, cgpa=None),
                SemesterResult(student_id=blank.student_id, semester=1, cgpa=None),
            ]
        )
        db.commit()

    body = _board(client, none, "vtu")
    assert [(r["rank"], r["student_id"], r["value_label"]) for r in body["rows"]] == [
        (1, scored.student_id, "CGPA 8.25"),
    ]
    assert body["cohort_size"] == 1


@requires_db
def test_board_values_leave_out_a_student_with_nothing_recorded(cohort):
    """The contract `_ranked_board` relies on: no confident zeros, for any board."""
    from app.routers.student import _BOARDS, _board_values

    empty = cohort("empty")
    with SessionLocal() as db:
        for board in _BOARDS:
            if board == "streak":
                # Signing in through `make_user` wrote today's login day, so
                # this is the one board a fresh account IS on.
                continue
            assert _board_values(db, board, [(empty.student_id, empty.user_id)]) == {}, board
