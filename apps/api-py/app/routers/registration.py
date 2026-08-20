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

import logging
import re
import time
from datetime import datetime, timezone
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.job import DegreeLevel
from ..models.registration import Registration, RegistrationRule, RegistrationStatus
from .mentor import require_director

router = APIRouter(prefix="/register", tags=["registration"])

log = logging.getLogger(__name__)


# --- usn_pattern is DB-sourced regex run on an UNAUTHENTICATED endpoint -------
#
# `RegistrationRule.usn_pattern` is a regular expression that arrives from the
# database and is executed on POST /register, which has no cookie and no roster
# check in front of it. Two ways that ends badly, and in both the *rule* is the
# thing that is broken while the *front door* is the thing that falls over:
#
#   * an invalid pattern (a bare "[") raises re.error inside the engine, so every
#     USN-carrying application 500s and nothing in the response — or, before
#     this, in the log — names the rule that did it;
#   * a catastrophic pattern ("(a+)+$") backtracks exponentially: a ReDoS an
#     anonymous caller can fire at will, one HTTP request at a time.
#
# Planting either needs a director/DB write, so this is a blast-radius problem
# rather than an entry point. It is defended twice anyway, because a rule row can
# always be edited straight in psql and skip whatever the write path checks:
#
#   1. validate_usn_pattern() at rule-WRITE time. app/seed.py is the only writer
#      today (the RegistrationRule(...) block); any future director-facing rule
#      editor MUST call it before commit and hand the ValueError back to the
#      author, who is the only person able to fix the pattern.
#   2. _usn_matcher() at MATCH time, which refuses to run a pattern that fails
#      the same check and drops that one rule instead of the request.

# A USN format is a short fixed shape ("^1BG2[0-9]MBA[0-9]{3}$"). Nothing
# legitimate needs more than this, and the cap is what stops a pathological
# pattern being pasted in at all.
MAX_USN_PATTERN_LENGTH = 200

# Backtracking cost is a function of the SUBJECT length, so the engine is never
# handed a long one. RegisterIn already caps `usn` at 32, but _rule_matches is a
# module-level helper with its own tests and callers: it must not depend on its
# caller for the bound that keeps it cheap.
MAX_USN_MATCH_LENGTH = 64

# A quantifier applied to a group — "(...)+", "(...)*", "(...){2,}" — is the shape
# behind essentially every real-world ReDoS, including the overlapping-alternation
# form "(a|aa)+" that a nested-quantifier check alone would miss. Deciding whether
# an arbitrary regex backtracks catastrophically is not something to attempt in a
# router, and a USN pattern has no honest use for a quantified group, so the whole
# shape is refused. If you ever genuinely need one, the rule engine is the wrong
# place for it — match in code, not in a row an operator can edit.
_QUANTIFIED_GROUP = re.compile(r"\)[*+{]")


def validate_usn_pattern(pattern: str) -> re.Pattern[str]:
    """Compile a rule's `usn_pattern`, refusing what the public endpoint cannot
    afford to run. Raises ValueError with a message written for whoever is
    authoring the rule — they are the only person who can fix it."""
    if len(pattern) > MAX_USN_PATTERN_LENGTH:
        raise ValueError(f"usn_pattern is longer than {MAX_USN_PATTERN_LENGTH} characters")
    if _QUANTIFIED_GROUP.search(pattern):
        raise ValueError(
            "usn_pattern applies a quantifier to a group — refused as a "
            "catastrophic-backtracking risk on the public registration endpoint"
        )
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"usn_pattern is not a valid regular expression: {exc}") from exc


@lru_cache(maxsize=256)
def _usn_matcher(pattern: str) -> re.Pattern[str] | None:
    """The compiled matcher for a rule, or None for a pattern we refuse to run.

    The cache does two jobs. It keeps regex compilation off the path of every
    application, and it makes the "unusable rule" WARNING fire once per distinct
    pattern per process rather than once per applicant — a log flooded by the
    hundredth copy is a log in which nobody finds the one line naming the bad
    rule. Fix the pattern in the database and the new string is a new cache key,
    so the fix takes effect with no restart; the WARNING reappears once if the
    new pattern is also unusable.
    """
    try:
        return validate_usn_pattern(pattern)
    except ValueError as exc:
        log.warning(
            "Registration rule has an unusable usn_pattern (%s) — that rule is "
            "SKIPPED, not matched: %r",
            exc,
            pattern[:120],
        )
        return None


def _email_domain(email: str) -> str:
    return email.rsplit("@", 1)[-1].lower()


