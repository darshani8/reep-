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
