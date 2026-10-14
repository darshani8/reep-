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

- **2026-10-14 — The other upload screens can fail the same way as Skilling.**
  `/register`, `/student/uploads`, the alumni resume, faculty upskilling,
  leave attachments and the signature upload still send the picked file by
  reference, so an Android phone can fail to read it at send time. Sentry
  [REEP-WEB-4](https://bgs-college-of-engineering-and.sentry.io/issues/REEP-WEB-4)
  shows 9 registration network failures from 1 to 7 Oct, all on Android.
  Fix: reuse `apps/web/src/app/core/picked-file.ts` on each screen.
- **2026-10-14 — Large phone photos are uploaded at full size.** An iPhone sent
  0.87 MB in 121 s and CloudFront timed it out (408). Shrinking photos in the
  browser before upload would help on slow mobile data.
- **2026-10-14 — A leave-day email was not delivered.** Sentry
  [REEP-API-3](https://bgs-college-of-engineering-and.sentry.io/issues/REEP-API-3):
  the address bounced on 2026-10-07 and Amazon SES now delivers nothing to it.
  No code fix needed; the office can lift the block on `/admin/mail`.

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
- **Status:** PR open (draft) into `dev` on 2026-10-14; not yet merged or
  deployed.
- **Left open:** the other upload screens and photo downscaling (see **Open**).
