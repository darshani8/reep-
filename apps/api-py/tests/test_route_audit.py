"""The route audit: every operation the API serves, checked against the rules a
reviewer would otherwise have to remember.

WHY THIS IS A TEST AND NOT A LINT. Every rule below is a property of the
ASSEMBLED application — which router was included under which prefix, which
dependencies the include added, what FastAPI inferred from a return annotation.
None of that is visible from one file, so a per-file linter cannot ask it, and a
reviewer reading one router's diff cannot see that the include that mounts it
lost its prefix. `app.main.app` can.

WHAT IT CHECKS, one test per rule:

  * AUTH       every operation needs a session (`get_current_session` somewhere
               in its dependency tree), or is in `PUBLIC` with the reason it may
               be called by anybody. Stricter: every authenticated handler calls
               a named role or scope gate, or REFUSES on an inline role
               comparison, or is in `KNOWN_UNGATED` with the reason a session
               alone is the whole answer.
  * WEBSOCKET  every socket authenticates from the cookie in its own body
               (`get_ws_session`), because a WebSocket dependency cannot answer
               401 — see `app/identity.py`.
  * RESPONSE   every JSON operation declares a typed response model — no bare
               dict, Mapping, Any or object anywhere in it — and none of them is
               a SQLAlchemy model: a DB row returned as-is ships every column it
               will ever grow, including the ones added next year.
  * STATUS     a 204 has no body; a DELETE answers 204 or a body model; a POST
               to a collection answers 201.
  * PAGINATION a GET returning a bare list accepts a bounded page size plus an
               offset/cursor, or is recorded as bounded by construction
               (`BOUNDED`) or as a known gap (`KNOWN_UNPAGINATED`).

THE EXCEPTION LISTS RATCHET IN BOTH DIRECTIONS (`route_audit_exceptions.py`). A
new violation fails with the fix. An entry that no longer violates — fixed, or
the route is gone — fails too, with "strike it off", because a list that only
grows is how an exception outlives the reason it was granted. Every entry also
names the HANDLER it was granted to: a different function mounted at a listed
(method, path) does not inherit the exception, it fails as new.

WHAT IT CANNOT PROVE, said once here so nobody reads more into a green run. The
gate check is static: it proves a gate is CALLED on some path through the
handler, or that the handler refuses on a role comparison — not that the gate
is the right one for the data, and not that every branch reaches it. Rule 2's
own tests (`test_mentee_records.py`, `test_no_director_privilege.py`) still
carry that.

NO DATABASE. This imports the app and reads it; it is part of the plain pytest
run and needs nothing but the import to work.
"""

from __future__ import annotations

import ast
import collections.abc
import inspect
import re
import textwrap
import types
import typing
from dataclasses import dataclass

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute, iter_route_contexts
from starlette.responses import Response

from app.db import Base
from app.main import app
from tests import route_audit_exceptions as ex

# --------------------------------------------------------------------------- #
# The inventory
# --------------------------------------------------------------------------- #

# A broken walk must not pass vacuously. AGENTS.md records the trap: FastAPI
# 0.141 keeps included routers as nested `_IncludedRouter` objects, so a flat
# walk of `app.routes` finds the four documentation routes and NOTHING else —
# every rule below would then hold over an empty set. 376 HTTP operations and
# 3 sockets on 2026-10-08; the floor is well under that so deleting a router is
# not a test failure, and well over the four a broken walk returns.
MIN_HTTP_OPERATIONS = 300
MIN_WEBSOCKETS = 2

# Starlette routes FastAPI mounts for itself. Gated by `settings.docs_exposed`
# in app/main.py (dev only), and they carry no handler of ours to audit.
DOCUMENTATION_ROUTES = frozenset({"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"})

# Operations whose handler is NOT ours, by top-level package. The dev MCP
# surface (`app/dev_mcp.py`) mounts `fastapi_mcp`'s own routes at /mcp, and only
# when `settings.mcp_enabled` — an ENV allowlist AND the explicit
# MCP_DEV_SURFACE flag, which docs/redesign-2026-09/MCP-SETUP.md tells a
# developer to put in their .env. Its access control is its own (it forwards
# the caller's cookie to the GET routes this audit already checks), so auditing
# its handlers would fail every developer who followed the setup guide and
# prove nothing about REEP. An allowlist and not "anything outside app.": a
# third-party decorator that hid one of OUR handlers behind its own module
# would otherwise make that handler silently unaudited.
FOREIGN_HANDLER_PACKAGES = {
    "fastapi_mcp": "the dev-only MCP surface; mounted only when settings.mcp_enabled",
}


