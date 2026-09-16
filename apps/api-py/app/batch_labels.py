"""How a batch is written for a person, in one place.

A BATCH IS A YEAR. "2026-28" is the whole of what a batch is: the span a
student who joined a two-year degree belongs to. WHO that batch belongs to --
college, department, course, specialization -- is not part of its name; it is
the spine it hangs off, and `cohorts` already carries every rung of it as a real
foreign key (`department_id`, `course_id`, `specialization_id`, with
`_resolve_ancestry` in `routers/admin.py` as their only writer).

WHAT THIS MODULE FIXES. Both writers of the spine used to MANUFACTURE the
course and the specialization into `cohorts.name` -- `seed_catalogue.batch_name`
and the Set-up-a-college screen agreed on "General MBA - Finance 2026-28" -- and
then every screen printed that string NEXT TO the year again, because the label
is its own column:

    f"{cohort.name} · {cohort.batch_label}"   ->  "General MBA - Finance 2026-28 · 2026-28"

Five endpoints did exactly that (`admin_students`, `swoc`, `registration`,
`governance`, `admin_promotion`), each with its own copy of the f-string. So one
fact was stored twice -- once as a foreign key that `ancestry_of_student` reads
and once as words inside a name nobody could join on -- and the two could
disagree the moment the office renamed a course, with the batch still printing
last year's name under a screen that says "verified by Main Admin".

THE RULE IS THEREFORE: the spine comes from the LINKS, the year comes from the
BATCH, and they are put together HERE and nowhere else. `compose` is the only
spelling any endpoint uses, and its twin on the client is
`apps/web/src/app/core/batch-label.ts` -- pinned against each other by
`tests/test_batch_labels.py`, because two implementations of one sentence drift
the first time somebody changes the separator.

WHY THE TAIL IS `name` AND NOT `batch_label`. For every batch the seeder or the
setup screen writes, they are now the same string -- the year -- so it makes no
difference there. Where it does is the NON-STANDARD batch the office types on
College structure: a section, or odd dates, named "2026-28 Section B". That is
the office's own word for this batch and it must survive onto every screen,
which printing `batch_label` would silently drop. `batch_label` keeps its own
job (sorting, the import picker's term, the student's profile card); it is not
a second place to say the name.
"""

from __future__ import annotations

#: Between a course and its specialization. Both are rungs of one path, so they
#: read as one phrase.
SPINE_JOIN = " - "
#: Between the spine and the batch. A middle dot, the separator the console
#: already uses everywhere it puts two facts on one line.
LABEL_JOIN = " · "


def compose(
    course_name: str | None,
    specialization_name: str | None,
    name: str,
) -> str:
    """"General MBA - Finance · 2026-28" -- the spine, then the batch.

    Every argument is allowed to be missing, and each absence is a real shape
    rather than an error:

    * no specialization -- a two-year MBA in Digital Marketing IS the
      qualification, with nothing to specialise into (`seed_catalogue.Course`
      says so at length), so it reads "Digital Marketing · 2026-28";
    * no course -- a batch may legitimately hang at department level, because
      `HIERARCHY_LEVELS` makes Course optional, so it reads "2026-28" and the
      department is on the row already;
    * a legacy name -- a row whose `name` the office typed itself is printed
      verbatim, because those are their words about their batch.

    It never returns an empty string: `cohorts.name` is NOT NULL, and a batch
    with no name at all would render as a blank option nobody can pick.
    """
    spine = SPINE_JOIN.join(
        part.strip() for part in (course_name, specialization_name) if part and part.strip()
    )
    tail = (name or "").strip()
    if not spine:
        return tail
    if not tail:
        return spine
    return f"{spine}{LABEL_JOIN}{tail}"
