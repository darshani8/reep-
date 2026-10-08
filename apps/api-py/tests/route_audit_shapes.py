"""Synthetic handler shapes for the route audit's self-tests.

Each function here is a HANDLER BODY the audit must judge correctly; none is
mounted on any router. They live in a module of their own because the audit
reads source with `inspect.getsource` and resolves calls through the module's
globals, so the shapes need real imports of the real gates. The names say the
expected verdict: `gated_*` must count as gated, `ungated_*` must not.

The `ungated_*` shapes are the unit tester's reproductions (DEF-QG-U01,
DEF-QG-U02, 2026-10-08): each one let a STUDENT through with a 200 while the
audit called it gated.
"""

from __future__ import annotations

import contextlib
import typing
from contextlib import suppress

import fastapi.exceptions
import starlette.exceptions
from fastapi import HTTPException, WebSocket
from fastapi import HTTPException as HE
from pydantic import BaseModel, RootModel

from app.identity import get_ws_session
from app.routers.interview_records import _may_see_raw_response
from app.routers.mentor import require_admin

# --- a refusal that is caught -------------------------------------------------


def ungated_caught_http(session: dict) -> int:
    try:
        require_admin(session)
    except HTTPException:
        pass
    return 1


def ungated_caught_exception(session: dict) -> int:
    try:
        require_admin(session)
    except Exception:
        return 0
    return 1


def ungated_caught_bare(session: dict) -> int:
    try:
        require_admin(session)
    except:  # noqa: S110 — a swallowed refusal is the shape under test
        pass
    return 1


def ungated_caught_in_tuple(session: dict) -> int:
    try:
        require_admin(session)
    except (ValueError, HTTPException):
        pass
    return 1


def ungated_predicate_helper(session: dict) -> int:
    # The real helper: it calls require_admin and turns the 403 into False.
    return int(_may_see_raw_response(session))


def ungated_inline_raise_caught(session: dict) -> int:
    try:
        if session.get("role") != "ADMIN":
            raise HTTPException(status_code=403)
    except HTTPException:
        pass
    return 1


def gated_caught_and_reraised(session: dict) -> int:
    try:
        require_admin(session)
    except HTTPException:
        raise
    return 1


def gated_caught_something_else(session: dict) -> int:
    try:
        require_admin(session)
    except ValueError:
        pass
    return 1


def gated_finally_still_runs(session: dict) -> int:
    try:
        pass
    except HTTPException:
        pass
    finally:
        require_admin(session)
    return 1


# --- swallowed by another spelling (DEF-QG-U08) --------------------------------


def ungated_suppress_http(session: dict) -> int:
    with contextlib.suppress(HTTPException):
        require_admin(session)
    return 1


def ungated_suppress_exception_imported(session: dict) -> int:
    with suppress(Exception):
        require_admin(session)
    return 1


def ungated_caught_starlette_qualified(session: dict) -> int:
    try:
        require_admin(session)
    except starlette.exceptions.HTTPException:
        return 0
    return 1


def ungated_caught_fastapi_qualified(session: dict) -> int:
    try:
        require_admin(session)
    except fastapi.exceptions.HTTPException:
        return 0
    return 1


def ungated_caught_alias(session: dict) -> int:
    try:
        require_admin(session)
    except HE:
        return 0
    return 1


def gated_suppress_something_else(session: dict) -> int:
    with suppress(KeyError):
        require_admin(session)
    return 1


def gated_ordinary_with(session: dict) -> int:
    with open(__file__, encoding="utf-8"):
        require_admin(session)
    return 1


# --- nested functions (DEF-QG-U09) ---------------------------------------------


def ungated_nested_def_never_called(session: dict) -> int:
    def check() -> None:
        require_admin(session)

    return 1


def ungated_lambda_never_called(session: dict) -> int:
    check = lambda: require_admin(session)  # noqa: E731 — the shape under test
    return 1 if check else 0


def ungated_nested_def_called_only_when_swallowed(session: dict) -> int:
    def check() -> None:
        require_admin(session)

    with suppress(HTTPException):
        check()
    return 1


def gated_nested_def_called(session: dict) -> int:
    def check() -> None:
        require_admin(session)

    check()
    return 1


def gated_lambda_called(session: dict) -> int:
    check = lambda: require_admin(session)  # noqa: E731 — the shape under test
    check()
    return 1


def gated_lambda_called_in_place(session: dict) -> int:
    (lambda: require_admin(session))()
    return 1


# --- dead code ---------------------------------------------------------------


def ungated_after_return(session: dict) -> int:
    return 1
    require_admin(session)


def ungated_after_raise(session: dict) -> int:
    raise RuntimeError("never gated")
    require_admin(session)


def ungated_if_not_true(session: dict) -> int:
    if not True:
        require_admin(session)
    return 1


def ungated_if_constant_and(session: dict) -> int:
    if True and 0:
        require_admin(session)
    return 1


def ungated_while_false(session: dict) -> int:
    while False:
        require_admin(session)
    return 1


def gated_if_not_false(session: dict) -> int:
    if not False:
        require_admin(session)
    return 1


def gated_while_real(session: dict) -> int:
    while session:
        require_admin(session)
        break
    return 1


def gated_return_in_a_branch_only(session: dict) -> int:
    if session.get("x"):
        return 0
    require_admin(session)
    return 1


# --- WebSocket ---------------------------------------------------------------


async def ws_ungated_swallowed(websocket: WebSocket) -> None:
    try:
        get_ws_session(websocket)
    except Exception:  # noqa: S110 — a swallowed refusal is the shape under test
        pass


async def ws_ungated_dead(websocket: WebSocket) -> None:
    return
    get_ws_session(websocket)


# --- response models -----------------------------------------------------------


class _ItemOut(BaseModel):
    name: str


UntypedRoot = RootModel[dict[str, typing.Any]]
TypedRoot = RootModel[list[_ItemOut]]
