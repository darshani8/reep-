"""Guards against the specific mistakes this codebase has actually made.

Every test here exists because the failure it prevents ALREADY HAPPENED — once
in production code, once during a build, or once in a way that cost an afternoon
of debugging. None of them is a style preference, and none needs a database, so
they run everywhere in well under a second and fail the build rather than a
review comment.

The pattern for each: state the incident, then assert it cannot recur.
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations" / "versions"
REPO = Path(__file__).resolve().parent.parent.parent.parent


def _python_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*.py") if "__pycache__" not in p.parts]


# --------------------------------------------------------------------------- #
# 1. Platform-specific strftime
# --------------------------------------------------------------------------- #

#: `%-d`, `%-m` and friends strip the leading zero. They are a GLIBC EXTENSION,
#: not part of the C standard, and Python delegates strftime to the platform.
#: On Linux they work; on Windows they raise ValueError("Invalid format string").
#:
#: ANY letter, not the six that were noticed first: %-e, %-Y, %-C, %-G, %-V,
#: %-u, %-w, %-s and %-z are all glibc-valid and all raise on Windows, and an
#: incomplete character class is a guard that passes on the next variant of the
#: same bug. `%#d` is Windows' own non-portable spelling and fails on Linux, so
#: it is caught here too — the rule is "portable", not "works on my machine".
_GLIBC_STRFTIME = re.compile(r"%[-#][a-zA-Z]")


def _strip_comment(line: str) -> str:
    """Drop a trailing `#` comment WITHOUT cutting inside a string literal.

    Splitting on the first `#` anywhere on the line was the first version, and
    it silently blinded the guard to any line with a `#` inside a string —
    `label = "#" + d.strftime("%-d")` is a rank label, and it was invisible.
    """
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            return line[:i]
    return line


def test_no_platform_specific_strftime() -> None:
    """INCIDENT: `director.py` used `strftime("%-d %b")` to label a week.

    `GET /api/director/students/{id}/weekly` returned 200 in CI and raised
    ValueError on every Windows developer machine — a whole endpoint that was
    green on the pipeline and dead locally. Portable form: f"{d.day} {d:%b}".
    """
    offenders: list[str] = []
    # Migrations and CI tooling too, not just app/. A data migration that labels
    # a date is the same bug in a place where it fails a DEPLOY rather than a
    # request, and tools/ci runs on the pipeline where a Windows developer never
    # sees it at all.
    scanned = (
        _python_files(APP)
        # MIGRATIONS is migrations/versions; its PARENT holds env.py, which is
        # also Python that runs on every deploy. Scanning only the versions
        # directory left env.py out, and a mutation proved it.
        + _python_files(MIGRATIONS.parent)
        + _python_files(REPO / "tools" / "ci")
    )
    for path in scanned:
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            # Strip trailing comments and skip comment-only lines: the guard's
            # first run flagged the very comment written to explain the fix.
            code = _strip_comment(line)
            if _GLIBC_STRFTIME.search(code):
                offenders.append(f"{path}:{lineno}: {line.strip()}")
    assert not offenders, (
        "glibc-only strftime directives found. These raise ValueError on Windows "
        "while passing on Linux CI. Use f\"{d.day} {d:%b}\" instead:\n  "
        + "\n  ".join(offenders)
    )


# --------------------------------------------------------------------------- #
# 2. Duplicate response/request schema names
# --------------------------------------------------------------------------- #

#: The debt as it stood when this guard was written. Each name is defined more
#: than once, in different modules, WITH DIFFERENT FIELDS — so the payload a
#: client receives depends on which URL it happened to hit.
#:
#: This list may SHRINK, never grow. Adding a name here to make the build pass
#: is the one edit that defeats the purpose of the test.
_KNOWN_DUPLICATE_SCHEMAS = {
    "ActionOut",
    "ApprovedCertificationOut",
    "CohortOut",
    "DecisionIn",
    "LeaderboardOut",
    "MenteeOut",
    "ProfileOut",
    "ResumeOut",
    "StatusOut",
}

#: The ceiling can only ever be LOWERED. See test_no_new_duplicate_schema_names.
_DUPLICATE_DEBT_CEILING = 9

#: Any base, not just a bare `BaseModel)`. `class FooOut(BaseModel, ABC)` and
#: `class FooOut(SomeSharedBase)` were both invisible to the first version,
#: which required a closing paren immediately after "BaseModel" — and a
#: subclass duplicate is the MOST likely form of "one name, two shapes",
#: because extracting a shared base is the natural refactor.
_SCHEMA_CLASS = re.compile(r"^class ([A-Za-z_][A-Za-z0-9_]*)\((?![^)]*\bProtocol\b)", re.MULTILINE)


def _schema_definitions() -> dict[str, list[str]]:
    seen: dict[str, list[str]] = defaultdict(list)
    for root in (APP / "routers", APP / "voice_platform" / "api"):
        if not root.exists():
            continue
        for path in _python_files(root):
            text = path.read_text(encoding="utf-8")
            for name in _SCHEMA_CLASS.findall(text):
                seen[name].append(str(path.relative_to(APP.parent)))
    return seen


def test_no_new_duplicate_schema_names() -> None:
    """INCIDENT: `LeaderboardOut` exists twice with different shapes.

    `student.py:1863` and `badges.py:460` both define it, and the client gets a
    different payload depending on the URL. `CohortOut` is defined twice as well
    — and while building the admin router a third was very nearly added.

    A name that means two things is a bug waiting for whoever assumes it means
    one. New duplicates fail here; the existing nine are listed above as debt so
    they are visible rather than forgotten.
    """
    duplicates = {n: paths for n, paths in _schema_definitions().items() if len(paths) > 1}
    unexpected = {n: p for n, p in duplicates.items() if n not in _KNOWN_DUPLICATE_SCHEMAS}
    assert not unexpected, (
        "New duplicate schema name(s). One name must mean one shape — name the "
        "new one for its surface instead (e.g. AdminCohortOut):\n  "
        + "\n  ".join(f"{n}: {', '.join(p)}" for n, p in sorted(unexpected.items()))
    )
    # The allowlist's own comment says it "may SHRINK, never grow" — and until
    # this line nothing enforced that. Adding a name to _KNOWN_DUPLICATE_SCHEMAS
    # made both this guard and the staleness one below go green with a fresh
    # duplicate in the tree, which is precisely the edit the comment forbids.
    # A comment is not a mechanism; a length bound is.
    assert len(_KNOWN_DUPLICATE_SCHEMAS) <= _DUPLICATE_DEBT_CEILING, (
        f"_KNOWN_DUPLICATE_SCHEMAS has grown to {len(_KNOWN_DUPLICATE_SCHEMAS)} entries "
        f"(ceiling {_DUPLICATE_DEBT_CEILING}). This list is debt to pay down, not a "
        "licence to add to — rename the new schema instead. If you genuinely cleaned "
        "one up, lower the ceiling to match."
    )


def test_the_duplicate_schema_debt_list_is_accurate() -> None:
    """The allowlist must not rot.

    If a duplicate is cleaned up, its name has to leave this list — otherwise the
    list slowly becomes a licence to add anything, and the guard above stops
    guarding.
    """
    duplicates = {n for n, paths in _schema_definitions().items() if len(paths) > 1}
    stale = _KNOWN_DUPLICATE_SCHEMAS - duplicates
    assert not stale, (
        "These names are no longer duplicated — remove them from "
        f"_KNOWN_DUPLICATE_SCHEMAS: {sorted(stale)}"
    )


# --------------------------------------------------------------------------- #
# 3. Model registration
# --------------------------------------------------------------------------- #


def test_every_model_module_is_imported_in_models_init() -> None:
    """AGENTS.md: "each new module is imported in models/__init__.py so Alembic
    autogenerate sees it."

    A model that is not imported is invisible to autogenerate, so its table is
    silently missing from the next migration — and the failure appears much
    later, as a missing-table error in an unrelated feature.
    """
    init = (APP / "models" / "__init__.py").read_text(encoding="utf-8")
    missing = [
        path.stem
        for path in sorted((APP / "models").glob("*.py"))
        if path.stem != "__init__"
        and not re.search(rf"^from \. import {re.escape(path.stem)}\b", init, re.MULTILINE)
    ]
    assert not missing, (
        "Model module(s) not imported in app/models/__init__.py, so Alembic "
        f"autogenerate cannot see them: {missing}"
    )


# --------------------------------------------------------------------------- #
# 4. Migration chain integrity
# --------------------------------------------------------------------------- #


def _revisions() -> tuple[dict[str, str | None], dict[str, str]]:
    """(revision -> down_revision, revision -> filename) across every migration."""
    down: dict[str, str | None] = {}
    files: dict[str, str] = {}
    unparsed: list[str] = []
    rev_re = re.compile(r"^revision:\s*str\s*=\s*[\"']([^\"']+)[\"']", re.MULTILINE)
    down_re = re.compile(r"^down_revision:[^=]*=\s*(?:[\"']([^\"']+)[\"']|None)", re.MULTILINE)
    for path in sorted(MIGRATIONS.glob("*.py")):
        text = path.read_text(encoding="utf-8")
        rev_m = rev_re.search(text)
        if not rev_m:
            # NOT `continue`. A migration whose revision line this regex cannot
            # read is INVISIBLE to both guards below — so a second head
            # introduced by a hand-written or older-template file (plain
            # `revision = "abc"`, no annotation) would pass unnoticed. A guard
            # that silently skips what it cannot parse is worse than no guard,
            # because the green tick is read as coverage.
            unparsed.append(path.name)
            continue
        down_m = down_re.search(text)
        rev = rev_m.group(1)
        # Two files claiming one revision id — the classic copy-paste merge
        # artefact — used to collapse into a single dict entry, and the head
        # count then came out right on a chain that was actually broken.
        if rev in files:
            raise AssertionError(
                f"Two migrations declare revision '{rev}': {files[rev]} and {path.name}. "
                "Alembic cannot order them and the head count below would be wrong."
            )
        down[rev] = down_m.group(1) if down_m and down_m.group(1) else None
        files[rev] = path.name
    assert not unparsed, (
        "Migration file(s) whose `revision:` line could not be parsed, so the "
        f"chain guards cannot see them: {unparsed}"
    )
    return down, files


def test_the_migration_chain_has_exactly_one_head() -> None:
    """Two heads means two people branched, and `alembic upgrade head` refuses.

    Cheaper to catch here than in a deploy, where it stops the release after the
    image has already been built and pushed.
    """
    down, files = _revisions()
    parents = {d for d in down.values() if d}
    heads = sorted(set(down) - parents)
    assert len(heads) == 1, (
        "The migration chain must have exactly one head. Found "
        f"{len(heads)}: {[(h, files[h]) for h in heads]}"
    )


def test_every_down_revision_points_at_a_migration_that_exists() -> None:
    """INCIDENT: the dev database was stamped at `a9c3e5f70b21`, whose file had
    been deleted. Alembic could not compute a path from it, so the database
    could not be migrated forward at all and had to be rebuilt.

    A dangling `down_revision` in the FILES is the same fault one step earlier,
    and it is catchable.
    """
    down, files = _revisions()
    dangling = [
        f"{files[rev]} -> down_revision '{parent}' does not exist"
        for rev, parent in down.items()
        if parent is not None and parent not in down
    ]
    assert not dangling, "Migration(s) reference a revision that no longer exists:\n  " + "\n  ".join(
        dangling
    )


# --------------------------------------------------------------------------- #
# 5. Documentation that describes code which exists
# --------------------------------------------------------------------------- #

#: Matches a backticked path under app/ WHETHER OR NOT it ends in .py, and
#: whether or not it carries a <placeholder> segment.
#:
#: THE FIRST VERSION DID NOT CATCH ITS OWN INCIDENT. It required either a `.py`
#: suffix or an `apps/api-py/` prefix, with a closing backtick immediately
#: after — so `app/domains/<context>/` (the `<` is not in the class) and
#: `app/core` (no `.py`) both evaded it silently. Those two are the exact
#: examples in the docstring below. A guard that misses the case it was written
#: for is worse than none, because the green tick reads as verification.
#: How far a "deleted"/"removed" note excuses a path, in characters.
_GONE_RADIUS = 240

_DOC_PATH = re.compile(r"`((?:apps/api-py/)?app/[A-Za-z0-9_./<>-]+)`")


def test_agents_md_only_references_paths_that_exist() -> None:
    """INCIDENT: AGENTS.md documented `app/domains/<context>/` bounded contexts
    and an `app/core` API contract in detail. Neither directory has any source —
    they were never committed. A reader spent real time looking for code the
    documentation promised.

    Documentation that describes non-existent code is worse than none: it is
    trusted. Only `.py` paths and directories under app/ are checked, because
    those are the ones a reader will go looking for.
    """
    agents = REPO / "AGENTS.md"
    if not agents.exists():  # pragma: no cover - repo layout guard
        return
    api_root = APP.parent
    text = agents.read_text(encoding="utf-8")
    # A path described as gone is the document doing its job — the historical
    # record of a removal is exactly what a reader needs. Only paths presented
    # as CURRENT are checked.
    # PROXIMITY, not the whole line. The first version skipped every path on any
    # line containing "removed" anywhere — and AGENTS.md has single paragraphs
    # with a dozen backticked paths in them, so writing "(the old X was
    # removed)" anywhere on such a line laundered all of them. Now the
    # exemption reaches only _GONE_RADIUS characters from the word, which still
    # covers the real historical records without excusing a path at the far end
    # of a paragraph.
    gone = re.compile(r"\b(deleted|removed|retired|no longer exists|gone)\b", re.IGNORECASE)
    missing: list[str] = []
    for line in text.splitlines():
        spans = [m.start() for m in gone.finditer(line)]
        for match in _DOC_PATH.finditer(line):
            raw = match.group(1)
            if any(abs(match.start() - at) <= _GONE_RADIUS for at in spans):
                continue  # documented as gone, and said so right here
            rel = raw[len("apps/api-py/") :] if raw.startswith("apps/api-py/") else raw
            # A <placeholder> segment stands for "any name", so the check is
            # that the directory ABOVE it exists — which is what fails for
            # `app/domains/<context>/` and is the whole point.
            probe = rel.split("<", 1)[0].rstrip("/") if "<" in rel else rel
            if probe and not (api_root / probe).exists():
                missing.append(raw)
    missing = sorted(set(missing))
    assert not missing, (
        "AGENTS.md references path(s) that do not exist. Either restore the code "
        "or correct the document — a reader will trust it:\n  " + "\n  ".join(missing)
    )


# --------------------------------------------------------------------------- #
# 6. The hierarchy switch
# --------------------------------------------------------------------------- #


def test_required_hierarchy_levels_form_a_prefix() -> None:
    """A required level implies every shallower one.

    Ancestors are DERIVED, not typed: the client names the deepest level it
    knows and `_resolve_ancestry` walks up the foreign keys. So "specialization
    required, course optional" is incoherent — a specialization cannot exist
    without a course, so requiring it requires the course too. The tuple's
    order is depth; the required flags must be True... then False..., never
    False-then-True.
    """
    from app.models.institution import HIERARCHY_LEVELS

    flags = [lv.required for lv in HIERARCHY_LEVELS]
    first_optional = flags.index(False) if False in flags else len(flags)
    assert all(not f for f in flags[first_optional:]), (
        "HIERARCHY_LEVELS has a required level BELOW an optional one: "
        f"{[(lv.key, lv.required) for lv in HIERARCHY_LEVELS]}. A deeper level "
        "cannot be required while its parent is optional — flip the parent too."
    )


def test_hierarchy_columns_stay_nullable() -> None:
    """The columns behind the switch must NEVER become NOT NULL.

    When "mandatory" starts to feel real, the tempting next step is to make the
    column NOT NULL "properly". That is a migration, it aborts on the first
    legacy batch, and it aborts DURING A DEPLOY. Nullability is what the
    database promises about rows that already exist; `required` in
    HIERARCHY_LEVELS is what this release asks of a new one. They are different
    questions. This test is the argument the next person in a hurry meets
    instead of a blank column definition.
    """
    from app.models.cohort import Cohort
    from app.models.institution import HIERARCHY_LEVELS

    not_nullable = [
        lv.field for lv in HIERARCHY_LEVELS if not Cohort.__table__.c[lv.field].nullable
    ]
    assert not not_nullable, (
        f"cohorts.{not_nullable} declared NOT NULL. Requiredness lives in "
        "HIERARCHY_LEVELS, never in the schema — see the constant's comment."
    )


def test_every_hierarchy_level_names_a_real_cohort_column() -> None:
    """The `field` on each level is read with getattr on Cohort by the validator,
    the compliance check and the incomplete-inbox predicate. A typo there is a
    500 on every batch create, found only by the first admin to try."""
    from app.models.cohort import Cohort
    from app.models.institution import HIERARCHY_LEVELS

    columns = set(Cohort.__table__.c.keys())
    missing = [lv.field for lv in HIERARCHY_LEVELS if lv.field not in columns]
    assert not missing, f"HIERARCHY_LEVELS names column(s) cohorts does not have: {missing}"


# --------------------------------------------------------------------------- #
# 7. Rule 2 has ONE implementation
# --------------------------------------------------------------------------- #


def test_rule_two_gate_is_a_pure_delegate(monkeypatch) -> None:
    """INCIDENT: `_assert_can_access_student` (routers/mentor.py) and
    `assert_student_scope` (policies.py) were two independent bodies answering
    "may this staff member see this student" — and CODEOWNERS recorded that
    nothing asserted they agreed. Rule 2 is the rule where two answers is a
    data-exposure bug, not a UX one. The mentor.py name is now a delegate; this
    pins it as one, so a second body cannot quietly grow back under the name
    every module docstring calls THE gate.
    """
    import ast
    import inspect
    import textwrap

    from app.routers import mentor

    sentinel = object()
    seen: list[tuple] = []

    def fake(session, student_id, db):
        seen.append((session, student_id, db))
        return sentinel

    monkeypatch.setattr(mentor, "assert_student_scope", fake)
    assert mentor._assert_can_access_student({"role": "MENTOR"}, "s1", "db") is sentinel
    assert seen == [({"role": "MENTOR"}, "s1", "db")]

    # And structurally: strip the docstring and exactly one statement remains,
    # a `return assert_student_scope(...)`. The mock proves the call happens;
    # the AST proves nothing ELSE does — no second query, no second branch.
    fn = ast.parse(textwrap.dedent(inspect.getsource(mentor._assert_can_access_student))).body[0]
    body = [
        stmt
        for stmt in fn.body
        if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant))
    ]
    assert len(body) == 1 and isinstance(body[0], ast.Return), (
        "_assert_can_access_student must be a pure delegate to policies.assert_student_scope"
    )
    call = body[0].value
    assert isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
    assert call.func.id == "assert_student_scope"


# --------------------------------------------------------------------------- #
# 8. Every foreign key has an index behind it
# --------------------------------------------------------------------------- #


def _leading_index_columns(table) -> set[str]:
    """Names of columns that LEAD some index-backed structure on `table`.

    Postgres uses an index for a foreign-key lookup only when the FK column is
    that index's FIRST column, so a composite that carries it second is no help
    and is not counted. Counted: an explicit Index, a UniqueConstraint, the
    primary key, and index=/unique=/primary_key= on the column itself.
    """
    from sqlalchemy import PrimaryKeyConstraint, UniqueConstraint

    leading: set[str] = set()
    for idx in table.indexes:
        cols = list(idx.columns)
        if cols:
            leading.add(cols[0].name)
    for con in table.constraints:
        if isinstance(con, (PrimaryKeyConstraint, UniqueConstraint)):
            cols = list(con.columns)
            if cols:
                leading.add(cols[0].name)
    for col in table.columns:
        if col.index or col.unique or col.primary_key:
            leading.add(col.name)
    return leading


def test_every_foreign_key_column_is_indexed() -> None:
    """INCIDENT (2026-09 schema review): 40 of 116 foreign-key columns had no
    index — `mentor_notes.mentor_id` (rule 2's scope path),
    `interview_sessions.conversation_id` and `placement_offers.job_id` among
    them. Postgres does not index the referencing side of a FOREIGN KEY, so
    every join through those columns and every DELETE of a parent row was a
    sequential scan. The 2026-08 audit (b41c9e2d7f05) indexed two and stopped.
    This makes the next unindexed FK fail here rather than in a query plan.
    """
    import app.models  # noqa: F401 — registers every table on Base.metadata
    from app.db import Base

    missing = [
        f"{table.name}.{col.name}"
        for table in Base.metadata.sorted_tables
        for col in table.columns
        if col.foreign_keys and col.name not in _leading_index_columns(table)
    ]
    assert not missing, (
        "Foreign-key column(s) with no index whose first column is the FK. Add "
        "index=True (or an Index in __table_args__) AND a migration:\n  "
        + "\n  ".join(missing)
    )


# --------------------------------------------------------------------------- #
# 9. The ledger's database bound is the same table the router reads
# --------------------------------------------------------------------------- #


def test_ledger_cell_check_is_derived_from_slot_capacities() -> None:
    """`SLOT_CAPACITY_HALVES` is the single source of truth for what a cell may
    hold, and since c2f7a9d41e63 the database enforces it too. Two copies of
    that table — one in Python, one typed into a CHECK — is how a widened slot
    accepts 9 half-hours on screen and refuses them on INSERT. The model builds
    the CHECK FROM the dict; this pins that every arm is present, that no
    stray arm sneaks in, and that the loud-failure `ELSE -1` arm survives.
    """
    from sqlalchemy import CheckConstraint

    from app.models.time_ledger import (
        LEDGER_CELL_HALF_HOURS_CHECK,
        SLOT_CAPACITY_HALVES,
        LedgerSlot,
        TimeLedgerCell,
    )

    checks = [
        c for c in TimeLedgerCell.__table__.constraints if isinstance(c, CheckConstraint) and c.name
    ]
    assert [c.name for c in checks] == ["ck_ledger_cell_half_hours"]
    assert str(checks[0].sqltext) == LEDGER_CELL_HALF_HOURS_CHECK
    for slot in LedgerSlot:
        assert f"WHEN '{slot.value}' THEN {SLOT_CAPACITY_HALVES[slot]}" in LEDGER_CELL_HALF_HOURS_CHECK
    assert LEDGER_CELL_HALF_HOURS_CHECK.count("WHEN '") == len(LedgerSlot)
    assert "ELSE -1 END" in LEDGER_CELL_HALF_HOURS_CHECK
