#!/usr/bin/env python3
"""Find `async def` functions in apps/api-py/app that block the event loop.

WHY THIS EXISTS. On 2026-09-29 sixteen students reported a 504 from
`/register`. `submit` and `attach_document` were `async def` doing BLOCKING
work -- a sync SQLAlchemy Session, the EFS write, the S3 archive PUT -- so they
ran ON the event loop, and while one student's files were being saved no
other request in that process was served at all. CloudFront gave up at 60 s
and printed its own 504 over a request that was still working. Both are plain
`def` now (FastAPI runs those on the threadpool), and
`tests/test_registration_concurrency.py` pins those two functions. Nothing
pinned the NEXT one, and that is this file's job.

WHY RUFF CANNOT DO IT. ruff's ASYNC rules see one call at a time: `time.sleep`,
`open()`, `requests.get`, `subprocess.run` inside `async def`. The defect that
actually reached production is none of those. It is a parameter --
`db: Session = Depends(get_db)` -- whose every method call is a blocking round
trip to Postgres, and whose type ruff does not know. An `async def` endpoint
that takes a sync Session is wrong before its body says anything, because
FastAPI only moves a handler to the threadpool when it is a plain `def`.

WHAT IT FLAGS, inside the body of an `async def` (nested `def`, `async def`
and `lambda` bodies are excluded: they run wherever they are sent, which is
usually `asyncio.to_thread`, and a nested `async def` is scanned on its own):

  (a) a parameter whose default or `Annotated[...]` metadata is
      `Depends(<dep>)` -- positional or `dependency=` -- where <dep> yields a
      sync Session: `get_db` (under any import alias), plus any generator in
      app/ that calls `SessionLocal()` and yields, found by reading the source
      so a second such dependency cannot slip past. FastAPI's documented
      alias idiom counts too: `DbDep = Annotated[Session, Depends(get_db)]`,
      `DbDep: TypeAlias = ...` and `type DbDep = ...`, declared anywhere in
      app/ and used here by name, by import alias or as `deps.DbDep`;
  (b) a call to `SessionLocal()` -- bare, imported under another name, or as
      `db.SessionLocal()`;
  (c) a sync-Session method (`execute`, `query`, `commit`, ...) on a name that
      is such a parameter, a parameter annotated `Session`, or a name bound
      from `SessionLocal()` (assignment or `with ... as`);
  (d) `open()`, `Path.read_text/read_bytes/write_text/write_bytes`;
  (e) `time.sleep`, anything on `requests`, `subprocess.run/Popen/...`,
      `boto3.client/resource/Session`;
  (f) any sync top-level function of `document_store`, `document_manifest`
      or `mail_transport` -- the file and mail choke points, read from those
      modules so a new helper is covered the day it is written.

A call is fine when it is HANDED to `asyncio.to_thread`, `anyio.to_thread`,
`run_in_threadpool` or an executor rather than made: `to_thread(save_bytes,
...)` names the function and calls nothing, so it is never reported. An
AWAITED call is not reported either -- `await anyio.Path(p).read_text()` is
the async twin of the pathlib call, and anything awaited returned an
awaitable rather than blocking.

EXCEPT A Depends(get_db) PARAMETER, WHICH NO HANDOFF EXCUSES, and that is a
decision rather than a gap. `async def f(db=Depends(get_db))` with every query
inside `run_in_threadpool(lambda: db.execute(...))` is still reported: the
Session was opened by the dependency on the loop's side, its teardown
(`db.close()`, a network round trip) runs on the loop, and a Session handed to
a pool thread is shared across threads with nothing serialising it. The fix
is the one /register took -- a plain `def`, which FastAPI runs whole on the
threadpool, Session and all -- and a rule that let the lambda form through
would bless the half-measure.

DELIBERATELY NOT CLEVER. It does not follow calls into helpers (an `async def`
calling a sync function of its own that opens a Session is not reported) and
it does not know types beyond the names above. It catches the shape people
actually write -- a copied endpoint with `async` in front -- and says nothing
it cannot back with a line number. A guard that cries wolf is a guard that
gets deleted.

KNOWN is a RATCHET, IN BOTH DIRECTIONS (`check_style_duplicates.py`'s rule).
Every function in it is a true positive that was already on main when this
check was written, with the reason it has not been changed yet AND the exact
findings it had then. A new offender fails the build; so does a known one
that grew a blocking call (a function on the list is not a licence to add
`requests.get` to it); so does an entry whose findings shrank or vanished,
because a list that names fixed code stops telling the truth. Fix one, update
or strike its entry in the same commit.

No imports of `app`: this reads source, runs in well under a second, and works
on a machine with no database and no dependencies installed.

    python3 tools/ci/check_async_blocking.py
"""

