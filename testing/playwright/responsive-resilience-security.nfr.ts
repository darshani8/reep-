/**
 * NFR-RESP  Flexibility / adaptability: no horizontal scroll at phone, tablet and desktop widths.
 * NFR-REL   Reliability / fault tolerance: the SPA degrades with a message when the API is down.
 * NFR-SEC   Security as seen from the browser.
 */
import { test, expect } from '@playwright/test';
import { signIn } from './support';

const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 780 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1366', width: 1366, height: 900 },
];

for (const vp of VIEWPORTS) {
  for (const [path, auth] of [['/login', false], ['/register', false], ['/student', true], ['/student/jobs', true]] as const) {
    test(`NFR-RESP-01 ${vp.name} ${path} has no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      if (auth) await signIn(page);
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${vp.width}px scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
    });
  }
}

test('NFR-REL-01 login with the API unreachable shows a message, not a blank or a hang', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.goto('/login');
  await page.locator('input[name="id"]').fill('loadtest104@bgscet.ac.in');
  await page.locator('input[name="password"]').fill('LoadTest#2026');
  await page.locator('form button.btn-primary[type="submit"]').click();
  await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
});

test('NFR-REL-02 a 500 from one student endpoint does not take the whole screen down', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/student/leaderboards**', (route) => route.fulfill({ status: 500, body: '{"detail":"boom"}' }));
  await page.goto('/student/leaderboards');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/login/);
});

test('NFR-SEC-01 the session cookie is httpOnly (invisible to page scripts)', async ({ page, context }) => {
  await signIn(page);
  await page.goto('/student');
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).not.toContain('reep_session');
  const cookie = (await context.cookies()).find((c) => c.name === 'reep_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
});

test('NFR-SEC-02 no session material or password is written to web storage', async ({ page }) => {
  await signIn(page);
  await page.goto('/student');
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(dump).not.toContain('LoadTest#2026');
  expect(dump).not.toMatch(/eyJhbGciOi/); // a JWT
});

test('NFR-SEC-03 reflected script in a query string is not executed', async ({ page }) => {
  let fired = false;
  page.on('dialog', async (d) => { fired = true; await d.dismiss(); });
  await page.goto('/login?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&next=javascript:alert(1)');
  await page.waitForTimeout(1500);
  expect(fired).toBe(false);
});
