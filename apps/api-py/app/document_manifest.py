"""The one way to put a file into the store, and the one way to say it is gone.

`app/document_store.py` writes bytes and knows nothing about who owns them —
deliberately, because it holds no ORM and that is what lets it be tested with
four integers and no database. `app/document_archive.py` copies those bytes
somewhere permanent, and knows even less. Neither can answer the question a
restore actually asks: *whose file was `3f2a…9c.pdf`, what was it called, and
when did it stop being live?*

This module is that answer. `save_and_record` is `document_store.save_bytes`
plus the `archived_documents` row, in one call and one transaction, and it is
the ONLY spelling the routers use.

**WHY IT IS A WRAPPER AND NOT A CONVENTION.** `document_store`'s own docstring
records what happened the last time an invariant lived in the callers: the
comment said enforcement was in "routers/student.py create_upload — the single
caller of save_bytes", and three writers later `routers/alumni.py` had no quota
check at all. The lesson taken then was to move the ARITHMETIC into the store
and refuse a caller that brings no `VolumeQuota`. The same lesson applies here
and the store cannot host it, because a manifest row needs a `Session`. So the
enforcement is one rung up: routers call this, and
`tests/test_codebase_guards.py` fails the build if a module under `app/routers/`
imports `save_bytes` directly. A file that reaches the store without a manifest
row is a file in the permanent archive that nothing can ever name.

**THE ROW IS ADDED, NEVER COMMITTED HERE.** `db.add` and `db.flush`, so the
manifest lands in the same transaction as the live row the caller is about to
write. A separate commit would make "file recorded, upload rolled back" and
"upload committed, file unrecorded" both reachable; the first is harmless
noise, the second is the failure this module exists to prevent.

**`release` IS BEST-EFFORT AND ITS ABSENCE IS NEVER READ AS "STILL LIVE".** The
bytes are in the archive whether or not anybody stamps `released_at`. A
manifest that refused to record a file because it could not also record the
release would trade the thing that matters for the thing that does not.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import document_store
from .document_store import VolumeQuota
from .models.archived_document import ArchivedDocument, DocumentOwnerKind

log = logging.getLogger("reep.document_manifest")


def save_and_record(
    db: Session,
    content: bytes,
    *,
    quota: VolumeQuota,
    kind: DocumentOwnerKind,
    owner_id: str | None,
    original_name: str,
    title: str | None = None,
) -> tuple[str, str, int]:
    """Store the bytes, archive them, and record what they were.

    Returns `document_store.save_bytes`'s `(stored_name, mime, size)` unchanged,
    so a call site is a one-word edit rather than a rewrite.

    Every argument after `quota` is keyword-only and none has a default except
    `title`, which is genuinely absent for four of the six stores. `owner_id`
    takes `None` explicitly rather than by omission: a registration document
    belongs to an applicant with no account yet, and that must be a stated fact
    rather than a forgotten argument.
    """
    stored_name, mime, size = document_store.save_bytes(content, quota=quota)
    db.add(
        ArchivedDocument(
            stored_name=stored_name,
            kind=kind,
            owner_id=owner_id,
            original_name=original_name,
            title=title,
            mime_type=mime,
            size_bytes=size,
        )
    )
    db.flush()
    return stored_name, mime, size


def release(db: Session, stored_name: str | None, *, reason: str) -> None:
    """Stamp `released_at` — the live row no longer points at this file.

    Idempotent and silent about a name it does not know. Two callers make that
    necessary rather than merely tidy: `python -m app.purge_people` releases
    files whose manifest rows predate this table, and a re-run of any delete
    path releases a name already released. Neither is an error, and raising on
    either would put a destructor into a state only a database edit can leave.

    NEVER DELETES THE ROW. The point of the manifest is that it outlives the
    thing it describes.
    """
    if not stored_name:
        return
    row = db.scalar(select(ArchivedDocument).where(ArchivedDocument.stored_name == stored_name))
    if row is None:
        # A file stored before this table existed, or one written by a path
        # that does not go through `save_and_record`. Worth a line in the log —
        # it is how the second case is ever noticed — and never worth an
        # exception on a delete the user asked for.
        log.info("Released %s, which has no manifest row (%s)", stored_name, reason)
        return
    if row.released_at is None:
        row.released_at = datetime.now(timezone.utc)
        row.released_reason = reason
