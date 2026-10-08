# 0007. Student data leaves the machine only through the egress gate

- **Status:** Accepted
- **Date:** recorded 2026-10-08 from `AGENTS.md`
- **Source:** `AGENTS.md`, "1. Student data must not leave the machine unbidden" and "Rule 1 applies to telemetry too"

## Context

Recorded from `AGENTS.md`; no rationale is added here. `LLM_BASE_URL` is a URL,
not a promise: it may point at a free model that trains on submissions, and a
resume brief carries a student's name, USN, marks and attendance.

## Decision

`student_data_egress_allowed(base_url)` in `apps/api-py/app/ai/llm.py` is the
gate: loopback is always allowed; anything else requires
`LLM_ALLOW_REMOTE_STUDENT_DATA=true`. Any path that sends a student's private
records calls the model through `complete_chat(..., carries_student_data=True)`
or `stream_chat(...)`, and is refused before leaving the process unless the gate
permits it; `/student/resume/generate` then composes deterministically and says
so (`used_ai=false`). Telemetry is held to the same rule: Sentry is initialised
once per process through `init_sentry` with PII flags off and every payload
scrubbed by `app/telemetry_scrub.py`.

## Alternatives considered

- None recorded in `AGENTS.md`.

## Consequences

- A new student-PII-to-model path must route through the gate.
- `carries_student_data` defaults to `False`, so a forgotten keyword is silent;
  the "Rule 1 (every model call declares its cargo)" CI job requires every call
  to state it explicitly, and the PR template asks.
- Enforced by that CI job, `tests/test_observability.py` and the codebase guards
  that pin Sentry's flags.
