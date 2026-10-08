"""Every migration can be rolled back, or says in words why it cannot.

Static: no database, no Alembic runtime, just the source of
`migrations/versions/` read as ASTs. The proof against Postgres is
`tools/ci/check_migration_roundtrip.py`, the "Migrations roll back" step in
ci.yml's `api` job; this is the half that fails in a second and names the file.

A RATCHET IN BOTH DIRECTIONS, because each direction alone rots:

  * a new revision whose downgrade() is `pass` or a bare `raise`, with no entry
    in `migrations/reversibility.py`'s IRREVERSIBLE, fails -- write the reverse,
    or write down why there is none;
  * an entry whose revision now HAS a real downgrade fails too -- strike it off,
    or the round trip keeps stopping at a floor that is no longer there and the
    revisions under it are never exercised again.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]


def _load_reversibility():
    # Loaded by path: `migrations/` is not a package, and making it one to
    # satisfy a test would put an __init__.py beside env.py for no runtime reason.
    spec = importlib.util.spec_from_file_location(
        "reep_migration_reversibility", API / "migrations" / "reversibility.py"
    )
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load apps/api-py/migrations/reversibility.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rev = _load_reversibility()


@pytest.fixture(scope="module")
def revisions():
    found = rev.scan()
    assert len(found) > 50, f"read only {len(found)} revisions from {rev.VERSIONS}; the guard would pass by finding nothing"
    return found


def test_there_is_exactly_one_head(revisions) -> None:
    """Two heads is two revisions generated against the same parent. `alembic
    upgrade head` refuses to run at all, so this is the cheap place to say so."""
    tips = rev.heads(revisions)
    assert len(tips) == 1, f"expected one head, found {tips}: merge or re-parent one of them"


def test_every_revision_is_on_one_unbranched_chain(revisions) -> None:
    ordered = rev.chain(revisions)
    assert len(ordered) == len(revisions), (
        f"{len(revisions) - len(ordered)} revision(s) are not on the chain from the head"
    )
    assert ordered[0].down_revision is None, f"the chain starts at {ordered[0].revision}, which has a parent"


def test_every_downgrade_does_real_work_or_is_declared_irreversible(revisions) -> None:
    undeclared = [
        f"{r.revision} ({r.path.name}): downgrade is {r.downgrade}"
        for r in revisions
        if r.downgrade != "real" and r.revision not in rev.IRREVERSIBLE
    ]
    assert not undeclared, (
        "these migrations cannot be rolled back and do not say why:\n  "
        + "\n  ".join(undeclared)
        + "\nWrite the downgrade. If the reverse would have to guess, re-issue something "
        "a person revoked, or undo what Postgres cannot, add the revision to IRREVERSIBLE "
        "in migrations/reversibility.py with that reason in words."
    )


def test_every_declared_irreversible_is_still_irreversible(revisions) -> None:
    by_id = {r.revision: r for r in revisions}
    stale = []
    for revision, entry in rev.IRREVERSIBLE.items():
        assert entry.downgrade in rev.KINDS, f"{revision}: unknown kind {entry.downgrade!r}"
        assert entry.reason.strip(), f"{revision}: an entry with no reason is not a decision"
        found = by_id.get(revision)
        if found is None:
            stale.append(f"{revision}: no such revision in migrations/versions/")
        elif found.downgrade != entry.downgrade:
            stale.append(
                f"{revision} ({found.path.name}) is declared {entry.downgrade!r} but its "
                f"downgrade is now {found.downgrade!r}"
            )
    assert not stale, (
        "IRREVERSIBLE no longer matches the migrations:\n  "
        + "\n  ".join(stale)
        + "\nA revision that gained a real downgrade must be struck off, or the round trip "
        "keeps stopping above revisions it could now exercise."
    )


def test_no_migration_lacks_a_downgrade_function(revisions) -> None:
    missing = [r.path.name for r in revisions if r.downgrade == "missing"]
    assert not missing, f"no downgrade() at all: {missing}"


def test_the_floor_is_the_newest_refusing_revision(revisions) -> None:
    """Derived, never typed: if it were a constant, a new refusing migration
    would leave CI trying to roll back through it. A refusing revision AT THE
    HEAD is legal -- SKILL.md says a new "raises" becomes the floor -- and then
    the newest segment is empty, which the round trip prints as such."""
    ordered = [r.revision for r in rev.chain(revisions)]
    refusing = [r for r in ordered if r in rev.IRREVERSIBLE and rev.IRREVERSIBLE[r].downgrade == "raises"]
    floor = rev.rollback_floor(revisions)
    assert floor == (refusing[-1] if refusing else None), (
        f"rollback_floor() says {floor}, but the newest refusing revision is "
        f"{refusing[-1] if refusing else None}"
    )


def test_the_segments_cover_every_downgrade_that_can_run(revisions) -> None:
    """Cut at each refusing revision, the segments must hold every other revision
    exactly once -- that is the round trip's coverage claim -- and at least one
    downgrade must run, or the CI step proves nothing (it exits 2 then)."""
    plan = rev.segments(revisions)
    downgraded = [r for s in plan for r in s.downgraded]
    refusing = {r for r, e in rev.IRREVERSIBLE.items() if e.downgrade == "raises"}
    expected = [r.revision for r in rev.chain(revisions) if r.revision not in refusing]
    assert downgraded == expected, "the segments do not cover each runnable downgrade exactly once, in order"
    assert len(plan) == len(refusing) + 1, f"{len(refusing)} refusing revisions should cut {len(refusing) + 1} segments"
    for s in plan:
        if s.downgraded:
            assert s.top == s.downgraded[-1], f"segment from {s.bottom} has top {s.top}, not its last revision"
    assert downgraded, "no downgrade on the chain can run; the round trip would prove nothing"


def test_a_refusing_revision_at_the_head_makes_an_empty_last_segment(revisions) -> None:
    """The shape SKILL.md promises, proved on a synthetic chain: a new "raises"
    at the head is the floor, and the segment above it is empty rather than an
    error."""
    head = rev.chain(revisions)[-1].revision
    saved = dict(rev.IRREVERSIBLE)
    try:
        rev.IRREVERSIBLE[head] = rev.Irreversible("raises", "synthetic: a refusing head")
        plan = rev.segments(revisions)
        assert rev.rollback_floor(revisions) == head, "a refusing head must be the floor"
        assert plan[-1].bottom == head and plan[-1].downgraded == (), (
            f"the last segment should be empty and start at the head, got {plan[-1]}"
        )
        assert any(s.downgraded for s in plan), "the segments below a refusing head still run"
    finally:
        rev.IRREVERSIBLE.clear()
        rev.IRREVERSIBLE.update(saved)


def test_every_declared_leftover_is_well_formed(revisions) -> None:
    """KEPT_ON_DOWNGRADE is the only thing the round trip ignores at a segment's
    bottom, so each entry must name a real revision, a known kind and a reason.
    Whether the leftover really happens is the round trip's half of the ratchet."""
    ids = {r.revision for r in revisions}
    shapes = {"enum-value": 3, "extension": 2, "table": 2}
    for revision, kept in rev.KEPT_ON_DOWNGRADE.items():
        assert revision in ids, f"KEPT_ON_DOWNGRADE names {revision}, which is not a revision"
        assert kept.reason.strip(), f"{revision}: a leftover with no reason is not a decision"
        assert kept.entries, f"{revision}: declares no leftover"
        for entry in kept.entries:
            assert entry[0] in shapes and len(entry) == shapes[entry[0]], f"{revision}: malformed entry {entry}"


