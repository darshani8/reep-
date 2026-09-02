# Email & password sign-in, with emailed one-time codes

The second door beside Google, added 2026-09. A student (or staff member) on
the roster sets a password themselves: they type their college address, a
6-digit code is emailed to it, they enter the code and choose a password, and
they are signed in. The same screen resets a forgotten password and changes a
known one. **Nothing about the session changed** — the cookie that comes out is
the `reep_session` Google mints, byte for byte — and **nothing about the roster
changed**: no row is ever created, no role is ever guessed, and an address that
is not already in `users` (or not on the college domain) gets exactly the same
answer as one that is.

It ships **dark**. `LOCAL_AUTH_ENABLED` defaults to `false` and `EMAIL_TRANSPORT`
to blank, so every existing deployment — the AWS task definition,
`docker-compose.prod.yml`, an unrecognised `ENV` — behaves as it did: Google
only, `POST /api/auth/login` refused outside dev/CI. Nothing in this feature is
ever a boot failure; the worst a misconfiguration can do is keep the door shut
and say why.

This page is the design record and the runbook. The AWS checklist (SES
identity, DKIM, sandbox, production access) is `docs/aws-deployment.md` §8; the
Google door is `docs/google-sign-in.md`.

---

## Two doors, one roster, one session

```
             ┌──────────── Google ────────────┐      ┌──── email & password ────┐
browser ──►  GET /api/auth/sso/google         │      │ POST /api/auth/login      │
             accounts.google.com              │      │   {email, password}       │
             GET /api/auth/sso/google/callback│      │                           │
             verify ID token (JWKS, aud, iss, │      │ POST /api/auth/password/otp
             exp, email_verified, nonce,state)│      │   {email}  ──► 202 always │
             └───────────────┬────────────────┘      │ POST /api/auth/password/set
                             │                       │   {email, code, new_password}
                             │                       └─────────────┬─────────────┘
                             ▼                                     ▼
                  select User where lower(email) = <address>   (the roster IS the allowlist;
                             │                                  the password door also fences
                             │                                  on ROSTER_EMAIL_DOMAIN)
                             ▼
                  _record_login -> _payload_for -> _issue_session
                  Set-Cookie: reep_session  (HS256 JWT, AUTH_SECRET, httpOnly, SameSite=Lax)
```

`require_*` in `app/identity.py` and every router read the cookie and cannot
tell which door minted it. The `users` table is unchanged: `password_hash` stays
`NOT NULL`, the roster seed keeps writing the unusable sentinel
(`security.UNUSABLE_PASSWORD_HASH`, the literal `google-only`, which
`has_usable_password` rejects structurally), and `google_sub` /
`token_version` are reused as they are.

### The files

| file | role |
|---|---|
| `apps/api-py/app/local_auth.py` | the lifecycle: constants, `address_allowed`, `find_user`, `otp_hash`, `issue_code`, `verify_code`, `consume_and_set_password`, `request_code` (the background task), `deliver_code`, `purge_stale`. FastAPI-free, like `google_auth.py` |
| `apps/api-py/app/routers/local_auth.py` | the two endpoints, mounted at `/api/auth/password/*` and `/api/v1/auth/password/*` |
| `apps/api-py/app/routers/auth.py` | `POST /api/auth/login` (the reworked door) and `GET /api/auth/sso/status` (the probe, two new fields) |
| `apps/api-py/app/email.py` | the transport adapter — the only module that knows how a message leaves the process |
| `apps/api-py/app/models/auth_otp.py` | `auth_email_otps`, the one new table |
| `apps/api-py/app/config.py` | `local_auth_enabled`, the `email_*` / `ses_*` / `smtp_*` settings, `email_ready`, `local_auth_ready`, and the reworked `password_login_allowed` |
| `apps/api-py/app/ratelimit.py` | `FixedWindow`, the four per-IP / per-address windows |
| `apps/web/src/app/features/login/` | the form on `/login`, and `/login/password` — one screen for create, reset and change |
| `infra/aws/email.tf` | the SES identity, configuration set, bounce events and the scoped `ses:SendEmail` grant |

---

## One screen, three modes

`/login/password?mode=create|reset|change` is one component and one endpoint
pair; `mode` changes the heading and the copy, never the request.

| mode | reached from | what differs |
|---|---|---|
| `create` | *Create your password* under the login form | the first-time copy. The row's `password_hash` is still the sentinel; `/set` overwrites it |
| `reset` | *Forgot your password?* | the same flow — a forgotten password and a never-set one are the same state to the server |
| `change` | the shell's title-bar *Change password* link, while signed in | the address is locked to the session's email; the copy says every other device will be signed out |

