# Bug log

One entry per bug or production error that was fixed, newest first, with the
date it was fixed. The entry is written in the same pull request as the fix,
and its **Status** line is updated when that fix is merged and when it is
deployed. A problem that was found but not fixed goes under **Open** with the
date it was found, and moves into an entry when it is fixed.

`AGENTS.md` keeps the longer reasoning behind each rule. This file answers the
shorter question: what broke, when, and what was done about it.

Entry format:

```
## YYYY-MM-DD — what the user saw, in a few words

- **Symptom:** who saw what, on which screen.
- **Cause:** the file and function at fault, and why.
- **Evidence:** the logs, metrics or reports that showed it.
- **Fix:** what changed.
- **Where:** pull request, commit, files.
- **Checked by:** the test that fails without the fix, and the checks run.
- **Status:** open PR / merged to dev / deployed (with dates).
- **Left open:** anything deliberately not done.
```

## Open

- **2026-10-14 — Two Main Admin screens still send a picked file by
  reference.** The catalogue upload (`features/admin/catalogue`) and the
  spreadsheet import (`features/admin/imports`) do not copy the file at pick
  time. They are used from an office desktop, where the Android failure below
  does not happen, so they were left as they are. Fix if needed: read the file
  with `readPickedFile` from `core/picked-file.ts`, as every other upload
  screen now does.
- **2026-10-14 — Large phone photos are uploaded at full size.** An iPhone sent
  0.87 MB in 121 s and CloudFront timed it out (408). Shrinking photos in the
  browser before upload would help on slow mobile data.
