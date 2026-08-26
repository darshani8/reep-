"""FastAPI application entrypoint.

Run (dev):  uvicorn app.main:app --port 3300
Docs:       http://localhost:3300/docs

(No --reload: on Windows it has wedged a stale worker here. See AGENTS.md.)
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import retention
from .config import settings
from .db import SessionLocal
from .traceability import RequestTraceMiddleware
from .routers import (
    agent,
    alumni,
    auth,
    badge_verification,
    badges,
    director,
    health,
    interview,
    leave,
    mentee_records,
    mentor,
    registration,
    staff_upskilling,
    student,
    student_programme,
    voice,
)

log = logging.getLogger("reep.startup")

# Sentry is the ONE observability + traceability tool (user decision, 2026-08):
# errors and performance traces from api and web land in one place, joined to
# raw CloudWatch log lines by the X-Request-ID tag app/traceability.py sets.
# Initialised at import time — before the app object — so even lifespan/boot
# failures are captured. Blank SENTRY_DSN = not initialised = every downstream
# sentry_sdk call is a no-op; a laptop and CI pay nothing.
#
# send_default_pii=False is load-bearing: with it off the SDK does not attach
# cookies (the reep_session token!) or user context. Telemetry gets stack
# traces, timings and tags — never a student's text or a signed credential.
if settings.sentry_dsn.strip():
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn.strip(),
        environment=settings.env.strip() or "development",
        traces_sample_rate=settings.sentry_traces_rate,
        send_default_pii=False,
    )
    log.info("Sentry initialised (traces_sample_rate=%s)", settings.sentry_traces_rate)


def _sweep_orphaned_interviews() -> int:
    """Layer 3 of interview finalization, run once per boot. See the call site
    in `lifespan` below, which is where the reasoning lives.

    Its own function so that call stays a single readable line, and so the
    session is opened AND closed on the worker thread — a `Session` is not safe
    to hand across threads, and the one thing worse than an unswept orphan is a
    connection shared by two of them.
    """
    with SessionLocal() as db:
        return retention.finalize_orphaned_interviews(db)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Clamp what may be logged, then two configuration gates before we serve.

    Boot is where the gates belong. `Settings` can decide what is wrong, but only
    startup can REFUSE, and startup is the moment an operator is actually
    watching; anything checked later is checked at request time, by which point
    the process is already answering students.
    """
    # A HARD FLOOR, not a preference. At DEBUG the `websockets` library prints
    # the outbound handshake header by header (ClientProtocol.send_request,
    # guarded by Protocol.debug = logger.isEnabledFor(DEBUG)) and redacts
    # nothing -- and one of those headers is
    # `Authorization: Bearer <OPENAI_API_KEY>` on the interview relay's upstream
    # socket (app/interview_relay.py). Running uvicorn with --log-level debug is
    # a documented troubleshooting step, so without this the operator following
    # the manual is the one who prints the credential into the API log, beside
    # student traffic, in whatever aggregator this deployment ships to. That
    # would defeat the containment the relay exists to provide.
    # Protocol.debug is evaluated per connection at connect time, i.e. after
    # this runs, and websockets.client/.server are NOTSET so they inherit it.
    logging.getLogger("websockets").setLevel(logging.INFO)

    # 1) REFUSE to serve real people with the credentials published in this repo.
    #
    # Settings.production_boot_failures() decides (it owns the defaults, so it
    # cannot end up comparing against a string nobody uses); this raises. It is
    # fatal rather than a warning, and there is no override flag, for the reason
    # app/seed.py's ENV=prod refusal gives: a warning about a leaked signing key
    # is a line in a log nobody reads, and the deployment it describes is one
    # forged cookie away from every student's marks, attendance and USN. The
    # check returns [] on every non-production ENV, so a laptop, CI, and the test
    # suite — which boots this same app through TestClient — never meet it.
    #
    # Logged AND raised on purpose: uvicorn reports a lifespan exception as a
    # traceback under "Application startup failed. Exiting.", which is complete
    # but easy to lose in a container log; the CRITICAL line is the one that
    # survives an aggregator and is worth grepping for. Neither carries the
    # secret or the URL itself — see production_boot_failures().
    boot_failures = settings.production_boot_failures()
    if boot_failures:
        detail = "\n".join(f"  * {problem}" for problem in boot_failures)
        refusal = (
            f"REFUSED to start: ENV={settings.env.strip() or '(blank)'} is a production "
            f"environment and this process is holding development credentials.\n{detail}"
        )
        log.critical(refusal)
        raise RuntimeError(refusal)

    # 2) Say plainly, once, when voice is running unauthenticated.
    #
    # A blank VOICE_WORKER_SECRET leaves BOTH worker endpoints open to anyone who
    # can reach this port. The reachable abuse is the forged HEARTBEAT: the body
    # accepts any worker_id, so a stranger can make _worker_healthy() true and
    # students are then handed tokens into rooms no agent ever joins — voice looks
    # available and silently is not. (Forged TRANSCRIPTS are much harder: an
    # unknown conversation id 404s, and ids are uuid4 hex.)
    #
    # A WARNING, not a hard failure. Most REEP deployments never enable voice, and
    # refusing to boot over an unset optional secret would take the whole dashboard
    # down over a feature the operator is not using. require_voice_worker already
    # fails closed at request time — this exists so the operator learns at deploy
    # rather than from a confused student.
    #
    # Keyed on worker_auth_optional, not is_prod (audit M1). The old test was a
    # NAME test: a `staging` or `uat` box, or one whose ENV arrived blank from a
    # half-written deploy template, was left with open worker endpoints AND no
    # warning at all, because it was not spelled "prod". The same allowlist now
    # decides both, so the warning fires exactly where the endpoint refuses.
    if not settings.worker_auth_optional and not settings.voice_worker_secret.strip():
        log.warning(
            "VOICE_WORKER_SECRET is blank on a non-development environment "
            "(ENV=%s): /api/voice/heartbeat and /api/voice/transcript are "
            "unauthenticated. A forged heartbeat makes voice report itself "
            "available with no worker behind it. Set the same value on the API "
            "and the voice worker.",
            settings.env.strip() or "(blank)",
        )

    # 3) Close the interview rows the PREVIOUS process died holding.
    #
    # Interview finalization has three layers (docs/interview-engine-v3.md §6.7)
    # and the first two — the relay's own finalizer and the router's `finally:`
    # backstop — both need this process to still be alive to run. Neither
    # survives a `kill -9`, an OOM kill, or a container cut off mid-interview,
    # and each of those leaves `interview_sessions.status = 'running'` forever:
    # a row that lies, sitting on a student's history screen next to their real
    # interviews.
    #
    # Startup is where this belongs, with no cron at all, because a worker that
    # has just booted is precisely the process that knows the previous one died.
    # A deploy and a crash-restart — which is essentially every way this happens
    # — therefore sweep themselves. The stale-heartbeat predicate is what makes
    # it safe to run here with other workers live: a healthy interview's
    # heartbeat is a minute old, and the grace window is 1200 s.
    #
    # NOT purge_expired. That one DELETES student data on a clock, and running it
    # from every boot would make the amount destroyed a function of how often
    # someone restarts the API. Cron wiring for the reapers stays a deployment
    # concern, as app/retention.py has always said of its own jobs.
    #
    # Wrapped whole, and on a thread: this is a synchronous psycopg call, so it
    # would otherwise block the event loop, and a database that is slow or down
    # at boot must degrade to "orphans get swept next restart" rather than to "no
    # dashboard". The whole app does not fall over for a bookkeeping sweep.
    try:
        swept = await asyncio.to_thread(_sweep_orphaned_interviews)
        if swept:
            log.info("Startup sweep finalized %d orphaned interview session(s).", swept)
    except Exception:
        log.exception(
            "Startup sweep of orphaned interview sessions failed; any "
            "interview_sessions row left 'running' by a previous process stays "
            "that way until the next successful sweep. Serving anyway."
        )

    try:
        yield
    finally:
        # Ask live interviews to close with a real code and reason rather than
        # being torn down as a bare 1006.
        #
        # BACKSTOP ONLY, and honestly so: uvicorn's Server.shutdown() closes
        # every live WebSocket (queueing websocket.disconnect(1012)) BEFORE it
        # sends the lifespan shutdown event, so under uvicorn this set is
        # already empty here. The standalone relay hijacked SIGINT/SIGTERM to
        # get ahead of that; this process serves the whole dashboard and taking
        # over its signals to improve one feature's close code is a bad trade --
        # especially as the client already has a sentence for 1012 ("the
        # interview server is restarting"). This covers an ASGI server whose
        # shutdown ordering differs, and a shutdown with no signal at all.
        interview.shutdown_interviews()


