# API checklist — REEP's conventions, and what enforces each one

The short form of this list is the "Engineering checklist" in
`.github/pull_request_template.md`. This page is the long form: for every item,
what REEP actually does today (with the file to copy), and **which gate enforces
it — or that nothing does**. An item marked *human — no gate* is a claim in a
pull request, not evidence; the reviewer has to look.

Gate names used below are the ones in [`quality-gates.md`](quality-gates.md):
**Static analysis** (step in "API (FastAPI + Postgres)"), **Secrets (gitleaks)**
(required check), **route audit** (`apps/api-py/tests/test_route_audit.py`),
**migration round trip** (step in "API (FastAPI + Postgres)"), and the existing
**codebase guards** (`apps/api-py/tests/test_codebase_guards.py`).

## Before coding

| Item | REEP's convention | Enforced by |
|---|---|---|
| Request and response shapes agreed as Pydantic models | `...In` / `...Out` `BaseModel` classes, either beside the router (most routers, e.g. `app/routers/leave.py`'s `LeaveIn`/`LeaveOut`) or in `app/schemas/` (`auth.py`). Write the models first; they are the contract the Angular client compiles against. | human — no gate |
| Edge cases listed: empty, duplicate, huge, bad input | Name them in the PR's "Why". Precedents worth reading: the empty attendance table that rendered "0.0%" (`AGENTS.md`, Phase 4), the duplicate-application retry (`registrations.submission_key_hash`), the backwards leave dates (`LeaveIn.dates_run_forwards`). | human — no gate |

## While coding

| Item | REEP's convention | Enforced by |
|---|---|---|
| Separate input, output and DB models; never return the DB model | ORM classes live in `app/models/` (`Base` in `app/db.py`); handlers build an `...Out` from the row. | **route audit** (`test_no_operation_returns_a_database_model`); FastAPI also refuses a bare ORM class as `response_model` at import |
| Every JSON operation declares a response model | `response_model=` or a return annotation naming a Pydantic model. Files, CSVs, PDFs and redirects return a `Response` subclass. 13 operations answer a bare `dict` or a union today and are listed in `KNOWN_NO_RESPONSE_MODEL`. | **route audit** |
| Validate with Pydantic: types, min/max, enums | `Field`/`Query(ge=, le=)`, validators for cross-field rules (`LeaveIn.dates_run_forwards`, `RegisterIn`'s required fields). A value Postgres refuses to store becomes a 422 via the `DataError` handler in `app/main.py` — the floor, not the fix. | human — no gate (FastAPI turns a schema failure into 422) |
| Auth and permission on every route | Authentication is a dependency: `session: dict = Depends(get_current_session)` (`app/identity.py`). Authorisation is a call in the body: `require_mentor` / `require_admin` (`app/routers/mentor.py`), `require_capability` (`app/governance.py`), `_assert_can_access_student` for a student named in the path (rule 2, `AGENTS.md`), `_require_student` for a student's own screen. WebSockets call `get_ws_session` in the body. | **route audit** (session in the tree; a gate reached; `PUBLIC` and `KNOWN_UNGATED` list the exceptions with reasons) |
| Thin routes, logic in a service layer, DB in a repository layer | **Not REEP's convention today, and saying so is the point.** Most handlers query SQLAlchemy directly (`app/routers/student.py`). Logic that more than one router needs lives in a module under `app/` — `app/governance.py`, `app/mentor_history.py`, `app/account_deletion.py`, `app/policies.py` — which is a service layer in all but name. There is no repository layer. New shared rules go in an `app/` module, never copied between routers (see `_require_student`, the one deliberate duplicate, and its "EDIT BOTH OR NEITHER"). | human — no gate |
| Correct status codes: 201 / 204 / 404 / 409 / 422 | Create → 201, body-less → 204, missing or out-of-scope → 404 (rule 2 refusals are deliberately a flattened 404 in places, e.g. `leave._assert_can_decide`), state conflict → 409, invalid input → 422 (`status.HTTP_422_UNPROCESSABLE_CONTENT`). | **route audit** for 201-on-create, 204-has-no-body and DELETE shape (`KNOWN_STATUS` lists the one deviation). 404/409/422 choice: human — no gate |
| One error format | **One envelope, two shapes.** Every error is `{"detail": ...}`. A schema failure sends `detail` as FastAPI's list of errors; ~150 handlers raise `HTTPException(422, "a sentence")` with a string. `app/main.py::_openapi_with_honest_422` documents both, and the SPA's `detailOf` reads both. There is no error code field. | not enforced yet |
| A transaction per request | `get_db` (`app/db.py`) yields one session per request; handlers `db.commit()` explicitly once, after every refusal. Background tasks open their own session. | human — no gate |
| No N+1 queries | Batch reads with `in_()` and join; `app/routers/student.py::_institution_for` is one flat LEFT JOIN for that reason. | not enforced yet |
| An index for every filter and sort column | Declare the index ON THE MODEL as well as in the migration, or `alembic check` asks to drop it every run (`AGENTS.md`, Backend conventions). | **codebase guards** for foreign keys (`test_every_foreign_key_column_is_indexed`) and redundant prefixes (`test_no_index_duplicates_the_prefix_of_another`); other filter/sort columns: human — no gate |
| Paginated lists | `limit: int = Query(50, ge=1, le=MAX)` plus `offset` — `app/routers/leave_policy.py::list_balances`. Or `page` + `page_size` clamped in code (`admin_mentoring.py`). 26 lists are capped by construction (`BOUNDED`); 65 are recorded gaps (`KNOWN_UNPAGINATED`). | **route audit** |
| `async def` only with async libraries | A handler doing database, file or boto3 work is a plain `def` (FastAPI runs it on the threadpool). `async def` handlers that block froze the event loop and produced the 2026-09-29 registration 504s. | **Static analysis** (`tools/ci/check_async_blocking.py`) |
| Idempotency for retries | Three idioms: a client-minted key hashed on the row (`registrations.submission_key_hash`, a lost reply returns the original 201); `require_idempotency_key` for `/api/v1` commands (`app/architecture_events.py`); keyed mail (`mailer.deliver_once`). | human — no gate |
| Config and secrets from the environment | `Settings(BaseSettings)` in `app/config.py`, read from env / `.env`; secrets come from the ECS task definition's `secrets`. `Settings.production_boot_failures()` refuses to boot `ENV=prod` on a repo-default or short `AUTH_SECRET` or the dev database password. | **Secrets (gitleaks)** for values in code; the boot guard at runtime (`tests/test_boot_guard.py`) |

## Before merge

| Item | REEP's convention | Enforced by |
|---|---|---|
| Tests: happy path, failure path, auth failure | The PR template's "Tests" section asks for the test that fails without the change. Auth failures: a STUDENT refused by every `/api/admin/*` operation (`tests/test_admin_institution.py`), rule 2 (`tests/test_mentee_records.py`). | human — no gate (the route audit proves a gate is *called*, not that it is the right one) |
| ruff and mypy pass | Configuration in `apps/api-py/pyproject.toml`. | **Static analysis** |
| Migration written and checked for rollback | One head; enum gotchas in `AGENTS.md`; `.claude/skills/new-migration`. Downgrade written, or the revision listed in `IRREVERSIBLE` with a reason. | **migration round trip**; the PR template's "Schema" section |
| Logs carry a request id; no passwords or tokens | `app/traceability.py` stamps `X-Request-ID` on every response and on the one `reep.access` line per request (`rid=`), and tags the Sentry scope. **Other log lines do not carry the id** — there is no logging filter that adds it. The access line logs no body, query string or cookie; Sentry payloads go through `app/telemetry_scrub.py` (`AGENTS.md`, rule 1 applies to telemetry). | partly: `tests/test_observability.py` pins the Sentry scrubbers; request id on non-access lines — not enforced yet |
| Rate limit on login and public routes | Login: per-ACCOUNT failure budget (`app/routers/auth.py::_login_retry_after`, never per address — behind the ALB every caller is one address). Forgot password: its own throttle (`app/routers/passwords.py`). Public register form and its document upload: per-address limiter (`app/routers/registration.py`). LLM routes: `app/ratelimit.py`. The edge: the WAF rate rule (`infra/cdk/reep_core/edge.py`). | human — no gate |
| `/docs` examples correct | `/docs`, `/redoc` and `/openapi.json` are served only where `settings.docs_exposed` (dev). The contract is exercised from outside by Schemathesis (`testing/api/run_schemathesis.sh`), not in CI. | not enforced yet in CI |
| Review done | The PR template's "Design and approach" section; `claude-review.yml` on every non-draft PR; a human for anything `tools/ci/release_gate.py` refuses to auto-ship. | human |

## Gaps worth closing, in the order they would pay off

1. **A request id on every log line**, not only the access line — a logging
   filter reading a contextvar the middleware sets. Cheap, and it turns "grep
   the rid" into the whole story of a request.
2. **Pagination on the growing lists** in `KNOWN_UNPAGINATED` tagged `gap:` —
   `/api/admin/students` and `/api/leaves/pending` first. Each needs its screen
   changed too.
3. **Response models for the 13 untyped answers** — safe only if each model
   reproduces today's keys exactly.
4. **An error code** beside `detail`, if the client ever needs to branch on a
   refusal rather than print it.
