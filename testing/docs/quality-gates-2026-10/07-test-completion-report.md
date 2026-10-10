# 07 — Test Completion Report: Quality Gates release (QG-2026-10)

| Field | Value |
|---|---|
| Document ID | REEP-TCR-QG-2026-10 |
| Version | 1.0 |
| Status | Issued for the product owner's decision (§10) |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 *Test Completion Report*; ISTQB® CTFL v4.0 terminology |
| Parent document | [01 — Test Plan](01-test-plan.md) (REEP-TP-QG-2026-10 v1.1) |
| Companion documents | [02 Unit](02-unit-testing.md) v1.2 · [03 Integration](03-integration-testing.md) v1.4 · [04 System](04-system-testing.md) v1.1 · [05 Traceability](05-traceability-matrix.md) v1.0 · [06 Incident register](06-incident-register.md) v1.0 |
| Change under test | Pull request [darshani8/reep-#132](https://github.com/darshani8/reep-/pull/132), `claude/clever-meitner-ndvc2e` → `dev` |
| Prepared by | the orchestrating session (Test Manager role), 2026-10-08 |
| Approver | the product owner (bdarshan5@bgscet.ac.in), §10 |

### Revision history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-08 | Issued after the last re-test rounds (L1 on `e55d139`, L2 on `988e732`) and the L3 regression pass (`40201a1`) |

---

## 1. Summary

PR #132 turns five review concerns into gates:

* **G1:** ruff, mypy and an async-blocking guard.
* **G2:** a gitleaks required check.
* **G3:** a route audit for auth, response model, status codes and pagination.
* **G4:** a migration round trip with a reversibility ratchet.
* **G5:** a human gate in the PR template.

Three independent tester sessions verified the change at unit, integration and system level. None of them had written any of the code. A fix-and-re-test loop ran until no Critical or Major defect remained open.

| | |
|---|---|
| Requirements covered | **37 of 37 (100 %)**; 31 pass on every case, 6 have one not-passed case, each explained (§4.2) |
| Distinct test cases | **241** (L1 147, L2 54, L3 40); **533 executions** across the rounds |
| Defects raised by testing | **21**: Critical 0 · Major 8 · Minor 13 |
| Closed and confirmed by re-test | **17**, including all 8 Major |
| Proposed for deferral | **4**, all Minor and all deliberate third-order bypass spellings (Q5) |
| Open | **0** |
| Product behaviour | **Unchanged**, apart from the four intended fixes. The OpenAPI document is byte-identical to the base; 0 of the base's passing tests lost; the system API suite gave the same 281 verdicts; every role works end to end |
| CI on the final code (`988e732`) | All 7 required checks green (run on `987afdc`, which is `988e732` plus documents) |
| **Recommendation** | **GO: merge into `dev`**, subject to the owner's answers to Q1–Q6 (§6). None of them blocks the merge on test grounds |

The development phase before formal testing had already caught 52 incidents: 2 Critical (the secret scan failing open, and a line-wide allowlist), 14 Major and 36 Minor. Formal testing then found 21 more, every one of them in the gates' own code or configuration. **No defect in REEP's product behaviour was found at any level.**

---

## 2. Test items and the builds tested

| Build | Sha | Content | Tested at |
|---|---|---|---|
| Base | `15a9e7d` | `main` / `dev` before the change | L3 comparisons |
| Round 1 | `a3688f0` | The three development branches merged; all 7 required checks green (plan entry criterion 2) | L1, L2, L3 round 1 |
| Re-test 1 | `40201a1` | + the L1 and L2 fix rounds and FV-QG-01 | L1 re-test 1, L2 re-test 1, L3 regression pass |
| Re-test 2 | `e55d139` | + the L1 re-test-1 fixes (U07–U11) | L1 re-test 2 |
| Final code | `988e732` | + DEF-QG-I06 | L2 final confirmation |
| PR head | the head of #132 at issue | `988e732` + this documentation | CI (7 required checks) |

**The product code did not move after round 1 except in comments.**

* `a3688f0` → `40201a1`: the only changes in `apps/api-py/app` and `apps/web` are 93 reasons added to existing `# noqa` comments. The L3 tester proved this with a token-stream and AST comparison with comments removed (ST-040). Its negative control does flag the real round-1 changes.
* `40201a1` → `988e732`: nothing under `apps/api-py/app` or `apps/web` changed at all (TM, `git diff --stat`). The changes are gate code, tests, `.gitleaks.toml`, `secret-scan.yml`, `migrations/reversibility.py` (not a migration revision) and documentation.

So the system-level results on `40201a1` stand for the final code.

---

## 3. Testing performed

### 3.1 Against the plan

| Plan item | Planned | Actual | Deviation |
|---|---|---|---|
| Levels | L1, L2, L3 in parallel, one container each | As planned | — |
| Independence | Testers wrote none of the code | As planned. Testers reported defects, never fixed them; every fix went to a developer session (A, B or C) and back to the tester who raised it | — |
| Entry criteria (§6) | Fixes merged; 7 checks green; plan baselined | Met on `a3688f0` | — |
| Test basis | Plan v1.0 | v1.1 | Two requirements corrected during execution, neither widening what a tester had to prove. REQ-G4-05 described the round trip before its rewrite. REQ-GX-03 listed three intended fixes where the build carries four |
| Python / PostgreSQL | CI 3.14 / 17; test bed 3.13 / 16 | As planned. L2 replayed the CI api job on **Python 3.14** in every round; CI ran 3.14 / 17 on every tested head | Mitigated |
| Re-testing | Fixed → Re-tested → Closed | Every fix was confirmed by the tester who raised the defect, with targeted regression of the changed gate. The L1 loop ran two rounds, L2 two rounds plus a final confirmation, and L3 a regression pass | — |
| History scans | "Full history" on the test bed | Every container's clone was **shallow** (OBS-QG-S05), so round-1 "full history" scans covered 140–219 commits | Re-run by U, I, S and TM on unshallowed clones: 594–602 commits in the head's ancestry and 1,292–1,295 across every branch, all clean. REQ-G2-08 rests on those runs. The finding also produced DEF-QG-I06 |

### 3.2 Techniques

The plan's techniques were all used:

* equivalence partitioning per rule family;
* boundary values (the 300-operation floor, page-size bounds, the rollback floor, the placeholder length cap);
* decision tables (preflight's exit codes);
* state transitions (every ratchet: baseline → new violation → fixed → struck off);
* comparison testing (OpenAPI, catalogue dumps, GET responses for 5 identities × 131 paths, base vs head);
* regression suites;
* **error guessing with adversarial bypass attempts**, which was by far the most productive. 16 of the 21 test-phase defects are bypasses: U01–U09, U11–U14, I02, I05 and I06. The other five are a weakened self-test (U10), a step that stopped early (I01), a gap in the local runner (I03), a missing location in its output (I04), and a false positive introduced by a fix (FV-QG-01).

---

## 4. Metrics

### 4.1 Executions by level and round

| Level | Round | Build | Executed | Pass | Fail | Blocked |
|---|---|---|---|---|---|---|
| L1 unit | 1 | `a3688f0` | 109 | 99 | 10 | 0 |
| L1 unit | Re-test 1 (all 109 + 22 new) | `40201a1` | 131 | 122 | 9 | 0 |
| L1 unit | Re-test 2 (81 targeted + 16 new) | `e55d139` | 97 | 93 | 4 | 0 |
| L2 integration | 1 | `a3688f0` | 48 | 45 | 3 | 0 |
| L2 integration | Re-test 1 (48 + 6 new) | `40201a1` | 54 | 52 | 2 | 0 |
| L2 integration | Final confirmation | `988e732` | 39 | 38 | 1 | 0 |
| L3 system | 1 | `a3688f0` | 39 | 39 | 0 | 0 |
| L3 system | Regression pass (15 + 1 new) | `40201a1` | 16 | 16 | 0 | 0 |
| **Total** | | | **533** | **504** | **29** | **0** |

No case was Blocked or Not run in any round. Every Fail in a round is a raised defect or an observation, and §4.2 gives each final disposition.

### 4.2 Requirements coverage

All 37 requirements are covered by executed cases at the level(s) that can observe them; see [05](05-traceability-matrix.md). Five cases end not passed:

| Case | Requirement(s) | Why |
|---|---|---|
| UT-G1-040 | REQ-G1-02 | DEF-QG-U12, deferred (proposed) |
| UT-G3-050 | REQ-G3-03 | DEF-QG-U13, deferred (proposed) |
| UT-G4-026 | REQ-G4-01 | DEF-QG-U14, deferred (proposed) |
| IT-GX-022 | REQ-GX-01, REQ-GX-02 | DEF-QG-I05, deferred (proposed) |
| UT-G2-025 | REQ-G2-05 | OBS-QG-U08: gitleaks' own `openai-api-key` boundary; identical with no REEP configuration, so not a defect of this change |

### 4.3 Defects

| Source | Raised | Critical | Major | Minor | Closed | Deferred (proposed) | Open by design |
|---|---|---|---|---|---|---|---|
| Development phase (INC-QG-D, before formal testing) | 52 | 2 | 14 | 36 | 46 | 0 | 6 |
| L1 unit (DEF-QG-U01–U14) | 14 | 0 | 5 | 9 | 11 | 3 | 0 |
| L2 integration (DEF-QG-I01–I06) | 6 | 0 | 2 | 4 | 5 | 1 | 0 |
| L3 system | 0 (5 observations) | 0 | 0 | 0 | 0 | 0 | 0 |
| Fix verification by TM (FV-QG-01) | 1 | 0 | 1 | 0 | 1 | 0 | 0 |
| **Total** | **73** | **2** | **22** | **49** | **63** | **4** | **6** |

**Defect detection by round** shows the loop converging:

* round 1 found 10 (6 at L1, 4 at L2);
* the re-test-1 rounds found 7 (5 at L1, 2 at L2), plus FV-QG-01 in fix verification;
* re-test 2 found 3, all Minor third-order spellings.

**Every Major was closed** and confirmed by re-test. **Fix-introduced regressions:** two. FV-QG-01 was caught by TM before any re-test. DEF-QG-U10, the replay no longer guarding the round-1 bug, was caught by L1. Both are closed.

### 4.4 Regression (REQ-GX-03, plan exit criterion 4)

| Suite | Base `15a9e7d` | Head | Result |
|---|---|---|---|
| OpenAPI document | 370 operations | 370 operations, byte-identical on `a3688f0` and `40201a1` | Unchanged |
| GET surface, 131 paths × 5 identities | — | 655 comparisons | 0 product differences |
| Backend pytest | 1,981 passed, 3 skipped (1,984 collected) | **2,195 passed, 3 skipped** on the final code (the L2 CI replay on Python 3.14; 2,198 collected) | 0 base passes lost; +214 tests, all the gates' own |
| `testing/api` system API suite | 281 passed, 2 skipped (2026-09-29 baseline) | 281 passed, 2 skipped on `a3688f0` and `40201a1` | 0 verdicts changed |
| Web unit (`ng test`), `ng build` | — | 226 / 226; production build within budget (228 kB initial < 250 kB) | `apps/web` unchanged by the PR |
| e2e (`tests/`, one API worker) | — | 246 passed. The 10 failures are pre-existing and state-dependent, failing identically on the base (OBS-QG-S04) | 0 attributable to the change |
| Per-role walkthroughs (API and browser) | — | Student, mentor, alumni and admin all pass; negative cases identical to base | — |
| CI, 7 required checks | — | Green on `a3688f0`, `40201a1` and the final code | — |

---

## 5. What the gates were proven to do

Each claim is backed by cases at the level that can observe it. All of them hold on the final code.

* **G1, static analysis.**
  - ruff fails on every selected family and not on its defaults; mypy fails on each configured check.
  - The async guard catches inline, aliased (three forms, across modules) and keyword sessions, and blocking calls including `os.*` and `Path(...).open()`. Its `KNOWN` list pins exact findings, in both directions.
  - **Every spelling ruff honours for suppressing a rule** is read by §39: `noqa`, `flake8: noqa`, `ruff: ignore`, `disable`/`enable` and `file-ignore`. A file-level, codeless or reasonless suppression is refused in shipped code, and RUF103/RUF104 are selected. CI's static step reports all three tools' findings at once.
* **G2, secrets.**
  - The pinned binary is verified by sha256.
  - The PR range and the tree are both scanned, and both scans always run under GitHub's `bash -e`. The step fails closed on an unresolvable range, a scanner error and, now, a **shallow checkout**. Values are redacted while file, line and commit are named.
  - Inline `gitleaks:allow` is ignored everywhere gitleaks runs (CI, preflight, pre-commit, the replay). A placeholder is freed only when it is **wholly** one `<…>`.
  - The replay puts a real secret on the same line as every freed value, so it fails if `regexTarget` regresses to `line` (9 leaks missed) or any exemption widens.
  - The full history is clean on unshallowed clones.
* **G3, route audit.**
  - It walks all 376 operations and 3 WebSockets and cross-checks the count independently, with no database, in any test order.
  - A gate counts only on a live, uncaught path. A refusal swallowed by `except` (any spelling or alias, resolved by identity) or by `suppress()`, a gate in dead code, and a gate in an uncalled nested function are all refused.
  - The response-model rule looks inside `RootModel`. Six exception lists ratchet both ways, each entry pinned to its handler.
  - The OpenAPI document is unchanged.
* **G4, migrations.**
  - Every downgrade that can run is run: 90 of 92, in three segments. The catalogue is compared at each segment's bottom and top, the walked head must equal the straight one, and `alembic check` must be clean.
  - It catches missing, incomplete, residue-leaving and wrong-default downgrades, including one the static test alone would miss.
  - The classifier refuses do-nothing downgrades (constant folding, `return <constant>`, falsy loops) unless declared `IRREVERSIBLE`.
  - The script refuses a non-dev `ENV`, non-loopback hosts (including `?host=`/`?hostaddr=`, `PGHOSTADDR` and any libpq service), production-named databases and managed cloud servers. It passes through a port mapping, as CI's service container needs.
  - It only reads the dev database: the schema is identical after a preflight run.
* **G5, the human gate.** The PR template keeps every pre-existing section; every Engineering-checklist line names its gate or says *human — no gate*. All 41 relative links in `docs/engineering` and `docs/adr` resolve, and 18 sampled factual claims match the code.
* **Cross-cutting.**
  - §34 proves the five `ci.yml` jobs, the rulesets, `protect-main.sh` and `preflight.sh` agree. It reads preflight's code rather than comments, and requires each check to be recorded under its exact name and called in both dispatch paths.
  - `preflight.sh` follows its exit-code table in every tested row, scans untracked files, and says where a secret is.
  - The release gate classifies `testing/` as deploying nothing.

---

## 6. Residual risks and decisions for the product owner

| # | Risk or question | Severity | Recommendation |
|---|---|---|---|
| Q5 | **Four deferred Minor bypasses**: DEF-QG-U12 (a reasoned module-wide disable range), U13 (a locally rebound exception class), U14 (a `return` inside `if True:` in a downgrade), I05 (a preflight call behind `if false`/after `exit 0`). Each needs deliberate effort, and the common and second-order spellings are refused | Minor | **Accept as residual risk.** All four are tracked as one follow-up task. Another fix round costs more than it protects: each round has found exactly one rarer spelling per gate |
| Q4 | **A PR can silence the secret gate** by fingerprinting its own leak in `.gitleaksignore` (OBS-QG-I01). CODEOWNERS lists the file, but `require_code_owner_review` is false and the only owner is every PR's author. The docs now say so plainly | Residual | Accept for now. It closes only with enforced code-owner review and a second maintainer, a governance decision |
| Q3 | **The rulesets are committed but not applied.** Until a repository admin applies `.github/rulesets/{main,stage,dev}.json`, no required check blocks a merge on GitHub | High (process) | **Apply them after merge.** Without this, every gate in this PR is advisory |
| Q1 | `POST /api/leaves` admits an ALUMNI account (201 at runtime; INC-QG-D-46) | Product question | Decide whether alumni may file leave; unchanged by this PR |
| Q6 | Session revocation is per API worker. With two workers, a signed-out session can work for up to 60 s (OBS-QG-S03). This is pre-existing, and AGENTS.md's "drops the laptop on its next request" holds only within one process | Pre-existing | Decide whether immediate cross-worker revocation is required; outside this PR |
| Q2 | Six development-phase findings are open by design. Three async handlers do blocking database work; `deliver_once` can return `None`; two badge routes answer 500 instead of 404; 35 growing lists are unpaginated; two stale documents remain | Minor / follow-up | Accept as tracked follow-ups; each changes product behaviour or the client contract |

Other limits, stated so nobody reads more into a green run:

* **The route audit proves a gate is *called*, not that it is the right one.** Rule 2's own tests carry that.
* **The secret gate catches the shapes its rules know.** The replay pins 54 of them and 11 quiet controls. A value written wholly inside `<…>` and up to 40 characters long is indistinguishable from a placeholder (OBS-QG-U09).
* **The e2e suite is not a clean signal** while its 10 state-dependent cases fail on the base too (OBS-QG-S04).

---

## 7. Process incidents and lessons

| Incident | Effect | Lesson applied |
|---|---|---|
| A fix introduced a regression (FV-QG-01): anchoring placeholders flagged the testers' own `<FAKE-VALUE-MASKED>` evidence | Caught by TM while verifying the fix, before any re-test | **Verify a fix against real data before routing it to re-test.** The masked evidence of the testers themselves was the best test data available |
| TM accepted FV-QG-01's widened exemption on a premise ("no rule alphabet contains `<`") that L1 then proved false (OBS-QG-U07) | The acceptance was withdrawn in the register, struck through with the reason, and the exemption narrowed | **An acceptance is a claim that needs a test.** Record the premise so a tester can falsify it |
| A fix weakened the replay that guards a previous fix (DEF-QG-U10) | Reverting to `regexTarget = "line"` would have passed silently | A self-test must keep a case that exercises **the original bug**, not only the new shape |
| Shallow clones in every container | Round-1 "full history" scans were partial and still printed "no leaks found" | History claims now quote the commit count. CI now refuses a shallow checkout (DEF-QG-I06) |
| A tester committed evidence holding real-shaped fake secrets | Its history commit would have turned the PR's secret scan red | Tester documents are **imported as fresh commits** from each branch tip, never merged, and every tip is scanned with the final config first |
| TM pushes cancelled in-progress CI runs (`concurrency: cancel-in-progress`) | One CI run on `988e732` was cancelled | Pushes were batched; the final code's green run is on `987afdc` (same code) |
| Two tester-environment restarts (Postgres stopped between rounds) | Recorded in evidence; nothing Blocked | One database per run, as AGENTS.md requires |

---

## 8. Exit criteria (plan §6)

| # | Criterion | Status |
|---|---|---|
| 1 | 100 % of planned cases executed; "Not run" only with an accepted reason | **Met**: every planned and added case executed; 0 Blocked, 0 Not run |
| 2 | Every requirement covered by at least one executed case | **Met**: 37 / 37 |
| 3 | No open Critical or Major; every Minor fixed or accepted in writing | **Met for Critical and Major** (0 open). **Pending for 4 Minor:** the owner's written acceptance (Q5) |
| 4 | Regression: backend suite, web unit suite and `ng build` green on the final head | **Met**: 2,195 passed / 3 skipped on the final code (Python 3.14); 226/226 web unit; build within budget; all 7 CI checks green |
| 5 | Test Completion Report written; sign-off block ready | **Met**: this document |

---

## 9. Recommendation

**GO.** Merge PR #132 into `dev`.

The gates do what their requirements say on correct and incorrect input. Every Major found by independent testing was fixed and confirmed by re-test, and REEP's behaviour is unchanged apart from the four intended fixes.

The merge needs one signature: the owner's acceptance of the four deferred Minor items (Q5). After merge, apply the rulesets (Q3); until then, the gates inform but do not block.

---

## 10. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Test Engineer — Unit (L1) | Tester session U | GO on `e55d139`: no open Critical or Major; U12–U14 to be fixed or accepted ([02](02-unit-testing.md) §7.6) | 2026-10-08 |
| Test Engineer — Integration (L2) | Tester session I | GO on `988e732`: I05 to be accepted (Q5); OBS-QG-I01 with the owner (Q4) ([03](03-integration-testing.md) §7.F) | 2026-10-08 |
| Test Engineer — System (L3) | Tester session S | GO: 39/39 on `a3688f0`, 16/16 regression pass on `40201a1`, 0 defects ([04](04-system-testing.md) §7.5) | 2026-10-08 |
| Test Manager | Orchestrating session | GO, as §9 | 2026-10-08 |
| **Product owner (approver)** | bdarshan5@bgscet.ac.in | ☐ Approve merge ☐ Approve with conditions ☐ Reject. Q1: ___ Q2: ___ Q3: ___ Q4: ___ Q5: ___ Q6: ___ | |