# /docs, /redoc and /openapi.json follow settings.docs_exposed: served in dev —
# AGENTS.md sends a newcomer to http://127.0.0.1:3300/docs on their first run —
# and OFF in production unless the operator sets DOCS_ENABLED on purpose.
#
# The endpoints stay authenticated either way, so this is not a security control;
# it is the difference between an attacker guessing at routes and reading the
# list. The schema names every path, every field, every enum value and every
# staff-only surface, and it is served before any login.
#
# All three are named even though `openapi_url=None` alone would disable the two
# UIs as a side effect: leaving that as an implicit consequence is how one of
# them comes back the next time someone adds a docs option.
_DOCS_URL = "/docs" if settings.docs_exposed else None
_REDOC_URL = "/redoc" if settings.docs_exposed else None
_OPENAPI_URL = "/openapi.json" if settings.docs_exposed else None

app = FastAPI(
    title="REEP API (Python / FastAPI)",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=_DOCS_URL,
    redoc_url=_REDOC_URL,
    openapi_url=_OPENAPI_URL,
)

# Credentials are sent (the session cookie), so the origin must be explicit, not "*".
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Traceability: every request carries an X-Request-ID edge to log line — see
# app/traceability.py. Added AFTER CORSMiddleware so it runs INSIDE it and the
# echoed header rides on responses CORS has already stamped.
app.add_middleware(RequestTraceMiddleware)

