"""The endpoints behind the three screens the v2 student UI adds:

    GET  /api/student/ledger?day=          the Time Allocation Ledger
    PUT  /api/student/ledger                save a day (draft)
    POST /api/student/ledger/copy-yesterday prefill from the previous day
    POST /api/student/ledger/submit         latch the day, once it reconciles
    GET  /api/student/english-baseline      the English Proficiency Baseline
    GET  /api/student/mentor-meetings       the Mentor Meeting Log
    GET  /api/student/programme             the three landing stage cards

ITS OWN MODULE, so `app/routers/student.py` — already 2 200 lines and the file
every other student change touches — is not the place a whole new screen's worth
of schemas lands. It mounts under the same `/student` prefix from `app/main.py`,
so the client sees one flat surface and cannot tell the two files apart.

EVERY ENDPOINT HERE IS FIRST-PERSON. `_require_student` reads `studentId` from
the session and there is no path parameter anywhere in this module that names a
student, so there is nothing for a crafted id to reach: rule 2's staff gate does
not appear because no staff surface does. A mentor reading a student's ledger is
a different endpoint on `routers/mentor.py`, behind `_assert_can_access_student`,
and it does not exist yet.

THE COMPUTED VIEW LIVES HERE, NOT IN THE CLIENT. The metrics strip, the day
band's proportions and the mix bars are all derived from the same cell figures,
and deriving them twice — once in Python for the API and once in TypeScript for
the chart — is how a band ends up disagreeing with the number printed above it.
The client renders what it is given.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..deps import get_current_session
from ..models.english_baseline import (
    CEFR_LABEL,
    SKILL_ICON,
    SKILL_LABEL,
    SKILL_ORDER,
    BaselineStatus,
    EnglishBaseline,
    EnglishBaselineSection,
    SectionStatus,
)
from ..models.mentor_note import MentorAction, MentorNote
from ..models.milestone import (
    MILESTONES,
    STAGES,
    STATUS_GLYPH,
    MilestoneStatus,
    StudentMilestone,
)
from ..models.schedule import ScheduleItem, ScheduleType
from ..models.time_ledger import (
    ACTIVITY_COLOUR,
    ACTIVITY_LABEL,
    ACTIVITY_ORDER,
    DAY_CAPACITY_HALVES,
    PRODUCTIVE,
    SLOT_CAPACITY_HALVES,
    SLOT_ICON,
    SLOT_LABEL,
    SLOT_TICK,
    LedgerDayStatus,
    LedgerSlot,
    TimeLedgerCell,
    TimeLedgerDay,
)
from ..english_report import render_english_report_pdf
from ..models.timesheet import DayActivity
from ..models.user import Mentor, Student, User

router = APIRouter(prefix="/student", tags=["student-screens"])


def _require_student(session: dict) -> str:
    """The same gate `routers/student.py` uses, deliberately duplicated rather
    than imported: a cross-import between two sibling routers for four lines is
    a circular-import waiting to happen the first time either grows a shared
    schema."""
    student_id = session.get("studentId")
    if not student_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a student account.")
    return student_id


# ---------------------------------------------------------------------------
# Time Allocation Ledger
# ---------------------------------------------------------------------------


def _hours(half_hours: int) -> float:
    """Half-hours to hours, at the edge and nowhere else.

    Storage is integral (see models/time_ledger.py); the client speaks hours.
    This is the ONLY place the two units meet, so the exact 24-hour comparison
    the submit gate makes is never done against a float.
    """
    return half_hours / 2


class LedgerCellIn(BaseModel):
    slot: str
    activity: str
    hours: float = Field(ge=0, le=12)


class LedgerSaveIn(BaseModel):
    day: date
    cells: list[LedgerCellIn]


class LedgerCellOut(BaseModel):
    slot: str
    activity: str
    hours: float


class LedgerSegmentOut(BaseModel):
    """One coloured run inside a slot's band track or mix bar."""

    activity: str | None  # None = the unaccounted hatch
    label: str
    colour: str | None
    hours: float
    percent: float


class LedgerSlotOut(BaseModel):
    key: str
    label: str
    icon: str | None
    tick: str
    capacity_hours: float
    logged_hours: float
    #: Flex weight for the day band — proportional to slot duration, straight
    #: off SLOT_CAPACITY_HALVES so the band can never be drawn out of scale.
    weight: int
    state_label: str
    state_tone: str
    cells: dict[str, float]
    mix: list[LedgerSegmentOut]


