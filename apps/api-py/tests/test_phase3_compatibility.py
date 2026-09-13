"""07 §5 — what must still be true after Phase 3, for people who were already here.

Phase 3 changed how access is decided, in four places at once: the MENTOR role
baseline shrank to two keys (B2.3), eleven list endpoints started narrowing
themselves to the caller's reach (B1.4), grants gained a rung of the spine to
hang on (B1.2), and provisioning gained a domain fence (B1.1). Every one of
those is a change to who can see what, made on a deployment that already has
faculty signing in, grants in the table and students on the roster.

The acceptance checklist calls these the COMPATIBILITY GUARDRAILS, and they are
a different kind of test from the ones beside them. `test_grant_scope.py` proves
the new rule works. These prove the OLD behaviour survived it — which is the
half that nobody notices is broken until a faculty member cannot open a screen
they opened yesterday, and by then the deploy is three days old and the change
that did it is one of forty.

Each test names the guardrail it holds. Guardrails whose subject is a Phase 4
task (batch promotion, graduation, the daily interview cap, summary backfill)
are NOT here and are not silently missing: there is a written note at the foot
of this module saying which, and why they cannot be pinned yet.

WRITTEN AGAINST THE REAL SEED, because that is the population these guarantees
are about. A guardrail proven only against rows the test itself invented is a
guardrail about the test.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from conftest import requires_db

from app.db import SessionLocal
from app.governance import ROLE_BASELINE, capabilities_for, granted_reaches
from app.mentor_functions import MENTOR_FUNCTIONS, mentee_count, mentor_functions_for
from app.models.governance import CapabilityGrant, ScopeLevel, SubjectKind
from app.models.institution import Department
from app.models.user import Mentor, Role, Student, User
from app.policies import scope_filter
from app.seed_roster import SSO_ONLY_PASSWORD_HASH

ADMIN = ("admin@bgscet.ac.in", "admin123")
MENTOR = ("mentor@bgscet.ac.in", "mentor123")
STUDENT = ("student@bgscet.ac.in", "student123")


@pytest.fixture
def unmentored_faculty():
    """A MENTOR-role account with no `Mentor` row and no students.

    THE POPULATION B2.3 IS ABOUT. AGENTS.md has said "a faculty account is not a
    mentor by existing" since the Main Admin console landed, and every one of
    the four endpoints already behaved that way; what B2.3 changed is that the
    CAPABILITY now says so too. This account is how the two are compared.
    """
    tag = uuid.uuid4().hex[:8]
    with SessionLocal() as db:
        user = User(
            email=f"unmentored-{tag}@bgscet.ac.in",
            name="Unmentored Faculty",
            role=Role.MENTOR,
            password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        db.add(user)
        db.commit()
        uid = user.id
    yield uid
    with SessionLocal() as db:
        # Signing this account in — which two of these tests do — writes a
        # `login_days` row and, since B15, a `login_events` one, and both hold a
        # real FK to `users` with no ON DELETE. Deleting the user without them
        # is a ForeignKeyViolation that fails the NEXT test to run, in a
        # teardown, which is the least legible place a failure can appear.
        from app.models.account_events import LoginEvent
        from app.models.user import LoginDay

        db.execute(delete(LoginEvent).where(LoginEvent.user_id == uid))
        db.execute(delete(LoginDay).where(LoginDay.user_id == uid))
        db.execute(delete(CapabilityGrant).where(CapabilityGrant.subject_user_id == uid))
        db.execute(delete(User).where(User.id == uid))
        db.commit()


# ----------------------------------------------------------- the role itself --


@requires_db
def test_existing_faculty_still_sign_in_and_their_role_is_unchanged(client, login):
    """GUARDRAIL: "Existing faculty sign in; `users.role` unchanged."

    B2.3 shrank what MENTOR *means*, and the failure mode worth naming is the
    one where somebody "simplifies" that by changing the role of the accounts
    instead. A role migration is invisible in a diff of governance.py and
    catastrophic: every `require_mentor` gate in the product reads the role.
    """
    headers = login(*MENTOR)
    me = client.get("/api/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    assert me.json()["role"] == "MENTOR"

    with SessionLocal() as db:
        row = db.scalar(select(User).where(User.email == MENTOR[0]))
        assert row is not None and row.role == Role.MENTOR


@requires_db
def test_faculty_with_mentees_keep_the_four_group_functions(client, login):
    """GUARDRAIL: "Faculty with mentees keep Mentee Log / Verifications / Leave queue."

    The seeded mentor has one mentee, so they hold the four. Asserted through
    `/api/auth/me`, which is the list the client actually renders its nav from —
    not through `mentor_functions_for` alone, which would prove the helper works
    and not that the session sees it.
    """
    headers = login(*MENTOR)
    capabilities = set(client.get("/api/auth/me", headers=headers).json()["capabilities"])

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == MENTOR[0]))
        assert mentee_count(db, user.id) > 0, "the seed's mentor lost their mentee"

    assert MENTOR_FUNCTIONS <= capabilities, (
        "a faculty member with mentees lost a function they held before Phase 3"
    )
    # And the personal two, which never depended on the group.
    assert {"mentor.agent", "mentor.upskilling"} <= capabilities


@requires_db
def test_faculty_without_mentees_keep_their_own_things_and_nothing_else(unmentored_faculty):
    """GUARDRAIL: "Faculty without see Notebook, Leave (own), Signature, Agent."

    The four GROUP functions go; the two PERSONAL ones stay. Those two are in
    the baseline deliberately — the assistant and one's own certificate shelf
    belong to the person, and taking them away between assignments would be
    removing their own things.

    Signature and one's own leave are NOT capabilities at all and never were:
    `/api/staff/signature` and `POST /api/leaves` gate on the ROLE. That is why
    this test asserts the capability set is exactly the baseline rather than
    looking for keys named after those screens — a reader who expects to find
    `mentor.signature` here should find this sentence instead.
    """
    with SessionLocal() as db:
        session = {"role": "MENTOR", "userId": unmentored_faculty}
        assert mentor_functions_for(db, unmentored_faculty) == frozenset()
        assert capabilities_for(db, session) == ROLE_BASELINE["MENTOR"]
        assert capabilities_for(db, session) == frozenset(
            {"mentor.agent", "mentor.upskilling"}
        )


@requires_db
def test_the_capability_and_the_endpoint_agree_about_an_unmentored_faculty(
    client, login, unmentored_faculty
):
    """The two halves that a role removal is famous for splitting.

    `test_no_director_privilege.py` exists because the DIRECTOR removal reached
    the role gates and not the capability baseline, and a session refused by
    every `require_*` was admitted by every `require_capability`. B2.3 is the
    same shape of change in the other direction, so the same pairing is checked:
    the capability list and the endpoint must give the SAME answer.
    """
    with SessionLocal() as db:
        user = db.get(User, unmentored_faculty)
        email, password = user.email, "compat-guardrail-pw-2026"
        from app.security import hash_password

        user.password_hash = hash_password(password)
        db.commit()

    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    headers = {"Cookie": r.headers.get("set-cookie", "")}
    client.cookies.clear()

    capabilities = set(client.get("/api/auth/me", headers=headers).json()["capabilities"])
    assert "mentor.mentees" not in capabilities

    # ...and the endpoint says the same thing. A mentor with no group sees
    # NOBODY — rule 2's words — which is an empty list, not a refusal, because
    # they are staff and the question is legitimate.
    mentees = client.get("/api/mentor/mentees", headers=headers)
    assert mentees.status_code in (200, 403), mentees.text
    if mentees.status_code == 200:
        assert mentees.json() == [], (
            "the capability says no mentees and the endpoint returned some"
        )


# ------------------------------------------------------------------- grants --


@requires_db
def test_a_grant_made_before_b1_2_still_opens_its_screen(unmentored_faculty):
    """GUARDRAIL: "Every pre-existing grant still opens its screen (scope = BGSCET)."

    Every row written before B1.2 has NULL in both scope columns, because there
    was nothing to put there. `granted_reaches` must read that pair as
    programme-wide and `scope_filter` must answer `everything` — if either ever
    reads NULL as "reaches nothing", every grant in the product silently stops
    working on deploy, and the screen it opens goes empty rather than refusing,
    which is the version nobody reports as a permissions bug.

    Written as a RAW ROW with NULLs rather than through the endpoint, because
    the endpoint is the new code and the row is what is already in the database.
    """
    with SessionLocal() as db:
        grant = CapabilityGrant(
            capability="admin.analytics",
            subject_kind=SubjectKind.USER,
            subject_user_id=unmentored_faculty,
            scope_level=None,
            scope_id=None,
            reason="A grant made before scope targets existed at all.",
        )
        db.add(grant)
        db.commit()

        assert granted_reaches(db, unmentored_faculty, "admin.analytics") == [(None, None)]
        reach = scope_filter(
            db, {"role": "MENTOR", "userId": unmentored_faculty}, "admin.analytics"
        )
        assert reach.everything, "a pre-existing grant stopped reaching the programme"
        assert not reach.nothing


@requires_db
def test_the_main_admin_is_never_narrowed_by_scoping(client, login):
    """GUARDRAIL, and the one that covers several others at once.

    "FIRST_APPROVED leave rows are decidable by the Main Admin immediately" and
    "SWOC entries show their author without re-entry" are both really this: the
    office account holds its keys through ROLE_BASELINE, and a baseline
    capability is UNSCOPED by design (`require_capability` says why). So B1.4
    narrowed nothing for the one account that must see everything.

    Proven on the queues B1.4 actually rewrote, through HTTP, because that is
    where a scope projection that defaulted the wrong way would show up.
    """
    headers = login(*ADMIN)
    with SessionLocal() as db:
        admin = db.scalar(select(User).where(User.email == ADMIN[0]))
        session = {"role": "ADMIN", "userId": admin.id}
        for key in ("admin.analytics", "admin.exports", "admin.swoc", "mentor.leave_approve"):
            if key in ROLE_BASELINE["ADMIN"]:
                assert scope_filter(db, session, key).everything, (
                    f"the Main Admin was narrowed on {key}"
                )

    for path in ("/api/leaves/pending", "/api/admin/swoc"):
        r = client.get(path, headers=headers)
        assert r.status_code == 200, f"{path}: {r.text}"


@requires_db
def test_swoc_entries_still_carry_their_author(client, login):
    """GUARDRAIL: "SWOC entries show their author without re-entry."

    B1.4 added a scope projection to this list. The author is a JOIN onto
    `swoc_entries.author_user_id`, and a rewritten query that dropped it would
    leave every entry reading as written by nobody — which on a screen whose
    whole purpose is a named judgement about a student is worse than an error.

    WRITTEN HERE RATHER THAN READ FROM THE SEED, and that distinction cost a
    false failure before it was understood: `app/seed.py` writes its four SWOC
    entries with NO `author_user_id`, so a seeded entry answers `author: null`
    CORRECTLY — the schema's own comment allows null for an account that is
    gone, and a demo row nobody wrote is the same shape of fact. Asserting
    against those rows tests the seed, not the join. So this test creates one
    through the real endpoint, as a real person, and reads it back.
    """
    from app.models.swoc import SwocEntry

    headers = login(*ADMIN)
    listing = client.get("/api/admin/swoc", headers=headers)
    assert listing.status_code == 200, listing.text
    students = listing.json()
    if not students:
        pytest.skip("no students on this deployment to write a SWOC entry about")
    student_id = students[0]["student_id"]

    created = client.post(
        f"/api/admin/swoc/{student_id}",
        headers=headers,
        json={
            "kind": "STRENGTH",
            "text": "Compatibility guardrail: this entry must name its author.",
            "weight": 3,
        },
    )
    assert created.status_code in (200, 201), created.text
    entry_id = created.json().get("id")
    assert entry_id

    try:
        again = client.get("/api/admin/swoc", headers=headers)
        assert again.status_code == 200, again.text
        mine = [
            e
            for row in again.json()
            for e in (row.get("entries") or [])
            if e.get("id") == entry_id
        ]
        assert mine, "the entry that was just written is not in the list"
        assert mine[0].get("author"), (
            "an entry written by a named admin came back with no author — "
            "the join was dropped"
        )
    finally:
        with SessionLocal() as db:
            db.execute(delete(SwocEntry).where(SwocEntry.id == entry_id))
            db.commit()


# ------------------------------------------------------------- the student --


@requires_db
def test_student_routes_are_untouched_by_scoping(client, login):
    """GUARDRAIL: "Student routes and APIs unchanged by scoping."

    B1.4 edited eight routers. `policies.scope_filter` answers a question about
    a STAFF member's reach and has no meaning for a student reading their own
    record — a student's fence is rule 2 and their own session, which is a
    different and stricter gate. If a scope projection ever leaks onto one of
    these, a student starts seeing an empty dashboard with a 200 beside it.
    """
    headers = login(*STUDENT)
    for path in (
        "/api/student/profile",
        "/api/student/dashboard",
        "/api/student/jobs",
        "/api/student/programme",
        "/api/student/ledger",
    ):
        r = client.get(path, headers=headers)
        assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"
        assert "X-Reep-Scope" not in r.headers, (
            f"{path} grew a staff scope header; a student has no scope"
        )


@requires_db
def test_a_student_is_still_refused_every_console_surface(client, login):
    """The fence that all of Phase 3's rewriting had to leave standing.

    Named separately from the capability tests because it is a different claim:
    not "a student holds no capability" but "no Phase 3 endpoint answers one".
    """
    headers = login(*STUDENT)
    for path in (
        "/api/admin/audit",
        "/api/admin/faculty",
        "/api/admin/governance/grants",
        "/api/admin/exports/history",
    ):
        r = client.get(path, headers=headers)
        assert r.status_code in (401, 403), f"{path} answered {r.status_code} to a student"


# -------------------------------------------------------- faculty lifecycle --


@requires_db
def test_disabling_one_account_leaves_every_other_untouched(client, login, unmentored_faculty):
    """GUARDRAIL: "Disabled faculty only: active accounts untouched."

    The obvious failure is an UPDATE with no WHERE. The quieter one is a
    `token_version` bump that reaches further than the row it was about — which
    under one-device-at-a-time signs a colleague out mid-task with no
    explanation, and reads to them as the app logging them out at random.
    """
    headers = login(*ADMIN)
    with SessionLocal() as db:
        others = {
            u.id: (u.token_version or 0, u.disabled_at)
            for u in db.scalars(
                select(User).where(User.role.in_([Role.MENTOR, Role.ADMIN]))
            ).all()
            if u.id != unmentored_faculty
        }
    assert others, "no other staff accounts to compare against"

    r = client.post(
        f"/api/admin/users/{unmentored_faculty}/disable",
        headers=headers,
        json={"reason": "Compatibility guardrail: disabling exactly one account."},
    )
    assert r.status_code == 200, r.text
    assert r.json()["disabled"] is True

    with SessionLocal() as db:
        for uid, (version, disabled_at) in others.items():
            now = db.get(User, uid)
            assert (now.token_version or 0) == version, (
                f"disabling one account bumped {now.email}'s token version"
            )
            assert now.disabled_at == disabled_at, (
                f"disabling one account changed {now.email}'s disabled state"
            )


@requires_db
def test_an_activation_link_is_not_revoked_by_somebody_elses(client, login, unmentored_faculty):
    """GUARDRAIL: "Activation links already sent stay valid to expiry."

    Issuing a link SUPERSEDES every older live one — for that user. The rule is
    per account, and a superseding query written without its user predicate
    would invalidate every outstanding link in the product every time an admin
    minted one, which presents as "the link you were sent does not work" for
    people who were never mentioned.
    """
    headers = login(*ADMIN)
    tag = uuid.uuid4().hex[:8]
    with SessionLocal() as db:
        other = User(
            email=f"bystander-{tag}@bgscet.ac.in",
            name="Bystander Faculty",
            role=Role.MENTOR,
            password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        db.add(other)
        db.commit()
        other_id = other.id

    try:
        first = client.post(f"/api/admin/users/{other_id}/activation-link", headers=headers)
        assert first.status_code == 200, first.text
        from app.models.auth_token import AuthToken

        with SessionLocal() as db:
            live_before = db.scalar(
                select(AuthToken).where(
                    AuthToken.user_id == other_id, AuthToken.consumed_at.is_(None)
                )
            )
            assert live_before is not None
            token_id = live_before.id

        # A link minted for a DIFFERENT account.
        second = client.post(
            f"/api/admin/users/{unmentored_faculty}/activation-link", headers=headers
        )
        assert second.status_code in (200, 422), second.text

        with SessionLocal() as db:
            still = db.get(AuthToken, token_id)
            assert still is not None, "the bystander's link row was deleted"
            assert still.consumed_at is None, (
                "minting one account's activation link consumed another's"
            )
    finally:
        with SessionLocal() as db:
            from app.models.auth_token import AuthToken

            db.execute(delete(AuthToken).where(AuthToken.user_id == other_id))
            db.execute(delete(User).where(User.id == other_id))
            db.commit()


# --------------------------------------------------------- the office's data --


@requires_db
def test_placement_criteria_defaults_still_answer(client, login):
    """GUARDRAIL: "Criteria defaults remain the fallback; screens say 'no import
    yet' instead of zeros."

    The API half is what is pinnable here: the endpoint either serves the active
    criteria or answers 404 saying none is set. What it must NEVER do is return
    a row of zeros, because a zero threshold reads on the analytics screen as
    "every student qualifies" — the opposite of "nobody has set this yet".
    """
    r = client.get("/api/admin/criteria", headers=login(*ADMIN))
    assert r.status_code in (200, 404), r.text
    if r.status_code == 200:
        body = r.json()
        assert not all(
            (body.get(k) in (0, 0.0, None))
            for k in ("min_cgpa", "min_attendance_pct", "min_reep_completion_pct")
        ), "the criteria endpoint served a row of zeros, which reads as 'everyone qualifies'"


# --------------------------------------------------------------------------- #
# WHAT IS DELIBERATELY NOT HERE
#
# Five of 07 §5's guardrails have no Phase 3 subject and cannot be pinned yet.
# They are listed rather than left out silently, because a checklist with five
# quiet gaps is one somebody signs off as complete:
#
#   - "Records after promotion keep their semester numbers; graduation keeps
#     login and USN" — batch promotion and graduation are Phase 4. The dialogs
#     exist on the console and are still `[reepPending]="4"`.
#   - "Old interview track codes still open sessions; existing consent rows
#     still valid until the version bumps" — the interview bank's write path is
#     Phase 4; Phase 3 touched neither `interview_matrix` nor
#     `INTERVIEW_CONSENT_VERSION`.
#   - "Daily cap value 8; counted attempts never lost mid-day" — the cap is not
#     a Phase 3 surface.
#   - "Interview summaries backfilled before the first purge after deploy" — the
#     summary table arrives with Phase 4; there is nothing to backfill from.
#   - "Registration auto-approval behaves as before on day one" — B1.1 fenced
#     PROVISIONING by college domain, and `tests/test_college_domains.py` holds
#     that fence from the other side, including that the env list is a FALLBACK
#     and not a floor. Repeating it here would be a second copy of one claim.
#   - "Old leave PDFs untouched" — `app/leave_paper.py` and the pinned template
#     were not opened by any Phase 3 task; `tests/test_codebase_guards.py`
#     already pins the template by size.
# --------------------------------------------------------------------------- #
