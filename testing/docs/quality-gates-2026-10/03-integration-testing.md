# 03 — Integration Test Specification, Execution Log and Incident Report (QG-2026-10, level L2)

## 1. Document control

| Field | Value |
|---|---|
| Document ID | REEP-ITS-QG-2026-10 |
| Version | 1.0 |
| Status | Executed — submitted to the Test Manager for triage |
| Author | Tester session I |
| Date | 2026-10-08 |
| Build under test | `claude/clever-meitner-ndvc2e` (PR darshani8/reep-#132 → `dev`), head **`a3688f0189c48287f376cf8c165d762a2f8ab8d8`** |
| Base for comparison | `15a9e7d1d89ad7971436235db9d606e976c46be4` |
| Test basis | [01-test-plan.md](01-test-plan.md) v1.0 (REQ-G1-01 … REQ-GX-04) |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 (test specification, test execution log, incident report); ISTQB CTFL v4.0 terminology |
| Reviewer | Test Manager (orchestrating session) |
| Evidence | `testing/results/quality-gates-2026-10/integration/` (one file per case, named by case ID) |

### Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-10-08 | Tester session I | Cases designed from the test plan and the gate sources, before execution |
| 1.0 | 2026-10-08 | Tester session I | All 48 cases executed; actual results, verdicts, 4 defects and 6 observations recorded |
| 1.1 | 2026-10-08 | Tester session I | §6.1: re-test of DEF-QG-I02 and DEF-QG-I03 on `8914e839` — both still open |

---

## 2. Scope of this level

**Question answered (plan §3):** do the gates work *wired together and into their environment* — in the right order, with the right exit codes and failure messages — rather than each component on its own?

### 2.1 Items tested

| Item | How it was integrated for test |
|---|---|
| `ci.yml` job `api` | Replayed step by step, exactly as written (working-directory, commands, job env), by a small driver that reads the YAML (`IT-G1-001-replay_job.py.txt`), under Python **3.14** and a Postgres reached through a **port mapping** |
| "Static analysis (ruff, mypy, async blocking)" step | Inside the job replay, with one planted defect per tool |
| "Migrations roll back" step (`check_migration_roundtrip.py`) with `alembic`, `reversibility.py`, `test_migration_reversibility.py` | CI topology, seeded DB, `--plan`, three injected broken downgrades, refusals against real servers, dev-DB non-interference |
| `secret-scan.yml` | Its two `run:` scripts extracted **verbatim** and executed with the workflow's env against real git ranges in a scratch clone, under GitHub's own default shell; actionlint over every workflow |
| `.gitleaks.toml`, `.gitleaksignore`, `check_gitleaks_rules.py`, `.pre-commit-config.yaml` | Through the workflow script, the rule self-test and the pre-commit hook |
| Required-check contract | §34 of `test_codebase_guards.py` against the four files + two workflows, with mutations; the three rulesets; `protect-main.sh --dry-run`; `release_gate.py` |
| `tools/ci/preflight.sh` | End to end, every row of the exit-code decision table |
| Route audit | In the assembled app, without a database, in different orders, and with a new route mounted |

### 2.2 Items not tested at this level (and why)

| Not tested | Why |
|---|---|
| REQ-G1-02, G1-05, G3-03, G3-05, G3-06, G3-07, G3-09 | Component behaviour of a single gate (ratchet transitions, each audit rule) — level L1/L3 (sessions U and S) |
| REQ-G5-01 … G5-03 (PR template, docs) | Documentation review — level L3 |
| REQ-GX-04 (stack end to end per role) | System level L3 |
| Server-side enforcement of the rulesets and of CODEOWNERS | Plan §3.1: not applied on GitHub; the committed JSON and §34 were tested |
| The real GitHub runner | No runner access from the test bed; the job was replayed in its topology and CI's own green result on the same head is cited by the plan's entry criteria |
| `--clean-deps`, `--npm-ci` flags of preflight | Not in the requested decision table; time spent on the rows that decide the exit code |

---

## 3. Test environment actually used

| Component | Version / configuration | Deviation from plan §5 |
|---|---|---|
| Container | Linux 6.18.44, 4 vCPU | — |
| PostgreSQL (dev bed) | 16.15 + pgvector 0.6.0, `localhost:5433`, trust auth; one DB per concurrent run (`reep_py`, `reep_pf`, `reep_inj`, …) | PG 16 vs CI's 17 (plan-approved) |
| PostgreSQL (CI topology) | Second 16.15 cluster listening **only** on `192.0.2.2:5432` (an address added to `lo`), SCRAM password auth with `host all all all scram-sha-256` like the pgvector image; reached through `socat 127.0.0.1:5435 → 192.0.2.2:5432`. `inet_server_addr()` = `192.0.2.2` — the same shape as GitHub's service container (172.18.0.2) | Port 5435 instead of 5433 (5433 taken by the dev bed) |
| Python | **3.14.6** (uv-managed CPython, fresh venv `/tmp/py314`) for the CI replay; 3.13.16 in `apps/api-py/.venv` for preflight and ad-hoc runs; 3.12.3 for `infra/cdk/.venv` | Better than plan: the CI job itself ran on 3.14, removing the 3.13 deviation for IT-G1-001 |
| ruff / mypy / alembic | 0.16.10 / 2.4.0 / 1.19.1 (pinned by `requirements-dev.txt`) | — |
| Node / npm | 22.22.3 (sha256-verified against nodejs.org SHASUMS256.txt) / 10.9.8; `npm ci` in `apps/web` | — |
| gitleaks | 8.30.0, sha256 `79a3ab57…a66e` verified against the pin in `secret-scan.yml`; 8.18.4 (checksum-verified from its release) for the version-mismatch row | — |
| actionlint | 1.7.7 and 1.7.12 (release checksums verified) | — |
| pre-commit | 4.6.2 in a scratch venv | — |
| Git | Repository **unshallowed** (`git fetch --unshallow`) after the first push-mode run found a 219-of-724-commit shallow clone; equivalent to `fetch-depth: 0` | See IT-G2-006 |
| Docker | CLI present, daemon absent — topology built with an alias address + socat instead | — |
| Isolation | Every violation was made in a scratch worktree (`/tmp/ci-replay`, `/tmp/wt34`, `/tmp/wtmig`, `/tmp/wtpf`) or a scratch clone (`/tmp/ss-clone`, never pushed); each mutation was reverted and `git status --porcelain` re-checked to 0 (recorded in each evidence file). Fake secrets were generated at run time into `/tmp/faketok`, outside the repository, and appear in no evidence file (verified: 0 occurrences; gitleaks over the evidence folder is clean) | — |

Versions: `ENV-versions.txt`.

---

## 4. Test case specification

### 4.1 Case index

| ID | Requirement(s) | Title | Technique | Priority |
|---|---|---|---|---|
| IT-G1-001 | G1-06, G4-02, G4-05, GX-03 | Replay the whole `api` job on a fresh DB, Python 3.14, port-mapped Postgres | Regression; scenario | P1 |
| IT-G1-002 | G1-06, G1-07, G4-05, GX-01 | Step order, names and commands match the contract | Comparison (base vs head, YAML vs plan) | P1 |
| IT-G1-003 | G1-01, G1-03, G1-04, G1-06 | A defect for each of the three tools stops the job at the static step, before the database | Equivalence partitioning; error guessing | P1 |
| IT-G2-001 | G2-02 | Clean PR range 15a9e7d..head → 0 | Positive | P1 |
| IT-G2-002 | G2-03, G2-06 | Secret added then removed in the PR → fails, located, redacted | Negative | P1 |
| IT-G2-003 | G2-03 | Same range under GitHub's default shell: both scans run and one verdict is given | Error guessing (environment) | P1 |
| IT-G2-004 | G2-04 | Unresolvable base/head (unknown, empty, tree object) → fails closed | Negative; boundary | P1 |
| IT-G2-005 | G2-02 | Empty range (base = head) → 0 | Boundary | P2 |
| IT-G2-006 | G2-02, G2-08 | Push mode scans the whole history and the tree; history clean | Positive | P1 |
| IT-G2-007 | G2-05, G2-07 | A PR that only edits `.gitleaksignore` to hide a planted secret | Adversarial bypass | P1 |
| IT-G2-008 | G2-01 | Install step with the pinned sha256 → installed, on `GITHUB_PATH` | Positive | P1 |
| IT-G2-009 | G2-01 | Install step with a wrong / stale / empty sha256 → fails, nothing installed | Negative; boundary | P1 |
| IT-G2-010 | G2-05 | "Prove the rules" step green; removing a rule turns it red | Positive + mutation | P2 |
| IT-G2-011 | G2-06 | pre-commit hook version equals the workflow's and agrees with the CI scan | Comparison | P2 |
| IT-G2-012 | G2-05 | Real-shaped token on the same line as an allowlisted dev value, through the workflow | Adversarial bypass | P1 |
| IT-G3-001 | G3-01, G3-08 | Audit runs with no database, in several orders, and is collected by CI's pytest step | Integration; order independence | P2 |
| IT-G3-002 | G3-02, G3-04 | A newly mounted unauthenticated, model-less route is caught through the real app | Adversarial bypass | P1 |
| IT-G4-001 | G4-02, G4-05 | Round-trip step passes inside the CI replay, after migrations and before the seed | Scenario | P1 |
| IT-G4-002 | G4-02 | CI topology: Postgres behind a port mapping (server reports a non-loopback address) | Regression of a fixed CI defect | P1 |
| IT-G4-003 | G4-02 | Round trip on a seeded DB, and `--plan` touches nothing | Positive | P2 |
| IT-G4-004 | G4-01, G4-03 | Injected defect A: downgrade omits its `drop_column` | Fault injection | P1 |
| IT-G4-005 | G4-01, G4-03 | Injected defect A2: downgrade does "work" that removes nothing (static-test bypass) | Fault injection; bypass | P1 |
| IT-G4-006 | G4-03 | Injected defect B: downgrade restores the wrong default (invisible at the top) | Fault injection | P1 |
| IT-G4-007 | G4-01, G4-02 | Exactly one head; `alembic check` clean | Positive | P1 |
| IT-G4-008 | G4-04 | Refusals against real endpoints: direct non-loopback, `?hostaddr=`, `?host=`, non-dev ENV, "prod" name, a server that answers like RDS | Negative; adversarial | P1 |
| IT-G4-009 | G4-06 | Standalone round trip leaves the dev DB byte-identical (schema + data) | Comparison | P1 |
| IT-G4-010 | G4-06 | After a full preflight the dev schema is identical and no scratch DB remains | Comparison | P1 |
| IT-GX-001 | GX-01, G2-07 | §34 green on the head | Positive | P1 |
| IT-GX-002 | G2-07, GX-01 | Rename the secret-scan job → §34 fails naming the workflow | Mutation | P1 |
| IT-GX-003 | G2-07 | Drop "Secrets (gitleaks)" from `dev.json` → §34 fails | Mutation | P1 |
| IT-GX-004 | GX-01 | Rename a `ci.yml` job → §34 fails | Mutation | P1 |
| IT-GX-005 | GX-01, GX-02 | Remove / rename a check in `preflight.sh` → §34 fails | Mutation; bypass | P1 |
| IT-GX-006 | G2-07 | Remove the secret scan from `protect-main.sh` STANDALONE_CHECKS → §34 fails | Mutation | P1 |
| IT-GX-007 | G2-07, GX-01 | `protect-main.sh --dry-run` lists all seven checks and sends nothing | Positive; error guessing | P2 |
| IT-GX-008 | G2-07, GX-01 | The three rulesets parse; main/stage = five + Secrets + Branch policy, dev = five + Secrets | Decision table | P1 |
| IT-GX-009 | GX-01 (gate wiring) | `release_gate.py`: its tests, and this PR's paths classified as `agent-release.yml` would | Equivalence partitioning | P2 |
| IT-GX-010 | GX-01 | actionlint on every workflow; every workflow/ruleset/pre-commit file parses | Static | P2 |
| IT-GX-011 | GX-02, GX-03, G4-06 | Full `preflight.sh` on a clean tree → exit 0 | Decision table (all PASS) | P1 |
| IT-GX-012 | GX-02 | `--quick` → 2 (PARTIAL + SKIP) | Decision table | P1 |
| IT-GX-013 | GX-02 | gitleaks absent from PATH → check 3 SKIP → 2 | Decision table | P1 |
| IT-GX-014 | GX-02, G2-06 | Fake secret in an uncommitted change to a tracked file → check 3 FAIL → 1 | Decision table; negative | P1 |
| IT-GX-015 | GX-02 | Fake secret in a new, untracked (uncommitted, unstaged) file → check 3 FAIL → 1 | Error guessing | P1 |
| IT-GX-016 | GX-02 | The same file staged → check 3 FAIL → 1 | Decision table | P1 |
| IT-GX-017 | GX-02 | gitleaks of another version first on PATH → SKIP, never a scan | Boundary (version ≠ pin) | P2 |
| IT-GX-018 | GX-02, G4-06 | `--skip-db-setup` → PARTIAL, round trip not run → 2 | Decision table | P2 |
| IT-GX-019 | GX-02, G1-03 | Type error planted in `app/` → check 6 FAIL at static analysis → 1 | Decision table | P1 |
| IT-GX-020 | GX-02 | Postgres unreachable → check 6 SKIP after static analysis ran → 2 | Decision table | P1 |
| IT-GX-021 | GX-02 | Two planted failures: default stops after the first; `--keep-going` records both → 1 | Decision table; state | P2 |

### 4.2 Cases in full

Common preconditions unless stated: build `a3688f0` checked out; environment of §3; `ENV=dev`, `AUTH_SECRET=ci-secret-not-used-outside-ci-0123456789abcdef`. "Executed by" is Tester session I and the date is 2026-10-08 for every case; times are in §5.

---

#### IT-G1-001 — Replay the whole `api` job
- **Requirements:** REQ-G1-06, REQ-G4-02, REQ-G4-05, REQ-GX-03
- **Objective:** the `api` job, as written, is green on the PR head on a fresh database, on CI's Python, against a Postgres reached through a port mapping.
- **Preconditions:** worktree `/tmp/ci-replay` at `a3688f0`; fresh empty DB `reep_py` on the port-mapped cluster; `/tmp/py314` (3.14.6) first on `PATH` (stands in for `actions/setup-python`).
- **Test data:** job env from `ci.yml`; override `DATABASE_URL=…@localhost:5435/reep_py`; `PYTEST_ADDOPTS='-o addopts='` in the environment only, so pytest prints its summary (pytest.ini adds a second `-q`).
- **Steps:** 1. Parse `ci.yml`, take `jobs.api.steps`. 2. For each `run:` step, in order, run it with `bash --noprofile --norc -eo pipefail` in its `working-directory` with the job env. 3. Stop at the first non-zero step, as a runner does. 4. Record exit code, duration and key output per step.
- **Expected:** all six `run:` steps exit 0 in the order Install → Static analysis → Apply migrations → Migrations roll back → Seed → Run tests; pytest ≈ 2 060 passed, 0 failed.
- **Actual:** Install 0 (81.1 s); Static analysis 0 (43.8 s, "All checks passed!", mypy clean, guard "3 known"); Apply migrations 0 (4.4 s); Migrations roll back 0 (25.1 s, "OK: 90 of 92 downgrades … 3 segment(s) … 2118 lines, alembic check clean"); Seed 0 (3.0 s); Run tests 0 (307.9 s) — **2075 passed, 3 skipped, 2 warnings**. The count is 15 above the plan's estimate; 2 078 tests are collected (IT-G3-001), so the difference is the estimate, not a skip.
- **Verdict:** **Pass** · **Evidence:** `IT-G1-001-ci-api-job-replay.txt`, `IT-G1-001-replay_job.py.txt`

#### IT-G1-002 — Step order, names and commands match the contract
- **Requirements:** REQ-G1-06, REQ-G1-07, REQ-G4-05, REQ-GX-01
- **Objective:** the wiring in `ci.yml` is exactly what the plan says.
- **Preconditions:** head checked out; base `15a9e7d` available.
- **Steps:** 1. Load `ci.yml`; list jobs and the `api` steps with working-directory and command. 2. Compare with the contract list. 3. Diff `ci.yml` base→head. 4. Check where ruff/mypy/stubs are pinned and that `requirements.txt`/Dockerfile are unchanged.
- **Expected:** five jobs; `api` steps in contract order; static step immediately after "Install dependencies" with `python -m ruff check --config pyproject.toml . ../../tools/ci`, `python -m mypy`, `python ../../tools/ci/check_async_blocking.py`; round trip after "Apply migrations" and before "Seed"; the PR adds only those two steps; tools in `requirements-dev.txt` only.
- **Actual:** exactly as expected ("ORDER MATCHES CONTRACT: True", "ruff line exact: True", "mypy no args: True"); the diff adds only the two steps; `ruff==0.16.10`, `mypy==2.4.0`, two `types-` stubs in `requirements-dev.txt`, 0 in `requirements.txt`; only `requirements-dev.txt` changed (+17).
- **Verdict:** **Pass** · **Evidence:** `IT-G1-002.txt`

#### IT-G1-003 — Each tool's failure stops the job at the static step
- **Requirements:** REQ-G1-01, REQ-G1-03, REQ-G1-04, REQ-G1-06
- **Objective:** every one of the three commands in the step is wired so that its failure fails the step, and the job stops before touching the database.
- **Preconditions:** scratch worktree `/tmp/wtmig`; `DATABASE_URL` deliberately on a closed port (127.0.0.1:5499), so that if the static step did *not* stop the job, "Apply migrations" would fail instead and the evidence would show it.
- **Test data:** A — `qg_probe: int = "x"` appended to `app/clock.py` (mypy only); B — `eval("1")` appended to `tools/ci/check_pii_gate.py` (ruff S307, on the command's *second* path); C — new `app/qg_probe.py` with `async def qg_probe(db: Session = Depends(get_db))` (valid for ruff and mypy; async guard only).
- **Steps:** for each variant: plant → replay the job → record which step failed and why → revert → `git status` = 0.
- **Expected:** each variant: step 4 exits non-zero naming the planted line; steps 5–8 not run.
- **Actual:** A — `app/clock.py:62: error: Incompatible types in assignment` → step 4 exit 1; B — `S307 … --> tools/ci/check_pii_gate.py:105:1` → exit 1; C — "An `async def` under apps/api-py/app does blocking work … app/qg_probe.py:10: qg_probe: parameter `db` is Depends(get_db), a sync Session" → exit 1. In all three "JOB FAILED at this step; later steps not run". Tree restored each time.
- **Verdict:** **Pass** (see OBS-QG-I06 on first-failure-only reporting) · **Evidence:** `IT-G1-003.txt`

#### IT-G2-001 — Clean PR range → 0
- **Requirements:** REQ-G2-02
- **Objective:** the scan script, verbatim, passes the PR's real commits and tree.
- **Preconditions:** scratch clone `/tmp/ss-clone` of the repository; gitleaks 8.30.0 on PATH; script extracted verbatim from `secret-scan.yml` (`IT-G2-scan-step-extracted.sh.txt`).
- **Test data:** `EVENT=pull_request`, `BASE_SHA=15a9e7d1…`, `HEAD_SHA=a3688f0…`, `RUNNER_TEMP=/tmp/rt1`.
- **Steps:** run the script; inspect exit code, log and both JSON reports.
- **Expected:** exit 0; the range is reported; history and tree both "no leaks found"; reports are `[]`.
- **Actual:** "Range …: 23 non-merge commit(s), 20 adding lines"; "20 commits scanned"; both "no leaks found"; `history.json` and `tree.json` = `[]`; exit 0.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-001.txt`

#### IT-G2-002 — Secret added then removed → fails, located, redacted
- **Requirements:** REQ-G2-03, REQ-G2-06
- **Objective:** a secret that no longer exists in the tree but was pushed in the PR fails the check; logs and reports never carry the value.
- **Preconditions:** scratch branch `pr-leak` = head + empty commit + commit adding `apps/api-py/leak_probe.py` with `<fake ghp_ token, 40 chars>` + commit deleting it.
- **Steps:** run the script on `a3688f0..pr-leak`; count the raw token in log and JSON; print the finding's fields.
- **Expected:** non-zero; the finding names file, line, rule, commit; `Secret`/`Match` read REDACTED; raw token count 0.
- **Actual:** exit 1; `RuleID: github-pat`, `File: apps/api-py/leak_probe.py`, `Line: 1`, `Commit: 7ae6f4a…`, `Secret: REDACTED`, `Match: REDACTED`; raw token in `history.log` 0, in `history.json` 0.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-002.txt`

#### IT-G2-003 — Under GitHub's default shell both scans still run and one verdict is given
- **Requirements:** REQ-G2-03 (and the step's documented design, `secret-scan.yml:83` "Two scans, both always run, one verdict at the end")
- **Objective:** the step behaves as designed in the shell GitHub actually uses for a `run:` with no `shell:` — `bash -e` (`bash --noprofile --norc -eo pipefail`).
- **Preconditions:** as IT-G2-002.
- **Steps:** 1. Run the script with `bash --noprofile --norc -eo pipefail`. 2. Run it with plain `bash` for comparison. 3. Compare outputs and report files.
- **Expected:** in the GitHub shell: history finding reported, the tree scan still runs, the `::error::` verdict line ("gitleaks found a secret in the history scan … Rotate it first …") is printed, both `history.*` and `tree.*` reports exist, exit 1.
- **Actual:** GitHub shell: exit 1 after the history scan; **the tree scan never ran, no `::error::` line was printed, and only `history.json`/`history.log` exist**. Plain bash: both scans ran, the `::error::` line printed, all four report files present, exit 1. The step still fails closed, but its own verdict logic (lines 145–184) is unreachable whenever a scan finds something.
- **Verdict:** **Fail** → **DEF-QG-I01** · **Evidence:** `IT-G2-003.txt`

#### IT-G2-004 — Unresolvable range fails closed
- **Requirements:** REQ-G2-04
- **Objective:** no form of an unresolvable range scans nothing and passes.
- **Test data:** (a) base = an unknown 40-hex sha; (b) base empty; (c) head = `deadbeef`; (d) base = a *tree* object id.
- **Steps:** run the script once per variant under the GitHub shell.
- **Expected:** each exits non-zero with a `::error::` saying the commit is not in the clone; gitleaks never runs.
- **Actual:** (a)(b)(c)(d) all exit 1 with "the pull request's base|head commit '…' is not in this clone … Refusing rather than scanning nothing"; no report written.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-004.txt`

#### IT-G2-005 — Empty range → 0
- **Requirements:** REQ-G2-02 · **Technique:** boundary
- **Test data:** `BASE_SHA = HEAD_SHA = a3688f0…`.
- **Expected:** "0 non-merge commit(s), 0 adding lines"; "0 commits scanned" is accepted because nothing adds lines; tree scanned; exit 0.
- **Actual:** exactly that; tree "no leaks found"; exit 0.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-005.txt`

#### IT-G2-006 — Push mode: whole history and tree, clean
- **Requirements:** REQ-G2-02, REQ-G2-08
- **Preconditions:** scratch clone detached at the head; **full history** (see actual).
- **Test data:** `EVENT=push`, empty `BASE_SHA`/`HEAD_SHA`.
- **Expected:** range `HEAD`; every non-merge commit counted; no leaks in history or tree; exit 0.
- **Actual:** First run: the clone was shallow (219 of 724 commits — the test bed's clone, not the product). After `git fetch --unshallow` (what `fetch-depth: 0` gives the runner): "Range HEAD: 586 non-merge commit(s), 578 adding lines", "580 commits scanned", history and tree "no leaks found", exit 0 (21 s).
- **Verdict:** **Pass** · **Evidence:** `IT-G2-006.txt`

#### IT-G2-007 — A PR that only edits `.gitleaksignore`
- **Requirements:** REQ-G2-05, REQ-G2-07
- **Objective:** document how far a PR can weaken its own gate, and what stands in the way.
- **Test data:** branch `pr-ignore` = head + C1 (adds `apps/api-py/leak_probe.py` with `<fake ghp_ token, 40 chars>`, **kept**) + C2 (appends C1's history fingerprint `C1:apps/api-py/leak_probe.py:github-pat:1`) + C3 (appends the tree-mode fingerprint `apps/api-py/leak_probe.py:github-pat:1`).
- **Steps:** scan `head..C2`; scan `head..C3`; run the rule self-test; read CODEOWNERS and the rulesets' code-owner setting.
- **Expected (designed as a characterisation):** after C2 the tree scan still catches the token (a history fingerprint does not match the tree); after C3 the check is green — the repository can silence its own gate, and the only control is review of `.gitleaksignore` (CODEOWNERS).
- **Actual:** C2: history "no leaks found", tree `github-pat` at `apps/api-py/leak_probe.py` → exit 1. C3: both scans "no leaks found" → **exit 0 with a live-shaped token in the tree**. The rule self-test still passes ("13 leaks caught, 6 placeholder files quiet"). CODEOWNERS lists `.gitleaks.toml` and `.gitleaksignore` (lines 155–156) but all three rulesets have `"require_code_owner_review": false` and the only owner is the PR author's account.
- **Verdict:** **Pass** as a characterisation; residual risk raised as **OBS-QG-I01** · **Evidence:** `IT-G2-007.txt`

#### IT-G2-008 — Install step with the pinned hash
- **Requirements:** REQ-G2-01
- **Test data:** `GITLEAKS_VERSION=8.30.0`, `GITLEAKS_SHA256=79a3ab57…a66e`, `RUNNER_TEMP`, `GITHUB_PATH` files; script verbatim (`IT-G2-install-step-extracted.sh.txt`), GitHub shell.
- **Expected:** download, "OK" from `sha256sum --check --strict`, extracted binary prints `8.30.0`, its directory appended to `GITHUB_PATH`, exit 0.
- **Actual:** exactly that.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-008.txt`

#### IT-G2-009 — Install step with a wrong, stale or empty hash
- **Requirements:** REQ-G2-01
- **Test data:** (a) last hex digit changed; (b) version bumped to 8.29.1 without the hash; (c) empty hash.
- **Expected:** each exits non-zero at the checksum; nothing extracted; `GITHUB_PATH` unchanged.
- **Actual:** (a) "FAILED … 1 computed checksum did NOT match", exit 1, `GITHUB_PATH` empty, no binary; (b) same, exit 1; (c) "no properly formatted checksum lines found", exit 1.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-009.txt`

#### IT-G2-010 — "Prove the rules" step
- **Requirements:** REQ-G2-05
- **Steps:** 1. Run `python3 tools/ci/check_gitleaks_rules.py` as the workflow does. 2. In the scratch clone, delete the `reep-auth-secret` rule block from `.gitleaks.toml`, run it again, revert.
- **Expected:** 1 → 0 with every replayed leak caught; 2 → non-zero naming the leaks no longer caught.
- **Actual:** 1 → "OK: 13 leaks caught, 6 placeholder files quiet", exit 0. 2 → "FAILED: l02/docker-compose.yml … l07/k8s/secret.yaml is a leak the rules no longer catch", exit 1; reverted, clean.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-010.txt`

#### IT-G2-011 — pre-commit hook agrees with the CI gate
- **Requirements:** REQ-G2-06 (and the pin-together rule in `secret-scan.yml`'s env comment)
- **Steps:** 1. Compare `.pre-commit-config.yaml`'s gitleaks `rev` with `GITLEAKS_VERSION`. 2. `pre-commit run gitleaks --all-files` on the clean head. 3. Stage the fake-token file and run it again.
- **Expected:** equal versions; clean → Passed; staged token → Failed with `github-pat`, redacted.
- **Actual:** `v8.30.0` = `8.30.0`; clean → "Passed", exit 0; staged → "Failed", `RuleID: github-pat`, `File: apps/api-py/leak_probe.py`, `Secret: REDACTED`, raw token 0 occurrences, exit 1. Same rule and file the CI scan reports for the same content (IT-G2-002).
- **Verdict:** **Pass** · **Evidence:** `IT-G2-011.txt`

#### IT-G2-012 — Real-shaped token beside an allowlisted dev value
- **Requirements:** REQ-G2-05
- **Test data:** control commit: `apps/api-py/.env.qg` = `AUTH_SECRET=ci-secret-not-used-outside-ci-0123456789abcdef` only; second commit: the same line plus `GITHUB_TOKEN=<fake ghp_ token, 40 chars>`.
- **Expected:** control → 0 (the published CI value is allowlisted); same line with the token → 1, `github-pat`, redacted.
- **Actual:** control → "no leaks found" ×2, exit 0; with token → `RuleID: github-pat`, `File: apps/api-py/.env.qg`, `Line: 1`, exit 1; raw token 0 occurrences in reports.
- **Verdict:** **Pass** · **Evidence:** `IT-G2-012.txt`

#### IT-G3-001 — Audit without a database, order-independent, collected by CI
- **Requirements:** REQ-G3-01, REQ-G3-08
- **Steps:** 1. `pytest tests/test_route_audit.py` with `DATABASE_URL` on a closed port and `REEP_REQUIRE_DB` unset. 2. Same audit first, then guards and release-gate tests. 3. Reverse order. 4. In the CI checkout, `pytest --collect-only` the way CI's step collects.
- **Expected:** 17 passed each time; collection includes the audit.
- **Actual:** 17 passed; 92 passed; 92 passed; CI collection: 17 `tests/test_route_audit.py::` items of "2078 tests collected".
- **Verdict:** **Pass** · **Evidence:** `IT-G3-001.txt`

#### IT-G3-002 — New unauthenticated route mounted in the real app
- **Requirements:** REQ-G3-02, REQ-G3-04
- **Test data:** new module `app/routers/qg_route.py` (`GET /api/qg/probe`, plain `def`, no session, no response model) and `app.include_router(qg_route.router)` in `app/main.py`, in the scratch worktree.
- **Expected:** the audit fails, naming the handler, under AUTH and RESPONSE MODEL.
- **Actual:** 2 failed / 15 passed: "GET /api/qg/probe (app.routers.qg_route.qg_open_probe: no session dependency)" and "(…: JSON body with no response model)". Reverted, clean.
- **Verdict:** **Pass** · **Evidence:** `IT-G3-002.txt`

#### IT-G4-001 — Round-trip step inside the CI replay
- **Requirements:** REQ-G4-02, REQ-G4-05
- **Objective:** in the job's own sequence the round trip runs on the freshly migrated DB, passes, and the seed and suite then run on the straight-path DB.
- **Steps / data:** as IT-G1-001.
- **Expected:** step 6 exit 0 between "Apply migrations" and "Seed"; scratch `reep_py_roundtrip` dropped afterwards.
- **Actual:** step 6 exit 0 (25.1 s): head `f4a2c9e7b1d3`, floor `9b2d47f0ce15`, segments base..31ca99852acd (66), 7c4e0b21d9aa..31f7a4c60b12 (2), 9b2d47f0ce15..f4a2c9e7b1d3 (22), "90 of 92 downgrades", 2118 catalogue lines, `alembic check` clean; database list afterwards has no `reep_py_roundtrip`.
- **Verdict:** **Pass** · **Evidence:** `IT-G1-001-ci-api-job-replay.txt`, `IT-G4-002-topology.txt`

#### IT-G4-002 — CI topology: Postgres behind a port mapping
- **Requirements:** REQ-G4-02 (regression of the fixed CI defect "server reports it is listening on 172.18.0.2")
- **Preconditions:** cluster listening only on 192.0.2.2; socat forwarder on 127.0.0.1:5435; SCRAM auth.
- **Steps:** 1. Build the topology; prove `inet_server_addr()` = 192.0.2.2 through the forwarder and that a password is required. 2. Run the round trip through `localhost:5435` (inside IT-G1-001).
- **Expected:** the server reports a non-loopback address, yet the round trip passes (the URL's host is loopback and the server is not managed).
- **Actual:** `192.0.2.2|5432|PostgreSQL 16.15`; no-password connection refused ("fe_sendauth: no password supplied"); round trip OK (IT-G4-001).
- **Verdict:** **Pass** · **Evidence:** `IT-G4-002-topology.txt`, `IT-G1-001-ci-api-job-replay.txt`

#### IT-G4-003 — Seeded database and `--plan`
- **Requirements:** REQ-G4-02
- **Preconditions:** the CI-topology `reep_py` after the replay (seeded, suite run).
- **Steps:** 1. `--plan`; check no scratch DB was created. 2. Fingerprint the schema and three row counts; full round trip; fingerprint again.
- **Expected:** `--plan` prints the segments and exits 0 creating nothing; the full run passes on seeded data and changes neither schema nor rows.
- **Actual:** `--plan` exit 0, 0 scratch DBs; full run "OK: 90 of 92 …" exit 0; schema md5 `ed17a26a…` before = after; rows (users, students, registrations) `5|2|3` before = after.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-003.txt`

#### IT-G4-004 — Injected defect A: downgrade omits its `drop_column`
- **Requirements:** REQ-G4-01, REQ-G4-03
- **Test data:** `f4a2c9e7b1d3`'s downgrade body replaced by `pass`; fresh `reep_inj`.
- **Steps:** `alembic upgrade head`; round trip; `tests/test_migration_reversibility.py`; revert.
- **Expected:** round trip fails with a catalogue diff naming the leftover column; the static test fails naming the revision; no scratch DB left.
- **Actual:** upgrade 0; round trip FAILED at the bottom of segment `9b2d47f0ce15 .. f4a2c9e7b1d3`: `+column | registrations | submission_key_hash | character varying(64)`, exit 1, 0 scratch DBs left; static test: "f4a2c9e7b1d3 (f4a2c9e7b1d3_registration_submission_key.py): downgrade is no-op" (1 failed, 9 passed). Reverted.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-004.txt`

#### IT-G4-005 — Injected defect A2: a downgrade that looks like work
- **Requirements:** REQ-G4-01, REQ-G4-03 · **Technique:** bypass of the static test
- **Test data:** downgrade body `op.execute("SELECT 1")` instead of the `drop_column`.
- **Expected:** the static test may accept it; the round trip must still catch it.
- **Actual:** static test 10 passed (bypassed, as expected — it can only see a no-op); round trip FAILED with the same `+column … submission_key_hash` diff, exit 1. The two gates together close the gap neither closes alone.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-005.txt`

#### IT-G4-006 — Injected defect B: wrong default restored
- **Requirements:** REQ-G4-03
- **Test data:** upgrade also sets `registrations.status` default to `PENDING_REVIEW`; downgrade restores `HOLD` (original `DRAFT`).
- **Expected:** invisible at the top; caught at the segment bottom with a diff naming the column and both defaults.
- **Actual:** FAILED at `9b2d47f0ce15`: `-column | registrations | status | … 'DRAFT'::registration_status` / `+… 'HOLD'::registration_status`; exit 1. Static test 10 passed (out of its scope). Reverted; DB dropped.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-006.txt`

#### IT-G4-007 — One head; `alembic check` clean
- **Requirements:** REQ-G4-01, REQ-G4-02
- **Steps:** on the dev bed `reep_py`: upgrade head, `alembic heads`, count, `alembic check`, `alembic current`.
- **Expected:** one head `f4a2c9e7b1d3`; "No new upgrade operations detected"; current = head.
- **Actual:** as expected; `CHECK_EXIT=0`.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-007.txt`

#### IT-G4-008 — Refusals against real endpoints
- **Requirements:** REQ-G4-04
- **Test data / steps:** (a) URL straight to `192.0.2.2:5432`; (b) `localhost` URL + `?hostaddr=192.0.2.2`; (c) `?host=192.0.2.2`; (d) `ENV=production`; (e) `ENV=staging`; (f) DB `reep_prodcopy`; (g) a migrated, loopback DB whose server answers `current_setting('rds.superuser_variables')` (set with `ALTER DATABASE`, simulating RDS behind a tunnel).
- **Expected:** every one refuses, exit non-zero, with the reason; (g) refuses at the managed-server question and creates no scratch DB.
- **Actual:** (a)(b)(c) "the connection would go to ['192.0.2.2'], which is not loopback" exit 1; (d)(e) "ENV='production'|'staging' is not a development environment" exit 1; (f) "the database is named 'reep_prodcopy', which says production" exit 1; (g) plan printed, then "refusing to run: the server defines rds.superuser_variables, which only Amazon RDS does" exit 1, 0 scratch DBs.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-008.txt`

#### IT-G4-009 — Standalone round trip leaves the dev DB byte-identical
- **Requirements:** REQ-G4-06
- **Steps:** seed `reep_py`; `pg_dump` (schema + data) md5 and the tuple-write counter; run the round trip; repeat both.
- **Expected:** identical dump; counter unchanged; no `reep_py_roundtrip` left.
- **Actual:** md5 `3ad7760e…` before = after ("FULL DUMP (schema+data) IDENTICAL"); `n_tup_ins+upd+del` 315 = 315; 0 scratch DBs.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-009.txt`

#### IT-G4-010 — After a full preflight: dev schema identical, no scratch DB
- **Requirements:** REQ-G4-06
- **Steps:** schema-only dump md5 and per-table live rows before IT-GX-011; repeat after.
- **Expected:** schema identical; rows change only through the seed and the suite (the round trip writes nothing); no `*roundtrip*` DB.
- **Actual:** schema md5 `1e1ca80c…` before = after; row changes are all in tables the suite and seed write (login_events, mail_logs, audit/outbox events, …); 0 `*roundtrip*` DBs.
- **Verdict:** **Pass** · **Evidence:** `IT-G4-010.txt`

#### IT-GX-001 — §34 green on the head
- **Requirements:** REQ-GX-01, REQ-G2-07
- **Steps:** run the §34 test alone and the whole `test_codebase_guards.py`.
- **Expected:** pass. · **Actual:** 1 passed; 59 passed.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-001.txt`

#### IT-GX-002 — Rename the secret-scan job
- **Requirements:** REQ-G2-07, REQ-GX-01
- **Test data:** `name: Secrets (gitleaks)` → `Secrets (gitleaks v8)` in `secret-scan.yml` (scratch worktree).
- **Expected:** §34 fails naming the workflow and the expected name.
- **Actual:** "the rulesets require 'Secrets (gitleaks)', which .github/workflows/secret-scan.yml does not report (its jobs report ['Secrets (gitleaks v8)'])", exit 1. Reverted.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-002.txt`

#### IT-GX-003 — Drop "Secrets (gitleaks)" from `dev.json`
- **Requirements:** REQ-G2-07
- **Expected:** §34 fails naming `dev.json`.
- **Actual:** first attempt did not apply the mutation (a here-document inside the evidence wrapper; a test-execution error, recorded); re-executed with the mutation in a script: "dev.json requires standalone checks [], but is declared to require ['Secrets (gitleaks)']", exit 1. Reverted.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-003.txt`

#### IT-GX-004 — Rename a `ci.yml` job
- **Requirements:** REQ-GX-01
- **Test data:** `Web (Angular)` → `Web (Angular 22)`.
- **Expected:** §34 fails ("the committed ruleset and ci.yml disagree").
- **Actual:** exactly that (`test_codebase_guards.py:1790`), exit 1. Reverted (a first restore ran from a subdirectory; re-restored from the root, porcelain 0 — recorded).
- **Verdict:** **Pass** · **Evidence:** `IT-GX-004.txt`

#### IT-GX-005 — Remove or rename a check in `preflight.sh`
- **Requirements:** REQ-GX-01, REQ-GX-02
- **Objective:** §34 says preflight must "run, or name" every required check; test that it notices when a check stops running.
- **Test data (scratch worktree):** A — rename the check in its one functional line (`local name="Secrets (gitleaks)"` → `"Secret scan"`); B — delete both `check_secrets` invocations (preflight never runs the secret scan); C — delete both `check_web` invocations; D (control) — remove every occurrence of the string `Web (Angular)`.
- **Expected:** A, B, C and D each make §34 fail.
- **Actual:** **A: 1 passed. B: 1 passed. C: 1 passed.** D: failed, "tools/ci/preflight.sh does not run, or does not name, ['Web (Angular)']". After A the string still occurs 3× in the file, after B/C 4× — all in comments and the usage text. The comparison (`test_codebase_guards.py:1808` and `:1819`) is a substring test over the whole file, so any comment satisfies it.
- **Verdict:** **Fail** → **DEF-QG-I02** · **Evidence:** `IT-GX-005.txt`

#### IT-GX-006 — Remove the secret scan from `protect-main.sh`
- **Requirements:** REQ-G2-07
- **Test data:** delete `"Secrets (gitleaks)|.github/workflows/secret-scan.yml"` from `STANDALONE_CHECKS`.
- **Expected:** §34 fails.
- **Actual:** "protect-main.sh's STANDALONE_CHECKS disagree with what main.json requires outside ci.yml: {'Branch policy (promotion path)': …}", exit 1. Reverted.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-006.txt`

#### IT-GX-007 — `protect-main.sh --dry-run`
- **Requirements:** REQ-G2-07, REQ-GX-01
- **Preconditions:** a logging `gh` shim first on PATH (records every call; refuses any PUT), so nothing can reach GitHub; run (a) unauthenticated, (b) authenticated.
- **Expected:** exit 0; the payload lists the seven checks (five + Branch policy + Secrets); "nothing was sent"; no write call.
- **Actual:** exit 0 both times; the AFTER block and the `PUT … /protection` payload list all seven contexts; "--dry-run: nothing was sent."; 0 PUTs. The script does make **read-only** calls in dry-run: `gh auth status`, and `gh api repos/…/branches/main/protection` (even when unauthenticated), plus `gh api repos/darshani8/reep-` when authenticated — see OBS-QG-I02.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-007.txt`

#### IT-GX-008 — The three rulesets
- **Requirements:** REQ-G2-07, REQ-GX-01 · **Technique:** decision table (branch → required set)
- **Expected:** all parse; main and stage = five + Secrets + Branch policy; dev = five + Secrets; no duplicates.
- **Actual:** "ALL OK"; each active, target branch, `strict` true; contexts exactly as expected; no duplicates.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-008.txt`

#### IT-GX-009 — `release_gate.py` and this PR's paths
- **Requirements:** REQ-GX-01 (gate wiring around the PR)
- **Steps:** 1. `tests/test_release_gate.py`. 2. `release_gate.py --base 15a9e7d --head a3688f0` as `agent-release.yml:98` calls it. 3. Classify key paths one by one through stdin.
- **Expected:** tests pass; the PR is not auto-deployable, with migrations and the gate itself named; `.gitleaksignore` classified exactly as `.gitleaks.toml`.
- **Actual:** 16 passed. PR verdict `target: api-only`, `auto_ok: false`, 41 reasons: 19 migrations, 12 sensitive files, 6 model changes, "tools/ci/release_gate.py: this gate changed", "169 files changed (more than 40)", and 2 "not a path this gate knows how to classify" (the test plan under `testing/`). `.gitleaksignore` and `.gitleaks.toml` → identical (`none`, `auto_ok: false`, no reason). `ci.yml`/`secret-scan.yml`/rulesets are NO_DEPLOY (not "human required"), which matches AGENTS.md's list (only the deploy pipelines and the gate are refused) — see OBS-QG-I05.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-009.txt`

#### IT-GX-010 — actionlint and parsing
- **Requirements:** REQ-GX-01
- **Expected:** every workflow lint-clean; every workflow, pre-commit and ruleset file parses.
- **Actual:** all parse. actionlint 1.7.7: one finding, `ops-task.yml:30` "maximum number of inputs for workflow_dispatch is 10 but 14" — an outdated rule (GitHub's limit is now 25) in a file this PR does not touch; actionlint 1.7.12: 13 workflows, exit 0.
- **Verdict:** **Pass** (OBS-QG-I04) · **Evidence:** `IT-GX-010.txt`

#### IT-GX-011 — Full preflight on a clean tree
- **Requirements:** REQ-GX-02, REQ-GX-03, REQ-G4-06
- **Preconditions:** main checkout clean (only untracked evidence); CDK venv, node_modules, gitleaks 8.30.0, Postgres up; `reep_py`.
- **Expected:** six checks in order 1 API deps → 2 Rule 1 → 3 Secrets → 4 CDK → 5 Web → 6 API; check 6 runs static analysis → `alembic upgrade head` → round trip → seed → pytest; all PASS; exit 0.
- **Actual:** exactly that order; CDK "141 passed, 22 skipped"; Web "Test Files 32 passed, Tests 226 passed", build passed; check 6: ruff "All checks passed!", mypy clean, guard "3 known", round trip "OK: 90 of 92 …", seed, pytest exit 0; all six PASS; "READY."; **exit 0** (7 m 57 s).
- **Verdict:** **Pass** · **Evidence:** `IT-GX-011-preflight-full.txt`

#### IT-GX-012 — `--quick`
- **Requirements:** REQ-GX-02
- **Expected:** checks 1–4 PASS, Web PARTIAL ("ng test and ng build did NOT run"), API SKIP "--quick", "INCOMPLETE", exit 2.
- **Actual:** exactly that; exit 2.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-012.txt`

#### IT-GX-013 — gitleaks absent
- **Requirements:** REQ-GX-02
- **Preconditions:** worktree with all other prerequisites; `PATH` without `/usr/local/bin`; DB `reep_pf`.
- **Expected:** check 3 SKIP with the install hint; every other check PASS; exit 2.
- **Actual:** "SKIP Secrets (gitleaks) - gitleaks is not on PATH - install v8.30.0, the version secret-scan.yml pins"; five PASS; "INCOMPLETE"; exit 2.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-013-preflight-no-gitleaks.txt`

#### IT-GX-014 — Secret in an uncommitted change to a tracked file
- **Requirements:** REQ-GX-02, REQ-G2-06
- **Test data:** `GITHUB_TOKEN=<fake ghp_ token, 40 chars>` appended to the tracked `tools/ci/README.md`, not staged; `--quick`.
- **Expected:** check 3 FAIL with the rotate-first note; exit 1; raw token never printed.
- **Actual:** the `--pre-commit` scan reports "leaks found: 1"; "FAIL Secrets (gitleaks)"; "NOT READY"; exit 1; raw token 0 occurrences. The output says nothing about **where** the secret is (no file, line or rule): preflight runs gitleaks without `--verbose` — see DEF-QG-I04.
- **Verdict:** **Pass** (exit-code row); location gap → DEF-QG-I04 · **Evidence:** `IT-GX-014.txt`

#### IT-GX-015 — Secret in a new, untracked file
- **Requirements:** REQ-GX-02 (preflight.sh:434-437: it scans "what you have not committed yet, staged or not")
- **Test data:** new file `apps/api-py/app/leak_probe.py` with `<fake ghp_ token, 40 chars>`, never `git add`ed; `--quick`.
- **Expected:** check 3 FAIL → exit 1.
- **Actual:** all three git scans and the `git archive HEAD` tree scan report "no leaks found"; **"PASS Secrets (gitleaks)"**; exit 2 (from the `--quick` SKIPs only). `git diff`-based `--pre-commit` and `--staged` modes never see an untracked file, and the tree scan reads HEAD, not the working directory.
- **Verdict:** **Fail** → **DEF-QG-I03** · **Evidence:** `IT-GX-015.txt`

#### IT-GX-016 — The same file staged
- **Requirements:** REQ-GX-02
- **Expected:** check 3 FAIL → exit 1.
- **Actual:** the `--staged` scan reports "leaks found: 1"; FAIL; exit 1; raw token 0 occurrences; no location printed (DEF-QG-I04).
- **Verdict:** **Pass** · **Evidence:** `IT-GX-016.txt`

#### IT-GX-017 — Another gitleaks version first on PATH
- **Requirements:** REQ-GX-02 · **Technique:** boundary (version ≠ pin)
- **Test data:** gitleaks 8.18.4 (checksum-verified) first on PATH; `--quick`.
- **Expected:** environment line shows "8.18.4, CI pins 8.30.0"; check 3 SKIP naming both versions; no gitleaks scan run; exit 2.
- **Actual:** exactly that; 0 `gitleaks git` invocations; exit 2.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-017.txt`

#### IT-GX-018 — `--skip-db-setup`
- **Requirements:** REQ-GX-02, REQ-G4-06
- **Preconditions:** `reep_py` already migrated and seeded; main checkout.
- **Expected:** migrations, round trip and seed not run (and said so); pytest runs; check 6 PARTIAL "the migration round trip did not run"; exit 2.
- **Actual:** 0 occurrences of `alembic upgrade`/round trip/`app.seed` in the output; the `--skip-db-setup` note printed; pytest ran; "PARTIAL API (FastAPI + Postgres) - --skip-db-setup: the migration round trip did not run"; others PASS; exit 2.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-018-preflight-skip-db-setup.txt`

#### IT-GX-019 — Type error in `app/`
- **Requirements:** REQ-GX-02, REQ-G1-03
- **Preconditions:** worktree without `node_modules` (check 5 SKIPs — which alone would give 2, so exit 1 can only come from a FAIL).
- **Test data:** `qg_probe: int = "not an int"` appended to `app/clock.py`.
- **Expected:** check 6 FAIL at static analysis, before any DB work; exit 1.
- **Actual:** ruff passed, mypy "app/clock.py:62: error: Incompatible types in assignment", the guard still ran, "FAIL … static analysis failed (ruff, mypy or the async-blocking guard)"; no alembic run; exit 1. Reverted.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-019.txt`

#### IT-GX-020 — Postgres unreachable
- **Requirements:** REQ-GX-02
- **Test data:** `DATABASE_URL` on 127.0.0.1:5499 (nothing listening — what the probe sees when the server is stopped). Stopping the shared dev cluster would have broken the concurrent runs; the probe outcome is identical.
- **Expected:** environment line "NOT REACHABLE"; check 6 runs static analysis, then SKIP "static analysis ran; the rest needs Postgres"; exit 2.
- **Actual:** exactly that; exit 2.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-020.txt`

#### IT-GX-021 — Two planted failures, with and without `--keep-going`
- **Requirements:** REQ-GX-02
- **Test data:** `app/qg_pii.py` calls `complete_chat` without `carries_student_data` (check 2) + type error in `app/clock.py` (check 6).
- **Expected:** default: check 2 FAIL, checks 3–6 SKIP "a previous check failed", exit 1. `--keep-going`: checks 2 and 6 both FAIL, the rest run, exit 1.
- **Actual:** default: "FAIL Rule 1 …" naming `apps/api-py/app/qg_pii.py:5 complete_chat(...)`, 3–6 SKIP with that reason, exit 1. `--keep-going`: Rule 1 FAIL, Secrets/CDK/Web PASS, API FAIL (mypy line 62), exit 1. Reverted.
- **Verdict:** **Pass** · **Evidence:** `IT-GX-021.txt`

---

## 5. Test execution log

Times are UTC start times on 2026-10-08, in execution order (long runs overlapped shorter ones, each on its own database).

| ID | Start (UTC) | Verdict | Evidence file | Notes |
|---|---|---|---|---|
| (env) | 08:34:41 | — | `ENV-versions.txt` | Versions recorded |
| IT-G4-002 | 08:34:49 | Pass | `IT-G4-002-topology.txt` | Topology built; result read from the replay |
| IT-G1-001 | 08:35 | Pass | `IT-G1-001-ci-api-job-replay.txt` | Ran 08:35–08:43, Python 3.14 |
| IT-G4-001 | 08:35 | Pass | `IT-G1-001-ci-api-job-replay.txt` | Step 6 of the replay |
| IT-G2-001 | 08:36:00 | Pass | `IT-G2-001.txt` | |
| IT-G2-002 | 08:36:19 | Pass | `IT-G2-002.txt` | |
| IT-G2-003 | 08:36:41 | **Fail** | `IT-G2-003.txt` | DEF-QG-I01 |
| IT-G2-004 | 08:37:06 | Pass | `IT-G2-004.txt` | 4 variants |
| IT-G2-005 | 08:37:06 | Pass | `IT-G2-005.txt` | |
| IT-G2-006 | 08:37:13 | Pass | `IT-G2-006.txt` | Re-run after unshallowing (08:38) |
| IT-G2-007 | 08:39:24 | Pass | `IT-G2-007.txt` | OBS-QG-I01 |
| IT-G2-008 | 08:40:02 | Pass | `IT-G2-008.txt` | |
| IT-G2-009 | 08:40:03 | Pass | `IT-G2-009.txt` | 3 variants |
| IT-G2-010 | 08:40:12 | Pass | `IT-G2-010.txt` | |
| IT-GX-010 | 08:40:18 | Pass | `IT-GX-010.txt` | OBS-QG-I04 |
| IT-GX-001 | 08:40:48 | Pass | `IT-GX-001.txt` | |
| IT-GX-002 | 08:41:07 | Pass | `IT-GX-002.txt` | |
| IT-GX-003 | 08:41:09 | Pass | `IT-GX-003.txt` | First attempt invalid (execution error), re-run |
| IT-GX-004 | 08:41:12 | Pass | `IT-GX-004.txt` | |
| IT-GX-005 | 08:41:45 | **Fail** | `IT-GX-005.txt` | DEF-QG-I02 |
| IT-GX-006 | 08:42:06 | Pass | `IT-GX-006.txt` | |
| IT-GX-007 | 08:42:25 | Pass | `IT-GX-007.txt` | OBS-QG-I02 |
| IT-GX-008 | 08:42:34 | Pass | `IT-GX-008.txt` | |
| IT-GX-009 | 08:42:43 | Pass | `IT-GX-009.txt` | OBS-QG-I05 |
| IT-G4-003 | 08:43:54 | Pass | `IT-G4-003.txt` | |
| IT-G4-004 | 08:44:28 | Pass | `IT-G4-004.txt` | |
| IT-G4-005 | 08:45:01 | Pass | `IT-G4-005.txt` | |
| IT-G4-006 | 08:45:24 | Pass | `IT-G4-006.txt` | |
| IT-G4-007 | 08:46:04 | Pass | `IT-G4-007.txt` | |
| IT-G4-008 | 08:46:10 | Pass | `IT-G4-008.txt` | 7 variants |
| IT-G4-009 | 08:46:57 | Pass | `IT-G4-009.txt` | |
| IT-GX-014 | 08:47:47 | Pass | `IT-GX-014.txt` | DEF-QG-I04 (location) |
| IT-GX-015 | 08:48:06 | **Fail** | `IT-GX-015.txt` | DEF-QG-I03 |
| IT-GX-016 | 08:49:05 | Pass | `IT-GX-016.txt` | |
| IT-GX-019 | 08:51:36 | Pass | `IT-GX-019.txt` | |
| IT-GX-020 | 08:53:05 | Pass | `IT-GX-020.txt` | |
| IT-GX-011 | 08:55 | Pass | `IT-GX-011-preflight-full.txt` | 7 m 57 s |
| IT-GX-013 | 09:01 | Pass | `IT-GX-013-preflight-no-gitleaks.txt` | Ran in parallel with IT-GX-018, separate DBs |
| IT-GX-018 | 09:01 | Pass | `IT-GX-018-preflight-skip-db-setup.txt` | |
| IT-G4-010 | 09:03:57 | Pass | `IT-G4-010.txt` | |
| IT-G2-011 | 09:04:22 | Pass | `IT-G2-011.txt` | |
| IT-G1-003 | 09:06:20 | Pass | `IT-G1-003.txt` | 3 variants |
| IT-G3-001 | 09:07:42 | Pass | `IT-G3-001.txt` | |
| IT-G3-002 | 09:08:08 | Pass | `IT-G3-002.txt` | |
| IT-GX-012 | 09:12:17 | Pass | `IT-GX-012.txt` | |
| IT-GX-017 | 09:13:15 | Pass | `IT-GX-017.txt` | |
| IT-GX-021 | 09:14:17 | Pass | `IT-GX-021.txt` | |
| IT-G1-002 | 09:16:30 | Pass | `IT-G1-002.txt` | |
| IT-G2-012 | 09:16:44 | Pass | `IT-G2-012.txt` | |

---

## 6. Defects and observations

### DEF-QG-I01 — Secret-scan step aborts after the first scan that finds something: the tree scan and the verdict never run

| Field | Value |
|---|---|
| Severity / Priority | **Minor / P2** |
| Requirement | REQ-G2-03; the step's own design (`secret-scan.yml:83-85`, "Two scans, both always run, one verdict at the end -- so a leak in the history does not hide whether the tree is clean") |
| Build / environment | `a3688f0`; gitleaks 8.30.0; bash 5.2 |
| Preconditions | A PR range in which the history scan finds a secret (scratch branch `pr-leak`) |
| Steps to reproduce | 1. Extract the "Scan the commits and the tree" `run:` verbatim. 2. Run it with `bash --noprofile --norc -eo pipefail <script>` (GitHub's shell for a `run:` with no `shell:` — `-e` is always on) with `EVENT=pull_request`, `BASE_SHA`, `HEAD_SHA`, `RUNNER_TEMP`. 3. Run it again with plain `bash`. |
| Expected | Under GitHub's shell: history finding reported, tree scan runs, `::error::gitleaks found a secret in the history scan … Rotate it first …` printed, `history.*` and `tree.*` reports uploaded, exit 1 |
| Actual | Exit 1 immediately after the history pipeline: no tree scan, no `::error::` annotation, only `history.json`/`history.log` exist. Plain bash gives the designed behaviour. Same for the tree pipeline: a tree finding exits before the verdict loop. Fails **closed** — never a false pass. |
| Evidence | `IT-G2-003.txt` |
| Frequency | Always |
| Suspected component | `.github/workflows/secret-scan.yml:118` `set -uo pipefail` leaves the runner's `-e` on, so the failing pipeline at `:141-144` (`gitleaks … | tee …history.log`) terminates the script before `history=$?` (`:145`); likewise the tree pipeline before `tree=$?`. Not fixed by the tester. |

### DEF-QG-I02 — §34 accepts a `preflight.sh` that no longer runs a required check

| Field | Value |
|---|---|
| Severity / Priority | **Major / P2** |
| Requirement | REQ-GX-01, REQ-GX-02 |
| Build / environment | `a3688f0`; Python 3.13 venv |
| Preconditions | Scratch worktree |
| Steps to reproduce | A: in `tools/ci/preflight.sh` change `local name="Secrets (gitleaks)"` to `local name="Secret scan"`. B: delete both lines `  check_secrets`. C: delete both lines `  check_web`. For each, run `pytest tests/test_codebase_guards.py::test_the_five_required_check_names_agree_across_all_four_files`. |
| Expected | Each fails: preflight no longer records (A) or no longer runs (B, C) a required check |
| Actual | All three pass (1 passed). The string still appears 3–4 times in comments, the banner and the usage text. Only removing **every** occurrence (control D) fails. |
| Evidence | `IT-GX-005.txt` |
| Frequency | Always |
| Suspected component | `apps/api-py/tests/test_codebase_guards.py:1808` (`n not in preflight`) and `:1819` — a substring test over the whole file, comments included. The five-check half is inherited from the base (`15a9e7d`, line 1745); this PR extended the same test to "Secrets (gitleaks)". The test's own docstring states the property it does not check ("It names each check in the `record` call that reports it"). |

### DEF-QG-I03 — Preflight's secret check passes a secret in a new, untracked file

| Field | Value |
|---|---|
| Severity / Priority | **Major / P2** |
| Requirement | REQ-GX-02; `tools/ci/preflight.sh:434-437` ("this scans … and - which no runner ever sees - what you have not committed yet, staged or not") |
| Build / environment | `a3688f0`; gitleaks 8.30.0 |
| Preconditions | Clean worktree |
| Steps to reproduce | 1. Create `apps/api-py/app/leak_probe.py` containing `GITHUB_TOKEN = "<a ghp_ token>"`; do not `git add` it. 2. `bash tools/ci/preflight.sh --quick`. |
| Expected | Check 3 FAIL; exit 1 |
| Actual | Check 3 **PASS** (`--pre-commit` and `--staged` read `git diff`, which excludes untracked files; the tree scan reads `git archive HEAD`); exit 2 only because `--quick` skips checks. Once staged, it is caught (IT-GX-016). A new `.env`-style file is the commonest way a secret is created, and the most likely file to be added with `git add -A` right after a green preflight. CI would still catch it once pushed — which is exactly what the local check exists to prevent ("a pushed AUTH_SECRET has no un-push"). |
| Evidence | `IT-GX-015.txt` |
| Frequency | Always |
| Suspected component | `tools/ci/preflight.sh:474-484` (`check_secrets`): no scan of untracked, non-ignored files (e.g. `gitleaks dir` over `git ls-files --others --exclude-standard`). |

### DEF-QG-I04 — Preflight's secret check does not say where the secret is

| Field | Value |
|---|---|
| Severity / Priority | **Minor / P3** |
| Requirement | REQ-G2-06 ("the log says where the finding is"), applied to the local runner |
| Steps to reproduce | As IT-GX-014 or IT-GX-016 |
| Expected | File, line and rule printed (redacted), as the CI step prints with `--verbose` |
| Actual | Only "WRN leaks found: 1" and "FAIL … gitleaks found a secret (or could not finish)"; no file, line or rule. On a large uncommitted change the developer has to re-run gitleaks by hand to find it. |
| Evidence | `IT-GX-014.txt`, `IT-GX-016.txt` |
| Frequency | Always |
| Suspected component | `tools/ci/preflight.sh:461-462` — `cfg` has `--redact` but not `--verbose`. |

### Observations

**OBS-QG-I01 — The repository can silence its own secret gate in one PR.** A PR that plants a token and adds both its history and tree fingerprints to `.gitleaksignore` turns "Secrets (gitleaks)" green (IT-G2-007). The designed mitigation, CODEOWNERS on `.gitleaks.toml`/`.gitleaksignore`, has no effect today: every ruleset has `require_code_owner_review: false`, the only owner is the PR author, and `release_gate.py` classifies both files NO_DEPLOY. CODEOWNERS says this itself. Residual risk for the product owner to accept; a cheap detector would be a CI step that fails when a PR adds an ignore entry pointing at a commit inside the PR's own range.

**OBS-QG-I02 — `protect-main.sh --dry-run` makes read-only API calls.** It never writes ("nothing was sent" holds, 0 PUTs), but it calls `gh auth status`, `gh api repos/…/branches/main/protection` (even unauthenticated) and `gh api repos/darshani8/reep-` (authenticated) to print the NOW block (IT-GX-007). If "dry-run" is meant as "offline", the usage text should say it reads.

**OBS-QG-I03 — The `testing/` folder is not known to the release gate.** `testing/docs/...` is "not a path this gate knows how to classify", so any PR carrying test documentation is refused auto-deploy (IT-GX-009). Fails safe; noise only.

**OBS-QG-I04 — actionlint 1.7.7 reports `ops-task.yml` (14 `workflow_dispatch` inputs > 10).** Outdated rule (GitHub allows 25); 1.7.12 is clean; file not touched by this PR (IT-GX-010).

**OBS-QG-I05 — Release-gate expectation in the brief vs the code.** The test brief expected workflows to require a human; the gate refuses only the deploy pipelines (`deploy.yml`, `cdk-deploy.yml`, `ops-task.yml`, `agent-release.yml`) and itself, and treats `ci.yml`/`secret-scan.yml`/rulesets as NO_DEPLOY — consistent with AGENTS.md, since a change to them deploys nothing. Recorded so the traceability matrix does not claim otherwise.

**OBS-QG-I06 — Local and CI feedback differ in shape.** (a) CI's static step stops at the first failing tool (`bash -e`), so a PR with a ruff and a mypy error shows only ruff; preflight runs all three (IT-G1-003 vs IT-GX-021). (b) Preflight's pytest prints no pass count (pytest.ini `-q` + `-q`). (c) `--no-color` does not remove gitleaks' own colour codes. Cosmetic.

### 6.1 Re-test record

| Defect | Build re-tested | Date | Result | Evidence |
|---|---|---|---|---|
| DEF-QG-I02 | `8914e8396c66c993cf3d975c4b786ea30d3a338a` | 2026-10-08 | **Still open.** None of the 10 commits after `a3688f0` names it. `test_codebase_guards.py` and `preflight.sh` both changed, but the comparison is still a whole-file substring test. Mutations A (rename the recorded name), B (delete `check_secrets` calls) and C (delete `check_web` calls) each still give "1 passed". Control D still fails as before. | `RT-DEF-QG-I02.txt` |
| DEF-QG-I03 | `8914e8396c66c993cf3d975c4b786ea30d3a338a` | 2026-10-08 | **Still open.** `preflight.sh`'s secret check gained `--ignore-gitleaks-allow` and a pinned-version read, but still has no scan of untracked files. A new untracked file holding a fake `ghp_` token: all four scans report "no leaks found", "PASS Secrets (gitleaks)". (The worktree's venv links did not resolve, so checks 1 and 4 SKIPped; check 3 does not depend on them.) | `RT-DEF-QG-I03.txt` |

Status for the incident register: both stay **Assigned**, not Fixed. The re-test will be repeated when a commit that names them lands on the integration branch.

---

## 7. Level summary

### 7.1 Counts

| Planned | Executed | Passed | Failed | Blocked | Not run |
|---|---|---|---|---|---|
| 48 | 48 | 45 | 3 | 0 | 0 |

**Pass rate:** 45 / 48 = **93.8 %** of executed cases. Defects: 4 (2 Major, 2 Minor); observations: 6. No Critical defect: no gate was found to fail open in CI.

### 7.2 Requirements covered by this level

| Requirement | Cases |
|---|---|
| REQ-G1-01 | IT-G1-003 |
| REQ-G1-03 | IT-G1-003, IT-GX-019 |
| REQ-G1-04 | IT-G1-003 |
| REQ-G1-06 | IT-G1-001, IT-G1-002, IT-G1-003 |
| REQ-G1-07 | IT-G1-002 |
| REQ-G2-01 | IT-G2-008, IT-G2-009 |
| REQ-G2-02 | IT-G2-001, IT-G2-005, IT-G2-006 |
| REQ-G2-03 | IT-G2-002, IT-G2-003 (Fail) |
| REQ-G2-04 | IT-G2-004 |
| REQ-G2-05 | IT-G2-007, IT-G2-010, IT-G2-012 |
| REQ-G2-06 | IT-G2-002, IT-G2-011, IT-GX-014, IT-GX-016 |
| REQ-G2-07 | IT-GX-001, -002, -003, -006, -007, -008, IT-G2-007 |
| REQ-G2-08 | IT-G2-006 |
| REQ-G3-01 | IT-G3-001 |
| REQ-G3-02 | IT-G3-002 |
| REQ-G3-04 | IT-G3-002 |
| REQ-G3-08 | IT-G3-001 |
| REQ-G4-01 | IT-G4-004, IT-G4-005, IT-G4-007 |
| REQ-G4-02 | IT-G4-001, IT-G4-002, IT-G4-003, IT-G4-007 |
| REQ-G4-03 | IT-G4-004, IT-G4-005, IT-G4-006 |
| REQ-G4-04 | IT-G4-008 |
| REQ-G4-05 | IT-G1-002, IT-G4-001 |
| REQ-G4-06 | IT-G4-009, IT-G4-010, IT-GX-011, IT-GX-018 |
| REQ-GX-01 | IT-G1-002, IT-GX-001 … IT-GX-010 (IT-GX-005 Fail) |
| REQ-GX-02 | IT-GX-005 (Fail), IT-GX-011 … IT-GX-021 (IT-GX-015 Fail) |
| REQ-GX-03 | IT-G1-001 (backend suite on 3.14), IT-GX-011 (web unit suite and production build) |

Not covered here (by design, other levels): REQ-G1-02, G1-05, G3-03, G3-05, G3-06, G3-07, G3-09, G5-01 … G5-03, GX-04.

### 7.3 Residual risks

1. **A secret in a new file can pass preflight green** (DEF-QG-I03) and be pushed; CI then catches it, but after publication.
2. **The local runner's coverage is not actually guarded** (DEF-QG-I02): a preflight that silently stops running a check still satisfies §34.
3. **The secret gate can be weakened from inside a PR** (OBS-QG-I01) with no machine control until code-owner review is enforced.
4. On a red scan the run log lacks the actionable `::error::` annotation and the tree report (DEF-QG-I01) — the reviewer sees less than designed, though the check is red.
5. Test-bed deviations: PostgreSQL 16 instead of 17; the runner itself was not used (topology reproduced). The job replay ran on Python 3.14, so the version deviation does not apply to IT-G1-001.

### 7.4 Recommendation

**Go for this level, with conditions.** The gates are wired correctly where it matters most: the `api` job is green end to end on Python 3.14 behind a port mapping (the fixed CI defect stays fixed); each of ruff, mypy and the async guard stops the job before the database; every injected broken downgrade is caught, including one that bypasses the static test; the secret scan fails closed on every unresolvable range and catches a secret that was added and removed; the required-check contract catches renamed or dropped checks in the workflows, rulesets and `protect-main.sh`; and preflight's exit codes follow the decision table in every row tested except one (a secret in an untracked file). Conditions:

- DEF-QG-I02 and DEF-QG-I03 (Major) fixed and re-tested, **or** accepted in writing by the product owner as tracked follow-ups (they affect the local, advisory runner and a guard test, not the authoritative CI gate).
- DEF-QG-I01 and DEF-QG-I04 (Minor) fixed or accepted as residual risk.
- OBS-QG-I01 acknowledged by the product owner as residual risk.

---

## 8. Sign-off

| Role | Name | Date | Statement |
|---|---|---|---|
| Test Engineer — Integration | Tester session I | 2026-10-08 | I designed, executed and recorded the 48 cases above against build `a3688f0189c48287f376cf8c165d762a2f8ab8d8`. I did not modify the code under test; every violation was made and reverted in a scratch worktree or clone. |
| Test Manager (review) | | | |
