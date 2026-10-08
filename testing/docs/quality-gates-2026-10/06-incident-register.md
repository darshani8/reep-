# 06 — Incident Register: Quality Gates release (QG-2026-10)

| Field | Value |
|---|---|
| Document ID | REEP-IR-QG-2026-10 |
| Version | 0.1 (open: L2 and L3 still executing) |
| Status | Draft, maintained by the Test Manager while the cycle runs |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 §8.6 *Incident Report*, kept as one register for the cycle |
| Parent document | [01 — Test Plan](01-test-plan.md) (REEP-TP-QG-2026-10), §8 defect management |
| Change under test | Pull request [darshani8/reep-#132](https://github.com/darshani8/reep-/pull/132) |
| Maintained by | the orchestrating session (Test Manager role) |

### Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-10-08 | Development-phase incidents recorded; L1 defects triaged and assigned |
| 0.2 | 2026-10-08 | L1 fixes merged (8914e83); L2 defects triaged and assigned; FV-QG-01 raised |

---

## 1. How to read this register

**Two phases, two ID schemes.**

* `INC-QG-D-NN`: incidents found **during development**, before formal test execution began on `a3688f0`. They were found by the new gates themselves, by the adversarial peer review of each worker branch, or by real CI on the integration branch. They are recorded because a register that starts at the first tester's report hides how many defects the build-review loop caught, and how. Every one is closed or deliberately left open; none is pending.
* `DEF-QG-{U,I,S}NN`: defects raised by the **independent testers** at levels L1 (unit), L2 (integration) and L3 (system), against a fixed build. `OBS-QG-{U,I,S}NN` are observations the tester did not claim as defects.

**Severity and priority** use plan §8. Critical means the gate fails open, a secret leaks, or the product changes behaviour unintentionally. Major means a significant false negative or false positive, CI or preflight red on a correct tree, or misleading documentation. Minor means wording, a cosmetic issue, or an unlikely edge case. Priority runs P1 (before merge) to P3 (follow-up). Where the peer reviewer's own label differs from the plan's scale, the plan's scale is used and the reviewer's label is noted.

**Lifecycle:** New → Triaged → Assigned → Fixed (commit) → Re-tested → **Closed**, or **Deferred** with the owner's written acceptance. **Open (by design)** marks a finding that is deliberately recorded rather than changed, because changing it would alter product behaviour outside this PR's scope. Each such item names the decision it waits for.

**Who:** Worker A = `claude/qg-static-analysis` (ruff, mypy, async guard). Worker B = `claude/qg-secrets-and-migrations` (gitleaks, migration round trip). Worker C = `claude/qg-route-audit-and-review` (route audit, PR template, docs). TM = the orchestrating session on `claude/clever-meitner-ndvc2e`.

---

## 2. Summary

| Phase | Found | Critical | Major | Minor | Closed | Open (by design) | Deferred | In progress |
|---|---|---|---|---|---|---|---|---|
| Development (INC-QG-D) | 52 | 2 | 14 | 36 | 46 | 6 | 0 | 0 |
| L1 unit (DEF-QG-U) | 6 | 0 | 3 | 3 | 0 | 0 | 0 | 6 (fixed, awaiting re-test) |
| L2 integration (DEF-QG-I) | 4 | 0 | 2 | 2 | 0 | 0 | 0 | 4 |
| Fix verification (FV-QG) | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| L3 system (DEF-QG-S) | _executing_ | | | | | | | |

"Closed" includes INC-QG-D-16 (accepted as negligible) and INC-QG-D-52 (a false alarm); INC-QG-D-48 is counted as open because two of its three stale documents are follow-ups.

---

## 3. Development-phase incidents (INC-QG-D)

### 3.1 Pre-existing product defects the new gates found in `app/`

These defects were already on `main`. The new static analysis surfaced them in the first run.

| ID | Title | Sev. | Found by | Status | Resolution |
|---|---|---|---|---|---|
| INC-QG-D-01 | `routers/interview.py` `_run_relay`: a `return` inside `finally` swallowed `CancelledError` for a rehearsal interview (B012 / PEP 765) | Major | ruff B012 | Closed | 51c6edb (if-block); pinned at runtime by `TestTheBackstopAtRuntime` in 27adab2 |
| INC-QG-D-02 | `models/time_ledger.py`: the 24-hour slot invariant was an `assert`, stripped by `python -O` | Minor | ruff S101 | Closed | 51c6edb: `raise RuntimeError` |
| INC-QG-D-03 | `interview_local.py`: `httpx` client with `timeout=None`, so a connect could hang for ever | Minor | ruff S113 | Closed | 51c6edb: `httpx.Timeout(None, connect=10.0)`; reads stay unbounded on purpose (a streamed reply) |
| INC-QG-D-04 | `config.py` `interview_ready` falls through to `realtime_ready`, which the retired OpenAI engine took with it: a latent `AttributeError` | Minor | mypy | Closed | 27adab2: returns `False`, with a test |
| INC-QG-D-05 | Three `async def` handlers do blocking database work on the event loop: `admin_imports.preview_import`, `voice_platform/api/admin.bulk_candidates`, `calls.close_call`. This is the /register 504 shape | Major | async guard | **Open (by design)** | Recorded in the guard's `KNOWN` with each reason and the exact findings pinned. Converting a handler changes its concurrency behaviour, so each needs a concurrency test of its own: a follow-up, not this PR |
| INC-QG-D-06 | `mailer.py:90` `deliver_once` can return `None` after an `IntegrityError`, despite its declared type | Minor | mypy | **Open (by design)** | Behaviour unchanged, reason written on the line; follow-up |
| INC-QG-D-07 | `routers/badges.py` `start_badge` / `submit_evidence` answer 500, not 404, when the Student row is gone | Minor | mypy | **Open (by design)** | Behaviour unchanged, reason written on the line; follow-up |
| INC-QG-D-08 | 64 unused imports and one duplicate import in a migration | Minor | ruff F401/F811 | Closed | 51c6edb; the reviewer checked every removal for import-time side effects |

### 3.2 Peer review of Worker A (verdict: needs fixes; no behaviour regression in 108 files)

| ID | Title | Sev. | Status | Resolution |
|---|---|---|---|---|
| INC-QG-D-09 | The async guard missed FastAPI's documented `DbDep = Annotated[Session, Depends(get_db)]`, in all three alias forms (assignment, `TypeAlias`, PEP 695) and across modules | Major | Closed | 33ff53f |
| INC-QG-D-10 | `preflight.sh` and the `ship` skill did not run the new checks | Major | Closed | c6f5e72, 6e56a56 (TM) |
| INC-QG-D-11 | The `KNOWN` ratchet was per function, so a known offender could gain new blocking calls unseen | Minor | Closed | 33ff53f: `Known(reason, findings)` multisets |
| INC-QG-D-12 | Missed call shapes: `Depends(dependency=…)`, an import alias of `get_db`, `db.SessionLocal()`, `SessionLocal as SL` | Minor | Closed | 33ff53f, each with a test |
| INC-QG-D-13 | False positives: a local variable named `requests`; an awaited `anyio.Path(...).read_text()` | Minor | Closed | 33ff53f. The `run_in_threadpool` lambda stays flagged by design, and the docstring now says so |
| INC-QG-D-14 | Code comments pointed at a "qg report" that does not exist | Minor | Closed | 33ff53f: the reason is written inline |
| INC-QG-D-15 | No runtime test for INC-QG-D-01 | Minor | Closed | 27adab2 |
| INC-QG-D-16 | Three removed test variables were implicit key checks | Minor | Closed (accepted) | Reviewer and TM accept: negligible |

### 3.3 Worker B's own triage, and the peer review of Worker B (verdict: needs fixes, 4 major)

| ID | Title | Sev. (reviewer) | Status | Resolution |
|---|---|---|---|---|
| INC-QG-D-17 | 25 gitleaks findings on the tree and the full history before any configuration | Minor | Closed | Triaged one by one: allowlisted by value for one rule, or pinned by fingerprint in `.gitleaksignore` with what each was. **No real secret; nothing to rotate** |
| INC-QG-D-18 | The repository's own `.gitleaks.toml` rules used `\s*`, which crosses newlines, so `GROQ_API_KEY=` read the next line as its value | Minor | Closed | 3db2acb: `[ \t]*` |
| INC-QG-D-19 | The pre-commit hook pinned gitleaks 8.18.4, which ignores `[[allowlists]]` (20 false findings) | Minor | Closed | 3db2acb: v8.30.0, matching the workflow |
| INC-QG-D-20 | `protect-main.sh` never applied the "Branch policy" required check | Minor | Closed | 3db2acb |
| INC-QG-D-21 | **The secret scan failed open**: an unresolvable pull-request range scanned 0 commits and exited 0 | **Critical** (Major) | Closed | 2ea6ca6: both shas proven with `cat-file`, `rev-list` is fatal, and an `ERR` line or "0 commits scanned" fails the step; shown failing in 5 scenarios |
| INC-QG-D-22 | **The global allowlist used `regexTarget = "line"`**, blinding about 4,400 tracked lines; 6 planted leaks passed | **Critical** (Major) | Closed | 2ea6ca6: `regexTarget = "match"`; `tools/ci/check_gitleaks_rules.py` replays 13 leaks that must be found and 6 placeholder files that must stay quiet |
| INC-QG-D-23 | The round trip compared the catalogue only at head, so a downgrade restoring the **wrong default** passed (the re-upgrade overwrote it) | Major | Closed | 7433efd: a segment walk, compared at each segment's bottom and top |
| INC-QG-D-24 | A correctly declared `"raises"` revision at head failed the static reversibility test | Major | Closed | 7433efd |
| INC-QG-D-25 | Only 22 of 92 downgrades were exercised; the claim of full coverage was overstated | Minor | Closed | 7433efd: 90 of 92 run, in 3 segments |
| INC-QG-D-26 | **Defect exposed by INC-QG-D-25:** 18 early downgrades left 27 enum types behind, so a re-upgrade failed with `type "role" already exists` | Major | Closed | 7433efd: `DROP TYPE IF EXISTS` added to those downgrades; no `upgrade()` touched |
| INC-QG-D-27 | AGENTS.md said the suite runs on the round-tripped schema; after the segment walk (INC-QG-D-23) the round trip only reads that database, so the sentence became false | Minor | Closed | 30c0ad9 (TM): the gate section now says the walk runs on a scratch database and leaves the straight-path schema to the seed and the suite |
| INC-QG-D-28 | Missing secret shapes: a YAML value on the next line (`AUTH_SECRET:` ↵ value), name/value pairs, plain `postgresql://` URLs | Minor | Closed | 2ea6ca6, each with a replay case |
| INC-QG-D-29 | The production refusal could be bypassed with `?host=` / `?hostaddr=` in the URL query | Minor | Closed | 7433efd: hosts read through the dialect's `create_connect_args` |
| INC-QG-D-30 | Documentation overclaimed ("nobody can skip it", "can block a merge", a wrong §34 message) | Minor | Closed | 2ea6ca6, 96cfbf3 |
| INC-QG-D-31 | `tools/ci/release_gate.py` did not classify `.gitleaksignore` | Minor | Closed | 2ea6ca6: classified like `.gitleaks.toml` (a human must approve) |
| INC-QG-D-32 | A failing scan's log did not say where the secret was | Minor | Closed | 2ea6ca6: `--verbose`; file, line and commit are shown, the value stays redacted |
| INC-QG-D-33 | A pull request could weaken its own gate by editing the gitleaks files | Minor (Info) | Closed | 2ea6ca6: CODEOWNERS lines |

### 3.4 Peer review of Worker C (verdict: needs fixes; no blockers; no real auth gap)

| ID | Title | Sev. | Status | Resolution |
|---|---|---|---|---|
| INC-QG-D-34 | A role comparison that refuses nothing counted as a gate, and so did one in dead code (19 such helpers exist) | Major | Closed | 748cb0f: a comparison counts only when it raises on a live path; 4 routes moved to `KNOWN_UNGATED` with whose rows they read |
| INC-QG-D-35 | The audit went red for a developer running with `MCP_DEV_SURFACE` | Major | Closed | 748cb0f: `FOREIGN_HANDLER_PACKAGES` |
| INC-QG-D-36 | `-> Any` and `-> dict[str, Any]` slipped past the response-model rule | Major | Closed | 748cb0f |
| INC-QG-D-37 | The ADRs and docs contradicted the design Worker B actually built | Major | Closed | 0915706 |
| INC-QG-D-38 | The PR template said `preflight.sh` runs "all five" checks | Minor | Closed | 0915706: "all six" |
| INC-QG-D-39 | The audit's operation count was not cross-checked by an independent walk | Minor | Closed | 748cb0f |
| INC-QG-D-40 | An exception was keyed on path alone, so a different handler at a listed path inherited it | Minor | Closed | 748cb0f: every entry names its handler |
| INC-QG-D-41 | The 201 rule missed plural collection paths | Minor | Closed | 748cb0f; new `KNOWN_STATUS` entry `POST /api/mentor/students/{id}/assessments` |
| INC-QG-D-42 | Four endpoints with a hard cap were listed as unpaginated | Minor | Closed | 748cb0f: moved to `BOUNDED` |
| INC-QG-D-43 | The WebSocket dead-branch case was not handled | Minor | Closed | 748cb0f |
| INC-QG-D-44 | A dead FastAPI-version fallback in the walk | Minor | Closed | 748cb0f: deleted |
| INC-QG-D-45 | Factual errors in the docs: alarm topics, concurrency, pool sizes. ADRs said "Accepted" before merge, and ADR 0006 omitted `POST /api/admin/faculty` | Minor | Closed | 0915706 |
| INC-QG-D-46 | `POST /api/leaves` admits an ALUMNI account (201 at runtime) | Minor | **Open (by design)** | A product question for the owner: should alumni file leave? Unchanged, because a one-line role check would change who may use the endpoint |
| INC-QG-D-47 | 13 untyped responses, 2 status-code deviations, 61 unpaged lists (35 of them growing collections, notably `/api/admin/students` and `/api/leaves/pending`) | Minor | **Open (by design)** | Recorded in `tests/route_audit_exceptions.py`, which ratchets both ways. Fixing them changes the Angular client's contract; follow-up |
| INC-QG-D-48 | Stale documents: `docs/api-v1-redesign.md` says no `/api/v1` exists (23 operations do); `deployment-process.md` cites the deleted `ecs.tf` and said nothing runs `alembic check` | Minor | Closed in part | The `alembic check` text was fixed by TM in 9953f2b; the other two are follow-ups (listed in the completion report) |

### 3.5 Incidents found by real CI on the integration branch

| ID | Title | Sev. | Status | Resolution |
|---|---|---|---|---|
| INC-QG-D-49 | Cross-branch defect: Worker B's round-trip script used a bare `assert` (S101), which Worker A's ruff configuration refuses, so the merged tree would have been red | Major | Closed | c6f5e72 (TM), and independently in 7433efd |
| INC-QG-D-50 | "Secrets (gitleaks)" red on 30c0ad9: `tools/ci/check_gitleaks_rules.py` matched its own rules (4 template-shaped findings, no real value). It also proved the gate blocks, redacts and names the file, line and commit | Major | Closed | 4d1a2b9: names split, fingerprints recorded; merged in 1c8c233 |
| INC-QG-D-51 | "Migrations roll back" red on 1c8c233: `server_is_local()` refused CI's service container (`172.18.0.2`). The same check would have refused every developer's `docker compose up -d` | Major | Closed | 9bf54d8: the script refuses a server exposing managed-service settings (RDS, Aurora, Cloud SQL, Azure) instead of a non-loopback listen address; `tests/test_migration_roundtrip_guard.py`; merged as a3688f0, all 7 checks green |
| INC-QG-D-52 | Worker B reported 1,942 tests passing on a branch that collects about 1,990 | Minor | Closed (false alarm) | A reporting miscount, not missing tests; the integrated suite runs 2,054 passed, 3 skipped |

---

## 4. Test-phase defects (L1, L2, L3)

Build under test: `a3688f0189c48287f376cf8c165d762a2f8ab8d8`. The full text of each defect (steps, expected, actual, evidence) is in the tester's document; this register tracks the lifecycle.

### 4.1 L1: unit ([02-unit-testing.md](02-unit-testing.md), §6)

| ID | Title | Sev. / Pri. | Status | Assigned | Fix commit | Re-test |
|---|---|---|---|---|---|---|
| DEF-QG-U01 | The route audit counts a gate whose refusal is caught (`try: require_admin(s) except HTTPException: pass`), including through a predicate helper such as `_may_see_raw_response` | Major / P2 | Fixed, awaiting re-test | Worker C | e9d4015 | UT-G3-008 |
| DEF-QG-U02 | The route audit counts a gate in dead code other than `if <constant>`: after `return`, `if not True:`, `while False:` | Minor / P3 | Fixed, awaiting re-test | Worker C | e9d4015 | UT-G3-007, UT-G3-009 |
| DEF-QG-U03 | One `# ruff: noqa` line switches the ruff gate off for a whole file in `app/`; a bare `# noqa` is accepted; nothing enforces "a reason on the line" | Major / P2 | Fixed, awaiting re-test | Worker A | f257442 | UT-G1-036 |
| DEF-QG-U04 | An inline `gitleaks:allow` comment silences a real secret (a third, unreviewed allowlist) | Major / P2 | Fixed, awaiting re-test | Worker B | 20b5c68 | UT-G2-021 |
| DEF-QG-U05 | The round trip's loopback refusal does not see libpq's `PGHOSTADDR` or a service entry | Minor / P3 | Fixed, awaiting re-test | Worker B | 28991b6 | UT-G4-020 |
| DEF-QG-U06 | The static reversibility test classifies a do-nothing downgrade as "real" unless it is literally `pass` | Minor / P3 | Fixed, awaiting re-test | Worker B | 28991b6 | UT-G4-007 |

**Triage decision (TM):** all six are fixed in this PR rather than deferred. Each fix is a small change to a gate's own source, none touches product behaviour, and leaving a known bypass in a gate that was just merged would make the gate's green less meaningful from its first day.

| Observation | Decision | Assigned |
|---|---|---|
| OBS-QG-U01: a value that *contains* an allowlisted placeholder is freed | Fix: anchor the placeholder allowlists to the whole secret | Worker B |
| OBS-QG-U02: path allowlists assume `gitleaks dir .` from the root | Fix: one-line note in `.gitleaks.toml` and the docs | Worker B |
| OBS-QG-U03: IIFE lambda and `os.open`/`os.read` not caught by the async guard | Fix `os.*` (and `Path.open`); document the lambda blind spot | Worker A |
| OBS-QG-U04: `-> RootModel[dict[str, Any]]` passes the response rule | Fix: look inside `RootModel` | Worker C |
| OBS-QG-U05: preflight reads the gitleaks pin only when double-quoted | Fix: accept all three YAML spellings; name the failure | Worker B |
| OBS-QG-U06: two checklist lines in the PR template use non-uniform wording | Fix: uniform "gate name" or "human — no gate" | Worker C |
| (note) `E9` comment in `pyproject.toml` describes ruff's built-in behaviour | Fix the comment | Worker A |

### 4.2 L2: integration ([03-integration-testing.md](03-integration-testing.md), §6)

| ID | Title | Sev. / Pri. | Status | Assigned | Fix commit | Re-test |
|---|---|---|---|---|---|---|
| DEF-QG-I01 | The secret-scan step aborts after the first scan that finds something, under GitHub's `bash -e`: no tree scan, no `::error::` annotation. Fails closed, but not as designed | Minor / P2 | Assigned | Worker B | _pending_ | IT-G2-003 |
| DEF-QG-I02 | §34 accepts a `preflight.sh` that no longer runs, or no longer records, a required check: a substring test over the whole file, comments included | Major / P2 | Assigned | Worker A | _pending_ | IT-GX-005 |
| DEF-QG-I03 | Preflight's secret check passes a secret in a new, untracked file | Major / P2 | Assigned | Worker A | _pending_ | IT-GX-015 |
| DEF-QG-I04 | Preflight's secret check does not say where the secret is | Minor / P3 | Assigned | Worker A | _pending_ | IT-GX-014, IT-GX-016 |

**Triage decision (TM):** all four are fixed in this PR. I02 is partly inherited: the five-check half of the substring test predates this PR. It is fixed here because this PR extended it, and a guard that a comment can satisfy is not a guard.

| Observation | Decision | Assigned |
|---|---|---|
| OBS-QG-I01: a PR can silence the secret gate by fingerprinting its own leak in `.gitleaksignore`; CODEOWNERS is not enforced (`require_code_owner_review: false`, one owner) | No detector in this PR. The docs are made to say plainly that CODEOWNERS is not enforced; raised to the owner as Q4 | Worker B (docs) |
| OBS-QG-I02: `protect-main.sh --dry-run` makes read-only API calls | Usage text says it reads and writes nothing | Worker A |
| OBS-QG-I03: the release gate does not know `testing/` | Classify `testing/` as NO_DEPLOY | Worker A |
| OBS-QG-I04: actionlint 1.7.7 reports `ops-task.yml` (14 inputs) | No action: an outdated actionlint rule, file not touched; 1.7.12 is clean | — |
| OBS-QG-I05: the brief expected workflows to need a human at the release gate | No action: the gate is consistent with AGENTS.md (a CI workflow change deploys nothing); the traceability matrix will not claim otherwise | — |
| OBS-QG-I06: CI's static step stops at the first tool; preflight's pytest prints no count; gitleaks colour survives `--no-color` | Fix all three (cosmetic, cheap) | Worker A |

### 4.2a Fix-verification findings (FV-QG)

Found by the Test Manager while verifying a fix round, before any re-test.

| ID | Title | Sev. | Status | Assigned | Fix commit |
|---|---|---|---|---|---|
| FV-QG-01 | **Regression from the OBS-QG-U01 fix (816ac71):** anchoring the placeholder allowlists to the whole secret made `KEY=<FAKE-VALUE-MASKED>` a finding. Some rules' capture groups exclude the angle brackets, so the conventional `<placeholder>` spelling in documentation would turn the secret gate red. Seen on the unit tester's masked evidence (8 findings) | Major (CI red on a correct tree) | Assigned | Worker B | _pending_ |

### 4.3 L3: system ([04-system-testing.md](04-system-testing.md))

_Executing._

---

## 5. Questions for the product owner

| # | Question | Raised by | Why it is not decided here |
|---|---|---|---|
| Q1 | Should an ALUMNI account be able to file a leave request (`POST /api/leaves` answers 201 today)? | INC-QG-D-46 | It changes who may use an endpoint; it is a product decision |
| Q2 | Accept the six "Open (by design)" items (§3) as tracked follow-ups rather than blockers? | §3 | Each changes product behaviour or the client contract |
| Q3 | Apply the committed rulesets (`.github/rulesets/{main,stage,dev}.json`) in the repository settings? | TM | Requires a repository admin. Until then no required check blocks a merge on GitHub |
| Q4 | Accept OBS-QG-I01 as residual risk: one PR can fingerprint its own leak in `.gitleaksignore`, and CODEOWNERS is not enforced while there is one maintainer? | OBS-QG-I01 | Closing it needs enforced code-owner review and a second maintainer, a governance decision |
