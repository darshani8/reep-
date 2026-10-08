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
               be called by anybody. Stricter: every authenticated handler
               reaches a role or scope gate, or is in `KNOWN_UNGATED` with the
               reason a session alone is the whole answer.
  * WEBSOCKET  every socket authenticates from the cookie in its own body
               (`get_ws_session`), because a WebSocket dependency cannot answer
               401 — see `app/identity.py`.
  * RESPONSE   every JSON operation declares a response model, and none of them
               is a SQLAlchemy model: a DB row returned as-is ships every column
               it will ever grow, including the ones added next year.
  * STATUS     a 204 has no body; a DELETE answers 204 or a body model; a POST
               that creates under a collection answers 201.
  * PAGINATION a GET returning a list accepts a bounded page size plus an
               offset/cursor, or is recorded as bounded by construction
               (`BOUNDED`) or as a known gap (`KNOWN_UNPAGINATED`).

THE EXCEPTION LISTS RATCHET IN BOTH DIRECTIONS (`route_audit_exceptions.py`). A
new violation fails with the fix. An entry that no longer violates — fixed, or
the route is gone — fails too, with "strike it off", because a list that only
grows is how an exception outlives the reason it was granted and then quietly
covers the next route mounted at the same path.

NO DATABASE. This imports the app and reads it; it is part of the plain pytest
run and needs nothing but the import to work.
"""

from __future__ import annotations

import ast
import inspect
import re
import textwrap
import types
import typing
from dataclasses import dataclass

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from starlette.responses import Response

from app.db import Base
from app.main import app

from tests import route_audit_exceptions as ex

try:  # FastAPI >= 0.140 keeps included routers nested; this walks them.
    from fastapi.routing import iter_route_contexts as _iter_route_contexts
except ImportError:  # pragma: no cover - older FastAPI flattened app.routes itself
    _iter_route_contexts = None


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


def _contexts():
    if _iter_route_contexts is None:
        return list(app.routes)
    return list(_iter_route_contexts(app.routes))


def _route_of(ctx):
    return getattr(ctx, "original_route", ctx)


def _http_operations() -> list[Operation]:
    out = []
    for ctx in _contexts():
        if isinstance(_route_of(ctx), APIRoute):
            for method in sorted(ctx.methods):
                out.append(Operation(method, ctx.path, ctx))
    return out


def _websockets() -> list[tuple[str, typing.Any]]:
    out = []
    for ctx in _contexts():
        route = _route_of(ctx)
        if isinstance(route, APIWebSocketRoute):
            starlette = getattr(ctx, "starlette_route", None) or route
            out.append((starlette.path, inspect.unwrap(route.endpoint)))
    return out


OPERATIONS = _http_operations()
WEBSOCKETS = _websockets()


def test_the_inventory_is_the_whole_application() -> None:
    assert len(OPERATIONS) >= MIN_HTTP_OPERATIONS, (
        f"The route walk found {len(OPERATIONS)} HTTP operations; the app has "
        f"hundreds. The walk is broken (FastAPI changed how it nests included "
        f"routers?) and every rule in this module would pass over nothing. Fix "
        f"`_contexts()` before trusting any of them."
    )
    assert len(WEBSOCKETS) >= MIN_WEBSOCKETS, f"Found {len(WEBSOCKETS)} WebSocket routes."
    keys = [op.key for op in OPERATIONS]
    assert len(keys) == len(set(keys)), "Two routes claim one (method, path)."

    # Cross-check against the OpenAPI document, which FastAPI builds by its own
    # walk: the two must name exactly the same operations (hidden ones aside).
    documented = {
        (method.upper(), path)
        for path, item in app.openapi()["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }
    walked = {op.key for op in OPERATIONS if op.route.include_in_schema}
    assert walked == documented, (
        f"Walked but not in OpenAPI: {sorted(walked - documented)}; "
        f"in OpenAPI but not walked: {sorted(documented - walked)}."
    )

    stray = sorted(
        getattr(ctx, "path", repr(ctx))
        for ctx in _contexts()
        if not isinstance(_route_of(ctx), (APIRoute, APIWebSocketRoute))
        and getattr(ctx, "path", None) not in DOCUMENTATION_ROUTES
    )
    assert not stray, (
        f"Routes this audit cannot read (a Mount? a bare Starlette Route?): {stray}. "
        f"Teach the audit about them rather than letting them go unchecked."
    )


# --------------------------------------------------------------------------- #
# Ratchet helper
# --------------------------------------------------------------------------- #


def _ratchet(rule: str, violations: dict, known: dict, fix: str) -> None:
    """Fail on a new violation AND on an exception that no longer applies."""
    new = sorted(set(violations) - set(known))
    stale = sorted(set(known) - set(violations))
    lines = []
    if new:
        lines.append(f"{rule}: {len(new)} new violation(s). {fix}")
        lines += [f"  {m} {p}  ({violations[(m, p)]})" for m, p in new]
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
    for (method, path), reason in entries.items():
        assert method in {"GET", "POST", "PUT", "PATCH", "DELETE"}, (name, method, path)
        assert path.startswith("/"), (name, method, path)
        assert isinstance(reason, str) and len(reason.strip()) >= 15, (
            f"{name}[{method} {path}] needs a one-line reason, not a placeholder."
        )


def test_pagination_lists_do_not_overlap() -> None:
    both = sorted(set(ex.BOUNDED) & set(ex.KNOWN_UNPAGINATED))
    assert not both, f"An endpoint is either bounded or a gap, never both: {both}"


# --------------------------------------------------------------------------- #
# AUTH
# --------------------------------------------------------------------------- #

SESSION_DEPENDENCIES = frozenset({"app.identity.get_current_session"})


def _qualname(fn) -> str:
    return f"{getattr(fn, '__module__', '?')}.{getattr(fn, '__qualname__', repr(fn))}"


def _dependency_calls(dependant) -> list:
    out = []
    for sub in dependant.dependencies:
        out.append(sub.call)
        out.extend(_dependency_calls(sub))
    return out


def _requires_session(op: Operation) -> bool:
    return any(_qualname(call) in SESSION_DEPENDENCIES for call in _dependency_calls(op.route.dependant))


def test_every_operation_requires_a_session_or_is_declared_public() -> None:
    violations = {op.key: op.where for op in OPERATIONS if not _requires_session(op)}
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

# An inline `session.get("role") != Role.STUDENT.value` (or `session["role"]`)
# compared and raised on is the same decision written in place. It is accepted
# because a dozen handlers are written that way and every one was read.
_INLINE_ROLE = re.compile(r"""session(?:\.get\(|\[)\s*["']role["']""")


def _source_tree(fn) -> ast.AST | None:
    try:
        return ast.parse(textwrap.dedent(inspect.getsource(fn)))
    except (OSError, TypeError, SyntaxError):
        return None


def _resolved_calls(fn) -> list:
    """The app functions `fn` calls, resolved through its module's globals."""
    tree = _source_tree(fn)
    if tree is None:
        return []
    names = getattr(fn, "__globals__", {})
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        target = None
        if isinstance(node.func, ast.Name):
            target = names.get(node.func.id)
        elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            base = names.get(node.func.value.id)
            if isinstance(base, types.ModuleType):
                target = getattr(base, node.func.attr, None)
        if inspect.isfunction(target) and target.__module__.startswith("app."):
            out.append(inspect.unwrap(target))
    return out


def _compares_role_inline(fn) -> bool:
    tree = _source_tree(fn)
    if tree is None:
        return False
    # `role = session.get("role")` and then `if role != ...` is the same check
    # one line apart, so the names the role was bound to count as the role.
    role_names = {
        target.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign) and _INLINE_ROLE.search(ast.unparse(node.value))
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        if _INLINE_ROLE.search(ast.unparse(node)):
            return True
        if any(isinstance(n, ast.Name) and n.id in role_names for n in ast.walk(node)):
            return True
    return False


_GATE_MEMO: dict = {}


def _reaches_gate(fn, depth: int = 0) -> bool:
    """Does `fn`, or anything it calls inside `app`, apply a gate?

    Branch-insensitive by construction — `if x: require_admin(s)` counts. That
    is the limit of a static check and the reason KNOWN_UNGATED is read by a
    human; what it reliably catches is the handler that never reaches a gate on
    ANY path, which is the shape of every scope bug this repository has had.
    """
    if _qualname(fn) in GATE_FUNCTIONS:
        return True
    if fn in _GATE_MEMO:
        return _GATE_MEMO[fn]
    if depth > 6:
        return False
    _GATE_MEMO[fn] = False  # cycle guard
    hit = _compares_role_inline(fn) or any(_reaches_gate(c, depth + 1) for c in _resolved_calls(fn))
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
    violations = {op.key: op.where for op in OPERATIONS if _requires_session(op) and not _gated(op)}
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
            isinstance(n, ast.Name) and n.id == "get_ws_session" for n in ast.walk(tree)
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


def _response_model_problem(op: Operation) -> str | None:
    model = op.route.response_model
    if model is dict:
        return "bare dict: no schema, nothing pins the shape"
    if model is not None:
        return None
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
            violations[op.key] = f"{op.where}: {problem}"
    _ratchet(
        "RESPONSE_MODEL",
        violations,
        ex.KNOWN_NO_RESPONSE_MODEL,
        "Declare `response_model=` (or a return annotation naming a Pydantic "
        "model). A file, CSV or redirect returns a Response subclass instead.",
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


def _status_problems() -> dict:
    out = {}
    paths = {op.path for op in OPERATIONS}
    for op in OPERATIONS:
        code = op.route.status_code
        if code == 204 and op.route.response_model is not None:
            out[op.key] = f"{op.where}: 204 declares a response model"
        if op.method == "DELETE" and code != 204 and op.route.response_model is None:
            out[op.key] = f"{op.where}: DELETE answers {code or 200} with no body model"
        if op.method == "POST":
            last = op.path.rstrip("/").rsplit("/", 1)[-1]
            is_collection = not last.startswith("{") and any(
                p.startswith(op.path + "/{") for p in paths
            )
            if is_collection and code != 201:
                out[op.key] = f"{op.where}: POST to a collection answers {code or 200}, not 201"
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
    return typing.get_origin(op.route.response_model) is list


def _is_paginated(op: Operation) -> bool:
    params = {(f.alias or f.name): f for f in _query_params(op.route.dependant)}
    bounded_size = any(
        name in PAGE_SIZE_PARAMS and _upper_bound(field) is not None for name, field in params.items()
    )
    return bounded_size and bool(CURSOR_PARAMS & set(params))


def test_list_reads_are_paginated_or_recorded() -> None:
    violations = {
        op.key: op.where
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
