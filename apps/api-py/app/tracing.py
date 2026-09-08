"""Sentry tracing for the whole application.

`sentry_sdk` is initialised once in app/main.py when SENTRY_DSN is set; every
call below is a no-op otherwise (the SDK's own contract), so a laptop and CI pay
nothing and no caller needs to check first.

WHAT THE FastAPI INTEGRATION ALREADY DOES, so this is not duplicated: it traces
HTTP requests, and it CONTINUES a trace the browser started — apps/web sets
`tracePropagationTargets` scoped to /api, so a click in Angular and the request it
causes are one trace already.

WHAT IT DOES NOT SEE, which is what these helpers are for:
  * a WebSocket's lifetime. `/api/interview` holds a socket for up to eight
    minutes and is the most complex path in the system; to the HTTP integration
    it is a single upgrade request that never returns.
  * the calls made INSIDE a request — Bedrock, the LLM adapter, the knowledge
    base, S3, SQS, DynamoDB. Those are where the latency and the failures are.

LIVES AT THE APP ROOT ON PURPOSE. It began under app/voice_platform/monitoring/,
which meant the core interview path could only trace itself by importing a
feature subpackage — a dependency pointing the wrong way. That module is now a
re-export of this one, so its existing callers are unchanged.

NOTHING HERE RECORDS STUDENT TEXT. Spans carry names, counts, durations and
identifiers; `sentry_sdk.init` sets include_local_variables=False and
max_request_body_size="never" for the same reason (see app/main.py, and
tests/test_codebase_guards.py for the guard). Rule 1 does not stop at the model
adapter — Sentry is off the account too.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from typing import Any

import sentry_sdk


def enabled() -> bool:
    try:
        return bool(sentry_sdk.is_initialized())
    except Exception:  # noqa: BLE001 - never let observability raise
        return False


@contextmanager
def transaction(name: str, *, op: str = "websocket.server", **tags: Any) -> Iterator[Any]:
    """A root transaction for one WebSocket connection (or one worker cycle)."""
    if not enabled():
        yield None
        return
    with sentry_sdk.start_transaction(name=name, op=op) as tx:
        for key, value in tags.items():
            tx.set_tag(key, str(value))
        yield tx


def span(op: str, description: str | None = None, **data: Any) -> Any:
    """A child span around one external call: `with span("aws.s3", "put_object")`."""
    if not enabled():
        return nullcontext()
    ctx = sentry_sdk.start_span(op=op, name=description or op)
    for key, value in data.items():
        try:
            ctx.set_data(key, value)
        except Exception:  # noqa: BLE001
            pass
    return ctx


def tag_connection(**tags: Any) -> None:
    """Attach conn/session/degree tags to whatever Sentry captures next."""
    if not enabled():
        return
    for key, value in tags.items():
        sentry_sdk.set_tag(key, str(value))


def capture(exc: BaseException, **tags: Any) -> None:
    if not enabled():
        return
    with sentry_sdk.new_scope() as scope:
        for key, value in tags.items():
            scope.set_tag(key, str(value))
        sentry_sdk.capture_exception(exc)
