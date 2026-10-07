// Screenshot + layout audit for the admin console at phone width, against a
// running `ng serve` with every /api request STUBBED (no API, no Postgres).
//
//   node docs/mobile-pwa/admin/harness/shoot.mjs <label> <route> [<route>...]
//   e.g.  node shoot.mjs before /admin /admin/registrations
//
// Options (env): WIDTH (390), HEIGHT (844), BASE (http://localhost:4200),
// OUT (docs/mobile-pwa/admin), FULL=1 full-page shots, CLICK="css selector"
// to click before the shot (e.g. open a sheet), SUFFIX for the file name.
//
// Fixtures: every module in ./fixtures exports `default` as an array of
// [method, RegExp-on-path+query, body | (url, request) => body]. First match
// wins; an unmatched GET answers [] and logs the path so a fixture can be
// added. Each line of the audit names elements wider than the viewport and
// tap targets under 44px tall — the two things that make a page feel broken
// on a phone.
import { chromium } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [label, ...routes] = process.argv.slice(2);
if (!label || routes.length === 0) {
  console.error('usage: shoot.mjs <label> <route>...');
  process.exit(2);
}
const W = Number(process.env.WIDTH ?? 390);
const H = Number(process.env.HEIGHT ?? 844);
const BASE = process.env.BASE ?? 'http://localhost:4200';
const OUT = resolve(process.env.OUT ?? join(here, '..'));

const fixtures = [];
for (const f of readdirSync(join(here, 'fixtures')).sort()) {
  if (!f.endsWith('.mjs')) continue;
  const mod = await import(join(here, 'fixtures', f));
  fixtures.push(...mod.default);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: W < 900, isMobile: W < 900 });
const page = await ctx.newPage();
const missing = new Set();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.split('\n')[0]));

await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const key = url.pathname.replace(/^\/api/, '') + url.search;
  for (const [method, re, body] of fixtures) {
    if (method !== req.method() && method !== '*') continue;
    if (!re.test(key)) continue;
    const value = typeof body === 'function' ? body(url, req) : body;
    if (value && value.__status) {
      return route.fulfill({ status: value.__status, contentType: 'application/json', body: JSON.stringify(value.body ?? {}) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  }
  if (req.method() === 'GET') missing.add(key);
  return route.fulfill({ status: 200, contentType: 'application/json', body: req.method() === 'GET' ? '[]' : '{}' });
});

for (const r of routes) {
  missing.clear();
  await page.goto(BASE + r, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (process.env.CLICK) {
    for (const sel of process.env.CLICK.split('||')) {
      await page.locator(sel).first().click();
      await page.waitForTimeout(400);
    }
  }
  const audit = await page.evaluate((vw) => {
    const doc = document.documentElement;
    const wide = [];
    const small = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rc = el.getBoundingClientRect();
      if (rc.width === 0 || rc.height === 0) continue;
      // The shell (app bar, drawer, tab bar, orb) is not an admin screen's.
      if (el.closest('.appbar, .desktop-nav, .tabbar, .nav-scrim, app-agent-orb, app-agent-dock')) continue;
      // Inside a horizontally scrolling box (a table wrapper, a tab strip) is fine.
      let p = el.parentElement, clipped = false;
      while (p && p !== document.body) {
        const ps = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 1) { clipped = true; break; }
        p = p.parentElement;
      }
      const name = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      if (!clipped && (rc.right > vw + 1 || rc.left < -1) && wide.length < 12) wide.push(`${name} [${Math.round(rc.left)}..${Math.round(rc.right)}]`);
      const tappable = el.matches('button, a[href], select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), [role=button], [role=tab]');
      if (tappable && rc.height < 40 && small.length < 15) small.push(`${name} ${Math.round(rc.width)}x${Math.round(rc.height)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`);
    }
    return { scrollW: doc.scrollWidth, wide, small, title: document.querySelector('h1')?.textContent?.trim() };
  }, W);
  if (process.env.FULL === '1') {
    // The shell scrolls .desktop-main, not the page, so a "full page" shot is
    // a taller viewport sized to the main column's content.
    const h = await page.evaluate(() => {
      const m = document.querySelector('.desktop-main');
      return m ? m.scrollHeight + m.getBoundingClientRect().top : document.documentElement.scrollHeight;
    });
    await page.setViewportSize({ width: W, height: Math.min(5000, Math.max(H, Math.ceil(h))) });
    await page.waitForTimeout(300);
  }
  const slug = (r.replace(/^\/+/, '').replace(/[/?=&]+/g, '-') || 'root') + (process.env.SUFFIX ? '-' + process.env.SUFFIX : '');
  const file = join(OUT, `${slug}.${label}.png`);
  await page.screenshot({ path: file });
  if (process.env.FULL === '1') await page.setViewportSize({ width: W, height: H });
  console.log(`${r} @${W}px  h1="${audit.title ?? ''}"  pageScrollW=${audit.scrollW}${audit.scrollW > W ? '  <-- HORIZONTAL SCROLL' : ''}`);
  if (audit.wide.length) console.log('  wider than viewport:', audit.wide.join(' | '));
  if (audit.small.length) console.log('  small targets:', audit.small.join(' | '));
  if (missing.size) console.log('  unstubbed GETs:', [...missing].join(' '));
  console.log('  ->', file);
}
await browser.close();
