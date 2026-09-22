# Manual test cases: Authentication

| Suite | Authentication (sign-in and password reset) |
|---|---|
| Application under test | REEP web app, `/login` screen (`apps/web/src/app/features/login/`) |
| Environment | Local development: `npx ng serve` on http://localhost:4200, API on port 3300 with `ENV=dev`, dev seed applied |
| Automated twin | [`tests/auth-sync.spec.ts`](../tests/auth-sync.spec.ts) |
| Results | `manual-test-results.csv` at the repository root, written by every `npm run test:e2e` |

## How the manual and automated suites stay linked

1. **Every case has a permanent ID, `TC-NNN`.** An ID is never reused or
   renumbered, even when its case is retired.
2. **The automated test for a case carries the ID as a tag in its `test()`
   title**, for example `... @TC-002`. To run one case:
   `npx playwright test --grep @TC-002`.
3. **The automated test's `test.step()` titles are the steps below, word for
   word**, and every assertion is labelled with the expected result it checks
   (`TC-001 ER-4: ...`). A failure in the HTML report or the CSV names the
   step and the expected result that failed.
4. **`manual-test-results.csv` has one row per case.** A case with no
   automated test is listed as `Not automated`, and a Playwright test whose
   title has no `@TC-NNN` tag, or names a case missing from this file, fails
   the run.
5. **A change to a case's steps or expected results changes its automated test
   in the same commit, and the other way round.**

## Traceability matrix

| ID | Title | Priority | Type | Automated test | Manual-only checks |
|---|---|---|---|---|---|
| TC-001 | Successful login with valid credentials | P1 | Functional, positive | `tests/auth-sync.spec.ts` `@TC-001` | None |
| TC-002 | Login is refused for an invalid password | P1 | Functional, negative | `tests/auth-sync.spec.ts` `@TC-002` | None |
| TC-003 | Password reset request | P2 | Functional, positive | `tests/auth-sync.spec.ts` `@TC-003` | ER-4 (the email itself) |

## Setup for every case

These steps prepare the environment once. Each case's own pre-conditions
list what must be true before that case starts.

1. Start the database: `docker compose up -d`.
2. From `apps/api-py`, apply migrations and seed the dev accounts:
   `python -m alembic upgrade head`, then `python -m app.seed`.
3. Start the API with a development `ENV`:
   `python -m uvicorn app.main:app --port 3300`.
4. From `apps/web`, start the web app: `npx ng serve`.

The dev seed creates the accounts used below. The seed refuses to run when
`ENV=prod`, so these passwords never exist on a production server.

---

## TC-001 — Successful login with valid credentials

| Field | Value |
|---|---|
| ID | TC-001 |
| Module | Authentication: password sign-in |
| Priority | P1 |
| Type | Functional, positive |
| Automated test | `tests/auth-sync.spec.ts`, title tagged `@TC-001` |

### Pre-conditions

1. The web app and the API are running as described in "Setup for every
   case". The API's `ENV` is a development one (`dev`), because password
   sign-in is offered only on dev/CI servers or where `PASSWORD_LOGIN=true`.
2. The dev seed has been applied, so the student account in the test data
   exists.
3. The browser has no REEP session: use a fresh private window, or sign out
   first.
4. The account has had fewer than 10 failed sign-in attempts in the last 15
   minutes. After 10, the API pauses password sign-in for that account. A
   successful sign-in resets the count.

### Test data

| Field | Value |
|---|---|
| Portal | Student |
| Email | `student@bgscet.ac.in` |
| Password | `student123` |
| Name on record | Test Student |

### Steps

1. Open the sign-in page at `/login`.
2. Under "Choose your portal", select Student.
3. Enter the email address in the "Institutional email or USN" field.
4. Enter the password in the "Password" field.
5. Click Sign in.
6. Reload the page.

### Expected results

| # | After step | Expected result |
|---|---|---|
| ER-1 | 1 | The "Welcome back" sign-in card is shown, with the "Institutional email or USN" field, the "Password" field and a Sign in button. |
| ER-2 | 2 | The Student portal card is marked as selected. |
| ER-3 | 4 | The password is masked, not shown as readable text. |
| ER-4 | 5 | The browser leaves the sign-in page for the student home, `/student`, which greets the student by first name: "Welcome back, Test". |
| ER-5 | 6 | The student is still signed in after the reload: the page stays on `/student` and shows "Welcome back, Test" again. |