# Health is infra liveness — unprefixed at /health.
app.include_router(health.router)
# agent + voice + interview already carry /api in their own prefix
# (/api/agent, /api/voice, /api/interview).
app.include_router(agent.router)
app.include_router(voice.router)
app.include_router(interview.router)
# Domain routers mount under a single /api prefix, so the whole surface the
# Angular client calls lives under /api — matching environment.apiBase and the
# dev proxy (apps/web/proxy.conf.json), with no path rewriting.
app.include_router(auth.router, prefix="/api")
app.include_router(student.router, prefix="/api")
# The v2 UI's three new screens (ledger, English baseline, mentor meeting log)
# and the landing programme cards. Its own module so routers/student.py — the
# file every other student change touches — did not grow another 600 lines; it
# shares the /student prefix, so the client sees one flat surface.
app.include_router(student_programme.router, prefix="/api")
app.include_router(mentor.router, prefix="/api")
# The staff side of the v2 screens — a mentor or director reading a student's
# ledger and English baseline. Separate from mentor.py so that file is untouched,
# and every endpoint in it goes through _assert_can_access_student (rule 2).
app.include_router(mentee_records.router, prefix="/api")
app.include_router(director.router, prefix="/api")
app.include_router(leave.router, prefix="/api")
# Faculty upskilling (own certificate uploads) and the alumni area (first-login
# profile + jobs sheet). Both scope every row to the signed-in user; the staff
# one gates on mentor.require_mentor, the alumni one on the ALUMNI role.
app.include_router(staff_upskilling.router, prefix="/api")
app.include_router(alumni.router, prefix="/api")
# The Skills & Badge dashboard: the student half shares the /student prefix
# (badges, growth, leaderboards); badge_verification carries the staff review queue,
# manual awards, assessment entry, cohort views and the certification
# catalogue, under /mentor and /director as rule 2 dictates.
app.include_router(badges.router, prefix="/api")
app.include_router(badge_verification.router, prefix="/api")
app.include_router(registration.router, prefix="/api")