- **2026-10-14 — After a failed claim on Skilling, a retry can file the
  certificate under the old title.** The retry reuses the certificate that
  already uploaded, so if the student changes the badge or the issuer before
  pressing **Submit claim** again, the stored document keeps the first title.
  The claim itself is filed correctly. Found in review of
  [PR #165](https://github.com/darshani8/reep-/pull/165).
- **2026-10-14 — An unreadable answer to a successful upload would be shown
  as a dropped connection.** On the alumni profile, both signature screens and
  the resume photo, the same `catch` covers the upload and reading its JSON
  answer, so a 200 whose body is not JSON would say "the connection dropped"
  when the file had arrived. The API always answers JSON, so this has not been
  seen. Found in review of
  [PR #169](https://github.com/darshani8/reep-/pull/169) and
  [PR #170](https://github.com/darshani8/reep-/pull/170).
- **2026-10-14 — A leave-day email was not delivered.** Sentry
  [REEP-API-3](https://bgs-college-of-engineering-and.sentry.io/issues/REEP-API-3):
  the address bounced on 2026-10-07 and Amazon SES now delivers nothing to it.
  No code fix needed; the office can lift the block on `/admin/mail`.

## 2026-10-16 — A USN typed in lower case was not matched against the roster

- **Symptom:** found while fixing the entry below, then fixed at the owner's
  request. An applicant who typed `1mp25ba033` was not flagged against a
  student holding `1MP25BA033`, and approving them put a second student on the
  roster with the same number in lower case.
- **Cause:** the roster stores USNs upper case (`seed_roster`, the Students
  editor), but `RegisterIn` in `app/routers/registration.py` stored the USN as
  typed. Every "who holds this USN" lookup was case-sensitive: the approval
  guard in `_provision_student`, the checklist in `_checks_for`, the Students
  editor's check in `admin_students.py`, `grant_access` and `seed_roster`. So
  was the unique index on `students.usn`.
- **Evidence:** reproduced in tests. Not seen in production.
- **Fix:** `app/usn.py` holds two helpers. `normalise_usn` strips and
  upper-cases a USN. `usn_is` compares upper case on both sides. The form now
  stores the USN upper case, approval seats the upper-case USN, and every
  lookup above, plus the new correction endpoint, compares upper case. That
  last part also catches a lowercase USN
  written before this fix, both on a pending application and on a student
  record. One side effect: a rule's USN pattern now sees the upper-case USN,
  so an applicant who typed lower case can now match an upper-case pattern
  (and be auto-approved by it), where before they went to manual review.
- **Where:** `app/usn.py`, `app/routers/registration.py`,
  `app/routers/admin_students.py`, `app/grant_access.py`, `app/seed_roster.py`.
- **Checked by:** six new tests in
  `tests/test_registration_usn_correction.py` (the five that touch the
  database fail on the old code). Every test module that touches
  registration, the Students editor, `grant_access` or `seed_roster` passes
  (42 modules, 567 tests).
- **Status:** open PR, the same one as the entry below.
- **Left open:** no migration. Lowercase USNs already on the roster stay as
  they are until somebody edits them on Students; lookups find them either
  way. A unique index on `upper(usn)` would make the database refuse a case
  twin too. It needs production checked for existing twins first, because
  such an index fails to build if one exists.

## 2026-10-16 — An application whose USN another student held could only be rejected

- **Symptom:** on New applications, pressing Approve on Prajwal Gowda Ic's
  application (USN 1MP25BA033) showed "USN 1MP25BA033 already belongs to
  another student. Correct the USN on this application, or reject it as a
  duplicate". The panel said "Fix the application or reject it". Nothing on
  the screen could correct a USN, and nothing said who held the number.
- **Cause:** `_provision_student` in `app/routers/registration.py` refuses a
  USN another student holds (GUARD 3, correct: `students.usn` is unique). But
  the API had no way to edit an application, so the refusal's advice pointed
  at a control that did not exist. The checklist line (`_checks_for_one`)
  named nobody, so the reviewer could not tell a typo from the same person
  applying under a second address, or from another record holding the wrong
  number.
- **Evidence:** the screenshot from the office. Reproduced locally with a
  student holding 1MP25BA033 and a pending application carrying it.
- **Fix:** `PATCH /api/register/{id}` corrects the USN on an application that
  is pending or on hold. It is upper-cased, audited (`CORRECTED`, before and
  after) and refused (409) if another student holds the new number, and it
  answers the row with its checklist recomputed. For a programme-wide reviewer
  the clash line now names the holder ("… already belongs to Prajwal G
  (1mp25ba033@bgscet.ac.in)") and carries `student_id`. The panel draws
  "Open their record" for a session that holds `admin.student_records`. A
  scoped reviewer is still told only that the USN is taken. The panel's USN
  row has a "Correct USN" button. The 409 from Approve still names nobody,
  because `_apply_rule` copies it into the applicant's public
  `decision_reason`.
- **Where:** `app/routers/registration.py`,
  `features/admin/registrations/` (component, template, styles, spec).
- **Checked by:** `tests/test_registration_usn_correction.py` (12 tests,
  which fail without the fix), the whole `tests/test_registration_*.py`
  suite, `test_codebase_guards.py` and `test_phase3_compatibility.py` (203
  passed), the registrations spec (4 tests) and the full `ng test` (269
  passed), `ng build`, and the four web static checks. Also walked in a
  browser against a local stack: the clash line named the holder, a taken
  USN was refused under the box, and a free one turned the line green.
- **Status:** open PR.
- **Left open:** what to do when the holder IS the applicant under another
  address is still the reviewer's call: reject as a duplicate, or change that
  record's address on Students to the applicant's and approve, which then
  reuses the record. There is no one-step "approve onto that record". It would
  attach an existing student's marks to a new address on a reviewer's click,
  and that needs the owner's decision.

## 2026-10-15 — The redesigned student page lost two panels, and "Full record" could lead to a refusal

- **Symptom:** found while checking the Student 360 release for the owner. The
  new `/admin/students/:id` no longer showed a student's mentor history (every
  faculty mentor they have had, with who moved them and why) or their
  promotions and graduations (who made each move and the reason). The old page
  showed both, and it was the only screen that showed the mentor history. And
  on the Mentee Log, a faculty member holding "View student records" for
  another department saw a "Full record" link beside their mentee that opened
  onto "Your 'View student records' capability does not reach this record".
- **Cause:** the approved prototype had no place for the two panels, so the
  rebuild in #177 dropped them, though `GET /admin/students/{id}/360` still
  sends both (`mentor_history`, `semester_history`). The Mentee Log drew the
  link whenever the session held `admin.student_records` anywhere
  (`canOpenRecord` in `mentee-log.component.ts`), while the record page asks
  whether the grant reaches that student. Before today every grant was
  programme-wide, so the two answers agreed.
- **Evidence:** the old and new templates compared side by side; the link
  reproduced on a local copy with a Civil-only grant, `GET /360` answering 403.
- **Fix:** the Overview's Faculty mentor card lists the mentor history again,
  and the Academics tab has a Promotions and graduations table, both from the
  data the page already loads (`mentorSpellRowsOf` and `moveLabelOf` in
  `student-record.ts`). `GET /api/mentor/mentees` now carries
  `record_openable` for each mentee, answered by the record page's own rule
  (`_openable_clause` in `routers/admin_student_record.py`), and the Mentee
  Log draws "Full record" only when it is true.
- **Where:** this pull request; `apps/api-py/app/routers/mentor.py`,
  `apps/web/src/app/features/admin/student-detail/`,
  `features/mentor/mentee-log/`.
- **Checked by:**
  `test_student_record_access.py::test_the_mentee_log_offers_the_full_record_only_where_it_opens`
  fails without the server change; new cases in `student-record.spec.ts`;
  the record, admin, governance and guard test modules, `ng test`, `ng build`,
  `tsc` and the four static web checks. Driven in a browser on a local copy:
  the two panels with a recorded mentor change and promotion, and the link
  hidden with a Civil-only grant and shown, and opening, with a grant on the
  student's department.
- **Status:** [PR #182](https://github.com/darshani8/reep-/pull/182) merged into `dev`
  2026-10-15, released to `main` in
  [PR #184](https://github.com/darshani8/reep-/pull/184) and deployed 2026-10-16
  (Deploy run 132, `3c48939`).

## 2026-10-15 — The office's student page had no resume, skills, leaderboard or KPIs

- **Symptom:** the owner, on `/admin/students/:id`: the student's resume could
  not be seen or downloaded, skills and the leaderboard were missing, there
  were no headline numbers, and nothing on the page let the office choose who
  else could open a student's record.
- **Cause:** the CV from the application is stored as an upload (kind
  `RESUME`, "CV from application", `_move_documents_to_uploads` in
  `routers/registration.py`) but the page listed it only as a Documents row
  with no preview. There was no staff read of a student's leaderboard rank
  (`GET /student/leaderboards` is the caller's own) or built resumes
  (`_own_resume`). The badge read was loaded but drawn as one "11/48" bar.
  The time sheet and English baseline came from reads gated on
  `mentor.mentees`, which the Main Admin does not hold, so they said "not
  readable". And `admin.student_records` granted to a faculty member reached
  only their own mentees, because rule 2 ran underneath it.
- **Evidence:** the owner's report; `GET /admin/students/{id}/360` carried
  none of these panels; the old screen showed the refusals in words.
- **Fix:** the page is rebuilt from the approved prototype
  (`docs/prototypes/student-360/index.html`): candidate column, six KPIs,
  Needs attention, and Overview, Resume, Skills, Leaderboard, Academics,
  Interviews, Time sheet, Documents and Access tabs. New reads on the page's
  own key in `routers/admin_student_record.py`: `/record` (built resumes,
  skills and growth, standing on every board, the ledger fortnight, the
  English baseline, interviews, six weeks of attendance), `/access`, `/files`
  and `/resumes/{id}/pdf` (a download writes an audit row), and
  `/admin/student-records`, the list a faculty member uses to find the
  students they were given. The CV is drawn with pdf.js (4.10.38), never
  inline. On the owner's decision, a SCOPED `admin.student_records` grant now
  opens the students it names, read only, through a new keyword on rule 2's
  gate (`allow_records_grant`, GET reads of this page only); a programme-wide
  grant still reaches only the holder's mentees. The review of the promotion
  found that the Leaderboard tab still named the student's top-ranked
  classmates, with their CGPA on the VTU board, to a faculty member granted
  that one student; the rows are now cut to the students the viewer may open
  (`_openable_clause`, shared with the Student records list).
- **Where:** [PR #177](https://github.com/darshani8/reep-/pull/177) and
  [PR #179](https://github.com/darshani8/reep-/pull/179);
  `apps/api-py/app/policies.py`, `app/routers/admin_student_record.py`,
  `app/routers/admin_student_360.py`,
  `apps/web/src/app/features/admin/student-detail/`,
  `features/admin/student-records/`, `shared/pdf-preview/`.
- **Checked by:** `tests/test_student_record_access.py` (the
  widening, programme-wide grants unchanged, revoked and lapsed grants, no
  mentor endpoint opened, downloads recorded, another student's file refused,
  the list matches the page), and in #179 a test that fails without the
  narrowing; `test_codebase_guards.py`'s delegate test now
  pins the new keyword's default; `student-record.spec.ts`; the full API
  suite, `ng test`, `ng build` and the four static web checks. Driven in a
  browser as the Main Admin and as a faculty member given a department grant,
  including giving and removing access.
- **Status:** #177 and #179 merged into `dev` and released to `main` in
  #180, 2026-10-15; deployed the same day (Deploy run 131, `1e09480`).
  Two non-blocking findings from the review of #180 are fixed in
  [PR #181](https://github.com/darshani8/reep-/pull/181), merged into `dev`
  2026-10-15 and deployed 2026-10-16 with #182 (Deploy run 132,
  `3c48939`): the Student records list offered a faculty
  member's own mentee that the page then refused, and `/access` showed the
  office's grant reasons to faculty viewers. Neither could expose anything
  before the office makes a scoped grant.
- **Left open:** interview reports and transcripts are not opened from this
  page (the Interviews tab lists every sitting with its score); a granted
  faculty member reads them on Interview records only for their own mentees.

## 2026-10-14 — Staff, alumni and resume-photo uploads: the same file-read failure

- **Symptom:** nobody had reported it yet; it was found while fixing the
  student screens below. Six more upload screens sent the picked file by
  reference: the alumni profile resume, faculty **Upskilling**, leave
  attachments, the signature on `/mentor/signature` and on the account page,
  and the resume builder's photo. A file the phone could not read at send time
  failed with "Could not reach the server.", and the two signature screens
  printed the browser's own "Failed to fetch".
- **Cause:** the same as the Skilling entry below. The alumni profile had the
  longest window: the resume is picked first and sent only when **Save** is
  pressed, after the company, designation and dates are filled in.
- **Evidence:** the same mechanism as Skilling, found by reading the code. None
  of these screens reported anything to Sentry before this fix, so there are
  no events to count.
- **Fix:** every one of them now uploads the in-memory copy from
  `core/picked-file.ts`, refuses an unreadable file on the spot, and says the
  connection dropped when no answer comes back (the new shared
  `UPLOAD_DROPPED_MESSAGE`). Both failures go to Sentry as fixed sentences.
  The alumni profile shows "Opening the file…" and holds **Save** until the
  copy is made. A refusal with no message from the server now shows its
  status code instead of blaming the file type (Upskilling, alumni profile,
  resume photo).
- **Where:** [PR #168](https://github.com/darshani8/reep-/pull/168);
  `features/alumni/profile`, `features/mentor/{upskilling,leave,signature}`,
  `features/account`, `features/student/resume/sections/basic.component.ts`,
  `core/picked-file.ts`.
- **Checked by:** six new spec files, three tests each. The main test of each
  screen fails when that screen sends the picker's reference (checked by
  putting the old line back). Type check, 251 unit tests, the four static
  checks and the production build pass.
- **Status:** merged to `dev` on 2026-10-14
  ([PR #168](https://github.com/darshani8/reep-/pull/168)), promoted through
  `stage` ([PR #169](https://github.com/darshani8/reep-/pull/169)) to `main`
  ([PR #170](https://github.com/darshani8/reep-/pull/170)), and deployed to
  production on 2026-10-14 at 15:25 UTC (front end only,
  [deploy run #129](https://github.com/darshani8/reep-/actions/runs/38588969905)).
- **Left open:** the two Main Admin screens, photo downscaling and the
  unreadable-answer case found in review (see **Open**).

## 2026-10-14 — Registration and Documents: the same file-read failure as Skilling

- **Symptom:** on `/register`, applicants on Android pressed Submit and were
  told their connection dropped. On `/student/uploads`, a failed upload said
  "Could not reach the server."
- **Cause:** both screens kept the picked file as a reference, like Skilling.
  On `/register` the CV is the first box and is sent only after about a
  dozen more are filled in, so there is always time for an Android phone to
  lose read access to a file held by Drive, Photos or another app.
  `/student/uploads` sends at pick time, so its window is short, but it
  showed the same misleading sentence.
- **Evidence:** Sentry
  [REEP-WEB-4](https://bgs-college-of-engineering-and.sentry.io/issues/REEP-WEB-4),
  "Registration submit failed: no HTTP response": 9 events from 1 to 7 Oct,
  all from Android (6 Chrome Mobile, 3 Samsung Internet), none from iPhone or
  desktop.
- **Fix:** both screens now copy the file into memory when it is picked
  (`core/picked-file.ts`). An unreadable file is refused immediately with a
  message about the file and reported to Sentry without its name. `/register`
  shows "Opening the file…" and holds Submit until the copy is made. On
  `/student/uploads`, a dropped connection now says so; a refusal with no
  message from the server shows its status code instead of blaming the
  file; and an unreadable file is refused before a Replace deletes anything.
- **Where:** [PR #165](https://github.com/darshani8/reep-/pull/165);
  `features/register/registration.component.{ts,html}`,
  `features/student/uploads/uploads.component.ts`.
- **Checked by:** new `features/register/registration.component.spec.ts` (3
  tests; the key one fails when the form keeps the picker's reference);
  type check, 233 unit tests, the four static checks and the production
  build pass.
- **Status:** merged to `dev` on 2026-10-14
  ([PR #165](https://github.com/darshani8/reep-/pull/165)), promoted through
  `stage` ([PR #166](https://github.com/darshani8/reep-/pull/166)) to `main`
  ([PR #167](https://github.com/darshani8/reep-/pull/167)), and deployed to
  production on 2026-10-14 at 12:45 UTC (front end only,
  [deploy run #128](https://github.com/darshani8/reep-/actions/runs/38566139358)).
- **Left open:** the four staff and alumni upload screens (see **Open**).

## 2026-10-14 — Skilling: certificate uploads failed with "Could not reach the server."

- **Symptom:** students pressing **Submit claim** on `/student/skilling` were
  told "Could not reach the server." and could not claim their skills.
- **Cause:** `skilling.component.ts` kept the picked file as a reference and
  the browser read it again only when the upload was sent, after the student
  had filled in four more fields. On Android, a file held by Google Drive,
  Photos or another app can be unreadable by then (Chrome
  `ERR_UPLOAD_FILE_CHANGED`). The request then failed inside the phone, and
  the screen's catch-all blamed the server.
- **Evidence:** the API logged 138 successful certificate uploads that day and
  one failure, so the failing requests never reached it. The CloudFront log
  showed failing Android uploads sending only headers (136 and 142 bytes),
  then hanging up without the file. The firewall (WAF) blocked nothing on
  that route.
- **Fix:** the new `apps/web/src/app/core/picked-file.ts` copies the file into
  memory the moment it is picked. A file the phone cannot read even then is
  refused immediately with a message telling the student to download it to
  the device first. A dropped connection now says so, keeps the form filled
  in, and a retry does not upload the certificate twice. Both failures are
  reported to Sentry (`reep-web`) as fixed sentences, with nothing from the
  form.
- **Where:** [PR #165](https://github.com/darshani8/reep-/pull/165), commit
  `9c42f89`; `core/picked-file.ts`,
  `features/student/skilling/skilling.component.{ts,html}`.
- **Checked by:** `apps/web/src/app/core/picked-file.spec.ts` (3 of its 4 tests
  fail with the old behaviour); type check, 230 unit tests and the production
  build pass; all five required CI checks green.
- **Status:** merged to `dev` on 2026-10-14
  ([PR #165](https://github.com/darshani8/reep-/pull/165)), promoted through
  `stage` ([PR #166](https://github.com/darshani8/reep-/pull/166)) to `main`
  ([PR #167](https://github.com/darshani8/reep-/pull/167)), and deployed to
  production on 2026-10-14 at 12:45 UTC (front end only,
  [deploy run #128](https://github.com/darshani8/reep-/actions/runs/38566139358)).
- **Left open:** photo downscaling (see **Open**). The registration and
  Documents screens were fixed the same day (entry above).
