"""The four capabilities a faculty account holds by having mentees.

B2.3 of docs/redesign-2026-09/04-backend-changes.md.

ROLE WAS DOING TWO JOBS. `ROLE_BASELINE["MENTOR"]` handed every faculty account
every SCOPED capability in the catalogue, so "is this person a member of staff"
and "may this person read a mentee's ledger" were one question with one answer.
They are not one question. A faculty member who has never been assigned a student
has no mentee log to read, nobody's evidence to verify and no leave to approve.
AGENTS.md says exactly that in words -- "a faculty account is not a mentor by
existing" -- and every one of these endpoints already behaves that way, but the
capability said otherwise, and the capability is what Governance shows the office
when they ask who can see what.

DERIVED, NOT GRANTED, AND THAT IS A DEPARTURE FROM 04 WORTH READING.

The spec writes these as `capability_grants` rows: written by
`ensure_mentor_group`, revoked when the last mentee is released, backfilled by a
migration. That was built first and thrown away, because the first test run
showed what it costs. Five places in this repository set `students.mentor_id` --
three routers, `app/seed.py` and `app/grant_access.py` -- and a stored grant is
correct only while every one of them remembers to re-derive. The fixtures that
went red were not the bug; they were a preview of it. The sixth writer somebody
adds next year will not fail loudly: a faculty member will simply be unable to
open their own mentee log, and the row that would explain why is the one nobody
wrote.

So the capability is a pure function of the state it describes: do you currently
mentor anybody? There is no second copy to drift, no backfill to run, no sweep to
get wrong, and no path that can forget. It is the same reasoning AGENTS.md
already applies elsewhere -- §13's display status is "DERIVED, never stored", the
badge catalogue is code and "only the status is a row", and one milestone is
derived rather than stored because "two sources of truth for one row is how that
row ends up saying 'not started' under a finished report".

WHAT THAT COSTS, HONESTLY: a derived function cannot carry an expiry, cannot be
revoked on its own, and leaves no historical record of who could see what last
March. The first two are features here -- a function you hold because you mentor
somebody should end when that does, not on a date -- and the third is the mentor
assignment history's job (B9.1), which is the record of the fact underneath.

IT IS ADDITIVE TO REAL GRANTS. The Main Admin granting itself `mentor.mentees`
in Governance because a student's evidence is stuck still works exactly as
before: `capabilities_for` unions the baseline, these, and the grants. This only
ever adds.
"""

from __future__ import annotations

from typing import Final

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models.user import Mentor, Student

#: The four a mentee brings. `mentor.agent` and `mentor.upskilling` are NOT here
#: and stay in the baseline: the assistant and one's own certificate shelf belong
#: to the person, not to the group, and taking them away between assignments
#: would be removing their own things.
MENTOR_FUNCTIONS: Final[frozenset[str]] = frozenset(
    {"mentor.mentees", "mentor.notebook", "mentor.verifications", "mentor.leave_approve"}
)


def mentee_count(db: Session, user_id: str) -> int:
    """How many students this faculty account currently mentors.

    Through the `mentors` row, which is the join students point at. Having the
    row and having a mentee are different things -- `ensure_mentor_group` creates
    it on first assignment and nothing ever deletes it -- and it is the MENTEE
    that carries the work, so it is the mentee that carries the function.
    """
    return (
        db.scalar(
            select(func.count(Student.id))
            .join(Mentor, Student.mentor_id == Mentor.id)
            .where(Mentor.user_id == user_id)
        )
        or 0
    )


def mentor_functions_for(db: Session, user_id: str) -> frozenset[str]:
    """The four, if this account mentors anybody. Otherwise nothing."""
    if not user_id:
        return frozenset()
    return MENTOR_FUNCTIONS if mentee_count(db, user_id) > 0 else frozenset()
