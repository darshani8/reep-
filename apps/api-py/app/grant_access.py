"""Grant one person Google sign-in access.

    python -m app.grant_access <email> --name "Full Name" --role ADMIN

Sign-in is Google-only, and the allowlist is not a config file â it is the
`users` table itself. `google_callback` looks the verified Google address up
case-insensitively and refuses anything it does not find, with no just-in-time
provisioning. So "allow this person to log in" means exactly one thing: give
them a row. THE DOMAIN IS NOT CHECKED â GOOGLE_ALLOWED_DOMAIN is a label, not a
fence (app/google_auth.py says why), so this row is the whole of the access
control and a @gmail.com address granted here signs in exactly like any other.

`app/seed_roster.py` does this in bulk for the student roster. This module is the
single-account counterpart, for the people a roster never contains â the operator
who has to get in before anyone else does, a mentor hired mid-term, a director.

STUDENT REQUIRES --usn, deliberately. A student is not a `User` row alone:
`_payload_for()` in app/routers/auth.py only puts `studentId` in the session
when `user.student` exists, and every /api/student/* route 403s without it â so
a bare student User row would sign in perfectly and then fail on every screen
it can reach. With --usn this tool creates the full User + Student +
StudentProfile trio exactly as `app/seed_roster.py` does; it exists for the
student the roster never contains â the operator's own TEST account, a late
joiner. Use a USN no roster row will ever claim (e.g. TEST01): it is UNIQUE,
and a real USN granted here blocks that student's roster seed. The real batch
stays `app.seed_roster`'s job.

PRODUCTION-SAFE, deliberately. Unlike `app/seed.py` â which refuses when
``ENV=prod`` because it creates demo accounts behind passwords published in
AGENTS.md â this writes no password anyone can use. It follows the `seed_kb.py`
precedent instead: production genuinely needs it, because on a fresh production
database with Google-only sign-in and an empty `users` table, *nobody can log in
at all*, including the person who has to fix that.

Idempotent. Re-running against an existing address updates the name and role
rather than raising on the unique constraint, so it doubles as "promote this
person" without a second tool.
"""

from __future__ import annotations

import argparse
import re
import sys
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models.student_profile import StudentProfile
from .models.user import Mentor, Role, Student, User
from .seed_roster import db_target

# The roles this tool may mint on its own. STUDENT is absent on purpose â see the
# module docstring; a User row without its Student row is an account that signs
# in and then 403s everywhere. MENTOR is present but warned about below: a MENTOR
# with no `Mentor` group correctly sees NOBODY (AGENTS.md rule 2), which is safe
# but silent, and the operator should know before the mentor reports it as a bug.
#
# ALUMNI needs nothing but the row. It has no Student and no Mentor row by
# definition (its session claims carry neither studentId nor mentorId), and its
# profile is deliberately NOT created here: `GET /api/alumni/profile` answers
# `created: false` until they save one, and that flag is what makes the client
# show the first-login create form. Minting a blank profile would skip the only
# screen a new alumnus is meant to land on.
_GRANTABLE_ROLES = (Role.MENTOR, Role.DIRECTOR, Role.ADMIN, Role.ALUMNI)

# Unusable-password sentinel, identical to seed_roster.SSO_ONLY_PASSWORD_HASH and
# for the same reason: `users.password_hash` is NOT NULL, but these accounts must
# never be able to authenticate with a password. `verify_password` splits on ":"
# and rejects anything that is not exactly scrypt:<salt>:<digest>, so this value
# returns False for every password ever tried â POST /api/auth/login answers with
# its ordinary 401 and reveals nothing about which accounts are SSO-only.
SSO_ONLY_PASSWORD_HASH = "google-only"

# Exactly what app/security.py:hash_password emits: `scrypt:<salt>:<digest>`
# with a 16-byte salt (32 hex chars) and dklen=64 (128 hex chars). Anchored and
# exact, so the only thing this accepts is a hash `verify_password` can actually
# check against — a truncated paste, a sentinel, or a hash from a different KDF
# is refused here rather than written as a key nobody can use.
_PASSWORD_HASH_RE = re.compile(r"^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$")


