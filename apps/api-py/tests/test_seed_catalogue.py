"""The catalogue seeder's shape, and the codes that decide whether a student
can be scored.

`app/seed_catalogue.py` writes the institutional spine. Most of what it does is
ordinary row creation; ONE field in it -- a leaf's `code` -- silently decides
whether that leaf's students ever get a scorecard, because
`routers/interview_policy._default_track` preselects the interview track by
exact match on it. Nothing on any screen reports a mismatch. So the codes are
asserted here, by name.

The structural tests need no database. The idempotency test does, and uses a
throwaway catalogue rather than the real BGSCET one, so it can never collide
with the dev seed or leave a real-looking college behind.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select

from conftest import requires_db

from app import seed_catalogue as sc
from app.db import SessionLocal
from app.interview_matrix import SPECIALIZATIONS
from app.models.cohort import Cohort
from app.models.institution import (
    AcademicCourse,
    AcademicSpecialization,
    College,
    Department,
)

BGSCET = sc.CATALOGUES["1MP"]


# ------------------------------------------------------- the codes that bite --


def test_every_code_is_lowercase_and_stripped() -> None:
    """`_default_track` case-folds, so a stray capital matches anyway -- but the
    codes are also read by humans off the Catalogue screen, and `HR` beside
    `marketing` reads as two different kinds of thing."""
    for cat in sc.CATALOGUES.values():
        for course in cat.courses:
            assert course.code == course.code.strip().lower(), course
            for spec in course.specializations:
                assert spec.code == spec.code.strip().lower(), spec


def test_codes_are_unique_where_the_schema_requires_it() -> None:
    """`uq_academic_course_department_code` and
    `uq_academic_specialization_course_code`. A duplicate here is an
    IntegrityError halfway through a seed, which is worse than a refusal."""
    for cat in sc.CATALOGUES.values():
        course_codes = [c.code for c in cat.courses]
        assert len(course_codes) == len(set(course_codes)), cat.college_code
        for course in cat.courses:
            spec_codes = [s.code for s in course.specializations]
            assert len(spec_codes) == len(set(spec_codes)), course


def test_the_leaves_that_match_a_built_in_track() -> None:
    """The four that must work on day one, named individually.

    Asserting "most of them match" would pass on a file where the wrong three
    matched. These are the exact pairings the college asked for.
    """
    keys = {
        f"{course.name}|{spec.name if spec else ''}": sc.track_key(course, spec)
        for course, spec in sc.leaves(BGSCET)
    }
    assert keys["General MBA|Human Resources"] == "hr"
    assert keys["General MBA|Business Analytics"] == "ba"
    assert keys["General MBA|Finance"] == "fa"
    assert keys["Digital Marketing|"] == "dm"
    for key in ("hr", "ba", "fa", "dm"):
        assert key in SPECIALIZATIONS, f"{key} is no longer a built-in track"


def test_marketing_is_deliberately_not_mapped_to_digital_marketing() -> None:
    """THE PIN THAT MATTERS MOST, because the "fix" is so tempting.

    Marketing has no interview track, and the nearest-looking one is `dm` --
    Digital Marketing, which is a DIFFERENT DISCIPLINE and is one of this
    college's other two-year courses. Mapping it would put a Marketing student
    in front of a growth CMO asking about CAC/LTV ratios and paid-media
    attribution, and they would be scored against that. The honest state is no
    preselection until the office builds a Marketing track.
    """
    marketing = next(
        spec
        for course, spec in sc.leaves(BGSCET)
        if spec is not None and spec.name == "Marketing"
    )
    assert marketing.code == "marketing"
    assert marketing.code != "dm"
    assert marketing.code not in SPECIALIZATIONS


def test_logistics_is_honestly_unmapped_too() -> None:
    """No track exists, and the code is the one that will make it work later.

    When the office adds a track with this code the preselection begins with no
    change to this file, because both halves are the same string.
    """
    course = next(c for c in BGSCET.courses if c.name.startswith("Logistics"))
    assert course.code == "lscm"
    assert course.code not in SPECIALIZATIONS


# ------------------------------------------------------------ the structure --


def test_a_course_with_specializations_is_not_itself_a_leaf() -> None:
    """Nobody enrols in "General MBA" without choosing one of its four."""
    names = [
        (course.name, spec.name if spec else None) for course, spec in sc.leaves(BGSCET)
    ]
    assert ("General MBA", None) not in names
    assert ("General MBA", "Finance") in names


def test_a_course_without_specializations_is_its_own_leaf() -> None:
    """A two-year MBA in Digital Marketing IS the qualification. This is the
    shape `_default_track` gained the course rung for."""
    names = [
        (course.name, spec.name if spec else None) for course, spec in sc.leaves(BGSCET)
    ]
    assert ("Digital Marketing", None) in names
    assert ("Logistics and Supply Chain Management", None) in names


def test_bgscet_has_six_leaves() -> None:
    assert len(sc.leaves(BGSCET)) == 6


def test_batch_codes_are_globally_unique() -> None:
    """`cohorts.code` is UNIQUE across the whole table, not per college -- so
    two colleges' batches share one namespace and the code has to carry the
    whole path. A collision is an IntegrityError mid-seed."""
    codes = [
        sc.batch_code(cat, course, spec, label)
        for cat in sc.CATALOGUES.values()
        for label in cat.batches
        for course, spec in sc.leaves(cat)
    ]
    assert len(codes) == len(set(codes)), "two batches would claim one code"
    assert all(c.startswith("1MP-MBA-") for c in codes if c.startswith("1MP"))


def test_the_batch_the_college_asked_for_is_the_one_declared() -> None:
    assert BGSCET.batches == ("2025-27",)


# ------------------------------------------------------------- idempotency --


def _throwaway() -> sc.Catalogue:
    tag = uuid.uuid4().hex[:6]
    return sc.Catalogue(
        college_code=f"T{tag}",
        college_name=f"Test College {tag}",
        department_code="TST",
        department_name="Testing",
        courses=(
            sc.Course(
                code="gen",
                name="General",
                specializations=(sc.Spec(code="hr", name="Human Resources"),),
            ),
            sc.Course(code="solo", name="Solo Programme"),
        ),
        batches=("2025-27",),
    )


@pytest.fixture
def swept():
    cats: list[sc.Catalogue] = []
    yield cats
    with SessionLocal() as db:
        for cat in cats:
            college = db.scalar(select(College).where(College.code == cat.college_code))
            if college is None:
                continue
            depts = list(db.scalars(select(Department.id).where(Department.college_id == college.id)))
            if depts:
                courses = list(
                    db.scalars(select(AcademicCourse.id).where(AcademicCourse.department_id.in_(depts)))
                )
                db.execute(delete(Cohort).where(Cohort.department_id.in_(depts)))
                if courses:
                    db.execute(
                        delete(AcademicSpecialization).where(
                            AcademicSpecialization.course_id.in_(courses)
                        )
                    )
                    db.execute(delete(AcademicCourse).where(AcademicCourse.id.in_(courses)))
                db.execute(delete(Department).where(Department.id.in_(depts)))
            db.execute(delete(College).where(College.id == college.id))
        db.commit()


@requires_db
def test_seeding_twice_writes_nothing_the_second_time(swept) -> None:
    """The property that makes this safe to put behind a button.

    An operator who is unsure whether the run worked will press it again. If the
    second press duplicated the catalogue, that uncertainty would cost a college
    a hand-unpicked mess -- and there is no destructor for a catalogue.
    """
    cat = _throwaway()
    swept.append(cat)
    with SessionLocal() as db:
        first = sc.seed(db, cat)
        db.commit()
    assert first["created"] == {
        "college": 1, "department": 1, "course": 2, "specialization": 1, "batch": 2
    }

    with SessionLocal() as db:
        second = sc.seed(db, cat)
        db.commit()
    assert sum(second["created"].values()) == 0, second["created"]
    assert second["existing"]["batch"] == 2


@requires_db
def test_a_renamed_college_is_reported_and_left_alone(swept) -> None:
    """ADDITIVE ONLY. The office renames things on screen; a seeder that
    reasserted its own names would undo that work on every press."""
    cat = _throwaway()
    swept.append(cat)
    with SessionLocal() as db:
        sc.seed(db, cat)
        db.commit()
    with SessionLocal() as db:
        college = db.scalar(select(College).where(College.code == cat.college_code))
        college.name = "Renamed By The Office"
        db.commit()
    with SessionLocal() as db:
        summary = sc.seed(db, cat)
        db.commit()
        college = db.scalar(select(College).where(College.code == cat.college_code))
        assert college.name == "Renamed By The Office"
    assert any("left as it is" in d for d in summary["drift"])


@requires_db
def test_a_leaf_without_a_specialization_still_gets_a_batch(swept) -> None:
    """The whole point of the course rung: a student on such a course must be
    seatable, or they have no ancestry at all and no track can be read."""
    cat = _throwaway()
    swept.append(cat)
    with SessionLocal() as db:
        sc.seed(db, cat)
        db.commit()
    with SessionLocal() as db:
        code = sc.batch_code(cat, cat.courses[1], None, "2025-27")
        row = db.scalar(select(Cohort).where(Cohort.code == code))
        assert row is not None
        assert row.specialization_id is None
        assert row.course_id is not None


# ------------------------------------------------------------------- the CLI --


def test_an_unknown_college_is_refused_rather_than_defaulted() -> None:
    """Seeding the wrong college into a deployment leaves a catalogue somebody
    unpicks by hand -- there is no destructor for one."""
    assert sc.main(["--college", "NOPE"]) == 2
    assert sc.main([]) == 2
