"""The retention reaper's entrypoint: ``python -m app.retention_job``, run from
deployment on a daily clock (the ``retention`` sidecar in
docker-compose.prod.yml).

This file exists so app/retention.py can keep the position its own docstring
stakes out: ``purge_expired`` and ``redact_expired_runs`` "delete student data
on a clock, which is a deployment decision, and running them from every boot
would make the amount of data destroyed a function of how often someone
restarts the API." The TRIGGER therefore lives in deployment, where a human
chose it and can see it — and this module is only the callable seam between
that trigger and the two jobs. It decides nothing: no schedule, no windows, no
policy. Change WHEN retention runs in the compose file; change WHAT it does in
app/retention.py; change neither here.

(The third job in that module, ``finalize_orphaned_interviews``, is already
wired — app/main.py runs it at every boot, because a worker that just restarted
is exactly the process that knows the previous one died. It is deliberately
NOT repeated here.)

Exit code 0 means both jobs ran to completion. Non-zero means at least one did
not, so whatever supervises this — the compose loop today, a cron with alerting
tomorrow — can tell a quiet day from a broken one without parsing prose.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from . import retention
from .db import SessionLocal

log = logging.getLogger("reep.reap")


def main() -> int:
    # basicConfig, not print: retention reports through `logging`, and the line
    # an operator most needs to see — _delete_interview_audio's ERROR about a
    # recording it could not destroy — must reach the container's stdout, which
    # is this process's entire observability story. An unconfigured root logger
    # would drop everything below WARNING on the floor, including the summary
    # below that says the sweep ran at all.
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )

    # ONE clock for the whole run. Both jobs are pure functions of `now` (their
    # module says so, and its tests pin it), and handing them the same instant
    # means a record cannot be due for one job and not-yet-due for the other
    # inside a single sweep.
    now = datetime.now(timezone.utc)

    try:
        with SessionLocal() as db:
            # purge_expired takes no batching/limit parameter today, so the
            # first run against a long-neglected backlog does all of it in one
            # transaction. Known follow-up: if that first sweep proves too
            # heavy, add a limit to purge_expired itself and drain it in a loop
            # HERE — do not grow a second retention implementation in this
            # file.
            summary = retention.purge_expired(db, now=now)
            log.info(
                "Retention sweep complete. Conversations: %d soft-deleted "
                "(%d message(s) PII-scrubbed), %d hard-deleted (%d message(s) "
                "destroyed). Interviews: %d soft-deleted (%d turn(s) and %d "
                "report(s) PII-scrubbed), %d hard-deleted (%d turn(s) "
                "destroyed), %d audio store(s) destroyed.",
                summary["soft_deleted"],
                summary["messages_redacted"],
                summary["hard_deleted"],
                summary["messages_deleted"],
                summary["interviews_soft_deleted"],
                summary["interview_turns_redacted"],
                summary["interview_reports_redacted"],
                summary["interviews_hard_deleted"],
                summary["interview_turns_deleted"],
                summary["interview_audio_deleted"],
            )
            # Non-zero here means retention did NOT complete — a named
            # student's recording is still on disk and its row was held back
            # from hard-delete so the file stays discoverable (see
            # retention._delete_interview_audio, which has already logged each
            # blocked session id). Said again at summary level because the
            # per-row lines scroll and this one number is the pager-worthy
            # fact.
            if summary["interviews_hard_delete_blocked"]:
                log.error(
                    "%d interview session(s) were due for hard-delete and were "
                    "HELD BACK because their stored audio could not be "
                    "destroyed. Retention is incomplete until someone looks.",
                    summary["interviews_hard_delete_blocked"],
                )

            redacted = retention.redact_expired_runs(db, now=now)
            log.info(
                "Redacted the free text of %d aged AgentRun row(s); their "
                "metrics are kept.",
                redacted,
            )
    except Exception:
        # The sidecar's loop keeps going (tomorrow's run may succeed), but the
        # failure must be loud and the exit code honest — a retention job that
        # fails silently is a 180-day promise quietly not being kept.
        log.exception("Retention run FAILED; nothing further was swept.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
