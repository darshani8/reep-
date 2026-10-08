/**
 * The phone's Back closes each faculty overlay instead of leaving the screen
 * (core/back-close.ts). For every case: open the overlay at 390px, press the
 * browser's Back, and check the overlay closed and the URL did not change.
 * Then the same at 1280px, where nothing is pushed: Back must leave the
 * screen exactly as it always has.
 *
 *   node back.mjs            (BASE_URL, PW_CHROMIUM as for shoot.mjs)
 *
 * The notebook's "Add entry" strip is not here on purpose: it opens inline
 * at every width, above the log, and is not an overlay on a phone either.
 *
 * Exits 1 on any failure.
 */
import { chromium } from 'playwright';
import { entries, notes, routes } from './fixtures.mjs';

const base = process.env.BASE_URL ?? 'http://localhost:4200';

/** [name, path, open(page), isOpen(page) -> boolean, own close button] */
const cases = [
  ['mentee log: pushed log', '/mentor/mentees',
    (p) => p.click('.ml-row >> nth=1'),
    (p) => p.locator('.ml-split.is-detail').count().then((n) => n > 0), '.m-back--wide'],
  ['verifications: open claim', '/mentor/verifications',
    (p) => p.click('text=Review evidence >> nth=0'),
    (p) => p.locator('.claim.is-open').count().then((n) => n > 0), '.m-back--wide'],
  ['leave: new form', '/mentor/leave',
    (p) => p.click('text=New leave request'),
    (p) => p.locator('.lv-back').count().then((n) => n > 0), '.lv-back'],
  ['leave: a request', '/mentor/leave',
    (p) => p.click('.req-card >> nth=0'),
    (p) => p.locator('.lv-back').count().then((n) => n > 0), '.lv-back'],
];

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let failed = 0;
for (const W of [390, 1280]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, hasTouch: W < 900, isMobile: W < 900 });
  await ctx.route('**/api/**', async (r) => {
    const p = new URL(r.request().url()).pathname.replace(/^\/api\//, '');
    if (p.startsWith('mentor/students/') && p.endsWith('/notes')) return r.fulfill({ json: notes });
    if (p.startsWith('v1/mentor/notebook/students/')) return r.fulfill({ json: entries });
    if (p.match(/^leaves\/[^/]+\/attachments$/)) return r.fulfill({ json: [] });
    const body = routes[p];
    return body === undefined ? r.fulfill({ status: 404, json: { detail: 'stub' } }) : r.fulfill({ json: body });
  });
  const page = await ctx.newPage();
  for (const [name, path, open, isOpen, closeSel] of cases) {
    // A screen to come back FROM, so a Back that leaves the route is visible.
    await page.goto(`${base}/mentor/upskilling`, { waitUntil: 'networkidle' });
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    await open(page);
    await page.waitForTimeout(300);
    const opened = await isOpen(page);
    await page.goBack();
    await page.waitForTimeout(400);
    const url = new URL(page.url()).pathname;
    const stillOpen = await isOpen(page).catch(() => false);
    // Phone: the overlay closes and the route stays. Desktop: nothing was
    // pushed, so Back leaves for the previous screen as it always did.
    const ok = W < 900
      ? opened && !stillOpen && url === path
      : url === '/mentor/upskilling';
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${W} ${name}: opened=${opened} afterBack open=${stillOpen} url=${url}`);
    if (!ok) failed++;

    // Closed by its own button instead, the pushed entry is popped with it:
    // the next Back leaves the screen, as it would have without the overlay.
    if (W < 900) {
      await page.goto(`${base}/mentor/upskilling`, { waitUntil: 'networkidle' });
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await open(page);
      await page.waitForTimeout(300);
      await page.click(closeSel);
      await page.waitForTimeout(300);
      const closed = !(await isOpen(page));
      await page.goBack();
      await page.waitForTimeout(400);
      const after = new URL(page.url()).pathname;
      const ok2 = closed && after === '/mentor/upskilling';
      console.log(`${ok2 ? 'ok  ' : 'FAIL'} ${W} ${name}, closed by its button then Back: url=${after}`);
      if (!ok2) failed++;
    }
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
