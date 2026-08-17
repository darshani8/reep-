"""DEPRECATED — do not use. Kept only as a tombstone; scheduled for deletion.

Historically this was a local SQLite bank keyed by a client-chosen session_id.
That was the P0: whoever named the session owned the thread. Memory now lives in
Postgres as Conversation/Message rows (app/conversations.py), keyed by a
server-issued conversation_id that only the owning user's session can resolve.

Its docstring then advertised itself as the voice worker's entry point, which is
no longer true: the worker is DB-free and posts turns over HTTP to
POST /api/voice/transcript. It has NO importers anywhere in app/, tests/ or
voice_agent.py.

Why it is a hazard rather than merely dead code: save_message() opened its own
SessionLocal and wrote straight into append_message, bypassing every rule the
routers enforce — the compulsory opening greeting, transcript length limits,
final-only policy, provider dedup, and worker authentication. It was the obvious
place a future out-of-request assistant turn would get written, silently
skipping all of it.

If you need to append a turn:
  * inside a request  -> app.conversations.append_message(db, ...)
  * from the worker   -> POST /api/voice/transcript (policy lives on the server)
"""

from __future__ import annotations

from typing import NoReturn

_REPLACEMENT = (
    "app.memory is deprecated. Use conversations.append_message(db, ...) inside a "
    "request, or POST /api/voice/transcript from an out-of-process worker — those "
    "paths enforce the greeting, length limits, final-only policy, dedup and "
    "worker auth that this module bypassed."
)


def save_message(*_args: object, **_kwargs: object) -> NoReturn:
    """Removed. Raises rather than writing, so a caller finds out at once instead
    of quietly persisting a turn that skipped every policy check."""
    raise NotImplementedError(_REPLACEMENT)


def get_history(*_args: object, **_kwargs: object) -> NoReturn:
    """Removed. Use conversations.history(db, ...) or GET /api/agent/history."""
    raise NotImplementedError(_REPLACEMENT)
