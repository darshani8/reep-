"""Which migrations may NOT be rolled back, and why -- one list, read twice.

`tests/test_migration_reversibility.py` reads this statically, with no
database: every file in `versions/` must have a `downgrade()` that does real
work, or be named in `IRREVERSIBLE` with the reason in words.
`tools/ci/check_migration_roundtrip.py` reads it against a real database: it
rolls the schema back to `rollback_floor()`, upgrades it again, and proves the
catalogue came back byte for byte. Two copies of this list would drift the day
somebody adds a fifth entry to one of them, so there is one, and both import it.

`migrations/env.py` must NOT import this. Alembic loads env.py on every
command, in production too, and nothing about running a migration depends on
knowing which ones cannot be undone. It is also why this file sits BESIDE
`versions/` rather than in it: Alembic loads every module in `versions/` as a
revision, and one without a `revision` identifier is an error.

TWO KINDS OF IRREVERSIBLE, and the difference decides how far CI can roll back:

  * "raises" -- the downgrade REFUSES. Nothing can be rolled back past it, so the
    newest one on the chain is the FLOOR: the round trip goes down to it (it
    stays applied) and up again, and everything above it is exercised.
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


def _downgrade_kind(tree: ast.Module) -> str:
    """Classify the body of downgrade(), read as source -- nothing is executed.

    A docstring and comments are not work. A body that is only `pass` (or only
    a docstring) is a no-op; a body that is a single `raise` refuses. Anything
    else is treated as real, deliberately loosely: this test cannot tell a
    correct reverse from a wrong one -- the round trip against Postgres can --
    it only refuses the two shapes that mean "no reverse was written".
    """
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "downgrade":
            body = [
                stmt
                for stmt in node.body
                if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant))
            ]
            if not body or all(isinstance(stmt, ast.Pass) for stmt in body):
                return "no-op"
            if len(body) == 1 and isinstance(body[0], ast.Raise):
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
