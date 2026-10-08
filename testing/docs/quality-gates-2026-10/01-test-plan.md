# 01 — Test Plan: Quality Gates release (QG-2026-10)

| Field | Value |
|---|---|
| Document ID | REEP-TP-QG-2026-10 |
| Version | 1.0 (baseline for execution) |
| Status | Approved for execution by the Test Manager; awaiting the product owner's sign-off in the Test Completion Report |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 §7 *Test Plan*; ISO/IEC/IEEE 29119-2:2021 test processes; ISTQB® CTFL v4.0 terminology |
| Parent documents | [REEP Test Strategy](../01-test-strategy.md) (project level, still in force) |
| Change under test | Pull request [darshani8/reep-#132](https://github.com/darshani8/reep-/pull/132), branch `claude/clever-meitner-ndvc2e` → `dev` |
| Prepared | 2026-10-08, by the orchestrating session (Test Manager role) for bdarshan5@bgscet.ac.in |

### Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-08 | Draft written while the development fix rounds were in progress |
| 1.0 | 2026-10-08 | Baseline: the build under test is fixed in §1.3 at the start of execution |

---

## 1. Context

### 1.1 Purpose

This plan governs the **independent verification and validation** of the
quality-gate programme added to REEP by PR #132. That change makes five review
concerns machine-checked on every pull request:

| # | Concern | Gate under test |
|---|---|---|
| G1 | Types, unsafe code, blocking calls in `async def` | ruff + mypy + `tools/ci/check_async_blocking.py`, as the `api` job step "Static analysis (ruff, mypy, async blocking)" |
| G2 | Secrets in code | gitleaks 8.30.0, as the standalone required check "Secrets (gitleaks)" (`.github/workflows/secret-scan.yml`) |
| G3 | Auth on every route, response model, status codes, pagination | `apps/api-py/tests/test_route_audit.py` + `tests/route_audit_exceptions.py` |
| G4 | Migration works and can roll back | `tools/ci/check_migration_roundtrip.py` + `tests/test_migration_reversibility.py` + `migrations/reversibility.py`, as the `api` job step "Migrations roll back (downgrade to the floor, then up again)" |
| G5 | Design, naming, "is this the right approach" | the human gate: `.github/pull_request_template.md` sections "Design and approach" and "Engineering checklist" |

and integrates them into the local runner (`tools/ci/preflight.sh`, six checks),
the required-check contract (§34 of `tests/test_codebase_guards.py`, the
rulesets, `tools/ci/protect-main.sh`), and the documentation
(`docs/engineering/`, `docs/adr/`, `AGENTS.md`, `CONTRIBUTING.md`, the `ship`
and `steward` skills).

### 1.2 Why independent testing

The change was built by three development sessions (A, B, C) and each branch
was already reviewed adversarially once. This cycle is executed by **three
different tester sessions that wrote none of the code** — the ISTQB principle
that independence finds the defects authors are blind to. Testers report
defects; they do not fix them. Fixes go back to development and are re-tested
(§8).

### 1.3 Test items and build identification

| Item | Location | Version |
|---|---|---|
| Integration branch | `claude/clever-meitner-ndvc2e` | the head sha recorded by each tester at the start of execution, and in the Test Completion Report |
| Base for comparison | `main` / `dev` | `15a9e7d` |
| Python | CI 3.14; test bed 3.13 (deviation, §5) | — |
| PostgreSQL | CI pgvector pg17; test bed 16 + pgvector 0.6 (deviation, §5) | — |

### 1.4 Stakeholders

| Role | Who | Responsibility in this cycle |
|---|---|---|
| Product owner / approver | Repository owner (bdarshan5@bgscet.ac.in) | Accepts residual risk; signs the completion report |
| Test Manager | Orchestrating session | Plan, entry/exit decisions, defect triage, completion report |
| Test Engineer — Unit | Tester session U | §3 level L1 |
| Test Engineer — Integration | Tester session I | §3 level L2 |
| Test Engineer — System | Tester session S | §3 level L3 |
| Developers | Development sessions A, B, C | Fix defects routed to them |

---

## 2. Test basis: the requirements under test

Every test case traces to one of these. IDs are stable; the traceability
matrix ([05](05-traceability-matrix.md)) is built from them.

### G1 — Static analysis

| ID | Requirement |
|---|---|
| REQ-G1-01 | ruff selects rules explicitly (F, E9, the selected B rules, S, ASYNC, RUF100) from `apps/api-py/pyproject.toml`, never ruff's defaults, and exits non-zero on a violation of each selected family |
| REQ-G1-02 | An exception to a ruff rule in `app/` is a line-level `# noqa: <code>` with a reason; a stale `noqa` is itself a finding (RUF100) |
| REQ-G1-03 | `mypy` (no arguments, from `apps/api-py`) checks `app/` for Python 3.14 with `check_untyped_defs`, `warn_unused_ignores`, `warn_redundant_casts`, and exits non-zero on a type error |
| REQ-G1-04 | `check_async_blocking.py` flags an `async def` that holds a sync DB session (inline `Annotated`, an Annotated alias, a default `Depends(get_db)`, keyword form) or makes a blocking call not handed to a thread; it does not flag genuinely async code |
| REQ-G1-05 | The async guard's `KNOWN` baseline ratchets both ways: a new offender fails; a fixed or changed known offender fails until the list is updated |
| REQ-G1-06 | The three tools run as one `api`-job step immediately after "Install dependencies", with the CI command `python -m ruff check --config pyproject.toml . ../../tools/ci` |
| REQ-G1-07 | ruff, mypy and stubs are pinned `==` in `requirements-dev.txt` only; `requirements.txt` (the production image) is unchanged |

### G2 — Secrets

| ID | Requirement |
|---|---|
| REQ-G2-01 | "Secrets (gitleaks)" installs gitleaks at the pinned version, verified against the pinned sha256, and fails if verification fails |
| REQ-G2-02 | On a pull request it scans exactly the PR's commits **and** the checked-out tree; on a push, every reachable commit and the tree |
| REQ-G2-03 | It fails on any finding, including a secret added in one commit and removed in a later one |
| REQ-G2-04 | It fails closed: a scan that could not run (unresolvable range, scanner error) is a failure, never a pass |
| REQ-G2-05 | Allowlisting is by value or fingerprint, narrow, with a reason; a real secret on the same line as an allowlisted dev value is still caught |
| REQ-G2-06 | Secret values never appear in logs or artifacts (`--redact`); the log says where the finding is |
| REQ-G2-07 | The check is required in `.github/rulesets/{main,stage,dev}.json` and `protect-main.sh`; §34 fails if the job is renamed or the check is dropped from a ruleset |
| REQ-G2-08 | The repository's full history is clean under the shipped configuration |

### G3 — Route audit

| ID | Requirement |
|---|---|
| REQ-G3-01 | The audit enumerates every HTTP operation and WebSocket of the assembled app, cross-checked independently, and fails if the walk is broken (floor of 300 operations) |
| REQ-G3-02 | AUTH: every operation has a session in its dependency tree or a `PUBLIC` entry with a reason |
| REQ-G3-03 | GATE: every authenticated handler reaches a role/scope gate that can refuse, or a `KNOWN_UNGATED` entry with a reason; a comparison that refuses nothing, or a gate in dead code, does not count |
| REQ-G3-04 | RESPONSE MODEL: every JSON operation declares a Pydantic response model; `dict`/`Any` leaves do not count; no operation returns an ORM model |
| REQ-G3-05 | STATUS: 204 carries no body; DELETE is 204 or returns a model; a create answers 201 — or a `KNOWN_STATUS` entry |
| REQ-G3-06 | PAGINATION: an unbounded list accepts a bounded page size, or a `BOUNDED`/`KNOWN_UNPAGINATED` entry naming the cap or the gap |
| REQ-G3-07 | Every exception list ratchets both ways ("new violation" and "strike it off"), and an entry cannot be inherited by a different handler at the same path |
| REQ-G3-08 | The audit needs no database and does not depend on test order |
| REQ-G3-09 | The audit changes no route: the OpenAPI document of the branch equals the base's |

### G4 — Migration roll-back

| ID | Requirement |
|---|---|
| REQ-G4-01 | Every revision has a downgrade that does real work, or an `IRREVERSIBLE` entry with its reason; the static test ratchets both ways and asserts exactly one head |
| REQ-G4-02 | The round trip downgrades to the declared floor(s) and upgrades again, and fails unless the schema catalogue matches and `alembic check` is clean |
| REQ-G4-03 | A downgrade that is missing, incomplete, leaves residue or restores the wrong thing is caught |
| REQ-G4-04 | The script refuses a non-dev `ENV`, a non-loopback host (including via `?host=`/`?hostaddr=`), and a production-named database |
| REQ-G4-05 | In CI it runs right after `alembic upgrade head` and before the seed, so the whole suite runs on the round-tripped schema |
| REQ-G4-06 | Locally (`preflight.sh`) it runs on a scratch database it creates and drops, never on the developer's data |

### G5 — Human gate and documentation

| ID | Requirement |
|---|---|
| REQ-G5-01 | The PR template keeps every pre-existing section and adds "Design and approach (human review)" and "Engineering checklist" |
| REQ-G5-02 | Each checklist item names the gate that enforces it, or says *human — no gate*; no item claims a machine check that does not exist |
| REQ-G5-03 | `docs/engineering/*.md` and `docs/adr/*.md` are factually consistent with the code that shipped; every relative link resolves |

### GX — Cross-cutting

| ID | Requirement |
|---|---|
| REQ-GX-01 | `ci.yml` keeps exactly its five jobs; all four files §34 compares agree, plus the declared standalone checks |
| REQ-GX-02 | `preflight.sh` runs six checks in fail-fastest order with exit codes 0 = all passed, 1 = a failure, 2 = something did not run; each new gate SKIPs honestly when its tool is absent |
| REQ-GX-03 | **No product behaviour changes** beyond the three intended fixes (interview rehearsal cancellation, the time-ledger boot check, the local-engine connect timeout): the full backend suite, the web unit suite and the production build are green; the API contract is unchanged |
| REQ-GX-04 | The deployed-style stack (API + SPA) works end to end for each role on the branch |

---

## 3. Scope and test levels

| Level | ID | Test object | Question it answers | Executed by |
|---|---|---|---|---|
| Unit (component) | L1 | Each gate's component in isolation: ruff/mypy configuration, the async guard's functions, the route-audit rules, the reversibility test and round-trip functions, the gitleaks rules and allowlists, preflight's helper functions | Does each component do what its requirement says on designed inputs, including boundaries and invalid inputs? | Tester session U |
| Integration (component integration) | L2 | The gates wired together and to their environment: the CI `api` job replayed step by step on a fresh database, the secret-scan workflow's script against real git ranges, §34 against the four files, `preflight.sh` end to end, rulesets/protect-main | Do the parts work together, in the right order, with the right exit codes and failure messages? | Tester session I |
| System | L3 | The whole product on the branch: API (uvicorn) + SPA (production build served) on a migrated, round-tripped, seeded database; the existing API suite and e2e smoke; an OpenAPI diff against the base | Does REEP still behave as before for every role, and does the PR as a whole meet REQ-GX-03/04? | Tester session S |

**"Manual" means human-style execution with recorded evidence**, not that
automated suites are banned: a tester designs each case, runs it by hand (one
command or one browser action at a time), compares the actual result with the
expected result, and records the verdict and the evidence file. Existing
automated suites are executed as regression *inputs* to a case and cited, never
counted as cases themselves.

### 3.1 Out of scope (and why)

| Not tested | Reason |
|---|---|
| GitHub ruleset enforcement on the server | The rulesets are committed but an admin has not applied them (`rules/branches/main` returns `[]`); the JSON and §34 are tested instead |
| Performance and load of the product | Unchanged by this PR; the 2026-09-29 cycle's results stand |
| Production / AWS | Never touched from a test bed (AGENTS.md rule 1; the round trip refuses it by design) |
| Python 3.14 runtime | The test bed has 3.13; CI runs 3.14 and its result on the PR head is cited instead |

---

## 4. Test design techniques

| Technique (ISTQB CTFL §4) | Used for |
|---|---|
| Equivalence partitioning | Rule families per gate (each ruff family, each route-audit rule, each secret shape) |
| Boundary value analysis | The 300-operation floor, `le=` page bounds, the rollback floor at head / below head, gitleaks version equal / unequal to the pin |
| Decision tables | preflight's result per check (PASS / FAIL / SKIP / PARTIAL) → exit code |
| State transition | Ratchets: baseline → new violation → fixed → struck off |
| Error guessing / negative testing | Bypass attempts: aliases, dead branches, `?host=`, a secret beside an allowlisted value |
| Regression testing | Full backend suite, web unit suite, `ng build`, the existing API suite, the e2e smoke |
| Comparison testing | OpenAPI document and catalogue dumps, base vs branch |

**Case ID convention:** `UT-G<n>-NNN` (unit), `IT-G<n>-NNN` (integration),
`ST-NNN` (system); defects `DEF-QG-<U|I|S>NN`.

**Mandatory fields per case:** ID, requirement(s), objective, preconditions,
test data, steps, expected result, actual result, verdict (Pass / Fail /
Blocked / Not run), evidence file, executed by, date.

---

## 5. Test environment (test bed)

Each tester session runs in **its own container**, so no two levels share a
database or a session cookie.

| Component | Configuration |
|---|---|
| Host | Cloud container, 4 vCPU, ~15 GB RAM |
| Database | PostgreSQL 16 + pgvector 0.6 on :5433 (project targets 17; schema identical, migrations verified). One database per concurrent run (AGENTS.md) |
| Python | 3.13 venv in `apps/api-py/.venv` from `requirements-dev.txt` (CI: 3.14 — **deviation**, mitigated by citing the PR's CI run) |
| Node | 22.22.3, sha256-verified from nodejs.org (the image's 22.22.0 is below the Angular CLI's minimum) |
| gitleaks | 8.30.0, sha256-verified against the value pinned in `secret-scan.yml` |
| Browser | Pre-installed Chromium (`/opt/pw-browsers`) for the system level |
| Test data | The dev seed (`python -m app.seed`), seeded accounts in AGENTS.md; synthetic **fake** secrets generated per run, never real ones |

---

## 6. Entry, exit, suspension and resumption criteria

**Entry** (all must hold before execution starts):
1. The development fix rounds (A, B, C) are merged into the integration branch and pushed.
2. CI on that head: the five `ci.yml` jobs and "Secrets (gitleaks)" are green (Branch policy green on base `dev`).
3. This plan is baselined (v1.0) and each tester has recorded the head sha.

**Exit** (all must hold to recommend merge):
1. 100 % of planned cases executed (Pass / Fail / Blocked recorded; "Not run" only with a reason the Test Manager accepts).
2. Every requirement in §2 is covered by at least one executed case.
3. No open **Critical** or **Major** defect; every Minor either fixed or accepted in writing as residual risk.
4. Regression: full backend suite, web unit suite and `ng build` green on the final head.
5. The Test Completion Report is written and the product owner's sign-off block is ready.

**Suspension:** stop a level when its environment cannot be brought up (e.g. the
database will not migrate on the branch) — that is a Blocker defect, raised
immediately. **Resumption:** after the fix, re-run the level from its first case.

---

## 7. Deliverables (29119-3 documentation set for this cycle)

| # | Document | File | Owner |
|---|---|---|---|
| 1 | Test Plan | this file | Test Manager |
| 2 | Unit test specification, execution log and defects | [02-unit-testing.md](02-unit-testing.md) | Tester U |
| 3 | Integration test specification, execution log and defects | [03-integration-testing.md](03-integration-testing.md) | Tester I |
| 4 | System test specification, execution log and defects | [04-system-testing.md](04-system-testing.md) | Tester S |
| 5 | Requirements traceability matrix | [05-traceability-matrix.md](05-traceability-matrix.md) | Test Manager |
| 6 | Incident (defect) register | [06-incident-register.md](06-incident-register.md) | Test Manager |
| 7 | Test Completion Report with sign-off | [07-test-completion-report.md](07-test-completion-report.md) | Test Manager |
| — | Evidence (command transcripts, diffs, screenshots) | `testing/results/quality-gates-2026-10/{unit,integration,system}/` | each tester |

---

## 8. Defect management

| Severity | Meaning in this cycle |
|---|---|
| **Critical** | A gate passes something it exists to stop (fails open), leaks a secret, or the product changes behaviour unintentionally |
| **Major** | A significant false negative/positive, a ratchet that does not ratchet, CI or preflight red on a correct tree, or documentation that would mislead someone into a wrong action |
| **Minor** | Inaccurate wording, a cosmetic message, an edge case unlikely in practice |

| Priority | Meaning |
|---|---|
| P1 | Fix before merge |
| P2 | Fix in this PR if cheap, else a tracked follow-up |
| P3 | Follow-up |

**Lifecycle:** New → Triaged (Test Manager) → Assigned (development session) →
Fixed (commit sha) → Re-tested (tester) → Closed, or Deferred with the owner's
written acceptance.

---

## 9. Schedule

| Order | Activity | Entry |
|---|---|---|
| 1 | Fix rounds A/B/C merged, CI green | — |
| 2 | L1, L2 and L3 executed in parallel, one container each | §6 entry |
| 3 | Defect triage; fixes routed to A/B/C; re-test | defects raised |
| 4 | Traceability matrix, incident register, completion report | all levels done |
| 5 | Sign-off by the product owner | report written |

## 10. Risks to the testing itself

| Risk | Mitigation |
|---|---|
| Test bed is Python 3.13 / PG 16 while CI is 3.14 / PG 17 | Cite CI's result on the same head for every gate; flag any version-sensitive case |
| Testers share a GitHub repository and could push conflicting files | Each tester owns exactly one document and one evidence folder (§7) |
| A tester reuses the developers' framing and misses what they missed | Testers get the requirements, not the implementation notes; adversarial cases are mandatory per gate |
| Fake secrets mistaken for real ones by GitHub push protection | Generate them in scratch files outside the repository; never commit them |