Step 1 asks for the address and posts `/otp`; step 2 shows the address, asks for
the code, the new password and its confirmation, and posts `/set`. Success
navigates to the role's home with the new cookie already set — `/set` returns
`SessionUser` and `AuthService.setPassword` stores it, so there is no extra
`/auth/me` round trip.

The change flow needs no third endpoint because of one rule on the two existing
ones: **when a `reep_session` cookie is present, the submitted address must
equal the session's address**, or the request is refused `403` before any
database read (`get_optional_session` in `app/identity.py`). No cookie means the
anonymous create/reset behaviour. A signed-in user therefore cannot use their
own session to mint a code for another address, and the change flow inherits the
table, the caps and the revocation of the anonymous one for free.

---

## The code's lifecycle

One table, `auth_email_otps`, no enums, no status column to drift. A row is
**live** when `consumed_at IS NULL AND attempts < 5 AND expires_at > now()`.

| constant (`app/local_auth.py`) | value | meaning |
|---|---|---|
| `OTP_DIGITS` | 6 | `f"{secrets.randbelow(10**6):06d}"` |
| `OTP_TTL_SECONDS` | 600 | ten minutes from issue |
| `OTP_MAX_ATTEMPTS` | 5 | wrong guesses per code; the sixth guess is refused even if right |
| `OTP_RESEND_SECONDS` | 60 | per-user cooldown, counted in the database so N workers do not multiply it; a request inside it is a silent 202 |
| `OTP_MAX_PER_HOUR` | 3 | codes issued per user per rolling hour; the fourth is a silent 202 and a WARNING naming the user **id** |
| `OTP_ROW_RETENTION_SECONDS` | 86 400 | rows older than a day are deleted on the next issue and by retention |
| `PASSWORD_MIN_CHARS` / `MAX_CHARS` | 10 / 200 | no composition rules (NIST 800-63B); not equal to the email address; the maximum bounds the scrypt input |

The steps, in order:

1. **issue** — `issue_code` deletes the user's rows older than a day; refuses
   inside the 60 s cooldown; refuses at three in the hour (superseded rows still
   count — they were requests); otherwise sets `expires_at = now()` on every
   older live row (**supersede by expiring, not deleting**, so the hourly count
   and the cooldown survive the request they should count), inserts the new
   row, and returns the plaintext code exactly once — to the caller that puts it
   in the email. It exists nowhere else.
2. **deliver** — through `app/mailer.py:deliver_once` with `kind="auth-otp"` and
   `dedupe_key=f"auth-otp:{otp.id}"`, so a retried task cannot send the same
   code twice and a legitimate second request is never deduped. A `SENT` or
   `FAILED` `mail_logs` row is written either way; the subject is *Your REEP
   sign-in code* (no digits — `mail_logs` stores subjects).
3. **verify** — `verify_code` finds the newest live row and compares
   `hmac.compare_digest(row.code_hash, otp_hash(...))`. A miss increments
   `attempts` and commits; a hit returns the row **without consuming it**.
4. **consume** — `consume_and_set_password` stamps `consumed_at`, writes
   `hash_password(new_password)` over the sentinel or the old hash, bumps
   `users.token_version`, and commits — **one transaction**. Code and password
   travel in one request, so there is no intermediate "code verified" bearer to
   steal or fixate.
5. **purge** — `purge_stale`, called from `retention.purge_expired`: OTP rows
   older than 24 h, and `mail_logs` rows with `kind='auth-otp'` older than 180
   days (the recipient address must not outlive the code forever; 180 d is the
   interview clock). Reported as `otp_rows_deleted` / `otp_mail_logs_deleted`.

The email itself is plain text, no link, no HTML, no name: *Your REEP code is
NNNNNN. It expires in 10 minutes and works once. Enter it on the page where you
asked for it. If you did not ask for a code, ignore this message — nothing
changes without it. REEP staff will never ask you for this code.* A code email
with markup and a button is what phishing looks like.

### Why HMAC, not scrypt

`code_hash` is `HMAC-SHA256(key = SHA256(label ‖ AUTH_SECRET), msg =
"<user_id>:<purpose>:<code>")`. A 6-digit code is 20 bits: a plain hash of it is
a lookup table, and a slow hash (scrypt, as one proposal had it) buys ~30 ms of
*unauthenticated* CPU per guess on the server for no gain over a keyed MAC —
brute force is stopped by `attempts` and `expires_at`, not by hash cost. The
keyed hash means a copy of the table without `AUTH_SECRET` verifies nothing, and
binding the message to `user_id:purpose` means a code can never verify against
another row. The guess budget per account is 5 attempts × 3 codes an hour = 15
guesses an hour against 1 000 000, before the per-IP windows.

`purpose` is `"password"` today. `"login"` is **reserved** for the optional
OTP-on-every-login flag (see *Not built*), so a password-purpose code can never
be spent to log in.

