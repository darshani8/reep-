# Handoff: email + password sign-in (with OTP) — resume point

Written so a fresh session can continue without the conversation. Update at every
milestone. Delete when the feature is merged.

## Where everything stands (2026-09-02 06:15 UTC)

### Nova 2 Sonic interviewer — ALL code/infra done, ONE unknown left
- PR #11 merged → `main` = `97b1b37`. Deploy #35 (18:31 UTC 09-01) shipped it.
- Transport bug fixed (`awscrt` + `transport=AWSCRTHTTPClient()`), verified against real Bedrock.
- Terraform applied: IAM `bedrock:InvokeModelWithBidirectionalStream`, `INTERVIEW_ENGINE=nova`,
  `NOVA_SONIC_REGION=ap-northeast-1`, `INTERVIEW_CONSENT_VERSION=2026-09`.
- **Unknown:** whether Bedrock model access for `amazon.nova-2-sonic-v1:0` is granted in
  `ap-northeast-1`. Nobody has pressed Start yet (no `POST /api/interview/consent`, no
  `WebSocket /api/interview` in `/reep/api` logs). When they do, search the log for
  `Could not open the Nova Sonic stream` — `AccessDeniedException` = model access missing.
- CloudWatch Logs `/reep/api` (ap-south-1) IS readable with this session's `reep-operator` creds.
  Everything else (ECS/IAM/S3/Bedrock/RDS) is denied. No terraform runs from here.

### Production outage on 09-01 — fixed
- Cause: `alb_origin_domain` was set to the PUBLIC hostname (`reep.sast-skills.com`, a CNAME to
  CloudFront `d3vofjzru0es1c.cloudfront.net`) → `/api/*` looped → 403 at the edge.
- Fix applied by the owner: `alb_origin_domain=origin.reep.sast-skills.com` (CNAME → ALB
  `reep-alb-916119662.ap-south-1.elb.amazonaws.com`, ACM cert in ap-south-1 covers exactly it).
- Guard added on this branch (`71efecf`): `cdn.tf` preconditions refuse origin==domain_name /
  `*.cloudfront.net`, and domain_name without a us-east-1 cert.

### Still pending on the OWNER (not code)
1. **`reep.sast-skills.com` is not an alias on the distribution** (CloudFront 403s that Host;
   default `*.cloudfront.net` cert). Needs a **us-east-1** ACM cert + `-var domain_name=…
   -var cloudfront_acm_certificate_arn=…`. Until then the site only works at the cloudfront.net URL.
2. Google OAuth: `https://d3vofjzru0es1c.cloudfront.net/api/auth/sso/google/callback` was added
   and login WORKS at the cloudfront URL (log shows callback→session at 01:16:56Z). After (1),
   also register `https://reep.sast-skills.com/api/auth/sso/google/callback` BEFORE applying,
   because `WEB_ORIGIN` flips and the redirect URI with it (flow cookie is host-only).
3. Press Start on an interview and read the log line above.

### Git
- Designated branch: `claude/nova-sonic-ai-interview-jm7jrb`, based on `main@97b1b37`.
- Unmerged on it: `b810967` (consent-bump tidy + code default 2026-09), `71efecf` (cdn guard).
- Commit style: `type: lowercase phrase` + 4-beat body. Preserve per-file CRLF/LF
  (`auth.py`, `google_auth.py`, `config.py`, `cdn.tf` are LF; `docs/interview-assistant.md` is CRLF —
  always check with `file`). Never global renormalise.
- Attribution footer for commits (current instruction):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` +
  `Claude-Session: https://claude.ai/code/session_013dtNk5E9WrDBM9vruvuJAe`
- Do NOT open a PR unless asked. Local Postgres for tests:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/reep-pg/data -o '-p 5433 -k /var/tmp/reep-pg/run' -l /var/tmp/reep-pg/pg.log start"`
  then `cd apps/api-py && .venv/bin/python -m pytest -q`. Terraform 1.9.8 binary at
  `/tmp/claude-0/-home-user-reep-/7063be7f-4c8e-5e52-9cdb-d5aefd109aa7/scratchpad/terraform`
  (re-download from releases.hashicorp.com if the scratchpad is gone).

## THE FEATURE — decisions are FINAL (owner confirmed)

Email + password sign-in for pre-enrolled college accounts, beside Google, with OTP by email.

1. Login screen has TWO separate paths: "Sign in with Google" (unchanged) and "Email & password".
2. Password path ONLY for emails already in `users` (roster / grant_access) AND with domain ==
   `settings.college_email_domain` (bgscet.ac.in). No registration, ever.
3. **OTP by email is required for: create password (first time), forgot password, AND change
   password while logged in.** All three are the same 3-step flow (email → code → new password)
   and share one screen + one endpoint set; "change password" is a link inside the app.
4. **Normal sign-in = email + password, NO code** (owner chose "Option A" explicitly).
   An OTP-on-every-login switch may exist but defaults OFF.
5. No email sender exists today. Add `app/email.py` adapter: transports `ses` (boto3 SESv2, prod),
   `smtp` (stdlib), `log` (dev/CI). Unconfigured in prod ⇒ password path reports UNAVAILABLE via a
   status endpoint (mirror `GET /api/auth/sso/status`) and the form renders disabled. NEVER a boot
   failure.
6. No enumeration: OTP request answers 202 always; code only sent when enrolled + domain ok.
7. Setting a password revokes other sessions (`security.py` token_version + `note_revocation`).
8. Google code path byte-for-byte unchanged. Rules 1 & 2 untouched.
9. Rework `settings.password_login_allowed` (currently dev/CI allowlist that refuses prod) so prod
   serves password login WHEN enabled+configured, without breaking `tests/conftest.py` `login`
   fixture or `test_boot_guard.py`.