@dataclass(frozen=True)
class Operation:
    method: str
    path: str
    route: typing.Any  # the effective route context: prefix, deps and inferred model applied

    @property
    def key(self) -> tuple[str, str]:
        return (self.method, self.path)

    @property
    def endpoint(self):
        return inspect.unwrap(self.route.original_route.endpoint)

    @property
    def where(self) -> str:
        fn = self.endpoint
        return f"{fn.__module__}.{fn.__qualname__}"


def _contexts() -> list:
    return list(iter_route_contexts(app.routes))


def _is_ours(fn) -> bool:
    return getattr(fn, "__module__", "").split(".")[0] == "app"


def _all_http_operations() -> list[Operation]:
    out = []
    for ctx in _contexts():
        if isinstance(ctx.original_route, APIRoute):
            for method in sorted(ctx.methods):
                out.append(Operation(method, ctx.path, ctx))
    return out


ALL_OPERATIONS = _all_http_operations()
OPERATIONS = [op for op in ALL_OPERATIONS if _is_ours(op.endpoint)]
FOREIGN_OPERATIONS = [op for op in ALL_OPERATIONS if not _is_ours(op.endpoint)]


def _websockets() -> list[tuple[str, typing.Any]]:
    out = []
    for ctx in _contexts():
        route = ctx.original_route
        if isinstance(route, APIWebSocketRoute):
            out.append((ctx.starlette_route.path, inspect.unwrap(route.endpoint)))
    return out


WEBSOCKETS = _websockets()


def _independent_walk(routes, prefix: str = "") -> typing.Iterator[tuple[str, str]]:
    """The same inventory, reached WITHOUT `iter_route_contexts`.

    FastAPI's own OpenAPI generator calls `iter_route_contexts` too, so the
    OpenAPI cross-check below is not independent of the walk: a bug in that
    function would drop the same routes from both sides and the comparison would
    still agree. This recurses the included routers' own `.routes` and adds the
    include prefixes itself. It reads FastAPI internals (`original_router`,
    `include_context.prefix`) on purpose; if they are renamed, this fails and
    says so rather than passing over nothing.
    """
    for route in routes:
        nested = getattr(route, "original_router", None)
        if nested is not None:
            yield from _independent_walk(nested.routes, prefix + route.include_context.prefix)
        elif isinstance(route, APIRoute):
            for method in route.methods:
                yield (method, prefix + route.path)
        elif isinstance(route, APIWebSocketRoute):
            yield ("WEBSOCKET", prefix + route.path)


