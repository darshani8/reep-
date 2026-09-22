/**
 * Authentication: the automated twins of the cases in
 * test-management/cases/01-authentication.md.
 *
 * THE TAG IS THE LINK. Each test's title ends with the `@TC-NNN` ID of the case
 * it automates, its top-level `test.step()` titles are that case's steps word
 * for word, and every assertion message names the expected result it checks
 * (`TC-001 ER-4: ...`). The CSV reporter (tests/reporters/manual-csv-reporter.ts)
 * FAILS THE RUN when a tag names no case in the manual files or a test's steps
 * have drifted from the manual steps, so the two suites cannot quietly
 * disagree. Change a case and its test in the same commit.
 *
 * These drive the REAL app, with nothing mocked, because a mocked
 * `/api/auth/login` would test the mock. The shared pre-conditions are checked
 * before every test by the `test` imported from ./support/reep, which marks
 * the test Blocked when they do not hold.
 */
import { ACCOUNTS, expect, test } from './support/reep';
import type { Page } from '@playwright/test';

/** The "Test data" tables: the dev seed's student. */
const STUDENT = { ...ACCOUNTS.student, firstName: 'Test' } as const;
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
