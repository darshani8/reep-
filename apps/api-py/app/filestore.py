"""Hardened on-disk file store for student uploads.

Bytes live on disk under a random `stored_name`; only metadata goes in the
`uploads` table (see models/upload.py). Two rules the Next.js store also enforced
and that matter for trusting a student-supplied file:

- The type is decided by MAGIC BYTES, not the client-sent name or Content-Type.
  A ".pdf" that is actually an executable is rejected; the recorded mime is what
  the bytes actually are.
- The name written to disk is random, so a crafted filename can never traverse
  the store or overwrite another file. Reads reject any separator in the name.

Only PDF / PNG / JPEG are accepted — the formats a mentor reviews (marksheets,
certificates, photos). Max 10 MB, matching the UI copy.
"""

import uuid
from pathlib import Path

from .config import settings

# First bytes -> (mime, extension). Order matters only in that each signature is
# unambiguous.
_MAGIC: list[tuple[bytes, str, str]] = [
    (b"%PDF", "application/pdf", ".pdf"),
    (bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), "image/png", ".png"),
    (bytes([0xFF, 0xD8, 0xFF]), "image/jpeg", ".jpg"),
]

MAX_BYTES = 10 * 1024 * 1024  # 10 MB


class UploadRejected(ValueError):
    """The bytes are not an accepted file (bad type, empty, or too large)."""


def _sniff(content: bytes) -> tuple[str, str]:
    for magic, mime, ext in _MAGIC:
        if content.startswith(magic):
            return mime, ext
    raise UploadRejected("Unsupported file type — only PDF, PNG and JPEG are accepted.")


def _store_dir() -> Path:
    d = settings.uploads_path
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_bytes(content: bytes) -> tuple[str, str, int]:
    """Validate and store; return (stored_name, sniffed_mime, size_bytes)."""
    if not content:
        raise UploadRejected("The file is empty.")
    if len(content) > MAX_BYTES:
        raise UploadRejected("File too large — the limit is 10 MB.")
    mime, ext = _sniff(content)
    stored_name = uuid.uuid4().hex + ext
    (_store_dir() / stored_name).write_bytes(content)
    return stored_name, mime, len(content)


def read_bytes(stored_name: str) -> bytes:
    """Read a stored file back. Rejects any path separator in the name."""
    if not stored_name or "/" in stored_name or "\\" in stored_name or ".." in stored_name:
        raise FileNotFoundError(stored_name)
    path = _store_dir() / stored_name
    if not path.is_file():
        raise FileNotFoundError(stored_name)
    return path.read_bytes()


def delete(stored_name: str) -> None:
    """Remove a stored file. Rejects any path separator in the name (same guard as
    read_bytes); silently ignores a file that is already gone."""
    if not stored_name or "/" in stored_name or "\\" in stored_name or ".." in stored_name:
        raise FileNotFoundError(stored_name)
    (_store_dir() / stored_name).unlink(missing_ok=True)