---

## Why `/otp` answers 202 to everyone — and why the whole path is a background task

`POST /api/auth/password/otp` returns `202 {ok: true, resend_after_seconds: 60}`
for an enrolled address, an unknown one, an off-domain one, a Google-only row, a
request inside the cooldown, one over the hourly cap, **and one whose email
failed to send**. The constant `60` is deliberate — a remaining-wait value would
be an oracle.

The handler does only: gate → per-IP window → session/address bind → normalise
→ `background.add_task(local_auth.request_code, email)` → 202. **Every
distinguishing step** — the domain fence, the lookup, the cooldown, the cap, the
supersede, the insert, the send — runs in the `BackgroundTasks` callable, with
its own `SessionLocal()`, *after* the response has been written. Neither the
body nor the clock can tell the caller whether the address is on the roster;
the earlier design's documented "one INSERT versus one SELECT" residual is
removed structurally rather than accepted. (There is no `time.sleep` floor: a
floor is not an equaliser, and it pins a threadpool thread.)

One residual is accepted and named: `POST /api/auth/password/set` does one
query for an unknown or off-domain address and two for a roster address (the
users lookup, then the code lookup), so its latency is not identical across the
two. It is bounded by the 20-per-15-minutes per-IP window and it answers
nothing a caller can use without also holding the code; the request endpoint,
which needs no code, is the one that must not leak and does not.

The same rule is why a **transport failure is not a 503**: only enrolled
addresses could receive it. The witnesses are elsewhere, and they are the
runbook below — the ERROR line `auth-otp send failed for otp <id>: <error>`
(the CloudWatch tripwire; never the code, never the address), the `FAILED`
`mail_logs` row, the `reep-auth-otp-send-failures` alarm, and the SES
bounce/complaint notifications on the alerts topic.

`/set` has the same shape on the other side: **one** `400` sentence — *That
code is not valid or has expired. Only the newest code works — check the latest
email, or request a new one.* — for an unknown address, an off-domain one, no
live row, a wrong code, exhausted attempts, an expired code and a consumed one,
with a dummy `hmac.compare_digest` on the no-user branch and no attempts-left
counter. The weak-password `422` is checked *before* the code, so a bad password
does not spend an attempt.

Nothing about the email is logged at any level. WARNING and ERROR lines carry
user ids and OTP ids.

---

## What revokes what

| event | what dies | how fast |
|---|---|---|
| a new code request | the previous live code (expired, not deleted) | immediately |
| a successful `/set` | the code (`consumed_at`) | immediately, same transaction as the password write |
| a successful `/set` — create, reset **or** change | **every other session of that user**: `users.token_version` is bumped and `security.note_revocation` is called; the response cookie carries the new version and is the one survivor | immediately on the worker that served it; within `AUTH_REVOCATION_CACHE_SECONDS` (60) on the others — the limit `app/security.py` already states, the same as logout |
| a wrong code, five times | that code, even for the right guess afterwards | immediately |
| the `LOCAL_AUTH_ENABLED` flag, either way | nothing — passwords already set stay in the database inert and work again when the flag returns | — |
| rotating `AUTH_SECRET` | **every session and every outstanding code** (the HMAC key derives from it) | immediately; do it at a quiet hour and expect *code not valid* from anyone mid-flow |
| `--rekey-domain` | nothing here — but a row that has set a password is no longer recognised as the seed's and is **not moved**, by design (see the risks) | — |

Setting a password never touches `google_sub`: the Google door keeps pinning the
row to the same Google account.

---

## The domain fence

All three password endpoints go through one helper,
`local_auth.address_allowed(email)`: the part after `@` must equal
`settings.roster_domain`. That is `ROSTER_EMAIL_DOMAIN` (alias
`COLLEGE_EMAIL_DOMAIN`), else the first `GOOGLE_ALLOWED_DOMAIN` entry, else
`bgscet.ac.in` — never empty. There is no second domain setting.

So a staff member `grant_access` enrolled at a Gmail address can sign in with
Google and only with Google: on the password door they get the same 401 / 202 /
400 as an unknown address. The Google path keeps its roster-only rule and
`GOOGLE_ALLOWED_DOMAIN` stays a label, byte for byte.

Lookups on every door are case-insensitive (`func.lower(User.email)`), which
fixes the old password door's exact-match lookup at the same time.

---

## The guard rework

Before: `password_login_allowed` was `_is_dev_env(self.env)` — the dev/CI
allowlist and nothing else. After:

```python
@property
def password_login_allowed(self) -> bool:
    return _is_dev_env(self.env) or self.local_auth_ready
```

where `local_auth_ready = local_auth_enabled and email_ready`. Two ways to be
open, and nothing else opens it:

