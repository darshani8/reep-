/**
 * The automated twins of the manual cases in test-management/manual-test-cases.md.
 *
 * THE TAG IS THE LINK. Each test's title ends with the `@TC-NNN` ID of the case
 * it automates, its top-level `test.step()` titles are that case's steps word
 * for word, and every assertion message names the expected result it checks
 * (`TC-001 ER-4: ...`). The CSV reporter (tests/reporters/manual-csv-reporter.ts)
 * FAILS THE RUN when a tag names no case in the manual file or a test's steps
 * have drifted from the manual steps, so the two suites cannot quietly
 * disagree. Change a case and its test in the same commit.
 *
 * These drive the REAL app: the Angular dev server and the API on a
 * development ENV with the dev seed applied (the manual file's "Setup for
 * every case"). Nothing is mocked, because a mocked `/api/auth/login` would
 * test the mock. `beforeEach` checks the shared pre-conditions first and marks
 * the test Blocked when they do not hold. A test still FAILS in that case, so
 * a run against a stopped API is red rather than a quiet row of skips.
 *
 * A pre-condition that goes unchecked turns into a false result, and TC-002 is
 * the sharp case: the API refuses an UNKNOWN or disabled account with the same
 * 401 sentence as a wrong password (deliberately, see `login` in
 * apps/api-py/app/routers/auth.py). So without the check, TC-002 "passes"
 * against a database the seed never reached.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/** The "Test data" tables. `python -m app.seed` creates this account, and it
 *  refuses to run on ENV=prod, so these credentials exist only on dev/CI. */
const STUDENT = {
  email: 'student@bgscet.ac.in',
  password: 'student123',
  firstName: 'Test',
} as const;
const WRONG_PASSWORD = 'wrong-password';

/** The app's own words, so a copy change fails a named expected result
 *  instead of drifting away from the manual file unnoticed.
 *  `passwordErrorFor` in apps/web/src/app/features/login/login.component.ts: */
const INVALID_CREDENTIALS =
  'That email and password did not match an account. Check both, or use Continue with Google.';
/** `_FORGOT_ANSWER` in apps/api-py/app/routers/passwords.py, which the login
 *  screen shows verbatim: */
const RESET_ANSWER =
  "If that address belongs to a REEP account, we've emailed it a link to reset your " +
  'password - or to set one up, if you have not yet.';

const idField = (page: Page) => page.getByLabel('Institutional email or USN');
// By placeholder, not by label: the label also contains the "Show password"
// toggle, whose aria-label would match a `getByLabel('Password')` too.
const passwordField = (page: Page) => page.getByPlaceholder('Enter your password');
// `exact`: "Already approved? Sign in →" is a button whose name contains this one.
const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in', exact: true });
const studentPortal = (page: Page) => page.getByRole('radio', { name: /^Student\b/ });
const greeting = (page: Page) =>
  page.getByRole('heading', { level: 1, name: `Welcome back, ${STUDENT.firstName}`, exact: true });

/**
 * The pre-conditions every case shares, in the order they fail:
 *   1. the web app answers, and the API answers behind it;
 *   2. the API offers password sign-in. The login screen hides the password
 *      form, and "Forgot password?" with it, unless `GET /api/auth/sso/status`
 *      says the password door is open;
 *   3. the dev seed's student signs in with its seed password. That one request
 *      proves the database is up and the seed was applied (TC-001 and TC-002
 *      pre-condition 2). It also proves the account's failure budget is not
 *      spent (pre-condition 4), and a success returns that budget, so TC-002
 *      run on its own, over and over, never meets the limiter.
 * The sign-in uses the `request` fixture, whose cookie jar is not the page's,
 * so the page still starts with no session (pre-condition 3).
 */
