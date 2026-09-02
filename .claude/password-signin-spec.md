# Email & password sign-in with emailed one-time codes, beside Google, over the one reep_session cookie — final spec (winner + grafts, owner decisions (a)/(b) folded in)
_priority: High (P1). Ships DARK: LOCAL_AUTH_ENABLED defaults false and EMAIL_TRANSPORT blank, so every existing deployment (AWS task definition, docker-compose.prod, an unrecognised ENV) behaves byte-for-byte as today — Google only, POST /api/auth/login 403 outside dev/CI, no boot change (decision 10). Nothing in this feature is ever a boot failure (decision 5). Four commits, each green on its own, in this order: (1) `feat(api): email transport adapter` — app/email.py, the email_* settings, tests/test_email.py; (2) `feat(auth): email and password sign-in with emailed codes` — model, migration, app/local_auth.py, app/routers/local_auth.py, the guard rework, ratelimit FixedWindow extraction, SsoStatus fields WITH the three pinned test/interface edits in the same commit, .env.example; (3) `feat(web): email and password door and the password screen` — login form, /login/password screen with mode=create|reset|change, app-shell 'Change password' link, spec; (4) `infra: ses identity, dkim, bounce events and a scoped send grant` + docs. Conflicts between the three proposals and the judges are resolved inline below, each marked RESOLVED._

## Data model
ONE new table, no enums (none of the AGENTS.md enum gotchas apply), one model module, one migration. NOTHING on `users` changes: `password_hash` stays NOT NULL, the "google-only" sentinel keeps meaning "no usable local password", `google_sub` and `token_version` are reused as they are.

### apps/api-py/app/models/auth_otp.py (new, LF)
```python
"""One-time codes emailed for the password path (create / reset / change).

A row exists ONLY for an enrolled address on the college domain: the request
endpoint answers 202 for everyone and writes nothing for anyone else, so the
table cannot be grown by probing, and a row is itself proof that the address
passed the roster and domain fences at request time.

`code_hash`, never the code: HMAC-SHA256 keyed on a value derived from
AUTH_SECRET (local_auth.otp_hash), bound to user_id:purpose. A 6-digit code is
20 bits, so a plain hash is a lookup table; the keyed hash means a copy of this
table without the secret verifies nothing. Brute force is stopped by
`attempts` and `expires_at`, not by hash cost (RESOLVED against P2's scrypt:
a ~30 ms unauthenticated CPU lever per guess for no gain over a keyed MAC).
"""
class EmailOtp(Base):
    __tablename__ = "auth_email_otps"
    __table_args__ = (Index("ix_auth_email_otps_user_created", "user_id", "created_at"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)          # uuid4().hex
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # "password" today. "login" is RESERVED for the optional OTP-on-every-login flag and must not be reused.
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # created_at + OTP_TTL_SECONDS. A newer request sets this to now() on older live rows rather than
    # deleting them, so the per-hour count and the 60 s resend cooldown survive the request they should count.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```
"Live" = consumed_at IS NULL AND attempts < OTP_MAX_ATTEMPTS AND expires_at > now(). No status column to drift. ON DELETE CASCADE is deliberate: conftest.make_user, test_google_callback.roster_user and test_conversations tear users down with `delete(User)` after LoginDay/Student; a plain FK would make any fixture that issued a code fail at teardown. Register with `from . import auth_otp  # noqa: F401` in app/models/__init__.py (alphabetical, between `attendance` and `badge`).

### Migration apps/api-py/migrations/versions/<12hex>_auth_email_otps.py (new, LF)
`python -m alembic revision -m "auth email otps"` for the id, then hand-write in the d6a4e7f91b22 style (docstring Revision ID / Revises, double quotes, `revision: str`, `down_revision: Union[str, Sequence[str], None] = "d6a4e7f91b22"` — the CURRENT HEAD, confirmed with `alembic heads` in this sandbox; re-confirm at merge time, never `alembic merge`). upgrade(): create_table with the eight columns above (`sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE")`, `attempts` server_default "0", `created_at` server_default `sa.text("now()")`) then `op.create_index("ix_auth_email_otps_user_created", ...)`. downgrade(): drop index, drop table. RESOLVED against P3's functional index on `lower(users.email)`: `users.email` is unique and the table is ~5k rows; an un-indexed `func.lower()` scan is single-digit ms and the index is a schema change on `users` this feature does not need.