10. A deployment that does not configure email keeps working exactly as today.
11. Infra: SES in ap-south-1 (`aws_sesv2_email_identity` + DKIM, task-role `ses:SendEmail` scoped),
    env/secrets via `ecs.tf`/`secrets.tf`/`variables.tf`. Document SES sandbox steps.
12. Docs: AGENTS.md auth section says "Google-only" — must be rewritten; `docs/google-sign-in.md`,
    `.env.example`, `docs/aws-deployment.md`.

## Design workflow (Workflow tool) — partial, resumable
- Run: `wf_277604b9-e41`. Script:
  `/root/.claude/projects/-home-user-reep-/7063be7f-4c8e-5e52-9cdb-d5aefd109aa7/workflows/scripts/password-signin-design-wf_277604b9-e41.js`
- Journal (full agent outputs):
  `/root/.claude/projects/-home-user-reep-/7063be7f-4c8e-5e52-9cdb-d5aefd109aa7/subagents/workflows/wf_277604b9-e41/journal.jsonl`
- DONE (cached): 5 codebase maps (backend-auth, config-guards, frontend-login, infra,
  tests-seeds-docs) + 3 full proposals (security-first, minimal-diff, operator-first).
- FAILED on session limit (now reset): 3 judges + synthesize. Resume with same args →
  8 cached, 4 live. Inject decision #3 (change-password also OTP) + #4 (Option A) into the
  judge/synthesize prompts by editing the script (args must stay byte-identical for cache hits).
- If the journal is gone: re-run the whole script (≈12 agents).

## Implementation plan (after the spec)
- Backend: `app/models/login_otp.py` (+ `models/__init__`), Alembic migration, `app/email.py`,
  config settings + `password_login_ready`/reason, endpoints under `/api/auth/password/*`
  (status, otp, set) + rework of `/login` guard, tests.
- Frontend: login component gets the email/password card + links; new lazy route
  `/login/password` (3-step: email → code → new password); "Change password" link in the shell.
- Infra: SES identity, IAM, env vars (`EMAIL_TRANSPORT`, `EMAIL_FROM`, `PASSWORD_LOGIN_ENABLED`),
  operator steps incl. sandbox.
- Verify: pytest (live PG), `tools/ci/check_api_imports.py`, `ng build`, `terraform validate`,
  then adversarial review workflow (security / correctness / repo-rules lenses) → fix → re-verify.
- Commit on the designated branch; push; do not open a PR unless asked.

## Milestone log
- 06:15 UTC — handoff written; resuming design workflow.
- 06:40 UTC — design workflow complete (12/12). Final spec saved at `.claude/password-signin-spec.md`
  (security-first proposal won 145 vs 65, all three judges). Flag name is `LOCAL_AUTH_ENABLED`.
- 07:05 UTC — BACKEND written by hand (uncommitted): app/email.py, app/local_auth.py,
  app/routers/local_auth.py, app/models/auth_otp.py (+__init__), migration a7e1c9d4f2b8
  (head, applied locally), config.py (CRLF preserved; new fields + properties +
  password_login_allowed rework), security.py (UNUSABLE_PASSWORD_HASH/has_usable_password),
  identity.py (get_optional_session), ratelimit.py (FixedWindow), registration.py (uses it),
  main.py (mount + INFO line), health.py, retention.py, seed_roster/grant_access (sentinel import),
  .env.example (CRLF), auth.py (login rework + SsoStatus fields). Tests: test_email,
  test_ratelimit_windows, test_local_auth_gates, test_local_auth (+ edits to test_sso_contract,
  test_google_callback, test_boot_guard). FULL SUITE: 726 passed, 3 skipped, 0 failed.
- 07:05 UTC — FRONTEND + INFRA/DOCS written by two workflow agents (wf_9a89a8af-81c), uncommitted.
  Frontend self-verified: tsc clean, ng test 13 passed, ng build 173.8 kB initial. Infra: see journal.
- 07:20 UTC — Verified agents' work myself (terraform fmt/validate, tsc, ng test 13, ng build).
  COMMITTED + PUSHED: `925498d` feat(auth) [apps/api-py + apps/web], `233ca3c` infra+docs.
  Branch `claude/nova-sonic-ai-interview-jm7jrb` now carries 5 unmerged commits on main@97b1b37.
- 07:22 UTC — adversarial review workflow running: `wf_68c98659-40f` (4 find lenses → 2 refuters
  per finding). Journal: `.../subagents/workflows/wf_68c98659-40f/journal.jsonl`.
- 11:30 UTC — review workflow was cut by the session limit (2/4 finders ran, 0/12 refuters).
  Judged its 6 findings by hand: FIXED (a) verify_code now SELECT ... FOR UPDATE + atomic
  `attempts = attempts + 1` (cap holds at 5 under 8 concurrent guesses; test pins it);
  (b) issue_code locks the user row so a burst issues ONE code inside the cooldown (test);
  (c) the `auth-otp send failed` line redacts addresses the provider's message may carry (test);
  (d) /password/set survives a failed _record_login and still issues the cookie (test).
  ACCEPTED + documented: /set does 1 vs 2 queries for unknown vs roster addresses (bounded by
  the 20/15-min per-IP window; docs/email-password-sign-in.md). Duplicate finding merged.
  Frontend lens never ran; spot-checked by hand (timer cleanup, FormsModule, name attrs, fail-open).
  FULL SUITE: 731 passed, 3 skipped, 0 failed. Committed + pushed as the `fix:` commit below.
- STATE: feature COMPLETE on the branch. Nothing pending except the owner's decisions
  (merge; SES setup per docs/aws-deployment.md §8; LOCAL_AUTH_ENABLED). No PR opened.
