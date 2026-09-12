# REEP — the stack

REEP is a college placement-readiness dashboard. It is an **Angular front end** talking to a **Python/FastAPI back end** over HTTP, on **PostgreSQL**. (It used to be a Next.js/React app with a NestJS API and Prisma — that stack has been fully migrated away and deleted. Ignore any lingering references to Next.js, React, Prisma, `server-only`, or `apps/api`; they are gone.)

```
apps/web      Angular 22 SPA (standalone components, signals, ReactiveForms)
apps/api-py   FastAPI + SQLAlchemy 2.0 + Alembic + Pydantic v2 (psycopg 3, PyJWT)
docker-compose.yml   Postgres 17 (container reep-postgres, host port 5433)
```

## Running it

1. **Database** — `docker compose up -d` starts Postgres on `localhost:5433`. The API uses a database named `reep_py` on that server.
2. **Back end** — from `apps/api-py` (venv at `.venv`, Python 3.14):
   ```
   .venv/Scripts/pip install -r requirements-dev.txt  # runtime + pytest
   .venv/Scripts/python -m alembic upgrade head      # apply migrations
   .venv/Scripts/python -m app.seed                  # idempotent dev seed
   .venv/Scripts/python -m uvicorn app.main:app --port 3300
   ```
   Docs at http://127.0.0.1:3300/docs. **Windows note:** `uvicorn --reload` has wedged a stale worker here — after editing backend files, kill port 3300 and restart rather than relying on `--reload`.

   **On `ENV=prod` this process now REFUSES TO BOOT on a bad secret, and that is not a bug in your deploy script.** `Settings.production_boot_failures()` (`app/config.py`) is raised from `app/main.py`'s lifespan, so uvicorn never binds a port, and the log names every problem it found. It fires on: an `AUTH_SECRET` that is blank, still the value published in this repo and `.env.example`, an obvious placeholder, or shorter than 32 characters; and a `DATABASE_URL` still carrying this repo's dev password. Set real values — the message includes the command to generate a secret. It is deliberately a refusal and not a warning: `AUTH_SECRET` signs the `reep_session` cookie, so a production host running on the repo default is one forged `{"role":"ADMIN"}` cookie away from every student's marks, attendance and USN, with no login and no database row involved. On every development `ENV` the check returns nothing at all, and `tests/test_boot_guard.py` pins that as hard as it pins the refusal — a guard that trips on a laptop gets deleted by whoever is trying to ship that afternoon.
3. **Front end** — from `apps/web`: `npx ng serve` (port 4200). `proxy.conf.json` forwards `/api` → `http://localhost:3300`, so the app is same-origin and the httpOnly session cookie is carried. The whole API surface the client calls lives under `/api`.
Seeded logins: `student@bgscet.ac.in` / `student123`, `mentor@bgscet.ac.in` / `mentor123`, `alumni@bgscet.ac.in` / `alumni123` (no profile row — so the alumni first-login create-profile flow is what you see on a fresh database), and `admin@bgscet.ac.in` / `admin123`: the **Main Admin**, the only role Governance admits (`require_admin` in `routers/mentor.py`). **There is no `director@bgscet.ac.in` any more** — see “DIRECTOR is not a role” below.

### Two requirements files, two seeds — the split is deliberate

- `requirements.txt` is **runtime only** and pinned `==`; it is what the Dockerfile installs. `requirements-dev.txt` pulls it in and adds pytest. A test runner has no business in a production image, and `>=` bounds meant a rebuild months later resolved a dependency set nobody had run the suite against.
- `python -m app.seed` **refuses to run when `ENV=prod`.** It creates the logins above — including the Main Admin, who by rule 2 below reads every student's marks, attendance and USN — behind passwords published in this file. Those accounts must never exist on a production host, so there is no override flag.
- `python -m app.seed_kb` is the production-safe seed: the grounded assistant's Knowledge Base, no accounts. Production needs it (without it the assistant has nothing to ground against) and never needs the demo users, which is why they no longer travel together.

**Handing a deployment over: `python -m app.purge_people`.** The counterpart to the seeds — it empties a deployment of PEOPLE (every account except the Main Admin, every record those accounts produced, every transcript and every recording, and the documents and audio on the volume) while leaving the institution and the catalogues standing: colleges, departments, courses, specializations, batches, job postings, the badge and certification catalogues and the Knowledge Base. It exists because nothing else can do it: `grant_access` creates and updates accounts and cannot remove one, the Main Admin console has no screen at all for deleting a faculty account, and the Ops task menu is a FIXED LIST because free text there is RCE on the cluster. **Every one of the 93 tables carries a written verdict in `VERDICTS`, and a table nobody classified ABORTS THE RUN** — not kept (which leaves a student's records behind) and not emptied (which destroys a catalogue somebody added last week); `tests/test_purge_people.py` fails in CI first, so the next person to add a model is made to decide. **Files go before rows**, because a row is the last pointer to a student's resume and a named student's recorded voice, and a delete that loses the pointer first leaves bytes nobody can find — `retention._delete_interview_audio`'s reasoning, applied to the five document stores and the S3 recordings. It refuses unless there is EXACTLY ONE ADMIN: zero would lock every human out of the console, and picking between two would be this module choosing which colleague keeps their account. **Dry run is the default**; `--apply` also demands `--i-understand-this-is-permanent`, and the Ops task's `purge-people` demands a typed sentence of its own on top of the menu's `confirm: run`, because that box is muscle memory by the time anyone reaches this task and nothing else on the menu destroys anything. The delete order satisfies 93 real foreign keys — several with no `ON DELETE` at all (`login_days.user_id`, `mentors.user_id`, `students.user_id`, and the four `created_by_user_id` columns on the KEPT institutional spine, which are nulled first) — and the test proves it by running the real delete against the real schema inside a transaction it rolls back, which is why `_delete_rows` is factored out of `execute` without a commit.

**Clearing a demonstration cohort: `python -m app.purge_students`.** The narrow counterpart, and the one that gets run on a deployment that is STAYING IN USE: it deletes every account whose role is STUDENT, everything those accounts produced, and everything staff wrote ABOUT them — while every MENTOR, ALUMNI and ADMIN account, their signatures, their upskilling shelf, their governance grants and their own leave requests stay exactly where they are. `purge_people` cannot express that, because its verdicts are whole-table (`students: EMPTY`, `users: SURVIVOR`): running it to clear a cohort deletes every faculty account on the way through. So here a verdict is THREE values and not two — "delete the student rows" is a different sentence in a table only a student can own (`resumes`) and in one shared with staff (`leave_requests`, `conversations`, `agent_runs`, `login_days`). 38 tables are emptied outright, 33 are untouched, 21 are scoped, and **`STUDENT_VERDICTS`'s key set is checked against `purge_people.VERDICTS`**, so the next person to add a model is stopped by BOTH destructors rather than the one they happened to read. **The doomed set is read ONCE, before anything is deleted**, and held as literal ids: as a live subquery over `users` it would be right only by accident, because the accounts go near the END of the pass and any table ordered after them would match nothing and silently leave its rows behind. `registrations` is the one table scoped by something other than an account — an application that was APPROVED, or that carries a doomed address, goes; the office's PENDING queue survives, because an approved application left behind makes `POST /api/register`'s duplicate guard refuse that address forever with no account left to explain why. The three file stores are `purge_people`'s own functions handed a subset, never a copy. Dry run is the default, the Ops task's `purge-students` demands the typed sentence `DELETE EVERY STUDENT` (deliberately NOT `purge-people`'s, so the words name the act), and `execute` refuses to commit if the number of non-student accounts changed.

**Tests:** `cd apps/api-py && .venv/Scripts/python -m pytest` (the backend suite). Front end: `cd apps/web && npx ng build`.

**CI has five jobs** (`api`, `pii-gate`, `api-imports`, `web`, `cdk`), and one of
them exists because a manifest shipped incomplete. `api-imports` proves
`requirements.txt` ALONE covers every module under `app/`
(`tools/ci/check_api_imports.py`). It was added
after `app/interview_local.py` reached main importing numpy undeclared — the
import is lazy, inside a request handler, so the API still booted and every test
still passed, and the break surfaced only as a pytest COLLECTION failure on a
clean machine. A lazy import does not make an undeclared dependency acceptable;
it only moves the crash from boot to the first student who reaches that path.

Those five names are also the five REQUIRED STATUS CHECKS in
`.github/rulesets/main.json` and in `tools/ci/protect-main.sh`'s
`REQUIRED_CHECKS`, and GitHub matches a required check by the job's DISPLAY NAME
as a string. So deleting a job does NOT retire its requirement: the ruleset
asked for "Voice worker (dependency completeness)" for months after that job
went with the LiveKit stack, which — had the ruleset ever been applied — would
have blocked every pull request on a check that can never report. Rename or
remove a job and edit all three files in the same commit. `tools/ci/preflight.sh`
runs the same five locally, in the order that fails fastest.

The `web` job also runs three static checks over `apps/web/src` before the slow
steps, each guarding a rule that is invisible at the call site:
`check_brand_magenta.py` (magenta is reserved for `--primary-gradient`, and had
leaked to 21 sites, two of them chart colours in TypeScript that a stylesheet
grep would never have found), `check_style_duplicates.py` (one owner per global
class — see the two-stylesheets note below; it ratchets in both directions, so a
merged duplicate must be struck off `KNOWN_DUPLICATES` too) and
`check_theme_tokens.py` (the grid and chart themes copy tokens as literals,
because neither library reads CSS custom properties — the duplication is forced,
the drift is not).

