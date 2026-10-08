#!/usr/bin/env python3
"""Prove the migrations roll back: down to the floor, up again, same schema.

WHY THIS EXISTS. Ninety-odd downgrade() functions had never been run by
anything. `alembic upgrade head` runs on every CI job and every deploy;
`alembic downgrade` runs on the worst night of somebody's year, against
production, after a bad migration has already shipped -- which is the one
moment a downgrade that was never executed is discovered to drop the wrong
index, miss an enum it created, or raise on a column it forgot it renamed. A
reverse nobody has run is not a rollback plan. This runs every one of them that
CAN run, on every pull request.

WHAT IT DOES, from apps/api-py with DATABASE_URL set:

  1. refuses unless ENV is a development name (app.config's allowlist, never
     `not is_prod`), the host is loopback, and the database name does not say
     "prod" -- it DROPS things, and production's database is also called
     reep_py, so the name alone cannot be the guard;
  2. refuses unless the database is at the single head, because a round trip
     from anywhere else proves something else;
  3. dumps the catalogue (tables, columns with type / nullability / default /
     identity / comment, indexes, constraints, enum types and their values in
     order, sequences, views, triggers, extensions);
  4. `alembic downgrade <floor>`, where the floor is the newest revision whose
     downgrade REFUSES, derived from migrations/reversibility.py -- the same
     list tests/test_migration_reversibility.py checks without a database;
  5. `alembic upgrade head`;
  6. dumps the catalogue again and demands it equal the first, line for line;
  7. `alembic check` -- clean on main when this was written, so it is gated.

A check that did not run is never a pass: every refusal and every failed
subprocess exits non-zero with the reason.

    cd apps/api-py && python ../../tools/ci/check_migration_roundtrip.py
    cd apps/api-py && python ../../tools/ci/check_migration_roundtrip.py --plan   # read-only
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import subprocess
import sys
import time
from pathlib import Path

API = Path(__file__).resolve().parents[2] / "apps" / "api-py"
sys.path.insert(0, str(API))

LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})

# Every query is scoped to the `public` schema and to objects an EXTENSION did
# not create: pgvector installs its functions and operators there, and they are
# the extension's, not the migrations'.
CATALOGUE = {
    "relation": """
        SELECT c.relname, c.relkind::text
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    """,
    # Position is the rank among LIVE columns: attnum keeps the holes a dropped
    # column leaves, so comparing raw attnum would report a difference nobody
    # can see in a `\\d`.
    "column": """
        SELECT c.relname,
               row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),
               a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
               coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), a.attidentity::text,
               a.attgenerated::text, coalesce(col_description(c.oid, a.attnum), '')
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
          AND a.attnum > 0 AND NOT a.attisdropped
    """,
    "table-comment": """
        SELECT c.relname, obj_description(c.oid, 'pg_class')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
          AND obj_description(c.oid, 'pg_class') IS NOT NULL
    """,
    "index": """
        SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    """,
    "constraint": """
        SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
    """,
    "enum": """
        SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        GROUP BY t.typname
    """,
    "sequence": """
        SELECT c.relname, format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement,
               s.seqmin, s.seqmax, s.seqcycle
        FROM pg_sequence s
        JOIN pg_class c ON c.oid = s.seqrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
    """,
    "view": """
        SELECT viewname, pg_get_viewdef(format('%I.%I', schemaname, viewname)::regclass)
        FROM pg_views WHERE schemaname = 'public'
    """,
    "trigger": """
        SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid)
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
    """,
    "function": """
        SELECT p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    """,
    "extension": "SELECT extname FROM pg_extension",
}


def fail(message: str) -> int:
    print(f"\nFAILED: {message}", file=sys.stderr)
    return 1


def load_reversibility():
    spec = importlib.util.spec_from_file_location(
        "reep_migration_reversibility", API / "migrations" / "reversibility.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def refusal(settings, url) -> str | None:
    """Why this database must not be touched, or None. Allowlists, not denylists."""
    if not settings.env_is_dev:
        return (
            f"ENV={settings.env!r} is not a development environment. This script drops "
            "tables, columns and types on its way down; it runs only where ENV is one of "
            "app.config's development names."
        )
    if (url.host or "") not in LOOPBACK:
        return (
            f"the database host {url.host!r} is not loopback. CI's database and a "
            "developer's docker compose are both localhost; a remote host is somebody "
            "else's data, and production's database is ALSO named reep_py, so the name "
            "cannot be the guard on its own."
        )
    if "prod" in (url.database or "").lower():
        return f"the database is named {url.database!r}, which says production."
    return None


def dump(engine) -> list[str]:
    from sqlalchemy import text

    lines = []
    with engine.connect() as conn:
        for kind, sql in CATALOGUE.items():
            for row in conn.execute(text(sql)):
                lines.append(" | ".join([kind, *("" if v is None else str(v) for v in row)]))
    return sorted(lines)


def current_revision(engine) -> list[str]:
    from sqlalchemy import inspect, text

    with engine.connect() as conn:
        if not inspect(conn).has_table("alembic_version"):
            return []
        return sorted(r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version")))


def alembic(*args: str) -> bool:
    command = [sys.executable, "-m", "alembic", *args]
    print(f"\n$ python {' '.join(command[1:])}", flush=True)
    return subprocess.run(command, cwd=API).returncode == 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--plan", action="store_true", help="print what would run, touch nothing")
    args = parser.parse_args(argv)

    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url

    from app.config import settings

    url = make_url(settings.sqlalchemy_url)
    reason = refusal(settings, url)
    if reason:
        return fail(f"refusing to run: {reason}")

    rev = load_reversibility()
    revisions = rev.scan()
    try:
        ordered = [r.revision for r in rev.chain(revisions)]
    except ValueError as exc:
        return fail(str(exc))
    head = ordered[-1]
    floor = rev.rollback_floor(revisions)
    target = floor or "base"
    above = ordered[ordered.index(floor) + 1 :] if floor else ordered
    passes_through = [r for r in above if r in rev.IRREVERSIBLE]

    print(f"database   {url.render_as_string(hide_password=True)}")
    print(f"head       {head}")
    print(f"floor      {target}  (newest downgrade that refuses; migrations/reversibility.py)")
    print(f"exercised  {len(above)} downgrade(s) and {len(above)} upgrade(s)")
    for r in passes_through:
        print(f"           {r} is a declared no-op downgrade: the second upgrade must re-run over it")
    if args.plan:
        return 0

    engine = create_engine(settings.sqlalchemy_url)
    started = time.monotonic()
    at = current_revision(engine)
    if at != [head]:
        return fail(
            f"the database is at {at or 'nothing'}, not the head {head}. Run "
            "`alembic upgrade head` first: a round trip from anywhere else proves something else."
        )

    before = dump(engine)
    print(f"\ncatalogue before: {len(before)} lines")

    if not alembic("downgrade", target):
        return fail(
            f"`alembic downgrade {target}` failed. A downgrade above the floor raised -- "
            "read the traceback above for the revision. Fix that downgrade(); if it can "
            "never be exact, it belongs in IRREVERSIBLE with the reason, which moves the floor."
        )
    if current_revision(engine) != ([floor] if floor else []):
        return fail(f"after the downgrade the database is at {current_revision(engine)}, not {target}")

    if not alembic("upgrade", "head"):
        return fail(
            "`alembic upgrade head` failed AFTER the downgrade. Either a downgrade left "
            "something its upgrade then trips over (an enum, an index, a table it did not "
            "drop), or a declared no-op downgrade sits under an upgrade that cannot run twice."
        )

    after = dump(engine)
    print(f"\ncatalogue after:  {len(after)} lines")
    if before != after:
        diff = list(difflib.unified_diff(before, after, "before (head)", "after (floor -> head)", lineterm="", n=0))
        print("\n".join(diff[:200]), file=sys.stderr)
        if len(diff) > 200:
            print(f"... and {len(diff) - 200} more lines", file=sys.stderr)
        return fail(
            "the schema after the round trip is not the schema before it. A downgrade did "
            "not undo exactly what its upgrade did: '-' lines are what the round trip lost, "
            "'+' lines what it left behind."
        )

    if not alembic("check"):
        return fail("`alembic check` reports drift between the models and the round-tripped schema")

    print(
        f"\nOK: rolled back {len(above)} revision(s) to {target} and up again to {head}; "
        f"{len(after)} catalogue lines identical; alembic check clean "
        f"({time.monotonic() - started:.0f} s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
