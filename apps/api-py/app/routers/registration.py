"""Programme sign-up flow (ported from the Next.js registration path).

Public submission runs the data-driven rule engine: among enabled rules, every
*populated* condition (email domain, USN regex, degree level) must match, and the
lowest `priority` among the matches decides. A matching auto-approve rule waves
the application through (AUTO_APPROVED) and assigns its cohort; a matching
non-auto rule routes it to a human (PENDING_REVIEW) with a label; no match falls
to manual review. Directors then approve/reject the queue.

Provisioning the actual Student (User row, cohort seat) is a deliberate
follow-up step, not done here — approval only stamps the decision, mirroring the
model note that a Student cannot exist until approval has decided a cohort.
"""

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.job import DegreeLevel
from ..models.registration import Registration, RegistrationRule, RegistrationStatus
from .mentor import require_director

router = APIRouter(prefix="/register", tags=["registration"])


def _email_domain(email: str) -> str:
    return email.rsplit("@", 1)[-1].lower()


def _rule_matches(rule: RegistrationRule, email: str, usn: str | None, degree: DegreeLevel) -> bool:
    """All populated conditions must hold; an empty condition is a wildcard."""
    if rule.email_domain and _email_domain(email) != rule.email_domain.lower():
        return False
    if rule.usn_pattern:
        if not usn or not re.search(rule.usn_pattern, usn):
            return False
    if rule.degree_level is not None and rule.degree_level != degree:
        return False
    return True


def _pick_rule(
    db: Session, email: str, usn: str | None, degree: DegreeLevel
) -> RegistrationRule | None:
    """Lowest priority among the enabled rules that match wins (ties broken by
    creation order, so a rule added later can't silently outrank an equal)."""
    candidates = db.scalars(
        select(RegistrationRule)
        .where(RegistrationRule.enabled.is_(True))
        .order_by(RegistrationRule.priority, RegistrationRule.created_at)
    ).all()
    for rule in candidates:
        if _rule_matches(rule, email, usn, degree):
            return rule
    return None


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    # A plain string with a light shape check (avoids the email-validator dep);
    # the domain is what the rule engine actually keys on.
    email: str = Field(min_length=3, max_length=200)
    usn: str | None = Field(default=None, max_length=32)
    phone: str | None = Field(default=None, max_length=32)
    degree_level: DegreeLevel = DegreeLevel.PG


class RegistrationOut(BaseModel):
    id: str
    name: str
    email: str
    usn: str | None
    degree_level: str
    status: str
    cohort_id: str | None
    matched_rule_id: str | None
    decision_reason: str | None
    reviewed_by_id: str | None
    reviewed_at: datetime | None
    review_note: str | None
    approved_student_id: str | None
    created_at: datetime


def _out(r: Registration) -> RegistrationOut:
    return RegistrationOut(
        id=r.id,
        name=r.name,
        email=r.email,
        usn=r.usn,
        degree_level=r.degree_level.value,
        status=r.status.value,
        cohort_id=r.cohort_id,
        matched_rule_id=r.matched_rule_id,
        decision_reason=r.decision_reason,
        reviewed_by_id=r.reviewed_by_id,
        reviewed_at=r.reviewed_at,
        review_note=r.review_note,
        approved_student_id=r.approved_student_id,
        created_at=r.created_at,
    )


@router.post("", response_model=RegistrationOut, status_code=status.HTTP_201_CREATED)
def submit(body: RegisterIn, db: Session = Depends(get_db)) -> RegistrationOut:
    """Public: submit an application. No auth — the applicant is not a user yet."""
    email = body.email.strip().lower()
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A valid email is required."
        )
    if db.scalar(select(Registration).where(Registration.email == email)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An application with this email already exists.",
        )

    rule = _pick_rule(db, email, body.usn, body.degree_level)
    if rule is None:
        status_ = RegistrationStatus.PENDING_REVIEW
        reason = "No rule matched — needs manual review."
        cohort_id = None
        rule_id = None
    elif rule.auto_approve:
        status_ = RegistrationStatus.AUTO_APPROVED
        reason = f"Auto-approved by rule '{rule.name}'."
        cohort_id = rule.cohort_id
        rule_id = rule.id
    else:
        status_ = RegistrationStatus.PENDING_REVIEW
        reason = f"Routed by rule '{rule.name}' — awaiting review."
        cohort_id = rule.cohort_id
        rule_id = rule.id

    reg = Registration(
        name=body.name.strip(),
        email=email,
        usn=body.usn,
        phone=body.phone,
        degree_level=body.degree_level,
        status=status_,
        cohort_id=cohort_id,
        matched_rule_id=rule_id,
        decision_reason=reason,
    )
    db.add(reg)
    db.commit()
    db.refresh(reg)
    return _out(reg)


@router.get("/pending", response_model=list[RegistrationOut])
def pending(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[RegistrationOut]:
    """Director review queue — applications a human still needs to decide."""
    require_director(session)
    rows = db.scalars(
        select(Registration)
        .where(Registration.status == RegistrationStatus.PENDING_REVIEW)
        .order_by(Registration.created_at)
    ).all()
    return [_out(r) for r in rows]


class DecisionIn(BaseModel):
    decision: str  # "APPROVE" | "REJECT"
    note: str | None = None


@router.post("/{registration_id}/decision", response_model=RegistrationOut)
def decide(
    registration_id: str,
    body: DecisionIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> RegistrationOut:
    """Director: approve or reject a pending application. Stamps the reviewer;
    Student provisioning is a separate follow-up step."""
    require_director(session)
    reg = db.get(Registration, registration_id)
    if reg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if reg.status in (RegistrationStatus.APPROVED, RegistrationStatus.REJECTED):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Application already decided."
        )
    decision = body.decision.upper()
    if decision == "APPROVE":
        reg.status = RegistrationStatus.APPROVED
    elif decision == "REJECT":
        reg.status = RegistrationStatus.REJECTED
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be APPROVE or REJECT.",
        )
    reg.reviewed_by_id = session["userId"]
    reg.reviewed_at = datetime.now(timezone.utc)
    reg.review_note = body.note
    db.commit()
    db.refresh(reg)
    return _out(reg)


class RuleOut(BaseModel):
    id: str
    name: str
    enabled: bool
    email_domain: str | None
    usn_pattern: str | None
    degree_level: str | None
    cohort_id: str | None
    auto_approve: bool
    priority: int


@router.get("/rules", response_model=list[RuleOut])
def rules(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[RuleOut]:
    """Director: the active rule set, in the order the engine evaluates it."""
    require_director(session)
    rows = db.scalars(
        select(RegistrationRule).order_by(RegistrationRule.priority, RegistrationRule.created_at)
    ).all()
    return [
        RuleOut(
            id=r.id,
            name=r.name,
            enabled=r.enabled,
            email_domain=r.email_domain,
            usn_pattern=r.usn_pattern,
            degree_level=r.degree_level.value if r.degree_level is not None else None,
            cohort_id=r.cohort_id,
            auto_approve=r.auto_approve,
            priority=r.priority,
        )
        for r in rows
    ]
