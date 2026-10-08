# 0002. Quality gates are steps in existing CI jobs, plus one standalone required secret scan

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** the quality-gate programme; review by the repository owner

## Context

Four new machine gates were added together: static analysis (ruff, mypy, an
async-blocking guard), a secret scan (gitleaks), a route audit, and a migration
round trip. The natural shape is one CI job per gate.

But REEP's required checks are matched by GitHub **by the job's display name, as
a string**, and `ci.yml`'s five job names are pinned in four files at once —
`ci.yml`, `.github/rulesets/main.json`, `tools/ci/protect-main.sh`'s
`REQUIRED_CHECKS` and `tools/ci/preflight.sh` — compared by
`apps/api-py/tests/test_codebase_guards.py` §34. `AGENTS.md` records why that
comparison exists: the ruleset asked for "Voice worker (dependency completeness)"
for months after that job was deleted, which would have blocked every pull
request on a check that can never report. Each new job is four edits and one more
name that can drift.

## Decision

- **Static analysis** and the **migration round trip** are steps in the existing
  **API (FastAPI + Postgres)** job ("Static analysis (ruff, mypy, async
  blocking)" and "Migrations roll back (downgrade to the floor, then up
  again)"). They need the same Python, dependencies and database that job
  already has.
- The **route audit** is a pytest module (`apps/api-py/tests/test_route_audit.py`)
  and runs inside that job's existing test step. It edits no workflow.
- The **secret scan** is its own workflow, `.github/workflows/secret-scan.yml`,
  whose check **Secrets (gitleaks)** is added to the required checks — the one
  exception, and the precedent is `branch-policy.yml`'s "Branch policy
  (promotion path)".

## Alternatives considered

- **One job per gate.** Four more names in four files each, and a failure in one
  would not stop the others running — which is the point of separate jobs, and
  not worth sixteen edits and §34's comparison growing by four.
- **The secret scan as a step in the API job too.** It would run only when the
  API job runs and inherit its failure modes; a secret in `infra/` or
  `apps/web/` is as leaked as one in `apps/api-py/`. A secret scan must also
  run on every push regardless of paths, and before the slow jobs, so it is the
  one gate that earns its own workflow.

## Consequences

- `ci.yml` still has exactly five jobs, and §34 does not change.
- The API job is slower and its log is longer; a static-analysis failure shows as
  "API (FastAPI + Postgres)" failing, and the step name says which gate.
- The required-check list on `main` grows by one name ("Secrets (gitleaks)"),
  which must be added to the ruleset in the same change that adds the workflow.
- Enforced by `test_codebase_guards.py` §34 for the five job names; the secret
  scan's place in the ruleset is enforced by review.
