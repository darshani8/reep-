"""B1.4 — one Reach, the models it does not own, and the header that states it.

`policies.scope_filter` answers the question ONCE — how far does this session's
grant for this key reach — and `policies.Reach` hands out a subquery per model
for the two things the spine is made of: `students` and staff `users`. Two of
the lists B1.4 narrows are neither.

A REGISTRATION IS NOT A STUDENT YET, and that is the whole point of the review
queue. The row carries its own `college_id` / `department_id` / `course_id` /
`specialization_id` / `requested_cohort_id` pointers — what the applicant named
on the public form, walked up the spine by `registration._resolve_claim` — and
there is no `students` row to join to until somebody approves it. So the
projection onto `registrations` is written here rather than in `policies.py`,
which knows about the spine and should not learn about an application; and
written ONCE here rather than at each of its two call sites
(`registration.pending` and the pending-applications tile in
`console.analytics_summary`), because two copies of a scope projection is
exactly how one of them stops matching the other.

The reach itself is still computed in exactly one place. Nothing in this module
decides who may see what; it decides how an answer already given is written
against one more table.

THE HEADER. 04-backend-changes.md asks that "every response carries
`scope: {college, department}`" so the app bar's scope control can show it.
Eleven list endpoints answer a bare `list[...]` today and the Phase 2 console is
built against those arrays; wrapping each in `{scope, rows}` is a breaking
change to every one of them, spent on the least important half of the
requirement. `app/exports.py` met the same problem from the other side (a JSON
envelope around a CSV is not a CSV) and answered it with response headers. This
is the same answer in the same shape of name, so a client reads scope one way
wherever it asks.
"""

from __future__ import annotations

from typing import Final

from fastapi import Response
from sqlalchemy import false as sa_false
from sqlalchemy import or_
from sqlalchemy import true as sa_true

from .exports import scope_note
from .policies import Reach

#: One of `programme`, `narrowed` or `none` — the three words `scope_note` uses,
#: and for its reason: "may see everything" and "may see nothing" are opposite
#: facts, not two ends of one scale, and must never render the same.
SCOPE_HEADER: Final[str] = "X-Reep-Scope"
SCOPE_COLLEGES_HEADER: Final[str] = "X-Reep-Scope-Colleges"
SCOPE_DEPARTMENTS_HEADER: Final[str] = "X-Reep-Scope-Departments"

#: How many ids a scope header will name before it stops. A header is not a
#: payload: a holder with three hundred cohort grants would otherwise push a
#: response past what several proxies will forward, and the failure would be the
#: whole response disappearing rather than a truncated hint doing so.
MAX_SCOPE_IDS: Final[int] = 20


def _ids(values: frozenset[str]) -> str:
    return ",".join(sorted(values)[:MAX_SCOPE_IDS])


def scope_header(response: Response, reach: Reach) -> None:
    """State the caller's reach on the response, for the app bar's scope control.

    Always sets the word. The two id headers are set only when there are ids to
    set, so a client can tell "narrowed to these colleges" from "narrowed, but
    at a rung this header does not carry" (a cohort- or student-scoped grant)
    without reading an empty string as a list of none.
    """
    note = scope_note(reach)
    response.headers[SCOPE_HEADER] = str(note["scope"])
    if reach.colleges:
        response.headers[SCOPE_COLLEGES_HEADER] = _ids(reach.colleges)
    if reach.departments:
        response.headers[SCOPE_DEPARTMENTS_HEADER] = _ids(reach.departments)


def registration_scope_clause(reach: Reach):
    """The reach, as a WHERE clause over `registrations`.

    Every rung the applicant's claim can name is matched, because the claim is
    walked UP: somebody who names a batch has their department and college
    settled from it, so a department-scoped reviewer sees that application
    through `department_id` and a college-scoped one through `college_id`,
    without either having to re-derive the chain here.

    BOTH COHORT COLUMNS. `requested_cohort_id` is what the applicant asked for
    and `cohort_id` is what a rule or a reviewer settled on; a cohort-scoped
    reach that read only one of them would lose the queue's rows at whichever
    moment the other was written.

    A STUDENT-SCOPED REACH MATCHES NO APPLICATION AT ALL, and that is right
    rather than missing: a grant naming one student is a grant about somebody
    who already has a `students` row, and an application is by definition
    somebody who does not. It falls through to the empty-clause branch below and
    sees nothing, which is the same answer `reaches_target` gives a target that
    hangs under nothing.
    """
    from .models.registration import Registration

    if reach.everything:
        return sa_true()
    clauses = []
    if reach.colleges:
        clauses.append(Registration.college_id.in_(reach.colleges))
    if reach.departments:
        clauses.append(Registration.department_id.in_(reach.departments))
    if reach.courses:
        clauses.append(Registration.course_id.in_(reach.courses))
    if reach.specializations:
        clauses.append(Registration.specialization_id.in_(reach.specializations))
    if reach.cohorts:
        clauses.append(Registration.cohort_id.in_(reach.cohorts))
        clauses.append(Registration.requested_cohort_id.in_(reach.cohorts))
    if not clauses:
        return sa_false()
    return or_(*clauses)
