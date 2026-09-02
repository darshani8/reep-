"""app/ratelimit.py:FixedWindow — the per-process window the sign-in doors and
the registration endpoint share. No database."""

from __future__ import annotations

import time

from app import ratelimit
from app.ratelimit import FixedWindow


def test_retry_after_counts_and_refuses_at_the_limit():
    window = FixedWindow(600, 3)
    assert [window.retry_after("k") for _ in range(3)] == [None, None, None]
    wait = window.retry_after("k")
    assert isinstance(wait, int) and 1 <= wait <= 600


def test_a_refused_caller_does_not_extend_their_own_window(monkeypatch):
    window = FixedWindow(10, 1)
    now = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: now[0])
    assert window.retry_after("k") is None
    assert window.retry_after("k") == 10
    now[0] += 9.0
    assert window.retry_after("k") == 1  # still the ORIGINAL window's remainder
    now[0] += 1.5
    assert window.retry_after("k") is None  # the window rolled over


def test_blocked_peeks_without_counting_and_hit_counts_without_asking():
    window = FixedWindow(600, 2)
    assert window.blocked("k") is None
    assert window.blocked("k") is None  # peeking never spends the budget
    window.hit("k")
    window.hit("k")
    assert window.blocked("k") is not None
    window.clear("k")
    assert window.blocked("k") is None


def test_the_table_is_bounded():
    window = FixedWindow(600, 5, max_keys=2)
    for key in ("a", "b", "c", "d"):
        window.retry_after(key)
    assert len(window._windows) <= 2


def test_ratelimit_reset_clears_every_registered_window():
    window = FixedWindow(600, 1)
    assert window.retry_after("k") is None
    assert window.retry_after("k") is not None
    ratelimit.reset()
    assert window.retry_after("k") is None


def test_registration_uses_the_shared_window_with_its_old_numbers():
    from app.routers import registration

    assert isinstance(registration._rate_window, FixedWindow)
    assert registration._rate_window.window_seconds == 600
    assert registration._rate_window.limit == 20
    assert registration._rate_window.max_keys == 4096
    assert registration._rate_limit_retry_after("203.0.113.9") is None
