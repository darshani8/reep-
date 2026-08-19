"""Application settings, read from the environment / apps/api-py/.env.

Field names map to env vars case-insensitively (database_url <- DATABASE_URL).
"""

from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import AliasChoices, Field, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Pin the env file to THIS app's directory. A bare ".env" resolves against the
# process CWD, which — run from the repo root — is the Next.js/Prisma .env, whose
# `postgresql://…?schema=public` URL selects psycopg2 (not installed) and carries
# a Prisma-only query param. This app reads its own file or nothing.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# Upstream for the realtime mock interview (app/routers/interview.py). Kept apart
# from the model id so the model can be swapped by env without anyone
# hand-assembling a query string - and forgetting to escape it.
_DEFAULT_REALTIME_BASE_URL = "wss://api.openai.com/v1/realtime"
# The GA realtime model, and the fallback when OPENAI_REALTIME_MODEL is set to
# whitespace: a blank model in the query string is a 404 at handshake time, which
# reads to a student as "the interview is down" rather than "it is misconfigured".
_DEFAULT_REALTIME_MODEL = "gpt-realtime"
# The Whisper-family model that transcribes the STUDENT's half of the interview
# (the model's own words come back as an assistant transcript and are not sent
# through this). "whisper-1" was hard-coded at BOTH call sites in
# app/interview_relay.py, which is what made "Whisper is missing from the stack"
# look true - it was there, as the LEGACY id, with no way off it short of a
# redeploy. gpt-4o-mini-transcribe is the same Whisper lineage with lower word
# error on accented English and a lower price per minute.
_DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
# The legacy id, and the only transcriber the BETA event surface is KNOWN to
# accept. Kept as the blank-default for beta rather than as a code path nobody
# exercises: flipping the default under an existing beta-pinned deployment turns
# a working interview into a close 4002 at handshake, with no .env change to
# explain it. An explicit INTERVIEW_TRANSCRIPTION_MODEL always wins, so a beta
# deployment that has verified a newer id still gets it.
_BETA_TRANSCRIPTION_MODEL = "whisper-1"

# The institution's mail domain. One constant behind two settings
# (GOOGLE_ALLOWED_DOMAIN and ROSTER_EMAIL_DOMAIN) because they describe the same
# real-world fact: which addresses belong to this college. It is NOT a security
# boundary — the roster is (see app/google_auth.py).
_DEFAULT_COLLEGE_DOMAIN = "bgscet.ac.in"

# Every spelling of "this is production" an operator actually types. `is_prod`
# used to be `env == "prod"` exactly, which FAILS OPEN in the two places it now
# matters most: ENV=production — the spelling most deploy templates and PaaS
# dashboards use — would leave the session cookie without `Secure` AND leave
# password sign-in reachable on the internet. Recognising the synonyms is the
# cheap half of the fix; `password_login_allowed` below is the other half.
_PROD_ENV_NAMES = frozenset({"prod", "production", "prd", "live"})

