#!/usr/bin/env python3
"""Prove the migrations roll back: every downgrade that can run, compared at both ends.

WHY THIS EXISTS. `alembic upgrade head` runs on every CI job and every deploy;
`alembic downgrade` runs on the night a bad migration has already shipped,
against production -- the one moment a downgrade nobody ever executed turns out
to drop the wrong index, miss the enum its upgrade created, or restore the wrong
default. A reverse nobody has run is not a rollback plan. This runs every
downgrade on the chain except the ones that refuse on purpose
(migrations/reversibility.py's IRREVERSIBLE "raises"), on every pull request.

WHAT IT DOES, from apps/api-py with DATABASE_URL set:

  1. refuses unless ENV is a development name (app.config's allowlist, never
     `not is_prod`), EVERY host libpq would use -- `host` and `hostaddr`, from
     the URL and from its query string, as psycopg will actually read them -- is
     loopback, the connected server says it is local, and the database name does
     not say "prod". It creates and drops a database; production's is also
     named reep_py, so the name cannot be the guard on its own;
  2. refuses unless DATABASE_URL's database is at the single head, and dumps its
     catalogue -- the schema a straight `upgrade head` built;
  3. creates a scratch database beside it and walks the chain in SEGMENTS, cut
     at every revision whose downgrade refuses (`segments()`): for each, dump at
     the segment's bottom, upgrade to its top and dump, downgrade to the bottom
     and dump, upgrade to the top and dump. The BOTTOM pair is what catches a
     downgrade that restores the wrong thing (a default put back as 'INACTIVE'
     where it was 'ACTIVE' is invisible at the top, because the re-upgrade
     overwrites it); the TOP pair catches a downgrade that leaves something its
     upgrade then trips over or silently keeps;
  4. demands the scratch database, now at head by way of every round trip, has
     the same catalogue as the straight one, runs `alembic check` against it,
     and drops it.

WHAT "THE SAME CATALOGUE" MEANS, and the two places it is deliberately less
than byte-for-byte: tables, columns (type, nullability, default, identity,
generated, comment), indexes, constraints, enum types and their values in
order, sequences, views, triggers, non-extension functions and extensions --
  * columns are compared as a SET per table, not by ordinal position. A
    downgrade that puts a dropped column back can only append it: Postgres has
    no way to insert a column at a position, so a position check would fail
    every honest reverse of a DROP COLUMN, and nothing here reads a column by
    position (SQLAlchemy names every column);
  * the entries KEPT_ON_DOWNGRADE declares -- an enum value Postgres cannot
    drop, an extension left installed -- are removed from both sides of a
    bottom comparison for the segments whose downgrades include them, and
    nowhere else.

A check that did not run is never a pass: every refusal and failed subprocess
exits non-zero with the reason, and a chain on which no downgrade can run at
all exits 2 ("nothing was proven"), which CI reads as a failure on purpose.

    cd apps/api-py && python ../../tools/ci/check_migration_roundtrip.py --plan   # read-only
    cd apps/api-py && python ../../tools/ci/check_migration_roundtrip.py
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import ipaddress
import os
import subprocess
import sys
import time
from pathlib import Path

API = Path(__file__).resolve().parents[2] / "apps" / "api-py"
sys.path.insert(0, str(API))

LOOPBACK_NAMES = frozenset({"localhost"})

# Every query is scoped to the `public` schema and to objects an EXTENSION did
# not create: pgvector installs its functions and operators there, and they are
# the extension's, not the migrations'. alembic_version is left out: it is the
# bookkeeping this script checks separately, and it does not exist on an empty
# database but does after `downgrade base`.
CATALOGUE = {
    "relation": """
        SELECT c.relname, c.relkind::text
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
          AND c.relname <> 'alembic_version'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    """,
    # No position column: see the docstring.
    "column": """
        SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
               coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), a.attidentity::text,
               a.attgenerated::text, coalesce(col_description(c.oid, a.attnum), '')
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
          AND c.relname <> 'alembic_version'
          AND a.attnum > 0 AND NOT a.attisdropped
    """,
    "table-comment": """
        SELECT c.relname, obj_description(c.oid, 'pg_class')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
          AND obj_description(c.oid, 'pg_class') IS NOT NULL
    """,
    "index": """
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'alembic_version'
    """,
    "constraint": """
        SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname <> 'alembic_version'
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


class Refused(Exception):
    pass


def fail(message: str, code: int = 1) -> int:
    print(f"\nFAILED: {message}", file=sys.stderr)
    return code


