# 0002. Quality gates are steps in existing CI jobs, plus one standalone required secret scan

- **Status:** Proposed (Accepted on merge)
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
- **The secret scan as a step in the API job too.** That job runs on every pull
  request (`ci.yml` has no path filters), so coverage would not be the problem;
  coupling would. The API job needs a Postgres service, a Python install and the
  whole dependency set before its first step, and a scan that reports red
  because `pip install` broke has not said anything about secrets. The scan
  reads the whole repository — `infra/`, `apps/web/`, workflows — not the API,
  needs only a checkout with history, finishes in seconds in parallel with the
  slow jobs, and runs on pushes to `main`, `stage` and `dev` as well as on pull
  requests. It is the one gate that earns its own workflow.

## Consequences

- `ci.yml` still has exactly five jobs, and §34's comparison of those five names
  across the four files is unchanged.
- The API job is slower and its log is longer; a static-analysis failure shows as
  "API (FastAPI + Postgres)" failing, and the step name says which gate.
- "Secrets (gitleaks)" is required on `main`, `stage` **and** `dev`
  (`.github/rulesets/*.json`), beside "Branch policy (promotion path)" on `main`
  and `stage`.
- **Residual risk, raised with the product owner and not solved:** the scan
  reads its rules from the pull request it is scanning, so a pull request that
  adds a leaked token's fingerprints to `.gitleaksignore` passes its own gate
  (OBS-QG-I01). CODEOWNERS names the two rules files but is **not enforced** —
  the rulesets set `require_code_owner_review: false`, and the only code owner
  is the author of every pull request. It is closed by enforced code-owner
  review with a second maintainer owning those files; a detector in CI was
  considered and not built.
- §34 grows a second half for the standalone checks:
  `STANDALONE_REQUIRED_CHECKS` names each one and the workflow that reports it,
  and `STANDALONE_CHECKS_BY_BRANCH` says which branch's ruleset requires which.
- Enforced by test, both halves: `test_codebase_guards.py` §34 fails if a
  required check's name, the workflow reporting it, `protect-main.sh` or any
  branch's ruleset disagree.
