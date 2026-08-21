"""Application settings, read from the environment / apps/api-py/.env.

Field names map to env vars case-insensitively (database_url <- DATABASE_URL).
"""

from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import AliasChoices, Field, ValidationInfo, field_validator, model_validator
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

# The environments allowed to keep their DEVELOPMENT AFFORDANCES — an
# ALLOWLIST, not the complement of _PROD_ENV_NAMES, because the two guards must
# fail in opposite directions. A typo'd ENV must mean "the cookie is Secure and
# the password door is shut", never "neither". ENV is "dev" by default and CI
# sets nothing, so the suite and every laptop keep the doors they already have.
#
# Three guards read it, all through _is_dev_env below: password sign-in
# (password_login_allowed), a session cookie without `Secure`
# (insecure_cookies_allowed) and an unauthenticated voice worker
# (worker_auth_optional). The 2026-08 audit found the last two keyed on
# `is_prod` instead, which is a NAME TEST: a `staging`/`uat`/`demo` box — real
# roster rows, real HTTPS, real students — is not one of the four prod
# spellings, so it was handed a sniffable session cookie and an open
# /api/voice/heartbeat because nobody had typed the magic word.
_DEV_ENV_NAMES = frozenset({"dev", "development", "test", "testing", "ci", "local"})

# The committed development credentials. They are FIELD DEFAULTS AND GUARD
# INPUTS in one place on purpose: the boot check in
# Settings.production_boot_failures compares against these constants, so a
# future edit to a default cannot leave the guard testing a string nobody uses
# any more. Both are also printed in .env.example, i.e. in the repository, i.e.
# known to everyone who has ever cloned it.
_DEV_DATABASE_URL = "postgresql+psycopg://reep:reep_dev_password@localhost:5433/reep_py"
_DEV_DB_PASSWORD = "reep_dev_password"
_DEV_AUTH_SECRET = "reep-dev-secret-change-me-in-production-0123456789abcdef"

# Substrings that mean "nobody has replaced this yet". A secret edited from the
# committed default by a couple of characters is not a new secret, and the
# equality test above would pass it. Kept deliberately short and specific:
# a real random secret can contain "secret", so that word is NOT on the list.
_PLACEHOLDER_SECRET_MARKERS = ("change-me", "changeme", "change_me", "your-secret")

# Minimum AUTH_SECRET length in production. HS256 signs with the raw bytes of
# this string and its digest is 32 bytes; a key shorter than the digest adds no
# strength beyond its own length, and a short one is guessable offline from a
# single captured cookie. 32 is also the floor .env.example has always claimed
# (">= 32 chars") — this only makes the file's own promise enforceable.
AUTH_SECRET_MIN_CHARS = 32

# How to replace it, quoted verbatim in every refusal below. An operator meeting
# a boot failure at 2am needs the command, not a policy.
_NEW_SECRET_HINT = (
    'Generate one and set AUTH_SECRET in apps/api-py/.env: '
    'python -c "import secrets; print(secrets.token_hex(32))". '
    "Changing it signs out every live session, which is the correct trade."
)


