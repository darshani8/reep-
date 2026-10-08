# 02 — Unit Test Specification, Execution Log and Defects (L1): Quality Gates release (QG-2026-10)

## 1. Document control

| Field | Value |
|---|---|
| Document ID | REEP-UTS-QG-2026-10 |
| Version | 1.2 |
| Status | Re-test round 2 executed on the second fix build; submitted to the Test Manager |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 (test design, test case and test procedure specifications, test execution log, incident reports); ISTQB® CTFL v4.0 techniques |
| Parent document | [01 — Test Plan](01-test-plan.md) (REEP-TP-QG-2026-10 v1.0), level L1 |
| Author | Tester session U |
| Reviewer | Test Manager (orchestrating session) |
| Date | 2026-10-08 |
| Build under test | `claude/clever-meitner-ndvc2e` at **`a3688f0189c48287f376cf8c165d762a2f8ab8d8`** (PR darshani8/reep-#132 into `dev`), checked out detached (round 1). **Re-test round 1: `40201a140ba70f8be40d6b016f55ddb828fcaa91`** (same branch, detached). **Re-test round 2: `e55d1395379e9bc97cf5f3dfbc6a55bd16962475`** |
| Base for comparison | `15a9e7d` |
| Evidence | `testing/results/quality-gates-2026-10/unit/` (one file per case, plus `ENV-versions.txt` and the two full route-audit outputs) |

### Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-10-08 | Tester session U | Cases designed from the test basis (plan §2) and the gate sources, before execution |
| 1.0 | 2026-10-08 | Tester session U | All 109 cases executed; actual results, verdicts, 6 defects and 6 observations recorded |
| 1.1 | 2026-10-08 | Tester session U | Re-test round 1 on `40201a1`: all 109 cases re-executed (evidence `-rt1`); 22 new adversarial cases (UT-G1-037..039, UT-G2-022..026, UT-G3-029..040, UT-G4-024..025); §5a re-test log; a Re-test field on every defect; DEF-QG-U01..U06 Closed; new DEF-QG-U07..U11 and OBS-QG-U07..U08; round-1 evidence respelled to the new masking rule (§3, deviation 6); §7.5 counts and recommendation for the new build. Addendum the same day: the clone was shallow; UT-G2-018 was re-run on the full history (594 / 580 / 1294 commits, clean) and the round-1 verdict's reliance on a shallow scan is recorded |
| 1.2 | 2026-10-08 | Tester session U | Re-test round 2 on `e55d139`: confirmation of DEF-QG-U07..U11 (all Closed) and targeted regression (81 cases, evidence `-rt2`); 16 new adversarial cases (UT-G1-040..043, UT-G2-027, UT-G3-041..050, UT-G4-026); §5b; new DEF-QG-U12..U14 and OBS-QG-U09; evidence re-masked so the folder and this document scan 0 with the round-2 configuration |

---

## 2. Scope of this level

**Test object.** Each gate's components in isolation, on designed inputs, without the CI pipeline around them:

| Gate | Components tested | How they were isolated |
|---|---|---|
| G1 static analysis | ruff with `apps/api-py/pyproject.toml` (selection, per-file-ignores, RUF100); mypy `[tool.mypy]`; `tools/ci/check_async_blocking.py` (`scan_source`, `scan_tree`, `KNOWN` ratchet); the dev requirements pins | Probe files in a scratch worktree; the guard's functions imported read-only and fed synthetic source |
| G2 secrets | `.gitleaks.toml` rules and allowlists, `.gitleaksignore`, `tools/ci/check_gitleaks_rules.py`, the version/sha256 pin in `secret-scan.yml` | `gitleaks dir` on scratch directories outside the repository holding fake values generated at run time |
| G3 route audit | `apps/api-py/tests/test_route_audit.py` rules and `tests/route_audit_exceptions.py` ratchets | A throwaway router of synthetic handlers mounted only in the scratch worktree's `app/main.py` |
| G4 migrations | `migrations/reversibility.py` (classification, `segments()`, `rollback_floor()`, `KEPT_ON_DOWNGRADE`), `tests/test_migration_reversibility.py`, `tools/ci/check_migration_roundtrip.py` (`refusal()`, `libpq_hosts()`, `managed_server()`, `without()`/`present()`/`compare()`) | Synthetic revisions in the scratch worktree; one database per round-trip case; a stubbed engine; `--plan` for the refusal (it touches nothing) |
| GX preflight | `tools/ci/preflight.sh` helpers: `GITLEAKS_PINNED` parsing, `record()`, `should_stop()`, the final exit block | The shipped lines `eval`-ed verbatim in a subshell |
| G5 human gate | `.github/pull_request_template.md` | Parsed and compared with the base |

**Not tested at this level, and why**

| Not tested here | Reason |
|---|---|
| REQ-G1-06 (step order and the exact CI command in `ci.yml`) | A property of the wired pipeline: level L2 |
| REQ-G2-02, 03, 04 (commit ranges, a secret added then removed, fail-closed on an unresolvable range) | They live in the workflow's shell script against real git ranges: level L2. The rules and allowlists they rely on are tested here |
| REQ-G2-07, REQ-GX-01 (rulesets, `protect-main.sh`, §34) | File-agreement checks across four files: level L2 |
| REQ-G3-09 (OpenAPI unchanged), REQ-GX-03, REQ-GX-04 | Whole-product behaviour: level L3 |
| REQ-G4-05, REQ-G4-06 (CI step order; preflight's scratch database) | Pipeline wiring: level L2. REQ-G4-02 is covered here only by the baseline run (UT-G4-010) |
| REQ-G5-03 (documentation consistency, links) | Document review across `docs/`: level L2/L3 |
| GitHub server-side ruleset enforcement, Python 3.14, production | Out of scope per plan §3.1 |

## 3. Test environment actually used

| Component | Plan §5 | Actually used |
|---|---|---|
| Host | Cloud container | Linux 6.18.44 container (this session's own; no other tester shares it) |
| Database | PostgreSQL 16 + pgvector 0.6 on :5433 | PostgreSQL **16.15** (Ubuntu 24.04 package), pgvector **0.6.0**, port 5433, `max_connections=300`; `reep_py` migrated to head `f4a2c9e7b1d3` |
| Python | 3.13 venv from `requirements-dev.txt` | **3.13.16**; ruff **0.16.10**, mypy **2.4.0**, pytest 9.1.1, FastAPI 0.141.1, SQLAlchemy 2.0.52, Alembic 1.19.1, Pydantic 2.13.4 |
| gitleaks | 8.30.0, sha256-verified | **8.30.0**, verified against the value pinned in `secret-scan.yml` and the release's checksums file (UT-G2-020) |
| Node / browser | Only if needed | Not needed at this level; not installed |
| Shell | — | GNU bash 5.2.21 |

**Deviations from the plan, and their effect**

1. Python 3.13, not 3.14 (as planned). ruff and mypy were run with the configuration's own targets (`py314`, `python_version = "3.14"`), so the rules and type checks are the same. CI's green run on the same head covers the 3.14 runtime.
2. PostgreSQL 16, not 17 (as planned). The round trip compares catalogues, and the shipped chain round-tripped cleanly on 16 (UT-G4-010).
3. For **UT-G4-021 only**, Postgres was restarted to listen on `localhost,192.0.2.2` as well, with one `pg_hba.conf` line trusting `192.0.2.2/32`, and a small TCP forwarder (`127.0.0.1:55433 → 192.0.2.2:5433`) stood in for Docker's port mapping. The forwarder was stopped after the case.
4. Every edit that a case needed (probe files, a scratch `reversibility.py`, scratch exception lists, a scratch `.gitleaks.toml`) was made in **scratch worktrees** under the session scratchpad (`git worktree add --detach … a3688f0`). Each was reverted with `git checkout`/`rm` and `git status` was checked; the only untracked entry there was the tester's own `.venv` symlink. The repository checkout on `claude/qg-test-unit` contains nothing but this document and the evidence folder.
5. Fake secrets were generated at run time into the scratchpad, never into the repository. The evidence prints them masked. `gitleaks dir` over the evidence folder reports **no leaks** (run before committing).

Environment versions are recorded in `unit/ENV-versions.txt`.

**Re-test round 1 (build `40201a1`).** Same container, same tools and versions (`requirements-dev.txt` is unchanged, so the same venv was used). Two scratch worktrees at `40201a1`: one read-only (`nb`) that the helper scripts point at, and one for mutations (`wt`). Deviations:

6. Between rounds the container had stopped PostgreSQL. It was restarted on the same data directory with the same options (plus `192.0.2.2` for UT-G4-021). Two evidence files record the failed first attempt (UT-G4-010-rt1, UT-G4-011-rt1).
8. **The clone was shallow** (11 grafts; `git rev-parse --is-shallow-repository` = true) for every history scan in round 1 and in the first part of this round, so those scans covered 219 of the 724 commits reachable from `a3688f0`. This was found by tester S (OBS-QG-S05) and relayed by the Test Manager. `git fetch --unshallow origin` was run and UT-G2-018 re-executed on the full history (§5a). No other unit case reads history.
7. **Round-1 evidence was respelled after execution**, as the Test Manager asked. Every masked value is now the bare `<FAKE-VALUE-MASKED>` with at most a `NAME=` prefix, PEM armour lines are replaced by `<PEM armour line omitted>`, and the worded placeholder at `UT-G2-009.txt:32` is written as `OPENAI_API_KEY=<the worded placeholder>`. Only the printing of inputs changed; no command output or verdict changed. The whole folder and this document scan clean (`gitleaks dir … --ignore-gitleaks-allow --redact`) with BOTH the new and the round-1 configuration.

## 4. Test case specification

Precondition sets used below (each case names one):

| Code | Precondition |
|---|---|
| PC-1 | A scratch worktree of the head (`git worktree add --detach <scratchpad>/wt a3688f0`) with the API venv linked in; commands run from its `apps/api-py`. A probe file is written, the command run, and the probe deleted; `git status` is checked afterwards. Read-only imports of `tools/ci/check_async_blocking.py` use the real checkout. |
| PC-2 | gitleaks 8.30.0 installed from the sha256-verified tarball (UT-G2-020). Case files are generated at run time by `mkleaks.py` with fresh fake values, in the scratchpad, outside the repository. Evidence prints them through `show`, which masks every run of 17+ key characters. |
| PC-3 | PC-1, plus `app/routers/qg_probe.py` (synthetic handlers) included in the scratch worktree's `app/main.py`. Behaviour checks use `TestClient` with `get_current_session` overridden to a STUDENT session. |
| PC-4 | PC-1, plus a probe revision in the scratch worktree's `migrations/versions/`. Round-trip cases each create their own database (`reep_u_g4_NNN`), migrate it, run the script and drop it and its `_roundtrip` copy (AGENTS.md: one database per run). |
| PC-5 | `tools/ci/preflight.sh` lines are evaluated verbatim (`sed -n 'a,bp'` + `eval`) in a subshell with stubs, so the logic under test is the shipped text, not a copy. |

### 4.1 Case index

| ID | Requirement(s) | Title | Technique | Priority |
|---|---|---|---|---|
| UT-G1-000 | REQ-G1-01, 03, 04 | Baseline: the shipped tree passes ruff (CI command), mypy and the async guard | Positive (regression input) | P1 |
| UT-G1-001 | REQ-G1-01 | F family: F401 unused import, F821 undefined name in `app/` | Equivalence partitioning | P1 |
| UT-G1-002 | REQ-G1-01 | E9: a file that does not parse | Equivalence partitioning | P1 |
| UT-G1-003 | REQ-G1-01 | B006 mutable default; B012 `return` in `finally` | Equivalence partitioning | P1 |
| UT-G1-004 | REQ-G1-01 | Further selected B rules: B023 loop variable in closure, B015 pointless comparison | Equivalence partitioning | P2 |
| UT-G1-005 | REQ-G1-01 | S family in `app/`: S105, S101, S602, S113 | Equivalence partitioning | P1 |
| UT-G1-006 | REQ-G1-01 | Near miss: S101/S105 are allowed under `tests/**` | Equivalence partitioning (allowed partition) | P2 |
| UT-G1-007 | REQ-G1-01 | S608 is ignored under `migrations/versions/**` and reported in `app/` | Boundary of per-file-ignores | P2 |
| UT-G1-008 | REQ-G1-01 | ASYNC family: ASYNC251, ASYNC210 (requests and httpx), ASYNC230 (`open`, `Path.open`) | Equivalence partitioning | P1 |
| UT-G1-009 | REQ-G1-01, 02 | Near misses: `await asyncio.sleep`, `await asyncio.to_thread(time.sleep, 1)`, blocking calls in a plain `def`, coded `# noqa: S603` with a reason | Negative | P1 |
| UT-G1-010 | REQ-G1-02 | RUF100: a stale `# noqa: S101` is a finding; a live coded `# noqa: F401` is not | State transition (live → stale suppression) | P1 |
| UT-G1-011 | REQ-G1-01 | `../../tools/ci/**` per-file-ignores: S603/S607 off, S101 still on | Equivalence partitioning | P2 |
| UT-G1-012 | REQ-G1-01 | The gate is not ruff's defaults: unselected rules do not fire; the enabled set is exactly the explicit list | Negative + configuration inspection | P1 |
| UT-G1-014 | REQ-G1-03 | mypy configuration, and a return-type error | Configuration inspection + EP | P1 |
| UT-G1-015 | REQ-G1-03 | Optional misuse | EP | P1 |
| UT-G1-016 | REQ-G1-03 | `warn_redundant_casts` | EP | P2 |
| UT-G1-017 | REQ-G1-03 | `warn_unused_ignores` | EP | P2 |
| UT-G1-018 | REQ-G1-03 | `check_untyped_defs`: an error inside an unannotated function | EP | P1 |
| UT-G1-019 | REQ-G1-03 | Near miss: a needed cast is not reported | Negative | P3 |
| UT-G1-020 | REQ-G1-03 | A new untyped third-party import is an error (no global `ignore_missing_imports`) | Error guessing | P2 |
| UT-G1-021 | REQ-G1-07 | ruff, mypy and stubs pinned `==` in `requirements-dev.txt` only; `requirements.txt` unchanged | Inspection + comparison with base | P2 |
| UT-G1-022 | REQ-G1-04 | Async guard: inline `Annotated[Session, Depends(get_db)]` | EP | P1 |
| UT-G1-023 | REQ-G1-04 | Alias forms: plain assignment, `TypeAlias`, PEP 695 `type X = ...`, quoted annotation | EP | P1 |
| UT-G1-024 | REQ-G1-04 | Alias declared in another module of a synthetic `app/` tree (`from ..deps import DbDep as D`, `deps.DbDep`), and a second SessionLocal-yielding dependency found by reading the tree | EP | P1 |
| UT-G1-025 | REQ-G1-04 | `Depends(dependency=get_db)`, `get_db as database`, keyword-only `fastapi.Depends(dbmod.get_db)` | EP | P1 |
| UT-G1-026 | REQ-G1-04 | `SessionLocal()`, `with db.SessionLocal() as s`, `SessionLocal as SL` | EP | P1 |
| UT-G1-027 | REQ-G1-04 | Blocking calls: `time.sleep`, `from time import sleep as nap`, `requests.get`, `open()`, `Path.read_text`, `subprocess.run`, function-local `boto3.client`, the `document_store`/`document_manifest` choke points | EP | P1 |
| UT-G1-028 | REQ-G1-04 | Documented rule: a `Depends(get_db)` parameter is flagged even when every query is in `run_in_threadpool` | Decision rule | P2 |
| UT-G1-029 | REQ-G1-04 | Negatives: `to_thread(time.sleep)`, `run_in_threadpool(Path(p).read_text)`, nested plain `def`, `await anyio.Path(p).read_text()`, a local list named `requests`, `await asyncio.sleep`, a plain `def` with `Depends(get_db)` | Negative | P1 |
| UT-G1-030 | REQ-G1-04 | Bypass attempt: blocking shapes outside the listed ones: an immediately-invoked lambda, `os.open`/`os.read` (and `Path(p).open()` for the guard alone) | Error guessing | P3 |
| UT-G1-031 | REQ-G1-05 | KNOWN ratchet: a new offender fails | State transition (baseline → new) | P1 |
| UT-G1-032 | REQ-G1-05 | KNOWN ratchet: a known offender that grows a blocking call fails | State transition (known → grew) | P1 |
| UT-G1-033 | REQ-G1-05 | KNOWN ratchet: a known offender that loses a call fails | State transition (known → shrank) | P1 |
| UT-G1-034 | REQ-G1-05 | KNOWN ratchet: a fixed offender must be struck off | State transition (known → fixed) | P1 |
| UT-G1-035 | REQ-G1-04 | A file under `app/` that does not parse fails the guard (not skipped) | Error guessing (fail closed) | P2 |
| UT-G1-036 | REQ-G1-02 | Bypass attempt: file-level `# ruff: noqa`, a blanket `# noqa` and a coded `noqa` with no reason in `app/` | Error guessing / bypass | P1 |
| UT-G2-001 | REQ-G2-05 | `reep-auth-secret`: dotenv and quoted Python assignment | EP | P1 |
| UT-G2-002 | REQ-G2-05 | `AUTH_SECRET:` in YAML with the value on the next, indented line | EP | P1 |
| UT-G2-003 | REQ-G2-05 | Boundary: the next line is a new top-level key, not a value | Boundary value | P2 |
| UT-G2-004 | REQ-G2-05 | Value length 31 vs 32 (the `{32,}` floor) | Boundary value | P2 |
| UT-G2-005 | REQ-G2-05 | `reep-env-name-value-pair` in JSON and YAML; a short value stays quiet | EP + boundary | P1 |
| UT-G2-006 | REQ-G2-05 | `reep-database-url-password`: `+psycopg`, `postgresql://`, `postgres://`; 3-character password quiet | EP + boundary | P1 |
| UT-G2-007 | REQ-G2-05 | Provider variables: OPENAI, GROQ (name and `gsk_` shape), LIVEKIT, VOICE_WORKER | EP | P1 |
| UT-G2-008 | REQ-G2-05 | gitleaks default shapes: `ghp_` token, AKIA + secret pair, RSA private key | EP | P1 |
| UT-G2-009 | REQ-G2-05 | Published dev values and placeholders stay quiet | Negative | P1 |
| UT-G2-010 | REQ-G2-05 | A real secret on the same line as an allowlisted value is still caught (`regexTarget = match`) | Boundary / bypass attempt | P1 |
| UT-G2-011 | REQ-G2-05 | `reep-bare-token-hex`: 64 hex beside "token" caught; beside "sha256" quiet | EP | P2 |
| UT-G2-012 | REQ-G2-06 | `--redact`: the value is in neither stdout nor the JSON report; the log names file, line and rule | EP | P1 |
| UT-G2-013 | REQ-G2-05 | `.gitleaksignore` is exact: a fingerprint frees one line, a wrong line number frees nothing | Boundary | P2 |
| UT-G2-014 | REQ-G2-05 | Bypass attempt: a real-shaped value that contains an allowlisted placeholder | Error guessing / bypass | P2 |
| UT-G2-016 | REQ-G2-05 | `check_gitleaks_rules.py` on the shipped configuration | Positive | P1 |
| UT-G2-017 | REQ-G2-05 | The replay fails when the configuration is broken (scratch copy), and fails closed without gitleaks | State transition / negative | P1 |
| UT-G2-018 | REQ-G2-08 | The repository's history and tree are clean under the shipped configuration (round-1 run was on a shallow clone; see §5a) | Regression | P1 |
| UT-G2-020 | REQ-G2-01 | The sha256 pinned in `secret-scan.yml` matches the release, and a changed tarball fails the check | EP + negative | P1 |
| UT-G2-021 | REQ-G2-05 | Bypass attempt: gitleaks' inline `gitleaks:allow` comment beside a real AUTH_SECRET | Error guessing / bypass | P1 |
| UT-G3-000 | REQ-G3-01..07, REQ-G4-01 | Baseline: the unmodified audit and reversibility tests pass | Positive | P1 |
| UT-G3-001 | REQ-G3-02 | AUTH: a route with no session | EP | P1 |
| UT-G3-002 | REQ-G3-03 | GATE: a session and no gate | EP | P1 |
| UT-G3-003 | REQ-G3-03 | A role comparison that raises counts as a gate | EP (allowed) | P1 |
| UT-G3-004 | REQ-G3-03 | A role comparison that refuses nothing does not count | Negative | P1 |
| UT-G3-005 | REQ-G3-03 | `if False: require_admin(session)` does not count | Negative (dead code) | P1 |
| UT-G3-006 | REQ-G3-03 | A gate reached through an `app/` helper counts | EP (allowed) | P1 |
| UT-G3-007 | REQ-G3-03 | Bypass attempt: the gate is unreachable (after `return`) | Error guessing (dead code) | P2 |
| UT-G3-008 | REQ-G3-03 | Bypass attempt: a gate whose refusal is caught (`try: require_admin(...) except HTTPException: pass`), and a handler whose only "gate" is the existing predicate helper `interview_records._may_see_raw_response`, which calls `require_admin` and catches it | Error guessing | P1 |
| UT-G3-009 | REQ-G3-03 | Bypass attempt: other dead-code shapes: `if not True:`, `while False:` | Error guessing (dead code) | P3 |
| UT-G3-010 | REQ-G3-04 | RESPONSE: `-> dict` | EP | P1 |
| UT-G3-011 | REQ-G3-04 | RESPONSE: `-> Any` | EP | P1 |
| UT-G3-012 | REQ-G3-04 | RESPONSE: `-> dict[str, Any]` | EP | P1 |
| UT-G3-013 | REQ-G3-04 | RESPONSE: `-> list[dict]` (paginated, so only this rule applies) | EP | P1 |
| UT-G3-014 | REQ-G3-04 | `-> dict[str, SomeModel]` is typed and passes | EP (allowed) | P2 |
| UT-G3-015 | REQ-G3-04 | Bypass attempt: `RootModel[dict[str, Any]]` | Error guessing | P3 |
| UT-G3-016 | REQ-G3-04 | No annotation and no `response_model` on a JSON route | EP | P1 |
| UT-G3-017 | REQ-G3-05 | STATUS: POST to a plural collection answering 200 is reported; 201 passes | EP | P1 |
| UT-G3-018 | REQ-G3-05 | STATUS: 204 with a body | EP | P2 |
| UT-G3-019 | REQ-G3-05 | STATUS: DELETE with an untyped body is reported; DELETE 204 passes | EP | P1 |
| UT-G3-020 | REQ-G3-06 | PAGINATION: a bare list with no page parameters | EP | P1 |
| UT-G3-021 | REQ-G3-06 | `limit` without `le=` (and `offset`) | Boundary | P1 |
| UT-G3-022 | REQ-G3-06 | `limit: int = Query(50, le=200)` without an offset or cursor | Decision rule | P2 |
| UT-G3-023 | REQ-G3-06 | `limit` with `le=` plus `offset` passes | EP (allowed) | P1 |
| UT-G3-024 | REQ-G3-02 | A WebSocket that never reads the session | EP | P1 |
| UT-G3-025 | REQ-G3-07 | Ratchet: a stale entry in each of the six exception lists | State transition (listed → fixed) | P1 |
| UT-G3-026 | REQ-G3-07 | An entry naming a different handler is not inherited | Negative | P1 |
| UT-G3-027 | REQ-G3-08 | The audit needs no database and does not depend on order | EP + order permutation | P1 |
| UT-G3-028 | REQ-G3-01 | The 300-operation floor, at the boundary, and a broken walk | Boundary value | P1 |
| UT-G4-001 | REQ-G4-01 | A new head whose `downgrade()` is `pass`, with no entry, fails | EP | P1 |
| UT-G4-002 | REQ-G4-01 | The same with an `IRREVERSIBLE` no-op entry passes | State transition | P1 |
| UT-G4-003 | REQ-G4-01 | An entry on a revision that now has a real downgrade must be struck off | State transition (declared → fixed) | P1 |
| UT-G4-004 | REQ-G4-01 | A `raises` downgrade at the head: undeclared fails; declared is legal and becomes the floor | Boundary (floor at head) | P1 |
| UT-G4-005 | REQ-G4-01 | Two heads fail | Negative | P1 |
| UT-G4-006 | REQ-G4-01 | No `downgrade()` at all fails | Negative | P1 |
| UT-G4-007 | REQ-G4-01 | Bypass attempt: a downgrade that does nothing but is not `pass`: `return`, and `if False: ...` | Error guessing | P3 |
| UT-G4-010 | REQ-G4-02 | Baseline: the round trip passes on the shipped chain | Positive | P1 |
| UT-G4-011 | REQ-G4-03 | An incomplete downgrade (forgets a table) is caught | EP | P1 |
| UT-G4-012 | REQ-G4-03 | A downgrade that restores the wrong default is caught | EP | P1 |
| UT-G4-013 | REQ-G4-03 | A `return`-only downgrade under a schema-changing upgrade is caught by the round trip | EP | P2 |
| UT-G4-014 | REQ-G4-03 | KEPT_ON_DOWNGRADE ratchet: a declared leftover that is not left behind fails | State transition | P1 |
| UT-G4-015 | REQ-G4-01 | `segments()` / `rollback_floor()` on synthetic five-revision chains | Decision table | P1 |
| UT-G4-016 | REQ-G4-03 | Nothing exercisable means exit 2, not a pass | Boundary | P2 |
| UT-G4-017 | REQ-G4-04 | Refusal decision table: ENV | Decision table | P1 |
| UT-G4-018 | REQ-G4-04 | Refusal decision table: host | Decision table | P1 |
| UT-G4-019 | REQ-G4-04 | Refusal decision table: database name | Decision table | P1 |
| UT-G4-020 | REQ-G4-04 | Bypass attempt: a non-loopback address given through libpq's `PGHOSTADDR` environment variable | Error guessing | P2 |
| UT-G4-021 | REQ-G4-04 | Regression of the CI defect: a server behind a port mapping (it reports a non-loopback address) is not refused; compared with the script before the fix | Comparison (before/after) | P1 |
| UT-G4-022 | REQ-G4-04 | `managed_server()`: rds.*, aurora*, cloudsql.*, azure.* settings and `rds.superuser_variables` refuse; a plain server runs; an unreachable server fails closed | Decision table (stubbed engine) | P1 |
| UT-G4-023 | REQ-G4-03 | `without()` / `present()` / `compare()`: declared leftovers ignored, undeclared ones still fail | EP | P2 |
| UT-GX-001 | REQ-GX-02 | preflight's `GITLEAKS_PINNED` parsing (line 211, evaluated verbatim) | EP + boundary | P2 |
| UT-GX-002 | REQ-GX-02 | preflight `record()` / `should_stop()` / final block → exit code | Decision table | P1 |
| UT-G5-001 | REQ-G5-01 | Every base heading of the PR template is still there, plus the two new sections | Comparison with base | P1 |
| UT-G5-002 | REQ-G5-02 | Each checklist item names its gate or says *human — no gate*, and every named gate exists | Inspection + cross-check | P1 |

### 4.2 Cases in full

Every case was executed by tester session U on 2026-10-08 against build `a3688f0`. The evidence file is `testing/results/quality-gates-2026-10/unit/<ID>.txt`.

#### UT-G1-000 — Baseline: the shipped tree passes ruff (CI command), mypy and the async guard

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01, 03, 04 |
| Objective | Verify, against the requirement: Baseline: the shipped tree passes ruff (CI command), mypy and the async guard. |
| Technique / priority | Positive (regression input) / P1 |
| Preconditions | PC-1 |
| Test data | Unmodified head |
| Steps | 1. `ruff check --config pyproject.toml . ../../tools/ci` 2. `mypy` 3. `check_async_blocking.py` |
| Expected result | All three exit 0 |
| Actual result | `All checks passed!`; `Success: no issues found in 218 source files`; `no new blocking calls ... (3 known)`; exit 0 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-000.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:38:32 UTC |

#### UT-G1-001 — F family: F401 unused import, F821 undefined name in `app/`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: F family: F401 unused import, F821 undefined name in `app/`. |
| Technique / priority | Equivalence partitioning / P1 |
| Preconditions | PC-1 |
| Test data | `import os` unused; `return undefined_name` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 naming F401 and F821 |
| Actual result | F401 (1:8), F821 (5:12); exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-001.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:31 UTC |

#### UT-G1-002 — E9: a file that does not parse

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: E9: a file that does not parse. |
| Technique / priority | Equivalence partitioning / P1 |
| Preconditions | PC-1 |
| Test data | `def f(:` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 with a syntax finding |
| Actual result | Two `invalid-syntax` findings, exit 1. Note: ruff 0.16 reports parse errors as `invalid-syntax` (E999 is gone); `E9` now enables only E902. The gate is still red, which is what the requirement asks |
| Verdict | Pass |
| Evidence | `unit/UT-G1-002.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:31 UTC |

#### UT-G1-003 — B006 mutable default; B012 `return` in `finally`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: B006 mutable default; B012 `return` in `finally`. |
| Technique / priority | Equivalence partitioning / P1 |
| Preconditions | PC-1 |
| Test data | `def f(x=[])` with `finally: return None` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 naming B006 and B012 |
| Actual result | B006 (1:9), B012 (5:9); exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-003.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:31 UTC |

#### UT-G1-004 — Further selected B rules: B023 loop variable in closure, B015 pointless comparison

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: Further selected B rules: B023 loop variable in closure, B015 pointless comparison. |
| Technique / priority | Equivalence partitioning / P2 |
| Preconditions | PC-1 |
| Test data | `lambda: i` in a loop; `1 == 2` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 naming B023 and B015 |
| Actual result | B023, B015; exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-004.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:39 UTC |

#### UT-G1-005 — S family in `app/`: S105, S101, S602, S113

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: S family in `app/`: S105, S101, S602, S113. |
| Technique / priority | Equivalence partitioning / P1 |
| Preconditions | PC-1 |
| Test data | `PASSWORD = "..."`, `assert x`, `subprocess.run(cmd, shell=True)`, `requests.get(url)` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 naming all four |
| Actual result | S105, S101, S602, S113; exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-005.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:39 UTC |

#### UT-G1-006 — Near miss: S101/S105 are allowed under `tests/**`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: Near miss: S101/S105 are allowed under `tests/**`. |
| Technique / priority | Equivalence partitioning (allowed partition) / P2 |
| Preconditions | PC-1 |
| Test data | Same password + assert in `tests/test_qg_probe.py` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 0 |
| Actual result | `All checks passed!`, exit 0 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-006.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:39 UTC |

#### UT-G1-007 — S608 is ignored under `migrations/versions/**` and reported in `app/`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: S608 is ignored under `migrations/versions/**` and reported in `app/`. |
| Technique / priority | Boundary of per-file-ignores / P2 |
| Preconditions | PC-1 |
| Test data | f-string SQL in both places |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. (twice) |
| Expected result | Migration probe exit 0; `app/` probe exit 1 with S608 |
| Actual result | Migration: passed, exit 0. `app/`: S608, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-007.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:39 UTC |

#### UT-G1-008 — ASYNC family: ASYNC251, ASYNC210 (requests and httpx), ASYNC230 (`open`, `Path.open`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: ASYNC family: ASYNC251, ASYNC210 (requests and httpx), ASYNC230 (`open`, `Path.open`). |
| Technique / priority | Equivalence partitioning / P1 |
| Preconditions | PC-1 |
| Test data | One `async def` with all five calls |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 naming each |
| Actual result | ASYNC251, ASYNC210 x2, ASYNC230 x2; exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-008.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:45 UTC |

#### UT-G1-009 — Near misses: `await asyncio.sleep`, `await asyncio.to_thread(time.sleep, 1)`, blocking calls in a plain `def`, coded `# noqa: S603` with a reason

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01, 02 |
| Objective | Verify, against the requirement: Near misses: `await asyncio.sleep`, `await asyncio.to_thread(time.sleep, 1)`, blocking calls in a plain `def`, coded `# noqa: S603` with a reason. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-1 |
| Test data | Probe with the four shapes |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 0 |
| Actual result | `All checks passed!`, exit 0 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-009.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:45 UTC |

#### UT-G1-010 — RUF100: a stale `# noqa: S101` is a finding; a live coded `# noqa: F401` is not

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-02 |
| Objective | Verify, against the requirement: RUF100: a stale `# noqa: S101` is a finding; a live coded `# noqa: F401` is not. |
| Technique / priority | State transition (live → stale suppression) / P1 |
| Preconditions | PC-1 |
| Test data | Two noqa comments |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1, RUF100 on the stale line only |
| Actual result | RUF100 at 5:19 only; exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-010.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:45 UTC |

#### UT-G1-011 — `../../tools/ci/**` per-file-ignores: S603/S607 off, S101 still on

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: `../../tools/ci/**` per-file-ignores: S603/S607 off, S101 still on. |
| Technique / priority | Equivalence partitioning / P2 |
| Preconditions | PC-1 |
| Test data | `subprocess.run(["git","status"])` + `assert True` in `tools/ci/_qg_probe.py` |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1 naming S101 only |
| Actual result | S101 only; exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-011.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:45 UTC |

#### UT-G1-012 — The gate is not ruff's defaults: unselected rules do not fire; the enabled set is exactly the explicit list

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-01 |
| Objective | Verify, against the requirement: The gate is not ruff's defaults: unselected rules do not fire; the enabled set is exactly the explicit list. |
| Technique / priority | Negative + configuration inspection / P1 |
| Preconditions | PC-1 |
| Test data | E501 (long line), I001 (unsorted), E711, B008 (`Depends`), B904, W291 |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. 4. `ruff check --show-settings` and count `linter.rules.enabled` by prefix |
| Expected result | Exit 0; enabled = F, E402/E731/E902, the 22 listed B codes, S, ASYNC, RUF100 |
| Actual result | Exit 0. Enabled: 43 F, 3 E (E402, E731, E902), 22 B (exactly the list), 58 S, 15 ASYNC, 1 RUF (RUF100). The first count in the file was a script error (it ran into `should_fix`) and is corrected there |
| Verdict | Pass |
| Evidence | `unit/UT-G1-012.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:39:53 UTC |

#### UT-G1-014 — mypy configuration, and a return-type error

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: mypy configuration, and a return-type error. |
| Technique / priority | Configuration inspection + EP / P1 |
| Preconditions | PC-1 |
| Test data | `def f(x: int) -> str: return x` |
| Steps | 1. Read `[tool.mypy]`. 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | `python_version = 3.14`, `files = ["app"]`, the three flags; exit 1 with `[return-value]` |
| Actual result | As expected; mypy_exit=1 (the first block's exit 0 was `tail`'s, corrected) |
| Verdict | Pass |
| Evidence | `unit/UT-G1-014.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:09 UTC |

#### UT-G1-015 — Optional misuse

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: Optional misuse. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 |
| Test data | `len(names)` where `names: list[str] &#124; None` |
| Steps | 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1, `[arg-type]` |
| Actual result | `[arg-type]`, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-015.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:18 UTC |

#### UT-G1-016 — `warn_redundant_casts`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: `warn_redundant_casts`. |
| Technique / priority | EP / P2 |
| Preconditions | PC-1 |
| Test data | `cast(int, x)` with `x: int` |
| Steps | 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1, `[redundant-cast]` |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-016.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:19 UTC |

#### UT-G1-017 — `warn_unused_ignores`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: `warn_unused_ignores`. |
| Technique / priority | EP / P2 |
| Preconditions | PC-1 |
| Test data | `# type: ignore[return-value]` on a correct line |
| Steps | 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1, `[unused-ignore]` |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-017.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:21 UTC |

#### UT-G1-018 — `check_untyped_defs`: an error inside an unannotated function

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: `check_untyped_defs`: an error inside an unannotated function. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 |
| Test data | `def untyped(x): y: int = "str"` |
| Steps | 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1, `[assignment]` |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-018.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:22 UTC |

#### UT-G1-019 — Near miss: a needed cast is not reported

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: Near miss: a needed cast is not reported. |
| Technique / priority | Negative / P3 |
| Preconditions | PC-1 |
| Test data | `cast(int, x)` with `x: object` |
| Steps | 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 0 |
| Actual result | `Success`, exit 0 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-019.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:24 UTC |

#### UT-G1-020 — A new untyped third-party import is an error (no global `ignore_missing_imports`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-03 |
| Objective | Verify, against the requirement: A new untyped third-party import is an error (no global `ignore_missing_imports`). |
| Technique / priority | Error guessing / P2 |
| Preconditions | PC-1 |
| Test data | `import yaml_not_installed_qg` |
| Steps | 1. Write `app/_qg_probe.py` in the scratch worktree. 2. Run `python -m mypy` (no arguments) from `apps/api-py`. 3. Delete the probe. |
| Expected result | Exit 1, `[import-not-found]` |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-020.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:31 UTC |

#### UT-G1-021 — ruff, mypy and stubs pinned `==` in `requirements-dev.txt` only; `requirements.txt` unchanged

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-07 |
| Objective | Verify, against the requirement: ruff, mypy and stubs pinned `==` in `requirements-dev.txt` only; `requirements.txt` unchanged. |
| Technique / priority | Inspection + comparison with base / P2 |
| Preconditions | Repository at head |
| Test data | Both requirements files |
| Steps | 1. grep the pins. 2. grep `requirements.txt`. 3. `git diff 15a9e7d a3688f0 -- requirements.txt` |
| Expected result | Four `==` pins in dev; none in runtime; no diff |
| Actual result | `ruff==0.16.10`, `mypy==2.4.0`, `types-reportlab==5.0.0.20260911`, `types-openpyxl==3.1.5.20260827`; 0 in requirements.txt; empty diff |
| Verdict | Pass |
| Evidence | `unit/UT-G1-021.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:33 UTC |

#### UT-G1-022 — Async guard: inline `Annotated[Session, Depends(get_db)]`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Async guard: inline `Annotated[Session, Depends(get_db)]`. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Synthetic module |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | Flagged |
| Actual result | Flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-022.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:58 UTC |

#### UT-G1-023 — Alias forms: plain assignment, `TypeAlias`, PEP 695 `type X = ...`, quoted annotation

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Alias forms: plain assignment, `TypeAlias`, PEP 695 `type X = ...`, quoted annotation. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Four synthetic modules |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | Each flagged |
| Actual result | All four flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-023.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:58 UTC |

#### UT-G1-024 — Alias declared in another module of a synthetic `app/` tree (`from ..deps import DbDep as D`, `deps.DbDep`), and a second SessionLocal-yielding dependency found by reading the tree

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Alias declared in another module of a synthetic `app/` tree (`from ..deps import DbDep as D`, `deps.DbDep`), and a second SessionLocal-yielding dependency found by reading the tree. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Temporary `app/` with db.py, deps.py, other_db.py, routers/x.py, routers/y.py |
| Steps | 1. `scan_tree(<temp app>)` |
| Expected result | `a`, `b` (get_db) and `c` (get_other) flagged |
| Actual result | All three flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-024.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:00 UTC |

#### UT-G1-025 — `Depends(dependency=get_db)`, `get_db as database`, keyword-only `fastapi.Depends(dbmod.get_db)`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: `Depends(dependency=get_db)`, `get_db as database`, keyword-only `fastapi.Depends(dbmod.get_db)`. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Three synthetic modules |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | Each flagged |
| Actual result | All flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-025.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:58 UTC |

#### UT-G1-026 — `SessionLocal()`, `with db.SessionLocal() as s`, `SessionLocal as SL`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: `SessionLocal()`, `with db.SessionLocal() as s`, `SessionLocal as SL`. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Three synthetic modules |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | Each flagged |
| Actual result | All flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-026.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:59 UTC |

#### UT-G1-027 — Blocking calls: `time.sleep`, `from time import sleep as nap`, `requests.get`, `open()`, `Path.read_text`, `subprocess.run`, function-local `boto3.client`, the `document_store`/`document_manifest` choke points

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Blocking calls: `time.sleep`, `from time import sleep as nap`, `requests.get`, `open()`, `Path.read_text`, `subprocess.run`, function-local `boto3.client`, the `document_store`/`document_manifest` choke points. |
| Technique / priority | EP / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Eight synthetic modules |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | Each flagged |
| Actual result | All flagged. 027h first ran without `app_module_funcs` (tester's error; `scan_tree` supplies it) and was re-run with the real function lists: both choke points flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-027.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:40:59 UTC |

#### UT-G1-028 — Documented rule: a `Depends(get_db)` parameter is flagged even when every query is in `run_in_threadpool`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Documented rule: a `Depends(get_db)` parameter is flagged even when every query is in `run_in_threadpool`. |
| Technique / priority | Decision rule / P2 |
| Preconditions | PC-1 (read-only import) |
| Test data | Synthetic module |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | Flagged (parameter finding) |
| Actual result | Flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-028.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:00 UTC |

#### UT-G1-029 — Negatives: `to_thread(time.sleep)`, `run_in_threadpool(Path(p).read_text)`, nested plain `def`, `await anyio.Path(p).read_text()`, a local list named `requests`, `await asyncio.sleep`, a plain `def` with `Depends(get_db)`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Negatives: `to_thread(time.sleep)`, `run_in_threadpool(Path(p).read_text)`, nested plain `def`, `await anyio.Path(p).read_text()`, a local list named `requests`, `await asyncio.sleep`, a plain `def` with `Depends(get_db)`. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-1 (read-only import) |
| Test data | Seven synthetic modules |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. |
| Expected result | None flagged |
| Actual result | None flagged |
| Verdict | Pass |
| Evidence | `unit/UT-G1-029.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:00 UTC |

#### UT-G1-030 — Bypass attempt: blocking shapes outside the listed ones: an immediately-invoked lambda, `os.open`/`os.read` (and `Path(p).open()` for the guard alone)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: Bypass attempt: blocking shapes outside the listed ones: an immediately-invoked lambda, `os.open`/`os.read` (and `Path(p).open()` for the guard alone). |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-1 |
| Test data | Synthetic module; the same code through ruff |
| Steps | 1. Call `check_async_blocking.scan_source(src, path)` (imported read-only from `tools/ci`) via `ab.py <case>`. 2. Compare the findings with the expectation. 3. Same code through ruff (UT-G1-030 probe) |
| Expected result | Caught by the guard or by ruff (the G1 step as a whole) |
| Actual result | `Path.open` is caught by ruff ASYNC230 (UT-G1-008) but not the guard. The lambda call and `os.open`/`os.read` are caught by neither tool |
| Verdict | Fail (OBS-QG-U03) |
| Evidence | `unit/UT-G1-030.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:00 UTC |

#### UT-G1-031 — KNOWN ratchet: a new offender fails

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-05 |
| Objective | Verify, against the requirement: KNOWN ratchet: a new offender fails. |
| Technique / priority | State transition (baseline → new) / P1 |
| Preconditions | PC-1 |
| Test data | `async def qg_new_offender(db: Session = Depends(get_db))` appended to `voice_platform/api/calls.py` |
| Steps | 1. Append. 2. Run the scratch copy's `check_async_blocking.py`. 3. `git checkout` the file |
| Expected result | Exit 1 with the "An `async def` ... does blocking work" message naming both findings |
| Actual result | As expected, exit 1. `git status` clean afterwards (only the tester's `.venv` symlink is untracked) |
| Verdict | Pass |
| Evidence | `unit/UT-G1-031.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:25 UTC |

#### UT-G1-032 — KNOWN ratchet: a known offender that grows a blocking call fails

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-05 |
| Objective | Verify, against the requirement: KNOWN ratchet: a known offender that grows a blocking call fails. |
| Technique / priority | State transition (known → grew) / P1 |
| Preconditions | PC-1 |
| Test data | `time.sleep(0)` added to `close_call` |
| Steps | As UT-G1-031 |
| Expected result | Exit 1, drift `NEW calls time.sleep()` |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-032.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:29 UTC |

#### UT-G1-033 — KNOWN ratchet: a known offender that loses a call fails

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-05 |
| Objective | Verify, against the requirement: KNOWN ratchet: a known offender that loses a call fails. |
| Technique / priority | State transition (known → shrank) / P1 |
| Preconditions | PC-1 |
| Test data | `db.close()` removed from `close_call` |
| Steps | As UT-G1-031 |
| Expected result | Exit 1, drift `GONE calls db.close()` |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-033.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:33 UTC |

#### UT-G1-034 — KNOWN ratchet: a fixed offender must be struck off

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-05 |
| Objective | Verify, against the requirement: KNOWN ratchet: a fixed offender must be struck off. |
| Technique / priority | State transition (known → fixed) / P1 |
| Preconditions | PC-1 |
| Test data | `close_call` made a plain `def` |
| Steps | As UT-G1-031 |
| Expected result | Exit 1, "Delete them from the dict" naming the key |
| Actual result | As expected, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-034.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:37 UTC |

#### UT-G1-035 — A file under `app/` that does not parse fails the guard (not skipped)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-04 |
| Objective | Verify, against the requirement: A file under `app/` that does not parse fails the guard (not skipped). |
| Technique / priority | Error guessing (fail closed) / P2 |
| Preconditions | PC-1 |
| Test data | `app/_qg_broken.py`: `def broken(:` |
| Steps | 1. Write. 2. Run the guard. 3. Delete |
| Expected result | Non-zero exit naming the syntax error |
| Actual result | `SyntaxError`, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-035.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:41:41 UTC |

#### UT-G1-036 — Bypass attempt: file-level `# ruff: noqa`, a blanket `# noqa` and a coded `noqa` with no reason in `app/`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-02 |
| Objective | Verify, against the requirement: Bypass attempt: file-level `# ruff: noqa`, a blanket `# noqa` and a coded `noqa` with no reason in `app/`. |
| Technique / priority | Error guessing / bypass / P1 |
| Preconditions | PC-1 |
| Test data | Probe with S101 + S602 under each suppression |
| Steps | 1. Write the probe to the scratch worktree. 2. Run `python -m ruff check --config pyproject.toml --no-cache --output-format concise <probe>` from `apps/api-py`. 3. Delete the probe. 4. For information only: same probe with `--extend-select PGH004` |
| Expected result | Refused: REQ-G1-02 and AGENTS.md say an exception in `app/` is a line-level `# noqa: <code>` with a reason, never a file-level ignore |
| Actual result | Both probes pass, exit 0: one comment line switches every selected rule off for the file. No guard in the repository looks for it. ruff's own PGH004 reports both shapes |
| Verdict | Fail (DEF-QG-U03) |
| Evidence | `unit/UT-G1-036.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:54:11 UTC |

#### UT-G2-001 — `reep-auth-secret`: dotenv and quoted Python assignment

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `reep-auth-secret`: dotenv and quoted Python assignment. |
| Technique / priority | EP / P1 |
| Preconditions | PC-2 |
| Test data | `AUTH_SECRET=<64 hex>`; `AUTH_SECRET = "<40 alnum>"` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | One `reep-auth-secret` finding each, exit 1 |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-001.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:33 UTC |

#### UT-G2-002 — `AUTH_SECRET:` in YAML with the value on the next, indented line

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `AUTH_SECRET:` in YAML with the value on the next, indented line. |
| Technique / priority | EP / P1 |
| Preconditions | PC-2 |
| Test data | k8s `stringData` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | `reep-auth-secret` at line 2 |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-002.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:32 UTC |

#### UT-G2-003 — Boundary: the next line is a new top-level key, not a value

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Boundary: the next line is a new top-level key, not a value. |
| Technique / priority | Boundary value / P2 |
| Preconditions | PC-2 |
| Test data | `AUTH_SECRET:` then `NEXT_TOP_LEVEL_KEY...: 1` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | No finding |
| Actual result | 0 findings, exit 0 |
| Verdict | Pass |
| Evidence | `unit/UT-G2-003.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:31 UTC |

#### UT-G2-004 — Value length 31 vs 32 (the `{32,}` floor)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Value length 31 vs 32 (the `{32,}` floor). |
| Technique / priority | Boundary value / P2 |
| Preconditions | PC-2 |
| Test data | 31 and 32 alnum characters |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | 32: `reep-auth-secret`; 31: not that rule |
| Actual result | 32: `reep-auth-secret`. 31: `reep-auth-secret` silent; gitleaks' `generic-api-key` still reports it |
| Verdict | Pass |
| Evidence | `unit/UT-G2-004.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:30 UTC |

#### UT-G2-005 — `reep-env-name-value-pair` in JSON and YAML; a short value stays quiet

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `reep-env-name-value-pair` in JSON and YAML; a short value stays quiet. |
| Technique / priority | EP + boundary / P1 |
| Preconditions | PC-2 |
| Test data | `SES_SMTP_PASSWORD`/`PAYMENT_API_KEY` with 20-char values; `value: short` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | Two findings; short value quiet |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-005.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:28 UTC |

#### UT-G2-006 — `reep-database-url-password`: `+psycopg`, `postgresql://`, `postgres://`; 3-character password quiet

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `reep-database-url-password`: `+psycopg`, `postgresql://`, `postgres://`; 3-character password quiet. |
| Technique / priority | EP + boundary / P1 |
| Preconditions | PC-2 |
| Test data | Four URLs |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | Three findings, one quiet |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-006.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:25 UTC |

#### UT-G2-007 — Provider variables: OPENAI, GROQ (name and `gsk_` shape), LIVEKIT, VOICE_WORKER

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Provider variables: OPENAI, GROQ (name and `gsk_` shape), LIVEKIT, VOICE_WORKER. |
| Technique / priority | EP / P1 |
| Preconditions | PC-2 |
| Test data | Five dotenv/notes files |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | Each reported by its REEP rule |
| Actual result | As expected (LIVEKIT also by `generic-api-key`) |
| Verdict | Pass |
| Evidence | `unit/UT-G2-007.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:22 UTC |

#### UT-G2-008 — gitleaks default shapes: `ghp_` token, AKIA + secret pair, RSA private key

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: gitleaks default shapes: `ghp_` token, AKIA + secret pair, RSA private key. |
| Technique / priority | EP / P1 |
| Preconditions | PC-2 |
| Test data | Three files |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | `github-pat`, `aws-access-token`, `private-key` |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-008.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:38 UTC |

#### UT-G2-009 — Published dev values and placeholders stay quiet

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Published dev values and placeholders stay quiet. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-2 |
| Test data | `reep_dev_password` URL, CI AUTH_SECRET, dev AUTH_SECRET, `change-me`, `${VAR}`, `GROQ_API_KEY=`, `<your openai api key>` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | No findings |
| Actual result | 0 findings in all six files |
| Verdict | Pass |
| Evidence | `unit/UT-G2-009.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:34 UTC |

#### UT-G2-010 — A real secret on the same line as an allowlisted value is still caught (`regexTarget = match`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: A real secret on the same line as an allowlisted value is still caught (`regexTarget = match`). |
| Technique / priority | Boundary / bypass attempt / P1 |
| Preconditions | PC-2 |
| Test data | `ghp_` beside `reep_dev_password`; AUTH_SECRET beside `# change-me`; DB URL beside the CI AUTH_SECRET |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | Each caught |
| Actual result | `github-pat`, `reep-auth-secret`, `reep-database-url-password` |
| Verdict | Pass |
| Evidence | `unit/UT-G2-010.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:41 UTC |

#### UT-G2-011 — `reep-bare-token-hex`: 64 hex beside "token" caught; beside "sha256" quiet

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `reep-bare-token-hex`: 64 hex beside "token" caught; beside "sha256" quiet. |
| Technique / priority | EP / P2 |
| Preconditions | PC-2 |
| Test data | Two runbook lines |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | One finding, one quiet |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-011.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:43 UTC |

#### UT-G2-012 — `--redact`: the value is in neither stdout nor the JSON report; the log names file, line and rule

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-06 |
| Objective | Verify, against the requirement: `--redact`: the value is in neither stdout nor the JSON report; the log names file, line and rule. |
| Technique / priority | EP / P1 |
| Preconditions | PC-2 |
| Test data | Cases 008a, 001, 006a |
| Steps | 1. gitleaks `--redact --verbose` with a JSON report. 2. grep both outputs for the raw value |
| Expected result | 0 occurrences; `Secret: REDACTED`; `File`, `Line`, `RuleID` printed |
| Actual result | 0 and 0 in all three; `Match: AUTH_SECRET=REDACTED`. (One block used a dotfile glob that matched nothing; re-run, noted in the file) |
| Verdict | Pass |
| Evidence | `unit/UT-G2-012.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:52 UTC |

#### UT-G2-013 — `.gitleaksignore` is exact: a fingerprint frees one line, a wrong line number frees nothing

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `.gitleaksignore` is exact: a fingerprint frees one line, a wrong line number frees nothing. |
| Technique / priority | Boundary / P2 |
| Preconditions | PC-2 |
| Test data | Two OPENAI lines |
| Steps | 1. Scan to get fingerprints. 2. Ignore `case/app.env:reep-openai-key:1`. 3. Ignore line 7 instead. 4. Check the shipped file's format |
| Expected result | Step 2: only line 2 reported; step 3: both reported; shipped entries are 4-field `commit:file:rule:line` |
| Actual result | As expected; 17 shipped entries, all 4 fields with a 40-char sha |
| Verdict | Pass |
| Evidence | `unit/UT-G2-013.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:36:07 UTC |

#### UT-G2-014 — Bypass attempt: a real-shaped value that contains an allowlisted placeholder

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Bypass attempt: a real-shaped value that contains an allowlisted placeholder. |
| Technique / priority | Error guessing / bypass / P2 |
| Preconditions | PC-2 |
| Test data | `AUTH_SECRET=change-me-<40>`; `AUTH_SECRET="${X}<40>"`; `OPENAI_API_KEY=changeme<40 hex>`; `postgresql://admin:changeme<20 hex>@db.example.com/...` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). |
| Expected result | Caught (only the placeholder itself should be free) |
| Actual result | All four quiet. For AUTH_SECRET this is harmless: the production boot guard refuses any value containing `change-me`. For other variables nothing refuses it |
| Verdict | Fail (OBS-QG-U01) |
| Evidence | `unit/UT-G2-014.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:35:40 UTC |

#### UT-G2-016 — `check_gitleaks_rules.py` on the shipped configuration

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: `check_gitleaks_rules.py` on the shipped configuration. |
| Technique / priority | Positive / P1 |
| Preconditions | PC-2 |
| Test data | Its own 13 leaks / 6 quiet files |
| Steps | 1. `python3 tools/ci/check_gitleaks_rules.py` |
| Expected result | 13 caught, 6 quiet, exit 0 |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-016.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:36:16 UTC |

#### UT-G2-017 — The replay fails when the configuration is broken (scratch copy), and fails closed without gitleaks

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: The replay fails when the configuration is broken (scratch copy), and fails closed without gitleaks. |
| Technique / priority | State transition / negative / P1 |
| Preconditions | PC-2 |
| Test data | Scratch `.gitleaks.toml`: (a) `regexTarget = "line"`; (b) `{32,}` → `{80,}`; (c) no gitleaks on PATH |
| Steps | 1. Edit the scratch copy. 2. Run the replay. 3. `git checkout` |
| Expected result | (a) and (b) exit 1 naming missed leaks; (c) exit 1 |
| Actual result | (a) 5 leaks missed, exit 1; (b) 2 missed, exit 1; (c) `FAILED: gitleaks is not on PATH`, exit 1. Scratch worktree clean afterwards |
| Verdict | Pass |
| Evidence | `unit/UT-G2-017.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:36:18 UTC |

#### UT-G2-018 — The repository's history and tree are clean under the shipped configuration

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-08 |
| Objective | Verify, against the requirement: The repository's history and tree are clean under the shipped configuration. |
| Technique / priority | Regression / P1 |
| Preconditions | PC-2 |
| Test data | `--log-opts=--all` (837 commits), `15a9e7d..a3688f0` (20 commits), `git archive a3688f0` scanned from its own root |
| Steps | 1. `gitleaks git . ... --log-opts='--all'` 2. same with the PR range 3. `gitleaks dir .` inside the extracted archive |
| Expected result | `no leaks found` three times |
| Actual result | As expected. A first tree scan by absolute path reported 4 lines that are path-allowlisted (tester's error; CI and preflight scan from the root). See OBS-QG-U02 |
| Verdict | Pass (OBS-QG-U02) |
| Evidence | `unit/UT-G2-018.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:36:35 UTC |

#### UT-G2-020 — The sha256 pinned in `secret-scan.yml` matches the release, and a changed tarball fails the check

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-01 |
| Objective | Verify, against the requirement: The sha256 pinned in `secret-scan.yml` matches the release, and a changed tarball fails the check. |
| Technique / priority | EP + negative / P1 |
| Preconditions | Tarball and `checksums.txt` downloaded from the v8.30.0 release |
| Test data | Pinned value; release checksums; one-byte-altered copy |
| Steps | 1. Compare the pinned value, the release file and `sha256sum`. 2. `sha256sum --check --strict` as the workflow does, on the real and the altered tarball |
| Expected result | Equal; real OK; altered FAILED, exit 1 |
| Actual result | `79a3ab57...a66e` in all three; `OK`; `FAILED`, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G2-020.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:33:58 UTC |

#### UT-G2-021 — Bypass attempt: gitleaks' inline `gitleaks:allow` comment beside a real AUTH_SECRET

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Bypass attempt: gitleaks' inline `gitleaks:allow` comment beside a real AUTH_SECRET. |
| Technique / priority | Error guessing / bypass / P1 |
| Preconditions | PC-2 |
| Test data | Control file and the same line with `# gitleaks:allow` |
| Steps | 1. Generate the case file with `mkleaks.py` (fake values, outside the repo). 2. Print it masked (`show`). 3. Run `gitleaks dir <case> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1 --report-format json` (`gl`). 4. For information only: the same with `--ignore-gitleaks-allow` |
| Expected result | Caught: REQ-G2-05 allows allowlisting only by value or by fingerprint, with a reason |
| Actual result | Control: 1 finding. With the comment: 0 findings, exit 0. Neither `secret-scan.yml`, `preflight.sh` nor `.pre-commit-config.yaml` passes `--ignore-gitleaks-allow`, which restores the finding |
| Verdict | Fail (DEF-QG-U04) |
| Evidence | `unit/UT-G2-021.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:54:30 UTC |

#### UT-G3-000 — Baseline: the unmodified audit and reversibility tests pass

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-01..07, REQ-G4-01 |
| Objective | Verify, against the requirement: Baseline: the unmodified audit and reversibility tests pass. |
| Technique / priority | Positive / P1 |
| Preconditions | Repository at head |
| Test data | — |
| Steps | 1. `pytest tests/test_route_audit.py tests/test_migration_reversibility.py` |
| Expected result | All pass |
| Actual result | 27 passed |
| Verdict | Pass |
| Evidence | `unit/UT-G3-000.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:55:33 UTC |

#### UT-G3-001 — AUTH: a route with no session

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-02 |
| Objective | Verify, against the requirement: AUTH: a route with no session. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `GET /api/qg/p01-open` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | AUTH (session) new violation |
| Actual result | Reported: `no session dependency` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-001.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-002 — GATE: a session and no gate

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: GATE: a session and no gate. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `p02-nogate` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | AUTH (gate) new violation |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-002.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-003 — A role comparison that raises counts as a gate

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A role comparison that raises counts as a gate. |
| Technique / priority | EP (allowed) / P1 |
| Preconditions | PC-3 |
| Test data | `if session.get("role") != "ADMIN": raise HTTPException(403)` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Not reported |
| Actual result | Not reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-003.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-004 — A role comparison that refuses nothing does not count

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A role comparison that refuses nothing does not count. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-3 |
| Test data | `is_admin = session.get("role") == "ADMIN"` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-004.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-005 — `if False: require_admin(session)` does not count

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: `if False: require_admin(session)` does not count. |
| Technique / priority | Negative (dead code) / P1 |
| Preconditions | PC-3 |
| Test data | `p05-if-false` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-005.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-006 — A gate reached through an `app/` helper counts

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A gate reached through an `app/` helper counts. |
| Technique / priority | EP (allowed) / P1 |
| Preconditions | PC-3 |
| Test data | `_helper_gate(session)` → `require_admin` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. 4. Call it as a STUDENT |
| Expected result | Not reported; STUDENT refused |
| Actual result | Not reported; STUDENT → 403 |
| Verdict | Pass |
| Evidence | `unit/UT-G3-006.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-007 — Bypass attempt: the gate is unreachable (after `return`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt: the gate is unreachable (after `return`). |
| Technique / priority | Error guessing (dead code) / P2 |
| Preconditions | PC-3 |
| Test data | `return Out()` then `require_admin(session)` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. 4. Call it as a STUDENT (TestClient, session dependency overridden) |
| Expected result | Reported: REQ-G3-03 says a gate in dead code does not count |
| Actual result | Not reported; a STUDENT session gets 200 |
| Verdict | Fail (DEF-QG-U02) |
| Evidence | `unit/UT-G3-007.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:43:46 UTC |

#### UT-G3-008 — Bypass attempt: a gate whose refusal is caught (`try: require_admin(...) except HTTPException: pass`), and a handler whose only "gate" is the existing predicate helper `interview_records._may_see_raw_response`, which calls `require_admin` and catches it

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt: a gate whose refusal is caught (`try: require_admin(...) except HTTPException: pass`), and a handler whose only "gate" is the existing predicate helper `interview_records._may_see_raw_response`, which calls `require_admin` and catches it. |
| Technique / priority | Error guessing / P1 |
| Preconditions | PC-3 |
| Test data | `p08-swallowed`, `p11-predicate-only` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. 4. Call both as a STUDENT |
| Expected result | Reported: neither can refuse anybody (REQ-G3-03: "a gate that can refuse") |
| Actual result | Neither reported; a STUDENT gets 200 from both |
| Verdict | Fail (DEF-QG-U01) |
| Evidence | `unit/UT-G3-008.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:43:46 UTC |

#### UT-G3-009 — Bypass attempt: other dead-code shapes: `if not True:`, `while False:`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt: other dead-code shapes: `if not True:`, `while False:`. |
| Technique / priority | Error guessing (dead code) / P3 |
| Preconditions | PC-3 |
| Test data | `p09-if-not-true`, `p10-while-false` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. 4. Call both as a STUDENT |
| Expected result | Reported |
| Actual result | Neither reported; STUDENT gets 200 from both |
| Verdict | Fail (DEF-QG-U02) |
| Evidence | `unit/UT-G3-009.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:43:47 UTC |

#### UT-G3-010 — RESPONSE: `-> dict`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: RESPONSE: `-> dict`. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `r01-dict` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported (dict) |
| Actual result | Reported: `untyped response model (dict)` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-010.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-011 — RESPONSE: `-> Any`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: RESPONSE: `-> Any`. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `r02-any` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported: `typing.Any` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-011.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-012 — RESPONSE: `-> dict[str, Any]`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: RESPONSE: `-> dict[str, Any]`. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `r03-dict-str-any` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported: `typing.Any` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-012.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-013 — RESPONSE: `-> list[dict]` (paginated, so only this rule applies)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: RESPONSE: `-> list[dict]` (paginated, so only this rule applies). |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `r04-list-dict` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported: `dict` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-013.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-014 — `-> dict[str, SomeModel]` is typed and passes

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: `-> dict[str, SomeModel]` is typed and passes. |
| Technique / priority | EP (allowed) / P2 |
| Preconditions | PC-3 |
| Test data | `r05-dict-str-model` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Not reported |
| Actual result | Not reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-014.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-015 — Bypass attempt: `RootModel[dict[str, Any]]`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: Bypass attempt: `RootModel[dict[str, Any]]`. |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-3 |
| Test data | `class Loose(RootModel[dict[str, Any]])` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported (a dict/Any leaf) |
| Actual result | Not reported: a Pydantic model is treated as a leaf and never looked inside (documented in `_untyped_parts`) |
| Verdict | Fail (OBS-QG-U04) |
| Evidence | `unit/UT-G3-015.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-016 — No annotation and no `response_model` on a JSON route

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: No annotation and no `response_model` on a JSON route. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `r07-unannotated` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported: `JSON body with no response model` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-016.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-017 — STATUS: POST to a plural collection answering 200 is reported; 201 passes

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-05 |
| Objective | Verify, against the requirement: STATUS: POST to a plural collection answering 200 is reported; 201 passes. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `POST /api/qg/widgets` (200), `POST /api/qg/gadgets` (201) |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | widgets reported; gadgets not |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G3-017.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-018 — STATUS: 204 with a body

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-05 |
| Objective | Verify, against the requirement: STATUS: 204 with a body. |
| Technique / priority | EP / P2 |
| Preconditions | PC-1 (venv) |
| Test data | `add_api_route(..., status_code=204, response_model=Out)` |
| Steps | 1. Build the route with FastAPI. 2. Read the audit's rule |
| Expected result | Refused somewhere |
| Actual result | FastAPI itself refuses at route creation: `Status code 204 must not have a response body`; the audit's rule (line 678) is a second line |
| Verdict | Pass |
| Evidence | `unit/UT-G3-018.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:44:09 UTC |

#### UT-G3-019 — STATUS: DELETE with an untyped body is reported; DELETE 204 passes

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-05 |
| Objective | Verify, against the requirement: STATUS: DELETE with an untyped body is reported; DELETE 204 passes. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `DELETE /widgets/{wid}` (200, no model), `DELETE /gadgets/{gid}` (204) |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Untyped DELETE reported (STATUS and RESPONSE); 204 not |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G3-019.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-020 — PAGINATION: a bare list with no page parameters

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-06 |
| Objective | Verify, against the requirement: PAGINATION: a bare list with no page parameters. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `l01-list` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-020.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-021 — `limit` without `le=` (and `offset`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-06 |
| Objective | Verify, against the requirement: `limit` without `le=` (and `offset`). |
| Technique / priority | Boundary / P1 |
| Preconditions | PC-3 |
| Test data | `l02-limit-no-le` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported (no bound) |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-021.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-022 — `limit: int = Query(50, le=200)` without an offset or cursor

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-06 |
| Objective | Verify, against the requirement: `limit: int = Query(50, le=200)` without an offset or cursor. |
| Technique / priority | Decision rule / P2 |
| Preconditions | PC-3 |
| Test data | `l03-le-no-offset` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported (the rule asks for a bounded size AND an offset/cursor) |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-022.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-023 — `limit` with `le=` plus `offset` passes

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-06 |
| Objective | Verify, against the requirement: `limit` with `le=` plus `offset` passes. |
| Technique / priority | EP (allowed) / P1 |
| Preconditions | PC-3 |
| Test data | `l04-paginated` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Not reported |
| Actual result | Not reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-023.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-024 — A WebSocket that never reads the session

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-02 |
| Objective | Verify, against the requirement: A WebSocket that never reads the session. |
| Technique / priority | EP / P1 |
| Preconditions | PC-3 |
| Test data | `/api/qg/w01-ws` |
| Steps | 1. Mount the probe handler(s) in the scratch worktree (`app/routers/qg_probe.py`, included in its `app/main.py`). 2. Run `pytest tests/test_route_audit.py`. 3. Look for the probe path in the failure output. |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-024.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:42:37 UTC |

#### UT-G3-025 — Ratchet: a stale entry in each of the six exception lists

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-07 |
| Objective | Verify, against the requirement: Ratchet: a stale entry in each of the six exception lists. |
| Technique / priority | State transition (listed → fixed) / P1 |
| Preconditions | PC-3 without the probe router |
| Test data | One `/zz-qg-stale-N` entry appended to each list, sorted |
| Steps | 1. Append (scratch). 2. Run the audit. 3. `git checkout` |
| Expected result | Each list's rule says "Strike it off" naming its entry |
| Actual result | AUTH (session) -0, AUTH (gate) -1, RESPONSE -2, STATUS -3, PAGINATION -4 and -5 (BOUNDED and KNOWN_UNPAGINATED share one rule): all "Strike it off" |
| Verdict | Pass |
| Evidence | `unit/UT-G3-025.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:44:18 UTC |

#### UT-G3-026 — An entry naming a different handler is not inherited

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-07 |
| Objective | Verify, against the requirement: An entry naming a different handler is not inherited. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-3 without the probe router |
| Test data | `POST /api/auth/forgot` entry renamed to `...forgot_v2` |
| Steps | 1. Edit (scratch). 2. Run the AUTH test. 3. `git checkout` |
| Expected result | New violation, saying the list grants it to another handler |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G3-026.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:44:38 UTC |

#### UT-G3-027 — The audit needs no database and does not depend on order

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-08 |
| Objective | Verify, against the requirement: The audit needs no database and does not depend on order. |
| Technique / priority | EP + order permutation / P1 |
| Preconditions | Repository at head; `DATABASE_URL` at `127.0.0.1:1` (nothing listening) |
| Test data | Two orders |
| Steps | 1. `pytest test_route_audit.py test_codebase_guards.py` 2. reverse order 3. audit alone 4. with `REEP_REQUIRE_DB=1` |
| Expected result | Pass in every order without a database |
| Actual result | 76 passed in both orders; audit alone passes. With `REEP_REQUIRE_DB=1` conftest refuses the whole session by design (CI always has Postgres) |
| Verdict | Pass |
| Evidence | `unit/UT-G3-027.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:44:50 UTC |

#### UT-G3-028 — The 300-operation floor, at the boundary, and a broken walk

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-01 |
| Objective | Verify, against the requirement: The 300-operation floor, at the boundary, and a broken walk. |
| Technique / priority | Boundary value / P1 |
| Preconditions | Repository at head |
| Test data | `MIN_HTTP_OPERATIONS` set to n-1, n, n+1; a walk returning only the docs routes |
| Steps | 1. Import the test module. 2. Run the inventory test with each floor. 3. Simulate an empty walk |
| Expected result | n=376: 375 and 376 pass, 377 fails; empty walk fails |
| Actual result | As expected (376 HTTP, 3 WebSockets) |
| Verdict | Pass |
| Evidence | `unit/UT-G3-028.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:45:56 UTC |

#### UT-G4-001 — A new head whose `downgrade()` is `pass`, with no entry, fails

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: A new head whose `downgrade()` is `pass`, with no entry, fails. |
| Technique / priority | EP / P1 |
| Preconditions | PC-4 |
| Test data | `aaaa00000001` on `f4a2c9e7b1d3` |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. |
| Expected result | Fails: `downgrade is no-op` |
| Actual result | As expected (1 failed, 9 passed) |
| Verdict | Pass |
| Evidence | `unit/UT-G4-001.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:26 UTC |

#### UT-G4-002 — The same with an `IRREVERSIBLE` no-op entry passes

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: The same with an `IRREVERSIBLE` no-op entry passes. |
| Technique / priority | State transition / P1 |
| Preconditions | PC-4 |
| Test data | Entry added in the scratch `reversibility.py` |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. |
| Expected result | 10 passed |
| Actual result | 10 passed |
| Verdict | Pass |
| Evidence | `unit/UT-G4-002.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:29 UTC |

#### UT-G4-003 — An entry on a revision that now has a real downgrade must be struck off

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: An entry on a revision that now has a real downgrade must be struck off. |
| Technique / priority | State transition (declared → fixed) / P1 |
| Preconditions | PC-4 |
| Test data | Entry kept, downgrade made real |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. |
| Expected result | Fails: declared `no-op` but now `real` |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-003.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:32 UTC |

#### UT-G4-004 — A `raises` downgrade at the head: undeclared fails; declared is legal and becomes the floor

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: A `raises` downgrade at the head: undeclared fails; declared is legal and becomes the floor. |
| Technique / priority | Boundary (floor at head) / P1 |
| Preconditions | PC-4 |
| Test data | `raise RuntimeError(...)` |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. 4. `check_migration_roundtrip.py --plan` |
| Expected result | Undeclared fails; declared passes; plan shows floor = head and an empty last segment |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-004.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:45 UTC |

#### UT-G4-005 — Two heads fail

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: Two heads fail. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-4 |
| Test data | Two revisions on `f4a2c9e7b1d3` |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. |
| Expected result | Fails naming both heads |
| Actual result | `expected exactly one head, found ['aaaa00000001', 'aaaa00000002']` |
| Verdict | Pass |
| Evidence | `unit/UT-G4-005.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:51 UTC |

#### UT-G4-006 — No `downgrade()` at all fails

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: No `downgrade()` at all fails. |
| Technique / priority | Negative / P1 |
| Preconditions | PC-4 |
| Test data | Revision without the function |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. |
| Expected result | Fails |
| Actual result | Fails in two tests (`missing`) |
| Verdict | Pass |
| Evidence | `unit/UT-G4-006.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:54 UTC |

#### UT-G4-007 — Bypass attempt: a downgrade that does nothing but is not `pass`: `return`, and `if False: ...`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: Bypass attempt: a downgrade that does nothing but is not `pass`: `return`, and `if False: ...`. |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-4 |
| Test data | Three chained revisions: `return`; docstring + `...`; `if False: op.execute(...)` |
| Steps | 1. Add the probe revision to the scratch worktree's `migrations/versions/`. 2. Run `pytest tests/test_migration_reversibility.py`. 3. Remove the probe. |
| Expected result | All three reported as not doing real work |
| Actual result | Only the docstring + `...` one is reported. `return` and `if False:` are classified `real` and pass. The round trip catches them only when the upgrade changed the schema (UT-G4-013); a data-only upgrade passes both |
| Verdict | Fail (DEF-QG-U06) |
| Evidence | `unit/UT-G4-007.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:57 UTC |

#### UT-G4-010 — Baseline: the round trip passes on the shipped chain

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-02 |
| Objective | Verify, against the requirement: Baseline: the round trip passes on the shipped chain. |
| Technique / priority | Positive / P1 |
| Preconditions | `reep_py` migrated to head |
| Test data | — |
| Steps | 1. `check_migration_roundtrip.py` |
| Expected result | Exit 0 |
| Actual result | 90 of 92 downgrades in 3 segments, 2118 catalogue lines, `alembic check` clean, 22 s, exit 0 |
| Verdict | Pass |
| Evidence | `unit/UT-G4-010.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:46:18 UTC |

#### UT-G4-011 — An incomplete downgrade (forgets a table) is caught

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-03 |
| Objective | Verify, against the requirement: An incomplete downgrade (forgets a table) is caught. |
| Technique / priority | EP / P1 |
| Preconditions | PC-4 |
| Test data | Upgrade adds a column and a table; downgrade drops only the column |
| Steps | 1. Create the case's own database and `alembic upgrade head` it from the scratch worktree (with the probe revision). 2. Run `python ../../tools/ci/check_migration_roundtrip.py`. 3. Drop the case database and its `_roundtrip` scratch. |
| Expected result | Exit 1, diff shows the table left behind at the bottom |
| Actual result | As expected (roundtrip_exit=1) |
| Verdict | Pass |
| Evidence | `unit/UT-G4-011.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:47:29 UTC |

#### UT-G4-012 — A downgrade that restores the wrong default is caught

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-03 |
| Objective | Verify, against the requirement: A downgrade that restores the wrong default is caught. |
| Technique / priority | EP / P1 |
| Preconditions | PC-4 |
| Test data | `resumes.title` default set to 'QG Resume', "restored" to 'My Resume' (was 'REEP Resume') |
| Steps | 1. Create the case's own database and `alembic upgrade head` it from the scratch worktree (with the probe revision). 2. Run `python ../../tools/ci/check_migration_roundtrip.py`. 3. Drop the case database and its `_roundtrip` scratch. |
| Expected result | Exit 1, diff on the column default |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-012.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:48:33 UTC |

#### UT-G4-013 — A `return`-only downgrade under a schema-changing upgrade is caught by the round trip

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-03 |
| Objective | Verify, against the requirement: A `return`-only downgrade under a schema-changing upgrade is caught by the round trip. |
| Technique / priority | EP / P2 |
| Preconditions | PC-4 |
| Test data | Upgrade adds a column; downgrade `return` |
| Steps | 1. Create the case's own database and `alembic upgrade head` it from the scratch worktree (with the probe revision). 2. Run `python ../../tools/ci/check_migration_roundtrip.py`. 3. Drop the case database and its `_roundtrip` scratch. |
| Expected result | Exit 1 |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-013.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:48:56 UTC |

#### UT-G4-014 — KEPT_ON_DOWNGRADE ratchet: a declared leftover that is not left behind fails

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-03 |
| Objective | Verify, against the requirement: KEPT_ON_DOWNGRADE ratchet: a declared leftover that is not left behind fails. |
| Technique / priority | State transition / P1 |
| Preconditions | PC-4 |
| Test data | `("table", "qg_never_left_behind")` on `f4a2c9e7b1d3` |
| Steps | 1. Create the case's own database and `alembic upgrade head` it from the scratch worktree (with the probe revision). 2. Run `python ../../tools/ci/check_migration_roundtrip.py`. 3. Drop the case database and its `_roundtrip` scratch. |
| Expected result | Exit 1, "must be struck off" |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-014.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:49:26 UTC |

#### UT-G4-015 — `segments()` / `rollback_floor()` on synthetic five-revision chains

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: `segments()` / `rollback_floor()` on synthetic five-revision chains. |
| Technique / priority | Decision table / P1 |
| Preconditions | Read-only import of `reversibility.py` |
| Test data | No refusing revision; one in the middle; at the head; at the base; two adjacent; a `no-op` entry; a branch; a merge |
| Steps | 1. `seg.py` |
| Expected result | Segments and floor as derived by hand |
| Actual result | All as expected; branch and merge refused |
| Verdict | Pass |
| Evidence | `unit/UT-G4-015.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:50:02 UTC |

#### UT-G4-016 — Nothing exercisable means exit 2, not a pass

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-03 |
| Objective | Verify, against the requirement: Nothing exercisable means exit 2, not a pass. |
| Technique / priority | Boundary / P2 |
| Preconditions | PC-4 |
| Test data | Every revision marked `raises` (scratch) |
| Steps | 1. Patch. 2. Run the script. 3. `git checkout` |
| Expected result | Exit 2 |
| Actual result | `exercised 0 of 92`, `FAILED: ... not a pass`, exit 2 |
| Verdict | Pass |
| Evidence | `unit/UT-G4-016.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:50:10 UTC |

#### UT-G4-017 — Refusal decision table: ENV

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: Refusal decision table: ENV. |
| Technique / priority | Decision table / P1 |
| Preconditions | Repository at head |
| Test data | dev, development, test, testing, ci, local, DEV, prod, production, staging, uat, blank, `dve` |
| Steps | 1. Run `dt.sh ENV URL EXPECT`: the real script with `--plan` (the refusal runs first; `--plan` touches nothing). 2. Compare RUNS/REFUSED with the expected column. |
| Expected result | The six dev names (any case) run; everything else refused |
| Actual result | All as expected (the `DEV` row's expected value was the tester's error: `_is_dev_env` folds case; noted in the file) |
| Verdict | Pass |
| Evidence | `unit/UT-G4-017.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:50:27 UTC |

#### UT-G4-018 — Refusal decision table: host

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: Refusal decision table: host. |
| Technique / priority | Decision table / P1 |
| Preconditions | Repository at head |
| Test data | localhost, LOCALHOST, 127.0.0.1, [::1], a Unix socket, 127.0.0.2, db.example.com, 10.0.0.5, 0.0.0.0, localhost.example.com, `?host=`, `?hostaddr=`, comma lists, no host |
| Steps | 1. Run `dt.sh ENV URL EXPECT`: the real script with `--plan` (the refusal runs first; `--plan` touches nothing). 2. Compare RUNS/REFUSED with the expected column. |
| Expected result | Loopback and Unix socket run; everything else refused (127.0.0.2 is loopback by definition) |
| Actual result | All 16 rows as expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-018.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:50:48 UTC |

#### UT-G4-019 — Refusal decision table: database name

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: Refusal decision table: database name. |
| Technique / priority | Decision table / P1 |
| Preconditions | Repository at head |
| Test data | reep_prod, prod_reep, REEP_PROD, reep_production, reep_py, reep_u_test |
| Steps | 1. Run `dt.sh ENV URL EXPECT`: the real script with `--plan` (the refusal runs first; `--plan` touches nothing). 2. Compare RUNS/REFUSED with the expected column. |
| Expected result | The four "prod" names refused |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-019.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:50:58 UTC |

#### UT-G4-020 — Bypass attempt: a non-loopback address given through libpq's `PGHOSTADDR` environment variable

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: Bypass attempt: a non-loopback address given through libpq's `PGHOSTADDR` environment variable. |
| Technique / priority | Error guessing / P2 |
| Preconditions | Repository at head |
| Test data | URL `@localhost:5433/reep_py`, `PGHOSTADDR=192.0.2.1` |
| Steps | 1. `dt.sh` with `PGHOSTADDR` set. 2. Same engine as the script: `libpq_hosts()`, `refusal()`, connect. 3. Control without the variable |
| Expected result | Refused |
| Actual result | Not refused (`libpq_hosts()` sees only `localhost`); the connection actually goes to `192.0.2.1:5433`. Control connects to 127.0.0.1 |
| Verdict | Fail (DEF-QG-U05) |
| Evidence | `unit/UT-G4-020.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:51:17 UTC |

#### UT-G4-021 — Regression of the CI defect: a server behind a port mapping (it reports a non-loopback address) is not refused; compared with the script before the fix

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: Regression of the CI defect: a server behind a port mapping (it reports a non-loopback address) is not refused; compared with the script before the fix. |
| Technique / priority | Comparison (before/after) / P1 |
| Preconditions | Postgres also on 192.0.2.2; a TCP forwarder 127.0.0.1:55433 → 192.0.2.2:5433; database `reep_u_g4_portmap` at head |
| Test data | — |
| Steps | 1. Fixed script through the mapping. 2. `git show 9bf54d8^:tools/ci/check_migration_roundtrip.py` through the same mapping |
| Expected result | Fixed: full run, exit 0. Before: refused |
| Actual result | Fixed: `OK: 90 of 92`, exit 0, 23 s. Before: `refusing to run: the server reports it is listening on 192.0.2.2` |
| Verdict | Pass |
| Evidence | `unit/UT-G4-021.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:52:08 UTC |

#### UT-G4-022 — `managed_server()`: rds.*, aurora*, cloudsql.*, azure.* settings and `rds.superuser_variables` refuse; a plain server runs; an unreachable server fails closed

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: `managed_server()`: rds.*, aurora*, cloudsql.*, azure.* settings and `rds.superuser_variables` refuse; a plain server runs; an unreachable server fails closed. |
| Technique / priority | Decision table (stubbed engine) / P1 |
| Preconditions | Repository at head |
| Test data | Stub engine answering the two queries; the real local server; `127.0.0.1:1` |
| Steps | 1. Call `managed_server()` per row. 2. Real server. 3. Full script against port 1 |
| Expected result | 5 refused, 1 runs, local runs, port 1 exit 1 |
| Actual result | As expected; `FAILED: could not connect to ask the server what it is`, exit 1 |
| Verdict | Pass |
| Evidence | `unit/UT-G4-022.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:52:45 UTC |

#### UT-G4-023 — `without()` / `present()` / `compare()`: declared leftovers ignored, undeclared ones still fail

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-03 |
| Objective | Verify, against the requirement: `without()` / `present()` / `compare()`: declared leftovers ignored, undeclared ones still fail. |
| Technique / priority | EP / P2 |
| Preconditions | Read-only import |
| Test data | Synthetic catalogue lines |
| Steps | 1. Call the three functions |
| Expected result | Declared ignored; undeclared differ; compare raises |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-023.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:52:57 UTC |

#### UT-GX-001 — preflight's `GITLEAKS_PINNED` parsing (line 211, evaluated verbatim)

| Field | Value |
|---|---|
| Requirement(s) | REQ-GX-02 |
| Objective | Verify, against the requirement: preflight's `GITLEAKS_PINNED` parsing (line 211, evaluated verbatim). |
| Technique / priority | EP + boundary / P2 |
| Preconditions | PC-5 |
| Test data | Fake REPO_ROOTs: the real workflow, indent/spacing/comment variants, CRLF, single quotes, no quotes, no key, no file |
| Steps | 1. Eval lines 211-212 per root. 2. For an empty pin, eval `check_secrets()` (449-458) with stubs |
| Expected result | The pinned version, or a fail-safe SKIP; never a PASS on a wrong version |
| Actual result | Double-quoted forms parse (8.30.0, 9.1.2, CRLF, comment line ignored). Single-quoted and unquoted parse to empty, and `check_secrets` then records SKIP with "gitleaks 8.30.0 is not v". Fail-safe, but the message is misleading |
| Verdict | Pass (OBS-QG-U05) |
| Evidence | `unit/UT-GX-001.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:53:24 UTC |

#### UT-GX-002 — preflight `record()` / `should_stop()` / final block → exit code

| Field | Value |
|---|---|
| Requirement(s) | REQ-GX-02 |
| Objective | Verify, against the requirement: preflight `record()` / `should_stop()` / final block → exit code. |
| Technique / priority | Decision table / P1 |
| Preconditions | PC-5 |
| Test data | Result sequences of PASS/FAIL/SKIP/PARTIAL/unknown |
| Steps | 1. `pf_dt.sh`: eval lines 164-176 and 758-777 of `preflight.sh` verbatim, record the sequence, run the final block |
| Expected result | All PASS → 0; any FAIL → 1; otherwise any SKIP/PARTIAL/unknown → 2; FAIL stops the run unless `--keep-going` |
| Actual result | All 10 rows as expected |
| Verdict | Pass |
| Evidence | `unit/UT-GX-002.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:53:12 UTC |

#### UT-G5-001 — Every base heading of the PR template is still there, plus the two new sections

| Field | Value |
|---|---|
| Requirement(s) | REQ-G5-01 |
| Objective | Verify, against the requirement: Every base heading of the PR template is still there, plus the two new sections. |
| Technique / priority | Comparison with base / P1 |
| Preconditions | Repository |
| Test data | `git show 15a9e7d:` vs `a3688f0:` `.github/pull_request_template.md` |
| Steps | 1. List `##` headings at both. 2. `comm -23` |
| Expected result | No base heading missing; "Design and approach (human review)" and "Engineering checklist" added |
| Actual result | As expected (8 → 10 headings) |
| Verdict | Pass |
| Evidence | `unit/UT-G5-001.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:53:43 UTC |

#### UT-G5-002 — Each checklist item names its gate or says *human — no gate*, and every named gate exists

| Field | Value |
|---|---|
| Requirement(s) | REQ-G5-02 |
| Objective | Verify, against the requirement: Each checklist item names its gate or says *human — no gate*, and every named gate exists. |
| Technique / priority | Inspection + cross-check / P1 |
| Preconditions | Repository |
| Test data | 22 checklist items |
| Steps | 1. Parse the section. 2. Classify each item. 3. grep for each named gate |
| Expected result | Every item classified; every named gate found |
| Actual result | 12 machine-backed (route audit, Static analysis, Secrets, migration round-trip, codebase guards), 8 *human — no gate*, 2 other wordings (*not enforced yet*, *human*); every named gate and file exists, including `test_every_foreign_key_column_is_indexed` and `require_idempotency_key`. No item claims a check that does not exist |
| Verdict | Pass (OBS-QG-U06) |
| Evidence | `unit/UT-G5-002.txt` |
| Executed by / date | Tester session U / 2026-10-08T08:53:58 UTC |

### 4.3 New cases added in re-test round 1 (build `40201a1`)

Designed against what the fixes introduced, adversarially (Test Manager's starting points plus the tester's own). Preconditions as §4, on the new build.

| ID | Requirement(s) | Title | Technique | Priority |
|---|---|---|---|---|
| UT-G1-037 | REQ-G1-02 | Bypass attempt on the DEF-QG-U03 fix: the `# flake8: noqa` file-level spelling, which ruff also honours | Error guessing | P2 |
| UT-G1-038 | REQ-G1-02 | Bypass attempt on the DEF-QG-U03 fix: ruff's range-suppression comment `# ruff: disable[<codes>]` | Error guessing / bypass | P1 |
| UT-G1-039 | REQ-G1-02 | §39 and ruff against `noqa` / `ruff: noqa` text inside string literals | Negative | P2 |
| UT-G2-022 | REQ-G2-05 | Boundary of the `<word>` placeholder allowlist accepted with FV-QG-01: a real value with a 3–40 character `<word>` joined to it | Boundary / error guessing | P1 |
| UT-G2-023 | REQ-G2-05 | The new PEM allowlist: a fully masked block is quiet; one real body line is found | Boundary | P1 |
| UT-G2-024 | REQ-G2-05 | FV-QG-01 regression: the masked-evidence convention is quiet; a worded placeholder on an unguarded variable is found | Regression | P1 |
| UT-G2-025 | REQ-G2-05 | A real OpenAI key inside an HTML element (`<code>KEY</code>`) | Error guessing | P3 |
| UT-G2-026 | REQ-G2-05 | The rule replay still guards its founding bug: the global allowlist reverted to `regexTarget = "line"` | State transition / ratchet | P1 |
| UT-G3-029 | REQ-G3-03 | A caught refusal re-raised as a different HTTPException (404) still counts as a gate | EP (allowed) | P2 |
| UT-G3-030 | REQ-G3-03 | A gate after `return` inside a nested branch only | Error guessing (dead code) | P2 |
| UT-G3-031 | REQ-G3-03 | Bypass attempt on the DEF-QG-U01 fix: `with contextlib.suppress(HTTPException): require_admin(session)` | Error guessing | P2 |
| UT-G3-032 | REQ-G3-03 | Bypass attempt: the refusal caught as starlette's base class (`except starlette.exceptions.HTTPException`) | Error guessing | P3 |
| UT-G3-033 | REQ-G3-03 | Bypass attempt: the refusal caught through an import alias (`from fastapi import HTTPException as HE`; `except HE`) | Error guessing | P3 |
| UT-G3-034 | REQ-G3-03 | `except fastapi.HTTPException` (module attribute) is a swallowed refusal | EP | P3 |
| UT-G3-035 | REQ-G3-03 | `except BaseException: pass` is a swallowed refusal | EP | P3 |
| UT-G3-036 | REQ-G3-03 | Bypass attempt on the DEF-QG-U02 fix: the gate sits in a nested function that is never called | Error guessing (dead code) | P3 |
| UT-G3-037 | REQ-G3-03 | A caught refusal that returns a 200 (`except HTTPException: return Out(ok=False)`) | EP | P2 |
| UT-G3-038 | REQ-G3-03 | A caught refusal re-raised as a non-HTTP exception still refuses (500) | EP (allowed) | P3 |
| UT-G3-039 | REQ-G3-04 | The OBS-QG-U04 fix on another shape: `RootModel[list[dict]]` | EP | P3 |
| UT-G3-040 | REQ-G3-04 | A typed RootModel (`RootModel[list[Item]]`) still passes | EP (allowed) | P3 |
| UT-G4-024 | REQ-G4-01 | Bypass attempt on the DEF-QG-U06 fix: other do-nothing downgrades under a data-only upgrade | Error guessing | P3 |
| UT-G4-025 | REQ-G4-04 | The DEF-QG-U05 fix against libpq service files: PGSERVICE, PGSERVICEFILE, `?service=`, PGSYSCONFDIR | Decision table | P2 |

#### UT-G1-037 — Bypass attempt on the DEF-QG-U03 fix: the `# flake8: noqa` file-level spelling, which ruff also honours

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-02 |
| Objective | Verify, against the requirement: Bypass attempt on the DEF-QG-U03 fix: the `# flake8: noqa` file-level spelling, which ruff also honours. |
| Technique / priority | Error guessing / P2 |
| Preconditions | PC-1 (new build) |
| Test data | Probe with S101 + S602 under `# flake8: noqa` |
| Steps | As UT-G1-036, plus §39's test |
| Expected result | Refused by ruff (PGH004) or §39 |
| Actual result | ruff: `PGH004 Use specific rule codes when using ruff: noqa`, exit 1. §39 does not recognise this spelling (its pattern needs `#` directly before `noqa` or `ruff:`), but the gate is red through PGH004 |
| Verdict | Pass |
| Evidence | `unit/UT-G1-037.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:43:02 UTC, build 40201a1 |

#### UT-G1-038 — Bypass attempt on the DEF-QG-U03 fix: ruff's range-suppression comment `# ruff: disable[<codes>]`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-02 |
| Objective | Verify, against the requirement: Bypass attempt on the DEF-QG-U03 fix: ruff's range-suppression comment `# ruff: disable[<codes>]`. |
| Technique / priority | Error guessing / bypass / P1 |
| Preconditions | PC-1 (new build) |
| Test data | (a) `disable[...]`/`enable[...]` around two lines; (b) `# ruff: disable[S101, S602, ASYNC221, ASYNC251, F401, F821]` on line 1 and no `enable`; (c) prefix codes `disable[S, ASYNC, F]` |
| Steps | As UT-G1-036, plus §39's test |
| Expected result | Refused: REQ-G1-02 and §39's own docstring say an exception in `app/` is a line-level suppression with a reason, never a file-level one |
| Actual result | (a) and (b) pass ruff and §39, exit 0. In (b) one comment line silences six codes for the rest of the file (both functions), with no reason. (c) prefixes are not honoured (all six findings still reported) |
| Verdict | Fail (DEF-QG-U07) |
| Evidence | `unit/UT-G1-038.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:43:05 UTC, build 40201a1 |

#### UT-G1-039 — §39 and ruff against `noqa` / `ruff: noqa` text inside string literals

| Field | Value |
|---|---|
| Requirement(s) | REQ-G1-02 |
| Objective | Verify, against the requirement: §39 and ruff against `noqa` / `ruff: noqa` text inside string literals. |
| Technique / priority | Negative / P2 |
| Preconditions | PC-1 (new build) |
| Test data | `HELP = "write # noqa …; # ruff: noqa …"`, a triple-quoted string holding `# ruff: noqa`, then unsuppressed S101 + S602 |
| Steps | As UT-G1-036 |
| Expected result | §39 quiet (strings are not suppressions); ruff still reports S101 and S602 (the string does not switch the file off) |
| Actual result | As expected: §39 passed; ruff S101 + S602, exit 1. (The first block in the file was inconclusive: tester's design, noted there) |
| Verdict | Pass |
| Evidence | `unit/UT-G1-039.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:43:08 UTC, build 40201a1 |

#### UT-G2-022 — Boundary of the `<word>` placeholder allowlist accepted with FV-QG-01: a real value with a 3–40 character `<word>` joined to it

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: Boundary of the `<word>` placeholder allowlist accepted with FV-QG-01: a real value with a 3–40 character `<word>` joined to it. |
| Technique / priority | Boundary / error guessing / P1 |
| Preconditions | PC-2 (new config) |
| Test data | `<abc>` appended to: OPENAI_API_KEY, quoted and unquoted AUTH_SECRET, a ghp_ token, LIVEKIT, VOICE_WORKER, GROQ; `<abc>` INSIDE a DB password; `<ab>` (2 characters); the Test Manager's `sk-…<x>` example in the legacy OpenAI shape, with and without a space |
| Steps | gl per case; the quiet ones again against a scratch config with only the global `<word>` regex removed |
| Expected result | Quiet only where the accepted residual risk says (a key deliberately made unusable by `<word>`) |
| Actual result | Quiet: OPENAI_API_KEY, **quoted** AUTH_SECRET, LIVEKIT, VOICE_WORKER, GROQ, and the DB URL with `<abc>` in the **middle** of the password (each is reported again once the `<word>` regex is removed, so the allowlist is what frees it). Found: unquoted AUTH_SECRET, ghp_, `<ab>`. The `sk-…<abc>` example is quiet even WITHOUT REEP's config (gitleaks' own `openai-api-key` stops matching when `<` follows); with a space before `<abc>` it is found |
| Verdict | Pass (OBS-QG-U07) |
| Evidence | `unit/UT-G2-022.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:50:08 UTC, build 40201a1 |

#### UT-G2-023 — The new PEM allowlist: a fully masked block is quiet; one real body line is found

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: The new PEM allowlist: a fully masked block is quiet; one real body line is found. |
| Technique / priority | Boundary / P1 |
| Preconditions | PC-2 (new config) |
| Test data | RSA PEM armour around (a) two mask lines; (b) mask, one real 64-char base64 line, mask; (c) mask, a real line ending in `<abc>` |
| Steps | gl per case (armour lines never printed in evidence) |
| Expected result | (a) quiet; (b) and (c) `private-key` |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-023.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:50:06 UTC, build 40201a1 |

#### UT-G2-024 — FV-QG-01 regression: the masked-evidence convention is quiet; a worded placeholder on an unguarded variable is found

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: FV-QG-01 regression: the masked-evidence convention is quiet; a worded placeholder on an unguarded variable is found. |
| Technique / priority | Regression / P1 |
| Preconditions | PC-2 (new config) |
| Test data | `NAME=<FAKE-VALUE-MASKED>` for AUTH_SECRET, OPENAI_API_KEY and a DB URL password; `OPENAI_API_KEY=` the worded placeholder change-me-please-now-ok |
| Steps | gl per case |
| Expected result | Masked: quiet. Worded: `reep-openai-key` |
| Actual result | As expected |
| Verdict | Pass |
| Evidence | `unit/UT-G2-024.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:50:03 UTC, build 40201a1 |

#### UT-G2-025 — A real OpenAI key inside an HTML element (`<code>KEY</code>`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: A real OpenAI key inside an HTML element (`<code>KEY</code>`). |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-2 |
| Test data | Legacy-shape OpenAI key in `<p>…<code>KEY</code></p>` |
| Steps | gl; then gitleaks with NO repository config (built-in rules only) |
| Expected result | Found |
| Actual result | Quiet under the repository config AND under gitleaks' built-in rules alone: the upstream `openai-api-key` rule's trailing boundary does not accept `<`. Not introduced by this PR |
| Verdict | Fail (OBS-QG-U08) |
| Evidence | `unit/UT-G2-025.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:50:03 UTC, build 40201a1 |

#### UT-G2-026 — The rule replay still guards its founding bug: the global allowlist reverted to `regexTarget = "line"`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G2-05 |
| Objective | Verify, against the requirement: The rule replay still guards its founding bug: the global allowlist reverted to `regexTarget = "line"`. |
| Technique / priority | State transition / ratchet / P1 |
| Preconditions | PC-2; scratch copy of the build's `.gitleaks.toml` with the two `regexTarget = "match"` lines set to `"line"` |
| Test data | (i) a real DB password beside the CI AUTH_SECRET; (ii) a ghp_ token beside the dev DATABASE_URL; (iii) `check_gitleaks_rules.py` with the same edit |
| Steps | 1. gl both cases with each config. 2. Run the replay in the scratch worktree with the edit. 3. `git checkout` |
| Expected result | (i)/(ii) caught by the build config and quiet under the line-targeted copy; the replay FAILS, as it did on a3688f0 (UT-G2-017: 5 leaks missed) |
| Actual result | (i)/(ii) as expected: both quiet under `line`. The replay prints `OK: 20 leaks caught, 11 placeholder files quiet`, exit 0: none of its cases puts a real secret on a line that also holds an allowlisted value in the new anchored spelling |
| Verdict | Fail (DEF-QG-U10) |
| Evidence | `unit/UT-G2-026.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:57:26 UTC, build 40201a1 |

#### UT-G3-029 — A caught refusal re-raised as a different HTTPException (404) still counts as a gate

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A caught refusal re-raised as a different HTTPException (404) still counts as a gate. |
| Technique / priority | EP (allowed) / P2 |
| Preconditions | PC-3 (new build) |
| Test data | `except HTTPException: raise HTTPException(404)` |
| Steps | As UT-G3-008 |
| Expected result | Not reported; STUDENT refused |
| Actual result | Not reported; STUDENT → 404 |
| Verdict | Pass |
| Evidence | `unit/UT-G3-029.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-030 — A gate after `return` inside a nested branch only

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A gate after `return` inside a nested branch only. |
| Technique / priority | Error guessing (dead code) / P2 |
| Preconditions | PC-3 (new build) |
| Test data | `if …: return Out(); require_admin(session)` inside the branch, then `return Out()` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Reported; STUDENT → 200 |
| Verdict | Pass |
| Evidence | `unit/UT-G3-030.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-031 — Bypass attempt on the DEF-QG-U01 fix: `with contextlib.suppress(HTTPException): require_admin(session)`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt on the DEF-QG-U01 fix: `with contextlib.suppress(HTTPException): require_admin(session)`. |
| Technique / priority | Error guessing / P2 |
| Preconditions | PC-3 (new build) |
| Test data | `n03-suppress` |
| Steps | As UT-G3-008 |
| Expected result | Reported (the refusal is swallowed) |
| Actual result | Not reported; STUDENT → 200 |
| Verdict | Fail (DEF-QG-U08) |
| Evidence | `unit/UT-G3-031.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-032 — Bypass attempt: the refusal caught as starlette's base class (`except starlette.exceptions.HTTPException`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt: the refusal caught as starlette's base class (`except starlette.exceptions.HTTPException`). |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `n04-starlette-base` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Not reported; STUDENT → 200 |
| Verdict | Fail (DEF-QG-U08) |
| Evidence | `unit/UT-G3-032.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-033 — Bypass attempt: the refusal caught through an import alias (`from fastapi import HTTPException as HE`; `except HE`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt: the refusal caught through an import alias (`from fastapi import HTTPException as HE`; `except HE`). |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `n05-alias` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Not reported; STUDENT → 200. (`except fastapi.HTTPException`, UT-G3-034, IS reported) |
| Verdict | Fail (DEF-QG-U08) |
| Evidence | `unit/UT-G3-033.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-034 — `except fastapi.HTTPException` (module attribute) is a swallowed refusal

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: `except fastapi.HTTPException` (module attribute) is a swallowed refusal. |
| Technique / priority | EP / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `n06-module-attr` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-034.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-035 — `except BaseException: pass` is a swallowed refusal

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: `except BaseException: pass` is a swallowed refusal. |
| Technique / priority | EP / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `n07-baseexception` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-035.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-036 — Bypass attempt on the DEF-QG-U02 fix: the gate sits in a nested function that is never called

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: Bypass attempt on the DEF-QG-U02 fix: the gate sits in a nested function that is never called. |
| Technique / priority | Error guessing (dead code) / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `def check(): require_admin(session)` defined inside the handler, never called |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Not reported; STUDENT → 200 |
| Verdict | Fail (DEF-QG-U09) |
| Evidence | `unit/UT-G3-036.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-037 — A caught refusal that returns a 200 (`except HTTPException: return Out(ok=False)`)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A caught refusal that returns a 200 (`except HTTPException: return Out(ok=False)`). |
| Technique / priority | EP / P2 |
| Preconditions | PC-3 (new build) |
| Test data | `n09-caught-returns-200` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-037.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-038 — A caught refusal re-raised as a non-HTTP exception still refuses (500)

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-03 |
| Objective | Verify, against the requirement: A caught refusal re-raised as a non-HTTP exception still refuses (500). |
| Technique / priority | EP (allowed) / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `raise PermissionError from exc` |
| Steps | As UT-G3-008 |
| Expected result | Not reported; STUDENT refused |
| Actual result | Not reported; STUDENT → 500 |
| Verdict | Pass |
| Evidence | `unit/UT-G3-038.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-039 — The OBS-QG-U04 fix on another shape: `RootModel[list[dict]]`

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: The OBS-QG-U04 fix on another shape: `RootModel[list[dict]]`. |
| Technique / priority | EP / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `r08-rootmodel-list-dict` |
| Steps | As UT-G3-008 |
| Expected result | Reported |
| Actual result | Reported: `untyped response model (LooseList[dict])` |
| Verdict | Pass |
| Evidence | `unit/UT-G3-039.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G3-040 — A typed RootModel (`RootModel[list[Item]]`) still passes

| Field | Value |
|---|---|
| Requirement(s) | REQ-G3-04 |
| Objective | Verify, against the requirement: A typed RootModel (`RootModel[list[Item]]`) still passes. |
| Technique / priority | EP (allowed) / P3 |
| Preconditions | PC-3 (new build) |
| Test data | `r09-rootmodel-typed` |
| Steps | As UT-G3-008 |
| Expected result | Not reported |
| Actual result | Not reported |
| Verdict | Pass |
| Evidence | `unit/UT-G3-040.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:45:23 UTC, build 40201a1 |

#### UT-G4-024 — Bypass attempt on the DEF-QG-U06 fix: other do-nothing downgrades under a data-only upgrade

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-01 |
| Objective | Verify, against the requirement: Bypass attempt on the DEF-QG-U06 fix: other do-nothing downgrades under a data-only upgrade. |
| Technique / priority | Error guessing / P3 |
| Preconditions | PC-4 (new build) |
| Test data | Six chained revisions (upgrade an `UPDATE`): `if not True:`, `while False:`, `return 0`, `for _ in ():`, `if 1 == 2:`, and `return` followed by an op |
| Steps | As UT-G4-001 |
| Expected result | All six reported as not doing real work |
| Actual result | Only the `return`-then-op revision is reported. `if not True:`, `while False:`, `return 0`, `for _ in ():` and `if 1 == 2:` are classified `real`. A data-only upgrade changes no catalogue, so the round trip cannot see them either |
| Verdict | Fail (DEF-QG-U11) |
| Evidence | `unit/UT-G4-024.txt` |
| Executed by / date | Tester session U / 2026-10-08T09:58:17 UTC, build 40201a1 |

#### UT-G4-025 — The DEF-QG-U05 fix against libpq service files: PGSERVICE, PGSERVICEFILE, `?service=`, PGSYSCONFDIR

| Field | Value |
|---|---|
| Requirement(s) | REQ-G4-04 |
| Objective | Verify, against the requirement: The DEF-QG-U05 fix against libpq service files: PGSERVICE, PGSERVICEFILE, `?service=`, PGSYSCONFDIR. |
| Technique / priority | Decision table / P2 |
| Preconditions | Repository at the new build; a scratch `pg_service.conf` with `[prod] host=192.0.2.1` |
| Test data | Six environment/URL combinations |
| Steps | `dt.sh` per row |
| Expected result | Every combination that names a service is refused; PGSYSCONFDIR alone (no service named) runs |
| Actual result | All six as expected |
| Verdict | Pass |
| Evidence | `unit/UT-G4-025.txt` |
| Executed by / date | Tester session U / 2026-10-08T10:02:49 UTC, build 40201a1 |

### 4.4 New cases added in re-test round 2 (build `e55d139`)

Preconditions as §4, on the round-2 build. Steps as in the round-1 case of the same gate; evidence `unit/<ID>.txt`.

| ID | Requirement(s) | Title | Technique | Priority | Actual result | Verdict |
|---|---|---|---|---|---|---|
| UT-G1-040 | REQ-G1-02 | A reasoned `disable` … `enable` range: (a) closed in a different function and class; (b) line 1 to the last line of the module | Error guessing / bypass | P2 | (a) Gate red: ruff reports RUF103/RUF104 because a range does not cross scopes, and the code after is reported. (b) ruff exit 0 and §39 passes: four codes (S101, S602, F401, F821) are silenced for the whole module, with one reason | Fail (DEF-QG-U12) |
| UT-G1-041 | REQ-G1-02 | Directives inside docstrings (module and function), with real S101/S602 below | Negative | P2 | ruff reports S101 + S602 (the docstrings suppress nothing); §39 passes | Pass |
| UT-G1-042 | REQ-G1-02 | The two whole-file spellings Worker A found: `# flake8: noqa: S101, S602` with a reason; `# ruff: file-ignore[S101, S602]` with a reason, on the LAST line | EP | P1 | ruff passes both; §39 refuses both (`file-level ruff: noqa` / `ruff: file-ignore silences the whole file`) | Pass |
| UT-G1-043 | REQ-G1-02 | A reasoned `disable[S101, S602]` closed by `enable[S101]` only | Boundary | P2 | §39: `disable[S101, S602]` is never closed by a matching enable; ruff RUF104 as well | Pass |
| UT-G2-027 | REQ-G2-05 | Placeholder edges after the whole-`<…>` rule: spaces inside; nested brackets; a real value inside nested brackets; a REAL value wholly inside `<…>` at 40 and 41 characters; a bracketed 32-hex AUTH_SECRET; a bracketed DB password; two placeholders around a real value | Boundary | P1 | Spaces: quiet (correct). Nested `<a<bc>d>`: found (conservative). Real inside nested brackets: found. Two placeholders around a real value: found. A real value wholly inside `<…>` is quiet up to 40 characters and found at 41; the bracketed AUTH_SECRET and DB password are quiet as well. This is the inherent limit of a placeholder allowlist: OBS-QG-U09 | Pass (OBS-QG-U09) |
| UT-G3-041 | REQ-G3-03 | `except (ValueError, HE)` (an alias inside a tuple) | Error guessing | P2 | Reported; STUDENT → 200 | Pass |
| UT-G3-042 | REQ-G3-03 | `from contextlib import suppress as sup`; `with sup(HTTPException)` | Error guessing | P2 | Reported; STUDENT → 200 | Pass |
| UT-G3-043 | REQ-G3-03 | A nested def holding the gate, called only from another nested def that is never called | Error guessing | P2 | Reported; STUDENT → 200 | Pass |
| UT-G3-044 | REQ-G3-03 | Positive controls: a nested def that IS called; an immediately-invoked lambda | EP (allowed) | P2 | Neither reported; STUDENT → 403 from both | Pass |
| UT-G3-045 | REQ-G3-03 | A called nested def whose call sits inside `try … except HTTPException: pass` | Error guessing | P2 | Reported; STUDENT → 200 | Pass |
| UT-G3-046 | REQ-G3-03 | `suppress(Exception)` (reported) vs `suppress(ValueError)` (a gate) | EP | P2 | As stated; STUDENT → 200 / 403 | Pass |
| UT-G3-047 | REQ-G3-03 | `suppress(ValueError, StarletteHTTPException)` | Error guessing | P3 | Reported; STUDENT → 200 | Pass |
| UT-G3-048 | REQ-G3-03 | A lambda holding the gate, assigned and never called | Error guessing | P3 | Reported; STUDENT → 200 | Pass |
| UT-G3-049 | REQ-G3-03 | A nested def called only after `return` | Error guessing | P3 | Reported; STUDENT → 200 | Pass |
| UT-G3-050 | REQ-G3-03 | The exception class rebound to a LOCAL name inside the handler (`Refusal = HTTPException`; `except Refusal: pass`) | Error guessing | P3 | Not reported; STUDENT → 200 | Fail (DEF-QG-U13) |
| UT-G4-026 | REQ-G4-01 | Dead statements behind a constant-true `return` (data-only upgrade): (1) op after `return` inside `if True:`; (2) `if True: return` then op; (3) `if 0 < 1: return` then op; (4) `while True: break` then `if not (1 == 1): op`; (5) control: `if True: op; return` | Error guessing | P3 | (1) reported as no-op. (5) real, correctly. (2), (3) and (4) are classified real: a `return` inside a folded-true branch does not end the outer body | Fail (DEF-QG-U14) |

## 5. Test execution log

In execution order (time of the first command in each evidence file).

| ID | Date/time (UTC) | Verdict | Evidence file | Notes |
|---|---|---|---|---|
| UT-G2-020 | 2026-10-08T08:33:58 | Pass | `unit/UT-G2-020.txt` |  |
| UT-G2-007 | 2026-10-08T08:35:22 | Pass | `unit/UT-G2-007.txt` |  |
| UT-G2-006 | 2026-10-08T08:35:25 | Pass | `unit/UT-G2-006.txt` |  |
| UT-G2-005 | 2026-10-08T08:35:28 | Pass | `unit/UT-G2-005.txt` |  |
| UT-G2-004 | 2026-10-08T08:35:30 | Pass | `unit/UT-G2-004.txt` |  |
| UT-G2-003 | 2026-10-08T08:35:31 | Pass | `unit/UT-G2-003.txt` |  |
| UT-G2-002 | 2026-10-08T08:35:32 | Pass | `unit/UT-G2-002.txt` |  |
| UT-G2-001 | 2026-10-08T08:35:33 | Pass | `unit/UT-G2-001.txt` |  |
| UT-G2-009 | 2026-10-08T08:35:34 | Pass | `unit/UT-G2-009.txt` |  |
| UT-G2-008 | 2026-10-08T08:35:38 | Pass | `unit/UT-G2-008.txt` |  |
| UT-G2-014 | 2026-10-08T08:35:40 | Fail | `unit/UT-G2-014.txt` | OBS-QG-U01 |
| UT-G2-010 | 2026-10-08T08:35:41 | Pass | `unit/UT-G2-010.txt` |  |
| UT-G2-011 | 2026-10-08T08:35:43 | Pass | `unit/UT-G2-011.txt` |  |
| UT-G2-012 | 2026-10-08T08:35:52 | Pass | `unit/UT-G2-012.txt` |  |
| UT-G2-013 | 2026-10-08T08:36:07 | Pass | `unit/UT-G2-013.txt` |  |
| UT-G2-016 | 2026-10-08T08:36:16 | Pass | `unit/UT-G2-016.txt` |  |
| UT-G2-017 | 2026-10-08T08:36:18 | Pass | `unit/UT-G2-017.txt` |  |
| UT-G2-018 | 2026-10-08T08:36:35 | Pass | `unit/UT-G2-018.txt` | OBS-QG-U02; a tester's script error is recorded and re-run in the file |
| UT-G1-000 | 2026-10-08T08:38:32 | Pass | `unit/UT-G1-000.txt` |  |
| UT-G1-001 | 2026-10-08T08:39:31 | Pass | `unit/UT-G1-001.txt` |  |
| UT-G1-002 | 2026-10-08T08:39:31 | Pass | `unit/UT-G1-002.txt` |  |
| UT-G1-003 | 2026-10-08T08:39:31 | Pass | `unit/UT-G1-003.txt` |  |
| UT-G1-004 | 2026-10-08T08:39:39 | Pass | `unit/UT-G1-004.txt` |  |
| UT-G1-005 | 2026-10-08T08:39:39 | Pass | `unit/UT-G1-005.txt` |  |
| UT-G1-006 | 2026-10-08T08:39:39 | Pass | `unit/UT-G1-006.txt` |  |
| UT-G1-007 | 2026-10-08T08:39:39 | Pass | `unit/UT-G1-007.txt` |  |
| UT-G1-008 | 2026-10-08T08:39:45 | Pass | `unit/UT-G1-008.txt` |  |
| UT-G1-009 | 2026-10-08T08:39:45 | Pass | `unit/UT-G1-009.txt` |  |
| UT-G1-010 | 2026-10-08T08:39:45 | Pass | `unit/UT-G1-010.txt` |  |
| UT-G1-011 | 2026-10-08T08:39:45 | Pass | `unit/UT-G1-011.txt` |  |
| UT-G1-012 | 2026-10-08T08:39:53 | Pass | `unit/UT-G1-012.txt` |  |
| UT-G1-014 | 2026-10-08T08:40:09 | Pass | `unit/UT-G1-014.txt` |  |
| UT-G1-015 | 2026-10-08T08:40:18 | Pass | `unit/UT-G1-015.txt` |  |
| UT-G1-016 | 2026-10-08T08:40:19 | Pass | `unit/UT-G1-016.txt` |  |
| UT-G1-017 | 2026-10-08T08:40:21 | Pass | `unit/UT-G1-017.txt` |  |
| UT-G1-018 | 2026-10-08T08:40:22 | Pass | `unit/UT-G1-018.txt` |  |
| UT-G1-019 | 2026-10-08T08:40:24 | Pass | `unit/UT-G1-019.txt` |  |
| UT-G1-020 | 2026-10-08T08:40:31 | Pass | `unit/UT-G1-020.txt` |  |
| UT-G1-021 | 2026-10-08T08:40:33 | Pass | `unit/UT-G1-021.txt` |  |
| UT-G1-022 | 2026-10-08T08:40:58 | Pass | `unit/UT-G1-022.txt` |  |
| UT-G1-023 | 2026-10-08T08:40:58 | Pass | `unit/UT-G1-023.txt` |  |
| UT-G1-025 | 2026-10-08T08:40:58 | Pass | `unit/UT-G1-025.txt` |  |
| UT-G1-026 | 2026-10-08T08:40:59 | Pass | `unit/UT-G1-026.txt` |  |
| UT-G1-027 | 2026-10-08T08:40:59 | Pass | `unit/UT-G1-027.txt` | a tester's script error is recorded and re-run in the file |
| UT-G1-024 | 2026-10-08T08:41:00 | Pass | `unit/UT-G1-024.txt` |  |
| UT-G1-028 | 2026-10-08T08:41:00 | Pass | `unit/UT-G1-028.txt` |  |
| UT-G1-029 | 2026-10-08T08:41:00 | Pass | `unit/UT-G1-029.txt` |  |
| UT-G1-030 | 2026-10-08T08:41:00 | Fail | `unit/UT-G1-030.txt` | OBS-QG-U03 |
| UT-G1-031 | 2026-10-08T08:41:25 | Pass | `unit/UT-G1-031.txt` |  |
| UT-G1-032 | 2026-10-08T08:41:29 | Pass | `unit/UT-G1-032.txt` |  |
| UT-G1-033 | 2026-10-08T08:41:33 | Pass | `unit/UT-G1-033.txt` |  |
| UT-G1-034 | 2026-10-08T08:41:37 | Pass | `unit/UT-G1-034.txt` |  |
| UT-G1-035 | 2026-10-08T08:41:41 | Pass | `unit/UT-G1-035.txt` |  |
| UT-G3-001 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-001.txt` |  |
| UT-G3-002 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-002.txt` |  |
| UT-G3-003 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-003.txt` |  |
| UT-G3-004 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-004.txt` |  |
| UT-G3-005 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-005.txt` |  |
| UT-G3-006 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-006.txt` |  |
| UT-G3-010 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-010.txt` |  |
| UT-G3-011 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-011.txt` |  |
| UT-G3-012 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-012.txt` |  |
| UT-G3-013 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-013.txt` |  |
| UT-G3-014 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-014.txt` |  |
| UT-G3-015 | 2026-10-08T08:42:37 | Fail | `unit/UT-G3-015.txt` | OBS-QG-U04 |
| UT-G3-016 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-016.txt` |  |
| UT-G3-017 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-017.txt` |  |
| UT-G3-019 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-019.txt` |  |
| UT-G3-020 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-020.txt` |  |
| UT-G3-021 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-021.txt` |  |
| UT-G3-022 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-022.txt` |  |
| UT-G3-023 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-023.txt` |  |
| UT-G3-024 | 2026-10-08T08:42:37 | Pass | `unit/UT-G3-024.txt` |  |
| UT-G3-007 | 2026-10-08T08:43:46 | Fail | `unit/UT-G3-007.txt` | DEF-QG-U02 |
| UT-G3-008 | 2026-10-08T08:43:46 | Fail | `unit/UT-G3-008.txt` | DEF-QG-U01 |
| UT-G3-009 | 2026-10-08T08:43:47 | Fail | `unit/UT-G3-009.txt` | DEF-QG-U02 |
| UT-G3-018 | 2026-10-08T08:44:09 | Pass | `unit/UT-G3-018.txt` |  |
| UT-G3-025 | 2026-10-08T08:44:18 | Pass | `unit/UT-G3-025.txt` |  |
| UT-G3-026 | 2026-10-08T08:44:38 | Pass | `unit/UT-G3-026.txt` |  |
| UT-G3-027 | 2026-10-08T08:44:50 | Pass | `unit/UT-G3-027.txt` |  |
| UT-G3-028 | 2026-10-08T08:45:56 | Pass | `unit/UT-G3-028.txt` |  |
| UT-G4-010 | 2026-10-08T08:46:18 | Pass | `unit/UT-G4-010.txt` |  |
| UT-G4-001 | 2026-10-08T08:46:26 | Pass | `unit/UT-G4-001.txt` |  |
| UT-G4-002 | 2026-10-08T08:46:29 | Pass | `unit/UT-G4-002.txt` |  |
| UT-G4-003 | 2026-10-08T08:46:32 | Pass | `unit/UT-G4-003.txt` |  |
| UT-G4-004 | 2026-10-08T08:46:45 | Pass | `unit/UT-G4-004.txt` |  |
| UT-G4-005 | 2026-10-08T08:46:51 | Pass | `unit/UT-G4-005.txt` |  |
| UT-G4-006 | 2026-10-08T08:46:54 | Pass | `unit/UT-G4-006.txt` |  |
| UT-G4-007 | 2026-10-08T08:46:57 | Fail | `unit/UT-G4-007.txt` | DEF-QG-U06 |
| UT-G4-011 | 2026-10-08T08:47:29 | Pass | `unit/UT-G4-011.txt` |  |
| UT-G4-012 | 2026-10-08T08:48:33 | Pass | `unit/UT-G4-012.txt` |  |
| UT-G4-013 | 2026-10-08T08:48:56 | Pass | `unit/UT-G4-013.txt` |  |
| UT-G4-014 | 2026-10-08T08:49:26 | Pass | `unit/UT-G4-014.txt` |  |
| UT-G4-015 | 2026-10-08T08:50:02 | Pass | `unit/UT-G4-015.txt` |  |
| UT-G4-016 | 2026-10-08T08:50:10 | Pass | `unit/UT-G4-016.txt` |  |
| UT-G4-017 | 2026-10-08T08:50:27 | Pass | `unit/UT-G4-017.txt` | a tester's script error is recorded and re-run in the file |
| UT-G4-018 | 2026-10-08T08:50:48 | Pass | `unit/UT-G4-018.txt` |  |
| UT-G4-019 | 2026-10-08T08:50:58 | Pass | `unit/UT-G4-019.txt` |  |
| UT-G4-020 | 2026-10-08T08:51:17 | Fail | `unit/UT-G4-020.txt` | DEF-QG-U05 |
| UT-G4-021 | 2026-10-08T08:52:08 | Pass | `unit/UT-G4-021.txt` |  |
| UT-G4-022 | 2026-10-08T08:52:45 | Pass | `unit/UT-G4-022.txt` |  |
| UT-G4-023 | 2026-10-08T08:52:57 | Pass | `unit/UT-G4-023.txt` |  |
| UT-GX-002 | 2026-10-08T08:53:12 | Pass | `unit/UT-GX-002.txt` |  |
| UT-GX-001 | 2026-10-08T08:53:24 | Pass | `unit/UT-GX-001.txt` | OBS-QG-U05 |
| UT-G5-001 | 2026-10-08T08:53:43 | Pass | `unit/UT-G5-001.txt` |  |
| UT-G5-002 | 2026-10-08T08:53:58 | Pass | `unit/UT-G5-002.txt` | OBS-QG-U06 |
| UT-G1-036 | 2026-10-08T08:54:11 | Fail | `unit/UT-G1-036.txt` | DEF-QG-U03 |
| UT-G2-021 | 2026-10-08T08:54:30 | Fail | `unit/UT-G2-021.txt` | DEF-QG-U04 |
| UT-G3-000 | 2026-10-08T08:55:33 | Pass | `unit/UT-G3-000.txt` |  |

## 5a. Re-test log (round 1, build `40201a140ba70f8be40d6b016f55ddb828fcaa91`)

Every round-1 case was re-executed with its original steps on the new build (confirmation for the failed and observation cases, regression for the rest). The evidence file is the round-1 name with the suffix `-rt1`. The 22 new cases are in §4.3 and listed at the end.

| ID | Kind | Date/time (UTC) | Verdict | Evidence file | Notes |
|---|---|---|---|---|---|
| UT-G1-000 | Regression | 2026-10-08T09:40:38 | Pass | `unit/UT-G1-000-rt1.txt` | same result as round 1 |
| UT-G3-000 | Regression | 2026-10-08T09:41:50 | Pass | `unit/UT-G3-000-rt1.txt` | 227 passed (6 guard modules incl. §34/§39, the route audit, reversibility, round-trip guard, async guard, secret-scan workflow) |
| UT-G1-036 | Confirmation | 2026-10-08T09:42:50 | Pass | `unit/UT-G1-036-rt1.txt` | PGH004 + §39 now refuse both shapes → DEF-QG-U03 Closed |
| UT-G1-002 | Confirmation | 2026-10-08T09:43:48 | Pass | `unit/UT-G1-002-rt1.txt` | pyproject comment now says E9 is E902 alone → note closed |
| UT-G1-030 | Confirmation | 2026-10-08T09:43:48 | Pass | `unit/UT-G1-030-rt1.txt` | os.open/os.read and Path(...).open() now flagged; the IIFE lambda is documented → OBS-QG-U03 Closed |
| UT-G3-001 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-001-rt1.txt` | same result as round 1 |
| UT-G3-002 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-002-rt1.txt` | same result as round 1 |
| UT-G3-003 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-003-rt1.txt` | same result as round 1 |
| UT-G3-004 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-004-rt1.txt` | same result as round 1 |
| UT-G3-005 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-005-rt1.txt` | same result as round 1 |
| UT-G3-006 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-006-rt1.txt` | same result as round 1 |
| UT-G3-007 | Confirmation | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-007-rt1.txt` | reported; STUDENT 200 → DEF-QG-U02 (this shape) Closed |
| UT-G3-008 | Confirmation | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-008-rt1.txt` | both shapes reported → DEF-QG-U01 Closed (new spellings: DEF-QG-U08) |
| UT-G3-009 | Confirmation | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-009-rt1.txt` | both reported → DEF-QG-U02 Closed (new shape: DEF-QG-U09) |
| UT-G3-010 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-010-rt1.txt` | same result as round 1 |
| UT-G3-011 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-011-rt1.txt` | same result as round 1 |
| UT-G3-012 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-012-rt1.txt` | same result as round 1 |
| UT-G3-013 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-013-rt1.txt` | same result as round 1 |
| UT-G3-014 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-014-rt1.txt` | same result as round 1 |
| UT-G3-015 | Confirmation | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-015-rt1.txt` | reported (`Loose[typing.Any]`) → OBS-QG-U04 Closed |
| UT-G3-016 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-016-rt1.txt` | same result as round 1 |
| UT-G3-017 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-017-rt1.txt` | same result as round 1 |
| UT-G3-019 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-019-rt1.txt` | same result as round 1 |
| UT-G3-020 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-020-rt1.txt` | same result as round 1 |
| UT-G3-021 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-021-rt1.txt` | same result as round 1 |
| UT-G3-022 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-022-rt1.txt` | same result as round 1 |
| UT-G3-023 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-023-rt1.txt` | same result as round 1 |
| UT-G3-024 | Regression | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-024-rt1.txt` | same result as round 1 |
| UT-G3-018 | Regression | 2026-10-08T09:45:51 | Pass | `unit/UT-G3-018-rt1.txt` | same result as round 1 |
| UT-G3-025 | Regression | 2026-10-08T09:45:51 | Pass | `unit/UT-G3-025-rt1.txt` | same result as round 1 |
| UT-G3-026 | Regression | 2026-10-08T09:45:58 | Pass | `unit/UT-G3-026-rt1.txt` | same result as round 1 |
| UT-G3-027 | Regression | 2026-10-08T09:46:03 | Pass | `unit/UT-G3-027-rt1.txt` | same result as round 1 |
| UT-G3-028 | Regression | 2026-10-08T09:46:31 | Pass | `unit/UT-G3-028-rt1.txt` | same result as round 1 |
| UT-G2-004 | Regression | 2026-10-08T09:49:41 | Pass | `unit/UT-G2-004-rt1.txt` | same result as round 1 |
| UT-G2-011 | Regression | 2026-10-08T09:49:42 | Pass | `unit/UT-G2-011-rt1.txt` | same result as round 1 |
| UT-G2-009 | Regression | 2026-10-08T09:49:44 | Pass | `unit/UT-G2-009-rt1.txt` | expected result revised per triage: the worded placeholder on OPENAI_API_KEY (009d) is now correctly a finding; the other five quiet |
| UT-G2-010 | Regression | 2026-10-08T09:49:48 | Pass | `unit/UT-G2-010-rt1.txt` | same result as round 1 |
| UT-G2-014 | Confirmation | 2026-10-08T09:49:50 | Pass | `unit/UT-G2-014-rt1.txt` | 3 of 4 found; AUTH_SECRET=change-me-… stays quiet through the reep-auth-secret allowlist that mirrors the boot guard (as round 1 judged harmless) → OBS-QG-U01 Closed |
| UT-G2-002 | Regression | 2026-10-08T09:49:53 | Pass | `unit/UT-G2-002-rt1.txt` | same result as round 1 |
| UT-G2-007 | Regression | 2026-10-08T09:49:53 | Pass | `unit/UT-G2-007-rt1.txt` | same result as round 1 |
| UT-G2-005 | Regression | 2026-10-08T09:49:57 | Pass | `unit/UT-G2-005-rt1.txt` | same result as round 1 |
| UT-G2-006 | Regression | 2026-10-08T09:49:59 | Pass | `unit/UT-G2-006-rt1.txt` | same result as round 1 |
| UT-G2-003 | Regression | 2026-10-08T09:50:02 | Pass | `unit/UT-G2-003-rt1.txt` | same result as round 1 |
| UT-G2-001 | Regression | 2026-10-08T09:50:05 | Pass | `unit/UT-G2-001-rt1.txt` | same result as round 1 |
| UT-G2-008 | Regression | 2026-10-08T09:50:18 | Pass | `unit/UT-G2-008-rt1.txt` | same result as round 1 |
| UT-G2-012 | Regression | 2026-10-08T09:50:35 | Pass | `unit/UT-G2-012-rt1.txt` | same result as round 1 |
| UT-G2-013 | Regression | 2026-10-08T09:50:38 | Pass | `unit/UT-G2-013-rt1.txt` | same result as round 1 |
| UT-G2-016 | Regression | 2026-10-08T09:50:39 | Pass | `unit/UT-G2-016-rt1.txt` | 20 leaks caught, 11 placeholder files quiet |
| UT-G2-017 | Regression | 2026-10-08T09:50:55 | Fail | `unit/UT-G2-017-rt1.txt` | DEF-QG-U10; the `{32,}`→`{80,}` and the unanchored-placeholder edits fail the replay; the `regexTarget = "line"` edit no longer does (DEF-QG-U10); no gitleaks → exit 1 |
| UT-G2-018 | Confirmation | 2026-10-08T09:50:58 | Pass | `unit/UT-G2-018-rt1.txt` | clean from the build and the tree from the root; absolute-path scan still 4, now documented at .gitleaks.toml:361 → OBS-QG-U02 Closed. **Addendum (OBS-QG-S05): every earlier history scan, in round 1 and in this round, ran on a SHALLOW clone** (219 of 724 commits reachable from a3688f0; 241 of 746 from 40201a1). After `git fetch --unshallow`: full history from 40201a1 with the new config, **594 commits scanned, no leaks**; from a3688f0 with the round-1 config, **580 commits, no leaks**; every branch of a local mirror minus `qg-test-unit`, **1294 commits, no leaks**. Round 1's UT-G2-018 verdict rested on the shallow scan; it is these re-runs that support REQ-G2-08 |
| UT-G2-020 | Regression | 2026-10-08T09:57:41 | Pass | `unit/UT-G2-020-rt1.txt` | same result as round 1 |
| UT-G2-021 | Confirmation | 2026-10-08T09:57:42 | Pass | `unit/UT-G2-021-rt1.txt` | found with --ignore-gitleaks-allow, which every invocation now passes → DEF-QG-U04 Closed |
| UT-G4-007 | Confirmation | 2026-10-08T09:58:14 | Pass | `unit/UT-G4-007-rt1.txt` | all three reported as no-op → DEF-QG-U06 Closed (new shapes: DEF-QG-U11) |
| UT-G4-001 | Regression | 2026-10-08T09:58:36 | Pass | `unit/UT-G4-001-rt1.txt` | same result as round 1 |
| UT-G4-002 | Regression | 2026-10-08T09:58:38 | Pass | `unit/UT-G4-002-rt1.txt` | same result as round 1 |
| UT-G4-003 | Regression | 2026-10-08T09:58:41 | Pass | `unit/UT-G4-003-rt1.txt` | same result as round 1 |
| UT-G4-004 | Regression | 2026-10-08T09:58:44 | Pass | `unit/UT-G4-004-rt1.txt` | same result as round 1 |
| UT-G4-005 | Regression | 2026-10-08T09:58:49 | Pass | `unit/UT-G4-005-rt1.txt` | same result as round 1 |
| UT-G4-006 | Regression | 2026-10-08T09:58:52 | Pass | `unit/UT-G4-006-rt1.txt` | same result as round 1 |
| UT-G4-010 | Regression | 2026-10-08T09:59:14 | Pass | `unit/UT-G4-010-rt1.txt` | 90 of 92, 21 s; the first block hit a stopped Postgres (environment), re-run |
| UT-G4-011 | Regression | 2026-10-08T09:59:15 | Pass | `unit/UT-G4-011-rt1.txt` | the first block hit a stopped Postgres (environment), re-run |
| UT-G4-012 | Regression | 2026-10-08T10:00:22 | Pass | `unit/UT-G4-012-rt1.txt` | same result as round 1 |
| UT-G4-013 | Regression | 2026-10-08T10:00:43 | Pass | `unit/UT-G4-013-rt1.txt` | the first block used a correct downgrade by mistake (tester), re-run with round 1's `return` |
| UT-G4-014 | Regression | 2026-10-08T10:01:41 | Pass | `unit/UT-G4-014-rt1.txt` | same result as round 1 |
| UT-G4-016 | Regression | 2026-10-08T10:02:02 | Pass | `unit/UT-G4-016-rt1.txt` | same result as round 1 |
| UT-G4-015 | Regression | 2026-10-08T10:02:14 | Pass | `unit/UT-G4-015-rt1.txt` | same result as round 1 |
| UT-G4-017 | Regression | 2026-10-08T10:02:14 | Pass | `unit/UT-G4-017-rt1.txt` | same result as round 1 |
| UT-G4-018 | Regression | 2026-10-08T10:02:22 | Pass | `unit/UT-G4-018-rt1.txt` | same result as round 1 |
| UT-G4-019 | Regression | 2026-10-08T10:02:32 | Pass | `unit/UT-G4-019-rt1.txt` | same result as round 1 |
| UT-G4-020 | Confirmation | 2026-10-08T10:02:47 | Pass | `unit/UT-G4-020-rt1.txt` | refused, naming 192.0.2.1 → DEF-QG-U05 Closed |
| UT-G4-021 | Regression | 2026-10-08T10:03:07 | Pass | `unit/UT-G4-021-rt1.txt` | fixed build through the port mapping: OK, 21 s |
| UT-G4-022 | Regression | 2026-10-08T10:03:44 | Pass | `unit/UT-G4-022-rt1.txt` | same result as round 1 |
| UT-G4-023 | Regression | 2026-10-08T10:03:45 | Pass | `unit/UT-G4-023-rt1.txt` | same result as round 1 |
| UT-GX-001 | Confirmation | 2026-10-08T10:04:07 | Pass | `unit/UT-GX-001-rt1.txt` | single-quoted and unquoted now parse; an empty pin SKIPs naming the cause → OBS-QG-U05 Closed |
| UT-GX-002 | Regression | 2026-10-08T10:04:07 | Pass | `unit/UT-GX-002-rt1.txt` | same result as round 1 |
| UT-G5-001 | Regression | 2026-10-08T10:04:19 | Pass | `unit/UT-G5-001-rt1.txt` | same result as round 1 |
| UT-G5-002 | Confirmation | 2026-10-08T10:04:19 | Pass | `unit/UT-G5-002-rt1.txt` | all 22 items now a gate name or *human — no gate* → OBS-QG-U06 Closed |
| UT-G1-001 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-001-rt1.txt` | same result as round 1 |
| UT-G1-003 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-003-rt1.txt` | same result as round 1 |
| UT-G1-004 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-004-rt1.txt` | same result as round 1 |
| UT-G1-005 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-005-rt1.txt` | same result as round 1 |
| UT-G1-006 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-006-rt1.txt` | same result as round 1 |
| UT-G1-007 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-007-rt1.txt` | same result as round 1 |
| UT-G1-008 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-008-rt1.txt` | same result as round 1 |
| UT-G1-009 | Regression | 2026-10-08T10:04:35 | Pass | `unit/UT-G1-009-rt1.txt` | same result as round 1 |
| UT-G1-010 | Regression | 2026-10-08T10:04:36 | Pass | `unit/UT-G1-010-rt1.txt` | same result as round 1 |
| UT-G1-011 | Regression | 2026-10-08T10:04:36 | Pass | `unit/UT-G1-011-rt1.txt` | same result as round 1 |
| UT-G1-012 | Regression | 2026-10-08T10:04:36 | Pass | `unit/UT-G1-012-rt1.txt` | same result as round 1 |
| UT-G1-014 | Regression | 2026-10-08T10:04:36 | Pass | `unit/UT-G1-014-rt1.txt` | same result as round 1 |
| UT-G1-015 | Regression | 2026-10-08T10:05:19 | Pass | `unit/UT-G1-015-rt1.txt` | same result as round 1 |
| UT-G1-016 | Regression | 2026-10-08T10:05:20 | Pass | `unit/UT-G1-016-rt1.txt` | same result as round 1 |
| UT-G1-017 | Regression | 2026-10-08T10:05:21 | Pass | `unit/UT-G1-017-rt1.txt` | same result as round 1 |
| UT-G1-018 | Regression | 2026-10-08T10:05:22 | Pass | `unit/UT-G1-018-rt1.txt` | same result as round 1 |
| UT-G1-019 | Regression | 2026-10-08T10:05:24 | Pass | `unit/UT-G1-019-rt1.txt` | same result as round 1 |
| UT-G1-020 | Regression | 2026-10-08T10:05:25 | Pass | `unit/UT-G1-020-rt1.txt` | same result as round 1 |
| UT-G1-021 | Regression | 2026-10-08T10:05:42 | Pass | `unit/UT-G1-021-rt1.txt` | same result as round 1 |
| UT-G1-022 | Regression | 2026-10-08T10:05:42 | Pass | `unit/UT-G1-022-rt1.txt` | same result as round 1 |
| UT-G1-023 | Regression | 2026-10-08T10:05:42 | Pass | `unit/UT-G1-023-rt1.txt` | same result as round 1 |
| UT-G1-025 | Regression | 2026-10-08T10:05:42 | Pass | `unit/UT-G1-025-rt1.txt` | same result as round 1 |
| UT-G1-026 | Regression | 2026-10-08T10:05:42 | Pass | `unit/UT-G1-026-rt1.txt` | same result as round 1 |
| UT-G1-027 | Regression | 2026-10-08T10:05:43 | Pass | `unit/UT-G1-027-rt1.txt` | 027h harness note as in round 1 |
| UT-G1-028 | Regression | 2026-10-08T10:05:43 | Pass | `unit/UT-G1-028-rt1.txt` | same result as round 1 |
| UT-G1-029 | Regression | 2026-10-08T10:05:43 | Pass | `unit/UT-G1-029-rt1.txt` | same result as round 1 |
| UT-G1-024 | Regression | 2026-10-08T10:05:44 | Pass | `unit/UT-G1-024-rt1.txt` | same result as round 1 |
| UT-G1-031 | Regression | 2026-10-08T10:05:59 | Pass | `unit/UT-G1-031-rt1.txt` | same result as round 1 |
| UT-G1-032 | Regression | 2026-10-08T10:06:03 | Pass | `unit/UT-G1-032-rt1.txt` | same result as round 1 |
| UT-G1-033 | Regression | 2026-10-08T10:06:07 | Pass | `unit/UT-G1-033-rt1.txt` | same result as round 1 |
| UT-G1-034 | Regression | 2026-10-08T10:06:11 | Pass | `unit/UT-G1-034-rt1.txt` | same result as round 1 |
| UT-G1-035 | Regression | 2026-10-08T10:06:15 | Pass | `unit/UT-G1-035-rt1.txt` | same result as round 1 |
| UT-G1-037 | New | 2026-10-08T09:43:02 | Pass | `unit/UT-G1-037.txt` |  |
| UT-G1-038 | New | 2026-10-08T09:43:05 | Fail | `unit/UT-G1-038.txt` | DEF-QG-U07 |
| UT-G1-039 | New | 2026-10-08T09:43:08 | Pass | `unit/UT-G1-039.txt` |  |
| UT-G3-029 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-029.txt` |  |
| UT-G3-030 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-030.txt` |  |
| UT-G3-031 | New | 2026-10-08T09:45:23 | Fail | `unit/UT-G3-031.txt` | DEF-QG-U08 |
| UT-G3-032 | New | 2026-10-08T09:45:23 | Fail | `unit/UT-G3-032.txt` | DEF-QG-U08 |
| UT-G3-033 | New | 2026-10-08T09:45:23 | Fail | `unit/UT-G3-033.txt` | DEF-QG-U08 |
| UT-G3-034 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-034.txt` |  |
| UT-G3-035 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-035.txt` |  |
| UT-G3-036 | New | 2026-10-08T09:45:23 | Fail | `unit/UT-G3-036.txt` | DEF-QG-U09 |
| UT-G3-037 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-037.txt` |  |
| UT-G3-038 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-038.txt` |  |
| UT-G3-039 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-039.txt` |  |
| UT-G3-040 | New | 2026-10-08T09:45:23 | Pass | `unit/UT-G3-040.txt` |  |
| UT-G2-024 | New | 2026-10-08T09:50:03 | Pass | `unit/UT-G2-024.txt` |  |
| UT-G2-025 | New | 2026-10-08T09:50:03 | Fail | `unit/UT-G2-025.txt` | OBS-QG-U08 |
| UT-G2-023 | New | 2026-10-08T09:50:06 | Pass | `unit/UT-G2-023.txt` |  |
| UT-G2-022 | New | 2026-10-08T09:50:08 | Pass | `unit/UT-G2-022.txt` | OBS-QG-U07 |
| UT-G2-026 | New | 2026-10-08T09:57:26 | Fail | `unit/UT-G2-026.txt` | DEF-QG-U10 |
| UT-G4-024 | New | 2026-10-08T09:58:17 | Fail | `unit/UT-G4-024.txt` | DEF-QG-U11 |
| UT-G4-025 | New | 2026-10-08T10:02:49 | Pass | `unit/UT-G4-025.txt` |  |

Supporting files: `unit/UT-G3-rt1-pytest-output.txt` (the full route-audit output with the round-1 and new probes mounted).

## 5b. Re-test round 2 (build `e55d1395379e9bc97cf5f3dfbc6a55bd16962475`)

Confirmation of DEF-QG-U07..U11 and targeted regression: every G2 and G3 case, the G4 classifier cases and the G1 suppression cases, as the Test Manager specified. G1 rule-family, mypy, async-guard, GX and G5 cases were not in scope this round; they were unchanged by the round-2 fixes, and their round-1 re-test results stand. Evidence: `<ID>-rt2.txt`; full route-audit output `UT-G3-rt2-pytest-output.txt`.

| ID | Kind | Date/time (UTC) | Verdict | Evidence file | Notes |
|---|---|---|---|---|---|
| UT-G1-000 | Regression | 2026-10-08T10:29:25 | Pass | `unit/UT-G1-000-rt2.txt` | ruff, mypy and the async guard clean on the build |
| UT-G3-000 | Regression | 2026-10-08T10:30:18 | Pass | `unit/UT-G3-000-rt2.txt` | 264 passed (no database) |
| UT-G2-016 | Regression | 2026-10-08T10:30:49 | Pass | `unit/UT-G2-016-rt2.txt` | 54 leaks caught, 11 placeholder files quiet |
| UT-G1-038 | Confirmation | 2026-10-08T10:30:59 | Pass | `unit/UT-G1-038-rt2.txt` | DEF-QG-U07 Closed |
| UT-G1-009 | Regression | 2026-10-08T10:32:02 | Pass | `unit/UT-G1-009-rt2.txt` | same result as the previous round |
| UT-G1-010 | Regression | 2026-10-08T10:32:05 | Pass | `unit/UT-G1-010-rt2.txt` | same result as the previous round |
| UT-G1-036 | Regression | 2026-10-08T10:32:08 | Pass | `unit/UT-G1-036-rt2.txt` | same result as the previous round |
| UT-G1-037 | Regression | 2026-10-08T10:32:14 | Pass | `unit/UT-G1-037-rt2.txt` | same result as the previous round |
| UT-G1-039 | Regression | 2026-10-08T10:32:17 | Pass | `unit/UT-G1-039-rt2.txt` | same result as the previous round |
| UT-G2-017 | Confirmation | 2026-10-08T10:33:33 | Pass | `unit/UT-G2-017-rt2.txt` | DEF-QG-U10 Closed: all three mutations fail the replay (9, 7 and 21 leaks MISSED respectively); no gitleaks → exit 1 |
| UT-G2-026 | Confirmation | 2026-10-08T10:33:47 | Pass | `unit/UT-G2-026-rt2.txt` | DEF-QG-U10 Closed: the line-target edit still frees the two leaks, and the replay now fails on it (9 missed) |
| UT-G2-004 | Regression | 2026-10-08T10:34:43 | Pass | `unit/UT-G2-004-rt2.txt` | same result as the previous round |
| UT-G2-011 | Regression | 2026-10-08T10:34:44 | Pass | `unit/UT-G2-011-rt2.txt` | same result as the previous round |
| UT-G2-009 | Regression | 2026-10-08T10:34:46 | Pass | `unit/UT-G2-009-rt2.txt` | 009d (the worded placeholder) found as triaged; the other five quiet |
| UT-G2-021 | Regression | 2026-10-08T10:34:46 | Pass | `unit/UT-G2-021-rt2.txt` | same result as the previous round |
| UT-G2-010 | Regression | 2026-10-08T10:34:50 | Pass | `unit/UT-G2-010-rt2.txt` | same result as the previous round |
| UT-G2-014 | Regression | 2026-10-08T10:34:52 | Pass | `unit/UT-G2-014-rt2.txt` | same result as the previous round |
| UT-G2-024 | Regression | 2026-10-08T10:34:55 | Pass | `unit/UT-G2-024-rt2.txt` | same result as the previous round |
| UT-G2-025 | Regression | 2026-10-08T10:34:55 | Fail | `unit/UT-G2-025-rt2.txt` | OBS-QG-U08 (upstream gitleaks; unchanged) |
| UT-G2-002 | Regression | 2026-10-08T10:34:57 | Pass | `unit/UT-G2-002-rt2.txt` | same result as the previous round |
| UT-G2-007 | Regression | 2026-10-08T10:34:57 | Pass | `unit/UT-G2-007-rt2.txt` | same result as the previous round |
| UT-G2-005 | Regression | 2026-10-08T10:35:01 | Pass | `unit/UT-G2-005-rt2.txt` | same result as the previous round |
| UT-G2-006 | Regression | 2026-10-08T10:35:03 | Pass | `unit/UT-G2-006-rt2.txt` | same result as the previous round |
| UT-G2-023 | Regression | 2026-10-08T10:35:05 | Pass | `unit/UT-G2-023-rt2.txt` | same result as the previous round |
| UT-G2-003 | Regression | 2026-10-08T10:35:07 | Pass | `unit/UT-G2-003-rt2.txt` | same result as the previous round |
| UT-G2-022 | Confirmation | 2026-10-08T10:35:08 | Pass | `unit/UT-G2-022-rt2.txt` | OBS-QG-U07 Closed: every REEP-rule shape now found. The sk- legacy key with `<abc>` joined (022k) and the unrecognised sk-proj control (022a) stay quiet for the upstream reason in OBS-QG-U08 |
| UT-G2-001 | Regression | 2026-10-08T10:35:15 | Pass | `unit/UT-G2-001-rt2.txt` | same result as the previous round |
| UT-G2-008 | Regression | 2026-10-08T10:35:22 | Pass | `unit/UT-G2-008-rt2.txt` | same result as the previous round |
| UT-G2-012 | Regression | 2026-10-08T10:36:05 | Pass | `unit/UT-G2-012-rt2.txt` | same result as the previous round |
| UT-G2-013 | Regression | 2026-10-08T10:36:07 | Pass | `unit/UT-G2-013-rt2.txt` | same result as the previous round |
| UT-G2-018 | Regression | 2026-10-08T10:36:09 | Pass | `unit/UT-G2-018-rt2.txt` | unshallow clone: 600 commits from the build, clean; tree clean |
| UT-G2-020 | Regression | 2026-10-08T10:36:09 | Pass | `unit/UT-G2-020-rt2.txt` | same result as the previous round |
| UT-G3-001 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-001-rt2.txt` | same result as the previous round |
| UT-G3-002 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-002-rt2.txt` | same result as the previous round |
| UT-G3-003 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-003-rt2.txt` | same result as the previous round |
| UT-G3-004 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-004-rt2.txt` | same result as the previous round |
| UT-G3-005 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-005-rt2.txt` | same result as the previous round |
| UT-G3-006 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-006-rt2.txt` | same result as the previous round |
| UT-G3-007 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-007-rt2.txt` | same result as the previous round |
| UT-G3-008 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-008-rt2.txt` | same result as the previous round |
| UT-G3-009 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-009-rt2.txt` | same result as the previous round |
| UT-G3-010 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-010-rt2.txt` | same result as the previous round |
| UT-G3-011 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-011-rt2.txt` | same result as the previous round |
| UT-G3-012 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-012-rt2.txt` | same result as the previous round |
| UT-G3-013 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-013-rt2.txt` | same result as the previous round |
| UT-G3-014 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-014-rt2.txt` | same result as the previous round |
| UT-G3-015 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-015-rt2.txt` | same result as the previous round |
| UT-G3-016 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-016-rt2.txt` | same result as the previous round |
| UT-G3-017 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-017-rt2.txt` | same result as the previous round |
| UT-G3-019 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-019-rt2.txt` | same result as the previous round |
| UT-G3-020 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-020-rt2.txt` | same result as the previous round |
| UT-G3-021 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-021-rt2.txt` | same result as the previous round |
| UT-G3-022 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-022-rt2.txt` | same result as the previous round |
| UT-G3-023 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-023-rt2.txt` | same result as the previous round |
| UT-G3-024 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-024-rt2.txt` | same result as the previous round |
| UT-G3-029 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-029-rt2.txt` | same result as the previous round |
| UT-G3-030 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-030-rt2.txt` | same result as the previous round |
| UT-G3-031 | Confirmation | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-031-rt2.txt` | DEF-QG-U08 Closed |
| UT-G3-032 | Confirmation | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-032-rt2.txt` | DEF-QG-U08 Closed |
| UT-G3-033 | Confirmation | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-033-rt2.txt` | DEF-QG-U08 Closed |
| UT-G3-034 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-034-rt2.txt` | same result as the previous round |
| UT-G3-035 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-035-rt2.txt` | same result as the previous round |
| UT-G3-036 | Confirmation | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-036-rt2.txt` | DEF-QG-U09 Closed |
| UT-G3-037 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-037-rt2.txt` | same result as the previous round |
| UT-G3-038 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-038-rt2.txt` | same result as the previous round |
| UT-G3-039 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-039-rt2.txt` | same result as the previous round |
| UT-G3-040 | Regression | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-040-rt2.txt` | same result as the previous round |
| UT-G3-018 | Regression | 2026-10-08T10:38:05 | Pass | `unit/UT-G3-018-rt2.txt` | same result as the previous round |
| UT-G3-025 | Regression | 2026-10-08T10:38:05 | Pass | `unit/UT-G3-025-rt2.txt` | same result as the previous round |
| UT-G3-026 | Regression | 2026-10-08T10:38:13 | Pass | `unit/UT-G3-026-rt2.txt` | same result as the previous round |
| UT-G3-027 | Regression | 2026-10-08T10:38:17 | Pass | `unit/UT-G3-027-rt2.txt` | same result as the previous round |
| UT-G3-028 | Regression | 2026-10-08T10:38:45 | Pass | `unit/UT-G3-028-rt2.txt` | same result as the previous round |
| UT-G4-001 | Regression | 2026-10-08T10:39:15 | Pass | `unit/UT-G4-001-rt2.txt` | same result as the previous round |
| UT-G4-002 | Regression | 2026-10-08T10:39:18 | Pass | `unit/UT-G4-002-rt2.txt` | same result as the previous round |
| UT-G4-003 | Regression | 2026-10-08T10:39:21 | Pass | `unit/UT-G4-003-rt2.txt` | same result as the previous round |
| UT-G4-004 | Regression | 2026-10-08T10:39:23 | Pass | `unit/UT-G4-004-rt2.txt` | same result as the previous round |
| UT-G4-005 | Regression | 2026-10-08T10:39:29 | Pass | `unit/UT-G4-005-rt2.txt` | same result as the previous round |
| UT-G4-006 | Regression | 2026-10-08T10:39:31 | Pass | `unit/UT-G4-006-rt2.txt` | same result as the previous round |
| UT-G4-007 | Regression | 2026-10-08T10:39:36 | Pass | `unit/UT-G4-007-rt2.txt` | same result as the previous round |
| UT-G4-024 | Confirmation | 2026-10-08T10:39:39 | Pass | `unit/UT-G4-024-rt2.txt` | DEF-QG-U11 Closed (all six reported) |
| UT-G4-015 | Regression | 2026-10-08T10:39:56 | Pass | `unit/UT-G4-015-rt2.txt` | same result as the previous round |
| UT-G1-040 | New | 2026-10-08T10:31:18 | Fail | `unit/UT-G1-040.txt` | DEF-QG-U12 |
| UT-G1-041 | New | 2026-10-08T10:31:40 | Pass | `unit/UT-G1-041.txt` |  |
| UT-G1-042 | New | 2026-10-08T10:31:43 | Pass | `unit/UT-G1-042.txt` |  |
| UT-G1-043 | New | 2026-10-08T10:31:50 | Pass | `unit/UT-G1-043.txt` |  |
| UT-G2-027 | New | 2026-10-08T10:35:16 | Pass | `unit/UT-G2-027.txt` | OBS-QG-U09 |
| UT-G3-041 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-041.txt` |  |
| UT-G3-042 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-042.txt` |  |
| UT-G3-043 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-043.txt` |  |
| UT-G3-044 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-044.txt` |  |
| UT-G3-045 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-045.txt` |  |
| UT-G3-046 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-046.txt` |  |
| UT-G3-047 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-047.txt` |  |
| UT-G3-048 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-048.txt` |  |
| UT-G3-049 | New | 2026-10-08T10:37:15 | Pass | `unit/UT-G3-049.txt` |  |
| UT-G3-050 | New | 2026-10-08T10:37:15 | Fail | `unit/UT-G3-050.txt` | DEF-QG-U13 |
| UT-G4-026 | New | 2026-10-08T10:39:42 | Fail | `unit/UT-G4-026.txt` | DEF-QG-U14 |

---

## 6. Defects and observations

All defects were found on build `a3688f0`, in the environment in §3. Each one happens every time (100% reproducible). The suspected component is given as a pointer only; nothing was changed in the code under test. Severity and priority follow plan §8. The Test Manager triages them.

### DEF-QG-U01 — The route audit counts a gate whose refusal is caught as a gate

| Field | Value |
|---|---|
| Severity / priority | **Major / P2**: a significant false negative in the AUTH (gate) rule |
| Requirement | REQ-G3-03 ("reaches a role/scope gate **that can refuse**") |
| Build / environment | `a3688f0`; §3; PC-3 |
| Case / evidence | UT-G3-008 — `unit/UT-G3-008.txt`, `unit/UT-G3-run2-gate-pytest-output.txt` |
| Frequency | Always |
| Preconditions | A scratch worktree with a synthetic router mounted in its `app/main.py` |
| Steps to reproduce | 1. Add a handler `GET /api/qg/p08-swallowed` with `session: dict = Depends(get_current_session)` whose body is `try: require_admin(session)` / `except HTTPException: pass` / `return Out()`. 2. Add `GET /api/qg/p11-predicate-only` returning `Out(ok=_may_see_raw_response(session))`, which uses the **existing** helper `app/routers/interview_records.py:510`. That helper calls `require_admin` and catches the 403 to return a bool. 3. Run `pytest tests/test_route_audit.py`. 4. Call both routes with a STUDENT session. |
| Expected | Both reported under AUTH (gate): neither handler can refuse anybody |
| Actual | Neither is reported; a STUDENT gets **200** from both |
| Suspected component | `apps/api-py/tests/test_route_audit.py:475` `_reaches_gate` / `:352` `_resolved_calls`: a call to a function in `GATE_FUNCTIONS` counts wherever it sits, including inside a `try` whose handler swallows `HTTPException`. Following calls into helpers turns every predicate helper written this way into a "gate" for any handler that calls it |
| Why it matters | The predicate idiom already exists in `app/` (it is commented as deliberate in `interview_records.py`). The next handler that uses that helper, or one like it, as its only check gets a green audit and no check. This is the "forgotten check" shape the rule exists to catch |
| Re-test | **Closed** on `40201a1`: UT-G3-008-rt1. Both shapes reported, and `p11` still gives a STUDENT 200 behaviourally, as it should; it is the audit that now refuses it. Three other spellings of a swallowed refusal still pass and are raised as **DEF-QG-U08** rather than re-opening this one, because its reproduction is fixed |

### DEF-QG-U02 — The route audit counts a gate in dead code other than `if <constant>`

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3**: an edge case, unlikely to be written by accident |
| Requirement | REQ-G3-03 ("a gate in dead code does not count") |
| Build / environment | `a3688f0`; §3; PC-3 |
| Case / evidence | UT-G3-007, UT-G3-009 — `unit/UT-G3-007.txt`, `unit/UT-G3-009.txt` |
| Frequency | Always |
| Steps to reproduce | 1. Mount three handlers with a session: (a) `return Out()` followed by `require_admin(session)`; (b) `if not True: require_admin(session)`; (c) `while False: require_admin(session)`. 2. Run the audit. 3. Call each as a STUDENT. |
| Expected | All three reported |
| Actual | None reported; a STUDENT gets 200 from each. (`if False:` *is* reported, UT-G3-005.) |
| Suspected component | `apps/api-py/tests/test_route_audit.py:331` `_live_nodes`: it prunes only an `ast.If` whose test is an `ast.Constant`. It does not prune statements after `return`/`raise`, `while <falsy constant>`, or constant expressions such as `not True` |
| Re-test | **Closed** on `40201a1`: UT-G3-007-rt1, UT-G3-009-rt1, and the new UT-G3-030 (dead only inside a branch). A gate in a never-called nested function still counts: **DEF-QG-U09** |

### DEF-QG-U03 — One comment line switches the ruff gate off for a whole file in `app/`

| Field | Value |
|---|---|
| Severity / priority | **Major / P2**: a gate that can be silenced without review; contradicts a stated requirement |
| Requirement | REQ-G1-02 (an exception in `app/` is a line-level `# noqa: <code>` with a reason); AGENTS.md: "never a file-level ignore in `app/`" |
| Build / environment | `a3688f0`; §3; PC-1 |
| Case / evidence | UT-G1-036 — `unit/UT-G1-036.txt` |
| Frequency | Always |
| Steps to reproduce | 1. Create `apps/api-py/app/_qg_probe.py` with `# ruff: noqa` on line 1, then `assert x` and `subprocess.run(cmd, shell=True)`. 2. Run `python -m ruff check --config pyproject.toml app/_qg_probe.py` (the CI command's config). 3. Repeat without the file-level line, with a bare `# noqa` on the assert and `# noqa: S602` (no reason) on the call. |
| Expected | Refused (exit 1) |
| Actual | `All checks passed!`, exit 0, both times. The S, ASYNC, F and B findings are all suppressed for the file. No guard in the repository looks for `ruff: noqa` or blanket `noqa` (`grep` over `tools/ci`, `test_codebase_guards.py`, `pyproject.toml`: none). For information: ruff's own `PGH004` reports both shapes (`--extend-select PGH004`), and `app/` has no blanket or file-level noqa today, so selecting it would start green. Nothing anywhere enforces "with a reason" either |
| Suspected component | `apps/api-py/pyproject.toml:27` `[tool.ruff.lint] select` (PGH004 is not selected) |
| Re-test | **Closed** on `40201a1`: UT-G1-036-rt1. PGH004 and §39 refuse both shapes, and §39 refuses a reasonless coded noqa. The flake8 spelling is refused by PGH004 (UT-G1-037). ruff's range suppression is not refused: **DEF-QG-U07** |

### DEF-QG-U04 — An inline `gitleaks:allow` comment silences a real secret

| Field | Value |
|---|---|
| Severity / priority | **Major / P2**: a third, unreviewed allowlisting mechanism next to the two the requirement allows |
| Requirement | REQ-G2-05 (allowlisting is by value or fingerprint, narrow, with a reason) |
| Build / environment | `a3688f0`; §3; PC-2 |
| Case / evidence | UT-G2-021 — `unit/UT-G2-021.txt` |
| Frequency | Always |
| Steps to reproduce | 1. In a scratch directory outside the repository, write `.env` with `AUTH_SECRET=<fresh secrets.token_hex(32)>  # gitleaks:allow`. 2. Run `gitleaks dir <dir> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --exit-code 1` (the flags `secret-scan.yml` and `preflight.sh` use). 3. Control: the same line without the comment. |
| Expected | One `reep-auth-secret` finding, exit 1, in both runs |
| Actual | Control: 1 finding. With the comment: **0 findings, exit 0**. gitleaks 8.30.0 has `--ignore-gitleaks-allow` ("ignore gitleaks:allow comments"), which restores the finding (exit 1). It is not passed by `secret-scan.yml:142,162`, `tools/ci/preflight.sh:461` or `.pre-commit-config.yaml`. The marker appears nowhere in the repository today, so adding the flag would start green |
| Suspected component | The gitleaks invocations listed above |
| Re-test | **Closed** on `40201a1`: UT-G2-021-rt1. Found with `--ignore-gitleaks-allow`, which `secret-scan.yml:157,177`, every preflight invocation (`cfg` array, :484), `.pre-commit-config.yaml:74` and the replay all pass |

### DEF-QG-U05 — The round trip's loopback refusal does not see libpq's `PGHOSTADDR`

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3**: needs a deliberately set environment variable, and the managed-server probe still refuses an RDS/Aurora/Cloud SQL/Azure server |
| Requirement | REQ-G4-04 (refuses a non-loopback host) |
| Build / environment | `a3688f0`; §3 |
| Case / evidence | UT-G4-020 — `unit/UT-G4-020.txt` |
| Frequency | Always |
| Steps to reproduce | 1. `cd apps/api-py`. 2. `PGHOSTADDR=192.0.2.1 ENV=dev DATABASE_URL=postgresql+psycopg://reep:…@localhost:5433/reep_py python ../../tools/ci/check_migration_roundtrip.py --plan`. 3. In the same environment, build the engine as the script does and connect. |
| Expected | Refused: the connection would go to a non-loopback address |
| Actual | Not refused: `libpq_hosts()` returns `['localhost']` and `refusal()` returns `None`. The connection attempt goes to `server at "192.0.2.1", port 5433`. Without the variable it goes to 127.0.0.1. The `alembic` subprocesses inherit the same environment |
| Suspected component | `tools/ci/check_migration_roundtrip.py:199` `libpq_hosts` / `:216` `refusal`: they read only the URL's connect arguments. libpq also takes `hostaddr` from `PGHOSTADDR` (and from a `service=` entry) when the URL has none |
| Note | `PGHOST` is not a gap: the URL always carries a host, or the script refuses `(libpq default)` (UT-G4-018) |
| Re-test | **Closed** on `40201a1`: UT-G4-020-rt1 (PGHOSTADDR refused, a loopback PGHOSTADDR allowed, and a comma list refused) and UT-G4-025 (PGSERVICE, PGSERVICEFILE, `?service=`, PGSYSCONFDIR+service all refused) |

### DEF-QG-U06 — The static reversibility test classifies a do-nothing downgrade as "real" when it is not literally `pass`

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3** |
| Requirement | REQ-G4-01 (every revision has a downgrade that does real work, or an `IRREVERSIBLE` entry with its reason) |
| Build / environment | `a3688f0`; §3; PC-4 |
| Case / evidence | UT-G4-007 (and UT-G4-013 for the dynamic half) — `unit/UT-G4-007.txt`, `unit/UT-G4-013.txt` |
| Frequency | Always |
| Steps to reproduce | 1. In a scratch worktree add three chained revisions after `f4a2c9e7b1d3` whose `downgrade()` bodies are `return`, `"""Nothing."""` + `...`, and `if False: op.execute("SELECT 2")`. 2. Run `pytest tests/test_migration_reversibility.py`. |
| Expected | All three reported as having no real downgrade |
| Actual | Only the docstring + `...` revision is reported. `return` and `if False:` are classified `real` and pass. The round trip catches such a downgrade only when its upgrade changed the catalogue (UT-G4-013). For a **data-only** migration (an `UPDATE`) whose downgrade is `return`, neither half fails, and no `IRREVERSIBLE` reason is ever written |
| Suspected component | `apps/api-py/migrations/reversibility.py:148` `_downgrade_kind`: only `pass`-only bodies and a single `raise` are recognised. The docstring says this looseness is deliberate; the requirement as written is stricter |
| Re-test | **Closed** on `40201a1`: UT-G4-007-rt1 (all three reported). Further do-nothing shapes remain: **DEF-QG-U11** |

## 6a. Defects raised in re-test round 1 (build `40201a1`)

### DEF-QG-U07 — `# ruff: disable[<codes>]` on line 1 silences named rules for a whole file, with no reason, and nothing refuses it

| Field | Value |
|---|---|
| Severity / priority | **Major / P2**: the same hole as DEF-QG-U03 (a file-level suppression in `app/`), reached through ruff's other suppression syntax |
| Requirement | REQ-G1-02; §39's own docstring ("a line-level suppression with its reason in words after the codes, never a file-level one") |
| Build / environment | `40201a1`; §3; PC-1 |
| Case / evidence | UT-G1-038 — `unit/UT-G1-038.txt` |
| Frequency | Always |
| Steps to reproduce | 1. Create `apps/api-py/app/_qg_probe.py`. Line 1: `# ruff: disable[S101, S602, ASYNC221, ASYNC251, F401, F821]`. Below it: an unused `import os`, and an `async def` with `assert x`, `subprocess.run(cmd, shell=True)`, `time.sleep(1)` and `return undefined_name`. Add a plain `def` with another `shell=True` call. No `# ruff: enable`. 2. `python -m ruff check --config pyproject.toml app/_qg_probe.py`. 3. `pytest tests/test_codebase_guards.py -k test_every_suppression_in_shipped_code`. |
| Expected | Refused by ruff or by §39 |
| Actual | ruff: `All checks passed!`, exit 0. §39: passed. Six rules are off for the rest of the file, in both functions, with no reason anywhere. The paired form (`disable[...]` … `enable[...]` around two lines) also passes both, again with no reason. Prefix codes (`disable[S, ASYNC, F]`) are not honoured by ruff, so the hole needs full codes |
| Suspected component | `apps/api-py/tests/test_codebase_guards.py` §39 `_NOQA` (it reads only `noqa` comments); PGH004 covers only blanket `noqa`. No ruff rule in the selection reports an unmatched or unreasoned range suppression |
| Re-test | **Closed** on `e55d139` (round 2): UT-G1-038-rt2. The line-1 unclosed `disable` is refused by §39 (never closed; no reason), and ruff's RUF104 too. The paired form without a reason is refused by §39. The flake8 spelling with codes and `file-ignore` are refused (UT-G1-042). A reasoned closed range spanning the whole file is still accepted: **DEF-QG-U12** |

### DEF-QG-U08 — The route audit still counts a swallowed refusal when the catch is spelled differently

| Field | Value |
|---|---|
| Severity / priority | **Minor / P2**: the DEF-QG-U01 shapes are fixed; these are less common spellings of the same bug |
| Requirement | REQ-G3-03 |
| Build / environment | `40201a1`; §3; PC-3 |
| Case / evidence | UT-G3-031, 032, 033 — `unit/UT-G3-031.txt` … `033.txt`, `unit/UT-G3-rt1-pytest-output.txt` |
| Frequency | Always |
| Steps to reproduce | Mount three handlers with a session. (a) `with contextlib.suppress(HTTPException): require_admin(session)`. (b) `try: require_admin(session)` / `except starlette.exceptions.HTTPException: pass` (FastAPI's `HTTPException` subclasses it). (c) `from fastapi import HTTPException as HE` … `except HE: pass`. Run the audit, then call each as a STUDENT. |
| Expected | All three reported under AUTH (gate) |
| Actual | None reported; a STUDENT gets 200 from each. `except fastapi.HTTPException`, `except BaseException`, `except Exception`, a bare `except`, a tuple, and a caught refusal that returns are all reported correctly (UT-G3-034, 035, 037, and Worker C's own shapes) |
| Suspected component | `apps/api-py/tests/test_route_audit.py`: the swallowed-refusal check matches the caught exception by name. It knows `HTTPException` / `fastapi.HTTPException` and the broad bases, but not an import alias or Starlette's base class, and it has no notion of `contextlib.suppress` |
| Re-test | **Closed** on `e55d139` (round 2): UT-G3-031/032/033-rt2 reported. New spellings are also reported: a tuple with an alias (UT-G3-041), a renamed `suppress` (042), and `suppress(Exception)` or a Starlette base inside a tuple (046, 047). A LOCAL rebinding of the exception class inside the handler is not: **DEF-QG-U13** |

### DEF-QG-U09 — The route audit counts a gate inside a nested function that is never called

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3** |
| Requirement | REQ-G3-03 (a gate in dead code does not count) |
| Build / environment | `40201a1`; §3; PC-3 |
| Case / evidence | UT-G3-036 — `unit/UT-G3-036.txt` |
| Frequency | Always |
| Steps to reproduce | A handler with a session whose body defines `def check() -> None: require_admin(session)` and returns `Out()` without calling `check`. Run the audit, then call it as a STUDENT. |
| Expected | Reported |
| Actual | Not reported; STUDENT → 200 |
| Suspected component | `test_route_audit.py`'s source walk (`_live_nodes` and its successors) descends into nested `def` bodies as if they ran in the handler |
| Re-test | **Closed** on `e55d139` (round 2): UT-G3-036-rt2 reported. Also reported: a def called only from an uncalled def (043), an uncalled lambda (048), a call after `return` (049), and a call inside a swallowing `try` (045). Called defs and lambdas still count (044) |

### DEF-QG-U10 — The rule replay no longer fails when the allowlist is reverted to `regexTarget = "line"`, the bug it exists to catch

| Field | Value |
|---|---|
| Severity / priority | **Major / P2**: a ratchet that no longer ratchets (plan §8). The edit it should catch frees real secrets |
| Requirement | REQ-G2-05 (and the replay's own docstring: it replays the leaks the line-targeted allowlist let through, "to keep it meaning that") |
| Build / environment | `40201a1`; §3; PC-2 |
| Case / evidence | UT-G2-026, UT-G2-017-rt1 — `unit/UT-G2-026.txt`, `unit/UT-G2-017-rt1.txt` |
| Frequency | Always |
| Steps to reproduce | 1. In a scratch copy of the build, change the two `regexTarget = "match"` lines of `.gitleaks.toml` (247 and 425) to `"line"`. 2. `python3 tools/ci/check_gitleaks_rules.py`. 3. With that config, scan (i) `AUTH_SECRET: ci-secret-not-used-outside-ci-0123456789abcdef ; DB=postgresql://reep:<20 random alnum>@db.example.com/x` and (ii) the dev `DATABASE_URL` (password `reep_dev_password`) followed on the same line by `GITHUB_TOKEN=` and a real-shaped ghp_ token. |
| Expected | The replay fails, as on `a3688f0` (UT-G2-017: 5 leaks MISSED, exit 1); (i) and (ii) are caught |
| Actual | Replay: `OK: 20 leaks caught, 11 placeholder files quiet.`, exit 0. (i) and (ii): **quiet**. With the shipped `"match"` both are caught |
| Why | The anchoring for OBS-QG-U01 and FV-QG-01 changed the published values to `:reep_dev_password@` and a bounded `ci-secret-…`. The replay's same-line case (`DATABASE_PASSWORD=reep_dev_password GITHUB_TOKEN=…`) no longer contains an allowlisted value, so it no longer exercises the line target |
| Suspected component | `tools/ci/check_gitleaks_rules.py` `cases()`: no leak case puts a real secret on the same line as a value the CURRENT allowlist frees. For example, cases (i) and (ii) above would restore the guard |
| Re-test | **Closed** on `e55d139` (round 2): UT-G2-017-rt2 and UT-G2-026-rt2. The `regexTarget = "line"` edit now fails the replay with 9 leaks MISSED. The `{80,}` edit and the unanchored-placeholder edit fail it too. The replay reports 54 leaks caught and 11 quiet files on the shipped config |

### DEF-QG-U11 — The reversibility classifier still reads several do-nothing downgrades as "real"

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3** |
| Requirement | REQ-G4-01 |
| Build / environment | `40201a1`; §3; PC-4 |
| Case / evidence | UT-G4-024 — `unit/UT-G4-024.txt` |
| Frequency | Always |
| Steps to reproduce | In a scratch worktree, chain six revisions after `f4a2c9e7b1d3`. Each upgrade is a data-only `UPDATE`. Their downgrade bodies: `if not True: op.execute(…)`, `while False: op.execute(…)`, `return 0`, `for _ in (): op.execute(…)`, `if 1 == 2: op.execute(…)`, and `return` followed by `op.execute(…)`. Run `pytest tests/test_migration_reversibility.py`. |
| Expected | All six reported as no-op |
| Actual | Only the last is reported. The other five are classified `real`, and a data-only upgrade changes no catalogue, so the round trip cannot see them either. The original DEF-QG-U06 shapes (`return`, `if False:`, a docstring and `...`) are now reported (UT-G4-007-rt1) |
| Suspected component | `apps/api-py/migrations/reversibility.py` `_executed`: it prunes only an `ast.If` whose test is an `ast.Constant`, and treats `return <value>` as work. The route audit's fix for DEF-QG-U02 already handles `if not True:` and `while False:` |
| Re-test | **Closed** on `e55d139` (round 2): UT-G4-024-rt2, all six reported as no-op. The Test Manager's shape (an op after `return` inside `if True:`) is reported as well (UT-G4-026, revision 1). Three related shapes are not: **DEF-QG-U14** |


## 6b. Defects raised in re-test round 2 (build `e55d139`)

### DEF-QG-U12 — A reasoned `ruff: disable` … `enable` range that spans a whole module is accepted

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3**: needs a written reason, which a reviewer sees; but it is a file-level suppression by another spelling |
| Requirement | REQ-G1-02; AGENTS.md ("never a file-level ignore in `app/`") |
| Build / case / evidence | `e55d139`; UT-G1-040 (second probe) — `unit/UT-G1-040.txt` |
| Frequency | Always |
| Steps to reproduce | `app/_qg_probe.py`, line 1: `# ruff: disable[S101, S602, F401, F821]  this whole module is a vendored shim, reviewed 2026-10`. Below it: an unused import, `assert x`, `subprocess.run(cmd, shell=True)` and an undefined name. Last line: the matching `# ruff: enable[...]`. Run ruff (CI config) and §39. |
| Expected | Refused: it suppresses the same rules for the same lines as the refused file-level forms |
| Actual | ruff exit 0; §39 passes |
| Suspected component | `tests/test_codebase_guards.py` §39: it checks a range is closed and reasoned, but not how much it spans (e.g. a range that opens before the first statement, or covers more than one function, could be refused) |
| Re-test | New in round 2 |

### DEF-QG-U13 — The route audit counts a swallowed refusal when the caught class is a local alias

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3**: an unusual spelling |
| Requirement | REQ-G3-03 |
| Build / case / evidence | `e55d139`; UT-G3-050 — `unit/UT-G3-050.txt` |
| Frequency | Always |
| Steps to reproduce | A handler with a session whose body is: `Refusal = HTTPException`, then `try: require_admin(session)` / `except Refusal: pass`, then `return Out()`. Run the audit; call it as a STUDENT. |
| Expected | Reported |
| Actual | Not reported; STUDENT → 200. Module-level aliases, qualified names, tuples, `suppress` under any name and the Starlette base are all reported (UT-G3-033, 041, 042, 047) |
| Suspected component | `tests/test_route_audit.py`: caught types are resolved through the handler's **globals** only, so a name bound inside the function resolves to nothing and is treated as "something else" |
| Re-test | New in round 2 |

### DEF-QG-U14 — The reversibility classifier does not treat a `return` inside a constant-true branch as ending the body

| Field | Value |
|---|---|
| Severity / priority | **Minor / P3** |
| Requirement | REQ-G4-01 |
| Build / case / evidence | `e55d139`; UT-G4-026 — `unit/UT-G4-026.txt` |
| Frequency | Always |
| Steps to reproduce | In a scratch worktree, chain revisions after `f4a2c9e7b1d3`, each upgrade a data-only `UPDATE`. Their downgrade bodies are (2) `if True: return` then `op.execute(…)`; (3) `if 0 < 1: return` then `op.execute(…)`; (4) `while True: break` then `if not (1 == 1): op.execute(…)`. Run `pytest tests/test_migration_reversibility.py`. |
| Expected | All three reported as no-op |
| Actual | Classified `real`. (`if True:` with the op after `return` INSIDE the branch, the Test Manager's shape, is reported; so are all six DEF-QG-U11 shapes) |
| Suspected component | `apps/api-py/migrations/reversibility.py` `_executed`: it folds a constant test and splices the selected branch's statements, but a `return` inside that branch does not stop the walk of the outer body. `while True: break` is kept as work |
| Re-test | New in round 2 |

### Observations (not raised as defects)

| ID | Case | Observation | Why it is not a defect |
|---|---|---|---|
| OBS-QG-U01 | UT-G2-014 | With `regexTarget = "match"`, a real-shaped value that *contains* an allowlisted placeholder is freed: AUTH_SECRET set to change-me- followed by 40 random characters; AUTH_SECRET set to a quoted dollar-brace X reference followed by 40 random characters; OPENAI_API_KEY set to the word changeme followed by 40 random hex; and a postgresql URL whose password is the word changeme followed by random hex. All four were quiet. | For AUTH_SECRET it is consistent: `app/config.py`'s boot guard refuses any value containing `change-me`/`changeme`, so such a value can never be a production key. For the other variables nothing refuses it. Anchoring the placeholder regexes (for example `^…$` against the secret) would close it. For the Test Manager to decide |
| OBS-QG-U02 | UT-G2-018 | The four path-scoped allowlists (`^\.gitleaks\.toml$`, `^apps/api-py/tests/test_backup_database\.py$`, `^apps/api-py/app/voice_platform/api/calls\.py$`, `^infra/cdk/import-map\.json$`) match only when gitleaks is run from the repository root. `gitleaks dir /abs/path/to/checkout` reports 4 findings on a clean tree. | CI and `preflight.sh` both run `gitleaks dir .` from the root, and so does the reproduction line in `.gitleaksignore`. Only someone running it by hand another way is affected; a one-line note in `.gitleaks.toml` would help |
| OBS-QG-U03 | UT-G1-030 | Blocking shapes that neither the async guard nor ruff ASYNC catch: an immediately-invoked lambda (`(lambda: time.sleep(5))()`), and `os.open`/`os.read`. `Path(p).open()` is caught by ruff (ASYNC230) but not by the guard. | The guard's docstring says it is "deliberately not clever" and excludes lambda bodies on purpose; `os.*` is not in the documented list. Recorded so the limits are known |
| OBS-QG-U04 | UT-G3-015 | `-> RootModel[dict[str, Any]]` passes the RESPONSE rule, although its only content is a `dict[str, Any]` leaf. | `_untyped_parts` documents that a Pydantic model is a leaf and is never looked inside. REQ-G3-04's wording ("dict/Any leaves do not count") would include it. Low likelihood |
| OBS-QG-U05 | UT-GX-001 | `preflight.sh` reads `GITLEAKS_VERSION` only in double quotes. A single-quoted or unquoted value (valid YAML, still read by Actions) gives an empty pin, and the secrets check then SKIPs with "gitleaks 8.30.0 is not v; another version is another ruleset". | Fails safe (SKIP → exit 2, never a false PASS). Only the message is misleading |
| OBS-QG-U06 | UT-G5-002 | Two checklist items use wordings other than a gate name or *human — no gate*: "Errors use the one envelope" says *not enforced yet*, and "Review done" says *human*. | Neither claims a machine check that does not exist, which is the substance of REQ-G5-02. The wording is not uniform |


**Re-test of the round-1 observations (build `40201a1`):** OBS-QG-U01 Closed (UT-G2-014-rt1: three of the four bypasses found; `AUTH_SECRET=change-me-…` stays quiet through a `reep-auth-secret`-scoped allowlist mirroring the boot guard, which round 1 already judged harmless). OBS-QG-U02 Closed (documented at `.gitleaks.toml:361`; UT-G2-018-rt1). OBS-QG-U03 Closed (`os.*` and `Path(...).open()` flagged, lambda documented; UT-G1-030-rt1). OBS-QG-U04 Closed (UT-G3-015-rt1, UT-G3-039). OBS-QG-U05 Closed (UT-GX-001-rt1). OBS-QG-U06 Closed (UT-G5-002-rt1). The E9 comment is fixed (UT-G1-002-rt1).

**New observations (round 1):**

| ID | Case | Observation | Why it is not a defect |
|---|---|---|---|
| OBS-QG-U07 | UT-G2-022 | The `<word>` placeholder allowlist accepted with FV-QG-01 frees more than the register's premise says. The register says "none of these rules' key alphabets contains `<` or `>`". In fact the alphabets of **reep-openai-key, reep-groq-key (name branch), reep-livekit-credentials, reep-voice-worker-secret, reep-database-url-password and reep-auth-secret's quoted branch** all admit `<`. A real value with `<abc>` joined to it is quiet under each of those rules, and for the DB URL also when the `<word>` sits in the **middle** of the password, which is a usable password. It is found where the alphabet stops at `<` (ghp_, unquoted AUTH_SECRET) and when the run is under 3 characters. | The Test Manager accepted this residual risk in writing (FV-QG-01). This records the exact boundary so the acceptance rests on accurate facts. One way to narrow it, if wanted: require the WHOLE secret to be the placeholder for those six rules, as the `change-me` and `${VAR}` regexes now do |
| OBS-QG-U08 | UT-G2-025 | A real OpenAI key inside an HTML element (`<code>KEY</code>`), or with `<abc>` joined, is not reported. The cause is gitleaks' own `openai-api-key` boundary, so the same happens with no REEP configuration at all. The Test Manager's `sk-…<x>` example is quiet for this reason, not because of REEP's allowlist. | Upstream behaviour, unchanged by this PR. The repository-specific `reep-openai-key` still catches the `OPENAI_API_KEY=` assignment form |

**Round 2 (build `e55d139`):** OBS-QG-U07 Closed (UT-G2-022-rt2; the exemption was narrowed to a WHOLE `<…>`). OBS-QG-U08 unchanged (upstream gitleaks).

| ID | Case | Observation | Why it is not a defect |
|---|---|---|---|
| OBS-QG-U09 | UT-G2-027 | A real value written WHOLLY inside one `<…>` is freed: up to 40 key characters (`[A-Za-z0-9_ .-]`) for OPENAI_API_KEY, a quoted AUTH_SECRET of 32 hex, and a DB password. At 41 characters it is found. | It is indistinguishable from a placeholder by construction, and it is the narrowest form the exemption can take while `<your key>` stays legal in docs. The 40-character cap bounds it; real AUTH_SECRETs are 64 hex and are always found |

Other things noticed while testing, not raised: ruff 0.16 reports parse errors as `invalid-syntax` rather than E999, so `E9` in the selection now enables only E902 (UT-G1-002). The gate still fails on a syntax error, but the comment "E9: the file does not even parse" describes ruff's built-in behaviour rather than the selection.

---

## 7. Level summary

### 7.1 Counts

| Planned | Executed | Passed | Failed | Blocked | Not run | Pass rate (executed) |
|---|---|---|---|---|---|---|
| 109 | 109 | 99 | 10 | 0 | 0 | 90.8 % |

| Gate | Cases | Pass | Fail | Fail → defect / observation |
|---|---|---|---|---|
| G1 static analysis | 36 | 34 | 2 | UT-G1-036 → DEF-QG-U03; UT-G1-030 → OBS-QG-U03 |
| G2 secrets | 19 | 17 | 2 | UT-G2-021 → DEF-QG-U04; UT-G2-014 → OBS-QG-U01 |
| G3 route audit | 29 | 25 | 4 | UT-G3-008 → DEF-QG-U01; UT-G3-007, 009 → DEF-QG-U02; UT-G3-015 → OBS-QG-U04 |
| G4 migrations | 21 | 19 | 2 | UT-G4-020 → DEF-QG-U05; UT-G4-007 → DEF-QG-U06 |
| GX preflight | 2 | 2 | 0 | (OBS-QG-U05 on a passing case) |
| G5 PR template | 2 | 2 | 0 | (OBS-QG-U06 on a passing case) |

Every failed case is an **adversarial bypass attempt**. Every positive, negative, boundary and ratchet case for every gate passed:
- each selected ruff family, the mypy flags and the async guard's documented shapes;
- every REEP gitleaks rule, the allowlists and the same-line rule, `--redact`, the rule replay, the sha256 pin, and a clean full history;
- every route-audit rule, all six ratchets, the handler pinning, the no-database run and the 300-operation floor;
- the static reversibility ratchet, segments/floor, the round trip catching incomplete, wrong and residue downgrades, the KEPT ratchet, the refusal decision tables, and the port-mapping fix;
- preflight's exit-code table;
- the PR template.

Unique IDs not used: UT-G1-013, UT-G2-015, UT-G2-019, UT-G4-008, UT-G4-009. They were reserved at design time and merged into neighbouring cases (for example, the `${X}` prefix bypass is part of UT-G2-014).

**Defects by severity:** Critical 0 · Major 3 (DEF-QG-U01, U03, U04) · Minor 3 (DEF-QG-U02, U05, U06). **Observations:** 6.

### 7.2 Requirements covered by this level

| Requirement | Cases |
|---|---|
| REQ-G1-01 | UT-G1-000, UT-G1-001, UT-G1-002, UT-G1-003, UT-G1-004, UT-G1-005, UT-G1-006, UT-G1-007, UT-G1-008, UT-G1-009, UT-G1-011, UT-G1-012 |
| REQ-G1-02 | UT-G1-009, UT-G1-010, UT-G1-036 |
| REQ-G1-03 | UT-G1-000, UT-G1-014, UT-G1-015, UT-G1-016, UT-G1-017, UT-G1-018, UT-G1-019, UT-G1-020 |
| REQ-G1-04 | UT-G1-000, UT-G1-022, UT-G1-023, UT-G1-024, UT-G1-025, UT-G1-026, UT-G1-027, UT-G1-028, UT-G1-029, UT-G1-030, UT-G1-035 |
| REQ-G1-05 | UT-G1-031, UT-G1-032, UT-G1-033, UT-G1-034 |
| REQ-G1-07 | UT-G1-021 |
| REQ-G2-01 | UT-G2-020 |
| REQ-G2-05 | UT-G2-001, UT-G2-002, UT-G2-003, UT-G2-004, UT-G2-005, UT-G2-006, UT-G2-007, UT-G2-008, UT-G2-009, UT-G2-010, UT-G2-011, UT-G2-013, UT-G2-014, UT-G2-016, UT-G2-017, UT-G2-021 |
| REQ-G2-06 | UT-G2-012 |
| REQ-G2-08 | UT-G2-018 |
| REQ-G3-01 | UT-G3-000, UT-G3-028 |
| REQ-G3-02 | UT-G3-000, UT-G3-001, UT-G3-024 |
| REQ-G3-03 | UT-G3-000, UT-G3-002, UT-G3-003, UT-G3-004, UT-G3-005, UT-G3-006, UT-G3-007, UT-G3-008, UT-G3-009 |
| REQ-G3-04 | UT-G3-000, UT-G3-010, UT-G3-011, UT-G3-012, UT-G3-013, UT-G3-014, UT-G3-015, UT-G3-016 |
| REQ-G3-05 | UT-G3-000, UT-G3-017, UT-G3-018, UT-G3-019 |
| REQ-G3-06 | UT-G3-000, UT-G3-020, UT-G3-021, UT-G3-022, UT-G3-023 |
| REQ-G3-07 | UT-G3-000, UT-G3-025, UT-G3-026 |
| REQ-G3-08 | UT-G3-027 |
| REQ-G4-01 | UT-G3-000, UT-G4-001, UT-G4-002, UT-G4-003, UT-G4-004, UT-G4-005, UT-G4-006, UT-G4-007, UT-G4-015 |
| REQ-G4-02 | UT-G4-010 |
| REQ-G4-03 | UT-G4-011, UT-G4-012, UT-G4-013, UT-G4-014, UT-G4-016, UT-G4-023 |
| REQ-G4-04 | UT-G4-017, UT-G4-018, UT-G4-019, UT-G4-020, UT-G4-021, UT-G4-022 |
| REQ-G5-01 | UT-G5-001 |
| REQ-G5-02 | UT-G5-002 |
| REQ-GX-02 | UT-GX-001, UT-GX-002 |

Not covered at L1 (see §2): REQ-G1-06, REQ-G2-02, 03, 04, 07, REQ-G3-09, REQ-G4-05, 06, REQ-G5-03, REQ-GX-01, 03, 04. REQ-G4-02 is covered here only by the baseline run.

### 7.3 Residual risks seen from this level

1. **The three gates that rely on matching source text can be bypassed by an author who wants to** (DEF-QG-U01, U03, U04). No correct tree is ever red because of them; the risk is a wrong change going green. Each has a cheap, start-green fix that the evidence points to: select PGH004; pass `--ignore-gitleaks-allow`; teach `_reaches_gate` not to count a gate inside a `try` that catches `HTTPException`. These are suggestions for the developers, not changes made here.
2. The route audit proves a gate is *called*, not that it is the right one, and its source reading is branch-insensitive. The module docstring says so; DEF-QG-U02 is the dead-code part of that limit.
3. Results are from Python 3.13 / PostgreSQL 16. Nothing in the 109 cases looked version-sensitive, but the CI run on 3.14 / 17 is the authority for those versions.

### 7.4 Recommendation (round 1, `a3688f0`; superseded by §7.5)

**Conditional GO for level L1.** Every gate does what its requirement says on correct and incorrect inputs, and every ratchet ratchets in both directions. No defect makes a gate red on a correct tree or green on an ordinary mistake. Conditions:
- the Test Manager triages the three **Major** defects (DEF-QG-U01, U03, U04, all P2). Either they are fixed in this PR, in which case I re-test UT-G1-036, UT-G2-021 and UT-G3-008, or they are accepted in writing as residual risk with a tracked follow-up, per plan §6 exit criterion 3;
- the three Minor defects and six observations are fixed or accepted.

### 7.5 Re-test round 1 on `40201a1`: counts, coverage and recommendation

| Set | Planned | Executed | Passed | Failed | Blocked | Not run |
|---|---|---|---|---|---|---|
| Round-1 cases re-executed (confirmation + regression) | 109 | 109 | 108 | 1 (UT-G2-017-rt1 → DEF-QG-U10) | 0 | 0 |
| New cases (§4.3) | 22 | 22 | 14 | 8 | 0 | 0 |
| **Total on `40201a1`** | **131** | **131** | **122** | **9** | **0** | **0** |

Pass rate on the new build: 93.1 % (122/131).

| Defect | Round-1 severity | Re-test verdict |
|---|---|---|
| DEF-QG-U01 | Major | **Closed** (UT-G3-008-rt1) |
| DEF-QG-U02 | Minor | **Closed** (UT-G3-007-rt1, 009-rt1) |
| DEF-QG-U03 | Major | **Closed** (UT-G1-036-rt1) |
| DEF-QG-U04 | Major | **Closed** (UT-G2-021-rt1) |
| DEF-QG-U05 | Minor | **Closed** (UT-G4-020-rt1, UT-G4-025) |
| DEF-QG-U06 | Minor | **Closed** (UT-G4-007-rt1) |

**New defects (round 1):** Critical 0 · Major 2 (**DEF-QG-U07** ruff range suppression; **DEF-QG-U10** the rule replay no longer catches a revert to `regexTarget = "line"`) · Minor 3 (DEF-QG-U08, U09, U11). **New observations:** 2 (OBS-QG-U07, U08). All round-1 observations are closed.

**Regression.** Every G1, G2, G3, G4, GX and G5 round-1 case gave the same result on the new build, with two exceptions, both intended. UT-G2-009's worded placeholder is now (correctly) a finding. UT-G2-017's line-target variant no longer fails the replay (DEF-QG-U10). The CI port-mapping fix still holds (UT-G4-021-rt1). **REQ-G2-08 rests on the unshallowed re-run of UT-G2-018 (594 commits from the build, clean), not on round 1's shallow scan.** The 227 guard and audit tests pass with no database.

**Requirements covered on the new build:** the same as round 1 (§7.2), every one re-executed. The new cases add evidence to REQ-G1-02, REQ-G2-05, REQ-G3-03, REQ-G3-04, REQ-G4-01 and REQ-G4-04.

**Residual risks:** DEF-QG-U07 and U10 (below), the accepted `<word>` boundary (OBS-QG-U07, now stated precisely), and the upstream HTML blind spot (OBS-QG-U08). The pattern across this round: each fix closed the reproduced shape. The adversarial cases found the neighbouring spellings of the same bypass (another suppression syntax; other ways to swallow or never run a gate; other do-nothing downgrades). The one regression was in the gate's own self-test.

**Recommendation: conditional GO for level L1 on `40201a1`.** All six round-1 defects are closed and no correct tree goes red. The conditions, per plan §6 exit criterion 3:
- **DEF-QG-U07** and **DEF-QG-U10** (both Major, P2) are fixed and re-tested, or accepted in writing.
  - U07: refusing `ruff: disable` in §39 (or its unmatched/reasonless form) would close it.
  - U10: one replay case per anchored allowlist value would restore the ratchet.
  - On a fix I re-run UT-G1-038, UT-G2-017 and UT-G2-026.
- DEF-QG-U08, U09 and U11 (Minor) are fixed or accepted as residual risk.
- The Test Manager confirms that the FV-QG-01 acceptance still stands with the corrected boundary in OBS-QG-U07.

### 7.6 Re-test round 2 on `e55d139`: counts and recommendation

| Set | Planned | Executed | Passed | Failed | Blocked | Not run |
|---|---|---|---|---|---|---|
| Confirmation + targeted regression (`-rt2`) | 81 | 81 | 80 | 1 (UT-G2-025-rt2 → OBS-QG-U08, upstream, unchanged) | 0 | 0 |
| New cases (§4.4) | 16 | 16 | 13 | 3 | 0 | 0 |
| **Total in round 2** | **97** | **97** | **93** | **4** | **0** | **0** |

| Defect | Severity | Round-2 verdict |
|---|---|---|
| DEF-QG-U01 … U06 | — | Closed in round 1 (not re-opened; their cases pass again in this regression) |
| DEF-QG-U07 | Major | **Closed** (UT-G1-038-rt2) |
| DEF-QG-U08 | Minor | **Closed** (UT-G3-031..033-rt2) |
| DEF-QG-U09 | Minor | **Closed** (UT-G3-036-rt2) |
| DEF-QG-U10 | Major | **Closed** (UT-G2-017-rt2, UT-G2-026-rt2) |
| DEF-QG-U11 | Minor | **Closed** (UT-G4-024-rt2) |
| DEF-QG-U12 | Minor (new) | Open |
| DEF-QG-U13 | Minor (new) | Open |
| DEF-QG-U14 | Minor (new) | Open |

**Open defects: Critical 0 · Major 0 · Minor 3.** Observations open: OBS-QG-U08 (upstream) and OBS-QG-U09 (inherent placeholder limit).

**Regression:** every G2 and G3 case, the G4 classifier cases and the G1 suppression cases give the same results as before (or the corrected ones). The replay is stronger: 54 leaks / 11 quiet files, and all three config mutations fail it. The full history is clean on an unshallow clone (600 commits).

**Recommendation: GO for level L1 on `e55d139`.** Exit criterion 3 holds: no open Critical or Major defect.
- The three open Minor defects (DEF-QG-U12, U13, U14) are each a further, deliberate spelling of a shape whose common forms are now refused.
- They should be fixed in this PR if cheap, or accepted in writing as residual risk with a follow-up, per plan §6.
- I re-test UT-G1-040, UT-G3-050 and UT-G4-026 on request.

## 8. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Test Engineer, level L1 (unit) | Tester session U | Executed as specified; results as recorded above; conditional GO (§7.4) | 2026-10-08 |
| Test Engineer, level L1 (unit), re-test round 1 | Tester session U | Re-executed on `40201a1`; DEF-QG-U01..U06 Closed; DEF-QG-U07..U11 raised; conditional GO (§7.5) | 2026-10-08 |
| Test Engineer, level L1 (unit), re-test round 2 | Tester session U | Re-executed on `e55d139`; DEF-QG-U07..U11 Closed; DEF-QG-U12..U14 (Minor) raised; GO with conditions on the Minors (§7.6) | 2026-10-08 |
| Reviewer | Test Manager | _pending_ | |