async function preconditionProblem(request: APIRequestContext): Promise<string | null> {
  let response;
  try {
    response = await request.get('/api/auth/sso/status');
  } catch (error) {
    return `the web app did not answer (${(error as Error).message.split('\n')[0]}). Start it with "npx ng serve" in apps/web.`;
  }
  if (!response.ok()) {
    return (
      `GET /api/auth/sso/status answered ${response.status()}, so the API is not reachable behind the web app. ` +
      'Start it on port 3300 (see "Setup for every case" in test-management/manual-test-cases.md).'
    );
  }
  let status: { password_login_available?: unknown };
  try {
    status = (await response.json()) as typeof status;
  } catch {
    return 'GET /api/auth/sso/status did not answer JSON, so REEP_BASE_URL is not pointing at a REEP web app.';
  }
  if (status.password_login_available !== true) {
    return 'the server does not offer password sign-in. Run the API with ENV=dev, as in "Setup for every case".';
  }

  const signIn = await request.post('/api/auth/login', {
    data: { email: STUDENT.email, password: STUDENT.password },
  });
  if (signIn.status() === 429) {
    return (
      `the API has paused password sign-in for ${STUDENT.email} after 10 failed attempts. ` +
      'Wait 15 minutes, or restart the API, which clears the count.'
    );
  }
  if (signIn.status() === 401) {
    return `${STUDENT.email} does not sign in with its seed password. Run "python -m app.seed" in apps/api-py.`;
  }
  if (signIn.status() === 403) {
    return `${STUDENT.email} is disabled or removed, so it cannot sign in. Restore it in the console, or seed a fresh database.`;
  }
  if (!signIn.ok()) {
    return (
      `POST /api/auth/login answered ${signIn.status()}, so the API cannot read its database. ` +
      'Start Postgres with "docker compose up -d", then apply migrations and the dev seed.'
    );
  }
  if ('otp_required' in ((await signIn.json()) as object)) {
    return 'the server asks for an emailed code after the password (OTP_REQUIRED), which these cases do not cover.';
  }
  return null;
}

test.beforeEach(async ({ request }, testInfo) => {
  const problem = await preconditionProblem(request);
  if (problem) {
    // Read by the CSV reporter, which records the case as Blocked, not Failed.
    testInfo.annotations.push({ type: 'blocked', description: problem });
    throw new Error(`Blocked by a pre-condition: ${problem}`);
  }
});