class LedgerMetricOut(BaseModel):
    key: str
    label: str
    value: str
    unit: str
    sub: str
    tone: str


class LedgerLegendOut(BaseModel):
    activity: str | None
    label: str
    colour: str | None
    hours: float


class LedgerOut(BaseModel):
    day: date
    status: str
    submitted_at: datetime | None
    can_submit: bool
    submit_blocked_reason: str | None
    total_hours: float
    day_capacity_hours: float
    unaccounted_hours: float
    activities: list[dict]
    slots: list[LedgerSlotOut]
    metrics: list[LedgerMetricOut]
    legend: list[LedgerLegendOut]


def load_day(db: Session, student_id: str, day: date) -> TimeLedgerDay | None:
    return db.scalar(
        select(TimeLedgerDay)
        .options(selectinload(TimeLedgerDay.cells))
        .where(TimeLedgerDay.student_id == student_id, TimeLedgerDay.day == day)
    )


def _cell_map(ledger: TimeLedgerDay | None) -> dict[tuple[LedgerSlot, DayActivity], int]:
    if ledger is None:
        return {}
    return {(c.slot, c.activity): c.half_hours for c in ledger.cells}


def compose_ledger(day: date, ledger: TimeLedgerDay | None) -> LedgerOut:
    """Everything the ledger screen draws, derived once from the cell figures."""
    cells = _cell_map(ledger)

    per_slot: dict[LedgerSlot, int] = defaultdict(int)
    per_activity: dict[DayActivity, int] = defaultdict(int)
    for (slot, activity), halves in cells.items():
        per_slot[slot] += halves
        per_activity[activity] += halves

    total = sum(per_slot.values())
    unaccounted = max(0, DAY_CAPACITY_HALVES - total)

    slots: list[LedgerSlotOut] = []
    for slot in LedgerSlot:
        capacity = SLOT_CAPACITY_HALVES[slot]
        logged = per_slot.get(slot, 0)
        open_halves = capacity - logged

        # The chip under the slot's time range. Three states, and each one says
        # what to DO rather than only what is true — "0.5 h open" is a nudge,
        # "Balanced" is a full stop.
        if logged == 0:
            state_label, tone = "Empty", "neutral"
        elif open_halves > 0:
            state_label, tone = f"{_hours(open_halves):g} h open", "warn"
        elif open_halves < 0:
            state_label, tone = f"{_hours(-open_halves):g} h over", "risk"
        else:
            state_label, tone = "Balanced", "good"

        mix: list[LedgerSegmentOut] = []
        for activity in ACTIVITY_ORDER:
            halves = cells.get((slot, activity), 0)
            if halves <= 0:
                continue
            mix.append(
                LedgerSegmentOut(
                    activity=activity.value,
                    label=ACTIVITY_LABEL[activity],
                    colour=ACTIVITY_COLOUR[activity],
                    hours=_hours(halves),
                    percent=round(100 * halves / capacity, 3),
                )
            )
        if open_halves > 0:
            # The hatch. `activity=None` is what tells the client to draw the
            # repeating-gradient rather than a flat fill — a sentinel colour
            # string would have made "unaccounted" just another activity.
            mix.append(
                LedgerSegmentOut(
                    activity=None,
                    label="Unaccounted",
                    colour=None,
                    hours=_hours(open_halves),
                    percent=round(100 * open_halves / capacity, 3),
                )
            )

        slots.append(
            LedgerSlotOut(
                key=slot.value,
                label=SLOT_LABEL[slot],
                icon=SLOT_ICON.get(slot),
                tick=SLOT_TICK[slot],
                capacity_hours=_hours(capacity),
                logged_hours=_hours(logged),
                weight=capacity,
                state_label=state_label,
                state_tone=tone,
                cells={
                    a.value: _hours(cells.get((slot, a), 0)) for a in ACTIVITY_ORDER
                },
                mix=mix,
            )
        )

    productive = sum(per_activity.get(a, 0) for a in PRODUCTIVE)
    sleep = per_activity.get(DayActivity.SLEEPING, 0)
    awake = max(0, DAY_CAPACITY_HALVES - sleep)
    utilisation = round(100 * productive / awake) if awake else 0

    metrics = [
        LedgerMetricOut(
            key="accounted",
            label="Day accounted",
            value=f"{_hours(total):g}",
            unit=f"/ {_hours(DAY_CAPACITY_HALVES):g} h",
            sub=(
                f"{_hours(unaccounted):g} h to reconcile"
                if unaccounted
                else "Reconciled to 24 h"
            ),
            tone="warn" if unaccounted else "good",
        ),
        LedgerMetricOut(
            key="productive",
            label="Productive",
            value=f"{_hours(productive):g}",
            unit="h",
            sub="Lectures · coursework · skilling",
            tone="neutral",
        ),
        LedgerMetricOut(
            key="utilisation",
            label="Waking utilisation",
            value=f"{utilisation}",
            unit="%",
            sub=f"of {_hours(awake):.1f} h awake",
            tone="neutral",
        ),
        LedgerMetricOut(
            key="rest",
            label="Rest",
            value=f"{_hours(sleep):.1f}",
            unit="h",
            sub="Against an 8 h benchmark",
            tone="good" if sleep >= 16 else "warn",
        ),
    ]

    legend = [
        LedgerLegendOut(
            activity=a.value,
            label=ACTIVITY_LABEL[a],
            colour=ACTIVITY_COLOUR[a],
            hours=_hours(per_activity.get(a, 0)),
        )
        for a in ACTIVITY_ORDER
    ]
    legend.append(
        LedgerLegendOut(
            activity=None, label="Unaccounted", colour=None, hours=_hours(unaccounted)
        )
    )

    status_value = ledger.status.value if ledger else LedgerDayStatus.DRAFT.value
    already = status_value == LedgerDayStatus.SUBMITTED.value
    blocked: str | None = None
    if already:
        blocked = "This day is already submitted."
    elif total != DAY_CAPACITY_HALVES:
        # Deliberately the same sentence the metrics strip shows, so the
        # disabled button and the nudge above it agree word for word.
        blocked = f"{_hours(abs(DAY_CAPACITY_HALVES - total)):g} h to reconcile before you can submit."

    return LedgerOut(
        day=day,
        status=status_value,
        submitted_at=ledger.submitted_at if ledger else None,
        can_submit=blocked is None,
        submit_blocked_reason=blocked,
        total_hours=_hours(total),
        day_capacity_hours=_hours(DAY_CAPACITY_HALVES),
        unaccounted_hours=_hours(unaccounted),
        activities=[
            {
                "key": a.value,
                "label": ACTIVITY_LABEL[a],
                "colour": ACTIVITY_COLOUR[a],
                "productive": a in PRODUCTIVE,
            }
            for a in ACTIVITY_ORDER
        ],
        slots=slots,
        metrics=metrics,
        legend=legend,
    )


