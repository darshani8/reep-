"""Conversation service — the ONE place conversations are resolved and written.

Every assistant surface (text chat, streaming, voice worker) codes against this
exact contract. The ownership rule lives here: a conversation is derived from the
authenticated user, and any id that must travel in a URL is checked with
assert_owner before it is trusted. No endpoint ever accepts a client-chosen
conversation id to decide whose data to read or write.
"""

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models.conversation import Conversation, Message
from .models.user import Role

RETENTION_DAYS = 90


def _now() -> datetime:
    return datetime.now(timezone.utc)


def current_conversation(db: Session, user_id: str) -> Conversation | None:
    """The user's most-recent non-deleted conversation, or None."""
    return db.scalar(
        select(Conversation)
        .where(
            Conversation.owner_user_id == user_id,
            Conversation.deleted_at.is_(None),
        )
        .order_by(Conversation.last_activity_at.desc())
        .limit(1)
    )


def get_or_create(db: Session, user_id: str, role: Role) -> Conversation:
    """Return the user's current conversation or open a fresh one (90-day
    retention). Always scoped to `user_id` — never a client-supplied id.

    Concurrency-safe. This is read-then-insert, so two simultaneous first
    requests can both find nothing and both try to insert — the page firing
    /history and /ask together is exactly that shape. A partial unique index
    (one live conversation per owner) turns the loser into an IntegrityError,
    which is resolved here by re-reading the winner's row. Without it the user
    ends up with two live threads, their turns split across both, and the
    greeting re-armed on whichever one lost."""
    existing = current_conversation(db, user_id)
    if existing is not None:
        return existing
    now = _now()
    conv = Conversation(
        owner_user_id=user_id,
        role=role,
        created_at=now,
        last_activity_at=now,
        retention_until=now + timedelta(days=RETENTION_DAYS),
    )
    db.add(conv)
    try:
        db.commit()
    except IntegrityError:
        # Another request won the race and created it a moment ago.
        db.rollback()
        winner = current_conversation(db, user_id)
        if winner is None:  # pragma: no cover — index violated for another reason
            raise
        return winner
    db.refresh(conv)
    return conv


def assert_owner(db: Session, conversation_id: str, user_id: str) -> Conversation:
    """Fetch a conversation only if `user_id` owns it and it is not soft-deleted.
    Raises 404 for missing, not-owned, or deleted alike — the caller can never
    tell "someone else's" apart from "does not exist" (no existence leak)."""
    conv = db.get(Conversation, conversation_id)
    if (
        conv is None
        or conv.owner_user_id != user_id
        or conv.deleted_at is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found."
        )
    return conv


def append_message(
    db: Session,
    conversation_id: str,
    sender: str,
    content: str,
    channel: str = "text",
    is_final: bool = True,
    provider_turn_id: str | None = None,
) -> Message:
    """Append a turn and bump the conversation's last_activity_at. When
    provider_turn_id is given, dedups on (conversation_id, provider_turn_id):
    a repeat returns the already-stored Message instead of inserting again."""
    if provider_turn_id is not None:
        existing = db.scalar(
            select(Message).where(
                Message.conversation_id == conversation_id,
                Message.provider_turn_id == provider_turn_id,
            )
        )
        if existing is not None:
            return existing

    msg = Message(
        conversation_id=conversation_id,
        sender=sender,
        content=content,
        channel=channel,
        is_final=is_final,
        provider_turn_id=provider_turn_id,
    )
    db.add(msg)

    conv = db.get(Conversation, conversation_id)
    if conv is not None:
        conv.last_activity_at = _now()

    db.commit()
    db.refresh(msg)
    return msg


def history(db: Session, conversation_id: str, limit: int = 40) -> list[dict]:
    """The conversation's final turns oldest-first as [{role: sender, content}] —
    the raw, universal shape any chat SDK accepts. Keeps the most recent `limit`."""
    rows = db.scalars(
        select(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.is_final.is_(True),
        )
        .order_by(Message.created_at.desc())
        .limit(limit)
    ).all()
    return [{"role": m.sender, "content": m.content} for m in reversed(rows)]


GREETING = "Jai Shri Gurudev"


def awaiting_first_reply(db: Session, conversation_id: str) -> bool:
    """True when the compulsory greeting is still owed on the TEXT surface.

    Reads an explicit stamp rather than counting assistant rows. Counting looks
    equivalent and is not: the voice worker's spoken greeting reaches this DB
    through a fire-and-forget POST /api/voice/transcript whose failures are
    deliberately swallowed so a bad write can never kill a live call. Lose that
    write and the student HEARS the greeting but the row is missing, so their
    first typed message greets again; land it and their first typed message is
    silently ungreeted. Neither is acceptable for something described as
    compulsory, so the text surface owns its own flag.

    Voice is intentionally NOT gated on this: a spoken call opens with a
    greeting every time, the way answering a phone does.

    Clearing soft-deletes the conversation, so the next one starts unstamped and
    the greeting is due again."""
    conv = db.get(Conversation, conversation_id)
    return conv is not None and conv.greeted_at is None


def mark_greeted(db: Session, conversation_id: str) -> None:
    """Record that the text surface has now greeted. Called only AFTER the
    greeted reply has been persisted, so a failed turn does not consume the
    greeting and leave the student never seeing it."""
    conv = db.get(Conversation, conversation_id)
    if conv is not None and conv.greeted_at is None:
        conv.greeted_at = _now()
        db.commit()


def open_with_greeting(answer: str) -> str:
    """Prefix the compulsory greeting to the assistant's first reply, unless it
    already opens with it (the voice agent speaks the greeting itself, and a
    model told about it may lead with it too — this must not double up)."""
    if answer.lstrip().lower().startswith(GREETING.lower()):
        return answer
    return f"{GREETING}! {answer.lstrip()}"


def clear(db: Session, user_id: str) -> None:
    """Soft-delete the user's current conversation (set deleted_at). The next
    get_or_create opens a fresh thread. No-op when there is nothing open."""
    conv = current_conversation(db, user_id)
    if conv is not None:
        conv.deleted_at = _now()
        db.commit()
