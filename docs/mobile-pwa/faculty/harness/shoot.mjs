/**
 * Screenshot harness for the faculty screens and the REEP Agent page, run
 * against `ng serve` with every /api request stubbed (fixtures.mjs). See the
 * README one level up for how to run it.
 *
 *   node shoot.mjs <outDir> [tag=after] [width=390] [height=844] [only=a,b]
 *
 * Writes <screen>-<tag>.png per screen, plus the interaction states (a pushed
 * mentee, an open claim, the leave form top/bottom/view, the notebook form,
 * the agent thread after a starter). Prints each screen's .desktop-main
 * scrollWidth/clientWidth so horizontal overflow shows up as unequal numbers.
 */
import { chromium } from 'playwright';
import { entries, notes, routes } from './fixtures.mjs';
const out = process.argv[2]; const tag = process.argv[3] || 'after';
const W = +(process.argv[4] || 390), H = +(process.argv[5] || 844);
const only = process.argv[6];
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: W < 900, isMobile: W < 900 });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERR', e.message));
await page.route('**/api/**', async (r) => {
  const u = new URL(r.request().url()); let p = u.pathname.replace(/^\/api\//, '');
  if (p.startsWith('mentor/students/') && p.endsWith('/notes')) return r.fulfill({ json: notes });
  if (p.startsWith('v1/mentor/notebook/students/')) return r.fulfill({ json: entries });
  if (p.match(/^leaves\/[^/]+\/attachments$/)) return r.fulfill({ json: [] });
  if (p === 'staff/signature/image') return r.fulfill({ status: 404, body: '' });
  const body = routes[p];
  if (body === undefined) { return r.fulfill({ status: 404, json: { detail: 'stub' } }); }
  return r.fulfill({ json: body });
});
const shots = [
  ['notebook', '/mentor/notebook'], ['mentees', '/mentor/mentees'], ['verifications', '/mentor/verifications'],
  ['leave', '/mentor/leave'], ['signature', '/mentor/signature'], ['upskilling', '/mentor/upskilling'], ['agent', '/mentor/agent'],
];
for (const [name, path] of shots) {
  if (only && !only.split(',').includes(name)) continue;
  await page.goto((process.env.BASE_URL ?? 'http://localhost:4200') + path, { waitUntil: 'networkidle' });
  // The agent's Clear button enables when the history lands; wait for it.
  if (name === 'agent') await page.waitForSelector('.ag-bubble');
  await page.waitForTimeout(500);
  const sw = await page.evaluate(() => { const m = document.querySelector('.desktop-main'); return m ? [m.scrollWidth, m.clientWidth] : null; });
  console.log(name, 'scroll/client', sw);
  await page.screenshot({ path: `${out}/${name}-${tag}.png` });
  if (name === 'mentees' && W < 900) { await page.click('.ml-row >> nth=1'); await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}-detail-${tag}.png` }); }
  if (name === 'verifications') { await page.click('text=Review evidence >> nth=0'); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${name}-open-${tag}.png` }); }
  if (name === 'leave') { await page.click('text=New leave request'); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${name}-form-${tag}.png`, fullPage: false }); await page.evaluate(() => { const m = document.querySelector('.desktop-main'); m.scrollTop = m.scrollHeight; }); await page.waitForTimeout(200); await page.screenshot({ path: `${out}/${name}-form-bottom-${tag}.png` }); await page.click('.lv-back'); await page.click('.req-card >> nth=0'); await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}-view-${tag}.png` }); }
  if (name === 'agent') { await page.click('.ag-starter >> nth=3'); await page.waitForTimeout(600); await page.screenshot({ path: `${out}/${name}-thread-${tag}.png` }); }
  if (name === 'notebook') { await page.click('.nb-toggle'); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${name}-form-${tag}.png` }); }
}
await browser.close();