### Post-conditions

The account now holds one live session. REEP allows one device per account,
so any other browser signed in as this student is signed out on its next
request.

---

## TC-002 — Login is refused for an invalid password

| Field | Value |
|---|---|
| ID | TC-002 |
| Module | Authentication: password sign-in |
| Priority | P1 |
| Type | Functional, negative |
| Automated test | `tests/auth-sync.spec.ts`, title tagged `@TC-002` |

### Pre-conditions

1. The web app and the API are running as described in "Setup for every
   case", with a development `ENV`.
2. The dev seed has been applied, so the email in the test data belongs to a
   real account. The case checks a wrong password for an existing account.
3. The browser has no REEP session: use a fresh private window, or sign out
   first.
4. The account has had fewer than 10 failed sign-in attempts in the last 15
   minutes. Past that, the API answers "Too many failed attempts…" instead of
   the message in ER-1.

### Test data

| Field | Value |
|---|---|
| Portal | Student |
| Email | `student@bgscet.ac.in` |
| Password | `wrong-password` (any value other than the account's real password) |

### Steps

1. Open the sign-in page at `/login`.
2. Under "Choose your portal", select Student.
3. Enter the email address in the "Institutional email or USN" field.
4. Enter the invalid password in the "Password" field.
5. Click Sign in.
6. Open `/student` directly in the same tab.

### Expected results

| # | After step | Expected result |
|---|---|---|
| ER-1 | 5 | An error message appears on the card: "That email and password did not match an account. Check both, or use Continue with Google." It does not say which of the two was wrong. |
| ER-2 | 5 | The page stays on the sign-in page, `/login`. |
| ER-3 | 5 | The password field is emptied, and the email address stays filled in. |
| ER-4 | 6 | No session was created: the app sends the browser back to the sign-in page, and the address bar reads `/login?next=%2Fstudent`. |

### Post-conditions

One failed attempt is counted against the account for 15 minutes. A
successful sign-in (TC-001) clears the count.

---

## TC-003 — Password reset request

| Field | Value |
|---|---|
| ID | TC-003 |
| Module | Authentication: forgotten password |
| Priority | P2 |
| Type | Functional, positive |
| Automated test | `tests/auth-sync.spec.ts`, title tagged `@TC-003` |

### Pre-conditions

1. The web app and the API are running as described in "Setup for every
   case", with a development `ENV`. The "Forgot password?" link sits under
   the password field, which is shown only when the server offers password
   sign-in.
2. The address has had fewer than 3 reset requests in the last hour. The API
   allows 3 per address per hour, and 100 in total. Past that, it answers
   "Too many reset requests. Please wait an hour and try again."
3. For ER-4 only: access to the API's console output (a development server
   with no mail transport), or to the account's mailbox.

### Test data

| Field | Value |
|---|---|
| Email | `student@bgscet.ac.in` (the dev seed's student account) |

The automated run enters a new, unregistered address on every run instead,
of the form `tc-003-<run id>@example.invalid`. That keeps repeated runs
under the 3-per-hour limit. It checks the same thing: the page shows the same
sentence for every address, registered or not (ER-3). The only difference a
registered address makes is the email itself, and ER-4 is checked by hand.

### Steps

1. Open the sign-in page at `/login`.
2. Click "Forgot password?".
3. Enter the email address in the "Email address" field.
4. Click Send reset link.

### Expected results

| # | After step | Expected result |
|---|---|---|
| ER-1 | 2 | A reset form opens below the card, with an "Email address" field and a Send reset link button. The button is disabled while the field is empty. |
| ER-2 | 3 | The Send reset link button becomes enabled. |
| ER-3 | 4 | The form is replaced by exactly this sentence: "If that address belongs to a REEP account, we've emailed it a link to reset your password - or to set one up, if you have not yet." The page stays on `/login`. |
| ER-4 | 4 | **Manual only.** An email with the subject "Reset your REEP password" is sent to the address. It contains a single-use link to `/reset?token=…` that expires in 60 minutes. A development server with no mail transport (`SES_FROM_ADDRESS` blank) logs the email to the API console as `MAIL (no transport configured) to=student@bgscet.ac.in subject='Reset your REEP password'`. |

### Post-conditions

The account's password is unchanged until the emailed link is used. A new
reset request replaces any earlier link that has not been used yet.
