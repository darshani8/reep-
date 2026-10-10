# 04 — System Testing: Quality Gates release (QG-2026-10)

## 1. Document control

| Field | Value |
|---|---|
| Document ID | REEP-STS-QG-2026-10 |
| Version | 1.1 |
| Status | Executed; re-test round 1 (rt1) on the new head executed — submitted to the Test Manager for review |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 §8 (Test Design / Case Specification), §9 (Test Procedure), §11 (Test Execution Log), §12 (Incident Report); ISTQB® CTFL v4.0 terminology |
| Parent document | [01 — Test Plan](01-test-plan.md) (REEP-TP-QG-2026-10 v1.0), level L3 |
| Author | Tester session S (system level) — independent: wrote none of the code under test |
| Reviewer | Test Manager (orchestrating session) |
| Date | 2026-10-08 |
| Build under test | `claude/clever-meitner-ndvc2e` @ **`a3688f0189c48287f376cf8c165d762a2f8ab8d8`** (PR darshani8/reep-#132 into `dev`) — round 1 |
| Build re-tested (rt1) | same branch @ **`40201a140ba70f8be40d6b016f55ddb828fcaa91`** — after the L1/L2 fix rounds; see §5a |
| Base for comparison | `15a9e7d` (`dev` / `main` before the change) |
| Evidence | [`testing/results/quality-gates-2026-10/system/`](../../results/quality-gates-2026-10/system/) — one file (or PNG set) per case, named by case ID |

### Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-10-08 | Tester session S | Cases designed from the Test Plan §2 before execution |
| 1.0 | 2026-10-08 | Tester session S | All 39 cases executed; log, observations and level summary written |
| 1.1 | 2026-10-08 | Tester session S | Regression pass at system level on the new head `40201a1` at the Test Manager's request: §5a re-test log (16 re-test runs, suffix `-rt1`, plus the new comment-only diff proof ST-040), observations updated in §6, new-head column in §7.3, recommendation updated in §7.5 |

---

## 2. Scope of this level

**Test object.** The whole REEP product built from the head sha, run the way an
operator stands it up and a user meets it: PostgreSQL migrated, round-tripped
and seeded; the FastAPI back end under uvicorn with two workers; the Angular
production build and the SPA served in front of it; every role signing in
through the browser and through the API.

**Questions this level answers** (Test Plan §3, L3):

1. Does REEP behave exactly as before the change, apart from the three intended
   fixes? (REQ-GX-03; the API contract part of REQ-G3-09)
2. Does the stack work end to end for each role? (REQ-GX-04)
3. Seen from the outside, is the repository free of secrets, are the
   engineering documents true to the code, and is the PR's own CI green on the
   tested sha? (REQ-G2-08, REQ-G5-03, REQ-GX-01)

### 2.1 Items tested

| Item | How |
|---|---|
| Database migrations, round trip, seed on a fresh database | ST-001…ST-003 |
| API process (boot, health, OpenAPI) | ST-004, ST-007 |
| Web production build and the SPA served through the dev proxy | ST-005, ST-006 |
| Backend suite, base vs head, per test | ST-008, ST-009 |
| Web unit suite | ST-010 |
| Existing system API suite (`testing/api`) vs its published 2026-09-29 baseline | ST-011 |
| Functional e2e suite (`tests/`, 256 tests, all eight modules) head vs base | ST-012…ST-015, ST-027 |
| Each role end to end, through the API and through the browser | ST-016…ST-023 |
| Negative: wrong role, anonymous, retired session (API and browser) | ST-024…ST-026, ST-028 |
| The three intended behaviour changes | ST-029…ST-032 |
| Every parameter-free GET, five identities, base vs head | ST-033 |
| gitleaks over the full history and the tracked tree | ST-034, ST-035 |
| `docs/engineering/*.md`, `docs/adr/*.md`: links, paths, 17 factual claims | ST-036, ST-037 |
| PR #132's check runs on the tested sha | ST-038 |
| This level's own evidence is free of secrets and session tokens | ST-039 |

### 2.2 Items not tested (and why)

| Not tested | Why |
|---|---|
| Each gate's internals (ruff/mypy rules, async guard, route-audit rules, round-trip refusals, gitleaks rules, preflight exit codes) | Levels L1/L2 (tester sessions U and I). This level sees them only from the outside (ST-002, ST-008, ST-034…ST-038) |
| The rehearsal-cancellation fix *as an internal exception path* | Not observable from outside in this bed: upstream Bedrock answers `ValidationException` before the shutdown arrives, on both trees (ST-031). Covered by the new `tests/test_interview_rehearsal.py::TestTheBackstopAtRuntime` (3 tests, passed in ST-008) |
| The local engine's 10 s connect bound reached by a live session | A session never reaches the Ollama client here: `faster_whisper`/Piper are not installed in the bed (ST-032). Covered by `tests/test_interview_local.py::TestEngineSelection` (new, passed in ST-008) |
| The production build *served as static files* | The plan's environment names the production build; the brief asks for `ng serve`. The build was produced and its budget checked (ST-005); the browser cases ran against the **dev server** (§3). `apps/web` is byte-identical between base and head, so this does not affect the comparison |
| Performance, load, AWS, ruleset enforcement on GitHub | Out of scope (Test Plan §3.1) |
| Python 3.14 / PostgreSQL 17 | Not in the bed; CI on the same sha ran them and is cited (ST-038) |

---

## 3. Test environment actually used

| Component | Version / configuration |
|---|---|
| Host | Cloud container, Linux 6.18.44, 4 vCPU, 15 GB RAM |
| PostgreSQL | **16.15** (Ubuntu) + pgvector **0.6.0**, `localhost:5433`, `max_connections=300`, trust auth, role `reep` (published dev password) |
| Python | **3.13.16**, venv `apps/api-py/.venv` from `requirements-dev.txt` (FastAPI 0.141.1, SQLAlchemy 2.0.52, Alembic 1.19.1, Pydantic 2.13.4, uvicorn 0.52.3, psycopg 3.3.4, pytest 9.1.1, ruff 0.16.10, mypy 2.4.0) |
| Node / npm | **22.22.3** (tarball sha256-verified against nodejs.org `SHASUMS256.txt`), npm 10.9.8; Angular CLI 22.1.3, `@angular/core` 22.1.1 |
| gitleaks | **8.30.0**, tarball sha256 `79a3ab57…a66e`, equal to `GITLEAKS_SHA256` in `.github/workflows/secret-scan.yml` (`sha256sum --check` OK) |
| Browser | Pre-installed Chromium **141.0.7390.37** (`/opt/pw-browsers/chromium-1194`), driven by the repository's Playwright **1.63.0** |
| `testing/` tooling | scratch venv from `testing/requirements.txt` (pytest 9.1.1, requests 2.34.2, Schemathesis 4.28.0) |
| Environment variables (all runs) | `ENV=dev`, `AUTH_SECRET=ci-secret-not-used-outside-ci-0123456789abcdef`, `REEP_REQUIRE_DB=1`, `DATABASE_URL=postgresql+psycopg://reep:…@localhost:5433/<db>` |
| Base tree | `git worktree add --detach /tmp/base 15a9e7d`, same venv, its own databases |

**Processes and ports**

| Port | What |
|---|---|
| 3300 | HEAD API, `uvicorn app.main:app --port 3300 --workers 2` (db `reep_sys`; later restarted on the e2e and UI databases below, and once on BASE for the e2e comparison — each restart recorded in its case) |
| 3301 | BASE API, 2 workers, db `reep_base_api` (comparison cases) |
| 3302 | HEAD API under `python -O` (ST-030) |
| 3303–3308 | Short-lived single-worker APIs for the interview cases (ST-029, ST-031, ST-032), on their own databases |
| 4200 | **Angular dev server** `npx ng serve --port 4200`, `proxy.conf.json` → `:3300` |

**Databases — one per concurrent run (AGENTS.md):** `reep_sys` (head live API),
`reep_pt_head` / `reep_pt_base` (the two pytest runs, run at the same time on
different databases), `reep_base_api` (base live API), `reep_ws_head` /
`reep_ws_base` (interview cases), `reep_e2e_head` / `reep_e2e_base` (re-run of
23 e2e cases), `reep_e2e_head2` / `reep_e2e_base2` (the two full e2e runs),
`reep_ui` (browser walks). Each: `alembic upgrade head` then `python -m app.seed`.

**Deviations from the plan / brief**

| # | Deviation | Effect and mitigation |
|---|---|---|
| D1 | Python 3.13, PostgreSQL 16 (CI: 3.14, 17) | As planned (§5). CI's result on the same sha is cited (ST-038) |
| D2 | The e2e suite pins Playwright 1.63, whose Chromium build 1243 is not installed; `playwright install` is forbidden | Ran the **repository's own `playwright.config.ts`** through a wrapper kept in the scratch directory (never committed) that only sets `launchOptions.executablePath` to the pre-installed Chromium 141 and drops the HTML reporter. Tests, reporter and case files unmodified |
| D3 | The container's clone was **shallow** (219 commits) | A gitleaks "full history" scan on it covered 140 commits; the clone was unshallowed (`git fetch --unshallow`, all remote branches) and the scan repeated (ST-034). The first attempt is not counted |
| D4 | SPA served by `ng serve` (dev server), not the static production build | See §2.2 |
| D5 | The first full e2e run shared `reep_sys` with the 110 load-test students that ST-011 needs | 11 admin-roster cases failed because of it; both trees were then re-run on fresh databases (ST-027, ST-012…015). Recorded as a test-design lesson, not a product defect |

---

## 4. Test case specification

All cases: **Executed by** Tester session S, **date** 2026-10-08. Technique
codes: **E2E** end-to-end scenario, **CMP** comparison (base vs head),
**NEG** negative, **REG** regression (existing suite as input), **STA** static
review against the code.

| ID | Requirement(s) | Title | Technique | Priority |
|---|---|---|---|---|
| ST-001 | GX-04, GX-03 | Fresh database migrates to a single head and `alembic check` is clean | E2E | P1 |
| ST-002 | G4-02, G4-05, GX-04 | Migration round trip on the system database leaves it untouched | E2E | P1 |
| ST-003 | GX-04 | Dev seed applies and is idempotent | E2E | P2 |
| ST-004 | GX-04, GX-03 | API boots with two workers; `/health`, `/docs`, `/openapi.json` answer | E2E | P1 |
| ST-005 | GX-03 | `npm ci` + `ng build` (production) passes the bundle budget | REG | P1 |
| ST-006 | GX-04 | SPA served and `/api` proxied to the API | E2E | P2 |
| ST-007 | G3-09, GX-03 | OpenAPI document of head equals base | CMP | P1 |
| ST-008 | GX-03 | Full backend suite on head, own database | REG | P1 |
| ST-009 | GX-03 | Full backend suite on base; every base pass passes on head | REG, CMP | P1 |
| ST-010 | GX-03 | Web unit suite on head | REG | P1 |
| ST-011 | GX-03 | `testing/api` suite vs its 2026-09-29 baseline | REG, CMP | P1 |
| ST-012 | GX-04, GX-03 | e2e module 01 (authentication), head vs base | REG, CMP | P1 |
| ST-013 | GX-04, GX-03 | e2e student modules 02–04, head vs base | REG, CMP | P1 |
| ST-014 | GX-04, GX-03 | e2e faculty/alumni module 05, head vs base | REG, CMP | P1 |
| ST-015 | GX-04, GX-03 | e2e admin modules 06–08, head vs base | REG, CMP | P1 |
| ST-016 | GX-04 | Student through the API: sign in, home, ledger, jobs, sign out | E2E | P1 |
| ST-017 | GX-04 | Mentor through the API: mentee listed, note added and listed, sign out | E2E | P1 |
| ST-018 | GX-04 | Alumni through the API: profile not yet created, jobs, sign out | E2E | P1 |
| ST-019 | GX-04 | Admin through the API: home counts, roster, governance, sign out | E2E | P1 |
| ST-020 | GX-04 | Student in the browser | E2E | P1 |
| ST-021 | GX-04 | Mentor in the browser, including adding a meeting note | E2E | P1 |
| ST-022 | GX-04 | Alumni in the browser: first-login create-profile form | E2E | P1 |
| ST-023 | GX-04 | Admin in the browser: home with live counts, roster, governance | E2E | P1 |
| ST-024 | GX-04, GX-03 | Wrong role is refused (403) | NEG | P1 |
| ST-025 | GX-04, GX-03 | Anonymous and forged cookie are refused (401); public stays public | NEG | P1 |
| ST-026 | GX-04, GX-03 | Single-device rule through the API: `401` + `X-Reep-Session: retired` | NEG | P1 |
| ST-027 | GX-03 | Classification of the first e2e run's failures (re-run head vs base) | CMP | P1 |
| ST-028 | GX-04 | Single-device rule in the browser: the first device is told why | NEG, E2E | P2 |
| ST-029 | GX-03 | Interview status for every role, base vs head (rehearsal flag) | CMP | P1 |
| ST-030 | GX-03 | Time-ledger boot check (`RuntimeError`) and ledger behaviour, base vs head | CMP, E2E | P1 |
| ST-031 | GX-03 | Rehearsal socket open while the API is shut down, base vs head | CMP | P2 |
| ST-032 | GX-03 | Local engine connect timeout: configuration only, no endpoint change | CMP, STA | P2 |
| ST-033 | GX-03, G3-09 | Every parameter-free GET × 5 identities, base vs head | CMP | P1 |
| ST-034 | G2-08 | gitleaks over the full history | E2E | P1 |
| ST-035 | G2-08 | gitleaks over the tracked tree | E2E | P1 |
| ST-036 | G5-03 | Every relative link and repository path in the engineering docs and ADRs resolves | STA | P2 |
| ST-037 | G5-03 | 17 factual claims in the docs checked against the code | STA | P1 |
| ST-038 | GX-01, GX-03 | PR #132's check runs on the tested sha | STA | P1 |
| ST-039 | G2-06 (this level's own artefacts) | Evidence folder carries no secret or session token | NEG | P2 |

### 4.1 Cases in full

Unless a case says otherwise: preconditions are the environment of §3 with the
head API on :3300 (db `reep_sys`) and the SPA on :4200; test data is the dev
seed and the four seeded accounts published in AGENTS.md; "base" means the same
procedure on the worktree at `15a9e7d` on a database of its own.

**ST-001 — Fresh database migrates to a single head**
- Requirements: GX-04, GX-03 · Objective: the schema of the head builds from nothing.
- Preconditions: empty database `reep_sys`. Test data: none.
- Steps: 1. `alembic upgrade head`. 2. `alembic heads`; `alembic current`. 3. `alembic check`.
- Expected: exit 0; one head equal to current; "No new upgrade operations detected".
- Actual: exit 0; head = current = `f4a2c9e7b1d3`; `alembic check` clean.
- Verdict: **Pass** · Evidence: `ST-001-alembic-upgrade-head.txt`

**ST-002 — Migration round trip on the system database**
- Requirements: G4-02, G4-05 (system half), GX-04 · Objective: the round trip runs against a real migrated database, reads it only, and leaves nothing behind.
- Preconditions: ST-001. Test data: none.
- Steps: 1. `python ../../tools/ci/check_migration_roundtrip.py` from `apps/api-py`. 2. List databases.
- Expected: exit 0; the target is reported read-only; a scratch database is created, walked and dropped; catalogues identical; `alembic check` clean; no scratch database left.
- Actual: exit 0 in 21 s; floor `9b2d47f0ce15`; 3 segments; 90 of 92 downgrades exercised (2 refuse on purpose); 2118 catalogue lines identical; only `reep_sys` and system databases remain.
- Verdict: **Pass** · Evidence: `ST-002-migration-roundtrip.txt`

**ST-003 — Dev seed applies and is idempotent**
- Requirements: GX-04 · Objective: the seeded accounts and data the other cases need exist.
- Preconditions: ST-002. Steps: 1. `python -m app.seed`. 2. List users and roles. 3. Run the seed again; count users.
- Expected: exit 0; the four seeded accounts with roles STUDENT, MENTOR, ALUMNI, ADMIN; a second run adds nothing.
- Actual: as expected; 4 users before and after the second run.
- Verdict: **Pass** · Evidence: `ST-003-seed.txt`

**ST-004 — API boots with two workers**
- Requirements: GX-04, GX-03 · Steps: 1. `uvicorn app.main:app --port 3300 --workers 2` (ENV=dev). 2. `GET /health`. 3. `GET /docs`, `GET /openapi.json`.
- Expected: both workers reach "Application startup complete"; 200 `{"status":"ok"}`; 200, 200.
- Actual: both workers started (mail and archive notices only, expected in dev); 200 `{"status":"ok","service":"reep-api-py"}` with the security headers; 200, 200.
- Verdict: **Pass** · Evidence: `ST-004-api-boot-health.txt`

**ST-005 — Web install and production build**
- Requirements: GX-03 · Steps: 1. `npm ci` in `apps/web` (Node 22.22.3). 2. `npx ng build`. 3. Compare the initial total with the `initial` budget in `angular.json`. 4. `git diff --stat 15a9e7d a3688f0 -- apps/web`.
- Expected: exit 0; no budget warning or error; (4) for information.
- Actual: build complete in 42 s, exit 0; initial total **228.22 kB** against warning 250 kB / error 400 kB, no warnings; `apps/web` is **unchanged** by the PR.
- Verdict: **Pass** · Evidence: `ST-005-web-npm-ci-ng-build.txt`

**ST-006 — SPA served and `/api` proxied**
- Requirements: GX-04 · Steps: 1. `npx ng serve --port 4200`. 2. `GET /`. 3. `GET /api/auth/me` through :4200. 4. `GET /student` (SPA route).
- Expected: 200 with the app shell; 401 JSON from the API (proves the proxy); 200 (SPA fallback).
- Actual: 200, `<title>REEP · Student</title>`, `<app-root>`; 401 `{"detail":"Sign in required."}`; 200.
- Verdict: **Pass** · Evidence: `ST-006-spa-serve-and-proxy.txt`

**ST-007 — OpenAPI document, head vs base**
- Requirements: G3-09, GX-03 · Objective: the gates changed no route.
- Steps: 1. In each tree, `app.openapi()` → `json.dumps(sort_keys=True, indent=1)`. 2. `diff`. 3. Compare with the live `/openapi.json` of the head API. 4. Inventory.
- Expected: identical paths, methods, parameters, status codes and schemas.
- Actual: both documents 37 764 lines, **identical sha256** `70c88fd0…6b1f`, empty diff; live document equals the generated one; 318 paths, 370 operations (192 GET, 121 POST, 18 PUT, 17 PATCH, 22 DELETE), 394 schemas.
- Verdict: **Pass** · Evidence: `ST-007-openapi-base-vs-head.txt`

**ST-008 — Backend suite on head**
- Requirements: GX-03 · Preconditions: own fresh migrated+seeded db `reep_pt_head` (never the live API's). Steps: `pytest -o addopts="" -q -rs --junitxml=…`.
- Expected: all pass; skips only for absent optional providers. (Brief: "about 2,057 collected, 3 skipped".)
- Actual: **2075 passed, 3 skipped** (2078 collected) in 4 min 56 s, exit 0. Skips: Nova test skipped because `AWS_REGION` is set in the bed; two embedding tests (no provider). 2078 vs the brief's ~2057: the 21 extra are `tests/test_migration_roundtrip_guard.py`, which the brief's estimate evidently predates — not an issue.
- Verdict: **Pass** · Evidence: `ST-008-backend-suite-head.txt`, `ST-008-junit-head.xml.gz`

**ST-009 — Backend suite on base; per-test comparison**
- Requirements: GX-03 · Preconditions: own db `reep_pt_base`. Steps: 1. same command in the base worktree. 2. Compare the two junit reports test by test.
- Expected: every test that passes on base passes on head; nothing present on base is absent on head.
- Actual: base **1981 passed, 3 skipped** (1984). Passed-on-base-not-on-head: **0**. Absent on head: **0**. New on head: 94 (40 async-blocking guard, 21 round-trip guard, 17 route audit, 10 reversibility, 3 rehearsal backstop, 2 release gate, 1 local engine).
- Verdict: **Pass** · Evidence: `ST-009-backend-suite-base-and-compare.txt`, `ST-009-junit-base.xml.gz`

**ST-010 — Web unit suite**
- Requirements: GX-03 · Steps: `npx ng test --watch=false`.
- Expected: all pass. Actual: **32 files, 226 tests passed**, exit 0. Base not re-run: `apps/web` identical (ST-005).
- Verdict: **Pass** · Evidence: `ST-010-web-unit-suite.txt`

**ST-011 — `testing/api` suite vs the 2026-09-29 baseline**
- Requirements: GX-03 · Preconditions: head API on `reep_sys`; load accounts created with `testing/tools/create_load_users.py --count 100` (ENV=dev; CSV written to scratch, not the repository).
- Steps: 1. `REEP_API=http://127.0.0.1:3300 pytest testing/api --junitxml=…`. 2. Compare per test with `testing/results/api/junit.xml`.
- Expected: no test changes verdict.
- Actual: **281 passed, 2 skipped** (283), identical to the baseline's 281/2; same test set; **0 verdicts changed**; the same two documented skips.
- Verdict: **Pass** · Evidence: `ST-011-api-suite-vs-baseline.txt`, `ST-011-api-junit-head.xml.gz`

**ST-012 … ST-015 — Functional e2e suite, head vs base (one procedure, four cases by module)**
- Requirements: GX-04, GX-03 · Objective: every user-facing case that passes before the change passes after it.
- Preconditions: for each side its own fresh migrated+seeded db (`reep_e2e_head2`, `reep_e2e_base2`); API on :3300 with 2 workers from that side's tree; SPA :4200; nothing else signed in; one Playwright worker (D2).
- Steps: 1. `npx playwright test` (all 256 tests) on base. 2. The same on head. 3. Compare per case. 4. Repeat every head-only failure 5× on head and on base, then on head with a single API worker.
- Expected: no case fails on head that passes reliably on base. A failure also seen on base is an observation, not a defect of this change.
- Actual (base | head, Passed / Failed+Timed out, manual-only cases excluded):

  | Case | Module(s) | Base | Head | Head-only failures | Verdict |
  |---|---|---|---|---|---|
  | ST-012 | 01 Authentication and access | 36 / 1 | 34 / 3 | TC-025, TC-038 | Pass |
  | ST-013 | 02 Registration · 03 Student home · 04 Student tools | 74 / 1 | 74 / 1 | none | Pass |
  | ST-014 | 05 Faculty and alumni | 30 / 0 | 30 / 0 | none | Pass |
  | ST-015 | 06 Admin people · 07 Admin operations · 08 Admin setup | 105 / 9 | 103 / 11 | TC-524, TC-631 | Pass |
  | **Total** | | **245 / 11** | **241 / 15** | 4 | |

  The four head-only failures, repeated 5× in isolation: TC-025 1/5 pass on **both**; TC-038 2/5 head, 1/5 base; TC-524 3/5 on **both**; TC-631 0/5 on **both**. With **one** API worker on head: TC-025, TC-038 and TC-524 pass 5/5. They are intermittent, identical on base, and caused by per-process state across two uvicorn workers (OBS-QG-S03); TC-631 depends on data earlier cases create (OBS-QG-S04). The 11 cases failing on both sides are pre-existing (OBS-QG-S04).
- Verdict: **Pass** (ST-012, ST-013, ST-014, ST-015) · Evidence: `ST-012-015-e2e-suite-head-vs-base.txt`, `ST-012-015-manual-test-results-{HEAD,BASE}-fresh-db.csv`, `ST-012-015-e2e-console-{HEAD,BASE}-fresh-db.log.gz`

**ST-016 — Student through the API**
- Requirements: GX-04 · Steps: 1. `POST /api/auth/login` (student). 2. `GET` `/auth/me`, `/student/dashboard`, `/student/programme`, `/student/ledger`, `/student/ledger/history?days=14`, `/student/timesheet`, `/student/jobs`, `/student/mentor-meetings`, `/interview/status`, `/student/swoc`. 3. `POST /api/auth/logout`. 4. `GET /api/auth/me`.
- Expected: 200, cookie `reep_session`; each 200 with its documented shape; 200; 401.
- Actual: as expected — dashboard shows USN `1BG24MBA001`, stage EXCEL_ADVANCED; ledger 23.5/24 h "0.5 h to reconcile"; 3 jobs; interview `rehearsal:false`; logout 200; then 401.
- Verdict: **Pass** · Evidence: `ST-016-api-walk-student.txt`

**ST-017 — Mentor through the API, including a write**
- Requirements: GX-04 · Steps: 1. Login (mentor). 2. `GET /api/mentor/mentees`. 3. `POST /api/mentor/students/{id}/notes` `{note_text, title}`. 4. `GET …/notes`. 5. Logout; `GET /api/auth/me`.
- Expected: 1 mentee (the seeded student); 201; the note is listed; 401 after logout.
- Actual: 1 mentee; **201**; 2 notes, the new one present; interview status says "Mock interviews are a student feature."; 401 after logout.
- Verdict: **Pass** · Evidence: `ST-017-api-walk-mentor.txt`

**ST-018 — Alumni through the API**
- Requirements: GX-04 · Steps: login; `GET /api/alumni/profile`; `GET /api/alumni/jobs`; logout.
- Expected: `created:false` on a fresh database; jobs list without match %; 401 after logout.
- Actual: `"created":false`; 3 postings; logout then 401.
- Verdict: **Pass** · Evidence: `ST-018-api-walk-alumni.txt`

**ST-019 — Admin through the API**
- Requirements: GX-04 · Steps: login; the five home queues (`/register/pending`, `/leaves/pending`, `/admin/unassigned-students`, `/mentor/offers/pending`, `/admin/governance/review`); `/admin/students`; `/admin/governance/grants`, `/catalogue`; `/admin/mentor-load`; `/interview/status`; logout.
- Expected: 200 each; `X-Reep-Scope: programme` on narrowed lists; `rehearsal:true`; 401 after logout.
- Actual: all 200; counts 1 / 0 / 0 / 0 / 0; scope header `programme` where documented; `rehearsal:true`; 401 after logout.
- Verdict: **Pass** · Evidence: `ST-019-api-walk-admin.txt`

**ST-020 — Student in the browser**
- Requirements: GX-04 · Preconditions: head API (2 workers) on fresh `reep_ui`; SPA :4200. Steps: open `/login`; choose Student; fill email and password; Sign in; open `/student`, `/student/time-log`, `/student/jobs`; Sign out; open `/student` again. Screenshot each step.
- Expected: lands on `/student` "Welcome back, Test"; each screen has its heading and no alert; signed out to `/login`; the protected route redirects to `/login?next=%2Fstudent`; no page error; no API ≥400 except the 401 after sign-out.
- Actual: as expected (headings "Welcome back, Test", "Time Allocation Ledger", "Jobs"); page errors none; only `401 GET /api/auth/me` after sign-out.
- Verdict: **Pass** · Evidence: `ST-020-browser-walk-student.txt`, `ST-020-01…08-*.png`

**ST-021 — Mentor in the browser, adding a meeting note**
- Requirements: GX-04 · Steps: sign in under Faculty; open `/mentor/mentees`; choose Test Student; type a heading and note; Save note; sign out; open `/mentor/mentees`.
- Expected: Mentee Log lists Test Student; the note appears in the list; sign-out redirects.
- Actual: lands on `/mentor/notebook` (the faculty home); Mentee Log lists "Test Student 1BG24MBA001 · Sem 2"; the saved note is visible; sign-out and redirect as expected; no page errors.
- Verdict: **Pass** · Evidence: `ST-021-browser-walk-mentor.txt`, `ST-021-01…08-*.png`

**ST-022 — Alumni in the browser, first login**
- Requirements: GX-04 · Steps: sign in under Alumni; screenshot `/alumni`; sign out.
- Expected: the first-login create-profile form (company required, resume required, "Create my profile").
- Actual: "My Profile — Welcome back, Test Alumnus! Set up your alumni profile…", Company*, Upload current resume*, "Create my profile" (screenshot ST-022-04).
- Verdict: **Pass** · Evidence: `ST-022-browser-walk-alumni.txt`, `ST-022-01…06-*.png`

**ST-023 — Admin in the browser**
- Requirements: GX-04 · Steps: open `/login`; Main Admin door; sign in; `/admin`, `/admin/students`, `/admin/governance`; sign out.
- Expected: "What do you want to do?" with the five live counts matching ST-019; roster and governance load.
- Actual: home shows 1 new application, 0 leave, 0 unassigned, 0 offers, 0 access requests (matches the API); "Students & batches"; "Who can do what"; no page errors.
- Verdict: **Pass** · Evidence: `ST-023-browser-walk-admin.txt`, `ST-023-01…08-*.png`

**ST-024 — Wrong role is refused**
- Requirements: GX-04, GX-03 · Steps: as student call 5 admin/mentor GETs; as mentor 2 admin GETs; as alumni 3 GETs of other roles; as student `POST /api/admin/students/bulk` with an empty and a valid body. Base: the same POSTs.
- Expected: 403 with a sentence for each GET; the valid POST 403; base identical.
- Actual: every GET **403** with the capability/role sentence; POST with `{}` → 422 (validation precedes the gate), valid body → **403**; base gives 422 and 403 identically (ST-033).
- Verdict: **Pass** · Evidence: `ST-024-negative-wrong-role-403.txt`

**ST-025 — Anonymous and forged cookie**
- Requirements: GX-04, GX-03 · Steps: 8 protected GETs and 1 POST with no cookie; 1 GET with `reep_session=garbage`; 3 public GETs.
- Expected: 401 "Sign in required." each; public 200.
- Actual: as expected.
- Verdict: **Pass** · Evidence: `ST-025-negative-anonymous-401.txt`

**ST-026 — Single-device rule through the API**
- Requirements: GX-04, GX-03 · Steps: sign in as mentor with jar A; `GET /api/auth/me` (A); sign in with jar B; A `GET /api/mentor/mentees`; B the same; A five more requests; a request with no cookie.
- Expected: A 200, then **401 + `X-Reep-Session: retired`**; B 200; no retired header without a cookie.
- Actual: A 401 with `x-reep-session: retired` on every one of 6 requests (both workers); B 200; no-cookie 401 without the header.
- Verdict: **Pass** · Evidence: `ST-026-single-device-retired.txt`

**ST-027 — Classification of the first e2e run's failures**
- Requirements: GX-03 · Objective: decide whether any failure of the first head run is a defect of this change.
- Preconditions: first run on `reep_sys` after ST-011 had added 110 load-test students (D5).
- Steps: 1. Read each failure. 2. Re-run the 23 failing cases on a fresh head db, then on a fresh base db, same API config. 3. Feed the remaining head-only ones into ST-012…015's repetition.
- Expected: each failure explained as environment or pre-existing, or raised as a defect.
- Actual: first run 233 passed / 23 failed. 11 failed because the admin grid virtualises rows and the seeded student is not rendered among 111 (my test data). Re-run: head 11/12, base 11/12, the same set except TC-524 and TC-631, which flip sides and were shown intermittent on both (ST-012…015).
- Verdict: **Pass** · Evidence: `ST-027-e2e-failure-classification.txt`, `ST-027-manual-test-results-*.csv`, `ST-027-e2e-console-HEAD-first-run.log.gz`

**ST-028 — Single-device rule in the browser**
- Requirements: GX-04 · Steps: browser context A signs in as the student; context B signs in as the student; A opens `/student/time-log`; wait 65 s; A navigates 3 times; B reloads.
- Expected: A ends on `/login?…&signedOut=elsewhere` with the explanation; B stays signed in. Per `app/security.py` (lines 38–51) revocation reaches the *other* worker within `auth_revocation_cache_seconds` (60 s).
- Actual: A's first navigation was served by the other worker and still loaded the ledger (screenshot ST-028-03); after 65 s all three navigations land on `/login?next=%2Fstudent%2Ftime-log&signedOut=elsewhere` with "You were signed out because this account was signed in on another device…"; B still signed in. Behaviour as designed and unchanged by the PR (`app/security.py` has no diff); the immediate-sign-out wording elsewhere is OBS-QG-S03.
- Verdict: **Pass** · Evidence: `ST-028-browser-retired-session.txt`, `ST-028-0*-*.png`

**ST-029 — Interview status, base vs head**
- Requirements: GX-03 · Preconditions: base :3304 / head :3303 on fresh dbs. Steps: `GET /api/interview/status` as student, admin, mentor, alumni, anonymous on each; diff.
- Expected: identical; admin `rehearsal:true`, student `rehearsal:false`, staff refused with the sentence, anonymous 401.
- Actual: identical bodies on both sides, as expected.
- Verdict: **Pass** · Evidence: `ST-029-interview-status-base-vs-head.txt`

**ST-030 — Time-ledger boot check and ledger behaviour**
- Requirements: GX-03 · Steps: 1. Read the diff (assert → `raise RuntimeError`). 2. Boot the head API under `python -O` (:3302) and `GET /health`; import the module under `-O`. 3. Run the same 14-step ledger walk (over-capacity cell, slot over capacity, non-half-hour, 23 h, submit short, 24 h, submit, edit after submit, copy-yesterday, locked day, tomorrow, history, weekly strip) against base :3301 and head :3300 on a day inside the edit window; diff.
- Expected: boots normally and under `-O` with `DAY_CAPACITY_HALVES = 48`; identical step-by-step results.
- Actual: boots under `-O`, 200; 48; ledger walk **identical** on base and head (422/422/422/200/409/200/200/409/404/409/422/200/200).
- Verdict: **Pass** · Evidence: `ST-030-ledger-boot-check-and-behaviour.txt`

**ST-031 — Rehearsal socket open during shutdown**
- Requirements: GX-03 · Steps (each tree, own db, 1 worker): start the API; open `/api/interview` as the Main Admin; after 2 s send SIGTERM; measure exit; read the client close and the server log.
- Expected: the server exits cleanly; the client gets a close; no new error on head versus base.
- Actual: both: exit 5.0 s after SIGTERM, client close **1012**, "Application shutdown complete", same counts (2 tracebacks from Bedrock's `ValidationException`, environment). The internal `CancelledError` path the fix targets is not reached here (§2.2).
- Verdict: **Pass** · Evidence: `ST-031-interview-rehearsal-shutdown.txt`

**ST-032 — Local engine connect timeout**
- Requirements: GX-03 · Steps: 1. Read the diff. 2. Note ST-007. 3. `INTERVIEW_ENGINE=local` on base :3308 / head :3307; status for 5 identities; diff. 4. Student socket on each.
- Expected: a client-construction change only; identical status; identical socket outcome.
- Actual: diff confined to `httpx.Timeout(None, connect=10.0)` and a Windows-only `type: ignore`; OpenAPI identical; status identical; both sockets close **4013** "Interview consent required".
- Verdict: **Pass** · Evidence: `ST-032-local-engine-connect-timeout.txt`

**ST-033 — Every parameter-free GET, base vs head**
- Requirements: GX-03, G3-09 · Steps: for each of 131 GET paths without path or required query parameters, as student, mentor, alumni, admin and anonymous, call base :3301 and head :3300; compare status, JSON shape (types and keys to 4 levels), `X-Reep-*` header names and the `X-Reep-Scope` value.
- Expected: 655 comparisons, 0 differences other than test data.
- Actual: **655 comparisons, 1 difference**: `student GET /api/student/mentor-meetings` `meetings[0].location` null vs str — the note ST-017 added (no location) on the head database is newest; database rows shown. Test data, not product.
- Verdict: **Pass** · Evidence: `ST-033-get-surface-base-vs-head.txt`

**ST-034 — gitleaks over the full history**
- Requirements: G2-08 · Preconditions: clone unshallowed (D3). Steps: A. `gitleaks git . --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --no-banner --exit-code 1`; B. the same with `--log-opts=--all`.
- Expected: "no leaks found", exit 0.
- Actual: A and B: 1277 commits scanned, **no leaks found**, exit 0.
- Verdict: **Pass** · Evidence: `ST-034-gitleaks-full-history.txt`

**ST-035 — gitleaks over the tracked tree**
- Requirements: G2-08 · Steps: `git archive HEAD` into a clean directory (1325 files); from its root `gitleaks dir . …`; for information, the working tree in place.
- Expected: no leaks, exit 0.
- Actual: tracked tree **no leaks**, exit 0. Side findings: (a) scanning the same tree by absolute path reports the 4 allowlisted values, because the `[[allowlists]] paths` are `^`-anchored (OBS-QG-S02); (b) the in-place working tree reports 136 JWTs, all in git-ignored `test-results/…/traces` written by the e2e run — none tracked, none in this level's evidence.
- Verdict: **Pass** · Evidence: `ST-035-gitleaks-tracked-tree.txt`

**ST-036 — Links and paths in the engineering docs and ADRs**
- Requirements: G5-03 · Steps: script over 12 files: every relative markdown link resolves; every backticked file/dir path exists (repo root, `apps/api-py/`, or the file's folder).
- Expected: 0 broken.
- Actual: 41/41 links resolve; 160 path mentions, 1 "missing" = `/openapi.json`, an HTTP path served by the API (ST-004), not a file.
- Verdict: **Pass** · Evidence: `ST-036-docs-links-and-paths.txt`

**ST-037 — Factual claims in the docs**
- Requirements: G5-03 · Steps: 17 claims (step names and order, job names, required checks per ruleset, ruff/mypy configuration, the 300-operation floor, `FOREIGN_HANDLER_PACKAGES`, the 10 named gates, the six exception lists and their sizes 13/30/61, the floor and 90/92, the async `KNOWN` list, preflight's six checks, the gitleaks pin) each read in the code.
- Expected: each claim true.
- Actual: **17/17 true**. (`api-checklist.md`: 13 `KNOWN_NO_RESPONSE_MODEL`, 30 `BOUNDED`, 61 `KNOWN_UNPAGINATED` — exact.)
- Verdict: **Pass** · Evidence: `ST-037-docs-claims-vs-code.txt`

**ST-038 — PR #132's check runs on the tested sha**
- Requirements: GX-01, GX-03 · Steps: read the PR and its check runs through the GitHub API.
- Expected: head sha = the tested sha; every required check concluded success.
- Actual: head `a3688f0…`; API (FastAPI + Postgres), Rule 1, API (dependency completeness), Web (Angular), Infra (CDK synth guards), Secrets (gitleaks), Branch policy — **all success**; `review` skipped (draft PR); mergeable_state clean.
- Verdict: **Pass** · Evidence: `ST-038-pr132-ci-checks.txt`

**ST-039 — This level's evidence carries no secret or session token**
- Requirements: G2-06 (applied to this level's artefacts) · Steps: 1. `gitleaks dir` over the evidence folder and this document. 2. grep for JWT shapes and `reep_session=` values, including inside the `.gz` files.
- Expected: no leaks; only the deliberate `reep_session=garbage` (ST-025) and redacted cookie placeholders.
- Actual: see ST-039 evidence (run immediately before commit).
- Verdict: **Pass** · Evidence: `ST-039-evidence-hygiene.txt`

---

## 5. Test execution log

| ID | Date/time (UTC) 2026-10-08 | Verdict | Evidence file | Notes |
|---|---|---|---|---|
| ST-001 | 08:35:54 | Pass | ST-001-alembic-upgrade-head.txt | |
| ST-002 | 08:36:05 | Pass | ST-002-migration-roundtrip.txt | 21 s |
| ST-003 | 08:36:31 | Pass | ST-003-seed.txt | |
| ST-004 | 08:36:49 | Pass | ST-004-api-boot-health.txt | |
| ST-008 | 08:37–08:42 | Pass | ST-008-backend-suite-head.txt | ran beside ST-009 on another database |
| ST-009 | 08:37–08:42 | Pass | ST-009-backend-suite-base-and-compare.txt | |
| ST-007 | 08:37 | Pass | ST-007-openapi-base-vs-head.txt | |
| ST-005 | 08:38 | Pass | ST-005-web-npm-ci-ng-build.txt | |
| ST-006 | 08:39:29 | Pass | ST-006-spa-serve-and-proxy.txt | |
| ST-016 | 08:39 | Pass | ST-016-api-walk-student.txt | |
| ST-017 | 08:40 | Pass | ST-017-api-walk-mentor.txt | wrote one note on `reep_sys` |
| ST-018 | 08:40 | Pass | ST-018-api-walk-alumni.txt | |
| ST-019 | 08:40 | Pass | ST-019-api-walk-admin.txt | |
| ST-024 | 08:40:26 | Pass | ST-024-negative-wrong-role-403.txt | |
| ST-025 | 08:40:58 | Pass | ST-025-negative-anonymous-401.txt | |
| ST-026 | 08:41:06 | Pass | ST-026-single-device-retired.txt | |
| ST-033 | 08:41:51 | Pass | ST-033-get-surface-base-vs-head.txt | 1 difference = ST-017's note |
| ST-030 | 08:42:55 | Pass | ST-030-ledger-boot-check-and-behaviour.txt | |
| ST-011 | 08:43 | Pass | ST-011-api-suite-vs-baseline.txt | added 110 load accounts to `reep_sys` |
| ST-010 | 08:44 | Pass | ST-010-web-unit-suite.txt | |
| ST-027 | 08:45–09:08 | Pass | ST-027-e2e-failure-classification.txt | first run + re-run of 23 cases |
| ST-034 | 08:47–08:48 | Pass | ST-034-gitleaks-full-history.txt | after unshallow (D3) |
| ST-036 | 08:49 | Pass | ST-036-docs-links-and-paths.txt | |
| ST-037 | 08:49 | Pass | ST-037-docs-claims-vs-code.txt | |
| ST-038 | 08:50 | Pass | ST-038-pr132-ci-checks.txt | |
| ST-035 | 08:50:05 | Pass | ST-035-gitleaks-tracked-tree.txt | OBS-QG-S02 |
| ST-031 | 08:52 | Pass | ST-031-interview-rehearsal-shutdown.txt | |
| ST-029 | 08:54 | Pass | ST-029-interview-status-base-vs-head.txt | |
| ST-032 | 08:55 | Pass | ST-032-local-engine-connect-timeout.txt | |
| ST-012 | 09:08–09:32 (+ repeats to 09:45) | Pass | ST-012-015-e2e-suite-head-vs-base.txt | OBS-QG-S03 |
| ST-013 | same run | Pass | ST-012-015-e2e-suite-head-vs-base.txt | OBS-QG-S04 |
| ST-014 | same run | Pass | ST-012-015-e2e-suite-head-vs-base.txt | |
| ST-015 | same run | Pass | ST-012-015-e2e-suite-head-vs-base.txt | OBS-QG-S03, S04 |
| ST-020 | 09:47 | Pass | ST-020-browser-walk-student.txt | |
| ST-021 | 09:48 | Pass | ST-021-browser-walk-mentor.txt | |
| ST-022 | 09:47 | Pass | ST-022-browser-walk-alumni.txt | |
| ST-023 | 09:47 | Pass | ST-023-browser-walk-admin.txt | |
| ST-028 | 09:50 | Pass | ST-028-browser-retired-session.txt | OBS-QG-S03 |
| ST-039 | before commit | Pass | ST-039-evidence-hygiene.txt | |

---

## 5a. Re-test log — round 1 (rt1) on the new head `40201a1`

**Why.** After round 1 the L1/L2 fix rounds changed the gate code (route
audit, async guard, §34/§39 guards, `.gitleaks.toml`/`.gitleaksignore`,
`secret-scan.yml`, `preflight.sh`, the round trip, the reversibility
classifier, `release_gate.py`), the PR template and docs, and made 93
comment-only edits in `apps/api-py/app/`. No product code was meant to change.
This regression pass confirms that from the outside.

**Build.** `40201a140ba70f8be40d6b016f55ddb828fcaa91` (all 7 required checks
green, ST-038-rt1). Diff from `a3688f0`: 47 files. Unchanged:
`apps/web`, `tests/`, `playwright.config.ts`, `test-management/`,
`apps/api-py/requirements*.txt`, `apps/api-py/migrations/versions/`. Checked
out as worktree `/tmp/new`. Every run used its own fresh migrated and seeded
database (`reep_rt1_pt`, `reep_rt1_sys`, `reep_rt1_e2e`, `reep_631_base`,
`reep_631_new`). The API ran from the new head with **one worker** unless the
row says otherwise.

**New case ST-040 — the fix rounds changed no product code** (REQ-GX-03;
technique STA/CMP; priority P1)
- Objective: `git diff a3688f0 40201a1 -- apps/api-py/app apps/web` contains
  only comment changes.
- Steps:
  1. For each changed file, take its Python token stream with `COMMENT`/`NL`
     tokens removed, and its `ast.dump()`, at both commits.
  2. Require both to be equal.
  3. Negative control: run the same script over `15a9e7d..a3688f0`, which
     did change code.
- Expected: every file comment-only; the control flags the round-1 code
  changes.
- Actual: 18 files changed (+93/−93), all **COMMENT-ONLY** (tokens and AST
  equal); `apps/web` has no diff. The control reports `NON-COMMENT CHANGE
  FOUND` for `interview_local.py`, `models/time_ledger.py`,
  `routers/interview.py` and 53 others.
- Verdict: **Pass**. Evidence: `ST-040-rt1-comment-only-diff.txt`.

| Re-test | Date/time (UTC) | Requirement(s) | Verdict | Evidence | Result on `40201a1` |
|---|---|---|---|---|---|
| ST-040 (new) | 09:58 | GX-03 | Pass | ST-040-rt1-comment-only-diff.txt | 18/18 files comment-only; negative control fires |
| ST-007-rt1 | 09:59 | G3-09, GX-03 | Pass | ST-007-rt1-openapi-new-head-vs-base.txt | OpenAPI **byte-identical** to base (sha256 `70c88fd0…6b1f`), generated and live |
| ST-033-rt1 | 10:00 | GX-03, G3-09 | Pass | ST-033-rt1-get-surface-new-head-vs-base.txt | 655 comparisons, 1 difference: `/api/admin/audit` empty on the fresh head db at probe time (the probe's own exports write the rows later). Same item shape once rows exist — test data |
| ST-016…019-rt1 | 10:00 | GX-04 | Pass | ST-01{6,7,8,9}-rt1-api-walk-*.txt | All four roles: every call 200, note write 201 and listed, alumni `created:false`, 401 after logout |
| ST-024…026-rt1 | 10:01 | GX-04, GX-03 | Pass | ST-024-026-rt1-negative-cases.txt | 403 / 401 / `X-Reep-Session: retired` as in round 1. Same script on base gives **identical** output |
| ST-023-rt1 | 10:01 | GX-04 | Pass | ST-023-rt1-browser-walk-admin.txt, ST-023-rt1-*.png | Admin browser walk; home counts 1/0/0/0/0 match the API; no page errors |
| ST-008/009-rt1 | 09:59–10:04 | GX-03 | Pass | ST-008-009-rt1-backend-suite.txt | **2156 passed, 3 skipped** (2159). Base passes lost: **0**. Round-1 tests lost: **0**. 175 new vs base, 81 new vs round 1 |
| ST-034-rt1 | 10:02 | G2-08 | Pass | ST-034-rt1-gitleaks-full-history.txt | Clone **unshallowed**. Head history: 746 commits (602 non-merge); 1564 reachable from all refs. New config + `--ignore-gitleaks-allow`: all refs, 1292 commits scanned, no leaks; head's ancestry only, 594 commits, no leaks |
| ST-035-rt1 | 10:03 | G2-08 | Pass | ST-035-rt1-gitleaks-tracked-tree.txt | Tracked tree (1328 files), new config, `--ignore-gitleaks-allow`, from the root: no leaks. By absolute path: the 4 known findings, now documented in `.gitleaks.toml` §"RUN GITLEAKS FROM THE REPOSITORY ROOT" (OBS-QG-S02) |
| ST-036-rt1 | 10:04 | G5-03 | Pass | ST-036-rt1-docs-links-and-paths.txt | 41/41 links resolve; 163 path mentions, all exist (one is the HTTP path `/openapi.json`) |
| ST-037-rt1 | 10:05 | G5-03 | Pass | ST-037-rt1-docs-claims-vs-code.txt | 18/18 claims true: 10 round-1 claims re-checked, 8 new ones (CODEOWNERS and rulesets, `--ignore-gitleaks-allow` in CI, "four findings" measured, `_may_see_raw_response`, `route_audit_shapes.py`, "human — no gate" rows) |
| ST-038-rt1 | 10:06 | GX-01, GX-03 | Pass | ST-038-rt1-pr132-ci-checks.txt | sha `40201a1`: all 7 required checks **success**; `review` skipped (draft) |
| ST-011-rt1 | 10:07 | GX-03 | Pass | ST-011-rt1-api-suite.txt | `testing/api` against a live new-head API (2 workers): 281 passed, 2 skipped. **0** verdicts changed vs round 1 and vs the 2026-09-29 baseline |
| ST-012…015-rt1 | 10:02–10:14 | GX-04, GX-03 | Pass | ST-012-015-rt1-e2e-new-head-1-worker.txt, CSV, console | Full suite, **one API worker**: **246 passed / 10 failed** (round 1: head 241/15, base 245/11). All four S03 cases now pass, as do TC-022 and TC-252. The 10 failures are the pre-existing state-dependent set. TC-631 passes 3/3 on brand-new databases on **both** base and new head (OBS-QG-S04) |
| ST-039-rt1 | before commit | G2-06 | Pass | ST-039-rt1-evidence-hygiene.txt | Evidence and this document scanned with the **new** config and `--ignore-gitleaks-allow`: no leaks; no session tokens |

**Re-test summary.** 16 re-test runs (15 re-executed cases or case groups,
plus the new ST-040): 16 Pass, 0 Fail, 0 Blocked. New defects: 0.

---

## 6. Defects and observations

**Defects (DEF-QG-SNN): none.** No difference between expected and actual
result was found that is attributable to the change under test.

### OBS-QG-S01 — PR #132's description quotes counts the code no longer has (Minor, P3)
- Requirement: none of §2 (the PR body is not a shipped document; REQ-G5-03 covers `docs/engineering` and `docs/adr`, which are exact — ST-037).
- Build: a3688f0. What: the PR body says "65 unpaged lists are recorded", `tests/test_route_audit.py` "(16)" and `tests/test_async_blocking_guard.py` "(26)". At the head `KNOWN_UNPAGINATED` has **61** entries (plus 30 `BOUNDED`), the junit report has **17** route-audit tests and **40** async-guard tests (ST-009), and the docs say 61 correctly.
- Why only an observation: no reader acts on the PR body after merge, and the shipped documents are right. Suggest the description be refreshed before merge so the record of the PR is accurate.
- **rt1:** triaged by the Test Manager, who will refresh the description at the end. Still open on `40201a1`.

### OBS-QG-S02 — `.gitleaks.toml` path allowlists only match when gitleaks scans from the repository root (Minor, P3)
- Requirement: REQ-G2-05 (system-level consequence). Build: a3688f0. Environment: gitleaks 8.30.0.
- Steps: `git archive HEAD | tar -x -C <dir>`; from the repository root run `gitleaks dir <dir> --config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact`.
- Expected (a developer's reasonable expectation): the same result as scanning the tree from its root. Actual: **4 findings** (`apps/api-py/tests/test_backup_database.py:59,100`, `apps/api-py/app/voice_platform/api/calls.py:219`, `infra/cdk/import-map.json:80`), because the `[[allowlists]] paths` are anchored `^apps/…`, `^infra/…` and gitleaks matches them against the path as given on the command line. `cd <dir> && gitleaks dir .` reports 0.
- Impact: none on CI (it scans `.` from the checkout root, ST-038) or `preflight.sh`; a developer scanning a sub-path or an absolute path gets false positives. Evidence: `ST-035-gitleaks-tracked-tree.txt`. Suspected component: `.gitleaks.toml` lines ~326, 338, 350 (anchoring). Not a defect of the gate's purpose.
- **rt1:** same as unit-level OBS-QG-U02. At `40201a1` the behaviour is unchanged (4 findings by absolute path, 0 from the root; ST-035-rt1), and it is now **documented**: `.gitleaks.toml` has a "RUN GITLEAKS FROM THE REPOSITORY ROOT" block, and `docs/engineering/quality-gates.md` §2 says so, with the "four findings" count measured true (ST-037-rt1 N5). Closed as documented.

### OBS-QG-S03 — Session revocation and the reset limiter are per process, so with `--workers 2` a retired session works for up to 60 s and four e2e cases are intermittent (pre-existing, Minor)
- Requirement: REQ-GX-04 context. Build: a3688f0 **and** 15a9e7d (identical). Environment: uvicorn `--workers 2`, which is how `testing/README.md` starts the API.
- Steps: ST-028 (two browser contexts), and e2e TC-022/TC-025/TC-524/TC-038 repeated 5× (ST-012…015).
- Actual: the first request after a second sign-in can be served by the worker whose `token_version` cache is still warm, and is answered normally (ST-028 screenshot 03); after `auth_revocation_cache_seconds` (60 s) every request is refused with `X-Reep-Session: retired`. TC-025 passes 1/5, TC-524 3/5, TC-038 1–2/5 **on both base and head** with 2 workers, and 5/5 on head with 1 worker.
- This is the behaviour `app/security.py` documents ("best-effort logout … takes UP TO auth_revocation_cache_seconds to reach the other workers"), and the PR does not touch it. It is recorded because (a) AGENTS.md's "signing in on a phone drops the laptop on its next request" is only true within one process, and (b) the e2e suite assumes immediacy while the documented way to run the stack uses two workers. Owner decision, not a defect of this change.
- **rt1 (confirmation):** with **one** API worker, the full e2e run on `40201a1` passes all four cases (TC-022, TC-025, TC-038, TC-524) and TC-252 as well (ST-012…015-rt1). The Test Manager is raising it with the owner as a question, not a blocker.

### OBS-QG-S04 — Eleven e2e cases fail on a fresh database on both base and head (pre-existing)
- Build: 15a9e7d and a3688f0, identical. Cases: TC-022 (also S03), TC-252, TC-506, TC-507, TC-510, TC-513, TC-532, TC-539, TC-651, TC-715, TC-735; and TC-631 fails 5/5 when run alone on both sides (it needs an offer year written by earlier cases).
- Errors (abridged): TC-252 "Not ranked on this board yet" card text; TC-506/507/510/539 30 s timeouts choosing a batch; TC-513 expects "Master of Business Administration - Finance · 2024-26 Section B"; TC-532 save confirmation not shown; TC-651 import wizard summary; TC-715/735 `TypeError: Cannot read properties of undefined (reading 'student_id')` in the test's own setup.
- Reading: most expect data (a "2024-26 Section B" batch, offers, imports) that another case or an earlier run creates, i.e. order/state dependence in the suite rather than product failures; not analysed further because every one fails identically on the base. Evidence: `ST-012-015-e2e-suite-head-vs-base.txt`. Suggested owner: the e2e suite's maintainers.
- **rt1:** TC-631 is now decided. On brand-new databases it passes 3/3 on **both** base and new head. In every full run, earlier admin cases that did not finish (the timed-out batch actions TC-506/507/510/539) left the seeded student in an "E2E" batch. The seeded batch then has no offers, the Period select is disabled, and `selectOption` waits until the timeout. Observed on base too. On `40201a1` with one worker, 10 cases remain: TC-506, 507, 510, 513, 532, 539, 631, 651, 715, 735. All pre-existing.

### OBS-QG-S05 — The test bed's clone is shallow (test-bed note)
- A shallow clone (219 commits) makes "full history" scans silently partial (140 commits scanned, "no leaks found"). CI is not affected (`secret-scan.yml` checks out with `fetch-depth: 0`). Other testers running gitleaks over history in this container should `git fetch --unshallow` first. Evidence: `ST-034-gitleaks-full-history.txt`.

---

## 7. Level summary

### 7.1 Counts

| Round | Build | Planned | Executed | Passed | Failed | Blocked | Not run |
|---|---|---|---|---|---|---|---|
| 1 | `a3688f0` | 39 | 39 | 39 | 0 | 0 | 0 |
| rt1 (§5a) | `40201a1` | 16 (15 re-tests + new ST-040) | 16 | 16 | 0 | 0 | 0 |

**Pass rate: 100 %** in both rounds. Defects: 0. Observations: 5 (S01–S05).
S03 and S04 are pre-existing on the base. S02 is now documented.

### 7.2 Requirements covered by this level

| Requirement | Cases (round 1) | Re-tested on `40201a1` |
|---|---|---|
| REQ-GX-03 (no unintended behaviour change) | ST-001, ST-004, ST-005, ST-007, ST-008, ST-009, ST-010, ST-011, ST-012…ST-015, ST-024…ST-027, ST-029…ST-033, ST-038 | ST-040, ST-007, ST-008/009, ST-011, ST-012…015, ST-024…026, ST-033, ST-038 |
| REQ-GX-04 (end to end for every role) | ST-001…ST-004, ST-006, ST-012…ST-026, ST-028 | ST-012…015, ST-016…019, ST-023, ST-024…026 |
| REQ-G3-09 (OpenAPI of branch equals base) | ST-007, ST-033 | ST-007, ST-033 |
| REQ-G2-08 (history clean under the shipped configuration) | ST-034, ST-035 | ST-034, ST-035 (new config, `--ignore-gitleaks-allow`) |
| REQ-G5-03 (docs consistent with code; links resolve) | ST-036, ST-037 | ST-036, ST-037 |
| REQ-GX-01 (five jobs + standalone checks agree; seen as CI results) | ST-037 (C03, C04), ST-038 | ST-037, ST-038 |
| REQ-G4-02, REQ-G4-05 (system half) | ST-002 | — (only the round-trip tool changed; covered at L1/L2, and by CI on `40201a1`) |
| REQ-G2-06 (applied to this level's artefacts) | ST-039 | ST-039 |

### 7.3 Regression comparison

| Suite | Base 15a9e7d | Head a3688f0 (round 1) | New head 40201a1 (rt1) | Delta new head vs base |
|---|---|---|---|---|
| Product code diff | — | 3 intended fixes + typing/lint edits | vs a3688f0: **comment-only** in 18 files (ST-040) | none beyond round 1 |
| Backend pytest (own fresh db each) | 1981 passed, 3 skipped (1984) | 2075 passed, 3 skipped (2078) | **2156 passed, 3 skipped (2159)** | +175 gate tests; **0** base passes lost; 0 tests removed |
| Web unit (`ng test`) | identical sources | 226/226 passed (32 files) | identical sources | none |
| `ng build` (production) | identical sources | pass, initial 228.22 kB < 250 kB | identical sources | none |
| `testing/api` (system API suite) | 281 passed, 2 skipped (published baseline 2026-09-29) | 281 passed, 2 skipped | 281 passed, 2 skipped | **0** verdicts changed |
| e2e (`tests/`, 256 tests, fresh db) | 245 passed, 11 failed (2 workers) | 241 passed, 15 failed (2 workers) | **246 passed, 10 failed (1 worker)** | 0 attributable to the change. The 10 failures are the pre-existing state-dependent set (OBS-QG-S04). With 1 worker the S03 cases pass |
| OpenAPI document | 370 operations | byte-identical | **byte-identical** | none |
| GET surface (131 paths × 5 identities) | — | 0 product differences | 0 product differences | none |
| Negative cases (403 / 401 / retired) | identical script output | as expected | identical to base | none |
| Time-ledger walk (14 steps) | — | identical | not re-run (comment-only diff) | none |
| Interview status (5 identities, 2 engines) | — | identical | not re-run (comment-only diff) | none |

### 7.4 Residual risks

1. **Python 3.14 / PostgreSQL 17 not exercised here.** Mitigated by CI on
   both shas (ST-038, ST-038-rt1: all 7 required checks green).
2. **The two interview fixes are not observable from outside in this bed**
   (ST-031, ST-032). Their effect rests on the new unit tests, which passed in
   both rounds.
3. **Browser cases ran against the Angular dev server**, not the static
   production build. The build itself passed (ST-005), and the front end is
   unchanged by the PR.
4. **The e2e suite is not a fully clean signal** (OBS-QG-S03/S04). With one
   API worker it is down to 10 pre-existing state-dependent failures. A real
   regression in those 10 cases would be masked; it was ruled out by base
   comparison and by running TC-631 on fresh databases.
5. **The secret gate can be silenced by the PR that it scans** (documented
   residual risk OBS-QG-I01, from L2). Outside this level's scope; noted
   because the docs now state it (ST-037-rt1 N1–N3).

### 7.5 Recommendation

**GO** at system level for `40201a140ba70f8be40d6b016f55ddb828fcaa91`, with no
conditions on this change.
- The fix rounds changed no product code (ST-040), and the API contract is
  byte-identical to the base.
- Every regression suite holds on the new head with no base pass lost.
- Every role works end to end.
- Optional before merge: refresh the PR description's counts (OBS-QG-S01).
- Owner follow-ups that do not block this PR: OBS-QG-S03/S04 (pre-existing on
  the base) and the L2 residual risk on the secret gate.

---

## 8. Sign-off

| Role | Name | Verdict | Date |
|---|---|---|---|
| Test Engineer — System (L3) | Tester session S | Round 1 (`a3688f0`): 39/39 Pass, 0 defects, 5 observations. Re-test rt1 (`40201a1`): 16/16 Pass, 0 defects. Recommend GO | 2026-10-08 |
| Reviewer | Test Manager | _pending_ | |