from __future__ import annotations

import ast
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "apps" / "api-py" / "app"

#: Methods of a sync `sqlalchemy.orm.Session` that reach the database (or the
#: identity map under a lock the threadpool shares). `add` is in the set: it is
#: cheap by itself, but an `async def` that adds is about to flush.
SESSION_METHODS = frozenset(
    {
        "execute", "query", "commit", "flush", "get", "scalar", "scalars",
        "refresh", "rollback", "merge", "add", "add_all", "delete", "close",
    }
)

#: `Path` I/O by method name. These names are pathlib's; nothing else in app/
#: uses them for anything that is not a file.
PATH_IO_METHODS = frozenset({"read_text", "read_bytes", "write_text", "write_bytes"})

#: module -> attributes that block (None means every attribute does).
BLOCKING_MODULE_CALLS: dict[str, frozenset[str] | None] = {
    "time": frozenset({"sleep"}),
    "requests": None,
    "subprocess": frozenset(
        {"run", "call", "check_call", "check_output", "Popen", "getoutput", "getstatusoutput"}
    ),
    "boto3": frozenset({"client", "resource", "Session"}),
}

#: REEP's own sync choke points. Their sync top-level functions are read from
#: the source at run time, so the list never has to be kept by hand.
BLOCKING_APP_MODULES = ("document_store", "document_manifest", "mail_transport")

#: The dependency that yields a sync Session by name; generators that call
#: SessionLocal() and yield are added to it by reading app/.
SYNC_SESSION_DEPENDENCIES = frozenset({"get_db"})

@dataclass(frozen=True)
class Known:
    """Why a known offender is still `async def`, and what it was caught doing.

    `findings` is the multiset of `Finding.what` strings, without line numbers
    so an unrelated edit above the function does not move the pin."""

    reason: str
    findings: tuple[str, ...]


_DB_PARAM = "parameter `db` is Depends(get_db), a sync Session"

#: True positives that were on main when this check was written. Key:
#: "<path under app/>::<qualified name>".
KNOWN: dict[str, Known] = {
    "routers/admin_imports.py::preview_import": Known(
        "The registration incident's exact shape: Depends(get_db) plus an"
        " openpyxl parse of the upload, all on the loop. It awaits"
        " UploadFile.read(MAX+1) for its size cap, so turning it into a plain"
        " def means rewriting that read against file.file -- a change to the"
        " upload path that wants its own commit and its own concurrency test,"
        " as registration's did. Main Admin only, so the blast radius is one"
        " office clerk's import stalling other requests, not a cohort.",
        (
            _DB_PARAM,
            "calls db.get() on a sync Session",
            "calls db.add() on a sync Session",
            "calls db.flush() on a sync Session",
            "calls db.commit() on a sync Session",
            "calls db.add() on a sync Session",
            "calls db.commit() on a sync Session",
            "calls db.refresh() on a sync Session",
        ),
    ),
    "voice_platform/api/admin.py::bulk_candidates": Known(
        "Depends(get_db) and a bulk insert on the loop. Same fix as"
        " preview_import (an awaited UploadFile.read), same reason it is not"
        " made here; Main Admin only.",
        (_DB_PARAM, "calls db.commit() on a sync Session"),
    ),
    "voice_platform/api/calls.py::close_call": Known(
        "Depends(get_db) for a primary-key read and a refresh, then db.close()"
        " before the real work, which finish_call already does through"
        " asyncio.to_thread. Two short queries on the loop; it stays async"
        " because it awaits the live buffer's aclose().",
        (_DB_PARAM, "calls db.refresh() on a sync Session", "calls db.close() on a sync Session"),
    ),
}


@dataclass(frozen=True)
class Finding:
    path: str
    qualname: str
    line: int
    what: str

    @property
    def key(self) -> str:
        return f"{self.path}::{self.qualname}"