def load_reversibility():
    spec = importlib.util.spec_from_file_location(
        "reep_migration_reversibility", API / "migrations" / "reversibility.py"
    )
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load apps/api-py/migrations/reversibility.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _is_loopback(host: str) -> bool:
    if host.startswith("/"):
        return True  # a Unix socket is this machine by definition
    if host.lower() in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def libpq_hosts(engine) -> list[str]:
    """Every host and hostaddr psycopg will hand libpq for this URL.

    Read from the dialect's own connect arguments rather than from `url.host`:
    `...@localhost/db?host=db.example.com` and `?hostaddr=192.0.2.1` both carry
    a loopback `url.host`, and psycopg really connects to the query string's.
    Both keys may be comma-separated lists (libpq's multi-host form).
    """
    _, kwargs = engine.dialect.create_connect_args(engine.url)
    hosts: list[str] = []
    for key in ("host", "hostaddr"):
        value = kwargs.get(key)
        if value:
            hosts.extend(h.strip() for h in str(value).split(",") if h.strip())
    return hosts or ["(libpq default)"]


def refusal(settings, engine) -> str | None:
    """Why this database must not be touched, or None. Allowlists, not denylists."""
    url = engine.url
    if not settings.env_is_dev:
        return (
            f"ENV={settings.env!r} is not a development environment. This script creates "
            "and drops a database and runs every downgrade; it runs only where ENV is one "
            "of app.config's development names."
        )
    hosts = libpq_hosts(engine)
    remote = [h for h in hosts if not _is_loopback(h)]
    if remote:
        return (
            f"the connection would go to {remote}, which is not loopback (host and hostaddr "
            "are both read, including from the query string). CI's database and a "
            "developer's docker compose are both local; production's database is ALSO "
            "named reep_py, so the name cannot be the guard on its own."
        )
    if "prod" in (url.database or "").lower():
        return f"the database is named {url.database!r}, which says production."
    return None


def server_is_local(engine) -> str | None:
    """Belt and braces after connecting: the server's own view of the socket."""
    from sqlalchemy import text

    with engine.connect() as conn:
        addr = conn.execute(text("SELECT host(inet_server_addr())")).scalar()
    if addr is None or ipaddress.ip_address(addr).is_loopback:
        return None
    return f"the server reports it is listening on {addr}, which is not loopback"


def dump(engine) -> list[str]:
    from sqlalchemy import text

    lines = []
    with engine.connect() as conn:
        for kind, sql in CATALOGUE.items():
            for row in conn.execute(text(sql)):
                lines.append(" | ".join([kind, *("" if v is None else str(v) for v in row)]))
    return sorted(lines)


def without(lines: list[str], kept: list[tuple[str, ...]]) -> list[str]:
    """Remove declared leftovers: an enum VALUE from its type's line, an
    extension, or a whole table (its relation, columns, indexes, constraints)."""
    out = []
    for line in lines:
        parts = line.split(" | ")
        for entry in kept:
            if entry[0] == "enum-value" and parts[:2] == ["enum", entry[1]]:
                parts[2] = ",".join(v for v in parts[2].split(",") if v != entry[2])
            elif entry[0] == "extension" and parts == ["extension", entry[1]]:
                parts = []
                break
            elif entry[0] == "table" and (
                (parts[0] in ("relation", "column", "constraint", "table-comment") and parts[1] == entry[1])
                or (parts[0] == "index" and f" ON public.{entry[1]} " in parts[2])
            ):
                parts = []
                break
        if parts:
            out.append(" | ".join(parts))
    return sorted(out)


def present(lines: list[str], entry: tuple[str, ...]) -> bool:
    """Whether a declared leftover is actually in a dump: the ratchet's other half."""
    for line in lines:
        parts = line.split(" | ")
        if entry[0] == "enum-value" and parts[:2] == ["enum", entry[1]]:
            return entry[2] in parts[2].split(",")
        if entry[0] == "extension" and parts == ["extension", entry[1]]:
            return True
        if entry[0] == "table" and parts[:2] == ["relation", entry[1]]:
            return True
    return False