test.describe('Authentication', () => {
  test('Successful login with valid credentials @TC-001', async ({ page }) => {
    await test.step('1. Open the sign-in page at /login', async () => {
      await page.goto('/login');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Welcome back', exact: true }),
        'TC-001 ER-1: the "Welcome back" sign-in card is shown',
      ).toBeVisible();
      await expect(
        idField(page),
        'TC-001 ER-1: the "Institutional email or USN" field is shown',
      ).toBeVisible();
      await expect(passwordField(page), 'TC-001 ER-1: the "Password" field is shown').toBeVisible();
      await expect(signInButton(page), 'TC-001 ER-1: the Sign in button is shown').toBeVisible();
    });

    await test.step('2. Under "Choose your portal", select Student', async () => {
      // Student is the default portal, so move off it first. Otherwise ER-2
      // would pass even if clicking a portal card did nothing.
      await page.getByRole('radio', { name: /^Faculty\b/ }).click();
      await expect(
        studentPortal(page),
        'TC-001 ER-2 (arrange): another portal is selected',
      ).not.toBeChecked();
      await studentPortal(page).click();
      await expect(
        studentPortal(page),
        'TC-001 ER-2: the Student portal card is selected',
      ).toBeChecked();
      await expect(
        idField(page),
        'TC-001 ER-2: the ID field reads "Institutional email or USN"',
      ).toBeVisible();
    });

    await test.step('3. Enter the email address in the "Institutional email or USN" field', async () => {
      await idField(page).fill(STUDENT.email);
    });

    await test.step('4. Enter the password in the "Password" field', async () => {
      await passwordField(page).fill(STUDENT.password);
      await expect(passwordField(page), 'TC-001 ER-3: the password is masked').toHaveAttribute(
        'type',
        'password',
      );
    });

    await test.step('5. Click Sign in', async () => {
      await signInButton(page).click();
      await expect(page, 'TC-001 ER-4: the browser lands on the student home').toHaveURL(
        /\/student$/,
      );
      await expect(
        greeting(page),
        'TC-001 ER-4: the home greets the student by first name',
      ).toBeVisible();
    });

    await test.step('6. Reload the page', async () => {
      await page.reload();
      await expect(
        page,
        'TC-001 ER-5: the student is still on /student after the reload',
      ).toHaveURL(/\/student$/);
      await expect(
        greeting(page),
        'TC-001 ER-5: the greeting is shown again, so the session held',
      ).toBeVisible();
    });
  });

  test('Login is refused for an invalid password @TC-002', async ({ page }) => {
    await test.step('1. Open the sign-in page at /login', async () => {
      await page.goto('/login');
    });

    await test.step('2. Under "Choose your portal", select Student', async () => {
      await studentPortal(page).click();
    });

    await test.step('3. Enter the email address in the "Institutional email or USN" field', async () => {
      await idField(page).fill(STUDENT.email);
    });

    await test.step('4. Enter the invalid password in the "Password" field', async () => {
      await passwordField(page).fill(WRONG_PASSWORD);
    });

    await test.step('5. Click Sign in', async () => {
      await signInButton(page).click();
      // ER-1 first: the alert is what proves the request came back, so the
      // URL check after it cannot pass merely because nothing happened yet.
      await expect(
        page.getByRole('alert').filter({ hasText: INVALID_CREDENTIALS }),
        'TC-002 ER-1: the card shows the invalid-credentials message',
      ).toBeVisible();
      await expect(page, 'TC-002 ER-2: the page stays on /login').toHaveURL(/\/login$/);
      await expect(passwordField(page), 'TC-002 ER-3: the password field is emptied').toHaveValue(
        '',
      );
      await expect(idField(page), 'TC-002 ER-3: the email address stays filled in').toHaveValue(
        STUDENT.email,
      );
    });

    await test.step('6. Open /student directly in the same tab', async () => {
      await page.goto('/student');
      await expect(
        page,
        'TC-002 ER-4: no session was created, so the app sends the browser back to sign in',
      ).toHaveURL(/\/login\?next=%2Fstudent$/);
      await expect(
        signInButton(page),
        'TC-002 ER-4: the sign-in form is shown again',
      ).toBeVisible();
    });
  });

  test('Password reset request @TC-003', async ({ page }) => {
    // ER-4, the email itself, is checked by hand; the CSV's "Manual-only
    // Checks" column reads it from the manual file. The address is a new,
    // unregistered one per run. The API allows 3 reset requests per address
    // per hour, and answers every address with the same sentence, so this
    // checks what the page shows without using up that limit. See the note
    // under the case's "Test data".
    const email = `tc-003-${Date.now().toString(36)}@example.invalid`;
    const emailField = page.getByLabel('Email address', { exact: true });
    const sendButton = page.getByRole('button', { name: 'Send reset link' });

    await test.step('1. Open the sign-in page at /login', async () => {
      await page.goto('/login');
    });

    await test.step('2. Click "Forgot password?"', async () => {
      await page.getByRole('button', { name: 'Forgot password?' }).click();
      await expect(
        emailField,
        'TC-003 ER-1: the reset form shows an "Email address" field',
      ).toBeVisible();
      await expect(
        sendButton,
        'TC-003 ER-1: Send reset link is disabled while the field is empty',
      ).toBeDisabled();
    });

    await test.step('3. Enter the email address in the "Email address" field', async () => {
      await emailField.fill(email);
      await expect(sendButton, 'TC-003 ER-2: Send reset link becomes enabled').toBeEnabled();
    });

    await test.step('4. Click Send reset link', async () => {
      await sendButton.click();
      await expect(
        page.getByRole('status').filter({ hasText: RESET_ANSWER }),
        'TC-003 ER-3: the form is replaced by the one answer given for every address',
      ).toHaveText(RESET_ANSWER);
      await expect(emailField, 'TC-003 ER-3: the form itself is gone').toBeHidden();
      await expect(page, 'TC-003 ER-3: the page stays on /login').toHaveURL(/\/login$/);
    });
  });
});
