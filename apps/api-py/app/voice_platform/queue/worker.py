"""The drain worker: pull candidate messages off one degree level's queue and
upsert them into `platform_candidates`.

    python -m app.voice_platform.queue.worker --degree UG
    python -m app.voice_platform.queue.worker --degree PG --once

One process per stream, matching the architecture's separate Undergraduate
and Postgraduate consumers. A message that fails to store is NOT acked: SQS
redelivers it, and after the queue's redrive policy it lands in the dead-letter
queue where an operator can read it — silently acking a bad record would make
the queue look healthy while the roster stays short.
"""

from __future__ import annotations

import argparse
import logging
import time
from typing import Any

from sqlalchemy.orm import Session

from .sqs import CandidateQueue, QueuedMessage, candidate_queue
from .validation import CandidateValidationError, validate_candidate

log = logging.getLogger("app.voice_platform.queue.worker")


def store_message(db: Session, message: QueuedMessage) -> tuple[str, bool]:
    """Persist one queued candidate. Returns (external_id, created)."""
    from ..storage import aurora

    body = message.body
    if body.get("type") != "candidate" or not isinstance(body.get("candidate"), dict):
        raise CandidateValidationError("type", f"unexpected message type {body.get('type')!r}")
    candidate = validate_candidate(body["candidate"])
    if candidate.degree_level != message.degree_level:
        raise CandidateValidationError(
            "degree_level",
            f"{candidate.degree_level} candidate arrived on the {message.degree_level} queue",
        )
    row, created = aurora.upsert_candidate(
        db,
        candidate,
        source=str(body.get("source") or "bulk_upload"),
        source_ref=body.get("source_ref"),
        status="validated",
    )
    return row.external_id, created


def drain_once(
    db: Session, queue: CandidateQueue, degree_level: str, *, max_messages: int = 10, wait_seconds: int = 0
) -> int:
    """One receive → store → ack cycle. Returns how many were stored."""
    stored = 0
    for message in queue.pull(degree_level, max_messages=max_messages, wait_seconds=wait_seconds):
        try:
            external_id, created = store_message(db, message)
            db.commit()
        except CandidateValidationError as exc:
            db.rollback()
            log.error("Leaving message %s on the %s queue: %s", message.message_id, degree_level, exc)
            continue
        except Exception:
            db.rollback()
            log.exception("Could not store message %s from the %s queue", message.message_id, degree_level)
            continue
        queue.ack(degree_level, message.receipt_handle)
        stored += 1
        log.info("%s candidate %s (%s)", "Stored" if created else "Updated", external_id, degree_level)
    return stored


def run(degree_level: str, *, once: bool = False, wait_seconds: int = 20, idle_sleep: float = 1.0) -> int:
    from ...db import SessionLocal

    queue = candidate_queue()
    if queue is None or not queue.configured(degree_level):
        raise SystemExit(
            f"No SQS queue is configured for the {degree_level} stream "
            f"(PLATFORM_{degree_level}_QUEUE_URL is blank)."
        )
    total = 0
    while True:
        db = SessionLocal()
        try:
            stored = drain_once(db, queue, degree_level, wait_seconds=wait_seconds)
        finally:
            db.close()
        total += stored
        if once:
            return total
        if stored == 0:
            time.sleep(idle_sleep)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Drain one candidate stream into Postgres.")
    parser.add_argument("--degree", required=True, choices=["UG", "PG"])
    parser.add_argument("--once", action="store_true", help="one receive cycle, then exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    stored = run(args.degree, once=args.once)
    if args.once:
        print(f"stored {stored} candidate(s) from the {args.degree} queue")


if __name__ == "__main__":  # pragma: no cover
    main()