**Routes are lazy.** `app.routes.ts` uses `loadComponent`, never a static `component:` reference. Every route was once eagerly imported, which put the whole app — mentor and admin screens, the resume builder, the realtime assistant — into a single 1.23 MB `main` chunk that a student on a phone downloaded before the login form could paint. It is ~142 kB initial now, and the production bundle budget is set close enough to that number that one re-eager-ed route fails `ng build` in CI.

## Auth — Google-only sign-in over the session retained from the migration

**Sign-in is Google, for every role, and the roster is the access control.** `app/google_auth.py` verifies the Google ID token properly — RS256 signature against Google's JWKS, `aud` = our client id, `iss` = accounts.google.com, unexpired, `email_verified` true, plus a single-use `state` cookie and a `nonce` — and then looks the verified email up in `users`. **A Google account with no matching row is refused** (`302 /login?error=sso_not_enrolled`); nothing self-provisions, and no role is ever guessed. Students come from `python -m app.seed_roster` — production-safe and idempotent like `app.seed_kb`, no passwords — which derives the email from the USN (`1MP25MDM01` → `1mp25mdm01@bgscet.ac.in`, domain from `ROSTER_EMAIL_DOMAIN`, alias `COLLEGE_EMAIL_DOMAIN`; `--rekey-domain` moves an already-seeded batch if that guess was wrong), so a student's USN is already filled in on their profile and they never type it.

What Google issues is **the same session as before, byte for byte**: passwords are `scrypt:salt:digest` (Node `scryptSync`-compatible: N=16384, r=8, p=1, dklen=64, salt as a hex string), sessions are HS256 JWTs signed with a shared `AUTH_SECRET` carrying the same claims (`userId, email, name, role, studentId?, mentorId?`), in the httpOnly `reep_session` cookie. `require_*` dependencies in `apps/api-py/app/identity.py` / the routers read the session and were **not changed** — they cannot tell the two paths apart.

**ONE DEVICE AT A TIME (2026-09-10).** A REEP account holds exactly **one live session**: every sign-in — password, emailed code, Google, and the activation link — advances `users.token_version` before the token is minted, and `app/security.py` refuses any token whose version is behind the row. So signing in on a phone drops the laptop on its next request. **The newest sign-in wins, deliberately**: refusing the *new* device instead would lock out the student whose browser crashed until a row aged out, and it would need a sessions table, an eviction policy and a device list that this design does not have. `_retire_other_sessions` is the in-memory half and **the caller's commit is what persists it** — on the code door that commit is the same one that lands the one-time code's `consumed_at`, so a separate earlier commit would make "code spent, session refused" reachable. `_confirm_exclusive_session` seeds this worker's revocation cache and must run **after** the commit. If that commit fails the session is still issued and the older devices survive: fail-open on exclusivity, never on authentication, and logged where it happens. `tests/test_single_device_session.py` covers all four doors, and the mutation that matters most is building the payload *before* the bump — that mints a token one version behind the row, which is a 200 from `/login` followed by a 401 on the very next request, for everyone.

Because this makes being signed out a routine event rather than an incident, the server says **why**: a 401 whose cookie was retired (rather than expired or absent) carries the header `X-Reep-Session: retired` (`session_was_retired` in `app/security.py`). `AuthService.refresh()` reads it, the auth guard redirects to `/login?signedOut=elsewhere`, and the login screen explains it. Without that the student meets a login form mid-task with no explanation, signs in again, drops the other device, and learns the app logs you out at random.

`POST /api/auth/login` (password) is **always on in dev/CI and off everywhere else unless `PASSWORD_LOGIN=true`**: the `login` fixture in `tests/conftest.py` and the six test modules that use it authenticate through it, so deleting it would take the DB-backed suite and CI with it. The guard is `settings.password_login_allowed` — an allowlist of dev/CI environment names **or** the explicit flag, never `not is_prod`, so an unrecognised `ENV` (`staging`, `uat`, a typo, a blank from a broken deploy) still shuts the password door rather than opening it. A default production deployment answers 403 and names Google instead. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `apps/api-py/.env`; blank means `GET /api/auth/sso/status` reports unavailable and the login screen's Google button renders disabled with the reason — nothing else is affected. Full notes, including the exact authorised redirect URI and a troubleshooting section: `docs/google-sign-in.md`.

**Running passwords in production is a supported choice, and the door is DERIVED, not toggled.** `password_door_open(db)` in `app/routers/auth.py` is the one answer `/login` and `/sso/status` both give: dev/CI always; `PASSWORD_LOGIN=true` always; `PASSWORD_LOGIN=false` never; and otherwise **open exactly when at least one account holds a real `scrypt:` hash**. That is deliberate and it is the whole design. `app.grant_access` and `app.seed_roster` mint accounts holding `SSO_ONLY_PASSWORD_HASH`, a sentinel that is not `scrypt:salt:digest`, so `verify_password` returns False for every password ever tried and a fresh deployment has no keys and a shut door. Nothing self-issues a key, so "a key exists" can only mean an operator issued one on purpose — and that act *is* the decision to open the door. A separate env switch would ask them to make the same decision twice, in a different tool, and on Fargate that second tool is a `terraform apply` (the env lives in the task definition; `deploy.yml` ships code, never infrastructure). Two sources of truth for one door is how a login form ends up 403ing over keys in circulation.