def test_the_inventory_is_the_whole_application() -> None:
    assert len(OPERATIONS) >= MIN_HTTP_OPERATIONS, (
        f"The route walk found {len(OPERATIONS)} HTTP operations; the app has "
        f"hundreds. The walk is broken (FastAPI changed how it nests included "
        f"routers?) and every rule in this module would pass over nothing."
    )
    assert len(WEBSOCKETS) >= MIN_WEBSOCKETS, f"Found {len(WEBSOCKETS)} WebSocket routes."
    keys = [op.key for op in ALL_OPERATIONS]
    assert len(keys) == len(set(keys)), "Two routes claim one (method, path)."

    walked = {op.key for op in ALL_OPERATIONS} | {("WEBSOCKET", path) for path, _ in WEBSOCKETS}
    independent = set(_independent_walk(app.routes))
    assert walked == independent, (
        f"The two walks disagree. Only iter_route_contexts: {sorted(walked - independent)}; "
        f"only the independent walk: {sorted(independent - walked)}."
    )

    # And against the OpenAPI document (hidden routes and foreign ones aside).
    documented = {
        (method.upper(), path)
        for path, item in app.openapi()["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }
    foreign_paths = {op.path for op in FOREIGN_OPERATIONS}
    documented = {(m, p) for m, p in documented if p not in foreign_paths}
    in_schema = {op.key for op in OPERATIONS if op.route.include_in_schema}
    assert in_schema == documented, (
        f"Walked but not in OpenAPI: {sorted(in_schema - documented)}; "
        f"in OpenAPI but not walked: {sorted(documented - in_schema)}."
    )

    stray = sorted(
        getattr(ctx, "path", repr(ctx))
        for ctx in _contexts()
        if not isinstance(ctx.original_route, (APIRoute, APIWebSocketRoute))
        and getattr(ctx, "path", None) not in DOCUMENTATION_ROUTES
    )
    assert not stray, (
        f"Routes this audit cannot read (a Mount? a bare Starlette Route?): {stray}. "
        f"Teach the audit about them rather than letting them go unchecked."
    )


def test_only_allowlisted_foreign_handlers_are_left_out() -> None:
    """The exclusion above can never hide one of OUR routes.

    `_is_ours` keeps every handler defined under `app.`; what it drops must come
    from a package named in FOREIGN_HANDLER_PACKAGES, so an `app` handler that a
    decorator re-homed to some other module fails here instead of vanishing.
    """
    unexpected = sorted(
        f"{op.method} {op.path} ({op.where})"
        for op in FOREIGN_OPERATIONS
        if op.endpoint.__module__.split(".")[0] not in FOREIGN_HANDLER_PACKAGES
    )
    assert not unexpected, (
        f"Handlers outside the app package that this audit would silently skip: "
        f"{unexpected}. Either the handler is ours (use functools.wraps in its "
        f"decorator) or the package is a deliberate mount — add it to "
        f"FOREIGN_HANDLER_PACKAGES with the reason."
    )
    assert all(_is_ours(op.endpoint) for op in OPERATIONS)


# --------------------------------------------------------------------------- #
# Ratchet helper
# --------------------------------------------------------------------------- #


def _ratchet(rule: str, violations: dict, known: dict, fix: str) -> None:
    """Fail on a new violation AND on an exception that no longer applies.

    `violations` is {(method, path): (handler, detail)}; `known` is
    {(method, path): (handler, reason)}. An entry whose handler differs from the
    one now mounted at that path is NOT an exception for it.
    """
    new = sorted(k for k in violations if k not in known or known[k][0] != violations[k][0])
    stale = sorted(k for k in known if k not in violations)
    lines = []
    if new:
        lines.append(f"{rule}: {len(new)} new violation(s). {fix}")
        for key in new:
            handler, detail = violations[key]
            note = f"; the list grants this to {known[key][0]}, not this handler" if key in known else ""
            lines.append(f"  {key[0]} {key[1]}  ({handler}: {detail}{note})")
    if stale:
        lines.append(
            f"{rule}: {len(stale)} exception(s) no longer apply — the route was "
            f"fixed or removed. Strike it off the list in tests/route_audit_exceptions.py:"
        )
        lines += [f"  {m} {p}" for m, p in stale]
    assert not lines, "\n".join(lines)


def _all_exception_lists() -> dict[str, dict]:
    return {
        "PUBLIC": ex.PUBLIC,
        "KNOWN_UNGATED": ex.KNOWN_UNGATED,
        "KNOWN_NO_RESPONSE_MODEL": ex.KNOWN_NO_RESPONSE_MODEL,
        "KNOWN_STATUS": ex.KNOWN_STATUS,
        "BOUNDED": ex.BOUNDED,
        "KNOWN_UNPAGINATED": ex.KNOWN_UNPAGINATED,
    }


@pytest.mark.parametrize("name", sorted(_all_exception_lists()))
def test_every_exception_list_is_sorted_and_says_why(name: str) -> None:
    entries = _all_exception_lists()[name]
    keys = list(entries)
    assert keys == sorted(keys, key=lambda k: (k[1], k[0])), (
        f"{name} must be sorted by (path, method) so a diff shows where an entry went."
    )
    for (method, path), value in entries.items():
        assert method in {"GET", "POST", "PUT", "PATCH", "DELETE"}, (name, method, path)
        assert path.startswith("/"), (name, method, path)
        assert isinstance(value, tuple) and len(value) == 2, (
            f"{name}[{method} {path}] must be (handler, reason)."
        )
        handler, reason = value
        assert handler.startswith("app."), f"{name}[{method} {path}]: {handler!r} is not a handler"
        assert isinstance(reason, str) and len(reason.strip()) >= 15, (
            f"{name}[{method} {path}] needs a one-line reason, not a placeholder."
        )


def test_pagination_lists_do_not_overlap() -> None:
    both = sorted(set(ex.BOUNDED) & set(ex.KNOWN_UNPAGINATED))
    assert not both, f"An endpoint is either bounded or a gap, never both: {both}"


# --------------------------------------------------------------------------- #
# Reading handler source
# --------------------------------------------------------------------------- #


def _qualname(fn) -> str:
    return f"{getattr(fn, '__module__', '?')}.{getattr(fn, '__qualname__', repr(fn))}"


def _source_tree(fn) -> ast.AST | None:
    try:
        return ast.parse(textwrap.dedent(inspect.getsource(fn)))
    except (OSError, TypeError, SyntaxError):
        return None


def _constant_truth(test: ast.expr) -> bool | None:
    """True/False for `if True` / `if 0` and friends; None for a real test."""
    if isinstance(test, ast.Constant):
        return bool(test.value)
    return None


def _live_nodes(node: ast.AST) -> typing.Iterator[ast.AST]:
    """`ast.walk`, minus the branches that can never run.

    `if False: require_admin(session)` is a gate nobody passes through, and it
    must not count as one; likewise the `else` of an `if True`.
    """
    yield node
    if isinstance(node, ast.If):
        truth = _constant_truth(node.test)
        yield from _live_nodes(node.test)
        if truth is not False:
            for child in node.body:
                yield from _live_nodes(child)
        if truth is not True:
            for child in node.orelse:
                yield from _live_nodes(child)
        return
    for child in ast.iter_child_nodes(node):
        yield from _live_nodes(child)


def _resolved_calls(fn) -> list:
    """The app functions `fn` calls on a live branch, resolved through its module's globals."""
    tree = _source_tree(fn)
    if tree is None:
        return []
    names = getattr(fn, "__globals__", {})
    out = []
    for node in _live_nodes(tree):
        if not isinstance(node, ast.Call):
            continue
        target = None
        if isinstance(node.func, ast.Name):
            target = names.get(node.func.id)
        elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            base = names.get(node.func.value.id)
            if isinstance(base, types.ModuleType):
                target = getattr(base, node.func.attr, None)
        if inspect.isfunction(target) and _is_ours(target):
            out.append(inspect.unwrap(target))
    return out


# --------------------------------------------------------------------------- #
# AUTH
# --------------------------------------------------------------------------- #

SESSION_DEPENDENCIES = frozenset({"app.identity.get_current_session"})


def _dependency_calls(dependant) -> list:
    out = []
    for sub in dependant.dependencies:
        out.append(sub.call)
        out.extend(_dependency_calls(sub))
    return out


def _requires_session(op: Operation) -> bool:
    return any(_qualname(call) in SESSION_DEPENDENCIES for call in _dependency_calls(op.route.dependant))


def test_every_operation_requires_a_session_or_is_declared_public() -> None:
    violations = {op.key: (op.where, "no session dependency") for op in OPERATIONS if not _requires_session(op)}
    _ratchet(
        "AUTH (session)",
        violations,
        ex.PUBLIC,
        "Add `session: dict = Depends(get_current_session)` to the handler. If it "
        "really must be callable with no account (sign-in, the public register "
        "form, health), read the handler, then add it to PUBLIC with the reason.",
    )


# The functions that decide WHO may do something. Each one reads the session's
# role (or the student/mentor claim behind it) and raises 401/403/404 — the
# helpers that merely delegate to one of these are found by following calls,
# so they are not listed. Named by module and qualname, never by bare name: a
# module-local function that happens to be called `require_admin` and does not
# gate anything must not count.
GATE_FUNCTIONS = frozenset(
    {
        "app.governance.require_capability",
        "app.policies.assert_student_scope",
        "app.policies.require_role",
        "app.routers.alumni.require_alumni",
        "app.routers.interview_records._own_student_id",
        "app.routers.mentor._assert_can_access_student",
        "app.routers.mentor.require_admin",
        "app.routers.mentor.require_mentor",
        "app.routers.student._require_student",
        "app.routers.student_programme._require_student",
    }
)

# `session.get("role")` or `session["role"]`.
_INLINE_ROLE = re.compile(r"""session(?:\.get\(|\[)\s*["']role["']""")


def _refuses_on_role_inline(fn) -> bool:
    """Does `fn` itself RAISE on a comparison of the session's role?

    The same decision as a gate call, written in place —
    `if session.get("role") != Role.STUDENT.value: raise HTTPException(403, ...)`
    — and a dozen handlers are written that way. A comparison that raises
    nothing is NOT a gate: `is_admin = session.get("role") == "ADMIN"` and the
    nineteen role-predicate helpers in `app/` (`capabilities_for`,
    `_is_rehearsal`, `scope_filter` …) only decide what to show, so a handler
    that calls one of them has not been refused anything.

    `role = session.get("role")` and then `if role != ...: raise` is the same
    check one line apart, so the names the role was bound to count as the role.
    """
    tree = _source_tree(fn)
    if tree is None:
        return False
    live = list(_live_nodes(tree))
    role_names = {
        target.id
        for node in live
        if isinstance(node, ast.Assign) and _INLINE_ROLE.search(ast.unparse(node.value))
        for target in node.targets
        if isinstance(target, ast.Name)
    }

    def mentions_role(test: ast.expr) -> bool:
        if _INLINE_ROLE.search(ast.unparse(test)):
            return True
        return any(isinstance(n, ast.Name) and n.id in role_names for n in ast.walk(test))

    for node in live:
        if not (isinstance(node, ast.If) and _constant_truth(node.test) is None):
            continue
        if not mentions_role(node.test):
            continue
        branches = [*node.body, *node.orelse]
        if any(isinstance(n, ast.Raise) for branch in branches for n in _live_nodes(branch)):
            return True
    return False


_GATE_MEMO: dict = {}


def _reaches_gate(fn, depth: int = 0) -> bool:
    """Does `fn`, or anything it calls inside `app` on a live branch, apply a gate?

    Branch-insensitive beyond dead code: `if x: require_admin(s)` counts. That
    is the limit of a static check and the reason KNOWN_UNGATED is read by a
    human; what it reliably catches is a handler that calls no gate and refuses
    on no role ANYWHERE in its call tree — the shape of a forgotten check.
    """
    if _qualname(fn) in GATE_FUNCTIONS:
        return True
    if fn in _GATE_MEMO:
        return _GATE_MEMO[fn]
    if depth > 6:
        return False
    _GATE_MEMO[fn] = False  # cycle guard
    hit = _refuses_on_role_inline(fn) or any(_reaches_gate(c, depth + 1) for c in _resolved_calls(fn))
    _GATE_MEMO[fn] = hit
    return hit


def _gated(op: Operation) -> bool:
    if _reaches_gate(op.endpoint):
        return True
    return any(
        inspect.isfunction(call) and _qualname(call) not in SESSION_DEPENDENCIES and _reaches_gate(call)
        for call in _dependency_calls(op.route.dependant)
    )


def test_every_authenticated_handler_reaches_a_role_or_scope_gate() -> None:
    violations = {
        op.key: (op.where, "no role or scope gate")
        for op in OPERATIONS
        if _requires_session(op) and not _gated(op)
    }
    _ratchet(
        "AUTH (gate)",
        violations,
        ex.KNOWN_UNGATED,
        "A session proves who is asking, not that they may. Call the gate before "
        "touching data: require_mentor / require_admin / require_capability, "
        "_assert_can_access_student for a student in the path, _require_student "
        "for a student's own screen. If the session alone IS the answer (the "
        "caller's own rows keyed on session['userId']), add it to KNOWN_UNGATED "
        "and say whose rows it reads.",
    )


def test_the_gate_check_can_see_a_gate() -> None:
    """The gate check must not pass because it found nothing to look at."""
    gated = [op for op in OPERATIONS if _requires_session(op) and _gated(op)]
    assert len(gated) > 250, f"Only {len(gated)} handlers reach a gate; the analysis is blind."


def test_every_websocket_authenticates_in_its_body() -> None:
    def reaches_ws_session(fn, depth=0, seen=None) -> bool:
        seen = set() if seen is None else seen
        if fn in seen or depth > 4:
            return False
        seen.add(fn)
        tree = _source_tree(fn)
        if tree and any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "get_ws_session"
            or isinstance(n, ast.Name) and n.id == "get_ws_session"
            for n in _live_nodes(tree)
        ):
            return True
        return any(reaches_ws_session(c, depth + 1, seen) for c in _resolved_calls(fn))

    unauthenticated = sorted(path for path, fn in WEBSOCKETS if not reaches_ws_session(fn))
    assert not unauthenticated, (
        f"WebSocket routes that never read the session cookie: {unauthenticated}. "
        f"Call `get_ws_session(websocket)` (app/identity.py) before accepting."
    )


# --------------------------------------------------------------------------- #
# RESPONSE MODEL
# --------------------------------------------------------------------------- #


def _return_annotation(fn):
    try:
        return typing.get_type_hints(fn).get("return", inspect.Signature.empty)
    except Exception:
        return inspect.signature(fn).return_annotation


def _returns_a_response(op: Operation) -> bool:
    ann = _return_annotation(op.endpoint)
    return inspect.isclass(ann) and issubclass(ann, Response)


def _declared_class(op: Operation):
    cls = op.route.response_class
    return getattr(cls, "value", cls)  # unwrap FastAPI's DefaultPlaceholder


_UNTYPED_MAPPINGS = (dict, collections.abc.Mapping, collections.abc.MutableMapping)


def _untyped_parts(t) -> list[str]:
    """The parts of a declared type that pin no shape.

    Any, object, and a dict/Mapping with no type arguments, anywhere in the type
    — `list[dict]` and `dict[str, Any]` included. A Pydantic model is a leaf and
    is never looked inside: its fields are its own contract. `dict[str, SomeOut]`
    is typed and passes. The point is mypy: annotating `-> dict[str, Any]` makes
    the type checker quiet and the API contract exactly as empty as before.
    """
    if t is typing.Any or t is object:
        return [repr(t)]
    if t in _UNTYPED_MAPPINGS or t is typing.Dict:  # the bare alias is the thing being refused
        return [getattr(t, "__name__", repr(t))]
    origin = typing.get_origin(t)
    args = typing.get_args(t)
    if origin in _UNTYPED_MAPPINGS and not args:
        return [repr(t)]
    return [part for arg in args for part in _untyped_parts(arg)]


def _response_model_problem(op: Operation) -> str | None:
    model = op.route.response_model
    if model is not None:
        untyped = _untyped_parts(model)
        return f"untyped response model ({', '.join(untyped)})" if untyped else None
    if op.route.status_code == 204 or _returns_a_response(op):
        return None
    cls = _declared_class(op)
    if inspect.isclass(cls) and cls.__name__ not in {"JSONResponse", "ORJSONResponse"}:
        return None
    return "JSON body with no response model"


def test_every_json_operation_declares_a_response_model() -> None:
    violations = {}
    for op in OPERATIONS:
        problem = _response_model_problem(op)
        if problem:
            violations[op.key] = (op.where, problem)
    _ratchet(
        "RESPONSE_MODEL",
        violations,
        ex.KNOWN_NO_RESPONSE_MODEL,
        "Declare `response_model=` (or a return annotation) naming a Pydantic "
        "model — not dict, dict[str, Any] or Any, which type-check and pin "
        "nothing. A file, CSV or redirect returns a Response subclass instead.",
    )


def _type_leaves(t) -> typing.Iterator:
    yield t
    for arg in typing.get_args(t):
        yield from _type_leaves(arg)


def test_no_operation_returns_a_database_model() -> None:
    """FastAPI already refuses a bare ORM class as `response_model` at import
    (it is not a Pydantic field type) — tried on 2026-10-08, the app will not
    start. This pins the rest: an ORM class anywhere inside the declared type,
    which a future `arbitrary_types_allowed` model or a looser FastAPI would let
    through, and a reader who wonders whether the rule is enforced at all."""
    leaking = sorted(
        f"{op.method} {op.path} -> {leaf.__name__}"
        for op in OPERATIONS
        if op.route.response_model is not None
        for leaf in _type_leaves(op.route.response_model)
        if inspect.isclass(leaf) and issubclass(leaf, Base)
    )
    assert not leaking, (
        f"These return a SQLAlchemy model: {leaking}. Return a Pydantic `...Out` "
        f"schema built from the row — the row ships every column it will ever grow."
    )


# --------------------------------------------------------------------------- #
# STATUS CODES
# --------------------------------------------------------------------------- #


def _is_collection_post(op: Operation, paths: set[str]) -> bool:
    """A POST that creates something in a collection.

    Two shapes, both cheap and both honest: the path has `/{id}` children (the
    collection is visibly addressable item by item), or its last segment is a
    plural noun (`/assessments`, `/members`). A POST to a singular or verb
    segment (`/request`, `/timesheet`, `/approve`) is NOT judged — telling an
    action from a singleton create needs a human, and a rule that guessed would
    fill KNOWN_STATUS with entries nobody believes.
    """
    last = op.path.rstrip("/").rsplit("/", 1)[-1]
    if last.startswith("{"):
        return False
    if any(p.startswith(op.path + "/{") for p in paths):
        return True
    return last.endswith("s") and not last.endswith("ss") and "." not in last


def _status_problems() -> dict:
    out = {}
    paths = {op.path for op in OPERATIONS}
    for op in OPERATIONS:
        code = op.route.status_code
        if code == 204 and op.route.response_model is not None:
            out[op.key] = (op.where, "204 declares a response model")
        if op.method == "DELETE" and code != 204 and op.route.response_model is None:
            out[op.key] = (op.where, f"DELETE answers {code or 200} with no body model")
        if op.method == "POST" and _is_collection_post(op, paths) and code != 201:
            out[op.key] = (op.where, f"POST to a collection answers {code or 200}, not 201")
    return out


def test_status_codes_follow_the_house_rules() -> None:
    _ratchet(
        "STATUS",
        _status_problems(),
        ex.KNOWN_STATUS,
        "A create answers 201, a body-less answer is 204, a DELETE is 204 or "
        "returns the model it changed. Changing an EXISTING route's code breaks "
        "the Angular client — record it in KNOWN_STATUS instead.",
    )


# --------------------------------------------------------------------------- #
# PAGINATION
# --------------------------------------------------------------------------- #

PAGE_SIZE_PARAMS = frozenset({"limit", "page_size"})
CURSOR_PARAMS = frozenset({"offset", "cursor", "page", "before", "after"})


def _query_params(dependant) -> list:
    out = list(dependant.query_params)
    for sub in dependant.dependencies:
        out.extend(_query_params(sub))
    return out


def _upper_bound(field) -> float | None:
    for meta in getattr(field.field_info, "metadata", []):
        for attr in ("le", "lt"):
            value = getattr(meta, attr, None)
            if value is not None:
                return value
    return None


def _returns_a_list(op: Operation) -> bool:
    # A BARE list only. A model WITH list fields (`/api/admin/exports/history`,
    # `/api/student/mentor-meetings`, ~50 GETs) is not judged: whether its list
    # grows without bound depends on what fills it, which needs reading.
    return typing.get_origin(op.route.response_model) is list


def _is_paginated(op: Operation) -> bool:
    params = {(f.alias or f.name): f for f in _query_params(op.route.dependant)}
    bounded_size = any(
        name in PAGE_SIZE_PARAMS and _upper_bound(field) is not None for name, field in params.items()
    )
    return bounded_size and bool(CURSOR_PARAMS & set(params))


def test_list_reads_are_paginated_or_recorded() -> None:
    violations = {
        op.key: (op.where, "unpaginated list")
        for op in OPERATIONS
        if op.method == "GET" and _returns_a_list(op) and not _is_paginated(op)
    }
    known = {**ex.BOUNDED, **ex.KNOWN_UNPAGINATED}
    _ratchet(
        "PAGINATION",
        violations,
        known,
        "Accept `limit: int = Query(50, ge=1, le=MAX)` plus `offset` (or a cursor). "
        "If the query is capped by construction, read the cap and add it to BOUNDED "
        "naming it; if it is a real gap, KNOWN_UNPAGINATED.",
    )
