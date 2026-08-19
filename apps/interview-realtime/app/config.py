"""Settings for the real-time mock-interview relay.

Field names map to env vars case-insensitively (openai_api_key <- OPENAI_API_KEY),
the same convention as apps/api-py/app/config.py. Every string field defaults to
"" so a blank value in a .env file is legal rather than a startup crash: a blank
OPENAI_API_KEY must degrade to "the interview is unavailable, everything else
works", never to a process that refuses to boot.

The OPENAI_API_KEY read here is used on exactly one socket — the server's
outbound connection to api.openai.com. It is never serialised into a downstream
frame and never logged. That containment is the entire reason this relay exists
instead of the browser talking to OpenAI directly.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Final
from urllib.parse import quote, urlsplit

from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)

# This app's own directory: apps/interview-realtime/ (config.py lives in app/).
_APP_DIR: Final[Path] = Path(__file__).resolve().parent.parent

# Env files, lowest precedence first. A bare ".env" resolves against the process
# CWD, so `uvicorn app.server:app` started from the repo root would read a
# different file than the same command started from this directory — the exact
# trap documented in apps/api-py/app/config.py. Both paths here are absolute.
#
# The shared apps/api-py/.env is read FIRST so an OPENAI_API_KEY already entered
# for the main API is picked up without being copied around (the LiveKit voice
# worker reads that same file for the same reason). This app's own .env is read
# SECOND and therefore wins, so a relay-specific override is always possible.
# A missing file is ignored by pydantic-settings, so neither is required.
_SHARED_ENV_FILE: Final[Path] = _APP_DIR.parent / "api-py" / ".env"
_LOCAL_ENV_FILE: Final[Path] = _APP_DIR / ".env"

# Default upstream. Kept separate from the model so the model can be swapped by
# env without anyone hand-assembling a query string (and forgetting to escape it).
_DEFAULT_REALTIME_BASE_URL: Final[str] = "wss://api.openai.com/v1/realtime"

# The GA realtime model. A named constant because it is also the fallback when
# OPENAI_REALTIME_MODEL is set to whitespace — a blank model in the query string
# is a 404 at handshake time, which reads as "the service is down".
_DEFAULT_REALTIME_MODEL: Final[str] = "gpt-realtime"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(_SHARED_ENV_FILE, _LOCAL_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",  # both env files serve other processes; ignore their keys
    )

    # --- Upstream credentials and endpoint ---------------------------------

    # Blank -> the WebSocket endpoint closes with 4001 "Voice service not
    # configured" and the rest of the app (health, the static client) still runs.
    openai_api_key: str = ""
    openai_realtime_model: str = _DEFAULT_REALTIME_MODEL
    openai_realtime_base_url: str = _DEFAULT_REALTIME_BASE_URL

    # The voice is frozen once the model has emitted audio, so it is sent in the
    # single session.update and never changed mid-session. "alloy" exists on both
    # API generations; newer names (marin, cedar) are GA-only, and an unknown
    # name is answered with an `error` event and a silent fall back to the
    # default — i.e. it fails without failing.
    openai_realtime_voice: str = "alloy"

    # Non-empty pins the BETA event surface (the value is "realtime=v1"), which
    # emits response.audio.delta and expects a FLAT session object. Blank selects
    # the GA surface (response.output_audio.delta, nested session.audio.*). The
    # relay normalises both event vocabularies, so this only decides which the
    # API sends: it is the lever for the day one generation is retired, not a
    # knob to turn casually.
    openai_realtime_beta_header: str = ""

    # --- Server -------------------------------------------------------------

    host: str = "127.0.0.1"
    port: int = 8080

    # Browser origins allowed to open the relay WebSocket, comma-separated.
    # Blank means same-origin only. Same-origin is the normal case because this
    # app serves its own public/index.html; the default entry exists so the
    # Angular dev server on :4200 can drive the relay during development.
    web_origin: str = "http://localhost:4200"

    log_level: str = "INFO"
    env: str = "dev"

    # --- Guardrails ---------------------------------------------------------

    # Hard cap on a single interview. This is a cost ceiling as much as a product
    # decision: audio tokens bill per second of a session that a forgotten
    # browser tab would otherwise hold open indefinitely.
    session_max_seconds: int = 900

    # No inbound client audio at all for this long means the student left, the
    # tab was backgrounded (which suspends mic capture), or the mic died. Two
    # minutes survives a long thinking pause plus a reconnecting network.
    idle_max_seconds: int = 120

    # PER-WORKER concurrency limit, enforced by one asyncio.Semaphore. N uvicorn
    # workers give N times this number, so it is deliberately NOT the 1000-student
    # target: one CPython process cannot carry 1000 sessions (~96 MB/s of PCM and
    # ~25k base64 encodes/s). Start near this figure, measure, then scale out with
    # --workers behind a WebSocket-aware load balancer. The upstream account's own
    # concurrent-session cap may bind long before the hardware does.
    max_concurrent_sessions: int = 100

    # --- Server VAD tuning --------------------------------------------------
    # Settings rather than literals because these are the numbers a real
    # deployment retunes against real rooms, and needing a redeploy to change a
    # float is how tuning stops happening.

    # 0.0-1.0 activation energy. 0.5 suits a nervous candidate in a hostel room
    # with a ceiling fan. Raise toward 0.6 only if VAD self-triggers on noise;
    # lowering it lets room noise start a turn.
    vad_threshold: float = 0.5

    # Audio retained BEFORE detected speech onset, so the first phoneme survives.
    # Below ~200 ms, candidates lose the leading consonant of "Actually...".
    vad_prefix_padding_ms: int = 300

    # Silence before the turn is considered over. Deliberately above the API's
    # 500 ms default: the persona promises not to interrupt the student, and a
    # real interview answer contains 400-600 ms thinking pauses mid-sentence.
    # 700 is the smallest value that reliably does not cut a candidate off.
    vad_silence_duration_ms: int = 700

    @field_validator(
        "port",
        "session_max_seconds",
        "idle_max_seconds",
        "max_concurrent_sessions",
        "vad_prefix_padding_ms",
        "vad_silence_duration_ms",
        "vad_threshold",
        mode="before",
    )
    @classmethod
    def _blank_is_default(cls, value: Any, info: ValidationInfo) -> Any:
        """A blank line in a shared .env means "unset", not "crash".

        The module docstring promises that a blank value in a .env file is legal,
        and .env.example documents `PORT=` / `MAX_CONCURRENT_SESSIONS=` as falling
        back to the default. That promise held only for the `str` fields: pydantic
        cannot coerce "" to an int, so `MAX_CONCURRENT_SESSIONS=` raised
        ValidationError during `Settings()` -- which runs at IMPORT, i.e. before
        uvicorn binds a socket. The whole process died at boot on a blank line an
        operator had been told was fine, and these two env files are shared with
        three other processes that may well write one.

        `_must_be_positive` below cannot catch this: it is an AFTER validator and
        never runs, because coercion has already failed.

        The default is read from the model field rather than returned as
        PydanticUndefined: returning PydanticUndefined does NOT re-trigger default
        substitution in pydantic 2.13 -- it is validated as a value and fails with
        "Input should be a valid integer".
        """
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name].default
        return value

    @field_validator(
        "port",
        "session_max_seconds",
        "idle_max_seconds",
        "max_concurrent_sessions",
        "vad_prefix_padding_ms",
        "vad_silence_duration_ms",
    )
    @classmethod
    def _must_be_positive(cls, value: int, info: ValidationInfo) -> int:
        """Reject zero/negative values at startup rather than mid-interview.

        A `SESSION_MAX_SECONDS=0` typo would otherwise mean "close every session
        the instant it opens", which presents as a relay that connects and hangs
        up — indistinguishable from an upstream outage.
        """
        if value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer, got {value}")
        return value

    @field_validator("vad_threshold")
    @classmethod
    def _threshold_in_range(cls, value: float) -> float:
        """An out-of-range threshold is rejected upstream with an `error` event
        that does NOT close the socket, so the session would quietly run on the
        default while the config claimed otherwise. Fail loudly here instead."""
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"vad_threshold must be between 0.0 and 1.0, got {value}")
        return value

    @property
    def is_configured(self) -> bool:
        """Whether an upstream credential is present.

        `.strip()` because a key pasted into a .env file routinely arrives with a
        trailing space or newline, and whitespace is not a credential — it is a
        401 at handshake time.
        """
        return bool(self.openai_api_key.strip())

    @property
    def realtime_url(self) -> str:
        """Upstream WebSocket URL with the model percent-encoded into the query.

        This is the ONLY place the URL is composed, so escaping happens exactly
        once. Dated model ids contain no unsafe characters today; `quote` costs
        nothing and removes the class of bug where a future id does.
        """
        model = self.openai_realtime_model.strip() or _DEFAULT_REALTIME_MODEL
        base = (self.openai_realtime_base_url.strip() or _DEFAULT_REALTIME_BASE_URL).rstrip("/")
        return f"{base}?model={quote(model, safe='')}"

    @property
    def beta_header(self) -> str:
        """The OpenAI-Beta header value, or "" meaning omit the header entirely."""
        return self.openai_realtime_beta_header.strip()

    @property
    def allowed_origins(self) -> tuple[str, ...]:
        """Origins from WEB_ORIGIN, split and trimmed. An empty tuple means
        same-origin only -- which `is_origin_allowed` implements against the
        request's own Host header, NOT by allowing everything."""
        return tuple(o.strip() for o in self.web_origin.split(",") if o.strip())

    def is_origin_allowed(self, origin: str | None, host: str | None = None) -> bool:
        """Origin check for the WebSocket handshake — call this explicitly.

        Browsers do NOT apply the same-origin policy to WebSocket connections,
        and CORS middleware never sees a socket upgrade. Without this check any
        page on the internet can open a session against this relay and spend the
        account's audio tokens.

        `host` is the request's own Host header, and it is what makes
        "same-origin" mean something. The page this process serves is always
        allowed, on whatever host:port the operator reached it on. Two bugs died
        with that one line:

          * WEB_ORIGIN blank used to return True for EVERY origin, so the setting
            documented as "same-origin only" was in fact the WIDEST one and any
            page on the internet could open a billed session.
          * WEB_ORIGIN at its shipped default (http://localhost:4200) rejected
            the bundled client, because the README's own smoke test opens
            http://127.0.0.1:8080/ and that origin is not in the list. The
            documented first run closed with 4003 out of the box.

        Only the AUTHORITY is compared, never the scheme: behind a TLS-terminating
        proxy the browser says `https://` while this process sees a plain upgrade
        and a Host header that carries no scheme at all.

        A missing Origin header means a non-browser client (curl, a smoke test)
        rather than a cross-site page, so it is allowed only outside production,
        where the risk is a developer's own laptop.
        """
        if origin is None:
            return not self.is_prod
        if host:
            try:
                if urlsplit(origin).netloc.lower() == host.strip().lower():
                    return True
            except ValueError:
                # A malformed Origin is not a browser this relay wants to trust.
                return False
        return origin in self.allowed_origins

    @property
    def is_prod(self) -> bool:
        return self.env.strip().lower() == "prod"

    @property
    def public_dir(self) -> Path:
        """Directory of the bundled browser client, pinned to this app.

        Same reasoning as the env file: a relative "public" resolves against the
        CWD and 404s for anyone who did not start uvicorn from this directory.
        """
        return _APP_DIR / "public"


settings = Settings()

if not settings.is_configured:
    # WARNING, not an exception: the process must still serve /health and the
    # static client so an operator can open the page and be told, in the browser,
    # what is missing. The WebSocket endpoint closes with 4001 until this is set.
    log.warning(
        # ASCII only: this line lands on a Windows console whose code page is
        # cp1252, where a non-ASCII character prints as mojibake at best.
        "OPENAI_API_KEY is not set (looked in %s and %s) - the interview relay "
        "will refuse sessions with close code 4001.",
        _SHARED_ENV_FILE,
        _LOCAL_ENV_FILE,
    )