**Issuing a key: the plaintext never travels, the hash does.** `python -m app.set_password <email>` types the password **at a prompt, never a flag**, because a `--password` option puts the secret in shell history, in `ps`, and in the CloudTrail record of ECS task overrides; it enforces a 12-character floor and refuses the demo passwords published in this file; `--revoke` restores the sentinel and leaves Google sign-in working. For a browser-only operator, `set_password --print-hash` applies the same checks locally and prints the scrypt hash, and `app.grant_access --password-hash <hash>` (exposed as the ops-task workflow's `password_hash` input) writes it — a hash with a random 16-byte salt is safe in argv and CloudTrail in a way a password is not, and `grant_access` refuses anything that is not exactly `scrypt:<32 hex>:<128 hex>` so a password pasted into that box by mistake is rejected rather than stored. `--mentor <email>` puts a granted STUDENT into a granted mentor's group, because a demo mentor with nobody in their group correctly sees nobody (rule 2). And `app.seed` **still refuses on `ENV=prod`**, so `admin123` and friends cannot be what the open door admits (`director123` is still on `set_password`'s refusal list — the account is gone, but the string was published, so it must keep being refused) — that refusal is the point of the whole arrangement and must not be relaxed.

**Onboarding, forgot-password and change-password (2026-09-10) — OPTION B IS OVER.** Students hold passwords now. Google sign-in is untouched and still works for every role; what changed is that it is no longer the *only* door a student has, and that the mailbox proof moved from BEFORE the decision to AFTER it.

**The whole student path is: apply → a human decides → three steps → sign in.** `POST /api/register` applies the rule engine at submit time and the application lands in the review queue **immediately, with no email in between**. The Main Admin approves or rejects. APPROVE provisions the account and emails a setup link; REJECT **requires a reason** (422 without one) and emails it, because a rejected applicant is not a user and that mail is the only channel the product has to them. The link opens `/onboard?token=`, which is **three steps on one URL** (`app/routers/onboarding.py`): `/auth/onboard/start` takes the token plus the address typed back and mails a six-digit code; `/auth/onboard/verify` spends the code and returns a 15-minute **ticket**; `/auth/onboard/password` takes the ticket — **never the link** — and sets the password. Three purposes, three different proofs: the link proves somebody opened mail sent there, which a FORWARDED link also proves; the code proves the mailbox is readable *now*; the ticket is the only thing the password step accepts, so the code can never be skipped by holding the link. It **signs nobody in** — the flow ends at `/login`, so the new password is typed once at the ordinary front door, which applies the ordinary brute-force limiter, revocation and single-device retirement. One door, not two.

**Why the confirmation link moved.** It used to run BEFORE the rule engine: `POST /register` wrote `PENDING_VERIFICATION` and waited. The reasoning was sound (approval mints a `users` row, so no address should auto-approve itself onto the roster) and the mail is the half that fails. On a deployment whose SES account is still sandboxed nothing can reach a student address at all, so **every** applicant sat invisible — the student saw a 201, the admin saw an empty queue, and the retry hit the duplicate guard's deliberately opaque 409, which reads as a broken form. Verified on production 2026-09-10: not one `GET /api/register/verify` in 30 days. A gate nobody can pass is not a gate, it is an outage. Migration `9b2d47f0ce15` moved the stuck rows into the queue; `/api/register/verify`, `EmailVerification`'s three helpers and `retention.sweep_unverified_registrations` are gone with the status that fed them.

**Changing a password later is the same idiom**: `POST /auth/change-password/code` mails a code to the address ON THE ACCOUNT (never one from the request), and `/auth/change-password` takes **one proof, never two** — `code` or `current_password`, and supplying both is refused, so a guessed code cannot ride a known password. Staff keep the current-password path; it is the door that still works when mail does not.

**STAFF still activate, and that refusal is not vestigial.** `python -m app.grant_access` prints an activation link for any staff account created without `--password-hash`, and `POST /api/admin/users/{id}/activation-link` (Main Admin) mints or re-mints it on screen — **the on-screen link is permanent, not a stopgap**, because "the email never arrived" is a support call the admin should be able to close by reading out a link. `issue_activation` still refuses a STUDENT: a student's equivalent is the onboarding walk, which proves the mailbox with a code first. Links are rows in `auth_tokens` (`app/models/auth_token.py`): stored as **sha256, never raw**; consumed by **one atomic `UPDATE … WHERE consumed_at IS NULL`** whose row count is the arbiter; issuing a new one **supersedes** every older live one; activation lives 7 days, reset 1 hour. Six-digit CODES bend two of those rules and the set that says which is `CODE_PURPOSES` — hashed WITH their row id (six digits are not unique across users, and `uq_auth_token_hash` is global), found by (user, purpose) and never by hash, predecessors DELETED rather than kept. A code purpose left out of that set would be minted with a bare sha256 and could collide with somebody else's identical six digits: a 500 in the face of a person who typed the right code.

`/auth/forgot` answers **the same 202 and the same words** whether the address is real, password-less or unknown, with the mail work in a background task so the timing matches too; it **now serves students**, who have a password to forget. `/auth/reset` puts every device out via `token_version`, kills other pending links and signs in nobody. Mail leaves through `app/mail_transport.py`: **Amazon SES** when `SES_FROM_ADDRESS` is set (task-role auth, no key to paste), otherwise a console transport that logs the message and keeps it in a bounded `outbox` — which is how a developer and the test suite read a link. **That log line was going nowhere until 2026-09-10**: nothing ever called `logging.basicConfig`, so the root logger had no handler and sat at WARNING, and every `log.info` in `app/` was discarded in development AND in production. `app/main.py`'s lifespan configures it now — deliberately WITHOUT `force=True`, which removes handlers somebody else installed (it broke `test_boot_guard`'s caplog assertion while the message was still plainly on stderr). Screens: `/onboard` (three steps), `/activate` and `/reset` (one component, two modes), all outside the shell; `/account/password` inside it; and the login's inline "Forgot password?" form. Full record: `docs/institutional-spine-build-log.md`, round 4.

The endpoint carries a brute-force limiter, and **it is keyed on the account, never on the source address**. Behind the ALB `request.client.host` is one value for the entire internet: an address bucket there is a global outage waiting to happen — ten wrong passwords from anyone locks out every student at once — and raising the limit until that stops hurting makes it stop working. This was written the wrong way first and the suite caught it immediately (24 failures became 134, because every `TestClient` request shares one peer address). Ten failures per email per fifteen minutes, only failures count, a success returns the budget, and the 429 names Google because that door is not gated by this counter — so an attacker who burns a known address's budget costs a real user a redirect, not their access. What no in-process counter can bound behind a proxy is **spraying** (one guess each against a thousand accounts); that control belongs at the edge, as a WAF rate rule.

### Runbook: the call sounded fine but saved nothing

The worst failure mode in this stack is silent — the conversation is perfect in the room and empty in the database, because transcript writes are deliberately fire-and-forget so a bad write can never kill a live call. After a test interview:

```sql
select channel, count(*), max(created_at) from messages group by channel;
```

No `interview` rows, or a stale `max(created_at)`, means turns are being dropped. The cause is logged as `Dropped interview turn`, with its exception. The interview also keeps a record of its own (`interview_sessions`), where the `turns_emitted` vs `turns_persisted` pair makes the same gap visible without a join — if those two disagree, writes are failing.

### The assistant screen is the mock interviewer (2026-08)

`/student/assistant` is the realtime mock interviewer: a WebSocket to `/api/interview` relaying 24 kHz PCM to a speech-to-speech model and back. It runs **inside the API process** — it is not a fifth process, and it needs no extra venv. Readiness is asked of the engine that is actually running (see below), and blank means `GET /api/interview/status` reports unavailable and the socket closes 4001, with nothing else in the dashboard affected. Full notes: `docs/interview-assistant.md`.

**Two engines, one setting, one contract.** `INTERVIEW_ENGINE` picks between **`nova`** (the default — `app/interview_nova.py` → **Amazon Nova 2 Sonic** on Bedrock, `amazon.nova-2-sonic-v1:0` over `InvokeModelWithBidirectionalStream`) and `local` (`app/interview_local.py` → nothing leaves the machine). Both take the same constructor and return the same `(code, reason)` from `run()`, and both emit the same DOWNSTREAM event names, so the router, the caps, the recorder, the writers, the three close layers and the Angular client never learn which one spoke. What they share — the persona, the payload records, the close codes, both concurrency caps, the scorecard parse — lives in **`app/interview_core.py`**, imported and never copied: a parallel `_TurnRecord` would drift the moment either side gained a field, silently. An unrecognised value falls back to the default **with a warning**: `INTERVIEW_ENGINE=loca` must not quietly leave the machine.

**A THIRD ENGINE, `openai`, ran this interview until 2026-09 and is gone.** `app/interview_relay.py` (3 968 lines) and its test module were deleted, along with `OPENAI_API_KEY`, the realtime model/voice/beta-header settings, the server-VAD tuning, the transcription and `response.create` deadlines, and the per-row OpenAI `voice` column on the Specialization Matrix. The reasoning that engine produced did NOT go with it: `docs/interview-engine-v3.md` is still the design record for the phase machine, the deterministic word gate and "one open question at a time", all of which Nova inherits. What died with it is the mechanism, not the argument — read that document before changing the arc. `OPENAI_API_KEY` is left in the operator-owned AWS secret rather than deleted by an apply (`infra/aws/secrets.tf` says why); nothing reads it.

**Nova has no API key, and Nova owns the turn.** The stream is signed with SigV4 from the standard AWS chain, so an AWS-hosted REEP grants the task role `bedrock:InvokeModelWithBidirectionalStream` and pastes nothing; `NOVA_SONIC_REGION` (falling back to `BEDROCK_REGION`, then `AWS_REGION`) is the only thing that must resolve, because this process composes the endpoint. Rule 1 is unchanged — Bedrock is off-machine, so no student record enters the session, and the module imports no ORM model. What differs from the retired relay is forced by the API and is deliberate: Nova 2 Sonic has no `create_response: false` and no `session.update`, so the **phase machine still ticks on accepted answers** (same `classify_answer`, same thresholds, same persona verbatim) but steering arrives as a **control note** — a cross-modal text input prefixed `[INTERVIEW CONTROL]`, carrying a fixed directive from `app/interview_matrix.py` and never a word the student said. A clarification turn is NOT injected (the model has already begun replying; a second directive is a second question) — the turn is still recorded `too_short`/`filler` and still does not advance the arc. The scorecard is a **tool call** (`submit_scorecard`), because Nova speaks everything it generates and a text-only request would read the JSON aloud; it is parsed by the relay's own `_parse_report`, never spoken, and salvaged from speech if the model ignores the tool. Voices are a different vocabulary from OpenAI's, so each matrix row carries `nova_voice` too (HR `kiara`, DM `tiffany`, BA `arjun`, FA `matthew`). **Bedrock closes the stream after 8 minutes**, which is shorter than `INTERVIEW_MAX_SECONDS` (900): the engine caps the session at `NOVA_SONIC_CONNECTION_SECONDS`, reports THAT to the client's countdown, and forces the wrap-up 90 s early so the verdict and the scorecard fit — an interview cut off mid-verdict is the exact failure the phase machine exists to prevent.

Turns are persisted through `app/conversations.py` with `channel='interview'`, so the runbook query above still answers "did it save anything" — group by `channel` and look for `interview`. The writes are fire-and-forget for the same reason the voice ones are, so the same silent failure applies; the cause is logged as `Dropped interview turn`.

**The v3 engine: the relay owned the turn (RETIRED 2026-09, and the reasoning outlives it).** The session runs `turn_detection.create_response: false`, so upstream no longer asks the next question by itself the moment the student stops speaking — it did, and that is why the phase directive was structurally one response late and why a cough could create a question. Now the relay waits for the transcript (on a deadline, because a wait nobody bounds is an interview that never continues), judges it with a deterministic word-count gate rather than a hot-path model call, ticks the phase machine, and only then issues **one** `response.create` from **one** call site — which is what makes "one open question at a time" a property of the call graph instead of a sentence in the persona. If a second `response.create` site ever appears after the handshake, that invariant is gone and no test will notice. The arc is still `opening → probing → deep_dive → wrap_up` on each *accepted* answer, steered by an instructions-only `session.update` per phase change; the student picks HR, Digital Marketing, Business Analytics or Financial Analytics and the client sends it as `?specialization=` (no param runs the generic interview, which never reaches wrap-up and so never produces a report; an unknown key is refused with close 4010). At wrap-up the model speaks its verdict, and then one further **text-only** `response.create` in the same session produces a strict-JSON scorecard — parsed defensively, never spoken, never written into the chat history, and persisted whatever happens to it. The arc now opens and closes like a real interview: OPENING is a greet/self-introduction beat (the hard scenario question moved to PROBING), and the tick into WRAP_UP first asks "any questions for us?" — the student's reply, never word-gated, earns the verdict, and only the verdict's `response.done` (gated on `_verdict_requested`) requests the scorecard. Voices are per-specialization on the matrix row (HR `coral`, DM `marin`, BA `cedar`, FA `ash`), set in the single startup `session.update`, with `OPENAI_REALTIME_VOICE` as the generic fallback (validated against the known set, logged fallback to `alloy`); `_advance_turn` remains the single post-handshake create site, the invite/verdict beats included. Instructions are still the base persona **verbatim** plus a fixed specialization block, a phase directive and a fixed clarification override; **no student transcript is ever composed into them**, which is a guardrail of shape rather than of necessity — the moment student text goes into an instruction string, the next editor puts a resume there. Rule 1 is unaffected.

The interview now leaves a **record of its own**, in four tables (`app/models/interview.py`) that are *in addition* to `messages`, never instead: `interview_sessions` (one per interview — the terminal status, the phase it reached, `turns_emitted` vs `turns_persisted`, and the consent grant), `interview_turns` (the phase a turn happened in, whether the transcriber actually heard it, whether it advanced the arc — an empty `content` is legal and means exactly that), `interview_evaluations` (the scorecard, with **nullable** scores, because a missing score and a zero mean opposite things to a mentor), and `interview_consents`. The student reads their own at `/student/interviews`; staff read them through rule 2's gate. A `running` row that is never closed is a record that lies, so three layers close it — the relay's finalizer, the router's `finally` backstop, and retention's orphan sweeper for the process that was killed — all idempotent against each other by one `AND status = 'running'` predicate. The whole record is deleted after `INTERVIEW_RETENTION_DAYS` (180).

**Consent is a row and the socket enforces it.** No live `interview_consents` grant for the current `INTERVIEW_CONSENT_VERSION` and the interview never opens — close **4013**, refused before anything is written; revoked while it runs and the heartbeat notices within a minute — close **4014**. Three separate booleans (live AI, store transcript, store audio), because they are three different disclosures and one boolean makes "they consented" unfalsifiable. `interview_sessions.consent_id` pins the exact grant, so *"was this student consented, to what wording, at the time of interview X"* stays answerable after it has been revoked. Opening fails **closed** and the mid-interview check fails **open**, deliberately: "we could not check whether they agreed" must never start an interview, and a database hiccup must never end one that a real grant authorised.

**Audio: off, and "off" is two independent switches.** Nothing is captured unless `INTERVIEW_RECORDING_ENABLED=true` *and* the student holds a live grant whose `scope_store_audio` is true — a separate, unticked checkbox whose copy says plainly that staff can listen. Neither is true in a default deployment. When both are, `app/interview_audio.py` writes two WAV files per interview (one per speaker, never mixed — the two directions are not time-aligned), capped by `INTERVIEW_RECORDING_MAX_BYTES` with a truncation flag rather than a silent cut, retrievable only by whoever holds `admin.interview_audio` (the Main Admin by baseline; a MENTOR only by an explicit grant) and deleted on the same 180-day clock. Branch on `interview_sessions.audio_recorded`, **never** on `audio_path IS NOT NULL` — a NULL path collapses four different facts into one. This overrides `docs/interview-engine-v3.md` §8.4, which argued against capture; read that section anyway, because it is why every guard above exists.

**The LiveKit voice stack was REMOVED in 2026-09.** `voice_agent.py`, `app/routers/voice.py` (`/api/voice/*`), `requirements-voice.txt`, the `chat-voice.service.ts` client, the orb's voice overlay, the CI `worker-imports` job and both `livekit-*` dependencies are gone, along with the fourth process and its separate Python 3.12 venv. It was a four-stage cascade (Groq Whisper -> Groq Llama -> TTS) over LiveKit's WebRTC transport, and it was superseded by the mock interviewer, which is genuinely speech-to-speech. **The one voice experience now is `/student/assistant`** (Amazon Nova 2 Sonic, in-process, no extra venv). Three things survived the removal on purpose: `Message.channel` is still a plain String column, so historical `voice` rows read back unchanged and the runbook query above still groups by it; `conversations.append_message`'s `provider_turn_id` dedup is still the interview's first dedup layer, now pinned by `tests/test_conversation_dedup.py` instead of through the deleted endpoint; and `AgentHistoryService` (`apps/web/src/app/core/`) carries the three non-voice members the interview screen needs — `chatHistory`, `loadHistory()`, `clearConversation()` — out of the 840-line service that was deleted.

The text orchestrator (`POST /api/agent/ask`) **has a UI caller**: the REEP Agent chat screen (`apps/web/src/app/features/agent/`) is routed at `/student/agent`, `/mentor/agent` and `/admin/agent`, and the floating orb now taps straight through to it. So `AGENT_RUNS_COLLECTED` in `app/routers/agent.py` is **`True`**, `POST /api/agent/feedback` records thumbs against the run, and `GET /api/agent/metrics` reports real counters. Flip that one constant to `False` if the chat screen is ever unmounted, and both surfaces say so rather than reading a frozen history as a live zero.

`apps/interview-realtime/`, the superseded standalone prototype of this relay (no authentication, no database), was **deleted in 2026-09** along with `ollama/` and `tools/cascade`; the in-process relay above is the only interviewer.

## The voice-assistant platform (2026-09)

`apps/api-py/app/voice_platform/` is the dual-path (Undergraduate / Postgraduate)
interview platform from the system-architecture diagram — Admin CRUD for a
per-degree catalogue (specializations, questions, time limits, recording
policies, candidates), the `/ws/media-bridge` socket, S3 → Lambda → SQS
candidate ingest, dual-channel call recordings uploaded to S3 with presigned
`recording_s3_url`s, DynamoDB session state, OpenSearch session logs and
question vectors, and CloudWatch/Sentry hooks. Full notes:
`docs/voice-platform.md`; infrastructure: **AWS CDK** in `infra/cdk/` (the core
stack stays Terraform in `infra/aws/`, untouched; the api reads the CDK stack's
SSM parameters at boot via `app/voice_platform/ssm_config.py`, so Terraform is
not part of the platform's deploy path).

**It reuses the interviewer; it does not fork it.** The media bridge compiles
catalogue rows into an `interview_matrix.Specialization` (which gained an
optional `question_bank`) and runs `NovaSonicSession` (which gained an optional
per-session `max_seconds`), calling the interview router's own `_open_records`
and writers — so consent (4013), the caps (4012/4015), rule 1's containment and
the `interview_sessions` record all apply unchanged. A platform call is a real
interview with a `platform_call_sessions` row beside it. **Every AWS projection
is optional and honest**: no bucket/queue/table/endpoint configured means that
piece is off and `GET /api/platform/admin/status` says so; nothing pretends.
Recording needs THREE switches — the degree's policy, `INTERVIEW_RECORDING_ENABLED`,
and the student's live `scope_store_audio` grant.

## The design-v4 screens (2026-09)

The four UIs (student, mentor, admin, alumni) follow the Claude Design export
at `docs/design-v4/reep-app-standalone.html`. The sidebars are the design's:
students get Home, Jobs, Skilling, Leaderboards, Time Sheet, Mentor / TPO Log,
Resume Builder — **no Badges screen and no agent link** (the badge grid lives on
Skilling; the orb's "Type instead" opens `/student/agent`); admins get
Analytics, Leave Approvals, Mentors & Students, Jobs Sheet, Exports, REEP Agent
(Registrations, Catalogue and Placement stay routed and are reached from the
Analytics tiles). The REEP Agent chat (`features/agent`, `POST /api/agent/ask`)
is the design's assistant, so `AGENT_RUNS_COLLECTED` is `True` again. Deleted
with this: the student Badges, Overview, Academics and Offers screens, the
mentor Badge Centre and the placeholder component. **The mock interviewer is
NOT in the design and was kept on purpose** — it is deployed and working, and
it is the landing's Elevate "Mock Interview" module (`/student/assistant`).

## The 2026-09 redesign — the shell, and the navigation as data

The approved boards are `docs/redesign-2026-09/` (the implementation kit, kept
in the repository because every phase prompt cites paths under it). Phase 0 is
the shell and the design system; the screens themselves arrive in the later
phases, and the sidebar says so rather than hiding them.

**The navigation is DATA, not markup.** `layout/app-shell.component.ts` declares
`ADMIN_NAVIGATION`, `STUDENT_NAVIGATION`, `FACULTY_NAVIGATION` and
`ALUMNI_NAVIGATION` as arrays of `NavigationGroup`, and the template renders
whatever the `navigation()` computed returns. That is what makes the answer to
"which screens does this role see" a list one can read, rather than a `@if`
tree; the old template had the four roles' items interleaved in one block with
role conditions on each, and adding a screen meant finding the right `@if`.

An item with `path: null` renders as a LABELLED, NON-CLICKABLE row carrying its
`arrivesIn` badge ("Available with Phase 2"). This is deliberate and it is the
opposite of the usual instinct, which is to leave an unbuilt screen out until it
works: the boards show the admin six groups, and a sidebar that grows a new
group each fortnight reads as an app that keeps changing shape. A row nobody can
click is honest about what is coming; a missing row is not. `.nav-pending`'s
label ellipsises, because "Students & batches" does not fit the 220px nav
alongside a badge.

**`capability` on an item is a filter, never a gate.** `grantedAdminScreens()`
hides a row the session does not hold, and that is a convenience — the API's
`require_capability` is what refuses the request. A client-side check that looks
like authorisation is how the next person stops writing the server-side one.

Four capabilities are deliberately absent from the Main Admin's sidebar
(`mentor.mentees`, `mentor.notebook`, `mentor.verifications`,
`mentor.upskilling`): `_FACULTY_ONLY` in `app/governance.py` keeps them out of
the ADMIN baseline, so those screens would render empty for the office account.
Confirmed live rather than by reading — asking `GET /api/mentor/mentees` as the
seeded Main Admin answers 403 naming `mentor.mentees`, while the seeded mentor
gets their one mentee.

### The dev MCP surface at `/mcp` (development only)

`app/dev_mcp.py` publishes every GET under `/api` as an MCP tool, so a screen's
data can be read AS THE SEEDED ROLE while the screen is being built — the check
that the board and the payload agree, made without clicking through a browser
and trusting what is drawn. `apps/api-py/tools/mcp_probe.py` is a client for it;
`tools/pg_mcp_probe.py` is the same idea against `postgres-mcp` in restricted
(read-only) mode, for the before-and-after of a migration. Setup:
`docs/redesign-2026-09/MCP-SETUP.md`.

**Three things keep it from being a second front door**, and they are in the
module's docstring for the next reader: it mounts only when `settings.mcp_enabled`
(an ENV allowlist AND an explicit `MCP_DEV_SURFACE` flag, so an unrecognised ENV
shuts it like every other door in `config.py`); it is read-only BY CONSTRUCTION,
deriving its tool list from the app's own GET routes rather than from an exclude
list somebody maintains; and `fastapi_mcp` is imported inside the function and
lives in `requirements-dev.txt` alone, so it is not in the production image at
all and `api-imports` still passes. `tests/test_codebase_guards.py` §33 pins all
three, the last by parsing the `FastApiMCP(...)` call and asserting no write
operation reaches the tool set.

Two traps are worth carrying forward. `include_tags=` does NOT work here: in
fastapi-mcp 0.4.0 the filters UNION rather than intersect, and every tag REEP's
routers carry contains write routes, so the kit's draft would have published
`DELETE /api/admin/cohorts/{id}` as a tool. And the operation ids must be read
from `app.openapi()`, not from `app.routes`: FastAPI 0.141 keeps included
routers as nested objects rather than flattening them, so walking `app.routes`
finds four documentation endpoints and the mount silently publishes nothing.

`python -m app.dev_session --email <address>` mints the cookie those tools
forward. It mints at the CURRENT `token_version` WITHOUT advancing it — a helper
that did "the same as login" would retire the developer's own browser session
for that account every time it ran, and the two would take turns, with the loser
each time looking like a bug in the mount.

## Infrastructure — CDK, and the cutover that HAS been run (2026-09)

**CloudFormation owns `reep-core`. Terraform is released and its fifteen `.tf` files are deleted** (commit `38eb7dd`, steps 6 and 7 of `docs/cdk-cutover.md`): `terraform_release.sh` dropped 82 managed addresses after checking the stack was `IMPORT_COMPLETE`, and the plan afterwards reads "82 to add, 0 to change, 0 to destroy" — the proof Terraform no longer knows these resources, and **a plan that must never be applied**. The state file before release was kept locally and gitignored, so the undo exists on one machine and not in this repository. `infra/aws/` still holds `bootstrap-state.sh` and `grant.sh` and nothing else.

Read the rest of this section as the RECORD of how that was done, because the reasoning is what protects the next migration of this shape — not as pending work. The rule that governed the order was: **never delete a `.tf` file before Terraform has released its state, and never release the state before `cdk import` has succeeded and drift detection is clean** — the wrong order is a `terraform apply` that destroys the database. The window between release and deletion is the most dangerous in the procedure (configuration present, state empty, one apply away from a duplicate production), which is why step 7 followed step 6 immediately. The synth guards that compared physical names against `infra/aws/*.tf` now SKIP themselves (`requires_terraform` — 61 passed, 22 skipped); the mirror is proven from here by the import and by drift detection instead. `reep-core` has two phases on one context key: `phase=import` is a mirror of what exists, carrying the LIVE values the import tool reads from the state, and nothing else (CloudFormation refuses an import template that adds resources it cannot adopt); `phase=harden` adds the fixes, split by `hardenEcs` so a circuit-breaker rollback cannot undo a Multi-AZ conversion in the same update. Every physical name is the Terraform name; the synth tests (`infra/cdk/tests/test_core_synth.py`, run by CI's `cdk` job) read them out of the `.tf` files where those still existed, and skip where they do not; no `MasterUserPassword` can appear; every resource in all three stacks is `Retain` (the database included — *Snapshot* means delete-after-snapshot). **Fargate caps `stopTimeout` at 120 s.** What keeps a 480 s interview socket alive through a deploy is the target group's 600 s deregistration delay, and `tests/test_codebase_guards.py` compares that CDK constant against `nova_sonic_connection_seconds` so the two cannot drift. `deploy.yml` therefore no longer uses `aws ecs wait services-stable` (its 10-minute cap is exactly one drain). Backup after harden: one retention number (35) for RDS, the daily rule, the cross-region copy to `reep-vault-dr` in ap-southeast-1 and the governance vault lock; a weekly restore test; three failure alarms. The `cleanup-orphans.sh` script that deleted the production cluster by name is gone. The import identifiers in `tools/import_map.py` are the CloudFormation registry's composite keys, cross-checked by `get-template-summary` in the runbook — eight of the first draft's were wrong, which is why the runbook was reviewed adversarially before it was written down. **Step 0 of that runbook is one read-only command**, `infra/cdk/tools/cutover_preflight.sh`: it checks the tools, the venv, the synth guards, the credentials' account, the three bootstraps and a clean `terraform plan` — after reconstructing `infra/aws/prod.tfvars` from the state with `tools/tfvars_from_state.py`, because the first apply's values were typed as `-var` flags and recorded nowhere, and without them the plan can never be clean. The import tool runs in two passes, **context before synth** (`import_map.py tf-state.json`, then `cdk synth`, then the map against that template): a context-free synth renders one plain-HTTP listener where the live ALB has two. `infra/cdk/tests/test_cutover_tools.py` rehearses that sequence against a synthetic state, and writing it found three blockers no guard had reached — the wrong order above, an OIDC ARN written while the provider was in the state (the re-synth dropped the mapped resource), and a TLS branch that did not synthesise at all (`SslPolicy.TLS13_12` is not a member of the library; none of the 58 guards had ever set a certificate). No cutover tool runs for the first time with credentials in hand any more, and the GitHub deploy role cannot run the cutover from the browser by design: it holds ECR, ECS, S3 and CloudFront rights only, none for CloudFormation, RDS or the state bucket.

## The two rules that must not be broken

### 1. Student data must not leave the machine unbidden

`LLM_BASE_URL` is a URL, not a promise — it may point at a free model that trains on submissions. A resume brief carries a student's name, USN, marks and attendance.

`student_data_egress_allowed(base_url)` in **`apps/api-py/app/ai/llm.py`** is the gate: **loopback is always allowed; anything else requires `LLM_ALLOW_REMOTE_STUDENT_DATA=true`.** Call the model through `complete_chat(messages, carries_student_data=True, ...)` (or `stream_chat(...)`) on any path that sends a student's private records, and it is refused before leaving the process unless the gate permits it. When it refuses, `/student/resume/generate` composes the resume **deterministically** and says so (`used_ai=false`). Route any *new* student-PII-to-model path through this gate. Public data (a job posting) does not need it.

### 2. Staff scope is decided by role, not by a missing field

`require_mentor(session)` admits **MENTOR and ADMIN**; `require_admin` admits the Main Admin alone, and it is now the ONE console gate (`require_director` is gone — see “DIRECTOR is not a role” below). To narrow to students, use `_assert_can_access_student(...)` in **`apps/api-py/app/routers/mentor.py`**: a MENTOR sees only students in their own `Mentor` group; the Main Admin sees all. **A MENTOR with no `Mentor` group sees NOBODY** — never the whole programme. Never read "no mentor group" as "whole programme".

### Rule 1 applies to telemetry too: Sentry is one init per process, and the scrubbers are the floor

Sentry is a second HTTP transport out of the process, carrying whatever the SDK
attaches, and `student_data_egress_allowed` does not guard it. Three processes
report, each to its own Sentry project through its own DSN, each through
**`init_sentry(service, dsn)` in `apps/api-py/app/observability.py`** and
nothing else: `reep-api` (`app/main.py`, `SENTRY_DSN`), `reep-scheduled-jobs`
(`app/retention_job.py`, `SENTRY_JOBS_DSN`) and `reep-interview-worker`
(`app/voice_platform/queue/worker.py`, `SENTRY_INTERVIEW_WORKER_DSN`). A blank
DSN is OFF and says so once; a process never borrows another's DSN — the
retention job runs on the api's task definition with `SENTRY_DSN` in its
environment and must not read it, because a nightly sweep filed under the api's
issues is a job nobody watches. Three constructor flags are rule 1 —
`send_default_pii=False`, `include_local_variables=False`,
`max_request_body_size="never"` — and `tests/test_codebase_guards.py` reads
that file as text to pin them, plus the four hooks (`before_send`,
`before_send_transaction`, `before_breadcrumb`, `before_send_log`) that route
every payload through **`app/telemetry_scrub.py`**: the query string is
allowlisted (a `?token=` never travels, a `?board=` does), log arguments are
redacted as well as the formatted line, the mail transport's body log is muted,
and a scrubber that raises drops the event rather than shipping it.
`tests/test_observability.py` proves it against the real SDK with a capturing
transport. The browser twin is `apps/web/src/app/core/telemetry-scrub.ts`, the
SDK is reached only through `apps/web/src/app/core/sentry-lazy.ts` (a direct
dynamic import of the package ships the Session Replay recorder to reach four
symbols), and **Session Replay stays unconstructed** — it cannot be blocked per
route and nineteen routes render a student's records. The environment tag is
`ENV` verbatim (`prod`, not `production`), the release is the commit sha baked
into the image and stamped into the SPA by `deploy.yml`, and the whole design
record is `docs/sentry-playbook.md`.

## The v2 student screens (2026-08)

Three screens the handoff adds, with their own tables and endpoints in
`app/routers/student_programme.py` — its own module so `routers/student.py`
(2 200 lines, and the file every other student change touches) did not grow
another 600. It mounts under the same `/student` prefix, so the client sees one
flat surface.

**Time Allocation Ledger** (`/student/time-log`) — six slots covering a 24-hour
day x five activity heads. **The unit is the half hour, stored as an integer.**
The day must reconcile to exactly 24 h before it may be submitted, and a float
column makes that a game of epsilons: drift across thirty cells leaves a
perfectly filled day sitting at 23.999999 and refusing to submit, with nothing
on screen to explain it. Integers make "does this add to 24" an exact comparison
against 48, and the API converts at the edge so the client still speaks hours.
Every cell is bounded twice, both from `SLOT_CAPACITY_HALVES`: no cell over its
slot's capacity, and no slot's five cells summing past it. `copy-yesterday`
copies only a **SUBMITTED** day — copying a half-finished draft spreads a mistake
forward with nothing saying where the numbers came from. Submitting latches the
day; it is then read-only. It does **not** replace `time_sheet_entries`, which
still answers the weekly SKILLING-hours-vs-target question the dashboard draws.

**English Baseline** (`/student/english`) — CEFR-aligned, AI-scored, one attempt
per semester. **Every score is nullable and that is load-bearing**: speaking is
scored after the other three, so "3 of 4 sections scored - Speaking pending" is
the healthy state, and a pending section rendering as a confident `0` in a 27px
numeral tells a student they failed something they have not sat. The client
branches on `status`, never on a falsy score. `provisional` is derived from how
many sections are scored, so the word cannot outlive the section that resolves
it.

**Mentor Meeting Log** (`/student/mentor-log`) — the student's own 1:1 history,
read from `mentor_notes` (extended with nullable `title` / `location`; existing
notes are **not** backfilled, because inventing a heading puts words in a
mentor's mouth on a screen the student reads). The mentor's internal vocabulary
is translated server-side — `FLAGGED` reads as "Flagged for follow-up".

**The landing stage cards** (`GET /api/student/programme`) — Reboot / Excel /
Elevate. **The catalogue is code and only the status is a row**
(`app/models/milestone.py`): seeding fourteen rows per student to say "not
started" would put the programme's shape in the database in thousands of places,
where a rename becomes a migration. One item is derived rather than stored —
`english_baseline` reads its status from the attempt, because two sources of
truth for one row is how that row ends up saying "not started" under a finished
report.

`python -m app.seed` seeds all four, including a ledger deliberately 0.5 h short
so the "0.5 h to reconcile" state is the one you see on a fresh database.

**Staff read these through rule 2's gate**, in `app/routers/mentee_records.py`:
`GET /api/mentor/students/{id}/ledger`, `.../ledger/summary` and
`.../english-baseline`. Every one names a student in the PATH, so every one goes
through `_assert_can_access_student` — imported from `routers/mentor.py`, never
reimplemented. The views are the **student's own**: `compose_ledger` and
`compose_english_baseline` are shared builders, so a mentor cannot see a
confident `0` where the student sees a dash. Read-only by design — a mentor's
instrument is the meeting note, which already has a write path.

The write paths behind the screens' buttons: `POST /english-baseline/start`
(idempotent — one attempt per semester is enforced by a unique index, so a
double-tap reads the existing row rather than 409-ing), `GET
/english-baseline/report` (ReportLab, local, so rule 1's gate does not apply —
do not add a remote renderer), and `POST /mentor-meetings/request`, which writes
a **mentor note** rather than inventing a requests table: that is already the
mentor's instrument for this student and already on their screen.

## The Skills & Badge dashboard (2026-08)

Implements the "REEP Student Skills & Badge Dashboard Developer Framework"
document end to end for CURRENT students, structured exactly as its §19 asks:
REEP stage → skill category → skill → evidence → badge → growth.

**The 48-badge catalogue is code** (`BADGES` in `app/models/badge.py` — 12
managerial, 16 sectoral across four tracks, 10 platform/technical, 6 thinking,
4 readiness), the milestone rule again: only student state is rows. The
framework's §18 "admins add/edit badges" is therefore a code change HERE, on
purpose; what admins maintain in the database is the **Approved Certification
Catalogue** (§12, CRUD under `/api/admin/approved-certifications`), evidence
verdicts, manual awards/revocations and assessment scores. `test_badges.py`
pins the catalogue's shape against the document.

**Certificate ≠ badge, enforced by the write path**: a student attaches
evidence (`badge_evidence` — several per badge, one per §11 type; the document's
own Negotiation example) and only a staff APPROVE on
`/api/mentor/badge-evidence/{id}/review` mints the `student_badges` EARNED row,
points stamped from the catalogue at that moment. §13 display status is DERIVED
(`compose_badges`), never stored. Readiness badges (§8) refuse evidence — they
arrive only through the manual-award endpoint when assessment thresholds are
met. Revoke is the Main Admin's and deletes the award row, never the evidence
history.

**Growth (§9/§15)** is `capability_assessments` — seven capabilities, 1–10, at
T0–T4, staff-entered and upserted. Every derived score is nullable and a
missing score renders as a dash: growth is claimed only when T0 AND a later
checkpoint both exist, because 0.0 with only a baseline says "has not improved"
when nobody has looked. The §16 **Most Improved** leaderboard ranks that growth,
not points; every leaderboard honours the existing `leaderboard_opt_out`.

Screens: `/student/badges` (journey strip, tiles, §14 detail + claim form,
growth table, leaderboards) and `/mentor/badge-centre` (verification queue
with the scoped certificate stream, assessment entry, §17 skill profile,
cohort CSV at `/api/admin/badges/export.csv`). Staff reads reuse
`compose_badges`/`compose_growth` — the mentor sees exactly the student's own
screen. Rule 1 untouched (nothing here calls a model); rule 2 via
`_assert_can_access_student`, with the pending queue narrowed in SQL.

## Reachability and keyboard access — what a full browser audit found (2026-09-10)

All 38 routes were driven in a real browser as all four roles. **The business
logic held: five cross-role write chains passed end to end** (leave → approval →
official PDF with both signatures; jobs → student feed with match % and alumni
feed correctly without it; SWOC → student home + Faculty/TPO Log with the
viewpoint derived from role; governance grant → faculty sidebar → revoke;
student create → roster + batch + SWOC + analytics counters → delete with no
orphan rows). Eleven defects were found and every one was about **reachability
or accessibility**, not business rules — with a single exception. The lessons
worth keeping:

**A leave request whose dates ran backwards was accepted, approvable and
printable.** `from_date` and `to_date` were two independently declared `date`
fields with nothing relating them, so 20 Dec → 10 Dec stored a span of MINUS
TEN days, reached the approver's queue with a live "Mark Sanctioned" button, and
rendered onto the college's own form. The refusal is `LeaveIn`'s
`dates_run_forwards` validator — **on the schema, because the leave form and its
buttons must not change**, so the request has to die before it is built.
`from == to` stays legal: a PERMISSION slip and a one-day CASUAL leave are both
written that way on the paper form. It needed a SECOND fix to be usable at all:
FastAPI answers a schema error with `detail` as a **list**, so the form rendered
`[object Object]` — `leave.component.ts` now uses the same `detailOf` helper
`governance.component.ts` already had.

**A screen that is routed is not a screen anyone can reach.** Four fully working
screens — `/student/profile`, `/student/uploads`, `/student/courses` and
`/admin/catalogue` — were reachable only by typing the URL. The sidebar
comments *said* they were "reached from the screen that owns the work" and "from
the Analytics tiles", and for the others that was true; for these four nobody
ever added the link. **A route with no `routerLink` anywhere is dead**, so grep
for the path, not for the component. Two further traps live here: `routerLink`
in a standalone component with `imports: []` is **inert markup that renders and
does nothing**, and `/mentor` loading the notebook component *as well as*
`/mentor/notebook` meant `routerLinkActive` matched nothing, so every faculty
member landed at every sign-in on a screen with no nav item lit. One screen, one
URL — `/mentor` is a `redirectTo` now, deliberately **without** a `canActivate`,
because Angular resolves redirects while matching the URL, before guards, so a
guard there would be dead config that reads as protection.

**`hidden` on a file input makes the picker mouse-only.** `hidden` is
`display:none`, which removes the input from the focus order, and a `<label>`
wrapper is not tabbable either — so on `/mentor/signature` the only
keyboard-reachable control was **"Remove…"**: you could delete your signature
but never upload one, and on the public `/register` an applicant could not
attach a CV or headshot at all. Hide these with geometry
(`position:absolute; width:1px; clip`), never `display:none`, and give the label
a `:focus-within` ring or the focusable invisible input is a trap. Five other
screens already used the correct `<button (click)="picker.click()">` pattern.

**`.icon` renders from ligatures, so an unlabelled icon is read aloud.** A
screen reader announced "hourglass top" and "add circle". 286 spans across 38
templates now carry `aria-hidden="true"` — but **blanket `aria-hidden` is not
safe on its own**: it silently unnames any control whose only content is the
icon. Five such buttons had to be given `aria-label`s, and the sweep script
reports them rather than guessing a name.

**A message inserted by `@if` is announced to nobody unless it is a live
region.** `/register` — the most public form in the product — showed "Your full
name and college email are both required." in a plain `<div>`: no `role="alert"`,
no `aria-invalid`, no focus move. 21 other templates already did this correctly.
Page titles had the same shape of problem: they were `<div class="dt-title">`,
so 29 of 38 screens had **no heading element at all**. Converting to `<h1>` is
visually free because `.dt-title` sets `margin: 0`. `/student/assistant` is the
screen to copy — real `<h1>`, `role="status"`, `role="log"`, named regions.

**And a warning about testing this stack in a browser harness.** Five findings
in that audit were false alarms produced by the harness, each of which looked
exactly like an app bug: a synthetic `.click()` does not drive the agent orb's
pointer-threshold gesture; `window.prompt` is auto-dismissed, so the code path
posts an empty value and the server's 422 looks like a broken button;
`element.textContent` does not include a `<textarea>`'s value, so a saved SWOC
line looked unrendered; a DOM read taken before a post-write refetch shows the
old list; and slicing an options list to the first 16 produced the conclusion
"Governance offers no `admin.*` capabilities" when it offers all 28. Restart the
API after touching a `.py` — there is no `--reload` here, and a stale worker
silently accepted a request the new validator refuses.

## The faculty & alumni pages (2026-08)

**Faculty** (any staff role, in the shell's staff nav): **Mentee Log**
(`/mentor/mentees` — mentees + meeting notes, on the existing
`/api/mentor/mentees` and `/notes` endpoints, all behind rule 2's gate),
**Leave Requests** (`/mentor/leave` — submit own + the two-approver queue on
`/api/leaves/*`), and **Upskilling** (`/mentor/upskilling` — the staff member's
OWN completed-course certificates, `app/routers/staff_upskilling.py`). The
upskilling shelf is keyed on `users.id`, not a Student row, goes through the
same hardened document_store as student uploads, applies its own per-user quota
(document_store's contract for any second `save_bytes` writer), and has **no review
workflow** — a staff certificate is a record, not evidence awaiting a verdict.

**The leave paper and the signature (2026-09).** `GET /api/leaves/{id}/paper.pdf` (`app/routers/leave_paper.py`, rendered by `app/leave_paper.py` with ReportLab, locally) is the college's OWN form PDF (`app/assets/leave_form_template.pdf`, the office's "Leave Form.pdf", pinned by size) with the request written onto it as a ReportLab overlay merged by pypdf — the form is never redrawn, and the field coordinates are measured from that exact file — for the applicant and for exactly the staff `_assert_can_decide` admits, every refusal the same 404. A staff member uploads ONE signature image at `/mentor/signature` (`PUT /api/staff/signature`, PNG/JPEG under 2 MB, replaced in place, `app/models/staff_signature.py`); it is drawn ABOVE the name and time in the two staff blocks of every paper they apply on and in the PROGRAM DIRECTOR block of every paper they sanction. **A signature is still a name and a time**; the image never replaces either, and the leave form's submit/decide endpoints and buttons are untouched (the owner asked for that) — the paper router imports `_leave_out` and `_assert_can_decide` rather than restating them.

**Alumni** are a real role: `Role.ALUMNI`, no Student/Mentor row, no staff
scope, session claims carry neither `studentId` nor `mentorId`. Their surface
is `app/routers/alumni.py`: `GET /api/alumni/profile` answers `created: false`
until they save one — that flag (never a falsy company string) is what makes
the client show the FIRST-LOGIN create form (current company + current resume,
resume required on create, kept-if-omitted on update) — plus their resume
download and `GET /api/alumni/jobs`, the postings sheet **without** the student
feed's match % / eligibility verdict (those are computed from a Student's
skills and marks, which an alumnus does not have). The shell's sidebar switches
on role (`navKind` in `layout/app-shell.component.ts`), and the SPA's `''`
route now routes by role through `homeRedirectGuard` instead of sending every
role to `/student`.

## The institutional spine and the Main Admin console (2026-09)

    College -> Department -> Course -> Specialization -> Cohort("Batch") -> Student.cohort_id

`app/models/institution.py` holds College, Department, `AcademicCourse` and
`AcademicSpecialization`; `students.cohort_id` is a real FK. **The student's
locked profile card is read THROUGH that join and stored on nothing** — one flat
LEFT-JOIN query in `routers/student.py::_institution_for`. Do not copy any of
it onto `students`: that is the backfill this shape exists to avoid.
`AcademicCourse` is prefixed because `Course` (app/models/course.py) is a taught
subject; `Specialization` is already three other things. The UI says "Course",
"Specialization" and "Batch".

**Course and Specialization are OPTIONAL, and the switch is one line.**
`HIERARCHY_LEVELS` in `app/models/institution.py` says which must be named on a
new batch; flip `required=False` to `True` and deploy — no migration, no second
edit. `AdminCohortIn`'s validator reads it and `GET /api/admin/hierarchy/levels`
serves it, so the Angular form (`features/admin/institution/`) builds
`Validators.required` from the same constant. **The columns stay nullable
forever** (`test_hierarchy_columns_stay_nullable`): nullability is a promise
about existing rows, `required` is a rule about new ones. The flip does NOT make
old batches compliant — `GET /api/admin/cohorts/incomplete` lists them,
`missing_levels` flags them, and PATCH refuses only an edit that *widens* the
gap. Ship the switch without that escape hatch and the console refuses saves on
rows nobody can fix.

`cohorts` carries all three parent pointers, and **`_resolve_ancestry` in
`app/routers/admin.py` is their only writer**: the client sends the deepest
level, the API derives the rest, and a contradicting shallower value is a 422 —
never a silent pick. `/api/admin/*` is Main Admin throughout and every
operation is proven to refuse a STUDENT (`tests/test_admin_institution.py`).

**One Main Admin (2026-09).** The placement office is ONE account, role ADMIN. `python -m app.grant_access` refuses a second ADMIN while an office account exists (the message says how a handover is done: demote the current one to MENTOR first) and refuses DIRECTOR outright — that role held every console screen by baseline, which was a second admin under another name, and it has since been removed entirely. Faculty are MENTOR, and a console screen reaches them ONLY as a grant the Main Admin makes in Governance, which is `require_admin` end to end (API and route guard) — so a granted mentor can use the screen they were given and never hand it on. The login's portal chooser is Student / Mentor / Alumni; the office comes in through the dashed "Main Admin" door. **And a faculty account is not a mentor by existing**: it has no `Mentor` row and sees nobody until the Main Admin assigns it a student on Mentors & Students — `GET /api/admin/mentor-load` lists every MENTOR-role account (`mentor_id` null until then) and `POST /api/admin/students/{id}/mentor` with `mentor_user_id` creates the group on that first assignment. No flag at creation, no second step; `grant_access --with-group` is now optional. **The Main Admin creates faculty accounts on screen**: Faculty & Students → "Add faculty member" → `POST /api/admin/faculty` (`app/routers/admin_faculty.py`, `require_admin`) mints the MENTOR row with the unusable password sentinel and no group, and shows the ACTIVATION LINK to hand over; "Activation link" on a faculty card re-mints it through the existing `POST /api/admin/users/{id}/activation-link`. The Ops task's `grant-access` still works and is the fallback for the very first account. **The Main Admin EDITS students and cannot mint or erase one (2026-09-10)** (`app/routers/admin_students.py`, capability `admin.students`, screen `/admin/students`): edit (name, address, USN, batch, faculty, stage, semester) and per batch `POST /api/admin/cohorts/{id}/students/bulk` (move / assign faculty / set stage / set semester, the single action repeated) plus `DELETE /api/admin/cohorts/{id}` for an EMPTY batch only. **There is no `POST /admin/students` and no `DELETE /admin/students/{id}`, and no bulk delete** — all three answer 405, never 403, because a capability refusal would mean the endpoint is still there waiting for a grant. A student account is minted by exactly one path, approving a registration, which records an application, a reason and a reviewer and then makes the person prove their mailbox; an admin-side create was a second way onto a roster that IS the access control, with none of that. And a delete erased marks, attendance, uploads, interviews and mentor notes behind a two-click confirm sitting among buttons that only move somebody between batches — emptying a deployment of people is `python -m app.purge_people`, which dry-runs by default and is built for it. Empty a batch by MOVING its students out. The vocabulary on screen is Student / Faculty / Alumni and Main Admin; "mentor" is a stored value, not a label.

**DIRECTOR is not a role (2026-09-10).** REEP had two office roles and only ever
wanted one. DIRECTOR held every console screen *by baseline* while ADMIN held
them by being the Main Admin, so it was a second administrator under a different
name; `grant_access` had already refused to mint one for months, and it survived
only in the dev seed, a few role sets and `ROLE_BASELINE`. It is gone: the role
gates (`policies.STAFF_ROLES`, `require_mentor`, `require_admin`), the capability
baseline, the seeded `director@bgscet.ac.in` account, `require_director` (29 call
sites, all now `require_admin` — one console gate, not two), the
`/api/director/*` routes (now `/api/admin/*`, verified collision-free against the
35 that were already there), `app/routers/director.py` — gone, and now
`app/routers/console.py` — and
`apps/web/src/app/features/director/` (now `features/admin/`, 14 screens).
Migration `7c4e0b21d9aa` converts any surviving row to MENTOR and bumps its
`token_version`, so no live session keeps the claim; its `downgrade()` raises
deliberately, because nothing records which MENTOR rows used to be DIRECTOR.

**The half-finished state was worse than not starting, and that is the lesson to
keep.** The role gates were done first, and for a few hours
`governance.ROLE_BASELINE["DIRECTOR"]` still read `_ALL`. Two systems decide
access here and they are checked separately ON PURPOSE (`app/governance.py`: "a
capability can never relax the student filter"), so the result was a session
refused by every `require_*` gate — it could not open its own mentee log — and
admitted by every `require_capability` one, which is roughly fifty endpoints
including `DELETE /api/admin/students/{id}` and the full-roster exports CSV. A
role removal that reaches one system and not the other opens the other. Both
halves are pinned together, for one session, in
`tests/test_no_director_privilege.py`, and `tests/test_codebase_guards.py` keeps
the naming from coming back — routes, modules, OpenAPI tags, the client's `Role`
union, and the two post-login home maps, which had already drifted (Google
sign-in was redirecting the Main Admin to the deleted `/director`).

**The word still appears in three places, all correct.** PROGRAM DIRECTOR is a
job title printed on the college's own leave form, so `leave.py`'s
`director_name` / `director_decided_at` / `director_note` and the block
`leave_paper.py` draws stay exactly as they are. `Role.DIRECTOR` survives as an
enum VALUE, because a Postgres enum value cannot be dropped without recreating
the type and the test needs to mint one to prove it reaches nothing. And
`director123` stays on `set_password`'s refusal list: the account is gone, but
the string was published here, so it must keep being refused.

**The Main Admin is not a faculty member, either.** Four capabilities —
`mentor.mentees`, `mentor.notebook`, `mentor.verifications`, `mentor.upskilling`
— are a mentor's own instruments, and `_FACULTY_ONLY` in `app/governance.py`
keeps them OUT of the office account's baseline: it has no mentees, no private
notebook, nobody's evidence to verify and no upskilling shelf, so those screens
would render empty for it. They stay GRANTABLE, so when a student's evidence is
stuck and nobody else will look, the Main Admin grants itself the instrument in
Governance — with a reason, on the audit trail. `ROLE_BASELINE["ADMIN"]` is
therefore deliberately NOT a superset of `ROLE_BASELINE["MENTOR"]`, which is what
`tests/test_governance.py` now pins, and the `granted` fixture in
`tests/conftest.py` is how a test takes that same path.


**Approval provisions, and two guards make that safe.** `POST
/api/register/{id}/decision` APPROVE now mints the User + Student + profile.
Because the roster IS the access control and the form is public, provisioning
refuses an address off `settings.provisionable_email_domains` and refuses an
address that already belongs to a non-STUDENT account (a MENTOR gaining a
`studentId` is rule 2 edited by a form). That fence is on provisioning and
deliberately NOT on sign-in — the two run in opposite directions, and the
property's docstring says why.

## Backend conventions

- **Models** live in `apps/api-py/app/models/` and are the schema's source of truth; each new module is imported in `models/__init__.py` so Alembic autogenerate sees it.
- **Alembic enum gotchas** (hit these repeatedly): (a) adding an enum *column* to an existing table does not auto-`CREATE TYPE` — create it first; (b) a *new table* reusing an *existing* enum must use `postgresql.ENUM(..., name='x', create_type=False)` in the migration (autogenerate emits a bare `sa.Enum` that errors "type already exists" — hand-fix it); (c) two columns sharing one enum reuse a single `Enum` instance.
- **Universal LLM adapter** (`app/ai/llm.py`) is OpenAI-compatible and auto-selects the first configured provider (Sakana → Groq → Mistral → OpenRouter → Gemini → Cohere), or an explicit `LLM_BASE_URL`+`LLM_MODEL`+`LLM_API_KEY`. One set of keys, any provider, no code change.
- **Knowledge Base = pgvector.** The docker image is `pgvector/pgvector:pg17` (stock PG17 + `CREATE EXTENSION vector`); `KnowledgeChunk.embedding` is a dimensionless `vector`. Retrieval (`app/knowledge.py`) is HYBRID — Postgres full-text blended with pgvector cosine (`embedding <=> :q`), gated by a distance floor so an off-topic query still hits the honest "no approved answer" fallback. The embedder (`app/ai/embeddings.py`) mirrors the LLM adapter: explicit `EMBEDDING_*`, else auto-select Mistral (`mistral-embed`) — and **no embedder configured ⇒ full-text only** (the KB always works). The KB is APPROVED public policy text, so embedding it is outside the student-data egress gate.

## Frontend conventions

- Standalone components + Angular **signals**; `fetch(\`${environment.apiBase}/...\`, { credentials: 'include' })` for API calls (see `apps/web/src/app/features/student/jobs/jobs.component.ts` for the house pattern).
- The "REEP v2" design system is **global CSS classes** in `apps/web/src/styles/reep-v2.scss` (`.card`, `.dt-table`, `.chip good/warn/risk/neutral`, `.dense-*`, `.ledger-*`, …) — reuse them; don't redefine globals in a component. Status is always shown as **text + colour together**, never colour alone.
- The design references are `docs/design-v2/*.html`.

### The v2 look, and the token shim under it (2026-08)

The visual language is the **Y2K-chrome / glass** handoff: a lilac-to-pink page
wash, white translucent cards on 1px lavender hairlines, **Plus Jakarta Sans**
for headings/labels (`--font-display`) and **Inter** for body and data
(`--font`), with a purple->magenta gradient reserved for primary actions and the
active nav pill. The handoff's own Orbitron/Chakra Petch pair was replaced
because Orbitron's wide techno letterforms were hurting the dense data screens —
the ledger, the analytics tables, the leaderboard — at the 13-14px those tables
actually use; the comment above the two tokens in `reep-v2.scss` is the record,
and several sizing rules downstream (`.dt-table`'s 9.5px uppercase became 10px)
were retuned for Inter's narrower caps rather than left at values chosen for
Orbitron's. It is **one committed
theme**, not a light/dark pair — every colour is painted explicitly and there is
no `prefers-color-scheme` block.

`reep-v2.scss` defines the handoff's tokens under honest names
(`--brand-purple`, `--ink`, `--surface`, `--hairline`, ...) and **every consumer
reads those**. The warm-paper aliases that stood there while the two designs
coexisted are gone — 286 references across 26 files were renamed — so a colour is
defined once and called one thing. The MUI-era `--reep-*` names survive for the
login, register and resume-builder surfaces, which sit outside the shell and
never adopted the component classes, but they are **defined in `reep-theme.scss`
with the v2 values** rather than overridden from elsewhere. One token, one place.
`reep-theme.scss`'s dark block is deleted: this is a single committed theme,
nothing calls `ThemeService.toggle()`, and a palette nobody can reach is a second
set of colours to keep correct for no one.

**Two global stylesheets, and they must not claim each other's names.**
`reep-v2-resume.scss` loads after `reep-v2.scss`, so it wins on every property it
sets and *leaks every property it does not*. Adding `display: flex` to
`.step-group`, `.completeness` or `.entry` in `reep-v2.scss` silently reflowed
the resume builder, because that file owns those names for a heading, a card and
a card. Before adding a class to `reep-v2.scss`, check it is not already defined
in `reep-v2-resume.scss`.

**`.icon` is clamped to a 1em box and hidden until the font reports itself
loaded, and both halves matter.** Material Symbols renders from LIGATURES, so
`<span class="icon">leaderboard</span>` is the literal word until the font
arrives. Without the clamp a sidebar item reserves ~90px for its icon and the
label is pushed out of the 220px nav; without the `fonts-ready` gate (set in
`main.ts` from the resolved `FontFace.status`, **not** from
`document.fonts.check()`, which answers yes for a fallback) the stray words show.
**The fonts are self-hosted**, in `apps/web/public/fonts/`, generated by
`tools/fonts/fetch-fonts.sh`. The icon face is SUBSET to the glyphs the app can
actually render (`tools/fonts/icon-names.txt`, regenerated by
`collect-icon-names.py`) — the full Material Symbols face is 5.2 MB against
172 kB for the 113 glyphs currently in it — which makes adding an icon a
two-command step rather than an optimisation: a glyph missing from the subset
renders as nothing at all.

`collect-icon-names.py` reads the templates, so it can only find an icon a
template already uses — which is a circular problem for a glyph a screen that
does not exist yet will need, and for one the scanner's denylist rejects as an
English word (`block`, `key`). `tools/fonts/icon-names.extra.txt` is the answer:
names DECLARED rather than discovered, unioned in after the denylist filter, one
per line with a comment saying which screen will want it. Put a glyph there when
you are about to build the screen that uses it; the alternative is discovering
on the day that the button is blank.

The floating **agent orb** and its voice overlay live in the SHELL
(`layout/agent-orb.component.ts`), not in a route, because they are on every
screen. Drag and tap are one gesture separated by a 4px threshold; the pointer
listeners go on `document` (a pointer leaving the 58px box mid-drag stops
delivering events to it) and are removed on pointerup **and** in `ngOnDestroy`.