def _rule_matches(rule: RegistrationRule, email: str, usn: str | None, degree: DegreeLevel) -> bool:
    """All populated conditions must hold; an empty condition is a wildcard."""
    if rule.email_domain and _email_domain(email) != rule.email_domain.lower():
        return False
    if rule.usn_pattern:
        matcher = _usn_matcher(rule.usn_pattern)
        if matcher is None:
            # An unusable pattern is a broken RULE, not a broken APPLICATION.
            # Skipping it lets the engine fall through to the next rule — worst
            # case, manual review — where raising took every USN-carrying
            # submission down with it.
            return False
        if not usn or len(usn) > MAX_USN_MATCH_LENGTH:
            # Longer than any real USN. Refused rather than truncated: a
            # truncated subject would let "^...$" match a prefix of something
            # that is not a USN at all.
            return False
        try:
            if not matcher.search(usn):
                return False
        except (re.error, RecursionError) as exc:
            # Compilation already succeeded, so this is the rare match-time
            # failure. Same verdict as an unusable pattern: lose the rule, keep
            # the endpoint.
            log.warning(
                "Registration rule usn_pattern failed at match time (%s) — rule "
                "SKIPPED: %r",
                exc,
                rule.usn_pattern[:120],
            )
            return False
    if rule.degree_level is not None and rule.degree_level != degree:
        return False
    return True


# --- The one unauthenticated write in the app ---------------------------------
#
# POST /register takes no cookie, consults no roster, and INSERTs a row. Without
# a limit it is both a database flood anyone can start and — together with the
# duplicate-email branch in submit() — a free "has this person applied here"
# lookup for anyone holding a list of names.
#
# Fixed window, keyed on the socket peer, held in this process. Three caveats
# stated plainly so nobody reads more into it than it gives:
#
#   * PER WORKER. N uvicorn workers give N times this limit, and a restart
#     forgets every window. It raises the cost of a flood; it is not a quota, and
#     a real one needs shared state (Postgres or Redis) this endpoint does not
#     have.
#   * The key is request.client.host, the SOCKET peer. Behind a reverse proxy
#     that is the proxy, so an entire campus can share one bucket — which is why
#     the limit is deliberately generous rather than tight: a class of sixty
#     applying from one NAT on results day must not lock itself out. If you put a
#     trusted proxy in front, read the real client from ITS header and say so
#     here. X-Forwarded-For is not trusted as it stands, because a header the
#     caller sets is a limiter the caller can switch off.
#   * The table is bounded, so the limiter cannot itself become the memory
#     exhaustion it exists to prevent. An attacker with thousands of live source
#     addresses can flush it — but they can also just spend the limit from each
#     of those addresses, so the table size was never the control.
_RATE_WINDOW_SECONDS = 600
_RATE_MAX_PER_WINDOW = 20
_RATE_MAX_KEYS = 4096
_rate_windows: dict[str, tuple[float, int]] = {}


def _rate_limit_retry_after(client_ip: str) -> int | None:
    """Count this attempt. Returns None to proceed, or seconds until the window
    resets when the caller has spent it."""
    now = time.monotonic()
    window_start, count = _rate_windows.get(client_ip, (now, 0))
    if now - window_start >= _RATE_WINDOW_SECONDS:
        window_start, count = now, 0
    if count >= _RATE_MAX_PER_WINDOW:
        # Not recorded: a caller who keeps hammering must not extend their own
        # window, or a refusal would become a permanent block.
        return max(1, int(_RATE_WINDOW_SECONDS - (now - window_start)))
    if client_ip not in _rate_windows and len(_rate_windows) >= _RATE_MAX_KEYS:
        for key, (started, _n) in list(_rate_windows.items()):
            if now - started >= _RATE_WINDOW_SECONDS:
                del _rate_windows[key]
        if len(_rate_windows) >= _RATE_MAX_KEYS:
            _rate_windows.clear()  # every window still live: start over, never grow
    _rate_windows[client_ip] = (window_start, count + 1)
    return None


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
def submit(
    body: RegisterIn, request: Request, db: Session = Depends(get_db)
) -> RegistrationOut:
    """Public: submit an application. No auth — the applicant is not a user yet."""
    # Limit BEFORE the database is touched: the point is that a flood never
    # reaches Postgres, not that Postgres survives it.
    client_ip = request.client.host if request.client else "unknown"
    retry_after = _rate_limit_retry_after(client_ip)
    if retry_after is not None:
        log.warning(
            "POST /api/register rate-limited (%s attempts in %ss) for %s",
            _RATE_MAX_PER_WINDOW,
            _RATE_WINDOW_SECONDS,
            client_ip,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts from this network. Please try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )

    email = body.email.strip().lower()
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A valid email is required."
        )
    existing = db.scalar(select(Registration).where(Registration.email == email))
    if existing is not None:
        # Deliberately does NOT confirm that an application exists for this
        # address. The old wording ("An application with this email already
        # exists.") turned the public form into a "has X applied to this college"
        # lookup for anyone with a list of names, and applying somewhere is not
        # something an applicant chose to publish.
        #
        # Be honest about what is left: the STATUS CODE still separates the two
        # cases — a fresh submission 201s, this 409s — and the only complete fix
        # is to answer every submission identically and send the real outcome out
        # of band by email, which this endpoint does not do. The rate limit above
        # is what makes walking a roster through the remaining tell slow rather
        # than free. The real application id goes to the log, not the response, so
        # support can still find it.
        log.info(
            "POST /api/register refused a duplicate application (registration id=%s)",
            existing.id,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This application could not be accepted. If you have already applied, "
                "or you think this is a mistake, contact the placement office."
            ),
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