### Lifecycle constants — apps/api-py/app/local_auth.py (new, LF, FastAPI-free like google_auth.py)
```
OTP_DIGITS = 6                    # f"{secrets.randbelow(10**6):06d}"
OTP_TTL_SECONDS = 600             # 10 minutes
OTP_MAX_ATTEMPTS = 5              # wrong guesses per code; then dead even if the next guess is right
OTP_RESEND_SECONDS = 60           # DB-backed per-user cooldown (grafted from P3); silent 202 inside it
OTP_MAX_PER_HOUR = 3              # codes issued per user per rolling hour, DB-counted so N workers do not multiply it
OTP_ROW_RETENTION_SECONDS = 86_400
PASSWORD_MIN_CHARS = 10
PASSWORD_MAX_CHARS = 200          # bounds the scrypt input; no composition rules (NIST 800-63B)
PURPOSE_PASSWORD = "password"
_OTP_KEY_LABEL = b"reep.email-otp-v1\x00"   # domain separation, the google_auth._FLOW_KEY_LABEL shape
```
Functions (all take a Session, none import FastAPI):
- `address_allowed(email) -> bool`: `"@" in email and email.rsplit("@", 1)[1] == settings.roster_domain`. The brief's `settings.college_email_domain` does not exist; `roster_domain` (ROSTER_EMAIL_DOMAIN, alias COLLEGE_EMAIL_DOMAIN, else first GOOGLE_ALLOWED_DOMAIN entry, else "bgscet.ac.in" — never empty) is the real resolver. Do not add a second domain setting.
- `find_user(db, email) -> User | None`: `func.lower(User.email) == email` (the Google callback's and grant_access's rule; the current password door's exact match is fixed to this too).
- `otp_hash(user_id, purpose, code) -> str`: `hmac.new(hashlib.sha256(_OTP_KEY_LABEL + settings.auth_secret.encode()).digest(), f"{user_id}:{purpose}:{code}".encode(), hashlib.sha256).hexdigest()` — key read per call, message bound to the row's owner.
- `validate_new_password(email, new_password) -> str | None`: returns the 422 sentence or None: "Choose a password of at least 10 characters." / "...at most 200 characters." / "Your password cannot be your email address." (grafted from P3; compared case-insensitively after strip).
- `issue_code(db, user, purpose, *, now=None) -> tuple[EmailOtp, str] | None`: deletes this user's rows older than OTP_ROW_RETENTION_SECONDS; if a row for (user, purpose) was created within OTP_RESEND_SECONDS -> None (cooldown, DEBUG log only); if >= OTP_MAX_PER_HOUR rows created in the last 3600 s -> None and `log.warning("auth-otp: hourly cap reached for user %s", user.id)` (user id, never the address); else UPDATE live rows `expires_at = now`, INSERT the new row with `expires_at = now + 600 s`, commit, return (row, plaintext). The plaintext exists only in this return value and the outbound email.
- `verify_code(db, user, purpose, code, *, now=None) -> EmailOtp | None`: newest live row; None if none; `hmac.compare_digest(row.code_hash, otp_hash(...))`; miss -> `row.attempts += 1; db.commit()`; hit -> returns the row WITHOUT consuming (consumption is one transaction with the password write).
- `consume_and_set_password(db, user, otp, new_password) -> int`: `otp.consumed_at = now; user.password_hash = hash_password(new_password); user.token_version = (user.token_version or 0) + 1; db.commit()`; returns the new version. `google_sub` is never touched.
- `request_code(email: str) -> None` — THE BackgroundTasks target (RESOLVED per P2 and all three judges: the WHOLE distinguishing path runs after the 202 is written, not only the send). Opens its own `SessionLocal()` (never the request's get_db session — yield-dependency teardown order is not something to depend on): `address_allowed` -> `find_user` -> `issue_code` -> `deliver_code`. Every non-matching case returns silently.
- `deliver_code(db, otp, email, code)`: `mailer.deliver_once(db, kind="auth-otp", recipient=email, dedupe_key=f"auth-otp:{otp.id}", subject=SUBJECT, send=lambda to, subject: email_mod.send(message_for_code(to, code)))`. If the returned row is FAILED: `log.error("auth-otp send failed for otp %s: %s", otp.id, row.error)` — that literal is the CloudWatch tripwire (never the code, never the address). The mailer swallows driver exceptions by contract, so this ERROR line is the only log witness.
- `message_for_code(to, code) -> OutboundEmail`: subject "Your REEP sign-in code" (no digits — MailLog stores subjects); plain-text body: "Your REEP code is <code>. It expires in 10 minutes and works once. Enter it on the page where you asked for it. If you did not ask for a code, ignore this message — nothing changes without it. REEP staff will never ask you for this code." No link, no HTML, no name.
- `purge_stale(db, *, now=None) -> dict[str, int]`: deletes auth_email_otps rows older than 24 h AND `mail_logs` rows with `kind='auth-otp'` older than 180 days (grafted from P3's risk list: the recipient address must not outlive the code forever; 180 d matches the interview clock). Called from `retention.purge_expired`, reported as `otp_rows_deleted` and `otp_mail_logs_deleted` in its summary dict.

### apps/api-py/app/security.py (LF) — two additions, no behaviour change
```python
# The value seed_roster / grant_access write for an account with no local password yet.
# Structurally unverifiable (one part, not three). Defined HERE so the two seeds, the
# tests and the login door share one constant; seed_roster._rekey_candidate compares
# against it, so its VALUE must never change.
UNUSABLE_PASSWORD_HASH = "google-only"

def has_usable_password(stored: str | None) -> bool:
    if not stored:
        return False
    parts = stored.split(":")
    return len(parts) == 3 and parts[0] == "scrypt" and bool(parts[1]) and bool(parts[2])
```
seed_roster.py and grant_access.py keep their public name: `SSO_ONLY_PASSWORD_HASH = UNUSABLE_PASSWORD_HASH` imported from `.security` (importable without a database). tests/test_google_callback.py:103 keeps its literal.

### Settings (apps/api-py/app/config.py — CRLF FILE, every inserted line ends \r\n)
New `# --- Outbound email (app/email.py) ---` block after the Google block, then `# --- Email & password sign-in ---`:
```
email_transport: str = ""        # "ses" | "smtp" | "log" | "" (off). Unknown value kept (so the reason can name it), WARNING once.
email_from: str = ""             # 'REEP <no-reply@bgscet.ac.in>' or a bare address; parsed with email.utils.parseaddr. Required by ses and smtp.
email_reply_to: str = ""         # placement-office address (grafted from P3); optional
ses_region: str = ""             # blank -> AWS_REGION / AWS_DEFAULT_REGION (boto3's chain); Terraform sets it explicitly
ses_configuration_set: str = ""  # blank = none; Terraform passes the stack's set (grafted from P3)
smtp_host: str = ""
smtp_port: int = 587             # ON _blank_is_default
smtp_username: str = ""
smtp_password: str = ""          # credential: never logged
smtp_starttls: bool = True       # ON _blank_is_default
local_auth_enabled: bool = False # ON _blank_is_default. The explicit opt-in. Default off = today's behaviour.
```
Properties (the interview_ready + interview_unready_reason shape: `.strip()` on every credential, no I/O, one student-facing sentence naming the variable):
- `email_transport_effective`: explicit strip().lower() if set; else `"log" if _is_dev_env(self.env) else ""` (a fresh clone exercises the flow with no .env edit; anything else gets nothing).
- `ses_region_resolved`: SES_REGION -> AWS_REGION -> AWS_DEFAULT_REGION -> "" (the nova_region shape).
- `email_ready`: `log` -> `_is_dev_env(env)` (NEVER ready outside dev: codes would land in CloudWatch); `smtp` -> host and parseable from, AND refuses when smtp_username is set with smtp_starttls false and port != 465 (credentials would go in the clear — grafted from P3); `ses` -> parseable from and ses_region_resolved; else False.
- `email_unready_reason`: one sentence each — blank: "Email is not configured on this server (EMAIL_TRANSPORT is blank)."; log on non-dev: "EMAIL_TRANSPORT=log writes every message, sign-in codes included, into the server log, so it is only accepted on a development ENV."; smtp names SMTP_HOST / EMAIL_FROM / "SMTP_USERNAME is set but SMTP_STARTTLS=false and SMTP_PORT is not 465"; ses names EMAIL_FROM / SES_REGION; unknown: "EMAIL_TRANSPORT=<value> is not one of ses, smtp, log."
- `local_auth_ready = local_auth_enabled and email_ready`; `local_auth_unready_reason`: not enabled -> "Email & password sign-in is not switched on for this server (LOCAL_AUTH_ENABLED)."; else `email_unready_reason`.
`production_boot_failures()` is NOT touched. app/main.py's lifespan gains one INFO line after gate 2: `log.info("email transport: %s; email & password sign-in: %s", email.transport_name() or "(none)", "ready" if settings.local_auth_ready else settings.local_auth_unready_reason)` — a line, not a gate. RESOLVED against P3's boot-time GetEmailIdentity call: readiness is config-only and the IAM grant (ses:SendEmail only) would deny it anyway.

### The optional-session dependency — apps/api-py/app/identity.py (LF), one addition for decision (b)
```python
def get_optional_session(request: Request) -> dict | None:
    """The session if a valid reep_session cookie is present, else None. Never raises.
    For endpoints that serve both anonymous callers (create / forgot password) and
    signed-in ones (change password) — the password endpoints bind a present session
    to the submitted address and require nothing when there is none."""
    token = request.cookies.get(SESSION_COOKIE)
    return verify_session_token(token) if token else None
```

## Endpoints
### GET /api/auth/sso/status  (also /api/v1/auth/sso/status; hidden alias /google/status unchanged)
**request:** none, unauthenticated
**responses:** ALWAYS 200 SsoStatus. Fields (snake_case, the wire contract with login.component.ts): google_available: bool; password_login_available: bool = settings.password_login_allowed; password_setup_available: bool = settings.local_auth_ready (NEW); domain: str = settings.roster_domain; reason: str|None (Google's, unchanged); password_reason: str|None = settings.local_auth_unready_reason when password_setup_available is false, else null (NEW).
**notes:** Two new fields touch three pinned places in ONE commit: `SsoStatus` in app/routers/auth.py, the `interface SsoStatus {` block in login.component.ts (now `export interface`, same literal, no nested braces; the password screen imports it from there — RESOLVED against P3 moving it to a new file the contract test would have to chase), the exact-set assertion in tests/test_google_callback.py:290 and the parametrize list in tests/test_sso_contract.py:104. `password_login_available` finally gets a reader. Never a 4xx; the client fails OPEN on a broken probe. No log line when the password door is closed — a closed door is a normal state, not an outage.

### POST /api/auth/login  (existing, reworked in place in app/routers/auth.py)
**request:** JSON LoginRequest {email, password} (unchanged shape; AuthService.login stops sending the ignored `next` key)
**responses:** 403 {detail: 'Password sign-in is not available on this server. Use Continue with Google.'} when not settings.password_login_allowed — before any DB read, as today. 429 + Retry-After {detail: 'Too many failed sign-in attempts. Wait a few minutes, or reset your password with an emailed code.'} from EITHER window, both checked before the DB: per-IP 40 FAILURES / 10 min, and per-ADDRESS 10 FAILURES / 15 min keyed on the normalised submitted string (grafted from P3: closes distributed guessing against one account; keyed on the string so it says nothing about existence, and the emailed-code reset is the self-service escape). Successes never count and clear the per-address window. 401 {detail: 'Invalid email or password.'} for ALL of: no row (case-insensitive lookup), address not on settings.roster_domain, password_hash not usable (sentinel or malformed), wrong password — the first three burn verify_password(body.password, _TIMING_EQUALIZER_HASH) first, closing the sentinel timing gap the codebase map records. 200 SessionUser + Set-Cookie reep_session exactly as today (_record_login -> _payload_for -> _issue_session).
**notes:** Handler order: guard -> ip window -> address window -> lookup (func.lower) -> domain fence -> has_usable_password -> verify_password -> success. The domain fence is enforced in dev too (every fixture/seed address is @bgscet.ac.in). RESOLVED against P2's email-only 10/min limiter: a 60 s lockout lever on any address with no IP ceiling; the per-address window here counts FAILURES only and is 10/15 min, so a mistyping student is not locked out by successes and an attacker's lever is bounded by the reset path. Every 401 records one failure on both windows.

### POST /api/auth/password/otp  (new, app/routers/local_auth.py, prefix '/auth/password', mounted at /api and /api/v1 beside auth.router)
**request:** JSON {email: str (3..254)}. Optional reep_session cookie via get_optional_session — never required.
**responses:** 503 {detail: settings.local_auth_unready_reason} when not settings.local_auth_ready — before the limiter and before any DB read (the voice 503 shape; never a boot failure). 429 + Retry-After {detail: 'Too many code requests from this network. Try again in a few minutes.'} at 30 requests / 10 min per IP (RESOLVED: P1's 10/15 min would lock a lab behind one NAT on rollout day). 403 {detail: 'You are signed in as a different address. Sign out first, or use the address you signed in with.'} when a session IS present and its email != normalised body email — before the DB, an authenticated-only comparison that reveals nothing about the roster. 422 (pydantic) for a malformed body. 202 {ok: true, resend_after_seconds: 60} in EVERY other case — enrolled, unknown, off-domain, cooldown, hourly cap, send failure — the constant 60 always (a remaining-wait value would be an oracle).
**notes:** The handler does ONLY: gate -> ip window -> session/email bind -> normalise (strip, lower) -> `background.add_task(local_auth.request_code, email)` -> 202. Every distinguishing step (domain fence, lookup, cooldown, hourly cap, supersede, insert, deliver_once) runs in the BackgroundTasks callable with its own SessionLocal AFTER the response is written, so neither body nor clock distinguishes enrolled from unknown — P1's documented one-INSERT-vs-one-SELECT residual is removed structurally rather than accepted. A transport failure stays a 202 (decision 6; RESOLVED against P3's 503 — only enrolled addresses could receive it): the witnesses are the ERROR tripwire line, the FAILED mail_logs row and the CloudWatch alarm. Starlette's TestClient completes background tasks before `client.post` returns, so tests stay synchronous. Nothing about the email is logged at any level.

### POST /api/auth/password/set  (new, same router)
**request:** JSON {email: str, code: str (pydantic pattern ^[0-9]{6}$ after strip), new_password: str}. Optional reep_session cookie via get_optional_session (decision (b)).
**responses:** 503 not ready (before DB, same reason text). 429 + Retry-After at 20 requests / 15 min per IP (before DB). 403 (same sentence as /otp) when a session is present and its email != body email — before the DB. 422 {detail: <validate_new_password sentence>} — checked BEFORE the code so a weak password does not spend an OTP attempt. 400 {detail: 'That code is not valid or has expired. Only the newest code works — check the latest email, or request a new one.'} for ALL of: unknown address, off-domain, no live row, wrong code (attempts += 1, committed), attempts exhausted, expired, already consumed; a dummy hmac.compare_digest on the no-user branch. 200 SessionUser + Set-Cookie reep_session: the caller is signed in (create/forgot) or stays signed in on a fresh cookie (change).
**notes:** Success is ONE transaction then the three session lines: consume_and_set_password() stamps consumed_at, writes hash_password(new_password) over the sentinel or the old hash, bumps users.token_version and commits; then security.note_revocation(user.id, new_version) so this worker refuses the user's other cookies immediately (other workers within auth_revocation_cache_seconds, the limit app/security.py already states); then _record_login -> _payload_for -> _issue_session, so the NEW cookie carries the bumped tokenVersion claim and is the only survivor (decision 7). This is what makes decision (b) free: a signed-in change replaces the caller's own cookie in the same response and kills every other session. google_sub is untouched. No intermediate 'code verified' bearer between code and password — they travel in one request. INFO log 'auth-otp: password set for user %s' with the id only.

### POST /api/auth/login/otp  (OPTIONAL, decision 4 — designed here, NOT built; add it and the setting together or not at all)
**request:** JSON {email, code}
**responses:** If built: with LOCAL_AUTH_OTP_ON_LOGIN=true, POST /login with a correct password issues a purpose='login' code (same issue_code, caps and cooldown) and answers 202 {otp_required: true, resend_after_seconds: 60} instead of a session; this endpoint verifies and consumes it (verify_code + consumed_at, no password write) and issues the session. A live purpose='login' row IS the proof the password step passed; no pending-login cookie is needed.
**notes:** Default off. Do not ship until the password path has held up in front of students: it doubles SES volume and puts the transport on the login critical path. If shipped, `local_auth_otp_on_login: bool = False` goes on _blank_is_default, the status endpoint gains `otp_on_login: bool`, and conftest's login fixture keeps working because the flag is off under ENV=dev. The purpose column's 'login' reservation exists so a password-purpose code can never be spent to log in.

### GET /ready  (existing, app/routers/health.py — NOT /health, which is the dependency-free liveness probe)
**request:** none
**responses:** checks gains a soft entry beside voice: `"email": {"transport": email.transport_name() or None, "configured": settings.email_ready, "local_auth": settings.local_auth_ready}`. Never fails the probe.
**notes:** Config-only, no I/O (the livekit_configured pattern). RESOLVED: P3 put this under /health; the checks dict lives on /ready.

## Email adapter
### apps/api-py/app/email.py (new, LF) — the ONLY module that knows how a message leaves the process
Docstring note at the top: this module is `app.email`; `from email.message import EmailMessage as _MimeMessage` is an absolute import and resolves to the stdlib (relative imports need a leading dot), so the clash is cosmetic — our own type is `OutboundEmail`. Nothing in the repo puts apps/api-py/app itself on sys.path; tools/ci/check_api_imports.py imports it as `app.email` and would catch a regression.
```python
@dataclass(frozen=True)
class OutboundEmail:
    to: str
    subject: str
    text: str                    # plain text only; no HTML, no links — a code email with markup is what phishing looks like
    reply_to: str | None = None  # settings.email_reply_to when set
class EmailError(RuntimeError): """A transport could not deliver. str(exc) is safe for MailLog.error and the log: provider code + message, never the body, never a credential."""
def transport_name() -> str: return settings.email_transport_effective
def send(message: OutboundEmail) -> None:
    name = settings.email_transport_effective
    if name == "log": _send_log(message)
    elif name == "smtp": _send_smtp(message)
    elif name == "ses": _send_ses(message)
    else: raise EmailError(f"no email transport is configured (EMAIL_TRANSPORT={name!r})")
```
Transports:
- `log` (dev/CI): `logging.getLogger("reep.email").info("EMAIL (log transport, NOT sent) to=%s subject=%r\n%s", to, subject, text)` — prints the code into the process log by design, which is exactly why `email_ready` refuses it on every non-dev ENV. Tests capture with caplog or monkeypatch `app.email.send` with a recorder.
- `smtp` (generic hosts, docker-compose.prod.yml, Google Workspace relay): port 465 -> `smtplib.SMTP_SSL(host, port, timeout=10, context=ssl.create_default_context())` (grafted from P3); otherwise `smtplib.SMTP(host, port, timeout=10)`, `ehlo()`, `starttls(context=...)` + `ehlo()` when `smtp_starttls`; `login(username, password)` only when a username is set; stdlib `_MimeMessage` with From=email_from, To, Subject, Reply-To when set, `set_content(text)`; `send_message`; `quit()` in finally. `(smtplib.SMTPException, OSError, ssl.SSLError)` -> `EmailError(f"smtp: {type(exc).__name__}: {exc}")`.
- `ses` (AWS): `import boto3` LAZILY inside `_ses_client()` (the app/ai/llm.py:127 pattern), `boto3.client("sesv2", region_name=settings.ses_region_resolved)` cached with `functools.lru_cache(maxsize=1)` (cleared in tests). `send_email(FromEmailAddress=email_from, Destination={"ToAddresses": [to]}, ReplyToAddresses=[reply_to] if set, ConfigurationSetName=settings.ses_configuration_set if set, Content={"Simple": {"Subject": {"Data": subject, "Charset": "UTF-8"}, "Body": {"Text": {"Data": text, "Charset": "UTF-8"}}}})`. `botocore.exceptions.ClientError` -> `EmailError(f"ses: {Error.Code}: {Error.Message}")` (MessageRejected = sandbox/unverified, AccessDeniedException = IAM, Throttling / daily quota = sandbox limits, AccountSendingPausedException = reputation pause — the runbook maps each); `BotoCoreError` -> EmailError too. Credentials come from the task role via SigV4 — no key, no new secret, exactly like Nova. boto3==1.43.80 is already pinned, so check_api_imports.py stays green with no manifest change.

### Delivery contract with the existing mailer
The OTP send goes through `app/mailer.py:deliver_once` with `kind="auth-otp"` and `dedupe_key=f"auth-otp:{otp.id}"`, closure-capturing the body (Driver `(recipient, subject) -> None` unchanged, tests/test_mailer.py untouched). The director's `GET /api/director/mail?kind=auth-otp` audit view gets a SENT/FAILED row per code with the transport's error text (never the code); dedupe by row id means a retried task cannot send the same code twice and a legitimate second request is never deduped. mailer.py swallows driver exceptions, so local_auth.deliver_code logs the ERROR tripwire itself.

### .env.example (CRLF) additions, house style (a # paragraph, then commented defaults), appended after ROSTER_EMAIL_DOMAIN
```
# --- Outbound email (app/email.py) --------------------------------------------
# Which transport sends mail. "ses" (AWS SESv2, signed by the task role - no key),
# "smtp" (any relay, stdlib smtplib; port 465 = implicit TLS, otherwise STARTTLS),
# "log" (dev/CI: the message is written to the API log and NEVER sent - and
# because a sign-in code in a log is a sign-in code, "log" is refused as a
# transport on every non-dev ENV). Blank is off - except on a dev ENV, where
# blank means "log" so the password flow works on a fresh clone.
#EMAIL_TRANSPORT=""
#EMAIL_FROM="REEP <no-reply@bgscet.ac.in>"
#EMAIL_REPLY_TO=""
#SES_REGION=""
#SES_CONFIGURATION_SET=""
#SMTP_HOST=""
#SMTP_PORT="587"
#SMTP_USERNAME=""
#SMTP_PASSWORD=""
#SMTP_STARTTLS="true"

# --- Email & password sign-in ------------------------------------------------
# The second door beside Google, for addresses ALREADY on the roster and on
# ROSTER_EMAIL_DOMAIN. Setting, resetting or changing a password needs a code
# emailed to that address, so this needs a working transport above;
# GET /api/auth/sso/status says whether it is ready and why not. Off by
# default; when off, nothing here changes and production keeps refusing
# POST /api/auth/login.
#LOCAL_AUTH_ENABLED="false"
```
Google Workspace relay example for SMTP in the same block: `EMAIL_TRANSPORT=smtp SMTP_HOST=smtp-relay.gmail.com SMTP_PORT=587 SMTP_STARTTLS=true`. Local Mailpit/MailHog tip (grafted from P2): `EMAIL_TRANSPORT=smtp SMTP_HOST=localhost SMTP_PORT=1025 SMTP_STARTTLS=false` (no username, so the TLS refusal does not fire).
docker-compose.prod.yml api service: pass through `LOCAL_AUTH_ENABLED: ${LOCAL_AUTH_ENABLED:-false}`, `EMAIL_TRANSPORT: ${EMAIL_TRANSPORT:-}`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SMTP_HOST/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD/SMTP_STARTTLS: ${...:-}` with a two-line comment ("blank = the password door stays shut; see docs/email-password-sign-in.md"). The migrate/retention services need none of them.

## Guard rework
### The exact change to Settings.password_login_allowed (apps/api-py/app/config.py, CRLF)
Today: `return _is_dev_env(self.env)`. After:
```python
@property
def password_login_allowed(self) -> bool:
    """Whether POST /api/auth/login may answer at all.

    TWO ways to be open, and NOTHING ELSE opens it:
      1. `_is_dev_env(self.env)` - the dev/CI allowlist, kept verbatim so
         tests/conftest.py's `login`/`make_user` fixtures and the seeded
         student@/mentor@/director@ logins keep working on a laptop and in CI
         with no configuration at all.
      2. `self.local_auth_ready` - the operator has set LOCAL_AUTH_ENABLED=true
         AND a real email transport is configured, i.e. the email & password
         door is deliberately on and a student can actually obtain a password
         through it. A configured transport ALONE does not open this door, and
         the flag ALONE does not either.

    Still an allowlist, still never `not is_prod`: an unrecognised, blank or
    typo'd ENV with nothing configured refuses exactly as before, and the only
    way an unrecognised ENV opens the door is the same explicit opt-in that
    opens it in production. The failure mode of a misconfiguration remains
    "nobody can use a password", never "anyone can".
    """
    return _is_dev_env(self.env) or self.local_auth_ready
```
Truth table the tests pin (ENV x LOCAL_AUTH_ENABLED x email_ready -> /login, /password/*):
- dev/test/ci/local/development/testing, anything, anything -> /login OPEN (fixtures unchanged); /password/* open iff LOCAL_AUTH_ENABLED (transport defaults to log on dev; 503 with the reason otherwise).
- prod/production/prd/live, false, anything -> 403 / 503 — today's behaviour byte for byte except the 403 detail text (decision 10).
- prod, true, ses|smtp ready -> OPEN / OPEN.
- prod, true, log or blank or misconfigured -> 403 / 503 (log is never ready outside dev; the reason names the variable).
- staging/uat/""/typo, false -> 403 / 503 (fail closed, as today).
- staging, true, ready -> OPEN / OPEN (explicit opt-in; same rule as prod).

Consumers updated in the same commit:
- app/routers/auth.py `login()`: guard text and docstring rewritten (no longer "a dev/CI affordance"; it is the password door, open in dev for the fixtures and in any environment that opts in). 403 detail: "Password sign-in is not available on this server. Use Continue with Google." WARNING log names `settings.env` and `settings.local_auth_unready_reason`, no credential, still before the DB.
- app/routers/auth.py `sso_status()`: both branches pass `password_setup_available=settings.local_auth_ready` and `password_reason=None if settings.local_auth_ready else settings.local_auth_unready_reason`.
- The two password endpoints gate on `settings.local_auth_ready` (503, reason) — stricter than /login's property on purpose: on a dev box with a broken EMAIL_TRANSPORT the fixture door stays open and the code flow says why it cannot.
- config.py's `_DEV_ENV_NAMES` comment ("Three guards read it") -> four, naming `email_transport_effective`/`email_ready`'s log arm, and noting that `password_login_allowed` now reads it OR the opt-in.
- Prose pins reworded to: "an allowlist of dev/CI environment names OR the explicit LOCAL_AUTH_ENABLED opt-in with a ready email transport — never `not is_prod`": .github/pull_request_template.md:117, CONTRIBUTING.md:588-590, AGENTS.md auth paragraph, docs/architecture.md:378, docs/deployment-process.md:418-421, tests/test_boot_guard.py:349-364 docstring.
- `insecure_cookies_allowed`, `worker_auth_optional`, `is_prod`-keyed guards (`production_boot_failures`, app/seed.py's refusal, the log.error in sso_status) are untouched.

RESOLVED naming: the flag is `LOCAL_AUTH_ENABLED` (P1), not P2/P3's `PASSWORD_LOGIN_ENABLED` — one name across config, Terraform, compose, docs and tests; the sentence in `local_auth_unready_reason` names it.

### Rate limiting — app/ratelimit.py (LF) gains a reusable `FixedWindow`
`class FixedWindow(window_seconds, limit, *, count_on_check=True, max_keys=4096)` extracted from routers/registration.py's `_rate_limit_retry_after` (behaviour-preserving: same eviction, same Retry-After arithmetic); methods `retry_after(key) -> int | None` (counts), `blocked(key) -> int | None` (does not count), `hit(key)` (count without checking — for /login failures), `reset()`. A module-level registry so `ratelimit.reset()` clears every window; conftest's autouse `_fresh_per_process_state` already calls it, so no conftest change. registration.py switches to it with its constants (20 per 600 s) unchanged. `llm_rate_limited` untouched. Windows: `LOGIN_IP_FAILURES = FixedWindow(600, 40)`, `LOGIN_ADDRESS_FAILURES = FixedWindow(900, 10)`, `OTP_REQUESTS_PER_IP = FixedWindow(600, 30)`, `OTP_SET_PER_IP = FixedWindow(900, 20)`, all defined in app/local_auth.py. Per process (N workers = N x the limit, still a ceiling — ratelimit.py's own argument); the IP key is trustworthy on AWS because the Dockerfile already sets FORWARDED_ALLOW_IPS to the VPC.

## Security
- ENUMERATION — request side: 202 with one constant body for enrolled, unknown, off-domain, google-only, cooldown, capped and send-failed addresses; the handler performs zero DB reads/writes — domain fence, lookup, caps, insert and send all run in the BackgroundTasks callable after the response is written (grafted from P2), so neither body nor clock differs. No 503 on transport failure (decision 6; P3's leak rejected), no time.sleep floor (a floor is not an equaliser and pins a threadpool thread). Residual: the 403 for a session/email mismatch fires only for authenticated callers and compares two strings the caller already knows; it reveals nothing about the roster.
- ENUMERATION — redeem and login side: /password/set answers ONE 400 sentence for unknown, off-domain, no live row, expired, wrong and exhausted, with no attempts-left counter and a dummy hmac.compare_digest on the no-user branch; /login answers one 401 and burns the scrypt equaliser for no-row, off-domain AND sentinel rows, closing the tens-of-milliseconds sentinel gap the codebase map records.
- OTP STRENGTH AND STORAGE: 6 digits from secrets.randbelow; stored only as HMAC-SHA256 under a key derived from AUTH_SECRET with a domain-separation label over user_id:purpose:code; compared with hmac.compare_digest; a table copy without the secret verifies nothing and a code can never verify against another row. Guess budget per account: 5 attempts x 3 codes per hour = 15 per hour against 1e6, plus the per-IP windows.
- REPLAY / SINGLE USE: consumed_at is stamped in the same transaction as the password write; a newer request supersedes older live rows by expiring them (not deleting, so the hourly count and the 60 s cooldown survive); code and password travel in one request so there is no intermediate bearer to steal or fix; the session cookie is the existing httpOnly / SameSite=Lax / Secure-by-_cookie_secure() reep_session and nothing here reads a session identifier from the client.
- WHAT REVOKES WHAT: setting a password (create, forgot OR change) bumps users.token_version and calls note_revocation, so every other session dies (immediately on the serving worker, within AUTH_REVOCATION_CACHE_SECONDS elsewhere — the limit app/security.py already states) and the response cookie carries the new version and is the one survivor (decision 7); a new code request revokes the previous code; a successful set revokes the code; rotating AUTH_SECRET revokes every session AND every outstanding code (the HMAC key derives from it) — documented.
- DECISION (b) BINDING: when a reep_session cookie is present on /password/otp or /password/set, the normalised body email MUST equal the session's email or the request is refused 403 before any DB read; no session means the anonymous create/forgot behaviour. A signed-in user therefore cannot use their own session to mint a code for another address, and the change flow reuses exactly the same two endpoints, table, caps and revocation as the anonymous flow — one screen, one endpoint set, one code path.
- BRUTE FORCE AT THE EDGE: four fixed windows in one shared FixedWindow class (registration switched to it, so there are not three copies): /login 40 FAILURES / 10 min per IP AND 10 FAILURES / 15 min per address (successes never count; the 429 names the emailed-code reset as the escape); /password/otp 30 / 10 min per IP; /password/set 20 / 15 min per IP. 429 + Retry-After, checked before the DB. The per-address window is the one deliberate lockout lever and it is bounded (15 minutes, failures only, self-serviceable via reset) — RESOLVED between P1's 'no per-account lockout' and P2's 60 s per-email lever.
- SECRET HANDLING: the plaintext code exists only in issue_code's return value and the outbound email; no log line at any level carries a code or an address (WARNING/ERROR lines carry user ids and otp ids — RESOLVED against P2/P3 logging the address); EmailError text never includes the body; MailLog stores subject (no digits) and the transport's error only; the `log` transport is refused by email_ready on every non-dev ENV; SES needs NO secret (SigV4 from the task role), so the operator-owned secret, secrets.tf and outputs.tf's external_secret_arn are UNTOUCHED — the PR body must say so explicitly so reviewers of secrets.tf do not go looking for a key and nobody re-puts the whole JSON; SMTP_PASSWORD is a plain str setting for non-AWS hosts, never logged, and email_ready refuses credentials without TLS.
- PASSWORDS: 10..200 chars, not equal to the email address (422, checked before the code so no attempt is spent), hashed only by the existing scrypt hash_password, never logged, never echoed. No breach-list check and no MFA on the password door (the OTP-on-login flag is designed, not built) — stated.
- THE DOMAIN FENCE (decision 2) applies to all three password endpoints via one helper, local_auth.address_allowed, keyed on settings.roster_domain; the Google path keeps its roster-only rule and GOOGLE_ALLOWED_DOMAIN stays a label, byte-for-byte (decision 8). A staff member granted at an off-domain address can only sign in with Google and gets the same 401/202/400 as an unknown address.
- NO SELF-PROVISIONING (decision 2, AGENTS.md rule 2): /password/set writes password_hash on an EXISTING row found by case-insensitive email; it never creates a User, never sets or changes role, never touches google_sub, Student or Mentor. Rule 1 is untouched (nothing here calls a model; the only egress is the code to the student's own address).
- FAIL DIRECTIONS: readiness is config-only (no I/O on the request path, no boot-time SES call); a transport that is configured but failing at runtime (SES sandbox refusal, throttling, DKIM not yet verified) keeps POST /login up (it needs no email) and makes /otp answer 202 while the ERROR line 'auth-otp send failed', the FAILED mail_logs row, the CloudWatch alarm and the SES bounce/complaint SNS destination say what happened. Nothing here is ever a boot failure; the alembic/seed one-offs and the retention job (same task definition) are unaffected.
- IAM: `ses:SendEmail` only, on THIS identity ARN and THIS configuration set ARN, with a `ses:FromAddress` StringLike condition on the sending domain — never `*`; conditional on the identity existing because the resource IS the identity. No SendRawEmail (Simple content).
- FRONTEND HYGIENE: code field autocomplete=one-time-code inputmode=numeric; password fields autocomplete=new-password / current-password; no code, email or password ever in a URL except the prefilled `email` query param on the setup screen (an address, not a secret); `?next` re-validated client-side with the existing rule and never followed by the server (the endpoints return JSON, no new redirect surface). The login form and the set-password screen post through AuthService (HttpClient, withCredentials) so the guard's session signal is the single source of truth.
- OUT OF SCOPE AND SAID SO: magic links; HTML mail; SMS or alternate-address recovery (would widen the trust root beyond the college mailbox, which is the same root Google already relies on); custom MAIL FROM; the OTP-on-every-login flag (designed, not built).

## Frontend
All under apps/web (LF, Prettier printWidth 100, singleQuote). Two screens, both lazy, both outside the shell, both styled on `--reep-*` tokens like login/register today. Forms use FormsModule + [(ngModel)] to plain class fields with `pending/error` signals — the pattern the codebase practises (zero ReactiveForms usages despite AGENTS.md's wording); do not introduce ReactiveForms.

### 0. Shared pieces — apps/web/src/app/features/login/
- `_auth-surface.scss` (new partial, grafted from P3): `.alert/.alert--error/.alert--warn/.alert__icon/.alert__text/.alert__meta`, `.spinner` + `@keyframes reep-spin` (reduced-motion guarded), the local `.btn` overrides, and the new `.divider`, `.door`, `.form-field` (label/input on `--reep-divider`, `--reep-text-*`, focus ring `--reep-secondary-main`, 44px min-height), `.form-actions`, `.setup-link`, `.linklike`. `@use`d by both component stylesheets; nothing is added to reep-v2.scss (owned by the shell; reep-v2-resume.scss loads after it). Each component stays well under the 16 kB anyComponentStyle warning (login.component.scss is 7 kB today).
- `auth-errors.ts` (new, ~15 lines): `detailOf(res)` copied from registration.component.ts with per-status fallbacks for 400/401/403/422/429/503 and Retry-After rendering; the API `detail` sentence always wins.
- `export interface SsoStatus {` STAYS in login.component.ts (the contract test greps that file); it gains `password_setup_available?: boolean;` and `password_reason?: string | null;` (flat, no nested braces). password-setup.component.ts imports it from './login.component'.

### 1. `/login` — login.component.{ts,html,scss} (extended; `imports: [FormsModule, RouterLink]` — today `imports: []`, so both are required or ngModel/routerLink silently do nothing)
- New signals: `passwordAvailable = signal(true)` (fail-open like `available`), `setupAvailable = signal(true)`, `passwordReason = signal<string|null>(null)`, `formPending`, `formError`; plain fields `email = ''`, `password = ''`.
- `probe()` additionally: `password_login_available === false` -> `passwordAvailable.set(false)`; `password_setup_available === false` -> `setupAvailable.set(false)` + `passwordReason.set(status.password_reason || 'Email & password sign-in is not configured on this server.')`. `undefined` keeps things live, as `google_available` is handled today.
- `submitPassword(event)`: preventDefault; trim; `auth.login(email, password)` (AuthService.login gets its first caller; it stops sending `next`); success -> `router.navigateByUrl(this.safeNext ?? HOME_FOR_ROLE[session.role])`; HttpErrorResponse map: 401 -> 'Invalid email or password.' plus a second line 'Not created a password yet, or forgotten it? Use the links below — a code will be emailed to your college address.'; 403/429 -> server detail (429 with Retry-After seconds); else 'Could not reach the sign-in service.' Sets `formError` only — `error`/`errorCode` stay reserved for the `?error=` Google contract so the probe callback cannot overwrite a form error. `messageFor` is NOT touched (the password path returns JSON, never a `?error=` redirect).
- Template: the Google block stays byte-for-byte; below it `<div class="divider" aria-hidden="true">or</div>` and `<section class="door door--password" aria-label="Email and password">` with `<h2 class="reep-h4">Email & password</h2>`, a `<form (submit)="submitPassword($event)" novalidate>` with two `.form-field` inputs (email: type=email autocomplete=username; password: type=password autocomplete=current-password with a show/hide toggle, aria-pressed), a submit `.btn` `[disabled]="!passwordAvailable() || formPending()"`, an `.alert.alert--error role="alert"` for `formError()`, and the links line: `First time here? <a routerLink="/login/password" [queryParams]="{mode: 'create', email, next: safeNext}">Create your password</a> · <a ... mode: 'reset'>Forgot your password?</a>`. When `!passwordAvailable()` the whole form renders with inputs disabled, links hidden, and an `.alert.alert--warn role="status"` carrying `passwordReason()` (decision 5: disabled WITH the reason, icon + text, never colour alone). When only `!setupAvailable()` the links are replaced by muted text with the reason. 'Who can sign in' and the technote rewritten: 'Two ways in, one roster: your college Google account, or an email & password you set yourself — only for addresses already on the roster and ending &#64;{{ domain() }}. We email a 6-digit code to that address; you enter it and choose a password. Staff whose roster address is not &#64;{{ domain() }} sign in with Google. There is no sign-up.' Remove 'Sign-in is Google only.' Header comment rewritten.

### 2. `/login/password` — password-setup.component.{ts,html,scss,spec.ts} (new) — THE one screen for create, reset AND change (decision (b))
- `PasswordSetupComponent`, standalone, `imports: [FormsModule, RouterLink]`. Injects ActivatedRoute, Router, AuthService.
- Query params: `mode` = `create` | `reset` | `change` (copy only; the endpoints are identical), `email` (prefill), `next` (validated with the login rule: startsWith('/') && !startsWith('//')).
- State: `step = signal<'email' | 'code'>('email')`; fields `email`, `code`, `newPassword`, `confirm`; signals `pending`, `error`, `info`, `resendIn` (countdown), `available` (fail-open), `unavailableReason`, `domain`. `mode === 'change'` additionally reads `auth.session()` (or `await auth.refresh()`), locks the email field to the session's email (read-only, no 'Change' link) and shows 'You will stay signed in here; every other device is signed out.'
- On construct: probe `GET ${environment.apiBase}/auth/sso/status` (same fail-open fetch as login); `password_setup_available === false` -> disabled form + `password_reason` in `.alert--warn role=status` + a 'Back to sign in' link and nothing else.
- Headings by mode: 'Create your password' / 'Reset your password' / 'Change your password'.
- Step 'email': copy 'Enter the college address on the programme roster — the one ending &#64;{{domain}}. We will email a 6-digit code to it. Personal addresses cannot set a password here.'; submit -> `fetch(POST ${environment.apiBase}/auth/password/otp, {credentials:'include', headers JSON, body {email}})`; 202 -> `step.set('code')`, `resendIn = body.resend_after_seconds`, and the ONLY copy shown is 'If that address is on the roster, a code is on its way. It works for 10 minutes and only the newest one counts. Give it a minute, and check spam before asking for another.' — never 'sent' versus 'not found'; 403/429/503 -> `detailOf(res)`; network -> 'Could not reach the sign-in service.'
- Step 'code': the address shown (with a 'Change' link back to step 'email' unless mode is change); inputs: code (`inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"`, non-digits stripped on input), new password (`autocomplete="new-password" minlength="10"`, show/hide, helper 'At least 10 characters. Not your email address.'), confirm (client match only); client check: 6 digits, >= 10 chars, match; submit -> `auth.setPassword(email, code, newPassword)`; 200 -> `router.navigateByUrl(safeNext ?? HOME_FOR_ROLE[session.role])` (no extra /auth/me round trip — setPassword sets the signal); 400 -> detail, password fields kept, code cleared and focused, plus a 'Send a new code' button disabled while `resendIn > 0` rendering 'Send a new code (42 s)'; 403 -> detail with a 'Sign out' hint; 422/429/503 -> detail.
- Every alert is icon + text with `role="alert"` (errors) or `role="status"` (info/unavailable). Inline SVG only — no Material Symbols ligatures, so no font-subset regeneration.
- URLs in this file use only `[a-z/]` characters after `environment.apiBase}` (`/auth/sso/status`, `/auth/password/otp`) so the route-table contract test can scan it with the same regex; `/auth/password/set` is called from AuthService and is asserted served by the same test extended to auth.service.ts.
- `password-setup.component.spec.ts` (vitest + TestBed, the app.spec.ts idiom, fetch and AuthService stubbed; grafted from P3): 202 moves to step 'code' and starts the countdown; 403 (probe says unavailable) renders the alert and no form; a wrong code (400) keeps the typed password and clears the code.

### 3. The 'Change password' link — apps/web/src/app/layout/app-shell.component.html (decision (b))
In `.desktop-titlebar`, before the existing Sign out button: `<a class="titlebar-link" routerLink="/login/password" [queryParams]="{mode: 'change', email: session()?.email}"><span class="icon" style="font-size:14px" aria-hidden="true">key</span> Change password</a>`. Add `RouterLink` to the shell's imports if not present; `key` is added to tools/fonts/icon-names.txt and the subset regenerated (`collect-icon-names.py` + `fetch-fonts.sh`) — a glyph missing from the subset renders as nothing. Hidden when the probe... no: the shell does not probe; the destination screen renders the disabled state with the reason if the door is off, which is the honest behaviour for a link that is on every screen. `.titlebar-link` styled beside `.titlebar-logout` in the shell's scss.

### 4. apps/web/src/app/app.routes.ts
Add, directly BEFORE the `login` route (longer path first): `{ path: 'login/password', loadComponent: () => import('./features/login/password-setup.component').then((m) => m.PasswordSetupComponent) }`. `loadComponent`, never `component:` — a static import re-eagers the bundle and fails the 250/400 kB initial budget.

### 5. apps/web/src/app/core/auth.service.ts
`login()` stops sending `next`; header comment rewritten ('Two doors, one session: the Google callback sets the cookie server-side; the email & password form and the set-password screen POST here.'). New `setPassword(email, code, newPassword): Promise<SessionPayload>` — an 8-line mirror of `login()` posting `${environment.apiBase}/auth/password/set` with `{email, code, new_password}`, withCredentials, setting `_session` (grafted from P2: the guard chain keeps one source of truth). `refresh()`/`logout()` unchanged; session.ts and the guards are unchanged.

### 6. Optional `login.component.spec.ts`
Two cases: a probe answering `password_login_available:false` renders the form disabled with the reason; `password_setup_available:false` hides the setup links. Cheap insurance; the pytest contract tests remain the load-bearing pin.

## Infra
All in infra/aws (LF). Validate with `terraform init -backend=false && terraform validate` (the partial s3 backend means plain validate fails until init; aws 5.100.0 / random 3.9.0 were fetched through the proxy in this sandbox and the `aws_sesv2_*` resources below are present in the provider schema). DNS is not managed by this stack, so records are surfaced through the existing `dns_records_to_create` output, never created. Every SES resource is conditional on an INFRASTRUCTURE fact (an identity exists), never on an application setting: the grant is scoped to a resource that only exists when the identity does, which is the one honest reason ecs.tf's "granted unconditionally" rule does not apply.

### variables.tf — new `# --- email & password sign-in ---` section after `# --- application behaviour ---`
```hcl
# The SES identity the API sends sign-in codes from. Blank = no identity, no grant,
# no transport - the email & password door stays shut and nothing in this stack
# changes. TWO honest choices, with different consequences (docs/aws-deployment.md §8):
#   - the ROSTER domain (bgscet.ac.in): inside the SES sandbox a verified DOMAIN
#     identity makes every recipient on it deliverable, so a pilot can run before
#     production access is granted (only the 200/day and 1/s caps bite) - at the
#     cost of three DKIM CNAMEs in the college's zone;
#   - the app's own subdomain (var.domain_name): DNS stays in the operator's hands,
#     but every student is undeliverable until SES production access is granted.
# Either way the college's root-domain SPF and DMARC are never edited (Easy DKIM
# aligns on the From domain under relaxed alignment, the default).
variable "mail_from_domain" { description = "Domain to verify as an SES sending identity (Easy DKIM). Blank disables outbound email and the password door."; type = string; default = "" }
variable "mail_from_address" { description = "EMAIL_FROM for the API, e.g. 'REEP <no-reply@bgscet.ac.in>'. The address part MUST be under mail_from_domain; the IAM grant is conditioned on it."; type = string; default = "" }
variable "mail_reply_to" { description = "EMAIL_REPLY_TO, e.g. the placement office. Blank = none."; type = string; default = "" }
# The application opt-in, separate from the transport on purpose: an identity can be
# verified and tested before a single student sees the form. Flip to "true" only after
# step 6 of docs/aws-deployment.md §8.
variable "local_auth_enabled" { description = "LOCAL_AUTH_ENABLED for the API: 'true' opens email & password sign-in. Requires mail_from_domain."; type = string; default = "false" }
```

### email.tf (new)
```hcl
locals {
  mail_on      = var.mail_from_domain != ""
  mail_address = local.mail_on ? regex("<?([^<>\\s]+@[^<>\\s]+)>?$", var.mail_from_address)[0] : ""
}
resource "aws_sesv2_configuration_set" "mail" {          # grafted from P3: a bounce is the one delivery failure neither mail_logs nor the tripwire can see
  count                  = local.mail_on ? 1 : 0
  configuration_set_name = "${var.project}-mail"
  reputation_options { reputation_metrics_enabled = true }
  sending_options    { sending_enabled = true }
}
resource "aws_sesv2_configuration_set_event_destination" "alerts" {
  count                  = local.mail_on ? 1 : 0
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name
  event_destination_name = "alerts"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT"]
    sns_destination { topic_arn = aws_sns_topic.alerts.arn }
  }
}
resource "aws_sesv2_email_identity" "mail" {
  count                  = local.mail_on ? 1 : 0
  email_identity         = var.mail_from_domain
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name
  dkim_signing_attributes { next_signing_key_length = "RSA_2048_BIT" }   # Easy DKIM; SES holds the key
}
# ses:SendEmail only, on THIS identity and THIS configuration set, from THIS address.
# No SendRawEmail (the client sends Simple content), no identity management, no
# account-level calls. A compromised task can send a plain-text message from no-reply@
# and nothing else.
resource "aws_iam_role_policy" "api_ses" {
  count  = local.mail_on ? 1 : 0
  name   = "send-sign-in-codes"
  role   = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["ses:SendEmail"]
      Resource  = [aws_sesv2_email_identity.mail[0].arn, aws_sesv2_configuration_set.mail[0].arn]
      Condition = { StringEquals = { "ses:FromAddress" = local.mail_address } }
    }]
  })
}
```
Custom MAIL FROM (`aws_sesv2_email_identity_mail_from_attributes`, MX+TXT on the college zone) is deliberately NOT added (RESOLVED against P3): DKIM alignment alone satisfies DMARC, and it is the first follow-up if Workspace quarantines the mail.

### ecs.tf
`local.api_environment` gains, with the house one-comment-per-entry:
```hcl
    # Email & password sign-in. The transport is decided by whether an SES identity
    # exists (email.tf), the opt-in is a separate variable, and the region is named
    # explicitly rather than inherited (this file's rule for NOVA_SONIC_REGION): SES
    # is served in ap-south-1, so this is var.region.
    { name = "LOCAL_AUTH_ENABLED", value = var.local_auth_enabled },
    { name = "EMAIL_TRANSPORT", value = local.mail_on ? "ses" : "" },
    { name = "EMAIL_FROM", value = var.mail_from_address },
    { name = "EMAIL_REPLY_TO", value = var.mail_reply_to },
    { name = "SES_REGION", value = var.region },
    { name = "SES_CONFIGURATION_SET", value = local.mail_on ? aws_sesv2_configuration_set.mail[0].configuration_set_name : "" },
```
`local.api_secrets`: UNCHANGED — SES needs no secret, so the operator-owned secret's JSON, outputs.tf:29 and the runbook's put-secret-value line are untouched. The comment at ecs.tf:49-51 becomes: "TWO AWS APIs: invoking Nova on Bedrock (here) and, when an SES identity exists, sending from it (email.tf). Nothing else."

### outputs.tf
- `dns_records_to_create` gains, inside the existing `compact([...])`: `local.mail_on ? join("\n", [for t in aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens : "CNAME  ${t}._domainkey.${var.mail_from_domain}  ->  ${t}.dkim.amazonses.com   (DNS only / grey cloud)"]) : ""`.
- New `output "ses_identity"` = `local.mail_on ? { domain = var.mail_from_domain, verified = aws_sesv2_email_identity.mail[0].verified_for_sending_status, dkim = aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].status } : null` so `terraform refresh && terraform output ses_identity` answers "are the CNAMEs in yet".

### observability.tf
- `aws_cloudwatch_log_metric_filter "otp_send_failures"` with `pattern = "\"auth-otp send failed\""`, metric `REEP/Auth` / `OtpSendFailures`, and `aws_cloudwatch_metric_alarm "otp_send_failures"` (Sum over 300 s >= 1, notBreaching, -> alerts topic), the dropped_turns shape verbatim, described "Sign-in codes are not being delivered - the API answers 202 and students receive nothing. See docs/email-password-sign-in.md."
- `claude_observer_read` gains read-only `ses:GetAccount`, `ses:GetEmailIdentity`, `ses:ListEmailIdentities`, `ses:GetConfigurationSet`.

### Nothing else
security.tf: no change (api SG egress is open; tasks reach `email.ap-south-1.amazonaws.com` through the NAT). github_oidc.tf: no change (the deploy role cannot create IAM/SES; a human `terraform apply` is the only path). versions.tf: no change (SES lives in the default provider's ap-south-1). secrets.tf: no change. The retention scheduled task and every deploy.yml one-off share the task definition and therefore the env and the grant — inert for them.

## Operator steps
1. 0. Do not set LOCAL_AUTH_ENABLED (local_auth_enabled) in production before step 6. Everything before it can be done while students still see Google only; identity verification, DNS and SES production access all take wall-clock time, and the UI must not advertise a door that silently sends nothing.
2. 1. Choose the sending domain, consciously. Recommended when the college's DNS admin will add three CNAMEs: the ROSTER domain (`mail_from_domain = "bgscet.ac.in"`, `mail_from_address = "REEP <no-reply@bgscet.ac.in>"`, `mail_reply_to = <placement office>`), because inside the SES sandbox a verified DOMAIN identity makes every @bgscet.ac.in recipient deliverable and a cohort pilot can run before production access is granted. Otherwise the app's own subdomain (`mail_from_domain = var.domain_name`, e.g. reep.bgscet.ac.in) keeps DNS in your hands but blocks every student until step 5 is approved. Prove whichever you chose with one real send (step 7) before rollout day.
3. 2. `cd infra/aws && terraform apply -var-file=prod.tfvars` with the mail_* variables set (prod.tfvars is gitignored). This creates the SESv2 identity with Easy DKIM, the configuration set with BOUNCE/COMPLAINT/REJECT events to the alerts topic, the scoped `send-sign-in-codes` policy on the api task role, registers a new task revision with EMAIL_TRANSPORT=ses / EMAIL_FROM / EMAIL_REPLY_TO / SES_REGION / SES_CONFIGURATION_SET, and re-points the service. `terraform validate` must pass first. The operator-owned secret is NOT touched — do not re-put it.
4. 3. Add the three DKIM CNAMEs printed by `terraform output dns_records_to_create` at the registrar / Cloudflare, DNS-only (grey cloud) — a proxied CNAME breaks DKIM verification exactly as it breaks the ALB origin. Then `terraform refresh && terraform output ses_identity` (or `aws sesv2 get-email-identity --email-identity <domain> --region ap-south-1 --query '{sending:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'`) until `verified = true` (minutes to an hour, up to 72 h). Until then SES refuses to send from the domain.
5. 4. SES SANDBOX, on by default for every new account per region: while sandboxed, SES sends ONLY to recipients that are themselves verified identities (a verified DOMAIN counts for every address on it), at most 200 messages a day and 1 per second. Check with `aws sesv2 get-account --region ap-south-1 --query '{prod:ProductionAccessEnabled,quota:SendQuota}'`. If your sending domain is not the roster domain, verify your own address for the end-to-end test: `aws sesv2 create-email-identity --email-identity you@bgscet.ac.in --region ap-south-1` and click the link. Any unverified student would get nothing while the API answers 202 — the ERROR line `auth-otp send failed` (SES code `MessageRejected`, 'Email address is not verified'), the FAILED row in `GET /api/director/mail?kind=auth-otp`, and the `otp_send_failures` alarm are the witnesses.
6. 5. Request production access (leaves the sandbox; required for a non-roster sender, for more than 200 codes/day, or for bursts above 1/s): console -> Amazon SES -> Account dashboard -> 'Request production access', or `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://reep.bgscet.ac.in --use-case-description "One-time sign-in codes for a college placement dashboard; recipients are enrolled students and staff on bgscet.ac.in; ~50/day; bounces and complaints go to an SNS topic and addresses are removed from the roster by the placement office" --additional-contact-email-addresses ops@... --contact-language EN --region ap-south-1`. AWS answers within ~24 h; confirm `ProductionAccessEnabled: true`.
7. 6. Turn the door on: set `local_auth_enabled = "true"` in prod.tfvars, `terraform apply` (new task revision), then run the Deploy workflow or `aws ecs update-service --cluster reep --service reep-api --force-new-deployment` so every task carries LOCAL_AUTH_ENABLED=true. The alembic migration for `auth_email_otps` ships with the code deploy that precedes this (deploy.yml runs `alembic upgrade head` as a one-off task by family) — code + migration first, flag second. Run `python -m app.seed_roster --rekey-domain` BEFORE this step if the email convention was ever in doubt: rows that have set a password are no longer movable by design.
8. 7. Verify: `curl https://reep.bgscet.ac.in/api/auth/sso/status` shows `password_login_available: true`, `password_setup_available: true`, `password_reason: null`; `/ready` shows `email.transport: ses`, `configured: true`, `local_auth: true`. Then, with your own roster address, use 'Create your password' end to end: the code arrives with DKIM=pass in the Gmail headers (Show original), the password signs you in, `select status, error, sent_at from mail_logs where kind='auth-otp' order by sent_at desc limit 5;` shows SENT, and a second browser that held your old session now answers 401 on /api/auth/me. Then sign in with Google on the same account to confirm both doors mint a working session, and use the shell's 'Change password' link once.
9. 8. Runbook for 'I never got a code' (in docs/email-password-sign-in.md): first `GET /api/director/mail?kind=auth-otp` — a FAILED row with `MessageRejected` = still in the sandbox, unverified recipient, or DKIM not yet verified; `AccessDeniedException` = the identity/configuration-set ARN or the FromAddress condition does not match EMAIL_FROM (re-apply); `Throttling` / quota = sandbox limits; `AccountSendingPausedException` = reputation pause, read the bounce notifications on the alerts topic; no row at all = the address is not on the roster, not on ROSTER_EMAIL_DOMAIN, inside the 60 s cooldown, or the hourly cap (3) was reached (a WARNING with the user id in CloudWatch); a SENT row and no mail = the college's Google Workspace spam quarantine (admin console -> Apps -> Gmail -> Spam) and the DKIM CNAMEs; codes visible in CloudWatch = EMAIL_TRANSPORT=log on a non-production ENV name (the door refuses to open on it).
10. 9. Rollback: `local_auth_enabled = "false"` + apply (or LOCAL_AUTH_ENABLED=false in compose). The form renders disabled with the reason, /login and /password/* refuse, passwords already set stay in the database inert and work again the moment the flag returns, Google is unaffected throughout, and no sessions are revoked by the flag either way.
11. 10. Non-AWS hosts (docker-compose.prod.yml): set EMAIL_TRANSPORT=smtp, SMTP_HOST/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD, EMAIL_FROM, LOCAL_AUTH_ENABLED=true. Google Workspace relay: `SMTP_HOST=smtp-relay.gmail.com SMTP_PORT=587 SMTP_STARTTLS=true` with a Workspace user + app password (the Workspace admin must allow the relay). EMAIL_TRANSPORT=log is refused as 'ready' on every non-dev ENV and the status probe says why. Local development needs nothing: ENV=dev resolves a blank transport to `log` and the code prints in the uvicorn console; to try SMTP locally, Mailpit/MailHog on `SMTP_HOST=localhost SMTP_PORT=1025 SMTP_STARTTLS=false`.
12. 11. Rotating AUTH_SECRET signs everyone out (as today) AND invalidates every outstanding code (the HMAC key derives from it) — do it at a quiet hour and expect 'code not valid' from anyone mid-flow.
13. 12. Tell students what to expect (one paragraph for the placement office): 'Sign in with Google as before, or create a password: on the sign-in page choose Create your password, enter your college address, enter the 6-digit code we email you, choose a password. Codes last 10 minutes; only the newest one works; after five wrong tries request a new one; wait a minute between requests. Setting or changing a password signs you out everywhere else. Staff will never ask you for a code.' Adoption check: `select count(*) filter (where password_hash like 'scrypt:%') as with_password, count(*) as total from users where role='STUDENT';`
14. 13. PR hygiene demanded by .github/pull_request_template.md: the PR body must state the guard that changed — `password_login_allowed` gained the explicit LOCAL_AUTH_ENABLED + ready-transport arm beside the untouched dev allowlist; `production_boot_failures()` unchanged; security.py gained UNUSABLE_PASSWORD_HASH/has_usable_password; identity.py gained get_optional_session; infra/aws gained a scoped ses:SendEmail grant conditional on an identity; secrets.tf, outputs.tf's external_secret_arn and the operator-owned secret JSON are UNCHANGED. Edit app/config.py and .env.example with CRLF line endings and check `git diff --stat`.

## Tests
- apps/api-py/tests/test_email.py (no DB): test_log_transport_writes_the_message_to_the_reep_email_logger_and_sends_nothing (caplog); test_smtp_transport_starttls_login_and_send_message (monkeypatch smtplib.SMTP with a fake recording ehlo/starttls/login/send_message/quit; asserts From/To/Subject/Reply-To, that starttls is skipped when SMTP_STARTTLS=false, and that port 465 uses SMTP_SSL); test_smtp_failure_becomes_email_error_without_the_body; test_ses_transport_calls_send_email_with_simple_text_content (monkeypatch app.email._ses_client; asserts FromEmailAddress, ToAddresses, ReplyToAddresses only when set, ConfigurationSetName only when set, UTF-8 charsets, no Raw, and that boto3 is imported lazily); test_ses_client_error_becomes_email_error_naming_the_ses_code (ClientError Code=MessageRejected -> 'MessageRejected' in str, body absent); test_no_transport_raises_email_error; test_unknown_transport_raises_email_error.
- apps/api-py/tests/test_local_auth_gates.py (no DB except where marked; the test_voice_gates idiom — monkeypatch the live settings singleton, reverted at teardown; pure Settings(_env_file=None, ...) constructions elsewhere): test_password_login_stays_open_on_every_dev_env (parametrize sorted(_DEV_ENV_NAMES), local_auth_enabled False -> password_login_allowed True); test_password_login_is_refused_on_a_non_dev_env_unless_opted_in (test_voice_gates.NON_DEV_ENVS x enabled False -> POST /api/auth/login 403 naming Google; /password/otp and /set 503 naming LOCAL_AUTH_ENABLED); test_the_403_and_503_fire_before_the_database_is_touched (monkeypatch get_db to raise; still 403/503 — closes the gap: the 403 branch has no test today); test_an_explicit_opt_in_with_a_ready_transport_opens_the_door_on_prod_and_staging (ses with from+region; smtp with host+from); test_the_flag_alone_and_a_transport_alone_do_not_open_the_door; test_the_log_transport_is_never_ready_outside_dev (NON_DEV_ENVS: email_ready False, 'log' in reason, local_auth_ready False even with the flag); test_blank_transport_means_log_on_dev_and_nothing_elsewhere; test_email_ready_requires_from_for_ses_and_host_plus_from_for_smtp (each missing field -> False, reason names the variable); test_smtp_refuses_credentials_without_tls (username set, starttls False, port 587 -> not ready, reason names SMTP_STARTTLS; port 465 -> ready); test_ses_region_resolves_like_nova_region (SES_REGION > AWS_REGION > AWS_DEFAULT_REGION > ''; monkeypatch.delenv/setenv, _env_file=None); test_blank_lines_for_the_new_fields_are_the_defaults (Settings(_env_file=None, local_auth_enabled='', smtp_port='', smtp_starttls='') -> False/587/True); test_email_settings_are_never_a_boot_failure (test_boot_guard._cfg(local_auth_enabled=True, email_transport='nonsense') -> production_boot_failures() == []).
- apps/api-py/tests/test_local_auth.py (@requires_db; a `transport` fixture monkeypatches settings.local_auth_enabled=True, settings.email_transport='log' and replaces app.email.send with a recorder list so tests read codes from captured OutboundEmail objects, never from a log; a `roster_user` factory creates a User with password_hash=UNUSABLE_PASSWORD_HASH on @bgscet.ac.in plus a Student row and tears down LoginDay/Student/User — auth_email_otps cascade; module docstring notes that Starlette's TestClient completes BackgroundTasks before client.post returns): test_request_answers_202_with_the_constant_body_for_unknown_and_off_domain_addresses_and_sends_nothing (parametrized incl. a MENTOR granted at gmail.com; asserts no auth_email_otps row, body == {ok: true, resend_after_seconds: 60}); test_request_for_an_enrolled_college_address_sends_exactly_one_six_digit_code (mixed-case roster address MUST send; no caplog record at any level contains the code or the address); test_the_handler_touches_no_database_before_the_202 (monkeypatch app.routers.local_auth.get_db / the request-scoped session to raise; still 202; the background task's own SessionLocal did the work); test_the_code_endpoint_never_reveals_a_send_failure (grafted from P2: recorder raises EmailError -> still 202; mail_logs kind auth-otp status FAILED with the error text; caplog ERROR contains 'auth-otp send failed' and NOT the address or code); test_set_with_the_right_code_signs_in_and_replaces_the_sentinel (200, reep_session cookie, /api/auth/me 200, password_hash startswith 'scrypt:', google_sub unchanged, consumed_at set, LoginDay written; claim keys == the pinned set plus tokenVersion); test_set_revokes_every_other_session_and_the_new_cookie_survives (settings.auth_revocation_cache_seconds=0; cookie A from /login; set via code -> cookie B; A -> /me 401, B -> 200; token_version +1); test_the_new_password_works_on_the_login_door_and_the_old_one_does_not; test_a_code_is_single_use; test_a_wrong_code_counts_an_attempt_and_five_wrong_burn_it (attempts == 5, then the RIGHT code -> 400); test_an_expired_code_is_refused (UPDATE expires_at = now()-1s); test_a_new_request_supersedes_the_previous_code (after monkeypatching OTP_RESEND_SECONDS=0); test_resend_is_silently_throttled_for_sixty_seconds (second request inside the cooldown -> 202, one row, one send); test_the_fourth_request_in_an_hour_answers_202_and_sends_nothing (WARNING names the user id; superseded rows still counted); test_stale_rows_and_old_mail_logs_are_purged_by_retention (retention.purge_expired deletes an otp row backdated 25 h and a mail_logs auth-otp row backdated 181 d; reports otp_rows_deleted and otp_mail_logs_deleted); test_a_weak_password_or_the_email_as_password_is_refused_with_422_before_spending_an_attempt; test_set_for_an_unknown_or_off_domain_address_is_the_same_400; test_change_password_with_a_matching_session_works_and_keeps_the_caller_signed_in (decision (b): cookie A -> /otp and /set with A's email -> 200, response cookie C works, A -> 401; a second device's cookie B -> 401); test_a_session_for_user_a_cannot_request_or_set_for_user_b (403 on both endpoints, no auth_email_otps row, no send); test_login_refuses_an_off_domain_account_with_the_uniform_401; test_login_refuses_the_sentinel_with_the_uniform_401_and_burns_the_equaliser (monkeypatch app.routers.auth.verify_password with a recorder; called once with _TIMING_EQUALIZER_HASH for sentinel AND unknown-email); test_login_lookup_is_case_insensitive; test_login_failures_are_rate_limited_per_ip_and_per_address_and_successes_are_not (monkeypatch the window limits small; 429 + Retry-After; a success clears the address window; a different address still answers); test_otp_request_and_set_are_rate_limited_per_ip (limits monkeypatched; ratelimit.reset() between); test_otp_hash_is_keyed_on_auth_secret_and_bound_to_the_row; test_password_endpoints_also_answer_under_api_v1.
- apps/api-py/tests/test_sso_contract.py (edit): the parametrize list at L104 gains 'password_setup_available' and 'password_reason'; test_the_login_screen_calls_paths_the_router_actually_serves becomes parametrized over login.component.ts, password-setup.component.ts AND core/auth.service.ts, with the served set `{r.path for r in auth.router.routes} | {r.path for r in local_auth.router.routes}` (prefix-less '/auth/password/otp', '/auth/password/set'). The `?error=` tests are untouched and must stay green with NO new codes.
- apps/api-py/tests/test_google_callback.py:290 (edit): exact set becomes {'google_available','password_login_available','password_setup_available','domain','reason','password_reason'}; add `assert body['password_setup_available'] is False` under the suite default and `'LOCAL_AUTH_ENABLED' in body['password_reason']`. The claim-set test at L164 stays as is (token_version 0 users still omit the claim).
- apps/api-py/tests/test_auth_rbac.py, test_mentee_records.py, test_faculty_alumni.py, test_conversations.py and every login/make_user user: unchanged and required green — the proof the dev arm of the guard did not move.
- apps/api-py/tests/test_boot_guard.py (edit + add): reword the L349-364 docstring's guard list; add test_email_and_local_auth_settings_never_refuse_boot using _cfg(...) with the worst email config and _boot(monkeypatch, cfg) starting cleanly.
- apps/api-py/tests/test_ratelimit_windows.py (new, no DB): FixedWindow preserves registration's 20-per-600 s behaviour (429 + Retry-After), a spent window is not extended by further hits, blocked() does not count and retry_after() does, hit() counts without checking, the 4096-key eviction still runs, and ratelimit.reset() clears every registered window.
- apps/api-py/tests/test_mailer.py (unchanged): the Driver contract local_auth.deliver_code relies on. tests/test_seed_guard.py: behaviour unchanged (docstring wording only).
- tools/ci/check_api_imports.py (CI job api-imports, unchanged): proves app/email.py, app/local_auth.py and app/routers/local_auth.py import against requirements.txt alone — boto3 lazily, smtplib/ssl/email.message from the stdlib.
- apps/web: `npx tsc --noEmit -p tsconfig.app.json`, `npx ng test --watch=false` (password-setup.component.spec.ts: 202 -> code step + countdown; unavailable probe -> alert, no form; 400 keeps the typed password; optional login.component.spec.ts), `npx ng build` (production budgets: both screens are lazy chunks; initial stays ~142 kB; the shell's new titlebar link adds bytes to the eager chunk but no import).
- infra: `terraform init -backend=false && terraform validate` in infra/aws after adding email.tf, the variables, the env entries, the outputs and the alarm.
- Manual, once, on a dev box with no .env edits beyond LOCAL_AUTH_ENABLED=true: the code prints in the uvicorn log (`EMAIL (log transport, NOT sent)`), the seeded student@ can set a new password and sign in with the form, the shell's Change password link completes a change and the old tab is signed out, and `select status, error from mail_logs where kind='auth-otp';` shows SENT rows.

## Docs
- AGENTS.md (LF; very long single lines — exact-string edits only): heading '## Auth — Google-only sign-in over the session retained from the migration' -> '## Auth — Google sign-in and email & password over one retained session'; first sentence -> 'Sign-in is Google OR email & password, for every role, and the roster is the access control for both.' ('no passwords' on seed_roster kept — the roster seed writes the unusable sentinel); the `POST /api/auth/login` paragraph rewritten to state the new guard (`password_login_allowed = _is_dev_env(env) or local_auth_ready`, still an allowlist, still never `not is_prod`), the two password endpoints, the 202-always rule and the BackgroundTasks reason, that create/forgot/change share one screen and one endpoint set with an optional session bound to the address, LOCAL_AUTH_ENABLED + EMAIL_TRANSPORT (ses/smtp/log, log never ready outside dev), that setting a password revokes the user's other sessions, and a one-line runbook query (`select status, error from mail_logs where kind='auth-otp' order by sent_at desc limit 20;`) pointing at docs/email-password-sign-in.md. The Google sentences about token verification, sso_not_enrolled, google_sub and docs/google-sign-in.md stay verbatim.
- docs/email-password-sign-in.md (new): the design record and runbook — the two doors diagram; the three modes on one screen; the OTP lifecycle (issue / cooldown / supersede / attempts / consume / purge, with the numbers); why HMAC not scrypt; why 202 always and why the WHOLE issue path is a background task; what revokes what (a table); the domain fence and settings.roster_domain; the guard rework with the truth table; the adapter and each transport's settings (incl. the TLS refusal and port 465); the SES section (identity, DKIM, configuration set + bounce SNS, the scoped grant, the sandbox and the verified-domain rule, both sending-domain choices and their consequence, the production-access request text); a troubleshooting table (no code arrived / 'code not valid' / 403 on login / 503 on the password endpoints / 403 on change / everyone signed out / codes in CloudWatch) mapping symptom -> cause -> where to look; the follow-ups deliberately not built (OTP-on-login flag, custom MAIL FROM, HTML mail, alternate-address recovery).
- docs/google-sign-in.md (LF): title stays; L3-6 'There is no password field on the production login screen' -> describes the second door and links the new doc; endpoint table L93-100 adds the two password endpoints and changes the `POST /api/auth/login` row to '200 when `password_login_allowed`; 403 otherwise (dev/CI, or LOCAL_AUTH_ENABLED with a ready transport)'; the whole '## Password login: kept, and refused in production' section (L409-441, whose snippet is already stale) replaced by '## Password login: the second door' with the real guard code and a pointer; first-deploy checklist item 6 -> 'answers 403 until LOCAL_AUTH_ENABLED is set with a ready transport'; troubleshooting table gains 'Password form disabled with a reason' -> `GET /api/auth/sso/status`.password_reason. Also fix the drifted `?error=` table (add sso_identity_mismatch) while there.
- docs/aws-deployment.md (LF): §1 Security row 'the api task's IAM can invoke Nova and *nothing else*' -> '...can invoke Nova and, when an SES identity exists, send sign-in codes from it — nothing else'; §2 Prerequisites: SES in a fresh account is sandboxed, and the DKIM CNAMEs are grey-cloud too; §3 secret-fill step gains a sentence that SES needs NO entry in the operator-owned secret; new '## 8. Email & password sign-in on SES' with the numbered operator steps (the §7 Bedrock-checklist precedent), both sending-domain options with their sandbox consequence, and the rollback step.
- docs/deployment-env.md: API image 'Optional' section gains LOCAL_AUTH_ENABLED, EMAIL_TRANSPORT, EMAIL_FROM, EMAIL_REPLY_TO, SES_REGION, SES_CONFIGURATION_SET, SMTP_* with blank-means semantics; 'Secrets hygiene' names SMTP_PASSWORD as a secret.
- docs/architecture.md:378 'Password login' row and docs/deployment-process.md:418-421: the allowlist wording gains 'OR the explicit LOCAL_AUTH_ENABLED opt-in with a ready email transport'.
- CONTRIBUTING.md:588-590 and .github/pull_request_template.md:117: 'password_login_allowed must remain an allowlist of dev/CI environment names OR the explicit LOCAL_AUTH_ENABLED opt-in with a ready email transport — never `not is_prod`'. The PR that lands this answers that checklist item as listed in operator step 13.
- apps/api-py/.env.example (CRLF): the ENV block (L40-52) sentence 'password sign-in at POST /api/auth/login' -> 'password sign-in without LOCAL_AUTH_ENABLED'; the Google block header '(the ONLY way a human signs in)' -> '(one of the two ways in)'; L69-71 and L78-79 reworded; the two new blocks appended after ROSTER_EMAIL_DOMAIN.
- apps/api-py/app/config.py (CRLF): the `_DEV_ENV_NAMES` comment ('Three guards read it') -> four; the Google block comment L161 'Sign-in is Google-only for every role' -> 'Google is one of two doors'; `google_ready`'s and `password_login_allowed`'s docstrings rewritten.
- apps/api-py/app/routers/auth.py (LF, mojibake em-dashes — copy bytes for exact-match edits): module docstring line 1 'password sign-in (dev/CI)' -> 'password sign-in (dev/CI, or opted in)', the endpoint list gains the two password routes, the `login()` docstring is rewritten (say 'the conftest fixtures and the modules that post to it' rather than a count), and the 'THE ROSTER IS THE ALLOWLIST' paragraph gains 'The password door reads the same roster and adds a domain fence.' The `The codes are:` table is NOT changed (contract test).
- apps/api-py/app/seed_roster.py and app/grant_access.py (LF; grant_access has mojibake): comments L15-16/L60-76/L156/L426/L430 and L5/L32 that say 'Google-only' / 'indistinguishable via POST /login' -> 'no local password yet; Google works, and the student can set a password through the emailed-code flow'; note on `_rekey_candidate` that a row with a set password is no longer movable BY DESIGN and the operator clears it by hand.
- apps/api-py/app/google_auth.py:91 comment 'the ONLY way into the app once password login is refused in production' -> 'one of two ways in'. No code change (decision 8).
- apps/web login.component.ts header (L2-7), login.component.html copy (L108-118 comments, L120-138 'Who can sign in', L142-150 technote), auth.service.ts header: 'Google only' sentences replaced as described in frontend.
- tests/test_seed_guard.py docstrings L96-97 and L122 ('under Google-only sign-in') -> 'under roster-only sign-in' (wording only).
- docs/codebase-mahabharath/05-auth-rbac.md:205-207 ('no password-change or password-reset endpoint anywhere') is now false: replace with a pointer to the new doc. tools/diagrams/render_architecture.py:221 and docs/architecture-blueprint.html:974 'Google-only SSO' -> 'Google + email/password, roster is the allowlist' (cosmetic; regenerate the diagram if the pipeline does).
- README.md: seeded-logins table unchanged (still valid in dev through the form); one line under Running: 'LOCAL_AUTH_ENABLED=true in apps/api-py/.env turns on the email & password door locally; codes print in the API log.'

## Files touched
- /home/user/reep-/apps/api-py/app/email.py (new)
- /home/user/reep-/apps/api-py/app/local_auth.py (new)
- /home/user/reep-/apps/api-py/app/models/auth_otp.py (new)
- /home/user/reep-/apps/api-py/app/models/__init__.py
- /home/user/reep-/apps/api-py/migrations/versions/<12hex>_auth_email_otps.py (new; down_revision d6a4e7f91b22, re-confirm with `alembic heads` at merge)
- /home/user/reep-/apps/api-py/app/routers/local_auth.py (new)
- /home/user/reep-/apps/api-py/app/routers/auth.py
- /home/user/reep-/apps/api-py/app/identity.py (get_optional_session)
- /home/user/reep-/apps/api-py/app/config.py (CRLF — preserve)
- /home/user/reep-/apps/api-py/app/security.py
- /home/user/reep-/apps/api-py/app/ratelimit.py (FixedWindow + registry; llm_rate_limited untouched)
- /home/user/reep-/apps/api-py/app/routers/registration.py (limiter extracted, behaviour preserved)
- /home/user/reep-/apps/api-py/app/main.py (mount local_auth.router at /api and /api/v1; one INFO line in lifespan)
- /home/user/reep-/apps/api-py/app/routers/health.py (soft `email` entry on /ready)
- /home/user/reep-/apps/api-py/app/retention.py (purge_expired calls local_auth.purge_stale; two summary keys)
- /home/user/reep-/apps/api-py/app/seed_roster.py (import the sentinel; comments)
- /home/user/reep-/apps/api-py/app/grant_access.py (import the sentinel; comments)
- /home/user/reep-/apps/api-py/app/google_auth.py (one comment)
- /home/user/reep-/apps/api-py/.env.example (CRLF — preserve)
- /home/user/reep-/apps/api-py/tests/test_email.py (new)
- /home/user/reep-/apps/api-py/tests/test_local_auth.py (new)
- /home/user/reep-/apps/api-py/tests/test_local_auth_gates.py (new)
- /home/user/reep-/apps/api-py/tests/test_ratelimit_windows.py (new, small)
- /home/user/reep-/apps/api-py/tests/test_sso_contract.py
- /home/user/reep-/apps/api-py/tests/test_google_callback.py (L290 exact set)
- /home/user/reep-/apps/api-py/tests/test_boot_guard.py
- /home/user/reep-/apps/api-py/tests/test_seed_guard.py (docstrings)
- /home/user/reep-/apps/web/src/app/features/login/login.component.ts
- /home/user/reep-/apps/web/src/app/features/login/login.component.html
- /home/user/reep-/apps/web/src/app/features/login/login.component.scss
- /home/user/reep-/apps/web/src/app/features/login/_auth-surface.scss (new)
- /home/user/reep-/apps/web/src/app/features/login/auth-errors.ts (new)
- /home/user/reep-/apps/web/src/app/features/login/password-setup.component.ts (new)
- /home/user/reep-/apps/web/src/app/features/login/password-setup.component.html (new)
- /home/user/reep-/apps/web/src/app/features/login/password-setup.component.scss (new)
- /home/user/reep-/apps/web/src/app/features/login/password-setup.component.spec.ts (new)
- /home/user/reep-/apps/web/src/app/features/login/login.component.spec.ts (new, optional)
- /home/user/reep-/apps/web/src/app/layout/app-shell.component.html (Change password titlebar link)
- /home/user/reep-/apps/web/src/app/layout/app-shell.component.ts (RouterLink import if absent)
- /home/user/reep-/apps/web/src/app/layout/app-shell.component.scss (.titlebar-link)
- /home/user/reep-/apps/web/src/app/app.routes.ts
- /home/user/reep-/apps/web/src/app/core/auth.service.ts (login() drops `next`; setPassword())
- /home/user/reep-/tools/fonts/icon-names.txt + regenerated apps/web/public/fonts subset (the `key` glyph)
- /home/user/reep-/infra/aws/email.tf (new)
- /home/user/reep-/infra/aws/variables.tf
- /home/user/reep-/infra/aws/ecs.tf
- /home/user/reep-/infra/aws/outputs.tf
- /home/user/reep-/infra/aws/observability.tf
- /home/user/reep-/docker-compose.prod.yml
- /home/user/reep-/AGENTS.md
- /home/user/reep-/docs/email-password-sign-in.md (new)
- /home/user/reep-/docs/google-sign-in.md
- /home/user/reep-/docs/aws-deployment.md
- /home/user/reep-/docs/deployment-env.md
- /home/user/reep-/docs/architecture.md
- /home/user/reep-/docs/deployment-process.md
- /home/user/reep-/docs/codebase-mahabharath/05-auth-rbac.md
- /home/user/reep-/docs/architecture-blueprint.html (one sentence)
- /home/user/reep-/tools/diagrams/render_architecture.py (one label)
- /home/user/reep-/CONTRIBUTING.md
- /home/user/reep-/.github/pull_request_template.md
- /home/user/reep-/README.md
- NOT touched, on purpose: app/policies.py, app/schemas/auth.py (LoginRequest/SessionUser unchanged; the new request models live in app/routers/local_auth.py), app/mailer.py, app/models/mail.py, app/models/user.py, the Google callback/start handlers in routers/auth.py, google_auth.py's code, app/seed.py, infra/aws/secrets.tf, infra/aws/security.tf, infra/aws/versions.tf, infra/aws/github_oidc.tf, .github/workflows/*, requirements*.txt, tests/conftest.py, apps/web/src/app/core/session.ts, apps/web/src/app/core/auth.guard.ts, apps/web/src/styles/*.scss.

## Risks
- The 'google-only' sentinel is load-bearing for `seed_roster --rekey-domain`: a roster row that has set a password is no longer recognised as 'ours' by `_rekey_candidate` and will not be moved if the email-domain guess turns out wrong after students have started setting passwords. Deliberate (a claimed row should not be silently renamed) but it narrows the rekey escape hatch; the runbook says to rekey BEFORE turning LOCAL_AUTH_ENABLED on and to fix stragglers by hand.
- Rate limits are per worker and keyed on the socket peer (IP windows) or the submitted string (address window). On AWS FORWARDED_ALLOW_IPS already makes request.client.host the real client; on a host that leaves it at '*' or puts an untrusted proxy in front, one machine rotating X-Forwarded-For gets an unlimited IP budget on /login — the per-address window (10 failures / 15 min) is then the only per-account brake, and it is also a bounded, self-serviceable lockout lever. The numbers are constants in local_auth.py for that reason; tune with evidence.
- Enumeration residual: none on the request path (the handler does no DB work). The 403 for a session/email mismatch is authenticated-only. What the feature reveals to a successful attacker of a mailbox is a password reset — the same trust root Google already relies on; the doc says so, so nobody later 'hardens' it into an SMS system.
- SES sandbox is the single most likely 'it is broken' report: the API answers 202, the student gets nothing, and the witnesses are an ERROR log line, a FAILED mail_logs row, the alarm and the bounce SNS. If the operator flips LOCAL_AUTH_ENABLED before the identity is verified (or before production access when the sender is not the roster domain), every student is told a code is on its way and none arrives. Mitigated by ordering in the runbook and by the alarm, not by code. The verified-DOMAIN sandbox rule is AWS's documented behaviour and must be proven with one real send before rollout day.
- Deliverability into Google Workspace is not guaranteed by DKIM alone: without SPF alignment (custom MAIL FROM) or a college-level DMARC allowance, mail from a new identity may land in quarantine; the bounce/complaint SNS destination and the Workspace admin quarantine are where to look. Custom MAIL FROM is the first follow-up.
- DNS may belong to the college, not the operator: DKIM CNAMEs on bgscet.ac.in take someone else's time; the SMTP transport via the Workspace relay is the designed fallback and needs a Workspace admin instead.
- Revocation stays best-effort across workers (the existing app/security.py limit): after a password set a stolen session on another worker lives up to AUTH_REVOCATION_CACHE_SECONDS (60 s). Same limit as logout today; not worsened, not fixed. A change-password on device A signs device B out — intended and written into the screen copy.
- A 6-digit code with 5 attempts and 3 issues per hour is 15 guesses per hour against 1e6 — fine — but the per-user hourly cap and the 60 s cooldown are also denial-of-service levers: anyone who knows a student's address can burn their codes for the hour. Chosen over a per-address lockout on the OTP path because it blocks one user's convenience for one hour rather than their login; the WARNING with the user id is the trace.
- The `log` transport defaulting on for blank EMAIL_TRANSPORT on dev ENVs prints codes to the terminal on every laptop. Harmless there, and the readiness rule refuses it everywhere else, but a developer who copies a dev .env onto a 'staging' box will see the password door go dark (503 with the reason) rather than leak — the intended direction, and a support question.
- app/config.py and .env.example are CRLF; the pre-commit `mixed-line-ending --fix=lf` hook converts the whole file the moment one LF line is inserted, turning a 40-line change into a 1148-line diff and a merge hazard. The implementer must write those two files with \r\n and check `git diff --stat` before committing.
- The SsoStatus exact-set test and the TS interface grep are deliberately brittle; the API change and all three test/interface edits must land in commit (2), or CI is red until the web commit. The route-table contract test now also scans auth.service.ts for `/auth/password/set`; the paths were chosen to fit its `[a-z/]+` regex.
- The optional-session binding on /password/* means a student who is signed in as one account and wants to create a password for another (two roster accounts in one browser) gets a 403 telling them to sign out first. Rare and honest; not a bug.
- The app-shell 'Change password' link is on every screen and does not probe: on a deployment with the door off, it leads to the setup screen's disabled state with the reason. Chosen over hiding the link behind a per-shell probe (a second probe on every page load for one link); if that support question recurs, the shell can read the probe once.
- The optional OTP-on-every-login flag is designed but not built. If someone builds it later without the `login`-purpose separation described here, a password-purpose code could be spent to log in; the purpose column and the 'reserved' comment exist to make that misuse visible in review.
- Terraform: `dkim_signing_attributes[0].tokens` is known after apply, so the first plan shows the DNS output as '(known after apply)' — expected. The `regex()` on mail_from_address fails the plan on a value with no @ — a feature, but the error text is Terraform's. The configuration set adds one more resource an operator must not delete by hand (the identity references it).
- mail_logs now holds a recipient address per code; retention deletes kind='auth-otp' rows after 180 days but other kinds are untouched, and the director audit view therefore shows at most six months of code history — stated in the doc so nobody reads an absent row as 'never requested'.