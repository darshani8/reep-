"""Sentry distributed tracing across the platform's external calls and
WebSocket connections.

`sentry_sdk` is initialised once in app/main.py when SENTRY_DSN is set; every
call below is a no-op otherwise (the SDK's own contract), so a laptop and CI
pay nothing. The FastAPI integration already traces HTTP requests; what it
does NOT see is a WebSocket's lifetime or the S3/SQS/DynamoDB/OpenSearch/
Bedrock calls made inside it — those are what `transaction` and `span` wrap.
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