def test_env_py_does_not_import_the_mapping() -> None:
    """Alembic loads env.py on every command, production included; knowing which
    migrations cannot be undone is CI's business, not the migration runner's."""
    env = (API / "migrations" / "env.py").read_text(encoding="utf-8")
    assert "reversibility" not in env, "migrations/env.py imports the reversibility list; it must not"


@pytest.mark.parametrize(
    ("body", "kind"),
    [
        # DEF-QG-U06's three shapes, and their neighbours: all execute nothing.
        ("    return\n", "no-op"),
        ('    """Nothing."""\n    ...\n', "no-op"),
        ('    """Nothing."""\n    return None\n', "no-op"),
        ('    if False:\n        op.execute("SELECT 2")\n', "no-op"),
        ('    if 0:\n        op.execute("SELECT 2")\n    pass\n', "no-op"),
        ('    return\n    op.execute("UPDATE t SET x = 1")\n', "no-op"),  # dead after return
        ("    if True:\n        pass\n", "no-op"),
        # The branch a literal selects is what runs.
        ('    if False:\n        pass\n    else:\n        op.execute("UPDATE t SET x = 0")\n', "real"),
        ('    if True:\n        op.drop_column("t", "c")\n', "real"),
        ('    op.execute("UPDATE t SET x = 0")\n', "real"),
        ('    if settings.flag:\n        op.execute("SELECT 1")\n', "real"),  # not a literal: kept
        # A refusal is a decision, wherever the dead code around it sits.
        ('    """Cannot."""\n    raise RuntimeError("no")\n', "raises"),
        ('    if False:\n        op.execute("SELECT 1")\n    raise RuntimeError("no")\n', "raises"),
    ],
)
def test_a_downgrade_that_executes_nothing_is_a_no_op(body, kind) -> None:
    """A data-only migration whose downgrade is `return` changes no catalogue, so
    the round trip cannot catch it; this classification is the only thing that
    can make it write an IRREVERSIBLE reason."""
    import ast

    tree = ast.parse("def upgrade() -> None:\n    pass\n\n\ndef downgrade() -> None:\n" + body)
    assert rev._downgrade_kind(tree) == kind, f"{body!r} should classify as {kind!r}"