def _validate_password_hash(value: str) -> str:
    """Accept a precomputed scrypt hash for `--password-hash`, or raise.

    WHY A HASH IS ALLOWED IN ARGV WHEN A PASSWORD IS NOT. app.set_password
    refuses a `--password` flag because argv lands in shell history, in `ps`,
    and in the CloudTrail record of an ECS RunTask's overrides. A scrypt hash
    with a random 16-byte salt is not a secret in that sense: recovering a
    12+-character password from it is the attack scrypt with N=16384 exists to
    make impractical, and the plaintext never leaves the machine that hashed it.
    That is what lets the ops-task workflow provision a password-holding account
    from the browser without the password crossing the RunTask API.

    The length floor and the published-password denylist live where the
    PLAINTEXT is — `python -m app.set_password --print-hash` applies both before
    it prints anything. This path trusts that the operator hashed there; it
    cannot check a password it never sees.
    """
    candidate = value.strip()
    if not _PASSWORD_HASH_RE.fullmatch(candidate):
        raise ValueError(
            "--password-hash must be exactly what `python -m app.set_password "
            "--print-hash` prints (scrypt:<32 hex>:<128 hex>); a password itself "
            "is never accepted here"
        )
    return candidate


def grant(
    db: Session,
    email: str,
    name: str,
    role: Role,
    usn: str | None = None,
    with_group: bool = False,
    password_hash: str | None = None,
    mentor_email: str | None = None,
) -> tuple[User, bool]:
    """Create or update the user row that permits `email` to sign in.

    Takes an existing session, the shape `seed_kb.seed_knowledge` and
    `seed_roster.seed_roster` both use, so a caller can run this inside its own
    scope. Returns the row and whether it was newly created, so the caller can
    print an honest summary instead of claiming to have created something it
    updated.

    `with_group` applies to MENTOR only and creates the `Mentor` row that makes
    the account a real mentor. Without it the grant is exactly what it was: a
    MENTOR who signs in and sees nobody. It is opt-in rather than automatic
    because tests/test_auth_rbac.py builds a group-less mentor on purpose to
    prove rule 2 refuses, and a tool that always created the group would leave
    no way to reach that state.

    STUDENT is granted only when `usn` is supplied, and then it creates the
    FULL trio (User + Student + StudentProfile) exactly as seed_roster does â
    the module refuses a bare student User row for the reason the docstring
    gives, not students as such. This path exists for the account the roster
    never contains: the operator's own test student, a late joiner. The USN is
    the caller's to choose and UNIQUE â a test account should use one that can
    never collide with a real roster row (e.g. TEST01), because a real USN
    granted here would block that student's roster seed forever.
    """
    normalised = email.strip().lower()
    if "@" not in normalised:
        raise ValueError(f"not an email address: {email!r}")
    if role is Role.STUDENT and not (usn or "").strip():
        raise ValueError(
            "STUDENT needs --usn (a User row alone gives no studentId, and every "
            "/api/student/* route 403s without it) â or use `python -m "
            "app.seed_roster` for the real batch"
        )
    if role is not Role.STUDENT and role not in _GRANTABLE_ROLES:
        raise ValueError(f"{role.value} cannot be granted here")
    if with_group and role is not Role.MENTOR:
        raise ValueError("--with-group applies to MENTOR only")
    if password_hash is not None:
        password_hash = _validate_password_hash(password_hash)
    mentor_group: Mentor | None = None
    if mentor_email is not None:
        if role is not Role.STUDENT:
            raise ValueError("--mentor applies to STUDENT only")
        wanted = mentor_email.strip().lower()
        mentor_user = db.scalar(select(User).where(func.lower(User.email) == wanted))
        if mentor_user is None or mentor_user.role is not Role.MENTOR:
            raise ValueError(f"{wanted} is not a MENTOR account; grant it first")
        mentor_group = db.scalar(select(Mentor).where(Mentor.user_id == mentor_user.id))
        if mentor_group is None:
            # Rule 2: the `Mentor` row IS the group. Without it there is nothing
            # to point the student at, and silently skipping would leave a
            # mentor who "has" a student they cannot see.
            raise ValueError(
                f"{wanted} has no Mentor group yet; re-grant it with --with-group first"
            )

    # Case-insensitive, matching the callback's lookup: granting a second row
    # that differs only in case would create an account nobody can sign into,
    # because `users.email` is UNIQUE on the exact string and the callback
    # lowercases before it compares.
    user = db.scalar(select(User).where(func.lower(User.email) == normalised))
    created = user is None

    if user is None:
        user = User(
            id=uuid.uuid4().hex,
            email=normalised,
            name=name,
            role=role,
            # The sentinel unless the operator brought a key. Google sign-in
            # works either way; the hash only adds a second door.
            password_hash=password_hash or SSO_ONLY_PASSWORD_HASH,
        )
        db.add(user)
    else:
        # Update rather than raise. Re-running with a different --role is the
        # supported way to promote someone, and re-running identically is a
        # no-op the operator can do safely when unsure whether it took.
        # A role is copied into every session JWT. Advance token_version on a
        # real role transition so old privilege-bearing cookies are rejected
        # once the other workers' revocation caches converge. Repeating the
        # same grant remains idempotent.
        role_changed = user.role is not role
        user.name = name
        user.role = role
        if role_changed:
            user.token_version = (user.token_version or 0) + 1
        if password_hash is not None:
            # Re-running with a hash SETS or ROTATES the key; re-running without
            # one leaves whatever key exists alone, so "promote this person"
            # never silently revokes their password.
            user.password_hash = password_hash

    if role is Role.STUDENT:
        # The trio, exactly as seed_roster builds it. flush() before each
        # dependent row so the ids exist; idempotent on re-run, filling in only
        # what is missing â the same contract seed_roster keeps for accounts a
        # student has already touched.
        db.flush()
        wanted_usn = (usn or "").strip().upper()
        other = db.scalar(select(Student).where(Student.usn == wanted_usn))
        if other is not None and other.user_id != user.id:
            db.rollback()
            raise ValueError(
                f"USN {wanted_usn} already belongs to another account â a test "
                "student must use a USN no roster row will ever claim"
            )
        stu = db.scalar(select(Student).where(Student.user_id == user.id))
        if stu is None:
            stu = Student(user_id=user.id, usn=wanted_usn)
            db.add(stu)
        elif not stu.usn:
            stu.usn = wanted_usn
        db.flush()
        if db.scalar(select(StudentProfile).where(StudentProfile.student_id == stu.id)) is None:
            db.add(StudentProfile(student_id=stu.id))
        if mentor_group is not None:
            # Points the student at the mentor's group, which is the only thing
            # that makes them visible to that mentor (rule 2). Idempotent.
            stu.mentor_id = mentor_group.id

    if role is Role.MENTOR and with_group:
        # The `Mentor` row IS the group: `_assert_can_access_student` narrows a
        # MENTOR to the students whose `mentor_id` points at it, and
        # `_payload_for` only puts `mentorId` in the session when this row
        # exists. Idempotent -- a second run finds the existing row.
        db.flush()
        if db.scalar(select(Mentor).where(Mentor.user_id == user.id)) is None:
            db.add(Mentor(user_id=user.id))

    db.commit()
    db.refresh(user)
    return user, created


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.grant_access",
        description="Grant one person Google sign-in access (the allowlist is the users table).",
    )
    parser.add_argument("email", help="the Google address, e.g. someone@bgscet.ac.in")
    parser.add_argument("--name", required=True, help='display name, e.g. "Darshan B"')
    parser.add_argument(
        "--role",
        # REQUIRED, never defaulted. This used to default to ADMIN â the highest
        # privilege in the system, which by AGENTS.md rule 2 reads every
        # student's marks, attendance and USN. A forgotten flag must be an
        # argparse error, not a silent grant of everything.
        required=True,
        choices=[r.value for r in _GRANTABLE_ROLES] + [Role.STUDENT.value],
        help="role to grant â required, because there is no safe default",
    )
    parser.add_argument(
        "--with-group",
        action="store_true",
        help="MENTOR only: also create the Mentor group row. Without it the "
        "mentor signs in and sees no students at all (AGENTS.md rule 2).",
    )
    parser.add_argument(
        "--usn",
        default=None,
        help="STUDENT only, and then required: the USN for the Student row. "
        "Use one no roster row will ever claim (e.g. TEST01) â it is UNIQUE, "
        "and a real USN granted here blocks that student's roster seed.",
    )
    parser.add_argument(
        "--password-hash",
        default=None,
        metavar="scrypt:SALT:DIGEST",
        help="also give the account a password, as the HASH printed by "
        "`python -m app.set_password --print-hash`. A password itself is never "
        "accepted here (it would land in shell history and CloudTrail); the hash "
        "is safe to pass, which is what lets the ops-task workflow do this from "
        "the browser. Re-running with a hash rotates the key; without one, "
        "leaves it alone.",
    )
    parser.add_argument(
        "--mentor",
        default=None,
        metavar="EMAIL",
        help="STUDENT only: put the student in this mentor's group (the mentor "
        "must already be granted --with-group), so the mentor can actually see "
        "them (AGENTS.md rule 2).",
    )
    args = parser.parse_args()

    # Said out loud BEFORE writing, for the same reason app/seed_roster.py says
    # it: this module is prod-runnable, and the operator's only defence against
    # granting an ADMIN on the wrong database is being told which one it is.
    print(f"granting {args.role} to {args.email.strip().lower()} on database {db_target()}")

    with SessionLocal() as db:
        try:
            user, created = grant(
                db,
                args.email,
                args.name,
                Role(args.role),
                usn=args.usn,
                with_group=args.with_group,
                password_hash=args.password_hash,
                mentor_email=args.mentor,
            )
        except ValueError as exc:
            # Reachable from a library caller; argparse's `choices` catches the
            # STUDENT case first on the command line, with its own message.
            print(f"REFUSED: {exc}", file=sys.stderr)
            return 2
        email, role, display_name = user.email, user.role, user.name

    verb = "created" if created else "updated"
    print(f"{verb}: {email}  role={role.value}  name={display_name}")
    if args.password_hash:
        print("  Password set from the supplied hash. This account can now sign in with")
        print("  email + password as well as Google; the password door opens on its own")
        print("  once any account holds a key (app/routers/auth.py:password_door_open).")
    if args.mentor:
        print(f"  Placed in the Mentor group of {args.mentor.strip().lower()}.")
    if not created:
        print("  (address already present â name and role were updated in place)")
    if role is Role.ALUMNI:
        # Says the quiet part out loud: the empty profile is the point, not an
        # oversight, and the first screen they land on is the one that fills it.
        print("  No alumni profile row was created, deliberately - the first-login")
        print("  create-profile form is what this account is meant to land on.")
    if role is Role.MENTOR and args.with_group:
        print("  Mentor group created. Students still need their mentor_id pointed at it")
        print("  before this mentor can see anybody (AGENTS.md rule 2).")
    if role is Role.MENTOR and not args.with_group:
        # Not a failure, but it will be reported as one. `_assert_can_access_student`
        # narrows a MENTOR to their own `Mentor` group, and no group means no
        # students â correctly, per AGENTS.md rule 2, but with nothing on screen
        # to explain it.
        print(
            "  NOTE: this mentor has no Mentor group yet, so they will sign in "
            "and see no students at all. Re-run with --with-group to create it.",
            file=sys.stderr,
        )
    print()
    print("This address may now complete Google sign-in, once GOOGLE_CLIENT_ID and")
    print("GOOGLE_CLIENT_SECRET are set. The DOMAIN IS NOT CHECKED â this row is")
    print("the whole allowlist (GOOGLE_ALLOWED_DOMAIN is a label, not a fence).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
