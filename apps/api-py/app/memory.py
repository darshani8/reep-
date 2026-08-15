"""Chat memory — now a thin adapter over the server-owned conversation store.

Historically this was a local SQLite bank keyed by a client-chosen session_id.
That was the P0: whoever named the session owned the thread. Memory now lives in
Postgres as Conversation/Message rows (app/conversations.py), keyed by a
server-issued conversation_id that only the owning user's session can resolve.

The two function names are kept so existing importers (the voice worker) keep
working — but they now take a conversation_id (a server-owned uuid), NOT a
client session_id, and delegate straight to the conversations service. Callers
that run outside a request (the separate voice worker process) get their own
short-lived DB session here.
"""

from .conversations import append_message, history
from .db import SessionLocal


def save_message(
    conversation_id: str, sender: str, content: str, channel: str = "text"
) -> None:
    """Append one turn to a server-owned conversation (Postgres)."""
    with SessionLocal() as db:
        append_message(db, conversation_id, sender, content, channel=channel)


def get_history(conversation_id: str, limit: int = 40) -> list[dict]:
    """A conversation's final turns oldest-first as [{"role","content"}, ...] —
    the raw, universal shape any chat SDK accepts."""
    with SessionLocal() as db:
        return history(db, conversation_id, limit=limit)