# --- The interview record endpoints (Interview Engine v3 §7) -----------------
#
# `app/routers/interview_records.py` declares its routers ALREADY PREFIXED — one
# at /api/interview and one at /api/mentor — so that `app/routers/mentor.py` is
# not touched at all by this work. That is the whole reason the module exists as
# a separate file, and it is why these are included bare rather than under the
# `prefix="/api"` the domain routers use.
#
# Two things make this include look unlike its neighbours, and both are
# deliberate:
#
# 1) THE IMPORT IS GUARDED, and on `Exception` rather than `ImportError`. The
#    module lands in the same wave as this wiring and from a different hand. A
#    missing or half-written module must degrade to "the interview history
#    screen 404s" — one feature — and never to "the dashboard does not boot",
#    which is every student's marks, attendance and jobs board gone because a
#    read-only history endpoint was not ready.
#    `except ImportError` would have covered only the ONE way this fails that
#    nobody actually hits once the file exists. A module that is present and
#    broken raises SyntaxError, NameError or AttributeError at import — none of
#    them an ImportError — and each would have taken the whole process down at
#    boot, which is precisely the outcome this guard was written to prevent.
#    Logged with the traceback (ERROR, not WARNING) because from here on a
#    failure here means a real defect in a module that is supposed to exist, and
#    "which line" is the first thing whoever reads this will need. The message
#    names exactly what is unavailable so this is diagnosed from the log rather
#    than from a student's screenshot.
#
# 2) THE ROUTERS ARE DISCOVERED, not named. §7 specifies two of them and does not
#    fix their variable names; guessing `router` and finding `student_router`
#    would mount NOTHING while raising nothing — a silently missing API surface,
#    which is the exact failure this codebase keeps writing comments about. Every
#    public APIRouter the module exposes is mounted, and the names and prefixes
#    are logged, so what got served is a fact in the log rather than an
#    assumption. The `/api/` requirement is a real contract check, not a filter
#    of convenience: the Angular client's `environment.apiBase` and the dev proxy
#    (apps/web/proxy.conf.json) forward `/api` and nothing else, so a router
#    mounted anywhere else is unreachable from the app that needs it.
try:
    from .routers import interview_records
except Exception:
    log.exception(
        "app/routers/interview_records.py is not importable: the interview "
        "record endpoints (GET /api/interview/sessions, the consent endpoints, "
        "and GET /api/mentor/students/{id}/interviews) are NOT served. "
        "Interviews themselves still run and still record. Nothing else is "
        "affected."
    )
else:
    _mounted: list[str] = []
    for _name, _candidate in vars(interview_records).items():
        if _name.startswith("_") or not isinstance(_candidate, APIRouter):
            continue
        if not _candidate.prefix.startswith("/api/"):
            log.error(
                "interview_records.%s is an APIRouter with prefix %r, which is "
                "outside /api — NOT mounting it, because the Angular client and "
                "the dev proxy only forward /api and it would be unreachable "
                "there anyway. Give it its own /api prefix.",
                _name,
                _candidate.prefix,
            )
            continue
        app.include_router(_candidate)
        _mounted.append(f"{_name} -> {_candidate.prefix}")
    if _mounted:
        log.info("Interview record routers mounted: %s", ", ".join(_mounted))
    else:
        log.error(
            "app/routers/interview_records.py imported but exposes no public "
            "APIRouter with an /api prefix — the interview record endpoints are "
            "NOT served."
        )