1. the dev/CI allowlist, kept verbatim — `tests/conftest.py`'s `login` fixture,
   the seeded `student@ / mentor@ / director@` logins and CI keep working with
   no configuration;
2. `LOCAL_AUTH_ENABLED=true` **and** a ready transport — the operator has
   deliberately switched the door on and a student can actually obtain a
   password through it.

It is still an allowlist and still never `not is_prod`. An unrecognised, blank
or typo'd `ENV` with nothing configured refuses exactly as before, and the only
way it opens is the same explicit opt-in that opens it in production. The
failure mode of a misconfiguration remains "nobody can use a password", never
"anyone can".

| `ENV` | `LOCAL_AUTH_ENABLED` | transport | `POST /login` | `/password/otp`, `/set` |
|---|---|---|---|---|
| dev / test / ci / local / development / testing | any | any | **open** (fixtures unchanged) | open iff the flag is set (blank transport = `log` on dev); else 503 with the reason |
| prod / production / prd / live | false | any | 403, names Google | 503, names `LOCAL_AUTH_ENABLED` |
| prod | true | `ses` or `smtp`, ready | **open** | **open** |
| prod | true | `log`, blank, or misconfigured | 403 | 503, the reason names the variable |
| staging / uat / "" / a typo | false | any | 403 (fail closed, as before) | 503 |
| staging | true | ready | **open** — the same explicit opt-in as prod | **open** |

The two password endpoints gate on `local_auth_ready` (503 with the reason),
which is stricter than `/login`'s property on purpose: on a dev box with a
broken `EMAIL_TRANSPORT` the fixture door stays open and the code flow says why
it cannot. `production_boot_failures()`, `insecure_cookies_allowed`,
`worker_auth_optional` and every `is_prod`-keyed refusal are untouched.

`GET /api/auth/sso/status` reports it all, never with a 4xx:
`password_login_available` (the `/login` guard), `password_setup_available`
(`local_auth_ready`) and `password_reason` (the sentence when it is false, else
`null`). The login screen renders the form disabled **with that sentence** when
the door is shut, and hides the create/reset links with the reason when only
setup is unavailable. `GET /ready` carries a soft `email` entry
(`transport`, `configured`, `local_auth`) that never fails the probe.

### Rate limits

