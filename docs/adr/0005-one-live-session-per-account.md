# 0005. One live session per account; the newest sign-in wins

- **Status:** Accepted
- **Date:** 2026-09-10 (recorded 2026-10-08)
- **Source:** `AGENTS.md`, "ONE DEVICE AT A TIME (2026-09-10)"

## Context

Recorded from `AGENTS.md`; no rationale is added here. A REEP account previously
could hold any number of live sessions.

## Decision

Every sign-in door — password, emailed code, Google and the activation link —
advances `users.token_version` before the token is minted, and `app/security.py`
refuses a token whose version is behind the row. Signing in on a second device
drops the first on its next request. A 401 for a retired cookie carries
`X-Reep-Session: retired` so the login screen can say why
(`/login?signedOut=elsewhere`).

## Alternatives considered

- **Refuse the new device instead.** Rejected in `AGENTS.md`: it would lock out a
  student whose browser crashed until a row aged out, and would need a sessions
  table, an eviction policy and a device list this design does not have.

## Consequences

- Being signed out is routine, so the server says why.
- Exclusivity fails open if the commit that persists the bump fails;
  authentication never does.
- Test suites that sign in as a seeded account sign out any other session of that
  account — the reason the Playwright suite runs one worker and never beside
  pytest.
- Enforced by `apps/api-py/tests/test_single_device_session.py`.