def _is_dev_env(env: str) -> bool:
    """Whether `env` names an environment that may keep its dev affordances.

    One allowlist behind three fail-closed guards (see _DEV_ENV_NAMES). Anything
    unrecognised — "staging", "uat", a typo, an empty string from a half-written
    deploy template — is treated as production-like: it loses the password door,
    it gets `Secure` cookies, and it must authenticate its voice worker.
    """
    return env.strip().lower() in _DEV_ENV_NAMES


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, extra="ignore")

    # BOTH of the next two defaults are development credentials published in this
    # repository, and BOTH are refused at boot when ENV is production — see
    # production_boot_failures() at the bottom of this class for what each one
    # costs if it reaches a real deployment.
    database_url: str = _DEV_DATABASE_URL
    # Signs the HS256 `reep_session` cookie (app/security.py) AND derives the
    # OAuth flow-cookie key (app/google_auth.py). Whoever knows it IS every user:
    # a forged {"role":"DIRECTOR"} claim reads every student's marks, attendance
    # and USN, and no login, no Google round-trip and no DB row is involved.
    auth_secret: str = _DEV_AUTH_SECRET
    web_origin: str = "http://localhost:4200"
    env: str = "dev"
    # Whether /docs, /redoc and /openapi.json are mounted. True here, and OFF in
    # production unless the operator sets DOCS_ENABLED on purpose — `docs_exposed`
    # below is what app/main.py actually reads, and it explains why the default
    # cannot be the whole answer. The endpoints stay authenticated either way;
    # what an open schema hands out is the MAP — every route, every field name,
    # every enum value, staff-only ones included — which is what turns "find an
    # endpoint" into "read the list".
    docs_enabled: bool = True
    # Sessions are stateless 12-hour HS256 JWTs, so `POST /api/auth/logout`
    # deleting the cookie does nothing to a token that was already copied (audit
    # M8). A revocation deny-list closes that; this is how long one decision may
    # be cached in-process before the DB is asked again — i.e. the window in
    # which a logged-out token still works. 60 s keeps "log out on the shared lab
    # machine" honest within a minute at a cost of one small query per user per
    # minute. 0 is legal and means "ask the database every request", which is the
    # value to use the day a per-worker cache looks like the wrong trade.
    auth_revocation_cache_seconds: int = 60

    # --- SQLAlchemy connection pool (app/db.py) --------------------------------
    # These used to be SQLAlchemy's silent defaults (pool_size=5, max_overflow=10,
    # pool_timeout=30), which made 15 connections the whole app's ceiling with no
    # env var to raise it — the 2026-08 scalability audit's first critical. Every
    # sync endpoint holds one connection for its whole handler, so two students
    # loading the 10-fetch dashboard at once already wanted 20. The new defaults
    # fit a single dev process; a production deployment sizes them per worker so
    # that workers x (pool_size + max_overflow) stays under Postgres
    # max_connections (docker-compose.prod.yml does this arithmetic in comments).
    # pool_timeout drops from 30 to 5: a request that cannot get a connection in
    # 5 s is already part of an incident, and making it queue for 30 more only
    # converts one slow endpoint into a wall of hung requests.
    db_pool_size: int = 20
    db_max_overflow: int = 20
    db_pool_timeout_s: int = 5

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
    # Was 300000 (5 minutes). Every LLM call runs synchronously in the shared
    # 40-thread pool, and generate_resume used to hold a pooled DB connection
    # across it too — so one hung provider could pin threads for 5 minutes each
    # and turn a slow model into a dashboard outage (audit critical #2). 60 s is
    # generous for a resume brief; a provider that has not answered in a minute
    # is not going to, and the deterministic fallback path exists precisely for
    # that day. Raise it only for a deliberately slow local model, and know that
    # the price is how long one request can occupy a worker thread.
    llm_timeout_ms: int = 60000
    # Per-user ceiling on LLM-backed HTTP requests (app/ratelimit.py): resume
    # generation and the retained /api/agent chat routes. The audit found these
    # had no cap at all, so one student's retry loop — or a 60-person class told
    # to "regenerate until it looks good" — was a self-inflicted DDoS on the
    # thread pool and an unbudgeted token bill. 5/minute is invisible to a human
    # clicking a button and a wall to a loop. The bucket is per worker process,
    # so N workers relax it to at most N x this — still a ceiling, and an
    # in-process dict costs nothing; a shared store is the day-two upgrade.
    llm_requests_per_minute: int = 5
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
    # The voice twin of interview_max_sessions_per_user below (audit H2). Tokens
    # were minted without limit, one fresh room each, and the token TTL bounds
    # only how long a student has to JOIN — never how long the call runs. One
    # scripted mint-and-join loop therefore costs unbounded worker memory and
    # unbounded Groq spend from a single enrolled account. 2 (not 1) so a student
    # whose browser died mid-call can start again without waiting out the old
    # room; raising it multiplies what one account can spend.
    voice_max_sessions_per_user: int = 2
    # ...and the call itself gets a clock, which it has never had. Matched to
    # interview_max_seconds on purpose: a student must not get a longer free
    # session by taking the rollback path. Too low cuts a real conversation off
    # mid-sentence, and there is deliberately no value meaning "unlimited".
    voice_max_call_seconds: int = 900

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
    # The other half of that cap, and the one the audit (H1) found missing: the
    # limiter above counts sessions and never asks WHOSE they are. One student
    # looping `new WebSocket('/api/interview')` from devtools takes every slot —
    # each socket authenticates, opens an upstream session, and BILLS from the
    # handshake's response.create with no microphone input at all — and everyone
    # else is answered 1013. 2 (not 1) so a student whose laptop slept mid-answer
    # can start again without waiting for the dead socket's watchdog to notice.
    interview_max_sessions_per_user: int = 2
    # The VOLUME half of the per-student cap, which concurrency alone never was:
    # 2 concurrent slots x back-to-back 15-minute sessions is ~96 interviews a
    # day from one account — each one billing OpenAI Realtime audio from the
    # handshake — and nothing counted them (audit H: unbounded spend). Enforced
    # in _open_records with one indexed COUNT over the student's sessions in the
    # last 24 h, refused with close 4015 BEFORE any upstream socket opens or row
    # is written. 8 is a full afternoon of honest practice; a student who hits
    # it is looping, sharing a cookie, or being scripted. Abandoned and failed
    # sessions COUNT toward it on purpose — a cap that only counts clean
    # finishes is a cap a crash loop never hits.
    interview_max_per_student_per_day: int = 8

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

    # --- Interview Engine v3: the relay owns the turn, not the upstream VAD ----
    # v3 runs `turn_detection.create_response: false`, so end-of-speech no longer
    # creates the next question by itself: the relay waits for the transcript,
    # validates the answer, ticks the phase machine and only then asks. One
    # question is open at a time BY CONSTRUCTION rather than by asking the model
    # nicely. Everything in this block is a consequence of that trade — with the
    # upstream no longer driving, every wait needs a deadline and every loop
    # needs a stop, or a stalled dependency becomes an interview that never
    # continues and reports no fault to anyone.
    #
    # How long to wait for the STUDENT's transcript after the audio buffer
    # commits before giving up on it. On expiry the turn is recorded with an
    # unknown transcript and the next question is asked anyway: the interview
    # must never stall on a transcriber. Too low and real answers land unscored;
    # too high and the student sits in dead air they read as a hang.
    interview_transcription_timeout_ms: int = 8000
    # How long to wait for OUR OWN response.create to be acknowledged with a
    # response.created before assuming upstream dropped it. Under v3 the relay
    # is the only party that creates a response, so a create that vanishes is
    # an interview that never continues: the student sits in silence, the idle
    # watchdog does not fire (the browser's echo-gate keepalive keeps sending
    # frames), and only the 15-minute cap ends it -- with no verdict. On expiry
    # the create is retried once with a fresh event id; a second expiry closes
    # the socket 4011 so the student is told to start again instead of waiting.
    # Wider than a healthy acknowledgement (~200 ms) because a busy upstream is
    # slow, not gone.
    interview_response_create_timeout_ms: int = 10000
    # The deterministic answer gate — a word count, not a model call, because
    # this runs on the hot path between the student finishing and the
    # interviewer replying, and a round-trip here is latency every single turn.
    # Below this many words the transcript is not treated as an answer: it earns
    # a clarification and does NOT advance the phase machine. 4 clears "yes",
    # "I don't know" and a cough transcribed as "uh", while leaving a real short
    # answer ("I led the campus fintech club") intact. 0 disables the gate — the
    # pre-v3 behaviour, where anything at all counted as an answer.
    interview_min_answer_words: int = 4
    # How many times ONE question may be re-asked before the interviewer accepts
    # whatever it got and moves on. The cap is the entire point: without it a
    # student who answers "yes" three times, or a transcriber returning noise,
    # pins the interview on question 2 until the hard cap ends it with no
    # verdict at all. 0 means never clarify.
    interview_max_clarifications_per_question: int = 1
    # Budget for the final scorecard: one extra, text-only response.create issued
    # after the spoken wrap-up verdict, in the same session that already holds
    # the transcript. It is the LAST thing in a session, so the student is
    # sitting on a finished interview waiting for it. On expiry the evaluation is
    # persisted as unavailable and the socket still closes 1000 — a missing
    # report must never cost the transcript.
    # ---- Which engine runs the interview -------------------------------
    #
    # "openai"  app/interview_relay.py -> api.openai.com. One speech-to-speech
    #           model hears, reasons and speaks. Needs OPENAI_API_KEY and costs
    #           money per minute.
    # "local"   app/interview_local.py -> nothing leaves the machine.
    #           faster-whisper hears, the Ollama model in LLM_MODEL reasons,
    #           Piper speaks. No key, no cost, and rule 1 holds by construction
    #           rather than by a gate.
    #
    # DEFAULT IS "openai" deliberately, even though the local engine is free: a
    # deployment that has been running the hosted interview must not silently
    # change what its students are assessed by because a new setting appeared.
    # Opting in is one line; opting out by surprise is not recoverable, because
    # the interviews have already happened.
    interview_engine: str = "openai"

    @field_validator("interview_engine", mode="before")
    @classmethod
    def _known_engine(cls, value: object) -> str:
        """An unrecognised engine name falls back to the hosted relay.

        Deliberately an ALLOWLIST rather than `!= "local"`: a typo like
        INTERVIEW_ENGINE=loca must not quietly run the hosted engine while the
        operator believes nothing is leaving the machine. It falls back to the
        documented default and says so, which is the same shape as
        `password_login_allowed` -- an unknown value closes the door rather than
        guessing which one was meant.
        """
        text = str(value or "").strip().lower()
        if text in {"openai", "local"}:
            return text
        if text:
            import logging

            logging.getLogger(__name__).warning(
                "INTERVIEW_ENGINE=%r is not 'openai' or 'local'; using 'openai'", value
            )
        return "openai"

    # The interviewer's model, SEPARATE from llm_model on purpose.
    #
    # llm_model serves the resume builder and the grounded assistant, where a
    # bigger model is simply better and a few seconds is nobody's problem. The
    # interviewer has two constraints that one does not: it must leave room on
    # the card for faster-whisper, and it must answer inside a conversation.
    #
    # Measured on this hardware, the cost of ignoring that: reep-gemma3 (7.8 GB)
    # resident alongside Whisper left 1 GB free on a 12 GB card and the first
    # clause took 9528 ms. llama3.2:3b (2 GB) leaves ~9 GB and returns in tens
    # of milliseconds. A smaller interviewer that speaks is worth more than a
    # better one that pauses for ten seconds between questions.
    #
    # Blank falls back to llm_model, so a deployment with plenty of VRAM can
    # deliberately run one model for everything.
    interview_local_llm_model: str = "llama3.2:3b"

    # faster-whisper size. base.en is the measured balance on this hardware:
    # ~28 ms for a 0.6 s tail on CUDA. tiny.en is faster and noticeably worse at
    # Indian-accented English; small.en is better and roughly 2.5x the latency.
    interview_local_stt_model: str = "base.en"
    # Decode width. beam_size=1 is greedy and was the obvious default; measured
    # on this cohort's own recordings it is both LESS accurate and SLOWER than 5
    # (157 ms vs 116 ms on a 6 s clip), because a wrong greedy token costs more
    # decoding downstream than the extra beams cost up front.
    interview_local_stt_beam: int = 5
    # Strip silence before decoding. The single biggest accuracy win measured
    # here, and it takes the average DOWN to 87 ms: less audio to decode, and no
    # silence for the model to hallucinate words into. It recovered a whole
    # clause the greedy config dropped.
    interview_local_stt_vad_filter: bool = True
    # Domain vocabulary. Whisper leans on an initial prompt for terms it has not
    # heard in context, and this cohort's interview is full of them -- a real
    # session transcribed "CAC" as "DCAC", which then cleared the answer-word
    # floor as a substantive answer and advanced the interview on nothing.
    interview_local_stt_prompt: str = (
        "This is a digital marketing interview. Terms used: CAC, LTV, ROAS, "
        "CTR, CPC, CPM, SEO, SEM, P-O-E-M, impressions, clicks, conversions, "
        "funnel, remarketing, programmatic, backlinks, crawling, indexing."
    )

    # "cuda" or "cpu". A CUDA failure is caught at load and falls back to CPU
    # rather than refusing to start the interview -- slow beats unavailable.
    interview_local_stt_device: str = "cuda"
    # Piper voice, absolute or relative to apps/api-py.
    interview_local_tts_voice: str = "var/piper-voices/en_US-lessac-medium.onnx"
    # How long Ollama keeps the interviewer model resident. An interview that
    # pays a cold load mid-conversation has a multi-second silence in it.
    interview_local_keep_alive: str = "30m"
    # The interviewer's instructions are ~2.6 kB composed; 4096 leaves room for
    # the phase directive and the syllabus block without a per-turn reload.
    interview_local_num_ctx: int = 4096
    # One question is tens of tokens. A ceiling against a model that decides to
    # monologue, not a target -- and deliberately not the primary control for
    # length, because a token cap truncates mid-sentence. The instruction does
    # that job; this catches the case where it is ignored entirely.
    interview_local_max_tokens: int = 120

    interview_report_timeout_ms: int = 20000
    # Audio capture, OFF and deliberately awkward to turn on. Recording a
    # student's voice requires their recorded consent (interview_consent_version
    # below) AND this flag AND a retention deadline, and the audio is retrievable
    # by DIRECTOR/ADMIN only. Flipping this true without the consent row in place
    # is the failure that matters here: it is the one that cannot be undone after
    # the fact.
    interview_recording_enabled: bool = False
    # Hard per-session ceiling on stored audio — a disk-exhaustion stop, not a
    # quality knob. At the cap the recording stops and the interview continues:
    # a call is never dropped to protect a file.
    #
    # SIZE IT AGAINST 96,000 BYTES A SECOND, NOT 48,000. This comment used to
    # read "64 MB is roughly 45 minutes ... comfortably past
    # interview_max_seconds", which was true of the speech-only capture it was
    # written for. app/interview_audio.py now pads BOTH tracks to the session's
    # wall clock, so an interview burns 2 x 24 kHz x 16-bit whether anyone is
    # talking or not: 64,000,000 B was 666 s = 11.1 min against an
    # interview_max_seconds of 900, and every maximum-length interview lost its
    # last 3.8 minutes to a cap nobody had recomputed. A truncation is at least
    # never silent (audio_truncated), which is the only reason that was a defect
    # and not a scandal.
    #
    # The floor is therefore 2 x interview_max_seconds x 48,000 = 86.4 MB, and
    # 128 MB is that plus ~48% — headroom for a model that emits an answer
    # faster than real time (the interviewer's track legitimately runs ahead of
    # the clock) and for the seconds a session spends closing. Disk, which is a
    # different number: the mix is written from what survived, so a full session
    # occupies up to ~256 MB. If you move interview_max_seconds, move this.
    interview_recording_max_bytes: int = 128000000
    # Where the WAVs live. Blank keeps the historical fallback — a SIBLING of
    # uploads_path named interview-audio (app/interview_audio.py:_store_root,
    # which already reads this field by name and documents why a sibling). Set
    # it explicitly in production to a MOUNTED path: the audit found the
    # fallback landed in the container's writable layer under the image's
    # UPLOAD_DIR, i.e. consented recordings were destroyed on every redeploy.
    # docker-compose.prod.yml now mounts a dedicated volume and sets this.
    interview_audio_dir: str = ""
    # Free-disk floor below which recorder_for hands out NO new recorders: the
    # interview proceeds, existing recordings keep flushing, only NEW capture is
    # declined (and says so in the log). Recording is wall-clock-padded at
    # 96,000 B/s, so a deadline-week of interviews can genuinely fill a volume —
    # and a full disk stops upload writes and (co-located) Postgres too, which
    # is a far worse trade than one interview going unrecorded. 2 GB clears the
    # worst case of every in-flight session flushing its cap at once. This is a
    # guard on NEW recordings only, never a reason to end a call.
    interview_audio_min_free_bytes: int = 2000000000
    # How long an interview record — transcript, evaluation, any audio — is kept
    # before the reaper deletes it. 180 days covers a placement season and the
    # review that follows it. There is no "keep forever" value and 0 is refused,
    # because the two honest readings of 0 ("delete immediately" and "never
    # delete") differ by the entire record.
    interview_retention_days: int = 180
    # How long an interview_sessions row may sit in `running` with no heartbeat
    # before the sweeper marks it `abandoned`. A killed worker cannot finalize
    # its own sessions, so without this every crash leaves rows that claim to be
    # live forever. interview_max_seconds (900) + 300 s of slack: comfortably
    # past the longest legal interview, so a HEALTHY session is never swept, and
    # short enough that a deploy's restart sweep tidies the previous process's
    # wreckage rather than yesterday's. The relay's heartbeat write is what
    # feeds it; if that write fails all session long the row is swept while
    # alive, which is the right direction to fail -- visible and arguable,
    # rather than invisible and stuck at `running`.
    interview_orphan_grace_seconds: int = 1200
    # Stamped on every consent row so a change of terms is visible in the data
    # instead of assumed. Consent is NOT retroactive: bump this when what the
    # student agrees to changes, and rows carrying the old string stop counting
    # as consent for the new terms — which is exactly what should happen. A date
    # is enough; nothing parses it, and it sorts.
    interview_consent_version: str = "2026-08"

    @field_validator(
        "llm_timeout_ms",
        "llm_requests_per_minute",
        "db_pool_size",
        "db_max_overflow",
        "db_pool_timeout_s",
        "interview_max_seconds",
        "interview_idle_seconds",
        "interview_local_num_ctx",
        "interview_local_stt_beam",
        "interview_local_max_tokens",
        "interview_max_sessions",
        "interview_max_sessions_per_user",
        "interview_max_per_student_per_day",
        "interview_transcription_timeout_ms",
        "interview_response_create_timeout_ms",
        "interview_min_answer_words",
        "interview_max_clarifications_per_question",
        "interview_report_timeout_ms",
        "interview_recording_enabled",
        "interview_recording_max_bytes",
        "interview_retention_days",
        "interview_orphan_grace_seconds",
        "interview_audio_min_free_bytes",
        "interview_vad_threshold",
        "interview_vad_prefix_padding_ms",
        "interview_vad_silence_duration_ms",
        "voice_max_sessions_per_user",
        "voice_max_call_seconds",
        "auth_revocation_cache_seconds",
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

        EVERY NEW NUMERIC OR BOOLEAN FIELD BELONGS ON THE LIST ABOVE. bool is not
        exempt: `INTERVIEW_RECORDING_ENABLED=` raises "Input should be a valid
        boolean" at import in exactly the same way, and str fields need it only
        because "" already means "off" for them. `docs_enabled` is the single
        deliberate absence - its PRESENCE in the environment, not just its value,
        decides something (see docs_exposed), so a blank line for it is dropped
        earlier by _blank_docs_flag_is_not_an_opt_in rather than defaulted here.
        """
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name].default
        return value

    @field_validator(
        "llm_requests_per_minute",
        "db_pool_size",
        "db_max_overflow",
        "db_pool_timeout_s",
        "interview_max_seconds",
        "interview_idle_seconds",
        "interview_local_num_ctx",
        "interview_local_stt_beam",
        "interview_local_max_tokens",
        "interview_max_sessions",
        "interview_max_sessions_per_user",
        "interview_max_per_student_per_day",
        "interview_transcription_timeout_ms",
        "interview_response_create_timeout_ms",
        "interview_report_timeout_ms",
        "interview_recording_max_bytes",
        "interview_retention_days",
        "interview_orphan_grace_seconds",
        "interview_audio_min_free_bytes",
        "interview_vad_prefix_padding_ms",
        "interview_vad_silence_duration_ms",
        "voice_max_sessions_per_user",
        "voice_max_call_seconds",
    )
    @classmethod
    def _must_be_positive(cls, value: int, info: ValidationInfo) -> int:
        """Reject zero/negative at startup rather than mid-interview.

        An `INTERVIEW_MAX_SECONDS=0` typo otherwise means "close every session the
        instant it opens", which presents as a relay that connects and hangs up -
        indistinguishable from an upstream outage. The same shape repeats across
        this list: 0 sessions per user is "nobody may interview", a 0 ms
        transcription deadline is "every answer is unknown", 0 retention days is
        a record that may already be gone. None of them is a thing an operator
        meant to type, and all of them look like an outage rather than a config
        error from the outside.
        """
        if value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer, got {value}")
        return value

    @field_validator(
        "interview_min_answer_words",
        "interview_max_clarifications_per_question",
        "auth_revocation_cache_seconds",
    )
    @classmethod
    def _must_not_be_negative(cls, value: int, info: ValidationInfo) -> int:
        """The three settings where 0 is a MEANING, not a typo.

        Deliberately not on the positive-only list above, and do not "fix" the
        omission by moving them: for these three, zero is the switch that turns a
        v3 behaviour off and returns the older one. 0 answer words accepts every
        transcript (the pre-v3 gate); 0 clarifications never re-asks a question;
        0 cache seconds asks the database about revocation on every request,
        which is the SAFEST value here rather than the broken one. Negative is
        still nonsense, and a negative deadline would read as "already expired"
        at every call site that compares against it.
        """
        if value < 0:
            raise ValueError(f"{info.field_name} must be zero or a positive integer, got {value}")
        return value

    @model_validator(mode="before")
    @classmethod
    def _blank_docs_flag_is_not_an_opt_in(cls, values: Any) -> Any:
        """A blank `DOCS_ENABLED=` line means UNSET, not "the operator chose".

        `docs_exposed` asks pydantic which fields a source actually supplied
        (`model_fields_set`), because in production the field default True is not
        consent — somebody has to say so. But a source that supplies the key with
        an EMPTY value lands in model_fields_set exactly like a real "true"
        would, so one stray blank line in a shared .env would republish the whole
        API surface on a production host. Dropping the key restores "blank means
        unset" for the one field whose presence, not just value, changes
        behaviour — and it is why docs_enabled is absent from _blank_is_default:
        by the time that validator would run, this has already made the field
        look untouched.
        """
        if isinstance(values, dict):
            return {
                key: raw
                for key, raw in values.items()
                if not (
                    key.lower() == "docs_enabled"
                    and isinstance(raw, str)
                    and not raw.strip()
                )
            }
        return values

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
        return _is_dev_env(self.env)

    @property
    def insecure_cookies_allowed(self) -> bool:
        """Whether the session and OAuth-state cookies may be issued WITHOUT
        `Secure` — i.e. whether this box is allowed to be plain HTTP.

        Read it as `secure=not settings.insecure_cookies_allowed` at the
        set_cookie sites in app/routers/auth.py. It replaces `secure=is_prod`,
        which was a NAME TEST and the audit's M2: a `staging`, `uat` or `demo`
        box is not one of the four spellings is_prod knows, so it served REAL
        roster rows over HTTPS while marking the session cookie non-Secure —
        meaning one downgraded or plain-HTTP request (a bookmarked http:// link,
        a mixed-content asset, an attacker who can force one) puts a
        12-hour-valid session token on the wire in the clear.

        Keyed on the dev allowlist instead, so only the environments that
        genuinely run on http://localhost keep the affordance and everything
        unrecognised gets the safe behaviour. The dev cost of getting this
        backwards is visible immediately (no cookie is stored on http://), which
        is the right direction for a mistake to fail in.
        """
        return _is_dev_env(self.env)

    @property
    def worker_auth_optional(self) -> bool:
        """Whether a blank VOICE_WORKER_SECRET may leave the worker endpoints
        open (POST /api/voice/heartbeat and /api/voice/transcript).

        The same move as insecure_cookies_allowed, for the audit's M1. Those two
        endpoints were open whenever the secret was blank AND ENV was not exactly
        prod, so a `staging` box — or a deploy whose ENV arrived empty — let
        anyone who could reach the port forge a heartbeat (voice then reports
        itself available and students are handed tokens into rooms no agent ever
        joins) and write assistant-labelled turns into any conversation whose
        32-hex id they observed, where they render in the UI and replay into
        later prompts.

        Blank-is-open is a real dev convenience — the worker is a fourth process
        in its own venv and making people copy a secret to try it once is how
        "voice is broken" reports start — so it survives, narrowed to the
        environments that are actually somebody's laptop.
        """
        return _is_dev_env(self.env)

    @property
    def docs_exposed(self) -> bool:
        """Whether app/main.py mounts /docs, /redoc and /openapi.json.

        Dev keeps them: they are how this API is explored, and AGENTS.md sends a
        newcomer to http://127.0.0.1:3300/docs on their first run.

        Production drops them unless DOCS_ENABLED says otherwise IN THE
        ENVIRONMENT. That is why this is not simply `self.docs_enabled`: the
        field default is True and a default is not a decision, so a deploy that
        sets nothing must not publish the full surface. `model_fields_set` is
        pydantic's record of which fields a source actually supplied, which makes
        "DOCS_ENABLED appears in the environment" the opt-in signal;
        _blank_docs_flag_is_not_an_opt_in above keeps a blank line from counting
        as one. `DOCS_ENABLED=false` still turns them off everywhere, dev
        included, because an explicit no is an answer in both directions.
        """
        if not self.docs_enabled:
            return False
        return not self.is_prod or "docs_enabled" in self.model_fields_set

    def production_boot_failures(self) -> list[str]:
        """Configuration this process must not serve real people with.

        Returns one sentence per problem, each naming the variable and the fix;
        empty means "nothing here is fatal". app/main.py's lifespan calls this
        and refuses to start when it comes back non-empty — the check lives here
        because these constants live here, and the REFUSAL lives there because
        boot is where an operator meets it.

        EMPTY ON EVERY NON-PRODUCTION ENV, and that is load-bearing: the test
        suite boots the real app through TestClient with ENV=dev and would
        otherwise need to know a secret. It is also the reason this is a hard
        failure rather than a warning — it can only fire on a host that has
        declared itself production, where "the log said something" is not a
        control. app/seed.py's ENV=prod refusal has the same shape and the same
        deliberate absence of an override flag: an escape hatch here would be
        found, used, and end with the committed secret live on the internet.

        Nothing in the returned text ever contains the secret or the URL itself.
        These messages land in deploy logs and aggregators, which is precisely
        where a credential must not be copied to.
        """
        if not self.is_prod:
            return []

        problems: list[str] = []

        secret = self.auth_secret.strip()
        placeholder = any(marker in secret.lower() for marker in _PLACEHOLDER_SECRET_MARKERS)
        if not secret:
            problems.append(f"AUTH_SECRET is blank or whitespace. {_NEW_SECRET_HINT}")
        elif secret == _DEV_AUTH_SECRET or placeholder:
            problems.append(
                "AUTH_SECRET is still the development value published in this "
                "repository (.env.example). It signs the reep_session cookie and "
                "derives the OAuth flow-cookie key, so anyone who has read the repo "
                'can sign {"role":"DIRECTOR"} for themselves and read every '
                "student's marks, attendance and USN — no login, no Google, no DB "
                f"row involved. {_NEW_SECRET_HINT}"
            )
        elif len(secret) < AUTH_SECRET_MIN_CHARS:
            problems.append(
                f"AUTH_SECRET is {len(secret)} characters; the floor is "
                f"{AUTH_SECRET_MIN_CHARS}, because HS256 signs with these bytes and a "
                "key shorter than its 32-byte digest is brute-forceable offline from "
                f"one captured cookie. {_NEW_SECRET_HINT}"
            )

        # A REFUSAL, not a warning, and the call was close enough to write down.
        # The password is published in this repo and in .env.example, so a
        # production database reachable with it is a production database that
        # anyone who cloned us can read every student's records from. The two
        # cases it catches are both bad and neither is subtle: the whole default
        # URL untouched means production is about to serve a developer's laptop
        # database (empty dashboards that read as a working deploy, or a
        # connection refused on every request), and a real host carrying this
        # password means the credential needs one ALTER ROLE. The argument for a
        # warning is that an operator on a private network may have chosen it —
        # but that operator can change one env var, while nobody can un-leak a
        # student roster, and a warning in a deploy log is a thing nobody reads.
        if _DEV_DB_PASSWORD in self.database_url:
            problems.append(
                "DATABASE_URL still carries the development password published in "
                "this repository (.env.example). Point it at the production database "
                "with a credential that is not in the repo; if that database really "
                "does use this password, change the password first (ALTER ROLE reep "
                "WITH PASSWORD ...) — anyone who has cloned REEP knows it."
            )

        return problems

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