Four fixed windows, one class (`ratelimit.FixedWindow`, extracted from the
registration router's limiter so there are not three copies), all checked
**before** the database and all answering `429` + `Retry-After`:

| window | key | limit |
|---|---|---|
| `LOGIN_IP_FAILURES` | client IP | 40 **failures** / 10 min |
| `LOGIN_ADDRESS_FAILURES` | the normalised submitted address (a string — says nothing about existence) | 10 **failures** / 15 min; a success clears it |
| `OTP_REQUESTS_PER_IP` | client IP | 30 / 10 min (a lab behind one NAT on rollout day must not lock itself out) |
| `OTP_SET_PER_IP` | client IP | 20 / 15 min |

Per process, so N workers = N × the limit — still a ceiling. The per-address
window is the one deliberate lockout lever and it is bounded: failures only,
fifteen minutes, and the 429 names the emailed-code reset as the self-service
escape. On AWS the IP is trustworthy because the Dockerfile already sets
`FORWARDED_ALLOW_IPS` to the VPC; on a host that leaves it at `*` or fronts the
API with an untrusted proxy, the per-address window is the only per-account
brake. The numbers are constants in `local_auth.py` for that reason — tune them
with evidence.

---

## The email adapter, and each transport

`app/email.py` is the only module that knows how a message leaves the process.
`send(OutboundEmail)` dispatches on `settings.email_transport_effective`; a
failure is one `EmailError` whose text is safe for `mail_logs.error` and the
log — provider code and message, never the body, never a credential.

| `EMAIL_TRANSPORT` | settings | ready when | notes |
|---|---|---|---|
| *(blank)* | — | never — **except on a dev `ENV`, where blank means `log`** so a fresh clone exercises the flow with no `.env` edit | anything else gets nothing, and `password_reason` says *EMAIL_TRANSPORT is blank* |
| `log` | — | **only on a dev `ENV`** | writes `EMAIL (log transport, NOT sent) to=… subject=…` and the body — code included — to the `reep.email` logger. A sign-in code in a log is a sign-in code, so `email_ready` refuses it everywhere else |
| `smtp` | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS` (true), `EMAIL_FROM`, `EMAIL_REPLY_TO` | host and a parseable `EMAIL_FROM`; **refused when `SMTP_USERNAME` is set with `SMTP_STARTTLS=false` on a port other than 465** (credentials would cross in the clear) | port 465 → `smtplib.SMTP_SSL` (implicit TLS); otherwise `SMTP` + `starttls()` when enabled; `login()` only when a username is set; stdlib `EmailMessage`, `send_message`, 10 s timeout |
| `ses` | `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SES_REGION` (→ `AWS_REGION` → `AWS_DEFAULT_REGION`), `SES_CONFIGURATION_SET` | a parseable `EMAIL_FROM` and a resolved region | `boto3.client("sesv2")`, imported lazily, credentials from the task role via SigV4 — **no key, no secret**. `SendEmail` with Simple text content; `ClientError` becomes `EmailError("ses: <Code>: <Message>")` |

An unknown value is kept (so the reason can name it) and logged once as a
WARNING. Readiness is **config only** — no I/O on the request path and no
boot-time `GetEmailIdentity` (the IAM grant, `ses:SendEmail` only, would deny
it anyway). `app/main.py` logs one INFO line at boot — *email transport: …;
email & password sign-in: ready / <reason>* — a line, not a gate.

Examples:

```
# Google Workspace relay (the Workspace admin must allow the relay; a Workspace
# user + app password)
EMAIL_TRANSPORT=smtp SMTP_HOST=smtp-relay.gmail.com SMTP_PORT=587 SMTP_STARTTLS=true
SMTP_USERNAME=reep@bgscet.ac.in SMTP_PASSWORD=<app password>
EMAIL_FROM="REEP <no-reply@bgscet.ac.in>"

# Local Mailpit / MailHog (no username, so the TLS refusal does not fire)
EMAIL_TRANSPORT=smtp SMTP_HOST=localhost SMTP_PORT=1025 SMTP_STARTTLS=false
```

---

## SES on AWS (`infra/aws/email.tf`)

Everything is conditional on `var.mail_from_domain != ""` — an infrastructure
fact (an identity exists), never an application setting. Blank = none of it,
`EMAIL_TRANSPORT=""` on the task, the door shut. DNS is not managed by the
stack: the DKIM CNAMEs are surfaced through `terraform output
dns_records_to_create` for a human to add, grey-cloud.

- **`aws_sesv2_email_identity.mail`** — a **domain** identity with Easy DKIM
  (`RSA_2048_BIT`; SES holds and rotates the key). A domain, not an address,
  because inside the sandbox a verified domain makes every recipient on it
  deliverable — that is what lets a pilot on the roster domain run before
  production access. `terraform output ses_identity` answers whether the CNAMEs
  have landed (`verified`, `dkim`).
- **`aws_sesv2_configuration_set.mail`** with reputation metrics, and an
  **event destination** sending `BOUNCE`, `COMPLAINT` and `REJECT` to the
  existing `reep-alerts` SNS topic. A bounce is the one delivery failure neither
  `mail_logs` nor the log tripwire can see: SES accepted the message, the API
  wrote `SENT`, and the student still got nothing.
- **`aws_iam_role_policy.api_ses`** on the api task role: `ses:SendEmail` only,
  on **this** identity ARN and **this** configuration set ARN, with a
  `ses:FromAddress` condition pinned to the bare address out of
  `mail_from_address`. No `SendRawEmail` (the client sends Simple content), no
  identity management, no account-level calls. A compromised task can send a
  plain-text message from `no-reply@` and nothing else. The apply refuses at
  plan time if the address is not under the domain — the alternative is a grant
  SES refuses, surfacing as an ERROR line behind a 202 in front of a student.
- **`ecs.tf`** passes `LOCAL_AUTH_ENABLED`, `EMAIL_TRANSPORT` (`ses` iff the
  identity exists), `EMAIL_FROM`, `EMAIL_REPLY_TO`, `SES_REGION` (`var.region`,
  named explicitly — SES is served in ap-south-1) and `SES_CONFIGURATION_SET`.
  **`api_secrets`, `secrets.tf`, `external_secret_arn` and the operator-owned
  secret's JSON are untouched** — there is no key to store.
- **`observability.tf`**: the metric filter `"auth-otp send failed"` →
  `REEP/Auth` / `OtpSendFailures` and the alarm `reep-auth-otp-send-failures`
  (sum ≥ 1 in 5 min → the alerts topic), the dropped-turns shape verbatim. The
  read-only `reep-claude-observer` role gains `ses:GetAccount`,
  `ses:GetEmailIdentity`, `ses:ListEmailIdentities`, `ses:GetConfigurationSet`.
- Not changed: `security.tf` (the api SG's egress is open; tasks reach
  `email.ap-south-1.amazonaws.com` through the NAT), `github_oidc.tf` (the
  deploy role cannot create IAM or SES — a human `terraform apply` is the only
  path), `versions.tf`, `secrets.tf`. The retention scheduled task and the
  deploy one-offs share the task definition and therefore the env and the
  grant; both are inert for them.

### The sandbox, and the two sending-domain choices

Every new AWS account is **sandboxed** per region: SES sends only to recipients
that are themselves verified identities, at most 200 messages a day and 1 a
second. **A verified domain identity counts for every address on it.** Hence
the two choices for `mail_from_domain`:

| choice | sandbox consequence | cost |
|---|---|---|
| the **roster domain** (`bgscet.ac.in`), From `REEP <no-reply@bgscet.ac.in>` | every `@bgscet.ac.in` recipient is deliverable **before** production access — a cohort pilot can run; only the 200/day and 1/s caps bite | three DKIM CNAMEs in the college's zone — someone else's time |
| the **app's own subdomain** (`reep.bgscet.ac.in`), From `no-reply@reep.bgscet.ac.in` | DNS stays in the operator's hands; **every student is undeliverable until production access is granted** | the production-access request, ~24 h |

Either way the college's root-domain SPF and DMARC are never edited: Easy DKIM
aligns on the From domain under DMARC's default relaxed alignment. Custom MAIL
FROM (SPF alignment) is deliberately not added — see *Not built*.

Production access (required for a non-roster sender, more than 200 codes a day,
or bursts above 1/s): console → Amazon SES → Account dashboard → *Request
production access*, or

```bash
aws sesv2 put-account-details --production-access-enabled \
  --mail-type TRANSACTIONAL --website-url https://reep.bgscet.ac.in \
  --use-case-description "One-time sign-in codes for a college placement dashboard; recipients are enrolled students and staff on bgscet.ac.in; ~50/day; bounces and complaints go to an SNS topic and addresses are removed from the roster by the placement office" \
  --additional-contact-email-addresses ops@… --contact-language EN \
  --region ap-south-1
```

Check with `aws sesv2 get-account --region ap-south-1 --query
'{prod:ProductionAccessEnabled,quota:SendQuota}'`.

---

## Operator steps

The full AWS sequence with the commands is `docs/aws-deployment.md` §8; this is
the order and the reasons.

0. **Do not set `LOCAL_AUTH_ENABLED` (`local_auth_enabled`) in production
   before step 6.** Everything before it can be done while students still see
   Google only. The API answers 202 whatever the transport does, so a door
   opened early tells every student a code is on its way and delivers none.
1. **Choose the sending domain**, consciously, from the table above. Prove it
   with one real send (step 7) before rollout day.
2. **`terraform apply -var-file=prod.tfvars`** with the `mail_*` variables set.
   Identity, configuration set, events, grant, new task revision. The
   operator-owned secret is not touched — do not re-put it.
3. **Add the three DKIM CNAMEs** from `terraform output dns_records_to_create`,
   DNS-only (grey cloud), then poll `terraform refresh && terraform output
   ses_identity` until `verified = true` (minutes to an hour, up to 72 h).
4. **Know whether you are sandboxed** (`aws sesv2 get-account`). If the sender
   is not the roster domain, verify your own address for the test
   (`aws sesv2 create-email-identity --email-identity you@bgscet.ac.in`).
5. **Request production access** if you need it (see above); confirm
   `ProductionAccessEnabled: true`.
6. **Turn the door on** — code and the `auth_email_otps` migration deployed
   first (the Deploy workflow runs `alembic upgrade head` as a one-off task),
   then `local_auth_enabled = "true"`, apply, and a forced new deployment so
   every task carries the flag. Run `python -m app.seed_roster --rekey-domain`
   **before** this if the email convention was ever in doubt — a row that has
   set a password is no longer movable.
7. **Verify**: `GET /api/auth/sso/status` → `password_login_available: true`,
   `password_setup_available: true`, `password_reason: null`; `/ready` →
   `email.transport: ses`, `configured: true`, `local_auth: true`. Then *Create
   your password* end to end with your own roster address: the code arrives
   with `DKIM=pass` (Gmail → *Show original*), the password signs you in,
   `select status, error, sent_at from mail_logs where kind='auth-otp' order by sent_at desc limit 5;`
   shows `SENT`, and a second browser holding your old session now answers 401
   on `/api/auth/me`. Sign in with Google on the same account to confirm both
   doors mint a working session, and use the shell's *Change password* link
   once.
8. **Runbook** for *I never got a code*: the table below.
9. **Rollback**: `local_auth_enabled = "false"` + apply (or
   `LOCAL_AUTH_ENABLED=false` in compose). The form renders disabled with the
   reason, `/login` and `/password/*` refuse, passwords already set stay inert
   and work again when the flag returns, Google is unaffected throughout, and
   no sessions are revoked by the flag either way.
10. **Non-AWS hosts** (`docker-compose.prod.yml`): `EMAIL_TRANSPORT=smtp`,
    `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD`, `EMAIL_FROM`,
    `LOCAL_AUTH_ENABLED=true`. Google Workspace relay:
    `SMTP_HOST=smtp-relay.gmail.com SMTP_PORT=587 SMTP_STARTTLS=true` with a
    Workspace user + app password (the Workspace admin must allow the relay).
    `EMAIL_TRANSPORT=log` is refused as ready on every non-dev `ENV` and the
    status probe says why. Local development needs nothing: `ENV=dev` resolves
    a blank transport to `log` and the code prints in the uvicorn console.
11. **Rotating `AUTH_SECRET`** signs everyone out (as today) **and** invalidates
    every outstanding code — the HMAC key derives from it. Quiet hour; expect
    *code not valid* from anyone mid-flow.
12. **Tell students what to expect** — one paragraph for the placement office:

    > Sign in with Google as before, or create a password: on the sign-in page
    > choose *Create your password*, enter your college address, enter the
    > 6-digit code we email you, and choose a password. Codes last 10 minutes;
    > only the newest one works; after five wrong tries request a new one; wait
    > a minute between requests. Setting or changing a password signs you out
    > everywhere else. Staff will never ask you for a code.

    Adoption check:
    `select count(*) filter (where password_hash like 'scrypt:%') as with_password, count(*) as total from users where role='STUDENT';`
13. **PR hygiene**, per `.github/pull_request_template.md`: the PR body must
    state which guard changed — `password_login_allowed` gained the explicit
    `LOCAL_AUTH_ENABLED` + ready-transport arm beside the untouched dev
    allowlist; `production_boot_failures()` unchanged; `security.py` gained
    `UNUSABLE_PASSWORD_HASH` / `has_usable_password`; `identity.py` gained
    `get_optional_session`; `infra/aws` gained a scoped `ses:SendEmail` grant
    conditional on an identity; `secrets.tf`, `outputs.tf`'s
    `external_secret_arn` and the operator-owned secret JSON are **unchanged**.
    `app/config.py` and `.env.example` are CRLF files — check `git diff --stat`.

---

## Troubleshooting

Start with `GET /api/director/mail?kind=auth-otp` (or
`select status, error, sent_at from mail_logs where kind='auth-otp' order by sent_at desc limit 20;`).
It has one row per code the server tried to send, with the transport's error
text and never the code.

| symptom | cause | where to look / what to do |
|---|---|---|
| No code arrived; `mail_logs` has **no row** | the address is not on the roster, not on `ROSTER_EMAIL_DOMAIN`, inside the 60 s cooldown, or the hourly cap (3) was reached | `select email from users where lower(email) = '…'`; a cap hit is a WARNING with the user **id** in the API log / CloudWatch. All four answer 202 by design |
| No code; a **`FAILED`** row with `MessageRejected` | SES sandbox (the recipient is not a verified identity), or the identity's DKIM has not verified yet | `terraform output ses_identity`; `aws sesv2 get-account` for `ProductionAccessEnabled`; `docs/aws-deployment.md` §8 steps 3–5 |
| `FAILED` with `AccessDeniedException` | the grant does not cover the send: `EMAIL_FROM` is not the address `mail_from_address` pinned, or the identity / configuration-set ARN changed | compare `EMAIL_FROM` on the task with `mail_from_address`; re-apply |
| `FAILED` with `Throttling` / a daily-quota message | the sandbox's 200/day or 1/s | request production access |
| `FAILED` with `AccountSendingPausedException` | SES paused the account for reputation (bounces, complaints) | read the bounce/complaint notifications on the alerts topic; fix the roster; ask SES to resume |
| `FAILED` with `smtp: …` | the relay refused: wrong credentials, relay not allowed for this user, TLS mismatch | the Workspace admin's relay settings; `SMTP_STARTTLS` / port 465; `password_reason` if `email_ready` refused it outright |
| A **`SENT`** row and still no mail | the college's Google Workspace spam quarantine, or the DKIM CNAMEs are wrong/proxied | admin console → Apps → Gmail → Spam; *Show original* on a delivered copy should say `DKIM=pass`; the CNAMEs must be grey-cloud |
| The `reep-auth-otp-send-failures` alarm fired | one or more of the `FAILED` rows above | the ERROR line `auth-otp send failed for otp <id>: <error>` in `/reep/api` names the cause |
| *That code is not valid or has expired* | wrong code, an older code (only the newest works), more than 10 minutes, five wrong tries, already used, or the address is not on the roster / domain (the 400 is the same for all of them, by design) | request a new code; if it persists, `select * from auth_email_otps where user_id = '…' order by created_at desc limit 3;` |
| *Choose a password of at least 10 characters* / *cannot be your email address* (422) | `validate_new_password` | checked before the code, so no attempt was spent |
| `403` on `POST /api/auth/login` — *Password sign-in is not available on this server* | `password_login_allowed` is false: not a dev `ENV`, and `LOCAL_AUTH_ENABLED` is unset or the transport is not ready | `GET /api/auth/sso/status` → `password_reason`; the API's WARNING names `ENV` and the reason |
| `401` on `POST /api/auth/login` with a password you are sure of | the row's `password_hash` is still the sentinel (never set), the address is off-domain, or the lookup missed | `select password_hash like 'scrypt:%' from users where lower(email) = '…'`; use *Forgot your password?* |
| `429` on `/login` | 40 failures / 10 min from this IP, or 10 failures / 15 min on this address | wait out `Retry-After`, or reset with an emailed code — the self-service escape |
| `503` on `/password/otp` or `/password/set` | `local_auth_ready` is false | the `detail` is `local_auth_unready_reason` and names the variable — `LOCAL_AUTH_ENABLED`, `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SES_REGION`, `SMTP_HOST`, or the TLS refusal |
| `403` on `/password/*` — *You are signed in as a different address* | a `reep_session` cookie is present and its email is not the submitted one (two roster accounts in one browser) | sign out first, or use the address you signed in with. Rare and honest; not a bug |
| The password form renders disabled with a reason | the probe said `password_login_available: false` (or only `password_setup_available: false`, which hides the links) | the reason under the form is `password_reason`; fix the variable it names |
| Everyone signed out at once | `AUTH_SECRET` rotated or differs between replicas — this also killed every outstanding code | as before; identical everywhere and stable |
| One student signed out of every other device | they set, reset or changed their password — `token_version` bumped. Intended, and the screen says so | nothing |
| Sign-in codes visible in CloudWatch / the API log | `EMAIL_TRANSPORT=log` on a dev-named `ENV` — the door refuses to open with it on any other | never on a shared host; set `ses` or `smtp` |
| `otp_rows_deleted` / `otp_mail_logs_deleted` missing from the retention summary | `retention.purge_expired` is not calling `local_auth.purge_stale` | the retention job's log |

---

## What this feature does not do, on purpose

- **No magic links, no HTML mail.** A plain-text 6-digit code, entered on the
  page that asked for it. A link in a code email is the shape of phishing, and a
  link is a bearer.
- **No SMS or alternate-address recovery.** It would widen the trust root
  beyond the college mailbox — which is the same root Google already relies on.
  What a successful attacker of that mailbox gains here is a password reset,
  exactly what they already gain through Google; this is stated so nobody later
  "hardens" it into an SMS system.
- **No breach-list check and no MFA on the password door.**
- **No custom MAIL FROM** (`aws_sesv2_email_identity_mail_from_attributes`,
  an MX and a TXT in the college zone). DKIM alignment alone satisfies DMARC;
  this is the first follow-up if Workspace quarantines the mail.
- **No OTP on every login.** `POST /api/auth/login/otp` and a
  `LOCAL_AUTH_OTP_ON_LOGIN` flag are designed (the `purpose='login'`
  reservation exists for them) and **not built**: it doubles SES volume and
  puts the transport on the login critical path. Do not ship it until the
  password path has held up in front of students, and add the endpoint and the
  setting together or not at all.
- **No self-provisioning, no role change, no `google_sub` change.** `/set`
  writes `password_hash` and `token_version` on an existing row and nothing
  else. Rule 1 is untouched (nothing here calls a model; the only egress is the
  code to the student's own address); rule 2 is untouched.

## Risks worth knowing

- The `google-only` sentinel is load-bearing for `seed_roster --rekey-domain`: a
  row that has set a password is no longer recognised as the seed's and is not
  moved if the email-domain guess turns out wrong later. Deliberate — a claimed
  row must not be silently renamed — but it narrows the escape hatch; rekey
  before turning the door on, and fix stragglers by hand.
- The hourly cap and the cooldown are also denial-of-service levers: anyone who
  knows a student's address can burn their three codes for the hour. Chosen over
  a per-address lockout on the OTP path because it blocks one user's
  convenience for an hour rather than their login; the WARNING with the user id
  is the trace.
- The SES sandbox is the single most likely "it is broken" report: the API
  answers 202, the student gets nothing, and the witnesses are a log line, a
  `FAILED` row, an alarm and a bounce notification. Mitigated by the order of
  the operator steps and by the alarm, not by code.
- Deliverability into Google Workspace is not guaranteed by DKIM alone; the
  bounce SNS destination and the Workspace quarantine are where to look, and
  custom MAIL FROM is the follow-up.
- Revocation stays best-effort across workers (60 s), the existing limit — not
  worsened, not fixed.
- A developer who copies a dev `.env` (blank transport = `log`) onto a
  "staging" box sees the password door go dark with a 503 naming the reason,
  rather than leaking codes into a log. The intended direction, and a support
  question.