def current_revision(engine) -> list[str]:
    from sqlalchemy import inspect, text

    with engine.connect() as conn:
        if not inspect(conn).has_table("alembic_version"):
            return []
        return sorted(r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version")))


def alembic(database_url: str, *args: str) -> None:
    command = [sys.executable, "-m", "alembic", *args]
    print(f"$ python {' '.join(command[1:])}", flush=True)
    env = {**os.environ, "DATABASE_URL": database_url}
    # stdout is the migration log, hundreds of lines per segment; it is shown
    # only when the command fails, where it is the evidence.
    result = subprocess.run(command, cwd=API, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout[-20000:])
        sys.stderr.write(result.stderr[-20000:])
        raise Refused(f"`alembic {' '.join(args)}` failed (traceback above names the revision)")


def compare(before: list[str], after: list[str], where: str, hint: str) -> None:
    if before == after:
        return
    diff = list(difflib.unified_diff(before, after, "before", "after", lineterm="", n=0))
    print("\n".join(diff[:200]), file=sys.stderr)
    if len(diff) > 200:
        print(f"... and {len(diff) - 200} more lines", file=sys.stderr)
    raise Refused(f"the catalogue {where} differs ('-' lost, '+' left behind). {hint}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--plan", action="store_true", help="print what would run, touch nothing")
    args = parser.parse_args(argv)

    from sqlalchemy import create_engine, text

    from app.config import settings

    engine = create_engine(settings.sqlalchemy_url)
    reason = refusal(settings, engine)
    if reason:
        return fail(f"refusing to run: {reason}")

    rev = load_reversibility()
    revisions = rev.scan()
    try:
        ordered = [r.revision for r in rev.chain(revisions)]
        plan = rev.segments(revisions)
    except ValueError as exc:
        return fail(str(exc))
    head = ordered[-1]
    exercised = sum(len(s.downgraded) for s in plan)

    url = engine.url
    scratch_name = f"{url.database}_roundtrip"
    scratch_url = url.set(database=scratch_name)
    print(f"database   {url.render_as_string(hide_password=True)}  (read only: compared against)")
    print(f"scratch    {scratch_name}  (created, walked, dropped)")
    print(f"head       {head}")
    print(f"floor      {rev.rollback_floor(revisions) or 'base'}  (the furthest a real rollback can go)")
    for s in plan:
        span = f"{s.bottom or 'base'} .. {s.top or 'base'}"
        if s.downgraded:
            print(f"segment    {span}: {len(s.downgraded)} downgrade(s)")
        else:
            print(f"segment    {span}: empty (the next revision refuses)")
    print(f"exercised  {exercised} of {len(ordered)} downgrades; the rest refuse on purpose")
    if args.plan:
        return 0
    if exercised == 0:
        return fail("no downgrade on the chain can run, so nothing was proven; a gate that "
                    "proved nothing is not a pass.", code=2)

    try:
        local = server_is_local(engine)
    except Exception as exc:  # noqa: BLE001 -- any failure here means "not proven local"
        return fail(f"could not connect to check the server's address: {exc}")
    if local:
        return fail(f"refusing to run: {local}")
    at = current_revision(engine)
    if at != [head]:
        return fail(
            f"{url.database} is at {at or 'nothing'}, not the head {head}. Run "
            "`alembic upgrade head` first: it is the straight-path schema the round trips "
            "are compared against."
        )

    started = time.monotonic()
    straight = dump(engine)
    print(f"\nstraight path: {len(straight)} catalogue lines at {head}")

    admin = create_engine(settings.sqlalchemy_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{scratch_name}"'))
        conn.execute(text(f'CREATE DATABASE "{scratch_name}"'))
    scratch_dsn = scratch_url.render_as_string(hide_password=False)
    scratch = create_engine(scratch_dsn)
    try:
        for s in plan:
            bottom = s.bottom or "base"
            print(f"\n== segment {bottom} .. {s.top or 'base'}")
            if s.bottom is not None:
                alembic(scratch_dsn, "upgrade", s.bottom)
            if not s.downgraded:
                print("   empty: the revision after the bottom refuses its downgrade")
                continue
            kept = [e for r in s.downgraded if r in rev.KEPT_ON_DOWNGRADE for e in rev.KEPT_ON_DOWNGRADE[r].entries]
            bottom_before = dump(scratch)
            alembic(scratch_dsn, "upgrade", s.top)
            top_before = dump(scratch)
            alembic(scratch_dsn, "downgrade", bottom)
            bottom_after = dump(scratch)
            stale = [e for e in kept if present(bottom_before, e) or not present(bottom_after, e)]
            if stale:
                raise Refused(
                    f"KEPT_ON_DOWNGRADE declares {stale} as left behind at {bottom}, but it is "
                    "not (or was already there before the upgrade). A downgrade that now "
                    "cleans up after itself must be struck off the list, or the comparison "
                    "keeps ignoring a difference that no longer exists."
                )
            compare(
                without(bottom_before, kept), without(bottom_after, kept),
                f"at {bottom} after {len(s.downgraded)} downgrade(s)",
                "A downgrade in this segment did not restore what its upgrade changed. If "
                "the leftover is genuinely impossible to remove (an enum value), declare it "
                "in KEPT_ON_DOWNGRADE with the reason.",
            )
            alembic(scratch_dsn, "upgrade", s.top)
            compare(
                top_before, dump(scratch), f"at {s.top} after the round trip",
                "A downgrade left something the re-upgrade kept or worked around.",
            )
            if kept:
                print(f"   declared leftovers ignored at the bottom: {kept}")
            print(f"   OK: {len(s.downgraded)} downgrade(s), identical at both ends")
        if current_revision(scratch) != [head]:
            alembic(scratch_dsn, "upgrade", "head")
        compare(
            straight, dump(scratch), f"at {head}: straight path vs every round trip",
            "Walking the chain through its round trips built a different schema from a "
            "straight `upgrade head`.",
        )
        print()
        alembic(scratch_dsn, "check")
    except Refused as exc:
        return fail(str(exc))
    finally:
        scratch.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{scratch_name}"'))
        admin.dispose()

    print(
        f"\nOK: {exercised} of {len(ordered)} downgrades run in {sum(1 for s in plan if s.downgraded)} "
        f"segment(s), catalogues identical at every bottom and top, the round-tripped head "
        f"matches the straight one ({len(straight)} lines), alembic check clean "
        f"({time.monotonic() - started:.0f} s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
