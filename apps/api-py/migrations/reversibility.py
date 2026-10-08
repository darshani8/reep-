"""Which migrations may NOT be rolled back, and why -- one list, read twice.

`tests/test_migration_reversibility.py` reads this statically, with no
database: every file in `versions/` must have a `downgrade()` that does real
work, or be named in `IRREVERSIBLE` with the reason in words.
`tools/ci/check_migration_roundtrip.py` reads it against a real database: on a
scratch copy it round-trips every SEGMENT between two refusing revisions
(`segments()`), proving the catalogue matches at the bottom of each segment
after its downgrades and at the top after the upgrades that follow -- minus the
leftovers declared in `KEPT_ON_DOWNGRADE`, and minus column order. Two copies of this list would drift the day
somebody adds a fifth entry to one of them, so there is one, and both import it.

`migrations/env.py` must NOT import this. Alembic loads env.py on every
command, in production too, and nothing about running a migration depends on
knowing which ones cannot be undone. It is also why this file sits BESIDE
`versions/` rather than in it: Alembic loads every module in `versions/` as a
revision, and one without a `revision` identifier is an error.

TWO KINDS OF IRREVERSIBLE, and the difference decides how far CI can roll back:

  * "raises" -- the downgrade REFUSES. Nothing can be rolled back THROUGH it, so
    each one splits the chain into segments, and each segment is round-tripped
    on its own: upgraded to just below the refusing revision, downgraded to the
    one before, upgraded again. The newest is the FLOOR a real rollback of
    production could reach (`rollback_floor()`).
  * "no-op" -- the downgrade does nothing ON PURPOSE and the rollback passes
    straight through. That is only honest when the upgrade is safe to run a
    second time over what the no-op left behind, and the round trip is what
    proves it: an upgrade that is not re-runnable fails there, on the second
    `upgrade head`, with this list's reason beside it.

Adding an entry is a decision, not a formality. "Nobody wrote the downgrade" is
not a reason -- write it. A reason belongs here when the reverse would have to
GUESS (which MENTOR rows were DIRECTOR), re-issue something a person revoked,
or undo what Postgres cannot (an enum value cannot be dropped).
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

VERSIONS = Path(__file__).resolve().parent / "versions"


@dataclass(frozen=True)
class Irreversible:
    downgrade: str  # "raises" | "no-op"
    reason: str


#: {revision id: why its downgrade() raises or does nothing}. A RATCHET in both
#: directions (tests/test_migration_reversibility.py): a revision that gains a
#: real downgrade must be struck off, and a new pass/raise downgrade with no
#: entry fails the build.
IRREVERSIBLE: dict[str, Irreversible] = {
    "7c4e0b21d9aa": Irreversible(
        "raises",
        "DIRECTOR is not a role any more. Nothing records which MENTOR rows were "
        "DIRECTOR, so a downgrade could only guess, and a wrong guess re-grants "
        "console access over every student's records. Restore a person's access "
        "in Governance instead.",
    ),
    "9b2d47f0ce15": Irreversible(
        "raises",
        "Which applications were PENDING_VERIFICATION is not recorded, and "
        "restoring the status would re-hide applications the office may since "
        "have decided.",
    ),
    "b8d2f7a4c619": Irreversible(
        "no-op",
        "Postgres cannot drop a value from an enum: removing NEEDS_CHANGES means "
        "recreating upload_status and deciding what every row holding it becomes, "
        "which is a data decision. An unused enum value is inert, and the "
        "upgrade's ADD VALUE IF NOT EXISTS re-runs cleanly over it.",
    ),
    "d8b1f4c2a7e9": Irreversible(
        "no-op",
        "The upgrade revoked every live mentor.leave_approve grant with a reason "
        "written on the row. Un-revoking would re-issue access nobody decided to "
        "give back; the upgrade's UPDATE ... WHERE revoked_at IS NULL re-runs "
        "cleanly.",
    ),
}

KINDS = frozenset({"raises", "no-op"})


@dataclass(frozen=True)
class Kept:
    #: Catalogue entries this revision's downgrade leaves behind on purpose:
    #: ("enum-value", type, value), ("extension", name) or ("table", name).
    entries: tuple[tuple[str, ...], ...]
    reason: str


#: Downgrades that do REAL work but cannot undo all of it -- an enum value
#: (Postgres has no DROP VALUE) or an extension something else may use. The
#: round trip compares the bottom of a segment with these entries removed from
#: both sides, and ONLY these: anything else a downgrade leaves behind fails.
#: It is a RATCHET: an entry that is not actually left at the bottom of its
#: segment fails too. That is why b8d2f7a4c619's NEEDS_CHANGES is NOT here: its
#: segment rolls back to an empty database, where 5d48c6c2ffdd's downgrade drops
#: the whole upload_status type, so the value never survives to be compared.
KEPT_ON_DOWNGRADE: dict[str, Kept] = {
    "b7e2f4a19c33": Kept(
        (("extension", "vector"),),
        "The pgvector extension stays installed: dropping it could break anything "
        "else that came to depend on it, and an unused extension is inert.",
    ),
    "d5a1c8b30f47": Kept(
        (("table", "students_orphaned_cohort_ids"),),
        "The rescue table is an operator's receipt for rows the upgrade was about to "
        "NULL (migrations/env.py, _PRESERVED_DATA_TABLES): the downgrade restores the "
        "rows from it and keeps it, and the upgrade's CREATE TABLE IF NOT EXISTS "
        "re-runs over it.",
    ),
    "c4f7b1e08d92": Kept(
        (("enum-value", "registration_status", "HOLD"),),
        "The three hold columns come back out; the HOLD value cannot -- Postgres "
        "has no DROP VALUE, and rows holding it would need a data decision.",
    ),
}


@dataclass(frozen=True)
class Revision:
    revision: str
    down_revision: str | tuple[str, ...] | None
    path: Path
    #: "real", "no-op" (only `pass` / a docstring), "raises" (a single raise),
    #: or "missing" (no downgrade() at all).
    downgrade: str


def _module_constant(tree: ast.Module, name: str) -> object:
    for node in tree.body:
        target = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
        elif isinstance(node, ast.AnnAssign):
            target = node.target
        if isinstance(target, ast.Name) and target.id == name and node.value is not None:
            return ast.literal_eval(node.value)
    raise LookupError(name)


def _executed(body: list[ast.stmt]) -> list[ast.stmt]:
    """The statements of `body` that can run and do something, read as source.

    Not work: a docstring or any bare constant expression (`...` included),
    `pass`, and everything after a `return`. A `return` with no value or
    `return None` ends the body. An `if` whose test is a literal constant is
    replaced by the branch that constant selects -- `if False: op.execute(...)`
    executes nothing, `if True:` executes its body -- and anything else is kept
    as it is. A RAISE is kept: it is not work, but it is a decision, and the
    caller tells the two apart.
    """
    out: list[ast.stmt] = []
    for stmt in body:
        if isinstance(stmt, ast.Pass):
            continue
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            continue
        if isinstance(stmt, ast.Return):
            if stmt.value is None or (isinstance(stmt.value, ast.Constant) and stmt.value.value is None):
                break
            out.append(stmt)
            break
        if isinstance(stmt, ast.If) and isinstance(stmt.test, ast.Constant):
            out.extend(_executed(stmt.body if stmt.test.value else stmt.orelse))
            continue
        out.append(stmt)
    return out


def _downgrade_kind(tree: ast.Module) -> str:
    """Classify the body of downgrade(), read as source -- nothing is executed.

    "no-op" is a body that EXECUTES NOTHING (`_executed` is empty): only a
    docstring, `pass`, `...`, a bare `return` / `return None`, or an `if` on a
    falsy literal. It used to be "only `pass`", and the unit test level showed
    why that was too loose (DEF-QG-U06): `return` alone, or `if False:
    op.execute(...)`, read as "real", and a DATA-ONLY migration -- an UPDATE --
    with such a downgrade changes no catalogue, so the round trip cannot see it
    either; no IRREVERSIBLE reason was ever written for it. "raises" is a body
    whose only executed statement is a `raise`. Anything else is "real", and
    whether a real reverse is CORRECT is the round trip's question, not this one.
    """
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "downgrade":
            executed = _executed(node.body)
            if not executed:
                return "no-op"
            if len(executed) == 1 and isinstance(executed[0], ast.Raise):
                return "raises"
            return "real"
    return "missing"


def scan(versions: Path = VERSIONS) -> list[Revision]:
    revisions = []
    for path in sorted(versions.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        revisions.append(
            Revision(
                revision=str(_module_constant(tree, "revision")),
                down_revision=_module_constant(tree, "down_revision"),  # type: ignore[arg-type]
                path=path,
                downgrade=_downgrade_kind(tree),
            )
        )
    return revisions


def heads(revisions: list[Revision]) -> list[str]:
    parents: set[str] = set()
    for rev in revisions:
        if isinstance(rev.down_revision, tuple):
            parents.update(rev.down_revision)
        elif rev.down_revision:
            parents.add(rev.down_revision)
    return sorted(r.revision for r in revisions if r.revision not in parents)


def chain(revisions: list[Revision]) -> list[Revision]:
    """Base first, head last. Refuses a branched history rather than guessing."""
    by_id = {r.revision: r for r in revisions}
    tips = heads(revisions)
    if len(tips) != 1:
        raise ValueError(f"expected exactly one head, found {tips}")
    ordered: list[Revision] = []
    current: str | None = tips[0]
    while current is not None:
        rev = by_id[current]
        if isinstance(rev.down_revision, tuple):
            raise ValueError(f"{rev.revision} is a merge revision; the floor is undefined across a merge")
        ordered.append(rev)
        current = rev.down_revision
    if len(ordered) != len(revisions):
        stray = sorted(set(by_id) - {r.revision for r in ordered})
        raise ValueError(f"revisions not on the chain from the head: {stray}")
    return list(reversed(ordered))


@dataclass(frozen=True)
class Segment:
    #: The revision the segment is rolled back TO (None = an empty database),
    #: the revision it is upgraded to, and the revisions whose downgrades run.
    bottom: str | None
    top: str | None
    downgraded: tuple[str, ...]


def segments(revisions: list[Revision] | None = None) -> list[Segment]:
    """The chain cut at every revision whose downgrade refuses.

    A refusing revision can be upgraded through but never downgraded through, so
    each stretch between two of them is round-tripped separately: from the
    refusing revision below it (or an empty database) to the revision just
    under the next one (or the head). A stretch with nothing in it -- two
    refusing revisions in a row, or one at the head -- is an empty segment.
    """
    out: list[Segment] = []
    bottom: str | None = None
    run: list[str] = []
    for rev in chain(revisions if revisions is not None else scan()):
        entry = IRREVERSIBLE.get(rev.revision)
        if entry is not None and entry.downgrade == "raises":
            out.append(Segment(bottom, run[-1] if run else bottom, tuple(run)))
            bottom, run = rev.revision, []
        else:
            run.append(rev.revision)
    out.append(Segment(bottom, run[-1] if run else bottom, tuple(run)))
    return out


def rollback_floor(revisions: list[Revision] | None = None) -> str | None:
    """The newest revision whose downgrade refuses: as far back as CI can go.

    None means nothing refuses and the whole chain can be rolled back to base.
    """
    floor = None
    for rev in chain(revisions if revisions is not None else scan()):
        entry = IRREVERSIBLE.get(rev.revision)
        if entry is not None and entry.downgrade == "raises":
            floor = rev.revision
    return floor
