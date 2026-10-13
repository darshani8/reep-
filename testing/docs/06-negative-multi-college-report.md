# Negative-scenario test: 10 colleges, different branches

**Date:** 2026-10-13 · **Build:** `main` at `dedc2b8` · **Stack:** local dev (PostgreSQL 16 + pgvector, API on :3300, `ENV=dev`, dev seed)
**Harness:** [`testing/api/negative_multi_college.py`](../api/negative_multi_college.py) · **Raw results:** [`testing/results/api/negative-multi-college-results.json`](../results/api/negative-multi-college-results.json)

## What was run

10 colleges, each with its own set of branches (departments), one course, one specialization and one batch per branch:

| College | Branches |
|---|---|
| C1 Alpha Institute of Technology | CSE, ECE, MECH |
| C2 Beta Engineering College | CIVIL, EEE |
| C3 Gamma College of Engineering | ISE, AIML, CSE |
| C4 Delta School of Management | MBA |
| C5 Epsilon Polytechnic | MECH, AUTO, CHEM |
| C6 Zeta Institute | MCA, CSE |
| C7 Eta Women's College | ECE, BT, EEE, CSE |
| C8 Theta Technical University | AERO, MECH |
| C9 Iota College | CSDS, CSBS |
| C10 Kappa Institute of Science | PHY, MATHS, CHEM |

That is 110 setup calls (all passed), then **166 negative probes**. Each probe has an expected answer; any 5xx counts as a failure. **144 passed and 22 failed.** The 22 failures come from **6 distinct bugs**. No probe returned a 5xx.

## Bugs found, worst first

### BUG-1 (high): a student can be moved into another college's batch, and keeps their old college's mentor

The rule that a mentor must be in the student's own college (B1.5, `_assert_same_college`) is checked only when a mentor is **assigned**. It is not checked when the **student** moves. Three endpoints move a student into another college's batch without any check:

| Endpoint | Got | Expected |
|---|---|---|
| `PUT /api/admin/students/{id}/cohort` (`routers/admin.py:1633`) | 204 | 422 |
| `PATCH /api/admin/students/{id}` with `cohort_id` (`routers/admin_students.py:503`) | 200 | 422 |
| `POST /api/admin/cohorts/{id}/students/bulk` with `move` (`routers/admin_students.py:659`) | 200 | 422 |

Steps to reproduce: approve a C1/CSE applicant, assign them a C1 faculty member, then move them into C2/CIVIL's batch. The database then shows a student seated in college C2 while a C1 faculty account is their mentor. Under rule 2, that faculty member keeps reading the C2 student's marks, attendance and USN. That is exactly what B1.5 exists to refuse.

Possible fix: when a move changes the student's college, either refuse it while the student has a mentor from another college, or release that mentor (with `mentor_history` recording why). Apply the same check to all three endpoints.

### BUG-2 (high): applications are accepted for an archived college or an archived branch

`GET /api/register/hierarchy` correctly lists only ACTIVE colleges, departments, courses and specializations. But `POST /api/register` checks the ids only with `db.get(...)` (`load()` in `_resolve_claim`, `routers/registration.py:1654`) and never looks at `status`. So:

* applying to an archived college returns 201 and the application lands in the review queue;
* applying to an archived department (branch) also returns 201.

Anyone holding an old form, a cached page, or a crafted request can apply to a college the office has closed. Approving that application then seats a student there. Fix: in `load()`, refuse any row whose `status` is not ACTIVE, with the same 422 wording ("Reload the form and choose again").

### BUG-3 (medium): blank names and codes are saved everywhere on the institution tree

Every create endpoint checks `min_length=1` first and **only then** strips the value (`code = body.code.strip().upper()` at `routers/admin.py:245, 760, 944, 1088, 1447`; names are stripped the same way). So `"   "` passes validation and is stored as `""`. PATCH does not strip at all, so `"   "` is stored as-is.

| Probe | Got | Expected |
|---|---|---|
| college: code `"   "` | 201 the first time (row with code `""`), then 409 "A college with code  already exists." | 422 |
| college: name `"   "` | 201, name `""` | 422 |
| college: PATCH name `"   "` | 200, name `"   "` | 422 |
| college: PATCH code `"   "` | 409 "code  already exists" | 422 |
| department: code / name `"  "` | 201, stored `""` | 422 |
| department: PATCH code `"   "` | 409 "department with code ." | 422 |
| course: code `"  "` | 201, code `""` | 422 |
| specialization: code `"   "` | 201, code `""` | 422 |
| batch: code `"   "` | 409 (a `""` batch already exists) | 422 |
| batch: name `"   "`, and PATCH name `"   "` | 201 / 200 | 422 |
| **public `/register`: name `"    "`** | 201, applicant named `""` | 422 |