# The environments POST /api/auth/login is allowed to answer in — an ALLOWLIST,
# not the complement of _PROD_ENV_NAMES, because the two guards must fail in
# opposite directions. A typo'd ENV must mean "the cookie is Secure and the
# password door is shut", never "neither". ENV is "dev" by default and CI sets
# nothing, so the suite and every laptop keep the door they already have.
_PASSWORD_LOGIN_ENV_NAMES = frozenset({"dev", "development", "test", "testing", "ci", "local"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    database_url: str = "postgresql+psycopg://reep:reep_dev_password@localhost:5433/reep_py"
    # Shared with the Next.js app so sessions verify on both sides during cutover.
    auth_secret: str = "reep-dev-secret-change-me-in-production-0123456789abcdef"
    web_origin: str = "http://localhost:4200"
    env: str = "dev"

    # --- Google sign-in (OIDC authorization-code flow) -------------------------
    # Sign-in is Google-only for every role. These credentials decide only WHO
    # GOOGLE SAYS YOU ARE; they decide nothing about access. The roster in the
    # `users` table is the allowlist — a verified Google account with no user row
    # is refused — so a leaked client id buys an attacker an identity we then
    # look up and reject, not an account.
    #
    # From console.cloud.google.com -> Credentials -> "OAuth client ID", type
    # "Web application". The SECRET is a real credential: it is used only on the
    # server-to-server token exchange (POST oauth2.googleapis.com/token) and must
    # never be serialised into a page, a redirect or a log line.
    #
    # BLANK IS OFF, the same contract OPENAI_API_KEY has for the interview: the
    # sign-in capability probe reports it unconfigured and the login screen keeps
    # the Google button disabled, instead of sending a student out of the app to
    # a Google error page nobody here can explain.
    google_client_id: str = ""
    google_client_secret: str = ""
    # OPTIONAL OVERRIDE, blank on nearly every deployment. Blank means
    # app/google_auth.py:redirect_uri() derives it as WEB_ORIGIN + CALLBACK_PATH,
    # which is the right answer whenever the browser reaches the API through the
    # web origin. Set it only when the public URL is not WEB_ORIGIN (a proxy in
    # front, a separate API host).
    #
    # Whatever the value, it must be BYTE-IDENTICAL to an "Authorised redirect
    # URI" on the OAuth client AND be the origin the BROWSER is on — not the one
    # FastAPI sees. apps/web/proxy.conf.json sets changeOrigin:true, so this
    # process is told `Host: localhost:3300` while the student is on :4200; a
    # redirect_uri built from the inbound request (request.url_for) would come
    # out :3300 and Google would answer redirect_uri_mismatch on every sign-in.
    # Composition lives in ONE function in app/google_auth.py, not here, because
    # the authorize request and the token exchange must send the same string and
    # Google rejects the exchange when they differ.
    google_redirect_uri: str = ""
    # The college's mail domain(s), comma-separated. READ THE NAME AS A LABEL,
    # NOT A FENCE: nothing in the sign-in path refuses on it, and nothing should
    # start to. The roster is the allowlist (app/google_auth.py explains why the
    # `hd` claim is deliberately not used — a domain test on top of the roster
    # can only add a second way to lock out someone who IS enrolled, and
    # app/grant_access.py exists precisely to admit staff whose address is not
    # on the student domain at all). Its two real jobs: it is the default
    # `roster_domain` derives addresses from, and its first entry is the string
    # GET /api/auth/sso/status hands the login screen so the copy can say
    # "the one ending @bgscet.ac.in" instead of "@your college".
    google_allowed_domain: str = _DEFAULT_COLLEGE_DOMAIN
    # The USN -> email convention: 1MP25MDM01 -> 1mp25mdm01@bgscet.ac.in (local
    # part = the USN, lowercased — the shape app/seed.py already seeds as
    # 1bg24mba045@bgscet.ac.in). This is the ONE piece of the design that is a
    # guess about the outside world: if the college's real convention differs by
    # a single character then every student on the roster is locked out on day
    # one, and that fix must be a .env edit, never a code change plus a rebuild.
    # COLLEGE_EMAIL_DOMAIN is accepted as an alias because that is the name
    # app/seed_roster.py documents in its --help. Blank -> the first
    # GOOGLE_ALLOWED_DOMAIN entry, so a single-domain college sets one variable.
    roster_email_domain: str = Field(
        "", validation_alias=AliasChoices("ROSTER_EMAIL_DOMAIN", "COLLEGE_EMAIL_DOMAIN")
    )

    # Universal LLM adapter (see app/ai/llm.py). Same names as the Next.js app,
    # so one set of keys drives both stacks. Any OpenAI-compatible provider.
    llm_base_url: str = ""
    llm_model: str = ""
    llm_api_key: str = ""
    llm_timeout_ms: int = 300000
    # A string (not bool) so a blank value is valid and safely means "off",
    # matching the Next.js gate where only the exact string "true" enables it.
    llm_allow_remote_student_data: str = ""

    # Per-provider keys for universal auto-select (app/ai/llm.py). Paste any one;
    # the adapter picks the first present. The explicit LLM_* trio above wins
    # over these when fully set.
    groq_api_key: str = ""
    mistral_api_key: str = ""
    openrouter_api_key: str = ""
    cohere_api_key: str = ""
    gemini_api_key: str = ""
    # Sakana Fugu — OpenAI-compatible meta-router (https://api.sakana.ai/v1).
    sakana_api_key: str = ""

    # Knowledge-Base embedder (app/ai/embeddings.py). OPTIONAL: leave the base URL
    # blank and retrieval falls back to Postgres full-text — no embeddings needed.
    # The KB is public policy text (no student PII), so it may be sent to any
    # OpenAI-compatible /embeddings endpoint. When set, POSTs to
    # {embedding_base_url}/embeddings with embedding_model.
    embedding_base_url: str = ""
    embedding_model: str = ""
    embedding_api_key: str = ""

    # LiveKit (voice assistant) — a free LiveKit Cloud project. The /api/voice
    # endpoints return 503 until all three are set.
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    # Optional shared secret the voice worker presents on POST /api/voice/heartbeat.
    # Blank -> the heartbeat is open (dev). Set it in prod to authenticate the worker.
    voice_worker_secret: str = ""
    # Maintenance banner surfaced by GET /api/voice/status when non-empty (voice is
    # forced unavailable while set — e.g. during an incident).
    voice_maintenance_message: str = ""

    # Realtime mock interview (app/routers/interview.py) - the student-facing
    # assistant. The API relays the browser's microphone to OpenAI's Realtime API
    # over one outbound WebSocket. OPENAI_API_KEY is used on exactly that socket:
    # it is never serialised into a downstream frame and never logged, and that
    # containment is the whole reason the relay lives here instead of the browser
    # talking to OpenAI directly.
    #
    # OPENAI_API_KEY is deliberately NOT part of the LLM auto-select chain in
    # app/ai/llm.py. The Realtime API is not OpenAI-compatible chat, so a key
    # pasted here must not quietly become the provider for resume generation.
    #
    # Rule 1 (AGENTS.md): this is a REMOTE provider, so no student record may
    # enter the session - no marks, attendance, CGPA, USN or resume text. The
    # interviewer persona asks questions; it does not need them, exactly as
    # voice_agent.py's BASE_INSTRUCTIONS states for the LiveKit worker. Anything
    # that would personalise the prompt goes through complete_chat(...,
    # carries_student_data=True) in app/ai/llm.py, or is left out.
    #
    # Blank OPENAI_API_KEY -> GET /api/interview/status reports unavailable with a
    # reason naming this variable and the WebSocket refuses the session; nothing
    # else in the dashboard is affected.
    openai_api_key: str = ""
    openai_realtime_model: str = _DEFAULT_REALTIME_MODEL
    openai_realtime_base_url: str = _DEFAULT_REALTIME_BASE_URL
    # The voice is frozen the moment the model emits audio, so it is sent in the
    # single session.update and never changed mid-session. "alloy" exists on both
    # API generations; the newer names (marin, cedar) are GA-only, and an unknown
    # name is answered with an `error` event and a silent fall back to the
    # default - i.e. it fails without failing.
    openai_realtime_voice: str = "alloy"
    # Non-empty pins the BETA event surface (the value is "realtime=v1"), which
    # emits response.audio.delta and expects a FLAT session object; blank selects
    # GA (response.output_audio.delta, nested session.audio.*). A string, not a
    # bool, for the same reason as llm_allow_remote_student_data: a blank line in
    # a shared .env must be legal. This is the lever for the day one generation is
    # retired, not a knob to turn casually.
    openai_realtime_beta_header: str = ""

    # Hard cap on one interview - a cost ceiling as much as a product decision:
    # audio tokens bill per second of a session that a forgotten browser tab
    # would otherwise hold open indefinitely. 15 minutes is a full mock round.
    interview_max_seconds: int = 900
    # No inbound audio at all for this long means the student left, the tab was
    # backgrounded (which suspends mic capture), or the mic died. Two minutes
    # survives a long thinking pause plus a reconnecting network.
    interview_idle_seconds: int = 120
    # PER-WORKER concurrency cap. N uvicorn workers give N times this number, so
    # it is deliberately NOT the 1000-student target: one CPython process cannot
    # carry 1000 sessions (~96 MB/s of PCM). Over the cap the socket is closed
    # immediately rather than queueing a student behind a clock that has not
    # started ticking.
    interview_max_sessions: int = 100

    # Server-VAD tuning. Settings rather than literals because these are the
    # numbers a real deployment retunes against real rooms, and needing a
    # redeploy to change a float is how tuning stops happening.
    #
    # READ THE ECHO NOTES BELOW BEFORE TURNING ANY OF THESE. Server VAD sits
    # downstream of the mixer: it sees one mono stream in which the interviewer's
    # own voice, arriving back through a laptop speaker into the microphone, IS
    # speech. It cannot tell whose voice it is, so no value here eliminates the
    # self-talk loop - that discrimination happens in the browser, which has the
    # loudspeaker signal and the microphone in one clock domain. These three
    # change how OFTEN echo clears the bar, not whether it can.
    #
    #   threshold  0.0-1.0 activation energy. 0.5 suits a nervous candidate in a
    #              hostel room with a ceiling fan; lower lets room noise start a
    #              turn, raise toward 0.6 only if VAD self-triggers on noise.
    #              ECHO: raising it makes speaker-borne echo (which reaches the
    #              mic 15-25 dB below the student's own near-field voice) less
    #              likely to open a turn, so the interviewer answers itself less
    #              often - at the cost that a quiet or leaned-back student stops
    #              being heard at all, and barge-in with it. It is a level knob,
    #              not a duplex fix.
    #   prefix     audio kept BEFORE detected speech onset so the first phoneme
    #              survives. Below ~200 ms candidates lose the leading consonant
    #              of "Actually...".
    #              ECHO: this padding is pulled out of the append buffer, so on a
    #              turn that echo triggered, raising it prepends MORE of the
    #              interviewer's own sentence - which transcribes into coherent
    #              text the model then answers confidently. It does not change
    #              how often a false turn fires, only how convincing it is.
    #   silence    how long a pause ends the turn. Deliberately above the API's
    #              500 ms default: the persona promises not to interrupt, and a
    #              real interview answer contains 400-600 ms thinking pauses
    #              mid-sentence. 700 is the smallest value that reliably does not
    #              cut a candidate off.
    #              ECHO: raising it makes self-talk LESS FREQUENT and LONGER -
    #              700 ms already exceeds the gaps between the model's own words,
    #              so an echo-triggered segment swallows a whole clause before it
    #              commits. Lowering it commits sooner and fires more often.
    interview_vad_threshold: float = 0.5
    interview_vad_prefix_padding_ms: int = 300
    interview_vad_silence_duration_ms: int = 700

    # The ASR for the student's own speech, sent on BOTH API shapes (flat beta
    # `input_audio_transcription`, nested GA `audio.input.transcription`). A
    # setting because the transcription model is retired on a different clock
    # from the realtime model, and moving to a newer one is something a
    # deployment does against real recordings - not a code change.
    #
    # Defaults to "" — meaning UNSET — rather than to a model id, because the
    # `transcription_model` property below resolves a blank differently per API
    # surface and cannot tell "the operator chose this id" from "this is the
    # field default" if the two look identical. Blank never reaches the wire.
    #
    # A WRONG id is rejected at session.update with an `error` echoing our
    # event_id, which _await_upstream_event turns into a close 4002 during the
    # handshake: loud, at startup, not a silent interview with no "You" lines.
    # That is the only reason this is safe to expose.
    interview_transcription_model: str = ""

    @field_validator(
        "llm_timeout_ms",
        "interview_max_seconds",
        "interview_idle_seconds",
        "interview_max_sessions",
        "interview_vad_threshold",
        "interview_vad_prefix_padding_ms",
        "interview_vad_silence_duration_ms",
        mode="before",
    )
    @classmethod
    def _blank_is_default(cls, value: Any, info: ValidationInfo) -> Any:
        """A blank line in .env means "unset", not "crash".

        Every str field here already reads "" as "feature off", and .env.example
        documents `INTERVIEW_MAX_SECONDS=` as falling back to the default. That
        promise did not hold for the int fields: pydantic cannot coerce "" to an
        int, so a bare `LLM_TIMEOUT_MS=` raised ValidationError inside
        `Settings()` - which runs at IMPORT, i.e. before uvicorn binds a socket.
        The whole dashboard died at boot on a blank line, and apps/api-py/.env is
        shared by four processes any of which may write one.

        `_must_be_positive` below cannot catch this: it is an AFTER validator and
        never runs, because coercion has already failed.

        The default is read off the model field rather than returned as
        PydanticUndefined - returning PydanticUndefined does NOT re-trigger
        default substitution in pydantic 2.13; it is validated as a value and
        fails with "Input should be a valid integer".
        """
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name].default
        return value

    @field_validator(
        "interview_max_seconds",
        "interview_idle_seconds",
        "interview_max_sessions",
        "interview_vad_prefix_padding_ms",
        "interview_vad_silence_duration_ms",
    )
    @classmethod
    def _must_be_positive(cls, value: int, info: ValidationInfo) -> int:
        """Reject zero/negative at startup rather than mid-interview.

        An `INTERVIEW_MAX_SECONDS=0` typo otherwise means "close every session the
        instant it opens", which presents as a relay that connects and hangs up -
        indistinguishable from an upstream outage.
        """
        if value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer, got {value}")
        return value

    @field_validator("interview_vad_threshold")
    @classmethod
    def _threshold_in_range(cls, value: float) -> float:
        """An out-of-range threshold is rejected upstream with an `error` event
        that does NOT close the socket, so the interview would quietly run on the
        default while the config claimed otherwise. Fail loudly here instead."""
        if not 0.0 <= value <= 1.0:
            raise ValueError(f"interview_vad_threshold must be between 0.0 and 1.0, got {value}")
        return value

    @property
    def google_ready(self) -> bool:
        """Whether Google sign-in — the only way a human signs in — is configured.

        Exactly the two credentials, matching app/google_auth.py:sso_ready(),
        which is the function the router actually gates on: GOOGLE_REDIRECT_URI
        is an optional override that defaults correctly, so requiring it here
        would report the feature "off" on a deployment where it works. Without
        either credential the failure lands on a Google page we do not control
        and cannot translate, so it is caught here and the login screen keeps its
        Google button disabled with our own words on it.

        `.strip()` for the same reason `realtime_ready` does it: a value pasted
        into a shared .env routinely arrives with a trailing space, and
        whitespace is not a credential — it is a failure the student meets
        instead of the operator.
        """
        return bool(self.google_client_id.strip() and self.google_client_secret.strip())

    @property
    def roster_domain(self) -> str:
        """Domain appended when deriving a roster email from a USN.

        ROSTER_EMAIL_DOMAIN (or its COLLEGE_EMAIL_DOMAIN alias) wins; otherwise
        the FIRST GOOGLE_ALLOWED_DOMAIN entry — the student domain by
        convention, staff domains listed after it — so a single-domain college
        configures one variable and not two. NEVER empty: an empty domain would
        derive "1mp25mdm01@", which is not a failed lookup but an INSERT of a
        malformed address into a UNIQUE column.
        """
        explicit = self.roster_email_domain.strip().lstrip("@").lower()
        if explicit:
            return explicit
        first = self.google_allowed_domain.split(",")[0].strip().lstrip("@").lower()
        return first or _DEFAULT_COLLEGE_DOMAIN

    @property
    def realtime_ready(self) -> bool:
        """Whether the mock interview can run at all.

        Only the key is checked: model, base URL and voice all carry working
        defaults, so the key is the one thing an operator must supply. `.strip()`
        because a key pasted into a .env file routinely arrives with a trailing
        space or newline, and whitespace is not a credential - it is a 401 at
        handshake time, i.e. a failure the student meets instead of the operator.
        """
        return bool(self.openai_api_key.strip())

    @property
    def realtime_url(self) -> str:
        """Upstream WebSocket URL, with the model percent-encoded into the query.

        This is the ONLY place the URL is composed, so escaping happens exactly
        once. Dated model ids carry no unsafe characters today; `quote` costs
        nothing and removes the class of bug where a future one does.
        """
        model = self.openai_realtime_model.strip() or _DEFAULT_REALTIME_MODEL
        base = (self.openai_realtime_base_url.strip() or _DEFAULT_REALTIME_BASE_URL).rstrip("/")
        return f"{base}?model={quote(model, safe='')}"

    @property
    def transcription_model(self) -> str:
        """The input-transcription model id, resolved once for both API shapes.

        The BLANK fallback differs BY SURFACE. On GA the current id is right; on
        the BETA surface (OPENAI_REALTIME_BETA_HEADER non-empty) "whisper-1" is
        the id known to be accepted, and a rejected session.update there is not a
        degraded interview but a close 4002 at handshake. A `str` default is not
        the place to carry an unverified assumption when the code already knows
        which surface it is on.

        An EXPLICIT INTERVIEW_TRANSCRIPTION_MODEL always wins on both surfaces,
        so this only changes what an operator who set nothing receives.

        `.strip()` for the reason every other id here is stripped: a value
        pasted into a shared .env arrives with a trailing space, and " whisper-1"
        is not a model name - it is a rejected session.update the student meets
        as "the interview is down".
        """
        explicit = self.interview_transcription_model.strip()
        if explicit:
            return explicit
        if self.realtime_beta_header:
            return _BETA_TRANSCRIPTION_MODEL
        return _DEFAULT_TRANSCRIPTION_MODEL

    @property
    def realtime_beta_header(self) -> str:
        """The OpenAI-Beta header value, or "" meaning omit the header entirely."""
        return self.openai_realtime_beta_header.strip()

    @property
    def gemini_key_present(self) -> bool:
        """A Gemini/Google key from either the config field or the raw env."""
        import os

        return bool(
            self.gemini_api_key.strip()
            or os.getenv("GEMINI_API_KEY", "").strip()
            or os.getenv("GOOGLE_API_KEY", "").strip()
        )

    @property
    def voice_model_key_present(self) -> bool:
        """Whether the key the VOICE WORKER actually needs is configured.

        Voice runs as a cascade (silero VAD -> Groq Whisper -> Groq Llama ->
        TTS), so GROQ_API_KEY is what makes it work. This deliberately does NOT
        check the Gemini key: that was the old native speech-to-speech path, and
        gating on it would report voice "not configured" on a machine where it
        runs perfectly — or, worse, report it ready on one where it cannot."""
        import os

        return bool(self.groq_api_key.strip() or os.getenv("GROQ_API_KEY", "").strip())

    @property
    def livekit_ready(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)

    # Where uploaded files are stored on disk (only metadata lives in the DB).
    # Empty -> apps/api-py/var/uploads (gitignored). Object storage in production.
    upload_dir: str = ""

    @property
    def is_prod(self) -> bool:
        """Whether this process is serving real people. See _PROD_ENV_NAMES."""
        return self.env.strip().lower() in _PROD_ENV_NAMES

    @property
    def password_login_allowed(self) -> bool:
        """Whether POST /api/auth/login may answer at all.

        Sign-in is Google-only for humans; that endpoint is a dev/CI affordance,
        kept because tests/conftest.py's `login` fixture and the test modules
        that use it cannot drive an OAuth round-trip from a TestClient. Keyed on
        the environments it SERVES rather than on `not is_prod`, so an ENV nobody
        anticipated ("staging", a typo, an empty string from a broken deploy)
        refuses rather than admits: the failure mode of a misconfiguration here
        must be "nobody can use a password", never "anyone can".
        """
        return self.env.strip().lower() in _PASSWORD_LOGIN_ENV_NAMES

    @property
    def uploads_path(self) -> Path:
        """Resolved directory for the file store (created on first use)."""
        if self.upload_dir.strip():
            return Path(self.upload_dir)
        return Path(__file__).resolve().parent.parent / "var" / "uploads"

    @property
    def allow_remote_student_data(self) -> bool:
        return self.llm_allow_remote_student_data.strip().lower() == "true"

    # Query params that belong to Prisma and mean nothing to libpq. Only these
    # are stripped — see sqlalchemy_url.
    _PRISMA_ONLY_PARAMS = frozenset({"schema", "connection_limit", "pgbouncer"})

    @property
    def sqlalchemy_url(self) -> str:
        """Normalise the DB URL for SQLAlchemy + psycopg 3.

        Forces the `+psycopg` driver (so a plain `postgresql://` does not fall
        back to psycopg2) and drops the Prisma-only query params left over from
        the old stack.

        It drops ONLY those. This used to end `return url.split("?", 1)[0]`,
        discarding the entire query string — which silently threw away
        `sslmode`. Every managed Postgres (Neon, RDS, Supabase, Cloud SQL) hands
        you `...?sslmode=require`, so the connection fell back to libpq's default
        `prefer`: TLS opportunistic, server certificate never verified, nothing
        logged and nothing failed. An operator who set sslmode=require in the
        secret had every reason to believe it applied while student records
        crossed the network on an unauthenticated channel.
        """
        url = self.database_url
        if url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url[len("postgresql://") :]

        base, sep, query = url.partition("?")
        if not sep:
            return base

        kept = [
            pair
            for pair in query.split("&")
            if pair and pair.split("=", 1)[0] not in self._PRISMA_ONLY_PARAMS
        ]
        return f"{base}?{'&'.join(kept)}" if kept else base


settings = Settings()
