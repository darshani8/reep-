# Authentication and access

| Field | Value |
|---|---|
| Screens | `/login`, sign-out, each role's landing page, route guards, `/account`, `/account/password`, `/activate`, `/reset` |
| Automated tests | [`tests/auth-sync.spec.ts`](../../tests/auth-sync.spec.ts) |
| ID range | TC-001 to TC-099 |

Setup, the seeded accounts and the rules that link these cases to their
automated tests are in [the index](../manual-test-cases.md).

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

1. The web app and the API are running as described in "Setup" in the
   index, and the API's `ENV` is a development one (`dev`). The dev seed
   that creates the test account refuses to run on `ENV=prod`, and a
   development `ENV` always offers password sign-in. Elsewhere the password
   form also appears when `PASSWORD_LOGIN=true`, or when that setting is
   blank and some account holds a real password, so a visible password form
   does not by itself mean the server is a development one.
2. The dev seed has been applied, so the student account in the test data
   exists.
3. The browser has no REEP session and no remembered sign-in: use a fresh
   private window, or sign out and clear this site's local storage (the
   `reep.login.id` and `reep.login.portal` keys that "Remember me" sets).
   Signing out alone leaves those keys, and the sign-in page then opens on
   the remembered portal with the ID already filled in.
4. The account has had fewer than 10 failed sign-in attempts in the last 15
   minutes. After 10, the API pauses password sign-in for that account. A
   successful sign-in resets the count.
5. Nothing else signs in as `student@bgscet.ac.in` while the case runs: no
   other browser or device, no pytest run and no other Playwright run
   against the same database. REEP keeps one live session per account, so
   another sign-in ends this one, either at once or within 60 seconds. The
   reload in step 6 would then land on `/login?next=%2Fstudent&signedOut=elsewhere`,
   and ER-5 would fail for a reason outside the app.

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
| ER-2 | 2 | The Student portal card is marked as selected, and the ID field is labelled "Institutional email or USN". |
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

1. The web app and the API are running as described in "Setup" in the
   index, with a development `ENV`.
2. The dev seed has been applied, so the email in the test data belongs to a
   real account. The case checks a wrong password for an existing account.
3. The browser has no REEP session and no remembered sign-in: use a fresh
   private window, or sign out and clear this site's local storage (the
   `reep.login.id` and `reep.login.portal` keys that "Remember me" sets).
4. The account has had fewer than 10 failed sign-in attempts in the last 15
   minutes. Past that, the API answers 429, and the card shows "Too many
   failed attempts for this account or from this network, so password
   sign-in is paused for a few minutes…" instead of the message in ER-1.

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

One failed attempt is added to the account's count. The count lasts until
15 minutes after the first failure in the current window, not 15 minutes
after this attempt. The API keeps it in memory, so restarting the API clears
it, and so does a successful sign-in (TC-001).

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

1. The web app and the API are running as described in "Setup" in the
   index, with a development `ENV`. The "Forgot password?" link sits under
   the password field, which is shown only when the server offers password
   sign-in.
2. In the last hour the API has received fewer than 3 reset requests for
   this address, and fewer than 100 reset requests in total, for any address.
   A request refused by the per-address limit still counts toward the 100.
   The API keeps both counts in memory, so restarting it clears them. Past
   either limit, it answers "Too many reset requests. Please wait an hour and
   try again."
3. For ER-4 only: access to the API's console output (a development server
   with no mail transport), or to the account's mailbox.

### Test data

| Field | Value |
|---|---|
| Email | `student@bgscet.ac.in` (the dev seed's student account) |

The automated run enters a new, unregistered address on every run instead,
of the form `tc-003-<run id>@example.invalid`. That keeps repeated runs under
the 3-per-hour limit, though each run still uses one of the 100 per hour. It
checks the same thing: the page shows the same sentence for every address,
registered or not (ER-3). The only difference a registered address makes is
the email itself, and ER-4 is checked by hand.

### Steps

1. Open the sign-in page at `/login`.
2. Click "Forgot password?".
3. Enter the email address in the "Email address" field.
4. Click Send reset link.

### Expected results

| # | After step | Expected result |
|---|---|---|
| ER-1 | 2 | A reset form opens on the sign-in card, under the Sign in button, with an "Email address" field and a Send reset link button. The button is disabled while the field is empty. |
| ER-2 | 3 | The Send reset link button becomes enabled. |
| ER-3 | 4 | The form is replaced by exactly this sentence: "If that address belongs to a REEP account, we've emailed it a link to reset your password - or to set one up, if you have not yet." The page stays on `/login`. |
| ER-4 | 4 | **Manual only.** An email with the subject "Reset your REEP password" is sent to the address. It contains a single-use link to `/reset?token=…` that expires in 60 minutes. A development server with no mail transport (`SES_FROM_ADDRESS` blank) logs the email to the API console as `MAIL (no transport configured) to=student@bgscet.ac.in subject='Reset your REEP password'`. |

### Post-conditions

The account's password is unchanged until the emailed link is used. A new
reset request replaces any earlier link that has not been used yet.