def _dotted(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def _depends_target(node: ast.expr | None) -> str | None:
    """`Depends(get_db)` -> "get_db"; anything else -> None."""
    if not isinstance(node, ast.Call):
        return None
    name = _dotted(node.func)
    if name is None or name.rsplit(".", 1)[-1] != "Depends":
        return None
    arg = node.args[0] if node.args else next(
        (k.value for k in node.keywords if k.arg == "dependency"), None
    )
    target = _dotted(arg) if arg is not None else None
    return target.rsplit(".", 1)[-1] if target else None


def _original(name: str, imports: _Imports) -> str:
    """The name a local binding was imported AS FROM: `from ..db import get_db
    as database` makes "database" mean "get_db". Unimported names are themselves."""
    origin = imports.names.get(name)
    return origin[1] if origin else name


def _is_session_local(func: ast.expr, imports: _Imports) -> bool:
    """`SessionLocal`, `db.SessionLocal`, or `SL` after `import SessionLocal as SL`."""
    if isinstance(func, ast.Name):
        return _original(func.id, imports) == "SessionLocal"
    return isinstance(func, ast.Attribute) and func.attr == "SessionLocal"


def _annotation_expr(node: ast.expr | None) -> ast.expr | None:
    """A quoted annotation ("DbDep") is parsed; anything else is returned as is."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            return ast.parse(node.value, mode="eval").body
        except SyntaxError:
            return None
    return node


def session_aliases_of(source: str, session_deps: frozenset[str]) -> dict[str, str]:
    """Module-level aliases whose Annotated metadata is Depends(<a session dep>):
    `X = Annotated[...]`, `X: TypeAlias = Annotated[...]` and PEP 695's
    `type X = Annotated[...]`. Alias name -> the dependency it carries."""
    tree = ast.parse(source)
    imports = _Imports()
    imports.visit(tree)
    found: dict[str, str] = {}
    for node in tree.body:
        name: str | None = None
        value: ast.expr | None = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name, value = node.targets[0].id, node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name, value = node.target.id, node.value
        elif isinstance(node, ast.TypeAlias) and isinstance(node.name, ast.Name):
            name, value = node.name.id, node.value
        dep = _annotated_depends(value)
        if name and dep and _original(dep, imports) in session_deps:
            found[name] = _original(dep, imports)
    return found


def sync_functions_of(source: str) -> frozenset[str]:
    """The top-level plain `def` names a module defines."""
    tree = ast.parse(source)
    return frozenset(n.name for n in tree.body if isinstance(n, ast.FunctionDef))


def session_dependencies_of(source: str) -> frozenset[str]:
    """Generator functions that call SessionLocal() and yield: FastAPI
    dependencies that hand a sync Session to whoever names them."""
    found: set[str] = set()
    tree = ast.parse(source)
    imports = _Imports()
    imports.visit(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        calls_session = any(
            isinstance(n, ast.Call) and _is_session_local(n.func, imports) for n in ast.walk(node)
        )
        yields = any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in ast.walk(node))
        if calls_session and yields:
            found.add(node.name)
    return frozenset(found)


class _Imports(ast.NodeVisitor):
    """Local name -> (module, attribute or None), over the whole module,
    function-local imports included: REEP imports boto3 and friends lazily."""

    def __init__(self) -> None:
        self.modules: dict[str, str] = {}
        self.names: dict[str, tuple[str, str]] = {}

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            local = alias.asname or alias.name.split(".")[0]
            self.modules[local] = alias.name.rsplit(".", 1)[-1] if alias.asname else alias.name.split(".")[0]

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = (node.module or "").rsplit(".", 1)[-1]
        for alias in node.names:
            local = alias.asname or alias.name
            if module:
                self.names[local] = (module, alias.name)
            # `from . import document_store` / `from app import document_store`
            # binds a MODULE, and its attributes are what gets called.
            if alias.name in BLOCKING_MODULE_CALLS or alias.name in BLOCKING_APP_MODULES:
                self.modules[local] = alias.name


def _blocking_call(
    call: ast.Call,
    imports: _Imports,
    session_names: set[str],
    app_module_funcs: dict[str, frozenset[str]],
) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        name = func.id
        if _is_session_local(func, imports):
            return "SessionLocal()"
        if name == "open":
            return "open()"
        origin = imports.names.get(name)
        if origin:
            module, attr = origin
            if module in BLOCKING_MODULE_CALLS:
                allowed = BLOCKING_MODULE_CALLS[module]
                if allowed is None or attr in allowed:
                    return f"{module}.{attr}()"
            if attr in app_module_funcs.get(module, frozenset()):
                return f"{module}.{attr}()"
        return None
    if not isinstance(func, ast.Attribute):
        return None
    attr = func.attr
    if attr == "SessionLocal":
        return "SessionLocal()"
    if attr in PATH_IO_METHODS:
        return f".{attr}()"
    if isinstance(func.value, ast.Name):
        base = func.value.id
        if base in session_names and attr in SESSION_METHODS:
            return f"{base}.{attr}() on a sync Session"
        # Through the file's imports only: a local list called `requests` is
        # not the requests library, and `requests.append()` blocks nothing.
        module = imports.modules.get(base)
        if module in BLOCKING_MODULE_CALLS:
            allowed = BLOCKING_MODULE_CALLS[module]
            if allowed is None or attr in allowed:
                return f"{module}.{attr}()"
        if module in app_module_funcs and attr in app_module_funcs[module]:
            return f"{module}.{attr}()"
        if base == "io" and attr == "open":
            return "io.open()"
    return None


def _is_session_annotation(node: ast.expr | None) -> bool:
    name = _dotted(node) if node is not None else None
    return name is not None and name.rsplit(".", 1)[-1] == "Session"


def _annotated_depends(node: ast.expr | None) -> str | None:
    """`Annotated[Session, Depends(get_db)]` -> "get_db"."""
    if isinstance(node, ast.Subscript) and _dotted(node.value) in ("Annotated", "typing.Annotated"):
        elts = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        for elt in elts[1:]:
            target = _depends_target(elt)
            if target:
                return target
    return None


def _own_body(fn: ast.AsyncFunctionDef):
    """Every node in fn's body, not descending into nested functions/lambdas."""
    nested = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
    stack: list[ast.AST] = [n for n in fn.body if not isinstance(n, nested)]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(c for c in ast.iter_child_nodes(node) if not isinstance(c, nested))


def scan_source(
    source: str,
    path: str,
    *,
    session_deps: frozenset[str] = SYNC_SESSION_DEPENDENCIES,
    app_module_funcs: dict[str, frozenset[str]] | None = None,
    session_aliases: dict[str, str] | None = None,
) -> list[Finding]:
    """Every blocking finding in one module's async defs."""
    tree = ast.parse(source, filename=path)
    imports = _Imports()
    imports.visit(tree)
    funcs = app_module_funcs or {}
    # This module's own aliases count even when the caller passed none.
    aliases = {**session_aliases_of(source, session_deps), **(session_aliases or {})}

    def _param_dependency(arg: ast.arg, default: ast.expr | None) -> str | None:
        dep = _depends_target(default)
        annotation = _annotation_expr(arg.annotation)
        dep = dep or _annotated_depends(annotation)
        if dep is None and annotation is not None:
            alias = (
                _original(annotation.id, imports)
                if isinstance(annotation, ast.Name)
                else annotation.attr if isinstance(annotation, ast.Attribute) else None
            )
            dep = aliases.get(alias) if alias else None
        return _original(dep, imports) if dep else None
    findings: list[Finding] = []

    def visit(node: ast.AST, scope: list[str]) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                inner = [*scope, child.name]
                if isinstance(child, ast.AsyncFunctionDef):
                    findings.extend(_scan_async(child, ".".join(inner)))
                visit(child, inner)
            else:
                visit(child, scope)

    def _scan_async(fn: ast.AsyncFunctionDef, qualname: str) -> list[Finding]:
        out: list[Finding] = []
        session_names: set[str] = set()
        args = fn.args
        positional = [*args.posonlyargs, *args.args]
        defaults: list[ast.expr | None] = [None] * (len(positional) - len(args.defaults))
        defaults += list(args.defaults)
        pairs = list(zip(positional, defaults, strict=True))
        pairs += list(zip(args.kwonlyargs, args.kw_defaults, strict=True))
        for arg, default in pairs:
            dep = _param_dependency(arg, default)
            if dep in session_deps:
                out.append(
                    Finding(path, qualname, arg.lineno, f"parameter `{arg.arg}` is Depends({dep}), a sync Session")
                )
                session_names.add(arg.arg)
            elif _is_session_annotation(arg.annotation):
                session_names.add(arg.arg)
        body = list(_own_body(fn))
        for node in body:  # names bound from SessionLocal() anywhere in the body
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                if _is_session_local(node.value.func, imports):
                    session_names.update(t.id for t in node.targets if isinstance(t, ast.Name))
            if isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    ctx = item.context_expr
                    if (
                        isinstance(ctx, ast.Call)
                        and _is_session_local(ctx.func, imports)
                        and isinstance(item.optional_vars, ast.Name)
                    ):
                        session_names.add(item.optional_vars.id)
        # An awaited call returned an awaitable; it did not block the loop.
        awaited = {id(n.value) for n in body if isinstance(n, ast.Await)}
        for node in body:
            if isinstance(node, ast.Call) and id(node) not in awaited:
                what = _blocking_call(node, imports, session_names, funcs)
                if what:
                    out.append(Finding(path, qualname, node.lineno, f"calls {what}"))
        return out

    visit(tree, [])
    return findings


def scan_tree(app: Path = APP) -> list[Finding]:
    if not app.is_dir():
        raise SystemExit(f"check_async_blocking: {app} does not exist; nothing was checked.")
    sources = {p: p.read_text(encoding="utf-8") for p in sorted(app.rglob("*.py"))}
    session_deps = set(SYNC_SESSION_DEPENDENCIES)
    for src in sources.values():
        session_deps |= session_dependencies_of(src)
    app_module_funcs: dict[str, frozenset[str]] = {}
    for module in BLOCKING_APP_MODULES:
        path = app / f"{module}.py"
        if not path.is_file():
            # The list names a module that is gone: fail loudly rather than
            # quietly check less than the docstring promises.
            raise SystemExit(f"check_async_blocking: {path} is missing; update BLOCKING_APP_MODULES.")
        app_module_funcs[module] = sync_functions_of(sources[path])
    # FastAPI's `DbDep = Annotated[Session, Depends(get_db)]` idiom: declared
    # once, usually in a deps module, and imported everywhere it is used.
    session_aliases: dict[str, str] = {}
    for src in sources.values():
        session_aliases.update(session_aliases_of(src, frozenset(session_deps)))
    findings: list[Finding] = []
    for path, src in sources.items():
        # A file that does not parse is NOT skipped: a check that did not run
        # is never a pass. ast.parse raises and the build fails with the name.
        findings.extend(
            scan_source(
                src,
                path.relative_to(app).as_posix(),
                session_deps=frozenset(session_deps),
                app_module_funcs=app_module_funcs,
                session_aliases=session_aliases,
            )
        )
    return findings


def main() -> int:
    findings = scan_tree()
    by_key: dict[str, list[Finding]] = {}
    for f in findings:
        by_key.setdefault(f.key, []).append(f)

    new = sorted(set(by_key) - set(KNOWN))
    stale = sorted(set(KNOWN) - set(by_key))
    # A known offender is pinned to the findings it had: one that GREW a
    # blocking call is reported as new work, one that lost some must have its
    # pin updated so the entry keeps describing the code.
    drifted = sorted(
        key
        for key in set(KNOWN) & set(by_key)
        if Counter(f.what for f in by_key[key]) != Counter(KNOWN[key].findings)
    )
    if not new and not stale and not drifted:
        print(
            f"check_async_blocking: no new blocking calls in async defs under app/ "
            f"({len(KNOWN)} known, each with its reason in this file)."
        )
        return 0
    if new:
        print(
            "An `async def` under apps/api-py/app does blocking work on the event loop.\n"
            "While it runs, nothing else in that process is served -- this is how\n"
            "/register returned 504s on 2026-09-29. Do one of these instead:\n"
            "  * make it a plain `def` (FastAPI runs those on the threadpool) -- the\n"
            "    right answer for an endpoint that takes Depends(get_db);\n"
            "  * hand the blocking call to `await asyncio.to_thread(fn, ...)` or\n"
            "    `await run_in_threadpool(fn, ...)` -- the right answer inside a\n"
            "    genuinely async function such as the interview relay.\n",
            file=sys.stderr,
        )
        for key in new:
            for f in by_key[key]:
                print(f"  app/{f.path}:{f.line}: {f.qualname}: {f.what}", file=sys.stderr)
    if drifted:
        print(
            "\nA function in KNOWN no longer does exactly what its entry pins. If it\n"
            "gained a blocking call, move that work off the loop; if it lost one,\n"
            "update `findings` in KNOWN to what it does now:\n",
            file=sys.stderr,
        )
        for key in drifted:
            now = Counter(f.what for f in by_key[key])
            pinned = Counter(KNOWN[key].findings)
            for what in sorted((now - pinned).elements()):
                print(f"  {key}: NEW      {what}", file=sys.stderr)
            for what in sorted((pinned - now).elements()):
                print(f"  {key}: GONE     {what}", file=sys.stderr)
    if stale:
        print(
            "\nThese are in KNOWN but no longer block. Delete them from the dict in\n"
            "tools/ci/check_async_blocking.py so it keeps telling the truth:\n",
            file=sys.stderr,
        )
        for key in stale:
            print(f"  {key}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
