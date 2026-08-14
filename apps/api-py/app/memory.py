"""Centralized chat memory — a local SQLite store shared by the text chat and
(soon) the voice agent, so both read/write the same conversation per session_id.

This is deliberately separate from the Postgres app DB (app/db.py): it is the
lightweight, always-available conversational memory the unified-assistant spec
calls for. Contract matches the spec's database.py: save_message / get_history,
the getter returning a raw [{"role","content"}, ...] list any SDK can consume.

Thread-safe by construction: every call opens its own short-lived connection
(so no connection is shared across threads) and the DB runs in WAL mode, which
allows concurrent readers alongside a writer. FastAPI runs sync endpoints in a
threadpool, and the voice worker is a separate process — both are safe here.
"""

import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

# One file, next to the app. Override with CHAT_MEMORY_DB (the voice worker sets
# the same path so text and voice share one memory bank).
DB_PATH = os.getenv(
    "CHAT_MEMORY_DB", str(Path(__file__).resolve().parent.parent / "chat_memory.db")
)

_INIT_LOCK = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create the chat_history table once. Idempotent and race-safe."""
    global _initialized
    if _initialized:
        return
    with _INIT_LOCK:
        if _initialized:
            return
        with _connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS chat_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_chat_session ON chat_history(session_id, id)"
            )
            conn.commit()
        _initialized = True


def save_message(session_id: str, role: str, content: str) -> None:
    """Append one turn to a session's history."""
    init_db()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO chat_history (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()


def get_history(session_id: str, limit: int | None = None) -> list[dict]:
    """A session's turns oldest-first as [{"role","content"}, ...] — the raw,
    universal shape any chat SDK (google-genai, OpenAI-compatible, …) accepts.
    `limit` keeps the most recent N turns when a session grows long."""
    init_db()
    if limit:
        query = (
            "SELECT role, content FROM ("
            "SELECT role, content, id FROM chat_history WHERE session_id = ? "
            "ORDER BY id DESC LIMIT ?) ORDER BY id ASC"
        )
        params: tuple = (session_id, limit)
    else:
        query = "SELECT role, content FROM chat_history WHERE session_id = ? ORDER BY id ASC"
        params = (session_id,)
    with _connect() as conn:
        rows = conn.execute(query, params).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in rows]
