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
    assert spec and spec.loader
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
    assert rev.heads(revisions) == [rev.chain(revisions)[-1].revision]
    assert len(rev.heads(revisions)) == 1, rev.heads(revisions)


def test_every_revision_is_on_one_unbranched_chain(revisions) -> None:
    ordered = rev.chain(revisions)
    assert len(ordered) == len(revisions)
    assert ordered[0].down_revision is None


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
    """The round trip's floor is derived, never typed: if it were a constant, a
    new refusing migration would leave CI trying to roll back through it."""
    ordered = [r.revision for r in rev.chain(revisions)]
    refusing = [r for r in ordered if rev.IRREVERSIBLE.get(r, None) and rev.IRREVERSIBLE[r].downgrade == "raises"]
    floor = rev.rollback_floor(revisions)
    assert floor == (refusing[-1] if refusing else None)
    # Something above the floor must be exercised, or the step proves nothing.
    assert floor is None or ordered.index(floor) < len(ordered) - 1


def test_env_py_does_not_import_the_mapping() -> None:
    """Alembic loads env.py on every command, production included; knowing which
    migrations cannot be undone is CI's business, not the migration runner's."""
    env = (API / "migrations" / "env.py").read_text(encoding="utf-8")
    assert "reversibility" not in env
