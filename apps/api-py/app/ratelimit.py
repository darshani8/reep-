"""Per-user rate limiting for LLM-backed HTTP endpoints.

The 2026-08 scalability audit found the expensive routes — resume generation
and the retained /api/agent chat surface — had no per-user ceiling at all.
Every call runs a synchronous model round-trip in the shared 40-thread pool, so
one student's retry loop (or a 60-person class told to "regenerate until it
looks good") was simultaneously a thread-pool DoS and an unbudgeted token bill.
The interview WebSocket already had both halves of this control
(interview_max_sessions_per_user + interview_max_per_student_per_day); this
module gives the HTTP routes their missing half.

Sliding window rather than a token bucket: "at most N calls in any 60 s" is
the sentence the setting (LLM_REQUESTS_PER_MINUTE) promises, a deque of
timestamps is exactly that sentence with no refill arithmetic to get subtly
wrong, and the memory cost is bounded at N floats per user who called at all.

PER PROCESS, on purpose. The state is a dict behind a threading.Lock — these
endpoints are sync `def`s running in the threadpool, so the lock is real, and
an asyncio primitive would be the wrong tool. N uvicorn workers therefore relax
the ceiling to at most N x the setting, which is still a ceiling (the audit's
finding was that there was NONE), costs no infrastructure, and degrades in the
safe direction: a limit that is accidentally loose still stops the loop; a
shared store that is accidentally down stops the feature. Move this to a shared
store the day the multiplied bound stops being acceptable, not before.

429 with Retry-After, not 503: the service is fine, the CALLER is over budget,
and Retry-After is the header that lets a well-behaved client (and a student
reading devtools) know the wait is seconds, not an outage.
"""

from __future__ import annotations

import threading
import time
from collections import deque

from fastapi import Depends, HTTPException, status

from .config import settings
from .identity import get_current_session

_WINDOW_S = 60.0

_lock = threading.Lock()
_calls: dict[str, deque[float]] = {}


def _check(user_id: str) -> float | None:
    """One call's verdict: None = allowed (and recorded), else seconds to wait.

    The prune and the append happen under one lock acquisition so two threads
    carrying the same cookie cannot both see "one slot left" and both take it.
    A user's entry holds at most `limit` floats forever after their last call —
    ~5,570 accounts x a few floats is not a memory figure worth a sweeper.
    """
    now = time.monotonic()
    limit = settings.llm_requests_per_minute
    with _lock:
        window = _calls.setdefault(user_id, deque())
        while window and now - window[0] >= _WINDOW_S:
            window.popleft()
        if len(window) >= limit:
            return _WINDOW_S - (now - window[0])
        window.append(now)
        return None


def llm_rate_limited(session: dict = Depends(get_current_session)) -> None:
    """FastAPI dependency: attach to any route whose handler calls a model.

    Depends on get_current_session rather than re-reading the cookie so FastAPI's
    per-request dependency cache means zero extra verification work on routes
    that already resolve the session — which is all of them.
    """
    wait = _check(session["userId"])
    if wait is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Too many AI requests. Wait a moment and try again — the limit "
                f"is {settings.llm_requests_per_minute} per minute."
            ),
            headers={"Retry-After": str(max(1, int(wait) + 1))},
        )


class FixedWindow:
    """A per-process fixed window keyed on a caller-supplied string.

    Extracted from app/routers/registration.py's limiter so the sign-in doors do
    not carry a third copy. Same caveats as the module docstring — PER WORKER,
    keyed on whatever the caller passes (a socket peer, a submitted address), and
    bounded at `max_keys` entries so the limiter cannot itself become the memory
    exhaustion it exists to prevent. Three verbs, because the doors need three
    different questions:

      retry_after(key)  count this attempt; None to proceed, else seconds to wait
      blocked(key)      the same verdict WITHOUT counting (peek before doing work)
      hit(key)          count without asking (a failure the caller decided on)

    A caller who is already over the limit is never counted, so a refusal cannot
    extend its own window into a permanent block. Every instance registers
    itself so `reset()` below clears it between tests.
    """

    def __init__(self, window_seconds: float, limit: int, *, max_keys: int = 4096) -> None:
        self.window_seconds = float(window_seconds)
        self.limit = int(limit)
        self.max_keys = int(max_keys)
        self._windows: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()
        _WINDOWS.append(self)

    def _verdict(self, key: str, *, count: bool) -> int | None:
        now = time.monotonic()
        with self._lock:
            start, n = self._windows.get(key, (now, 0))
            if now - start >= self.window_seconds:
                start, n = now, 0
            if n >= self.limit:
                return max(1, int(self.window_seconds - (now - start)))
            if count:
                self._store(key, start, n + 1, now)
            return None

    def _store(self, key: str, start: float, n: int, now: float) -> None:
        if key not in self._windows and len(self._windows) >= self.max_keys:
            for k, (started, _n) in list(self._windows.items()):
                if now - started >= self.window_seconds:
                    del self._windows[k]
            if len(self._windows) >= self.max_keys:
                self._windows.clear()  # every window still live: start over, never grow
        self._windows[key] = (start, n)

    def retry_after(self, key: str) -> int | None:
        return self._verdict(key, count=True)

    def blocked(self, key: str) -> int | None:
        return self._verdict(key, count=False)

    def hit(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            start, n = self._windows.get(key, (now, 0))
            if now - start >= self.window_seconds:
                start, n = now, 0
            self._store(key, start, n + 1, now)

    def clear(self, key: str) -> None:
        with self._lock:
            self._windows.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._windows.clear()


_WINDOWS: list[FixedWindow] = []


def reset() -> None:
    """Forget every window. FOR TESTS: the suite drives one seeded student
    through dozens of /api/agent/chat calls in one process, and a limiter that
    remembers them across tests would fail the suite for being thorough — the
    exact trap AGENTS.md warns turns guards into deleted guards. conftest.py
    calls this around each test. Clears every FixedWindow too, so a login test
    that spent an address window cannot fail the next one."""
    with _lock:
        _calls.clear()
    for window in _WINDOWS:
        window.reset()
