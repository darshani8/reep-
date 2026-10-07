// Screenshots of the student screens at phone width, with /api stubbed.
// usage: node shoot.mjs <baseUrl> <outDir> [route ...]
// Run from the repository root so @playwright/test resolves.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fixtureFor } from './fixtures.mjs';

const [base, out, ...only] = process.argv.slice(2);
const W = Number(process.env.W ?? 390);
const routes = only.length
  ? only
  : ['student', 'student/jobs', 'student/skilling', 'student/leaderboards', 'student/time-log',
     'student/mentor-log', 'student/resume', 'student/records', 'student/profile',
     'student/uploads', 'student/courses', 'student/english', 'student/interviews',
     'student/assistant'];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({
  viewport: { width: W, height: 844 }, deviceScaleFactor: 1, isMobile: W < 900, hasTouch: W < 900,
  serviceWorkers: 'block',
});
const missing = new Set();
await ctx.route('**/api/**', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const f = fixtureFor(req.method(), u.pathname, u.search);
  if (!f) { missing.add(`${req.method()} ${u.pathname}`); return route.fulfill({ status: 404, json: { detail: 'stub' } }); }
  return route.fulfill({ status: f.status ?? 200, json: f.body });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message.slice(0, 200)));
for (const r of routes) {
  await page.goto(`${base}/${r}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const name = r.replace(/\//g, '_');
  const overflow = await page.evaluate(() => {
    const m = document.querySelector('.desktop-main') ?? document.documentElement;
    return m.scrollWidth - m.clientWidth;
  });
  console.log(r, 'h-overflow', overflow);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  // the whole scroll height of the main column, for review
  const h = await page.evaluate(() => document.querySelector('.desktop-main')?.scrollHeight ?? 844);
  await page.setViewportSize({ width: W, height: Math.min(h + 120, 6000) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/${name}.full.png`, fullPage: false });
  await page.setViewportSize({ width: W, height: 844 });
}
console.log('missing fixtures:', [...missing].join('\n  '));
await browser.close();