What users see: blank entries in the public application form's pickers (8 of the 51 colleges served by `/register/hierarchy` had no name after this run), a review queue row with no applicant name, and a confusing 409 that names an empty code. Fix: strip first, then check length, using a validator (`RegisterIn` already does this for `usn`, `phone`, `personal_email` and `linkedin_url`, but not for `name`).

### BUG-4 (medium): a college's email domain list takes any text

`POST /api/admin/colleges` with `email_domains: ["not a domain", "http://x.com/", "@@", "gmail.com"]` returns 201. `normalise_domain` only lowercases and strips `@`. Two problems follow:

* entries like `not a domain` and `http://x.com/` can never match an address, so they do nothing and give no error;
* **`gmail.com` is accepted as a college domain.** Faculty creation and student provisioning both rely on this list. Listing `gmail.com` means any Gmail address passes the "is this a college address" fence for that college.

Fix: refuse anything that is not a bare hostname, and refuse the public-mail domains that `/register` already refuses in its college-email box.

### BUG-5 (low): phone number takes any text

`/register` with `phone="call me maybe"` returns 201. The phone number is copied onto the student profile at approval. Fix: accept only digits, spaces, `+`, `-` and brackets, with a sensible digit count.

### BUG-6 (low, consequence of BUG-3): blank colleges show in the public form

This is the same root cause as BUG-3, listed separately because it is the first thing an applicant would notice: empty options appear in the College and Department pickers on `/register`.

## What held up (passed)

* **Access control:** an anonymous user, a student and a mentor are all refused every admin write (401/403). A forged `reep_session` cookie and an `alg=none` cookie are both refused.
* **Duplicates:** duplicate college, department, course, specialization and batch codes are refused, case-insensitively and with padding. The same department code in two different colleges is allowed, which is correct.
* **Batches:** a batch whose end date is on or before its start date is refused. So are a specialization or course from another college or department, unknown ids, an invalid date, and an unknown degree level.
* **Courses:** a duration of 0, -12 or 121 months is refused.
* **Registration:** missing CV or photo, text renamed to `.pdf`, an empty file, a PDF passed as the photo, HTML passed as a PDF, and an 11 MB CV (the limit is 10 MB) are all refused.
* **Registration across colleges:** a branch, course, specialization or batch from another college is refused, as is a nonexistent college.
* **Registration fields:** a Gmail address as the college email, the same address in both email boxes, an Instagram or `javascript:` LinkedIn URL, and three distinct specializations (the limit is 2) are all refused.
* **Repeat applications:** a duplicate application is refused, including in upper case. Re-applying after a rejection is allowed, which is correct.
* **Review decisions:** a rejection without a reason, or with a whitespace-only reason, is refused. So are an unknown decision, a decision by a student or a mentor, a second approve, a reject after approval, and a hold after approval.
* **Faculty:** an address outside the college's domains, another college's domain, an outside address without a reason, a blank name, a malformed address, a missing or unknown department, and an address already used by a student or mentor account are all refused.
* **Mentors:** assigning another college's faculty member is refused, as are a missing or whitespace-only reason and a student or admin account given as the mentor.
* **Deleting a college with people under it** is refused and names what is still attached. A wrong code, a short code, a missing reason, and a non-admin caller are all refused. `POST` and `DELETE` on `/admin/students` return 405.
* **Leave:** dates that run backwards, or a missing reason, are refused.

## Notes for whoever re-runs this

* **The registration limit is per address:** 20 attempts per 10 minutes. A run from one machine is cut off after 20 `/register` calls, which caused this run's first false failures. The harness now sends a random `X-Forwarded-For` (uvicorn trusts it from 127.0.0.1). In production `FORWARDED_ALLOW_IPS` is set in the Dockerfile, so real client addresses are used. A whole campus behind one NAT still shares one budget of 20.
* The harness leaves its colleges, applications and accounts behind. Use a throwaway database (`AGENTS.md`: "ONE THING AT A TIME TOUCHES ONE DATABASE").