@router.get("/ledger", response_model=LedgerOut)
def read_ledger(
    day: date | None = None,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LedgerOut:
    """One day of the ledger. A day with nothing logged is a 200 with zeroes —
    an empty day is a real answer, not a 404."""
    student_id = _require_student(session)
    target = day or date.today()
    return compose_ledger(target, load_day(db, student_id, target))


def _validate_cells(cells: list[LedgerCellIn]) -> dict[tuple[LedgerSlot, DayActivity], int]:
    """Parse and bound the payload, or raise 422 naming the offending slot.

    Three rules, all enforced here rather than in the client, because the client
    is not the only thing that can POST: half-hour granularity, no cell over its
    slot's capacity, and no slot's five cells summing past it.
    """
    parsed: dict[tuple[LedgerSlot, DayActivity], int] = {}
    for cell in cells:
        try:
            slot = LedgerSlot(cell.slot)
        except ValueError:
            raise HTTPException(422, detail=f"Unknown slot {cell.slot!r}.")
        try:
            activity = DayActivity(cell.activity)
        except ValueError:
            raise HTTPException(422, detail=f"Unknown activity {cell.activity!r}.")

        halves = cell.hours * 2
        if abs(halves - round(halves)) > 1e-6:
            raise HTTPException(
                422,
                detail=f"{SLOT_LABEL[slot]} · {ACTIVITY_LABEL[activity]}: hours must be to the nearest half.",
            )
        halves = int(round(halves))
        if halves < 0:
            raise HTTPException(422, detail="Hours cannot be negative.")
        if halves > SLOT_CAPACITY_HALVES[slot]:
            raise HTTPException(
                422,
                detail=(
                    f"{SLOT_LABEL[slot]} holds {_hours(SLOT_CAPACITY_HALVES[slot]):g} h — "
                    f"{ACTIVITY_LABEL[activity]} cannot be {cell.hours:g} h."
                ),
            )
        if halves:
            # Last write wins on a duplicated (slot, activity) rather than
            # summing: a client that sends the same cell twice is buggy, and
            # silently adding the two would hide it behind a plausible number.
            parsed[(slot, activity)] = halves

    per_slot: dict[LedgerSlot, int] = defaultdict(int)
    for (slot, _), halves in parsed.items():
        per_slot[slot] += halves
    for slot, halves in per_slot.items():
        if halves > SLOT_CAPACITY_HALVES[slot]:
            raise HTTPException(
                422,
                detail=(
                    f"{SLOT_LABEL[slot]} is {_hours(halves):g} h against a "
                    f"{_hours(SLOT_CAPACITY_HALVES[slot]):g} h capacity."
                ),
            )
    return parsed


def _write_cells(
    db: Session, ledger: TimeLedgerDay, parsed: dict[tuple[LedgerSlot, DayActivity], int]
) -> None:
    """Replace the day's cells wholesale.

    A whole-day PUT rather than per-cell PATCHes: the slot-capacity rule is a
    property of the SET of cells, so validating one cell at a time would let a
    client build an invalid day out of individually valid writes.

    THE FLUSH BETWEEN THE CLEAR AND THE APPENDS IS LOAD-BEARING. Without it
    SQLAlchemy's unit of work orders every INSERT before the DELETEs of the rows
    they replace, and `uq_ledger_cell` rejects the second write of any day whose
    new figures reuse a (slot, activity) the old ones had — i.e. essentially
    every real edit, including "copy yesterday onto a day I already started".
    Clearing the collection is enough to mark the old rows for deletion
    (delete-orphan), but only the flush makes the database see it first.
    """
    ledger.cells.clear()
    db.flush()
    for (slot, activity), halves in parsed.items():
        ledger.cells.append(TimeLedgerCell(slot=slot, activity=activity, half_hours=halves))


def _editable(ledger: TimeLedgerDay | None) -> None:
    if ledger is not None and ledger.status == LedgerDayStatus.SUBMITTED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This day has been submitted and can no longer be edited.",
        )


