"""The Main Admin's rehearsal: the interview with no record (2026-09-16).

`_is_rehearsal` in app/routers/interview.py admits the one office account to
the mock interviewer so it can hear the persona it deploys — and the whole
mechanism is that `_open_records`, the ONE function that writes the
conversation, the `interview_sessions` row and the consent check, is not
called. These tests pin the gate from the outside, through the status probe
the client consults before it opens the socket, and the shape of the flag
from the inside.
"""

from __future__ import annotations

import inspect
import types


from app.models.user import Role
from app.routers import interview as interview_router
from tests.conftest import requires_db


class TestTheFlag:
    def test_only_the_main_admin_rehearses(self):
        assert interview_router._is_rehearsal({"role": Role.ADMIN.value}) is True
        for role in (Role.STUDENT, Role.MENTOR, Role.ALUMNI):
            assert interview_router._is_rehearsal({"role": role.value}) is False
        assert interview_router._is_rehearsal({}) is False

    def test_the_rehearsal_never_opens_records(self):
        """The rehearsal branch returns BEFORE `_open_records` and hands the
        relay every writer as None. Read from the source, because the socket
        cannot be driven in this suite: the branch must sit between the
        specialization check and the `try` that opens the records, and must
        carry no writer."""
        src = inspect.getsource(interview_router.interview)
        branch_at = src.index("if rehearsal:")
        open_at = src.index("_open_records,")
        assert branch_at < open_at, "the rehearsal must be decided before any record is opened"
        branch = src[branch_at:open_at]
        for hook in ("on_turn=None", "on_report=None", "on_finalize=None", "on_heartbeat=None", "recorder=None"):
            assert hook in branch, hook
        assert "interview_session_id=None" in branch

    def test_the_backstop_skips_a_rehearsal(self):
        """Layer 2 closes `interview_sessions` rows; a rehearsal has none."""
        src = inspect.getsource(interview_router._run_relay)
        assert "if interview_session_id is not None:" in src
        assert src.index("if interview_session_id is not None:") < src.index("_finalize_if_running")


@requires_db
class TestTheStatusProbe:
    """GET /api/interview/status is the one place a non-student learns why the
    socket would refuse; for the Main Admin it now says the opposite."""

    def test_the_main_admin_is_not_told_it_is_a_student_feature(self, client, login):
        r = client.get(
            "/api/interview/status",
            headers=login("admin@bgscet.ac.in", "admin123"),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["rehearsal"] is True
        # Whether it is AVAILABLE depends on the engine being configured on
        # this machine; what must never come back is the role refusal.
        assert body["reason"] != "Mock interviews are a student feature."

    def test_a_mentor_is_still_refused(self, client, login):
        r = client.get(
            "/api/interview/status",
            headers=login("mentor@bgscet.ac.in", "mentor123"),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["rehearsal"] is False
        assert body["available"] is False
        assert body["reason"] == "Mock interviews are a student feature."

    def test_a_student_is_not_a_rehearsal(self, client, login):
        r = client.get(
            "/api/interview/status",
            headers=login("student@bgscet.ac.in", "student123"),
        )
        assert r.status_code == 200, r.text
        assert r.json()["rehearsal"] is False


class TestTheBackstopAtRuntime:
    """`_run_relay`'s `finally`, exercised rather than read.

    It used to `return` there when there was no row to close, and a `return`
    inside `finally` swallows the exception in flight: a rehearsal cancelled at
    shutdown lost the CancelledError the handler above re-raises. These run the
    real function with the engine, the downstream close and the row UPDATE
    replaced, and pin both halves -- the rehearsal propagates the cancellation,
    and a real interview still reaches the backstop exactly once. No database.
    """

    @staticmethod
    def _wire(monkeypatch, run):
        import app.interview_local as interview_local

        class FakeEngine:
            def __init__(self, *args, **kwargs):
                pass

            async def run(self):
                return await run()

        monkeypatch.setattr(interview_router.settings, "interview_engine", "local")
        monkeypatch.setattr(interview_local, "LocalSession", FakeEngine)
        closed: list[tuple[int, str]] = []
        finalized: list[tuple] = []

        async def _close(websocket, code, reason):
            closed.append((code, reason))

        monkeypatch.setattr(interview_router, "_close_downstream", _close)
        # The slot was never acquired here; a stand-in limiter takes the release.
        monkeypatch.setattr(
            interview_router, "_LIMITER", types.SimpleNamespace(release=lambda user_id: None)
        )
        monkeypatch.setattr(
            interview_router, "_finalize_if_running", lambda *args: finalized.append(args)
        )
        return closed, finalized

    @staticmethod
    def _relay(session_id):
        return interview_router._run_relay(
            None, "conn-test", "user-test", None,
            on_turn=None, on_report=None, on_finalize=None, on_heartbeat=None,
            recorder=None, max_seconds=60, interview_session_id=session_id,
        )

    def _cancelled(self, monkeypatch, session_id):
        import asyncio

        async def forever():
            await asyncio.Event().wait()

        closed, finalized = self._wire(monkeypatch, forever)

        async def scenario():
            task = asyncio.create_task(self._relay(session_id))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                return "cancelled"
            return "swallowed"

        return asyncio.run(scenario()), closed, finalized

    def test_a_cancelled_rehearsal_propagates_the_cancellation(self, monkeypatch):
        outcome, closed, finalized = self._cancelled(monkeypatch, None)
        assert outcome == "cancelled"
        assert closed == [(interview_router._CLOSE_GOING_AWAY, "Server shutting down")]
        assert finalized == []

    def test_a_cancelled_interview_still_runs_the_backstop_once(self, monkeypatch):
        outcome, _, finalized = self._cancelled(monkeypatch, "sess-1")
        assert outcome == "cancelled"
        assert finalized == [
            ("sess-1", "conn-test", interview_router._CLOSE_GOING_AWAY, "Server shutting down")
        ]

    def test_a_clean_interview_runs_the_backstop_once_with_its_code(self, monkeypatch):
        import asyncio

        async def done():
            return 1000, "Interview complete"

        closed, finalized = self._wire(monkeypatch, done)
        asyncio.run(self._relay("sess-2"))
        assert closed == [(1000, "Interview complete")]
        assert finalized == [("sess-2", "conn-test", 1000, "Interview complete")]
