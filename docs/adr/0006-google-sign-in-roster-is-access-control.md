# 0006. Google sign-in for every role, with the roster as the access control

- **Status:** Accepted (amended 2026-09-10 to admit passwords issued by an operator; see Consequences)
- **Date:** recorded 2026-10-08 from `AGENTS.md`
- **Source:** `AGENTS.md`, "Auth — Google-only sign-in over the session retained from the migration"

## Context

Recorded from `AGENTS.md`; no rationale is added here.

## Decision

Sign-in is Google for every role. `app/google_auth.py` verifies the Google ID
token fully (RS256 against Google's JWKS, `aud`, `iss`, expiry,
`email_verified`, a single-use `state` cookie and a `nonce`) and then looks the
verified email up in `users`. **A Google account with no matching row is
refused**; nothing self-provisions and no role is ever guessed. Accounts come
from the roster (`python -m app.seed_roster`), from approving a registration,
from the Main Admin's "Add faculty member" (`POST /api/admin/faculty`), or from
`python -m app.grant_access`. What Google issues is the same session cookie
as every other door, so the `require_*` gates cannot tell the doors apart.

## Alternatives considered

- **Self-provisioning on first Google sign-in.** Rejected: the roster IS the
  access control, and a public identity provider must not decide who is a
  student.

## Consequences

- An address that is not on the roster cannot get in, whatever Google says.
- The password door is derived, not toggled: open in dev/CI, open where an
  operator has issued a real `scrypt:` hash, closed otherwise
  (`password_door_open`, `app/routers/auth.py`). Students also hold passwords
  since 2026-09-10 through the onboarding walk. Google sign-in is unchanged by
  either.
- Enforced by `apps/api-py/tests/test_google_callback.py`,
  `test_sso_contract.py`, `test_password_login_in_production.py` and
  `test_passwords.py`, and by `password_login_allowed` being an allowlist.