@router.put("/ledger", response_model=LedgerOut)
def save_ledger(
    body: LedgerSaveIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LedgerOut:
    """Save the whole day as a draft. Does not submit it."""
    student_id = _require_student(session)
    if body.day > date.today():
        raise HTTPException(422, detail="You cannot log a day that has not happened yet.")

    parsed = _validate_cells(body.cells)
    ledger = load_day(db, student_id, body.day)
    _editable(ledger)
    if ledger is None:
        ledger = TimeLedgerDay(student_id=student_id, day=body.day)
        db.add(ledger)
    _write_cells(db, ledger, parsed)
    db.commit()
    db.refresh(ledger)
    return compose_ledger(body.day, load_day(db, student_id, body.day))


class LedgerDayIn(BaseModel):
    day: date


@router.post("/ledger/copy-yesterday", response_model=LedgerOut)
def copy_yesterday(
    body: LedgerDayIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LedgerOut:
    """Prefill the day from the previous calendar day.

    SUBMITTED ONLY, as the design specifies ("the previous day's submitted
    ledger"). Copying yesterday's half-finished draft would spread a mistake
    forward silently, and the student has no way to tell which day the numbers
    came from once they are sitting in today's boxes.
    """
    student_id = _require_student(session)
    source_day = body.day - timedelta(days=1)
    source = load_day(db, student_id, source_day)
    if source is None or source.status != LedgerDayStatus.SUBMITTED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No submitted ledger for {source_day:%d %b %Y} to copy from.",
        )

    target = load_day(db, student_id, body.day)
    _editable(target)
    if target is None:
        target = TimeLedgerDay(student_id=student_id, day=body.day)
        db.add(target)
    _write_cells(db, target, {(c.slot, c.activity): c.half_hours for c in source.cells})
    db.commit()
    return compose_ledger(body.day, load_day(db, student_id, body.day))


@router.post("/ledger/submit", response_model=LedgerOut)
def submit_ledger(
    body: LedgerDayIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LedgerOut:
    """Latch the day, but only once it reconciles to exactly 24 h.

    The comparison is integer half-hours against DAY_CAPACITY_HALVES — see
    models/time_ledger.py for why that matters. The refusal reuses `_compose`'s
    own `submit_blocked_reason`, so the 409 a scripted client sees and the
    sentence under the disabled button are produced by one expression.
    """
    student_id = _require_student(session)
    ledger = load_day(db, student_id, body.day)
    view = compose_ledger(body.day, ledger)
    if not view.can_submit:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=view.submit_blocked_reason or "This day cannot be submitted yet.",
        )

    assert ledger is not None  # can_submit is False for a day with no rows at all
    ledger.status = LedgerDayStatus.SUBMITTED
    ledger.submitted_at = datetime.now(timezone.utc)
    db.commit()
    return compose_ledger(body.day, load_day(db, student_id, body.day))


# ---------------------------------------------------------------------------
# English Proficiency Baseline
# ---------------------------------------------------------------------------


class EnglishSubscoreOut(BaseModel):
    label: str
    value: int | None


class EnglishSectionOut(BaseModel):
    skill: str
    label: str
    icon: str
    status: str
    score: int | None
    band: str | None
    minutes: int
    subscores: list[EnglishSubscoreOut]
    has_report: bool
    #: The scorer's prose for this section. Sent whole rather than as a
    #: "fetch it separately" id: it is a paragraph, the client already has the
    #: section, and a second round-trip to read two sentences is a spinner for
    #: nothing.
    ai_report: str | None


class EnglishNextStepOut(BaseModel):
    title: str
    sub: str
    target: str | None


class EnglishBaselineOut(BaseModel):
    exists: bool
    status: str
    overall_score: int | None
    band: str | None
    band_label: str | None
    provisional: bool
    taken_on: date | None
    sections_scored: int
    sections_total: int
    progress_percent: int
    pending_label: str | None
    report_available: bool
    strengths: list[str]
    focus_areas: list[str]
    next_steps: list[EnglishNextStepOut]
    sections: list[EnglishSectionOut]


def compose_english_baseline(db: Session, student_id: str) -> EnglishBaselineOut:
    """The latest attempt, or an honest empty shell.

    `exists: false` with the four sections still listed as PENDING, rather than
    a 404: the screen's job when nothing has been taken is to show the four
    skills and a "start" affordance, and a 404 would make the client invent that
    layout from nothing.

    A FUNCTION RATHER THAN A ROUTE BODY, because a mentor reads the same view
    through `routers/staff_screens.py`. Two hand-written copies of "is this
    section pending or scored" is how a mentor ends up seeing a 0 where the
    student sees a dash.
    """
    baseline = db.scalar(
        select(EnglishBaseline)
        .options(selectinload(EnglishBaseline.sections))
        .where(EnglishBaseline.student_id == student_id)
        .order_by(EnglishBaseline.semester.desc())
        .limit(1)
    )

    by_skill: dict[str, EnglishBaselineSection] = {}
    if baseline:
        by_skill = {s.skill.value: s for s in baseline.sections}

    sections: list[EnglishSectionOut] = []
    scored = 0
    pending_names: list[str] = []
    for skill in SKILL_ORDER:
        row = by_skill.get(skill.value)
        is_scored = row is not None and row.status == SectionStatus.SCORED
        if is_scored:
            scored += 1
        else:
            pending_names.append(SKILL_LABEL[skill])
        sections.append(
            EnglishSectionOut(
                skill=skill.value,
                label=SKILL_LABEL[skill],
                icon=SKILL_ICON[skill],
                status=(row.status.value if row else SectionStatus.PENDING.value),
                score=row.score if is_scored else None,
                band=row.band if is_scored else None,
                minutes=row.minutes if row else 0,
                subscores=[
                    EnglishSubscoreOut(label=str(s.get("label", "")), value=s.get("value"))
                    for s in (row.subscores or [])
                ]
                if row
                else [],
                has_report=bool(row and row.ai_report),
                ai_report=(row.ai_report if row and is_scored else None),
            )
        )

    total = len(SKILL_ORDER)
    pending_label = None
    if baseline and pending_names:
        # "Speaking pending · 12 min" — the first outstanding skill and how long
        # that section takes, so the line tells the student what to do next
        # rather than only that something is missing.
        first_pending = next(s for s in SKILL_ORDER if SKILL_LABEL[s] == pending_names[0])
        row = by_skill.get(first_pending.value)
        minutes = row.minutes if row else 0
        pending_label = f"{pending_names[0]} pending" + (f" · {minutes} min" if minutes else "")

    band = baseline.band if baseline else None
    return EnglishBaselineOut(
        exists=baseline is not None,
        status=(baseline.status.value if baseline else BaselineStatus.IN_PROGRESS.value),
        overall_score=baseline.overall_score if baseline else None,
        band=band,
        band_label=CEFR_LABEL.get(band or "", None),
        # "Provisional band" is exactly "not every section is in yet" — derived,
        # never stored, so it cannot survive the section that resolves it.
        provisional=bool(baseline and scored < total),
        taken_on=baseline.taken_on if baseline else None,
        sections_scored=scored,
        sections_total=total,
        progress_percent=round(100 * scored / total),
        pending_label=pending_label,
        report_available=bool(baseline and baseline.report_available),
        strengths=[str(x) for x in (baseline.strengths or [])] if baseline else [],
        focus_areas=[str(x) for x in (baseline.focus_areas or [])] if baseline else [],
        next_steps=[
            EnglishNextStepOut(
                title=str(s.get("title", "")),
                sub=str(s.get("sub", "")),
                target=s.get("target"),
            )
            for s in (baseline.next_steps or [])
        ]
        if baseline
        else [],
        sections=sections,
    )


@router.get("/english-baseline", response_model=EnglishBaselineOut)
def read_english_baseline(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> EnglishBaselineOut:
    return compose_english_baseline(db, _require_student(session))



class EnglishStartOut(BaseModel):
    created: bool
    baseline: EnglishBaselineOut


@router.post("/english-baseline/start", response_model=EnglishStartOut)
def start_english_baseline(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> EnglishStartOut:
    """Open this semester's attempt, or hand back the one already open.

    IDEMPOTENT, and that is the whole design. The button says "Start assessment"
    on a fresh account and "Resume assessment" once an attempt exists, but a
    student who double-taps, or comes back on another device, must not create a
    second attempt — the programme rule is one per semester, and
    `uq_english_baseline_semester` enforces it at the database. Returning the
    existing row instead of a 409 means the client needs no special case for the
    common thing that actually happens.

    It creates the four PENDING sections and nothing else. SCORING IS NOT DONE
    HERE: the scores are written by the assessment pipeline
    (app/models/english_baseline.py), and inventing them here would put a number
    in front of a student that no assessment produced.
    """
    student_id = _require_student(session)
    student = db.get(Student, student_id)
    semester = student.current_semester if student else 1

    existing = db.scalar(
        select(EnglishBaseline)
        .options(selectinload(EnglishBaseline.sections))
        .where(
            EnglishBaseline.student_id == student_id,
            EnglishBaseline.semester == semester,
        )
    )
    if existing is not None:
        return EnglishStartOut(created=False, baseline=compose_english_baseline(db, student_id))

    baseline = EnglishBaseline(
        student_id=student_id, semester=semester, status=BaselineStatus.IN_PROGRESS
    )
    baseline.sections = [
        EnglishBaselineSection(skill=skill, status=SectionStatus.PENDING)
        for skill in SKILL_ORDER
    ]
    db.add(baseline)
    try:
        db.commit()
    except IntegrityError:
        # Two tabs, two taps. The unique constraint is the arbiter; the loser
        # reads the winner's row rather than reporting a failure for something
        # that in fact succeeded.
        db.rollback()
    return EnglishStartOut(created=True, baseline=compose_english_baseline(db, student_id))


@router.get("/english-baseline/report")
def download_english_report(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """The attempt as a PDF.

    RENDERED LOCALLY with ReportLab, like the resume PDF — nothing leaves the
    process, so rule 1's egress gate does not apply and must not be worked
    around by anyone adding a "nicer" remote renderer here. The content is the
    student's own CEFR record: their name, their scores, and the scorer's prose.

    A PENDING section prints "not yet taken", never 0 — the same distinction the
    screen makes, for the same reason. This document is the one a student may
    hand to somebody.
    """
    student_id = _require_student(session)
    view = compose_english_baseline(db, student_id)
    if not view.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="You have not taken the English baseline yet.",
        )

    student = db.get(Student, student_id)
    owner = db.get(User, student.user_id) if student else None
    pdf = render_english_report_pdf(
        student_name=(owner.name if owner else "REEP student"),
        usn=(student.usn if student else None),
        view=view,
    )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="english-baseline.pdf"',
            # The scores change as sections land, so a cached copy is a stale
            # copy of somebody's assessment.
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# Mentor Meeting Log
# ---------------------------------------------------------------------------


class MeetingOut(BaseModel):
    id: str
    met_on: datetime
    day: str
    month: str
    title: str
    location: str | None
    action: str
    action_label: str
    note: str
    logged_by: str


class NextMeetingOut(BaseModel):
    title: str
    location: str | None
    starts_at: datetime


class MentorLogOut(BaseModel):
    mentor_name: str | None
    meetings_logged: int
    last_meeting: datetime | None
    open_actions: int
    next_meeting: NextMeetingOut | None
    meetings: list[MeetingOut]


#: How each linked action reads on the student's own screen. The mentor's
#: vocabulary (FLAGGED, NUDGE_SENT) is internal; a student reading "FLAGGED"
#: about themselves learns nothing and worries more than the note warrants.
_ACTION_LABEL = {
    MentorAction.NONE: "Note only",
    MentorAction.FLAGGED: "Flagged for follow-up",
    MentorAction.NUDGE_SENT: "Reminder sent",
    MentorAction.ONE_ON_ONE_SCHEDULED: "1:1 scheduled",
}

#: Actions that are still outstanding, and so count on the "Open actions" tile.
_OPEN_ACTIONS = frozenset({MentorAction.FLAGGED, MentorAction.ONE_ON_ONE_SCHEDULED})


@router.get("/mentor-meetings", response_model=MentorLogOut)
def read_mentor_meetings(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MentorLogOut:
    """The student's own 1:1 history, newest first, plus the next scheduled one.

    Reads `mentor_notes` filtered to this student's own id from the session —
    the same rows a mentor writes. The screen says plainly that these notes are
    visible to the student and the placement office, which is why nothing here
    is filtered by author or hidden: a note a student cannot see is a note that
    should not have been written on this table.
    """
    student_id = _require_student(session)

    rows = db.scalars(
        select(MentorNote)
        .where(MentorNote.student_id == student_id)
        .order_by(MentorNote.meeting_at.desc())
    ).all()

    mentor_name: str | None = None
    student = db.get(Student, student_id)
    if student is not None and student.mentor_id:
        mentor = db.get(Mentor, student.mentor_id)
        if mentor is not None:
            user = db.get(User, mentor.user_id)
            mentor_name = user.name if user else None

    author_cache: dict[str, str] = {}

    def _author(mentor_id: str) -> str:
        if mentor_id not in author_cache:
            name = "Your mentor"
            mentor = db.get(Mentor, mentor_id)
            if mentor is not None:
                user = db.get(User, mentor.user_id)
                if user is not None and user.name:
                    name = user.name
            author_cache[mentor_id] = name
        return author_cache[mentor_id]

    upcoming = db.scalar(
        select(ScheduleItem)
        .where(
            ScheduleItem.student_id == student_id,
            ScheduleItem.type == ScheduleType.MENTOR_MEETING,
            ScheduleItem.starts_at >= datetime.now(timezone.utc),
        )
        .order_by(ScheduleItem.starts_at)
        .limit(1)
    )

    return MentorLogOut(
        mentor_name=mentor_name,
        meetings_logged=len(rows),
        last_meeting=rows[0].meeting_at if rows else None,
        open_actions=sum(1 for r in rows if r.linked_action in _OPEN_ACTIONS),
        next_meeting=(
            NextMeetingOut(
                title=upcoming.title, location=upcoming.location, starts_at=upcoming.starts_at
            )
            if upcoming
            else None
        ),
        meetings=[
            MeetingOut(
                id=r.id,
                met_on=r.meeting_at,
                day=f"{r.meeting_at:%d}",
                month=f"{r.meeting_at:%b %Y}",
                # Falls back to the action rather than to an empty heading — see
                # the migration's note on not backfilling titles.
                title=r.title or _ACTION_LABEL.get(r.linked_action, "Mentor meeting"),
                location=r.location,
                action=r.linked_action.value,
                action_label=_ACTION_LABEL.get(r.linked_action, r.linked_action.value),
                note=r.note_text,
                logged_by=_author(r.mentor_id),
            )
            for r in rows
        ],
    )



class MeetingRequestIn(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)
    preferred: str | None = Field(default=None, max_length=200)


class MeetingRequestOut(BaseModel):
    sent: bool
    mentor_name: str | None
    detail: str


@router.post("/mentor-meetings/request", response_model=MeetingRequestOut)
def request_mentor_meeting(
    body: MeetingRequestIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MeetingRequestOut:
    """Ask for a 1:1.

    WRITES A MENTOR NOTE, rather than inventing a requests table. The mentor's
    existing instrument for this student is `mentor_notes`, their screen already
    lists it, and a request is exactly a dated line addressed to them. A parallel
    `meeting_requests` table would need its own inbox, its own read/unread state
    and its own place in the mentor UI before it did anything a note does not —
    and until all three existed the request would land nowhere anyone looks.

    Attributed honestly: the note is authored under the MENTOR's id (the column
    is NOT NULL and points at `mentors`), so the text says plainly that the
    student asked. `logged_by` on the student's own log would otherwise read as
    the mentor having written it themselves.

    A student with no mentor assigned gets a truthful refusal rather than a
    silent success — a request nobody can receive is worse than a "not yet".
    """
    student_id = _require_student(session)
    student = db.get(Student, student_id)
    if student is None or not student.mentor_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "You do not have a mentor assigned yet, so there is nobody to send "
                "this to. The placement office assigns mentors."
            ),
        )

    mentor = db.get(Mentor, student.mentor_id)
    owner = db.get(User, mentor.user_id) if mentor else None
    mentor_name = owner.name if owner else None

    reason = body.reason.strip()
    preferred = (body.preferred or "").strip()
    text = f"Meeting requested by the student. {reason}"
    if preferred:
        text += f" Preferred time: {preferred}."

    db.add(
        MentorNote(
            mentor_id=student.mentor_id,
            student_id=student_id,
            note_text=text,
            title="Meeting requested",
            linked_action=MentorAction.NONE,
            meeting_at=datetime.now(timezone.utc),
        )
    )
    db.commit()

    return MeetingRequestOut(
        sent=True,
        mentor_name=mentor_name,
        detail=(
            f"Sent to {mentor_name}. It appears in your meeting log below."
            if mentor_name
            else "Sent to your mentor. It appears in your meeting log below."
        ),
    )


# ---------------------------------------------------------------------------
# Programme stage cards (landing)
# ---------------------------------------------------------------------------


class ProgrammeItemOut(BaseModel):
    key: str
    label: str
    route: str | None
    status: str
    glyph: str
    tone: str
    title: str


class ProgrammeStageOut(BaseModel):
    key: str
    label: str
    completed: int
    total: int
    items: list[ProgrammeItemOut]


class ProgrammeOut(BaseModel):
    stages: list[ProgrammeStageOut]
    completed: int
    total: int
    percent: int


@router.get("/programme", response_model=ProgrammeOut)
def read_programme(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ProgrammeOut:
    """The three landing cards: Reboot, Excel, Elevate.

    Structure comes from the code catalogue and status from `student_milestones`
    — with one exception the catalogue itself marks: `english_baseline` is
    DERIVED from the attempt, so a student who has taken the assessment sees
    that reflected without anyone having to remember to write a milestone row
    too. Two sources of truth for one row on one card is exactly how that row
    ends up saying "not started" under a completed report.
    """
    student_id = _require_student(session)

    stored = {
        row.key: row.status
        for row in db.scalars(
            select(StudentMilestone).where(StudentMilestone.student_id == student_id)
        ).all()
        if row.key in MILESTONES  # a removed catalogue key is inert, not fatal
    }

    baseline = db.scalar(
        select(EnglishBaseline)
        .options(selectinload(EnglishBaseline.sections))
        .where(EnglishBaseline.student_id == student_id)
        .order_by(EnglishBaseline.semester.desc())
        .limit(1)
    )
    if baseline is None:
        derived_english = MilestoneStatus.NOT_STARTED
    elif baseline.status == BaselineStatus.COMPLETE:
        derived_english = MilestoneStatus.COMPLETED
    else:
        derived_english = MilestoneStatus.IN_PROGRESS

    stages: list[ProgrammeStageOut] = []
    done_all = 0
    total_all = 0
    for stage in STAGES:
        items: list[ProgrammeItemOut] = []
        done = 0
        for item in stage.items:
            if item.derived_from == "english_baselines":
                item_status = derived_english
            else:
                item_status = stored.get(item.key, MilestoneStatus.NOT_STARTED)
            if item_status == MilestoneStatus.COMPLETED:
                done += 1
            glyph, tone, title = STATUS_GLYPH[item_status]
            items.append(
                ProgrammeItemOut(
                    key=item.key,
                    label=item.label,
                    route=item.route,
                    status=item_status.value,
                    glyph=glyph,
                    tone=tone,
                    title=title,
                )
            )
        done_all += done
        total_all += len(items)
        stages.append(
            ProgrammeStageOut(
                key=stage.key, label=stage.label, completed=done, total=len(items), items=items
            )
        )

    return ProgrammeOut(
        stages=stages,
        completed=done_all,
        total=total_all,
        percent=round(100 * done_all / total_all) if total_all else 0,
    )
