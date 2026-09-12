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
    """INCIDENT: the console router (then `director.py`) used `strftime("%-d %b")` to label a week.

    `GET /api/admin/students/{id}/weekly` returned 200 in CI and raised
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


# --------------------------------------------------------------------------- #
# 6. The infrastructure's numbers agree with the api's
# --------------------------------------------------------------------------- #

CDK_CORE = REPO / "infra" / "cdk" / "reep_core" / "stack.py"


def _cdk_constant(name: str) -> int:
    text = CDK_CORE.read_text(encoding="utf-8")
    m = re.search(rf"^{name}\s*=\s*(\d+)", text, re.MULTILINE)
    assert m, f"{name} is not declared as a plain integer at module level in {CDK_CORE}"
    return int(m.group(1))


def test_the_alb_keeps_an_interview_socket_open_longer_than_the_interview() -> None:
    """INCIDENT (found in review, before it happened in production): the ECS
    task had no stopTimeout, so a deploy SIGKILLed a task 30 s after SIGTERM
    while a 480 s interview was on its WebSocket. The first fix was going to
    be stopTimeout=500 — which Fargate refuses; its ceiling is 120.

    What actually keeps the socket alive through a deploy is the target
    group's deregistration delay: the ALB keeps a draining target's open
    connections until they close, and ECS waits for draining before SIGTERM.
    So that number must exceed the longest interview the api holds on one
    socket (nova_sonic_connection_seconds) plus the scorecard tail. The api's
    setting and the CDK constant live in different languages in different
    directories; this is the one place they are compared.
    """
    from app.config import settings

    delay = _cdk_constant("DEREGISTRATION_DELAY_SECONDS")
    longest = settings.nova_sonic_connection_seconds
    assert delay >= longest + 90, (
        f"infra/cdk DEREGISTRATION_DELAY_SECONDS={delay} but the api holds an interview "
        f"socket for up to {longest}s (+90s for the scorecard). Raise the delay, or the "
        f"next deploy cuts an interview off mid-verdict."
    )


def test_stop_timeout_is_within_fargates_ceiling() -> None:
    """Fargate refuses a task definition with stopTimeout > 120. A larger
    number here is not a longer grace period — it is a deploy that fails at
    RegisterTaskDefinition with a message nobody expects."""
    assert _cdk_constant("STOP_TIMEOUT_SECONDS") <= 120


def test_sentry_never_ships_local_variables_or_request_bodies() -> None:
    """Sentry must not carry a student's words off the account.

    THE INCIDENT: `sentry_sdk.init` set `send_default_pii=False` and stopped
    there. That flag governs headers, cookies and IP address. It does NOT govern
    `include_local_variables`, which is a separate option and DEFAULTS TO TRUE —
    so every captured exception carried the local variables of every stack frame.

    On this codebase those locals are a student speaking: `student_text` in the
    interview turn writer, `raw` holding a scorecard, `payload` holding a Nova
    transcript event. Demonstrated with the real SDK before the fix: a
    RuntimeError raised in a function whose local was "My CGPA is 8.7 and I was
    rejected by Infosys last week" put that string verbatim into the event's
    frame vars.

    That is rule 1 — student data leaving the machine unbidden — through a door
    that no `carries_student_data=True` gate guards, in a process otherwise
    forbidden to send that same text to a model.

    Both flags are asserted because both leak: `max_request_body_size` defaults
    to "medium", and POST /student/resume/generate carries a name, USN, marks
    and attendance in its body. Dropping these costs nothing an operator needs —
    the function, file and line number of every frame survive.

    The init moved from app/main.py to app/observability.py (2026-09) so the
    three reporting processes share ONE set of flags; this guard moved with it
    and now also pins that every process reaches the SDK through that function
    and never through a second `sentry_sdk.init` of its own.
    """
    source = (APP / "observability.py").read_text(encoding="utf-8")
    assert "sentry_sdk.init(" in source, "the Sentry init moved; this guard needs updating"
    for flag in ("send_default_pii=False", "include_local_variables=False", 'max_request_body_size="never"'):
        assert flag in source, (
            f"app/observability.py's sentry_sdk.init must set {flag} — without it a "
            "single exception on the interview path ships a student's transcript to "
            "a third party. See this test's docstring."
        )
    for module in ("main.py", "retention_job.py", "voice_platform/queue/worker.py"):
        text = (APP / module).read_text(encoding="utf-8")
        assert "sentry_sdk.init(" not in text, f"app/{module} must initialise Sentry through app.observability"
        assert "init_sentry(" in text, f"app/{module} no longer initialises Sentry at all"


def test_every_reporting_process_names_its_own_service_and_its_own_dsn() -> None:
    """One process, one Sentry project, one DSN — and never the api's.

    The retention job runs on the api's ECS task definition with only a command
    override, so SENTRY_DSN (the api project's key) is in its environment. A
    job that reads it files a nightly sweep under the api's issues, where nobody
    looks for one, and a cron monitor under the wrong project. Each process
    therefore names its service and reads the DSN setting for THAT service.
    """
    expectations = {
        "main.py": ("SERVICE_API", "settings.sentry_dsn"),
        "retention_job.py": ("SERVICE_JOBS", "settings.sentry_jobs_dsn"),
        "voice_platform/queue/worker.py": ("SERVICE_INTERVIEW_WORKER", "settings.sentry_interview_worker_dsn"),
    }
    for module, (service, dsn_setting) in expectations.items():
        text = (APP / module).read_text(encoding="utf-8")
        assert f"init_sentry({service}, {dsn_setting})" in text, (
            f"app/{module} must call init_sentry({service}, {dsn_setting}) — see this test's docstring"
        )
    for module in ("retention_job.py", "voice_platform/queue/worker.py"):
        text = (APP / module).read_text(encoding="utf-8")
        assert "settings.sentry_dsn)" not in text and "settings.sentry_dsn " not in text, (
            f"app/{module} reads the api's DSN; it must read its own"
        )


def test_sentry_scrubs_before_the_event_leaves_the_process() -> None:
    """The query string is NOT covered by any flag in the init.

    THE INCIDENT: `send_default_pii=False`, `include_local_variables=False` and
    `max_request_body_size="never"` were read as "Sentry gets no PII", and
    app/config.py said so in a comment. In sentry-sdk 2.68.1 the ASGI
    integration filters the query string ONLY when `_experiments["data_collection"]`
    is set; nothing sets it, so the request data takes the raw branch.
    `GET /api/register/verify?token=<raw>` therefore shipped a live, single-use,
    account-provisioning token — and `GET /api/auth/sso/google/callback?code=&state=`
    a Google authorization code — on error events AND on sampled transactions,
    since request data is attached by an event processor and those run for
    transactions too.

    All four hooks are asserted together because the transaction hook is the
    one that gets forgotten: a token does not need an exception to leak — and
    the log hook because structured logs bypass before_breadcrumb entirely.
    """
    source = (APP / "observability.py").read_text(encoding="utf-8")
    assert "sentry_sdk.init(" in source, "the Sentry init moved; this guard needs updating"
    for hook in ("before_send=", "before_send_transaction=", "before_breadcrumb=", "before_send_log="):
        assert hook in source, (
            f"app/observability.py's options must set {hook} — the constructor "
            "flags cover locals, bodies and cookies and cover NOTHING else. "
            "See this test's docstring."
        )


def test_the_scrubber_drops_account_tokens_and_keeps_the_screen_selectors() -> None:
    """Behavioural, not textual: the hook above can exist and do nothing.

    Both halves are asserted, and `board` is asserted because the first draft
    of the allowlist held five names and would have blanked it. A scrubber that
    deletes the whole query string passes the first assert and makes
    `interview hr` vs `interview generic`, or which leaderboard was slow,
    unanswerable in a trace — which is the observability this instrumentation
    was added for.
    """
    from app.telemetry_scrub import scrub_event, scrub_transaction

    for hook in (scrub_event, scrub_transaction):
        event = hook(
            {"request": {"query_string": "token=deadbeefcafe&code=4/0Axyz&specialization=hr&board=cgpa"}},
            {},
        )
        qs = event["request"]["query_string"]
        assert "deadbeefcafe" not in qs
        assert "4/0Axyz" not in qs and "4%2F0Axyz" not in qs
        assert "specialization=hr" in qs
        assert "board=cgpa" in qs


def test_an_error_log_ships_its_arguments_too_not_only_the_formatted_string() -> None:
    """LoggingIntegration's EventHandler writes THREE fields, not one:
    `event["logentry"] = {"message": <raw template>, "formatted": record.getMessage(),
    "params": record.args}`.

    THE INCIDENT this anticipates: app/routers/auth.py has a `log.error` whose
    arguments are `identity.email`, `user.google_sub` and `identity.sub`. ERROR
    is at the integration's event level, so that record is a captured EVENT,
    and on this deployment the email IS the USN. A hook that scrubs `formatted`
    alone leaves it sitting one key over, uninterpolated.
    """
    from app.telemetry_scrub import scrub_event

    event = scrub_event(
        {
            "logentry": {
                "message": "%s is pinned to Google sub %s",
                "formatted": "1mp25mdm01@bgscet.ac.in is pinned to Google sub 118…",
                "params": ["1mp25mdm01@bgscet.ac.in", "118…"],
            }
        },
        {},
    )
    logentry = event["logentry"]
    assert "1mp25mdm01" not in logentry["formatted"]
    assert "1mp25mdm01" not in logentry["params"][0]


def test_the_mail_body_never_becomes_a_breadcrumb() -> None:
    """app/mail_transport.py logs the ENTIRE outbound message at INFO when no
    transport is configured — the raw activation link, the raw reset link, the
    one-time code. Sentry's LoggingIntegration turns every INFO record into a
    breadcrumb under `category = record.name`, attached to the next captured
    event. It fires whenever SES_FROM_ADDRESS is blank, which no boot guard
    requires.

    The logger name is asserted too: mail_transport uses `logging.getLogger(__name__)`,
    so moving or renaming that module silently unmutes it.
    """
    from app.telemetry_scrub import MUTED_LOGGERS, scrub_breadcrumb, scrub_log

    assert "app.mail_transport" in MUTED_LOGGERS
    assert (APP / "mail_transport.py").exists(), "module moved; MUTED_LOGGERS is now stale"
    assert scrub_breadcrumb({"category": "app.mail_transport", "message": "MAIL ... /reset?token=deadbeef"}, {}) is None
    # The structured-logs pipeline is a second door to the same body.
    assert scrub_log({"body": "MAIL ... /reset?token=deadbeef", "attributes": {"logger.name": "app.mail_transport"}}, {}) is None


def test_the_spa_scrubs_the_token_out_of_its_own_url() -> None:
    """/activate?token= and /reset?token= are ANGULAR routes: the token is in
    the browser's location.href before it is ever in a request body. The browser
    SDK's httpContextIntegration is a DEFAULT integration — and an explicit
    `integrations:` array MERGES with the defaults rather than replacing them —
    so it sets event.request.url from location.href on every event, and the
    navigation breadcrumb's `from` is path AND query. `sendDefaultPii: false`
    governs IP and user identity, not the URL.

    The api has a guard for its half of this and the web had none, which is why
    this one reads across the app boundary.
    """
    source = (REPO / "apps" / "web" / "src" / "main.ts").read_text(encoding="utf-8")
    assert "sentry.init(" in source, "the SPA Sentry init moved; this guard needs updating"
    for hook in ("beforeSend:", "beforeSendTransaction:", "beforeBreadcrumb:"):
        assert hook in source, f"apps/web/src/main.ts's sentry.init must set {hook} — see this test's docstring."


def test_the_spa_keeps_replay_logs_and_metrics_off_and_imports_the_sdk_lazily() -> None:
    """Four browser-side doors, each pinned as text because each is one line
    from open.

    Session Replay reconstructs the DOM, and 19 routes render marks, a USN, a
    resume, an interview transcript or an admin console; it cannot be blocked
    per route in this SDK and the students' consent covers the college's
    server, not Sentry's. `enableLogs` and `enableMetrics` default to TRUE from
    @sentry/angular 10.71.0 and bypass beforeSend. And the SDK must be reached
    through ./app/core/sentry-lazy: a dynamic import of '@sentry/angular'
    retains its whole namespace, which ships the Replay recorder to every
    student to reach four symbols.
    """
    web = REPO / "apps" / "web" / "src"
    main_ts = (web / "main.ts").read_text(encoding="utf-8")
    lazy = (web / "app" / "core" / "sentry-lazy.ts").read_text(encoding="utf-8")
    assert "replayIntegration" not in main_ts and "replayIntegration" not in lazy
    assert "feedbackIntegration" not in main_ts and "feedbackIntegration" not in lazy
    for line in ("sendDefaultPii: false", "enableLogs: false", "enableMetrics: false"):
        assert line in main_ts, f"apps/web/src/main.ts must set {line}"
    assert "import('./app/core/sentry-lazy')" in main_ts
    assert "import('@sentry/angular')" not in main_ts
    assert "from '@sentry/angular'" in lazy, "sentry-lazy.ts is the one place the package is named"


def test_the_retention_monitor_keeps_the_same_clock_as_the_scheduler() -> None:
    """Two sources of truth for one clock is a monitor that reports MISSED
    every night against a job that ran fine. The Sentry monitor upserts its
    schedule from app/retention_job.py; the EventBridge schedule lives in
    infra/cdk/reep_core/stack.py. Both are read here and compared."""
    from app.retention_job import MONITOR_CONFIG

    stack = (REPO / "infra" / "cdk" / "reep_core" / "stack.py").read_text(encoding="utf-8")
    # The AWS Backup rule and the restore test have crons of their own, so the
    # search starts at the retention schedule's name and takes the first cron
    # after it — not the first cron in the file.
    anchor = stack.find("-retention-daily")
    assert anchor > 0, "the retention schedule's name moved; update this guard"
    match = re.search(r'schedule_expression="cron\((\d+) (\d+) \* \* \? \*\)"', stack[anchor:])
    assert match, "the retention schedule moved or changed shape; update this guard"
    minute, hour = match.group(1), match.group(2)
    assert MONITOR_CONFIG["schedule"] == {"type": "crontab", "value": f"{minute} {hour} * * *"}
    assert MONITOR_CONFIG["timezone"] == "Etc/UTC"
    for key in ("checkin_margin", "max_runtime", "failure_issue_threshold", "recovery_threshold"):
        assert key in MONITOR_CONFIG, f"{key} is missing — a camelCase key is accepted and ignored by the ingest"


# --------------------------------------------------------------------------- #
# The resume document: what it publishes, and what it must not
# --------------------------------------------------------------------------- #


def test_the_resume_composer_reads_no_private_builder_section() -> None:
    """INCIDENT (2026-09-09): the Resume Builder is also the placement office's
    intake form, and `resume_profiles.data` therefore holds next-of-kin details,
    a date of birth, medical history and demographics — each collected under an
    on-screen promise that it would not reach an employer.

    `_compose_resume_markdown` publishes by name, from an allowlist, so nothing
    travels unless a function puts it there. This guard is the textual half:
    if a section named in `_PRIVATE_BUILDER_SECTIONS` is ever read out of the
    builder map inside the composer, the promise is broken in one line and the
    behavioural test in tests/test_resume_document.py is one edit from being
    edited to match.
    """
    from app.routers.student import _PRIVATE_BUILDER_SECTIONS

    source = (APP / "routers" / "student.py").read_text(encoding="utf-8")
    start = source.index("def _compose_resume_markdown(")
    body = source[start : source.index("\nclass ResumeGenerateIn", start)]
    for section in _PRIVATE_BUILDER_SECTIONS:
        for reader in (f'b.get("{section}")', f"b.get('{section}')"):
            assert reader not in body, (
                f"_compose_resume_markdown reads the private builder section "
                f"'{section}'. That section is collected for the placement "
                f"office under a promise that it stays off the exported resume."
            )


def test_the_completeness_rule_is_the_same_on_both_sides() -> None:
    """The API computes the percentage; the client colours the dots beside it.

    Both decide what counts as "filled", and they used to disagree in the same
    direction: a form-supplied dial code and country made a section count as
    content, so a fresh profile jumped 8% -> 17% for one empty row. If the two
    lists drift, the sidebar's number and its dots describe different profiles
    and neither is wrong on its own terms.
    """
    from app.routers.student import _STRUCTURAL_LEAF_KEYS

    resume = REPO / "apps" / "web" / "src" / "app" / "features" / "student" / "resume"
    pattern = re.compile(r"STRUCTURAL_LEAF_KEYS\s*=\s*new Set\(\[([^\]]*)\]\)")
    seen = 0
    for name in ("resume-builder.component.ts", "resume-builder.service.ts"):
        text = (resume / name).read_text(encoding="utf-8")
        match = pattern.search(text)
        assert match, f"{name} no longer declares STRUCTURAL_LEAF_KEYS"
        keys = set(re.findall(r"'([^']+)'", match.group(1)))
        assert keys == _STRUCTURAL_LEAF_KEYS, (
            f"{name} has {sorted(keys)}; app/routers/student.py has "
            f"{sorted(_STRUCTURAL_LEAF_KEYS)}. One rule, two implementations — "
            "they have to name the same keys."
        )
        seen += 1
    assert seen == 2


def test_no_invented_person_is_offered_as_a_referee() -> None:
    """INCIDENT: the References step offered "Rakesh Iyer · Faculty Mentor ·
    BGSCET · MBA-2026-B" to every student, with a one-click "Add as reference"
    button. He does not work here. A student could put him on a document a
    recruiter then rings.

    The referee is now the real assigned mentor from the API, or the card is
    absent. The name is pinned here because the failure is invisible in review:
    a plausible Indian name in a mockup-derived component reads as data.
    """
    web = REPO / "apps" / "web" / "src"
    offenders = [
        str(p.relative_to(REPO))
        for p in web.rglob("*.ts")
        if "Rakesh Iyer" in p.read_text(encoding="utf-8")
    ]
    assert not offenders, (
        "A hard-coded person is being offered as a resume referee in: "
        + ", ".join(offenders)
    )


def test_ngsubmit_is_never_used_without_a_forms_module() -> None:
    """INCIDENT (2026-09-10): a Save button that rendered and did nothing.

    `(ngSubmit)` is an output of Angular's `NgForm` DIRECTIVE, which arrives with
    FormsModule. In a standalone component whose `imports` lack it, there is no
    NgForm on the `<form>`, so `(ngSubmit)` is parsed as a listener for a DOM
    event literally named "ngSubmit" — an event nothing ever raises. The
    template compiles, the build passes, the button looks wired, and clicking it
    runs nothing at all. No error appears anywhere.

    It cost a full browser round-trip to find, on a form whose two neighbours in
    the same template used the native `(submit)` pattern correctly. It is the
    same family as the `routerLink`-in-a-component-with-empty-imports trap the
    2026-09-10 reachability audit found: inert markup that reads as working.

    HTML comments are stripped first, because the fix for that incident explains
    itself in a comment that names `(ngSubmit)` — and a guard that trips on the
    prose describing it is a guard someone deletes.
    """
    web = REPO / "apps" / "web" / "src" / "app"
    comment = re.compile(r"<!--.*?-->", re.S)
    offenders: list[str] = []
    for template in web.rglob("*.html"):
        body = comment.sub("", template.read_text(encoding="utf-8"))
        if "(ngSubmit)" not in body:
            continue
        component = template.with_suffix(".ts")
        if not component.exists():
            offenders.append(f"{template.relative_to(REPO)} (no component beside it)")
            continue
        source = component.read_text(encoding="utf-8")
        if "FormsModule" not in source:
            offenders.append(str(template.relative_to(REPO)))
    assert not offenders, (
        "(ngSubmit) used where no FormsModule/ReactiveFormsModule is imported — "
        "the handler will never run and nothing will say so. Either import the "
        "module or use the native (submit) with $event.preventDefault():\n  "
        + "\n  ".join(offenders)
    )


# --------------------------------------------------------------------------- #
# The role that was removed does not come back by name
# --------------------------------------------------------------------------- #

#: Where the word may still legitimately appear, and why.
#:
#:  * PROGRAM DIRECTOR is a job title PRINTED ON THE COLLEGE'S OWN LEAVE FORM.
#:    The second approver signs that block, `leave.py` fills `director_name` /
#:    `director_decided_at` / `director_note` for it, and `leave_paper.py` draws
#:    it at coordinates measured from the office's PDF. Renaming any of that
#:    would change a paper form nobody in this repo owns.
#:  * `Role.DIRECTOR` survives as an ENUM VALUE. A Postgres enum value cannot be
#:    dropped without recreating the type, the migration converts the rows, and
#:    `test_no_director_privilege.py` needs to be able to MINT one to prove it
#:    reaches nothing.
#:  * The removal's own record — governance.py, policies.py, grant_access.py,
#:    seed.py — has to say the word to explain what was removed and why.
#:
#: What this guard is actually for is the OTHER kind: a new `/api/director/*`
#: route, a `features/director/` folder, a `require_director`, an OpenAPI tag.
#: Those all existed on 2026-09-10 and were renamed; nothing stops them being
#: typed again, and the last time half of them survived a removal the result was
#: a role that passed fifty capability gates while failing every role gate.

WEB_SRC = REPO / "apps" / "web" / "src"


def test_no_route_or_module_is_named_for_the_removed_role() -> None:
    """The paths, not the prose. A `/api/director/*` route or a `director/`
    folder is the naming that actually reaches a user."""
    offenders: list[str] = []

    # 1. No API route may live under /director.
    for path in _python_files(APP):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r'["\']/(api/)?director(/|["\'])', line):
                offenders.append(f"{path.relative_to(APP.parent)}:{n}: {line.strip()}")

    # 2. No module or Angular folder may be named for it.
    for path in list(APP.rglob("*.py")) + list(WEB_SRC.rglob("*.ts")) + list(WEB_SRC.rglob("*.html")):
        if "__pycache__" in path.parts:
            continue
        if any(part == "director" for part in path.parts) or path.stem == "director":
            offenders.append(f"{path}: named for the removed role")

    # 3. No OpenAPI tag may advertise it — the tag is what /docs groups by.
    for path in _python_files(APP):
        text = path.read_text(encoding="utf-8")
        if re.search(r'tags=\[[^]]*["\']director["\'][^]]*\]', text, re.I):
            offenders.append(f"{path.relative_to(APP.parent)}: OpenAPI tag 'director'")

    # 4. No dependency named for it.
    for path in _python_files(APP):
        text = path.read_text(encoding="utf-8")
        if re.search(r"\bdef require_director\b|\brequire_director\(", text):
            offenders.append(f"{path.relative_to(APP.parent)}: require_director")

    assert not offenders, (
        "DIRECTOR is not a role in REEP (2026-09-10) and nothing may be routed or "
        "named for it. The word is still allowed in prose that explains the removal, "
        "and PROGRAM DIRECTOR is the leave form's own job title — see this guard's "
        "note. Offenders:\n  " + "\n  ".join(offenders)
    )


def test_the_client_does_not_know_the_removed_role_as_a_role() -> None:
    """`roleGuard('DIRECTOR', ...)` is the frontend half of a half-done removal.

    It let a retired DIRECTOR cookie into the console shell — fifteen sidebar
    links, every one of which the API answers 403 to. The `Role` union in
    core/session.ts is what makes the compiler find these, so this pins that the
    union has not quietly grown the value back.
    """
    session_ts = (WEB_SRC / "app" / "core" / "session.ts").read_text(encoding="utf-8")
    union = re.search(r"export type Role = ([^;]+);", session_ts)
    assert union, "core/session.ts no longer declares `export type Role`"
    assert "DIRECTOR" not in union.group(1), (
        "the client's Role union carries DIRECTOR again; every `role === 'DIRECTOR'` "
        "branch it used to guard compiles silently once it is back"
    )

    routes = (WEB_SRC / "app" / "app.routes.ts").read_text(encoding="utf-8")
    assert "'DIRECTOR'" not in routes, "app.routes.ts guards a route on DIRECTOR again"


def test_the_two_post_login_home_maps_agree() -> None:
    """The server and the client each decide where a sign-in lands, and they must
    not disagree.

    INCIDENT (2026-09-10): the SPA's `/director/*` routes were renamed to
    `/admin/*`, and `_HOME_FOR_ROLE` in app/routers/auth.py was not. It still
    read `"ADMIN": "/director"`, so a Main Admin signing in THROUGH GOOGLE —
    the only door that uses that map — was redirected to a route that no longer
    existed. The password door was fine, which is exactly why nobody saw it: the
    seeded logins in AGENTS.md never take that path.

    The comment above the map already asked for the two to be kept in step. A
    comment is not a guard.
    """
    auth_py = (APP / "routers" / "auth.py").read_text(encoding="utf-8")
    session_ts = (WEB_SRC / "app" / "core" / "session.ts").read_text(encoding="utf-8")

    server = dict(re.findall(r'"([A-Z]+)": "(/[a-z]+)"', auth_py.split("_HOME_FOR_ROLE")[1].split("}")[0]))
    client = dict(re.findall(r"([A-Z]+): '(/[a-z]+)'", session_ts.split("HOME_FOR_ROLE")[2].split("}")[0]))

    assert server, "could not read _HOME_FOR_ROLE out of app/routers/auth.py"
    assert client, "could not read HOME_FOR_ROLE out of core/session.ts"
    assert server == client, (
        "the post-login destinations disagree.\n"
        f"  app/routers/auth.py : {sorted(server.items())}\n"
        f"  core/session.ts     : {sorted(client.items())}"
    )

    # And neither may name a route the SPA no longer has.
    routes = (WEB_SRC / "app" / "app.routes.ts").read_text(encoding="utf-8")
    for role, home in server.items():
        assert f"'{home.lstrip('/')}'" in routes or home == "/login", (
            f"{role} is sent to {home}, which app.routes.ts does not declare"
        )


# --------------------------------------------------------------------------- #
# An index that is a prefix of another index
# --------------------------------------------------------------------------- #


def _index_key(idx) -> tuple[str, ...] | None:
    """The column names of `idx`, in order, or None if it is not that simple.

    A PARTIAL index (`postgresql_where`) and a FUNCTIONAL one are excluded on
    purpose: `uq_interview_consent_active (user_id, version) WHERE revoked_at IS
    NULL` looks like a prefix of nothing and covers nothing in general, and
    `ix_users_email_lower (lower(email))` has no plain column at all. Comparing
    those by column name is how a guard starts recommending the deletion of an
    index the planner needs.
    """
    if idx.dialect_options.get("postgresql", {}).get("where") is not None:
        return None
    names = []
    for col in idx.expressions:
        name = getattr(col, "name", None)
        if name is None:
            return None  # an expression, not a column
        names.append(name)
    return tuple(names) or None


def test_no_index_duplicates_the_prefix_of_another() -> None:
    """INCIDENT (2026-09-10, found by reading `pg_indexes`, not the models):
    THIRTEEN indexes were a strict prefix of — or identical to — a UNIQUE index
    on the same table.

    `ix_studentbadge_student (student_id)` beside
    `uq_student_badge (student_id, badge_code)`; `ix_ledger_day_student_day`
    and `uq_ledger_day` with the SAME two columns in the same order. Postgres
    answers those lookups from the unique index, so the duplicate only bought a
    write on every insert and update to the row, plus another candidate for the
    planner to price.

    They accumulate because each one is individually reasonable: somebody adds a
    unique constraint to a table that already had an index on its lead column,
    or adds `index=True` to a foreign key whose unique constraint already leads
    with it. Nothing complains, and it is invisible from the model file — both
    declarations look necessary on their own line.

    Migration `a91f3c5d80e4` dropped them. This is what stops the fourteenth.
    """
    import app.models  # noqa: F401 — registers every table on Base.metadata
    from app.db import Base
    from sqlalchemy import UniqueConstraint

    offenders: list[str] = []
    for table in Base.metadata.sorted_tables:
        keyed: list[tuple[str, tuple[str, ...]]] = []
        for idx in table.indexes:
            key = _index_key(idx)
            if key:
                keyed.append((idx.name, key))
        for con in table.constraints:
            if isinstance(con, UniqueConstraint) and con.columns:
                name = con.name or f"<unnamed unique on {table.name}>"
                keyed.append((name, tuple(c.name for c in con.columns)))
        # The primary key covers its own lead column too.
        if table.primary_key is not None and table.primary_key.columns:
            keyed.append((f"{table.name}_pkey", tuple(c.name for c in table.primary_key.columns)))

        for name, key in keyed:
            for other_name, other_key in keyed:
                if other_name == name:
                    continue
                if len(other_key) >= len(key) and other_key[: len(key)] == key:
                    # `name` buys nothing that `other_name` does not already give.
                    offenders.append(
                        f"{table.name}.{name} {list(key)} is covered by "
                        f"{other_name} {list(other_key)}"
                    )
                    break

    assert not offenders, (
        "Index(es) that duplicate the prefix of another index on the same table. "
        "Postgres serves the lookup from the wider one; the narrower only costs a "
        "write on every row change. Drop it in the model AND in a migration:\n  "
        + "\n  ".join(sorted(set(offenders)))
    )


# --------------------------------------------------------------------------- #
# 33. The development MCP surface stays a development thing
# --------------------------------------------------------------------------- #

#: The dev MCP mount (app/dev_mcp.py) turns every GET under /api into a tool
#: and FORWARDS THE CALLER'S COOKIE into the real handlers, so a tool call runs
#: as whoever holds that session. On a laptop that is the point. On a host
#: serving real students it is a second front door with none of the rate
#: limiting, revocation or audit the first one has, and it would answer to any
#: cookie that leaked from anywhere.
#:
#: Three properties keep it where it belongs, and each one has failed somewhere
#: before in this codebase's history, which is why all three are pinned rather
#: than trusted:
#:
#:   * the gate is the dev ALLOWLIST, never `not is_prod`. AGENTS.md records
#:     what the other spelling cost: an unrecognised ENV ("staging", "uat", a
#:     typo, a blank from a half-written deploy template) is not production by
#:     name, so `not is_prod` would OPEN the door on exactly the boxes nobody
#:     is watching.
#:   * the flag is off by default, so the mount cannot arrive by upgrading.
#:   * `fastapi-mcp` is not in requirements.txt, so it is not in the image the
#:     Dockerfile builds. A dependency that is absent cannot be switched on by
#:     a stray environment variable at all.


def test_the_dev_mcp_mount_is_refused_outside_a_development_environment() -> None:
    from app.config import Settings

    development = Settings(env="dev", mcp_dev_surface="true")
    assert development.mcp_enabled, "a development host with the flag on should mount it"

    for environment in ("prod", "production", "staging", "uat", "demo", "", "Dev-2"):
        settings = Settings(env=environment, mcp_dev_surface="true")
        assert not settings.mcp_enabled, (
            f"ENV={environment!r} mounted the dev MCP surface. The gate must be the "
            "dev allowlist (_DEV_ENV_NAMES), never `not is_prod` — an environment "
            "nobody anticipated has to LOSE the affordance, not gain it."
        )


def test_the_dev_mcp_surface_is_off_unless_it_is_switched_on() -> None:
    from app.config import Settings

    for flag in ("", "false", "no", "0", "ture", "TRUE-ish"):
        settings = Settings(env="dev", mcp_dev_surface=flag)
        assert not settings.mcp_enabled, (
            f"MCP_DEV_SURFACE={flag!r} switched the surface on. Only the exact word "
            "'true' counts, so a blank line, an absent variable or a typo all mean off."
        )

    assert Settings(env="dev", mcp_dev_surface="true").mcp_enabled
    assert Settings(env="dev", mcp_dev_surface="TRUE").mcp_enabled


def test_the_mcp_dependency_stays_out_of_the_production_image() -> None:
    runtime = (Path(__file__).resolve().parent.parent / "requirements.txt").read_text()
    development = (Path(__file__).resolve().parent.parent / "requirements-dev.txt").read_text()

    assert "fastapi-mcp" not in runtime and "fastapi_mcp" not in runtime, (
        "fastapi-mcp is in requirements.txt, which is what the Dockerfile installs. "
        "It is a development tool that forwards a session cookie into every handler; "
        "it belongs in requirements-dev.txt and nowhere else."
    )
    assert "fastapi-mcp==" in development, "requirements-dev.txt should pin fastapi-mcp"
    assert "mcp==" in development, (
        "requirements-dev.txt must ALSO pin `mcp`. fastapi-mcp declares `mcp>=1.12.0` "
        "with no upper bound, and the 2.x line removed Server.request_context, "
        "list_tools and call_tool — the API it calls. Without the second pin a fresh "
        "install raises TypeError the moment FastApiMCP(app, ...) is constructed."
    )


def test_the_dev_mcp_mount_publishes_no_write_operation() -> None:
    """The tool list is GET-only by construction, not by an exclusion list.

    app/dev_mcp.py derives its operations from the app's own OpenAPI schema.
    The alternative the tooling notes first suggested — `include_tags` with
    `exclude_operations` — does not do this: in fastapi-mcp 0.4.0 those filters
    UNION rather than intersect, so the tag list narrows nothing and every
    write endpoint not named in the exclusion list is published. Every tag this
    API carries contains write routes.
    """
    import ast

    source = (APP / "dev_mcp.py").read_text()
    tree = ast.parse(source)

    # The CALL's keywords, not the file's text. An earlier draft of this test
    # grepped for "include_tags=" and failed on the paragraph in dev_mcp.py
    # that explains why include_tags is wrong — the same shape of bug as a
    # guard that trips on its own documentation.
    constructions = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "FastApiMCP"
    ]
    assert len(constructions) == 1, "expected exactly one FastApiMCP(...) construction"
    keywords = {keyword.arg for keyword in constructions[0].keywords}

    assert "include_operations" in keywords, (
        "app/dev_mcp.py should select operations explicitly by id."
    )
    assert "include_tags" not in keywords, (
        "app/dev_mcp.py must not pass include_tags: in fastapi-mcp 0.4.0 it unions with "
        "exclude_operations rather than intersecting, so it would publish every write "
        "endpoint on the app."
    )
    assert "exclude_operations" not in keywords, (
        "app/dev_mcp.py should not need exclude_operations — the tool list is GET-only "
        "by construction, and an exclusion list is a list somebody has to keep right."
    )

    method = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "READ_ONLY_METHOD" for target in node.targets)
    ]
    assert method and ast.literal_eval(method[0].value) == "GET", (
        "app/dev_mcp.py should state the one method it publishes as a named constant."
    )


def test_the_dev_session_helper_does_not_retire_the_browsers_session() -> None:
    """`python -m app.dev_session` mints at the current token version.

    REEP allows one live session per account: every sign-in advances
    `users.token_version` before the token is minted, and app/security.py
    refuses a token whose version is behind the row. A helper that copied the
    login path would therefore sign the developer out of their own browser
    every time they minted a cookie for the MCP tool, and signing back in would
    invalidate the cookie they had just exported. The two would take turns.
    """
    source = (APP / "dev_session.py").read_text()

    assert "token_version" in source, "dev_session should carry the account's token version"
    for advance in ("token_version +=", "token_version = user.token_version + 1", "_retire_other_sessions"):
        assert advance not in source, (
            f"app/dev_session.py appears to advance the token version ({advance!r}). "
            "It must READ the current value: advancing it retires the developer's own "
            "browser session for the same account."
        )
    assert "env_is_dev" in source, (
        "app/dev_session.py must refuse outside a development environment — it prints "
        "a bearer token for a whole account."
    )
