#!/usr/bin/env node
/**
 * REEP demo recorder.
 *
 * Drives the RUNNING portal (Angular on 4200 in front of the API on 3300) in a
 * real Chromium through every role's screens while Playwright records the
 * session — visible, slowed-down typing, a drawn cursor, a chapter card at the
 * start of each segment and a caption bar that says what the screen is for.
 * It also saves a screenshot of every screen it visits, which is what the
 * slide deck in docs/presentation/ is built from.
 *
 * It uses the seeded dev database (python -m app.seed) and the seeded logins
 * from AGENTS.md, and it WRITES: claims, meeting requests, notes, a leave
 * request and its sanction, a job posting, SWOC lines, a grant, a registration
 * and its approval. Run it against a throwaway database, never a real one.
 *
 *   node tools/demo/record-walkthrough.mjs                # every segment
 *   node tools/demo/record-walkthrough.mjs student admin  # some segments
 *
 * Segments: student, faculty, admin, alumni, interlinked, onboarding.
 *
 * Environment:
 *   REEP_WEB      the SPA origin           (default http://127.0.0.1:4200)
 *   REEP_API_LOG  the uvicorn log file — the console mail transport writes
 *                 every mail there in full, which is how the onboarding
 *                 segment reads the setup link and the six-digit code
 *   DEMO_OUT      output directory         (default tools/demo/out)
 *   DEMO_ASSETS   sample files directory   (default tools/demo/assets)
 *   TYPE_DELAY    ms between keystrokes    (default 55)
 *   DEMO_WIDTH / DEMO_HEIGHT   the viewport and video size (default 1920 x 1080)
 *   DEMO_ZOOM     how far the camera moves in while typing (default 1.55; 1 = off)
 *   DEMO_TTS_CMD  the text-to-speech command that narrates every caption: text on
 *                 stdin, a WAV at {out}. Default: Piper with the voice under
 *                 tools/demo/voices/ (fetch-voice.sh); blank disables narration.
 *                 The clips and their timings land in <DEMO_OUT>/narration/ and
 *                 render.sh lays them onto the video.
 *
 * Output: <DEMO_OUT>/<segment>.webm (VP8, at the viewport size) and <DEMO_OUT>/shots/*.png.
 * tools/demo/render.sh turns the .webm files into MP4s with title cards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WEB = (process.env.REEP_WEB ?? 'http://127.0.0.1:4200').replace(/\/$/, '');
const API_LOG = process.env.REEP_API_LOG ?? '';
const OUT = path.resolve(process.env.DEMO_OUT ?? path.join(HERE, 'out'));
const ASSETS = path.resolve(process.env.DEMO_ASSETS ?? path.join(HERE, 'assets'));
const TYPE_DELAY = Number(process.env.TYPE_DELAY ?? 55);
// The camera move: while a box is being typed into, the page is scaled up around
// it (a smooth CSS transform on <body>, panned from field to field) and scaled
// back before anything is clicked, scrolled or screenshotted. 1 turns it off.
const ZOOM = Number(process.env.DEMO_ZOOM ?? 1.55);
// Narration: every caption and chapter card is spoken. The recorder logs WHEN
// each one appeared (ms into the video) and synthesizes the words in the
// background; render.sh lays the clips onto the video at those times.
const VOICE = process.env.PIPER_VOICE ?? path.join(HERE, 'voices', 'en_US-lessac-medium.onnx');
const TTS_CMD = process.env.DEMO_TTS_CMD ?? (fs.existsSync(VOICE) ? `${process.env.PIPER ?? 'piper'} --model ${JSON.stringify(VOICE)} --length_scale 1.08 --output_file {out}` : '');
const WORDS_PER_SECOND = 2.7; // the pace the default voice speaks at; sets how long the next caption waits
// Full HD: the console's grids and the wider screens are cut off at 1280x720.
const SIZE = { width: Number(process.env.DEMO_WIDTH ?? 1920), height: Number(process.env.DEMO_HEIGHT ?? 1080) };

const STUDENT = { portal: 'Student', email: 'student@bgscet.ac.in', password: 'student123', home: /\/student(\?|$)/ };
const FACULTY = { portal: 'Faculty', email: 'mentor@bgscet.ac.in', password: 'mentor123', home: /\/mentor\// };
const ADMIN = { portal: 'admin', email: 'admin@bgscet.ac.in', password: 'admin123', home: /\/admin(\?|$)/ };
const ALUMNI = { portal: 'Alumni', email: 'alumni@bgscet.ac.in', password: 'alumni123', home: /\/alumni(\?|$)/ };
const APPLICANT = {
  name: 'Priya Menon',
  email: 'priya.menon@bgscet.ac.in',
  usn: '1BG25MDM014',
  personal: 'priya.menon.pm@gmail.com',
  phone: '+91 98450 12345',
  linkedin: 'linkedin.com/in/priya-menon',
  password: 'Placement@2026!',
};

const asset = (name) => path.join(ASSETS, name);
const STATE = () => path.join(OUT, 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; } };
const saveState = (patch) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify({ ...loadState(), ...patch }, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The overlay: caption bar, chapter card and a drawn cursor, injected into
// every document before the app's own scripts run. Angular's router keeps the
// document across screens, so the elements persist; a full navigation (the
// onboarding link, /register) re-creates them.
// ---------------------------------------------------------------------------
const OVERLAY = `(() => {
  const ensure = () => {
    if (document.getElementById('reep-demo-caption')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #reep-demo-caption{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);max-width:1560px;z-index:2147483646;
        background:rgba(24,12,48,.92);color:#fff;font:500 25px/1.35 Inter,"Plus Jakarta Sans",system-ui,sans-serif;
        padding:16px 26px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .25s;
        display:flex;gap:14px;align-items:center}
      #reep-demo-caption.on{opacity:1}
      #reep-demo-caption .k{flex:none;background:linear-gradient(135deg,#7c3aed,#db2777);border-radius:999px;padding:6px 16px;font-size:17px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
      #reep-demo-card{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
        background:linear-gradient(135deg,#2a0f55,#6d28d9 55%,#be185d);color:#fff;font-family:"Plus Jakarta Sans",Inter,system-ui,sans-serif;
        opacity:0;transition:opacity .35s;pointer-events:none;padding:40px;text-align:center}
      #reep-demo-card.on{opacity:1}
      #reep-demo-card .t{font-size:80px;font-weight:800;letter-spacing:-.02em;max-width:1500px;line-height:1.1}
      #reep-demo-card .s{font-size:34px;opacity:.92;max-width:1400px;line-height:1.35}
      #reep-demo-card .b{margin-top:34px;font-size:20px;opacity:.75;letter-spacing:.14em;text-transform:uppercase}
      #reep-demo-cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483645;pointer-events:none;transition:transform .04s linear}
      #reep-demo-cursor svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
      #reep-demo-cursor.click::after{content:"";position:absolute;left:-18px;top:-18px;width:66px;height:66px;border-radius:50%;
        border:4px solid #db2777;animation:reepPulse .5s ease-out forwards}
      @keyframes reepPulse{from{transform:scale(.25);opacity:1}to{transform:scale(1.25);opacity:0}}
    \`;
    document.documentElement.appendChild(style);
    const cap = document.createElement('div');
    cap.id = 'reep-demo-caption';
    cap.innerHTML = '<span class="k"></span><span class="m"></span>';
    document.documentElement.appendChild(cap);
    const cur = document.createElement('div');
    cur.id = 'reep-demo-cursor';
    cur.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l16 8.5-7 1.6L9.5 20z" fill="#fff" stroke="#1e1338" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
    document.addEventListener('mousemove', (e) => { cur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    document.addEventListener('mousedown', () => { cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); }, true);
  };
  window.__reepSay = (k, m) => {
    ensure();
    const c = document.getElementById('reep-demo-caption');
    c.querySelector('.k').textContent = k || '';
    c.querySelector('.m').textContent = m || '';
    c.classList.toggle('on', !!m);
  };
  window.__reepCard = (t, s, b) => {
    ensure();
    let c = document.getElementById('reep-demo-card');
    if (!c) { c = document.createElement('div'); c.id = 'reep-demo-card'; document.documentElement.appendChild(c); }
    c.innerHTML = '<div class="t"></div><div class="s"></div><div class="b"></div>';
    c.querySelector('.t').textContent = t;
    c.querySelector('.s').textContent = s;
    c.querySelector('.b').textContent = b || '';
    requestAnimationFrame(() => c.classList.add('on'));
  };
  window.__reepCardOff = () => {
    const c = document.getElementById('reep-demo-card');
    if (c) { c.classList.remove('on'); setTimeout(() => c.remove(), 420); }
  };
  // The camera: scale <body> around a target and pan so the target sits near the
  // middle of the frame, keeping the scaled page covering the viewport. The
  // overlay lives outside <body>, so captions and the cursor stay unscaled.
  window.__reepZoomTo = (el, S) => {
    const b = document.body;
    if (!b || !el) return;
    const cur = b.dataset.reepZoom ? JSON.parse(b.dataset.reepZoom) : { tx: 0, ty: 0, s: 1 };
    const br = b.getBoundingClientRect();
    const r0 = { left: br.left - cur.tx, top: br.top - cur.ty, width: br.width / cur.s, height: br.height / cur.s };
    const er = el.getBoundingClientRect();
    const px = (er.left + er.width / 2 - br.left) / cur.s;
    const py = (er.top + er.height / 2 - br.top) / cur.s;
    const W = innerWidth, H = innerHeight;
    let tx = W / 2 - r0.left - S * px;
    let ty = H / 2 - r0.top - S * py;
    const bw = Math.max(r0.width, W), bh = Math.max(r0.height, H);
    tx = Math.min(-r0.left, Math.max(W - r0.left - S * bw, tx));
    ty = Math.min(-r0.top, Math.max(H - r0.top - S * bh, ty));
    b.style.transition = 'transform .85s cubic-bezier(.3,.05,.2,1)';
    b.style.transformOrigin = '0 0';
    b.style.willChange = 'transform';
    b.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + S + ')';
    b.dataset.reepZoom = JSON.stringify({ tx, ty, s: S });
  };
  window.__reepZoomOut = () => {
    const b = document.body;
    if (!b || !b.dataset.reepZoom) return false;
    b.style.transform = 'translate(0px,0px) scale(1)';
    delete b.dataset.reepZoom;
    return true;
  };
  window.__reepZoomed = () => !!(document.body && document.body.dataset.reepZoom);
  window.__reepInView = (el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 8 && r.top >= 8 && r.right <= innerWidth - 8 && r.bottom <= innerHeight - 8;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure); else ensure();
})();`;

// ---------------------------------------------------------------------------
// Driving helpers. Every visible action goes through these so the recording
// shows a cursor gliding to the control, a click pulse and real keystrokes.
// ---------------------------------------------------------------------------
/** What a caption should sound like: symbols become words, initialisms are spelt out. */
function speakable(text) {
  return String(text)
    .replace(/→/g, ' to ').replace(/←/g, ' from ').replace(/↔/g, ' and ')
    .replace(/\s·\s/g, ', ').replace(/·/g, ', ').replace(/×/g, ' by ').replace(/%/g, ' percent')
    .replace(/\s\/\s/g, ' or ').replace(/&/g, ' and ').replace(/—/g, ', ').replace(/–/g, ' to ')
    .replace(/\b1:1s?\b/g, 'one-to-one').replace(/\b(\d+):(\d{2})\b/g, '$1 $2')
    .replace(/\bSWOC\b/g, 'S W O C').replace(/\bUSN\b/g, 'U S N').replace(/\bTPO\b/g, 'T P O')
    .replace(/\bCGPA\b/g, 'C G P A').replace(/\bMBA\b/g, 'M B A').replace(/\bPDF\b/g, 'P D F')
    .replace(/\bCSV\b/g, 'C S V').replace(/\bBGSCET\b/g, 'B G S C E T').replace(/\bGD\b/g, 'G D')
    .replace(/\bHR\b/g, 'H R').replace(/\bVTU\b/g, 'V T U').replace(/\bAI\b/g, 'A I').replace(/\bREEP\b/g, 'REEP')
    .replace(/@/g, ' at ').replace(/\.ac\.in\b/g, ' dot a c dot in').replace(/\.mp4\b/g, '')
    .replace(/\b(\d)BG(\d\d)MDM(\d+)\b/g, 'U S N $1 B G $2 M D M $3')
    .replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

const narration = { items: [], pending: [], videoStart: 0, endsAt: 0, segment: '' };
const clipDir = () => path.join(OUT, 'narration', 'clips');

function synthesize(text) {
  if (!TTS_CMD) return null;
  const spoken = speakable(text);
  const file = path.join(clipDir(), createHash('sha1').update(spoken).digest('hex').slice(0, 16) + '.wav');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(clipDir(), { recursive: true });
    const cmd = TTS_CMD.replace('{out}', JSON.stringify(file));
    const job = new Promise((resolve) => {
      const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'inherit'] });
      child.on('exit', (code) => { if (code !== 0) console.log(`  narration failed (${code}): ${spoken.slice(0, 60)}`); resolve(); });
      child.on('error', () => resolve());
      child.stdin.end(spoken + '\n');
    });
    narration.pending.push(job);
  }
  return { file, spoken };
}

/** Log a spoken line at this moment of the video, and hold the next one until this one would have finished. */
async function narrate(page, text, { hold = true } = {}) {
  if (!TTS_CMD || !text) return 0;
  const now = Date.now();
  if (hold && now < narration.endsAt) await page.waitForTimeout(narration.endsAt - now + 200);
  const clip = synthesize(text);
  const words = clip.spoken.split(/\s+/).length;
  const seconds = 0.5 + words / WORDS_PER_SECOND;
  narration.items.push({ at: Date.now() - narration.videoStart, text: clip.spoken, file: path.basename(clip.file), estimate: seconds });
  narration.endsAt = Date.now() + seconds * 1000;
  return seconds;
}

async function say(page, k, m) {
  if (m) await narrate(page, m);
  await page.evaluate(([k, m]) => window.__reepSay?.(k, m), [k, m]).catch(() => {});
}
const hush = (page) => page.evaluate(() => window.__reepSay?.('', '')).catch(() => {});

async function card(page, title, sub, ms = 2800) {
  await zoomOut(page);
  const seconds = await narrate(page, `${title}. ${sub}`);
  await page.evaluate(([t, s]) => window.__reepCard?.(t, s, 'REEP · placement-readiness platform · live portal walkthrough'), [title, sub]).catch(() => {});
  await page.waitForTimeout(Math.max(ms, seconds * 1000 + 400));
  await page.evaluate(() => window.__reepCardOff?.()).catch(() => {});
  await page.waitForTimeout(500);
}

async function settle(page, ms = 2600) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

const ZOOM_MS = 950;
async function zoomTo(page, loc) {
  if (!(ZOOM > 1)) return;
  const el = loc.first();
  await el.evaluate((node, S) => window.__reepZoomTo?.(node, S), ZOOM).catch(() => {});
  await page.waitForTimeout(ZOOM_MS);
}
async function zoomOut(page) {
  const was = await page.evaluate(() => window.__reepZoomOut?.()).catch(() => false);
  if (was) await page.waitForTimeout(ZOOM_MS);
}
const isZoomed = (page) => page.evaluate(() => window.__reepZoomed?.()).catch(() => false);

/** Glide to a control and click it. Zooms back out first unless `keepZoom` and the control is inside the zoomed frame. */
async function clickAt(page, loc, { pauseAfter = 650, timeout = 15000, keepZoom = false } = {}) {
  const el = loc.first();
  await el.waitFor({ state: 'visible', timeout });
  if (await isZoomed(page)) {
    const inside = keepZoom && (await el.evaluate((node) => window.__reepInView?.(node)).catch(() => false));
    if (!inside) await zoomOut(page);
  }
  if (!(await isZoomed(page))) await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.move(box.x + Math.min(box.width / 2, 160), box.y + Math.min(box.height / 2, 22), { steps: 16 });
  }
  await page.waitForTimeout(240);
  await el.click({ timeout });
  await page.waitForTimeout(pauseAfter);
}

async function type(page, loc, text, { clear = false, delay = TYPE_DELAY } = {}) {
  await clickAt(page, loc, { pauseAfter: 160, keepZoom: true });
  await zoomTo(page, loc);
  if (clear) await loc.first().fill('');
  await loc.first().pressSequentially(text, { delay });
  await page.waitForTimeout(420);
}

async function fillDate(page, loc, iso) {
  await clickAt(page, loc, { pauseAfter: 160, keepZoom: true });
  await zoomTo(page, loc);
  await loc.first().fill(iso);
  await page.waitForTimeout(500);
}

async function pick(page, loc, option) {
  await clickAt(page, loc, { pauseAfter: 200, keepZoom: true });
  await zoomTo(page, loc);
  await loc.first().selectOption(option);
  await page.waitForTimeout(650);
}

/** Wheel-scroll the CONTENT: the wheel goes to whatever is under the cursor, and after a sidebar click that is the sidebar. */
async function scroll(page, dy, ms = 1500) {
  await zoomOut(page);
  await page.mouse.move(SIZE.width * 0.62, SIZE.height * 0.55, { steps: 10 });
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(ms);
}

async function go(page, route, ms = 2600) {
  await zoomOut(page);
  await page.goto(WEB + route, { waitUntil: 'domcontentloaded' });
  await settle(page, ms);
}

/** Click a sidebar row by its label, as a person would. */
async function nav(page, label) {
  const exact = page.getByRole('link', { name: label, exact: true });
  const loc = (await exact.count()) ? exact : page.locator('a', { hasText: label });
  await clickAt(page, loc);
  await settle(page, 2600);
}

const shots = new Set();
async function shot(page, name) {
  await zoomOut(page);
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'shots', `${name}.png`) });
  shots.add(name);
}

/** One step of a segment. A control that is missing must not end the video. */
async function step(page, name, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`  SKIP ${name}: ${String(err.message ?? err).split('\n').slice(0, 3).join(' | ')}`);
    await say(page, '', '');
  }
}

async function signIn(page, who, caption) {
  await go(page, '/login', 900);
  if (caption) await say(page, 'Sign in', caption);
  if (!shots.has('login')) await shot(page, 'login');
  if (who.portal === 'admin') {
    await clickAt(page, page.locator('button.main-admin'));
  } else {
    const portal = page.locator('.portal', { has: page.locator('.portal__label', { hasText: new RegExp('^' + who.portal + '$') }) });
    await clickAt(page, portal);
  }
  await type(page, page.locator('input[formcontrolname="id"]'), who.email);
  await type(page, page.locator('input[formcontrolname="password"]'), who.password);
  await clickAt(page, page.locator('button[type="submit"]', { hasText: 'Sign in' }));
  await page.waitForURL(who.home, { timeout: 25000 });
  await settle(page, 1800);
}

async function signOut(page) {
  await hush(page);
  const candidates = page.locator('button, a').filter({ hasText: /sign out/i });
  const visibleOne = async () => {
    const n = await candidates.count();
    for (let i = 0; i < n; i++) if (await candidates.nth(i).isVisible()) return candidates.nth(i);
    return null;
  };
  let target = await visibleOne();
  if (!target) {
    // The staff and alumni shells keep Sign out inside the account menu.
    await clickAt(page, page.locator('.account__button').first(), { pauseAfter: 800 });
    target = await visibleOne();
  }
  if (!target) throw new Error('no visible Sign out control');
  await clickAt(page, target);
  await page.waitForURL(/\/login/, { timeout: 15000 });
  await settle(page, 600);
}

// ---------------------------------------------------------------------------
// Reading mail off the API log. With no SES identity the transport logs every
// message in full: "MAIL (no transport configured) to=<addr> subject='<s>'\n<text>".
// ---------------------------------------------------------------------------
function readMail(to, subjectPart) {
  if (!API_LOG || !fs.existsSync(API_LOG)) return null;
  const text = fs.readFileSync(API_LOG, 'utf8');
  const marker = `to=${to} subject=`;
  let pos = text.length;
  for (;;) {
    const idx = text.lastIndexOf(marker, pos);
    if (idx < 0) return null;
    const chunk = text.slice(idx, idx + 2000);
    if (chunk.includes(subjectPart)) return chunk;
    pos = idx - 1;
    if (pos < 0) return null;
  }
}

async function waitForMail(to, subjectPart, seen = null) {
  for (let i = 0; i < 40; i++) {
    const m = readMail(to, subjectPart);
    if (m && m !== seen) return m;
    await sleep(500);
  }
  throw new Error(`no mail to ${to} with subject containing "${subjectPart}" in ${API_LOG}`);
}

// ---------------------------------------------------------------------------
// Shared flows, used by more than one segment.
// ---------------------------------------------------------------------------
async function claimSkill(page, { file, categoryIndex = 1, badgeIndexes = [1, 2, 3], issuer, note }) {
  await attach(page, page.locator('button.cert-drop'), page.locator('input[type="file"][accept*="pdf"]'), file);
  const category = page.locator('select').filter({ has: page.locator('option', { hasText: /select a category/i }) }).first();
  await category.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction((el) => el.options.length > 1, await category.elementHandle());
  await pick(page, category, { index: categoryIndex });
  const badge = page.locator('select').filter({ has: page.locator('option', { hasText: /select a badge/i }) }).first();
  await page.waitForFunction((el) => el.options.length > 1, await badge.elementHandle());
  const labels = await badge.locator('option').allInnerTexts();
  for (const i of badgeIndexes) {
    if (i >= labels.length) continue;
    await pick(page, badge, { index: i });
    if (!(await page.locator('input[placeholder^="e.g. NISM"]').inputValue())) {
      await type(page, page.locator('input[placeholder^="e.g. NISM"]'), issuer);
      await type(page, page.locator('input[placeholder^="Optional"]'), note);
    }
    await clickAt(page, page.getByRole('button', { name: /submit claim/i }));
    await page.waitForTimeout(1600);
    if (await page.locator('.claim-done').count()) return labels[i].trim();
  }
  throw new Error('no badge accepted the claim');
}

async function verifyClaim(page, { note, badge = loadState().lastClaim }) {
  const buttons = page.locator('.btn.primary', { hasText: /review evidence|open/i });
  await buttons.first().waitFor({ state: 'visible', timeout: 20000 });
  let index = 0;
  if (badge) {
    const names = await page.locator('strong:has(+ .claim-lvl)').allInnerTexts();
    const claims = names.filter((n) => n.trim().length > 0);
    const i = claims.findIndex((n) => n.trim() === badge.trim());
    if (i >= 0 && i < (await buttons.count())) index = i;
  }
  await clickAt(page, buttons.nth(index));
  await page.waitForTimeout(900);
  await type(page, page.locator('input[placeholder^="e.g. The certificate"]').first(), note);
  await clickAt(page, page.getByRole('button', { name: /^\s*verified\s*Verify\s*$|^\s*Verify\s*$/ }).first());
  await settle(page, 1500);
}

async function requestMeeting(page, reason, when) {
  await clickAt(page, page.getByRole('button', { name: /request a meeting/i }));
  await type(page, page.locator('#mtg-reason'), reason);
  await type(page, page.locator('#mtg-when'), when);
  await clickAt(page, page.getByRole('button', { name: /send request/i }));
  await settle(page, 1500);
}

async function logMeetingNote(page, { studentName, title, note }) {
  await clickAt(page, page.locator('button.ml-row', { hasText: studentName }));
  await settle(page, 1200);
  await type(page, page.locator('input[placeholder="1:1 review"]'), title);
  await pick(page, page.locator('.ml-compose select').first(), { index: 1 });
  await type(page, page.locator('.ml-compose textarea'), note);
  await clickAt(page, page.getByRole('button', { name: /save note/i }));
  await settle(page, 1400);
}

async function applyForLeave(page, { from, to, purpose, credit }) {
  await clickAt(page, page.getByRole('button', { name: /new|apply|request/i }).first());
  await page.waitForTimeout(900);
  await clickAt(page, page.getByRole('button', { name: /^Casual Leave$/ }).first());
  await fillDate(page, page.locator('input[aria-label="From date"]'), from);
  await fillDate(page, page.locator('input[aria-label="To date"]'), to);
  await type(page, page.locator('textarea[aria-label="Purpose"]'), purpose);
  await type(page, page.locator('input[aria-label="Credit"]'), credit);
  await clickAt(page, page.getByRole('button', { name: /sign & submit/i }));
  await settle(page, 1800);
}

async function sanctionLeave(page, { requester, remarks }) {
  await clickAt(page, page.locator('tr.queue-row', { hasText: requester }).first());
  await settle(page, 1200);
  await clickAt(page, page.locator('.queue-panel .btn.primary').first());
  await page.waitForTimeout(700);
  await type(page, page.locator('#leave-remarks'), remarks);
  await clickAt(page, page.locator('.queue-panel .btn.primary', { hasText: /confirm|sanction|approve/i }).first());
  await settle(page, 1600);
  await scroll(page, -900, 600);
}

async function addSwocLine(page, { studentName, quadrant, text }) {
  await type(page, page.locator('input[placeholder="Name, USN or batch"]'), studentName.split(' ')[0]);
  await clickAt(page, page.locator('button', { hasText: studentName }).first());
  await settle(page, 1200);
  const order = ['STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'CHALLENGE'];
  const adds = page.locator('button.btn.ghost', { hasText: /^\s*add\s*Add\s*$|^\s*Add\s*$/ });
  await adds.first().waitFor({ state: 'visible', timeout: 15000 });
  await clickAt(page, adds.nth(order.indexOf(quadrant)));
  await type(page, page.locator('textarea[id^="sw-draft-"]').first(), text);
  await clickAt(page, page.locator('.sw-composer__foot .btn.primary'));
  await settle(page, 1400);
}

async function postJob(page, job) {
  await clickAt(page, page.getByRole('button', { name: /new posting|post a job|add posting/i }).first());
  await page.waitForTimeout(800);
  await type(page, page.locator('#jobs-title'), job.title);
  await type(page, page.locator('#jobs-company'), job.company);
  await type(page, page.locator('#jobs-location'), job.location);
  await pick(page, page.locator('#jobs-level'), { label: job.level });
  await fillDate(page, page.locator('#jobs-deadline'), job.deadline);
  await type(page, page.locator('#jobs-tracks'), job.tracks);
  await type(page, page.locator('#jobs-apply-url'), job.url);
  await clickAt(page, page.getByRole('button', { name: /publish/i }).first());
  await settle(page, 1600);
  await scroll(page, -900, 600);
}

async function optionValue(loc, text) {
  const options = await loc.locator('option').evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.textContent.trim() })));
  const hit = options.find((o) => o.text.includes(text));
  return hit ? hit.value : null;
}

async function grantFunction(page, { person, access, fallbackAccess = 'Analytics', reason }) {
  const user = page.locator('#gov-user');
  await user.waitFor({ state: 'visible', timeout: 15000 });
  await pick(page, user, await optionValue(user, person));
  await clickAt(page, page.locator('button', { hasText: /^\s*Add\s*$/ }).first());
  const fn = page.locator('#gov-function');
  await pick(page, fn, (await optionValue(fn, access)) ?? (await optionValue(fn, fallbackAccess)));
  await type(page, page.locator('#gov-reason'), reason);
  await clickAt(page, page.locator('.btn.primary', { hasText: /give access|grant/i }).first());
  await settle(page, 1600);
  await scroll(page, -1200, 800);
}

async function approveApplication(page, name) {
  const row = page.locator('.ag-row', { hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  const cell = row.locator('.ag-cell').nth(1);
  await clickAt(page, cell);
  await settle(page, 1300);
  await clickAt(page, page.locator('.btn.primary', { hasText: /approve/i }).last());
  await settle(page, 2000);
}

async function assignFaculty(page, { mentorName, studentName, reason }) {
  await clickAt(page, page.locator('button.mentor-row', { hasText: mentorName }).first());
  await settle(page, 1000);
  const row = page.locator('.pool-grid .ag-row', { hasText: studentName }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  const box = row.locator('.ag-selection-checkbox, .ag-checkbox-input-wrapper, input[type="checkbox"]').first();
  await clickAt(page, (await box.count()) ? box : row);
  await type(page, page.locator('#assign-reason'), reason);
  await clickAt(page, page.locator('.assign-bar .btn.primary, .assign-bar button', { hasText: /assign|seat/i }).first());
  await settle(page, 1600);
}


/** Attach a file the way a person does: click the picker, choose the file. Falls back to the input. */
async function attach(page, buttonLoc, inputLoc, file) {
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 6000 }),
      clickAt(page, buttonLoc, { pauseAfter: 200, timeout: 6000 }),
    ]);
    await chooser.setFiles(file);
  } catch {
    await inputLoc.first().setInputFiles(file);
  }
  await page.waitForTimeout(800);
}

async function openOrb(page) {
  await clickAt(page, page.locator('app-agent-orb button').first(), { pauseAfter: 900 });
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------
async function segStudent(page) {
  await go(page, '/login', 600);
  await card(page, 'Student portal', 'Sign in · Home · Jobs · Skilling · Leaderboards · Time Sheet · Faculty / TPO Log · Resume Builder · the assistant and the mock interviewer');
  await signIn(page, STUDENT, 'One front door for every role. A student signs in with the college address (or USN) and a password, or with Google.');
  await step(page, 'home', async () => {
    await say(page, 'Home', 'Readiness score, the Reboot → Excel → Elevate stages, recommendations, and the SWOC lines faculty and the office wrote for this student.');
    await shot(page, 'student-home');
    await scroll(page, 380); await shot(page, 'student-home-swoc'); await scroll(page, 600); await scroll(page, 600); await scroll(page, -1600, 700);
  });
  await step(page, 'jobs', async () => {
    await nav(page, 'Jobs');
    await say(page, 'Jobs', 'Every posting the placement office published, with this student\'s match % and eligibility verdict against the criteria.');
    await shot(page, 'student-jobs'); await scroll(page, 500); await scroll(page, -500, 600);
  });
  await step(page, 'skilling', async () => {
    await nav(page, 'Skilling');
    await say(page, 'Skilling', 'The badge board: managerial, sectoral, platform and thinking skills. Earned badges are lit; a claim in review wears a clock.');
    await shot(page, 'student-skilling');
    await scroll(page, 700); await scroll(page, 700); await scroll(page, -1400, 600);
    await say(page, 'Claim a skill', 'Upload the certificate, pick the badge it proves, name the issuer — the claim goes to the mentor\'s verification queue.');
    const badge = await claimSkill(page, { file: asset('certificate-power-bi.pdf'), categoryIndex: 3, badgeIndexes: [2, 3, 4, 1], issuer: 'Coursera', note: 'Business Analytics with Power BI, completed 12 Sep 2026.' });
    console.log('  claimed badge:', badge);
    saveState({ lastClaim: badge });
    await say(page, 'Claim submitted', 'The certificate is filed under Uploads and the claim now waits in the mentor\'s Skill Verifications.');
    await shot(page, 'student-claim-submitted');
    await page.waitForTimeout(1600);
  });
  await step(page, 'leaderboards', async () => {
    await nav(page, 'Leaderboards');
    await say(page, 'Leaderboards', 'Points, badges and Most Improved (growth between assessment checkpoints). A student can opt out.');
    await shot(page, 'student-leaderboards'); await scroll(page, 500); await scroll(page, -500, 600);
  });
  await step(page, 'time sheet', async () => {
    await nav(page, 'Time Sheet');
    await say(page, 'Time Sheet', 'The Time Allocation Ledger: six slots across the day × five activity heads, in half hours. The day must add to exactly 24 h before it can be submitted.');
    await shot(page, 'student-timesheet');
    const open = page.locator('tr', { hasText: /h open/ }).first();
    if (await open.count()) {
      const cell = open.locator('input[type="number"]').first();
      const current = Number((await cell.inputValue()) || 0);
      await say(page, 'Reconcile the day', 'Half an hour is unaccounted for. Type it into the open slot, save the draft, then submit — a submitted day is read-only.');
      await type(page, cell, String(current + 0.5), { clear: true, delay: 120 });
      await page.waitForTimeout(400);
      await clickAt(page, page.getByRole('button', { name: /save draft/i }));
      await settle(page, 1200);
      await clickAt(page, page.getByRole('button', { name: /submit day/i }));
      await settle(page, 1500);
      await shot(page, 'student-timesheet-submitted');
    }
  });
  await step(page, 'mentor log', async () => {
    await nav(page, 'Faculty / TPO Log');
    await say(page, 'Faculty / TPO Log', 'Every 1:1 the mentor recorded about this student, in the student\'s own words — and a button to ask for the next one.');
    await shot(page, 'student-mentor-log');
    await requestMeeting(page, 'GD delivery before the mock interview next month', 'Thursday afternoon');
    await say(page, 'Request sent', 'The request lands on the mentor\'s Mentee Log as a note, so both sides hold the same record.');
    await shot(page, 'student-meeting-requested');
    await page.waitForTimeout(1500);
  });
  await step(page, 'resume', async () => {
    await nav(page, 'Resume Builder');
    await say(page, 'Resume Builder', 'The placement resume, composed from the record and rendered to PDF locally — a student\'s marks never leave the machine unbidden.');
    await shot(page, 'student-resume'); await scroll(page, 600); await scroll(page, 600); await scroll(page, -1200, 600);
  });
  await step(page, 'uploads', async () => {
    await go(page, '/student/uploads');
    await say(page, 'Uploads', 'Every document attached — marksheets, certificates, the claim\'s certificate — with its review status from the mentor.');
    await shot(page, 'student-uploads');
  });
  await step(page, 'profile', async () => {
    await go(page, '/student/profile');
    await say(page, 'Profile', 'The institution card is read through the College → Department → Course → Specialization → Batch spine; nothing is typed twice.');
    await shot(page, 'student-profile'); await scroll(page, 500); await scroll(page, -500, 500);
  });
  await step(page, 'records', async () => {
    await go(page, '/student/records');
    await say(page, 'Records', 'Marks, attendance and results exactly as the office imported them from the spreadsheets.');
    await shot(page, 'student-records');
  });
  await step(page, 'english', async () => {
    await go(page, '/student/english');
    await say(page, 'English baseline', 'CEFR-aligned and AI-scored, one attempt per semester. A section not yet scored is a dash, never a zero.');
    await shot(page, 'student-english');
  });
  await step(page, 'interviews', async () => {
    await go(page, '/student/interviews');
    await say(page, 'Interviews', 'Past mock interviews: the transcript, the phase reached and the practice report with its scorecard.');
    await shot(page, 'student-interviews');
  });
  await step(page, 'courses', async () => {
    await go(page, '/student/courses');
    await say(page, 'Courses', 'The taught subjects and what is due next.');
    await shot(page, 'student-courses');
  });
  await step(page, 'assistant', async () => {
    await go(page, '/student');
    await say(page, 'The assistant', 'The floating orb on every screen opens the dock: Ask REEP (the grounded, typed agent) and the Mock interview room.');
    await openOrb(page);
    await settle(page, 1200);
    await shot(page, 'student-dock');
    const box = page.locator('textarea[placeholder^="Message the REEP Agent"]').first();
    await type(page, box, 'Which open jobs am I eligible for?');
    await page.keyboard.press('Enter');
    await settle(page, 3500);
    await say(page, 'Ask REEP', 'It answers from the approved Knowledge Base and this student\'s own record, with the sources it used and buttons to act.');
    await shot(page, 'student-agent-answer');
    await page.waitForTimeout(1500);
    const tab = page.locator('button.dock__tab', { hasText: 'Mock interview' });
    if (await tab.count()) {
      await clickAt(page, tab);
      await settle(page, 1500);
      await say(page, 'Mock interview', 'A speech-to-speech interviewer (Amazon Nova 2 Sonic) that runs a real campus-round arc and scores it. Consent is asked before anything is stored.');
      await page.waitForTimeout(1800);
      const round = page.locator('button', { hasText: /^\s*Analytics\s*$/ }).first();
      if (await round.count()) {
        await clickAt(page, round, { pauseAfter: 900 });
        await say(page, 'Mock interview', 'Pick the round: HR, Marketing, Analytics or Finance. The track is preselected from the student\'s batch; a scored report needs a track.');
      }
      await shot(page, 'student-mock-interview');
      await page.waitForTimeout(2400);
    }
    await openOrb(page);
  });
  await step(page, 'sign out', async () => { await signOut(page); });
}

async function segFaculty(page) {
  await go(page, '/login', 600);
  await card(page, 'Faculty portal', 'Notebook · Mentee Log · Skill Verifications · Leave Requests · Upskilling · Signature — every mentee screen is scoped to the faculty member\'s own group');
  await signIn(page, FACULTY, 'A faculty member signs in through the Faculty portal. What they can see is decided by role and by the mentor group the office assigned.');
  await step(page, 'notebook', async () => {
    await say(page, 'Notebook', 'The faculty notebook: a private log per mentee — what was discussed, the agreed action and a remark.');
    await shot(page, 'faculty-notebook');
    const sel = page.locator('select.nb-select');
    await page.waitForFunction((el) => el && !el.disabled && el.options.length > 0 && !/loading/i.test(el.options[0].text), await sel.elementHandle());
    await pick(page, sel, { index: 0 });
    await settle(page, 900);
    await clickAt(page, page.getByRole('button', { name: /add entry/i }));
    await page.waitForTimeout(700);
    await fillDate(page, page.locator('input[type="date"]').first(), '2026-09-17');
    await type(page, page.locator('input[placeholder="What was discussed"]'), 'Reviewed the Power BI certificate claim and the mock interview report');
    await type(page, page.locator('input[placeholder="Agreed action"]'), 'Practise two STAR answers before the next mock');
    await pick(page, page.locator('select').nth(1), { index: 1 });
    await clickAt(page, page.getByRole('button', { name: /save entry/i }));
    await settle(page, 1400);
    await shot(page, 'faculty-notebook-saved');
  });
  await step(page, 'mentee log', async () => {
    await nav(page, 'Mentee Log');
    await say(page, 'Mentee Log', 'Only this faculty member\'s mentees (rule 2). The student\'s meeting request is already here; the note written back is what the student reads.');
    await shot(page, 'faculty-mentee-log');
    await logMeetingNote(page, { studentName: 'Test Student', title: '1:1 · GD delivery plan', note: 'Met for 30 minutes. Agreed a weekly GD practice slot on Thursdays and a mock on the 30th. Student to bring two current-affairs topics.' });
    await say(page, 'Note saved', 'The heading, the linked action and the note appear on the student\'s Faculty / TPO Log within seconds.');
    await shot(page, 'faculty-note-saved');
    await page.waitForTimeout(1500);
  });
  await step(page, 'verifications', async () => {
    await nav(page, 'Skill Verifications');
    await say(page, 'Skill Verifications', 'The claims from this group\'s students, each with the certificate attached. Verify lights the badge; Request changes and Reject require a note the student is emailed.');
    await shot(page, 'faculty-verifications');
    await verifyClaim(page, { note: 'Certificate checked against the Coursera credential ID.' });
    await say(page, 'Verified', 'One decision writes both rows: the badge is EARNED and the certificate in Uploads is marked VERIFIED.');
    await shot(page, 'faculty-verified');
    await page.waitForTimeout(1500);
  });
  await step(page, 'leave', async () => {
    await nav(page, 'Leave Requests');
    await say(page, 'Leave Requests', 'The college\'s own leave form, filled on screen. Sign & submit sends it to the Main Admin, and the paper PDF carries both signatures.');
    await shot(page, 'faculty-leave');
    await applyForLeave(page, { from: '2026-09-24', to: '2026-09-25', purpose: 'Attending the AICTE faculty development programme on placement mentoring at RVCE, Bengaluru.', credit: '2 days' });
    await say(page, 'Submitted', 'Status: awaiting the Main Admin. The balance table and the cover request are on the same screen.');
    await shot(page, 'faculty-leave-submitted');
    await page.waitForTimeout(1500);
  });
  await step(page, 'upskilling', async () => {
    await nav(page, 'Upskilling');
    await say(page, 'Upskilling', 'The faculty member\'s own completed-course certificates: a record on the shelf, not evidence awaiting a verdict.');
    await shot(page, 'faculty-upskilling');
    await type(page, page.locator('input[placeholder^="e.g. Business Analytics"]'), 'Teaching with Case Studies');
    await type(page, page.locator('input[placeholder^="Coursera, NPTEL"]'), 'NPTEL');
    await fillDate(page, page.locator('input[type="date"]').first(), '2026-08-30');
    await attach(page, page.locator('.btn.primary', { hasText: /choose|upload|add|certificate/i }).first(), page.locator('input[type="file"]'), asset('certificate-faculty-nptel.pdf'));
    await settle(page, 1800);
    await shot(page, 'faculty-upskilling-added');
  });
  await step(page, 'signature', async () => {
    await go(page, '/mentor/signature');
    await say(page, 'Signature', 'One signature image, normalised on upload, drawn above the name and time on every leave paper this person signs.');
    await shot(page, 'faculty-signature');
    await attach(page, page.locator('.sg-file, label:has(input[type="file"])').first(), page.locator('input[type="file"]'), asset('signature-kavya.png'));
    await settle(page, 1800);
    await shot(page, 'faculty-signature-uploaded');
  });
  await step(page, 'account', async () => {
    await go(page, '/account');
    await say(page, 'My account', 'Sign-in security, this device (one live session per account), the signature and the email digests.');
    await shot(page, 'faculty-account');
  });
  await step(page, 'sign out', async () => { await signOut(page); });
}

async function segAdmin(page) {
  await go(page, '/login', 600);
  await card(page, 'Main Admin console', 'Home · New applications · Students & batches · Faculty · Assign faculty · Leave · Jobs · Placement · Reports · Interviews · SWOC · College setup · Who can do what · Audit');
  await signIn(page, ADMIN, 'The placement office is ONE account. The dashed Main Admin door selects the admin portal; the role on the account decides what opens.');
  await step(page, 'home', async () => {
    await say(page, 'Home', 'What is waiting — applications, leave, students without a faculty member, offers, access reviews — and every screen as a task button.');
    await shot(page, 'admin-home'); await scroll(page, 500); await scroll(page, -500, 600);
  });
  await step(page, 'registrations', async () => {
    await nav(page, 'New applications');
    await say(page, 'New applications', 'The review queue. Rules route each application; the checklist warns about a missing CV or a prior application. Approve provisions the account and emails the setup link.');
    await shot(page, 'admin-registrations');
    await approveApplication(page, 'Ravi Kumar');
    await say(page, 'Approved', 'Ravi Kumar now has a student account and a three-step setup link in his mailbox. Reject would have required a reason, which is emailed.');
    await shot(page, 'admin-registration-approved');
    await page.waitForTimeout(1500);
  });
  await step(page, 'students', async () => {
    await nav(page, 'Students & batches');
    await say(page, 'Students & batches', 'The roster: edit a student, act on a whole batch (move, assign faculty, set stage or semester), remove-and-restore. No admin-side create — approval is the only way onto the roster.');
    await shot(page, 'admin-students');
    const eye = page.locator('button[aria-label*="View" i], a[aria-label*="View" i], .ag-row button:has-text("visibility")').first();
    if (await eye.count()) {
      await clickAt(page, eye);
      await settle(page, 1500);
      await say(page, 'Student 360', 'One student across every semester: profile, results, attendance, documents, mentor history and interviews.');
      await shot(page, 'admin-student-360');
      await scroll(page, 600); await scroll(page, -600, 500);
    }
  });
  await step(page, 'faculty', async () => {
    await nav(page, 'Faculty');
    await say(page, 'Faculty', 'Every faculty account, its group size and functions. Add faculty member mints the account and shows the activation link to hand over.');
    await shot(page, 'admin-faculty');
  });
  await step(page, 'assign', async () => {
    await nav(page, 'Assign faculty');
    await say(page, 'Assign faculty', 'A faculty account is not a mentor by existing: seating a student here creates the group, and the mentor_id is what rule 2 filters on. Every move needs a reason.');
    await shot(page, 'admin-assign');
    await assignFaculty(page, { mentorName: 'Test Mentor', studentName: 'Ravi Kumar', reason: 'New admit; same department as the existing group.' });
    await shot(page, 'admin-assigned');
  });
  await step(page, 'leave approvals', async () => {
    await nav(page, 'Leave requests');
    await say(page, 'Leave requests', 'The faculty leave queue. One signature — the Main Admin\'s — sanctions it; the college form PDF then carries both signatures.');
    await shot(page, 'admin-leave');
    await sanctionLeave(page, { requester: 'Test Mentor', remarks: 'Sanctioned; classes covered by the department.' });
    await say(page, 'Sanctioned', 'The request is APPROVED and the paper PDF is ready for both the applicant and the office.');
    await shot(page, 'admin-leave-sanctioned');
    await page.waitForTimeout(1500);
  });
  await step(page, 'jobs', async () => {
    await nav(page, 'Job postings');
    await say(page, 'Job postings', 'The jobs sheet. A published posting reaches every eligible student\'s Jobs screen with a match % computed from their record.');
    await shot(page, 'admin-jobs');
    await postJob(page, { title: 'Business Analyst (Campus 2026)', company: 'Infosys BPM', location: 'Bengaluru', level: 'PG', deadline: '2026-10-15', tracks: 'BA, FA', url: 'https://careers.example.com/ba-campus-2026' });
    await shot(page, 'admin-job-published');
  });
  await step(page, 'placement', async () => {
    await nav(page, 'Placement & offers');
    await say(page, 'Placement & offers', 'Offers per student and per company, and the placement criteria the eligibility verdicts are read against.');
    await shot(page, 'admin-placement');
  });
  await step(page, 'exports', async () => {
    await nav(page, 'Download reports');
    await say(page, 'Download reports', 'CSV exports of the roster, readiness and offers. Every download writes a receipt on the audit trail.');
    await shot(page, 'admin-exports');
  });
  await step(page, 'imports', async () => {
    await nav(page, 'Upload spreadsheets');
    await say(page, 'Upload spreadsheets', 'Attendance and marks arrive as the examination section sends them: an .xlsx, previewed row by row before it is applied.');
    await shot(page, 'admin-imports');
  });
  await step(page, 'interview questions', async () => {
    await nav(page, 'Interview questions');
    await say(page, 'Interview questions', 'The question bank per interview track. The interviewer rephrases rather than recites, so rows are guidance, not a script.');
    await shot(page, 'admin-interview-questions');
  });
  await step(page, 'interview records', async () => {
    await nav(page, 'Interview records');
    await say(page, 'Interview records', 'Every mock interview with the student named: transcript, report, score over time, and the college\'s storage policy card.');
    await shot(page, 'admin-interview-records');
  });
  await step(page, 'swoc', async () => {
    await nav(page, 'SWOC notes');
    await say(page, 'SWOC notes', 'Strengths, Weaknesses, Opportunities, Challenges — the four lines on each student\'s Home, with author, semester and whether the student has read them.');
    await shot(page, 'admin-swoc');
    await addSwocLine(page, { studentName: 'Test Student', quadrant: 'OPPORTUNITY', text: 'Infosys BPM campus drive on 15 Oct — profile fits the Business Analyst role.' });
    await shot(page, 'admin-swoc-added');
  });
  await step(page, 'setup', async () => {
    await nav(page, 'Set up a college');
    await say(page, 'Set up a college', 'The institutional spine typed once: college → departments → courses → specializations → one batch per leaf, created in one press.');
    await shot(page, 'admin-setup');
  });
  await step(page, 'colleges', async () => {
    await nav(page, 'Colleges');
    await say(page, 'Colleges', 'Each college as a card with its facts, the email domains that may hold accounts, and an Appoint action for a college admin.');
    await shot(page, 'admin-colleges');
  });
  await step(page, 'institution', async () => {
    await nav(page, 'College structure');
    await say(page, 'College structure', 'See and change what exists: departments, courses, specializations, batches, seating, and the mock-interview track mapping.');
    await shot(page, 'admin-institution'); await scroll(page, 600); await scroll(page, -600, 500);
  });
  await step(page, 'catalogue', async () => {
    await nav(page, 'Catalogue');
    await say(page, 'Catalogue', 'Courses and the Approved Certification Catalogue that badge claims and readiness read.');
    await shot(page, 'admin-catalogue');
  });
  await step(page, 'governance', async () => {
    await nav(page, 'Who can do what');
    await say(page, 'Who can do what', 'Access is a decision with a reach, a reason and an expiry. Grant a console screen to a faculty member here; revoke it the same hour.');
    await shot(page, 'admin-governance');
    await scroll(page, 900); await page.waitForTimeout(600);
    await grantFunction(page, { person: 'Test Mentor', access: 'Interview records', reason: 'Runs the mock-interview practice sessions for the MBA batch this semester.' });
    await say(page, 'Granted', 'The row is live at once for the Main Admin\'s own grants; the faculty sidebar gains the screen under Granted access.');
    await shot(page, 'admin-granted');
    await page.waitForTimeout(1400);
  });
  await step(page, 'audit', async () => {
    await nav(page, 'What changed');
    await say(page, 'What changed', 'The audit trail: every write the console made, by whom, with the before and after.');
    await shot(page, 'admin-audit');
  });
  await step(page, 'analytics', async () => {
    await nav(page, 'Charts & numbers');
    await say(page, 'Charts & numbers', 'Programme analytics: readiness distribution, attendance, offers and alerts, aggregated on the server.');
    await shot(page, 'admin-analytics'); await scroll(page, 600); await scroll(page, -600, 500);
  });
  await step(page, 'sign out', async () => { await signOut(page); });
}

async function segAlumni(page) {
  await go(page, '/login', 600);
  await card(page, 'Alumni portal', 'A real role with no student record: a profile, a resume, and the jobs sheet without the student-only match %');
  await signIn(page, ALUMNI, 'An alumnus signs in through the Alumni portal.');
  await step(page, 'profile', async () => {
    await say(page, 'My Profile', 'On first sign-in there is no profile row, so the create form appears: current company, designation, batch year and a resume.');
    await shot(page, 'alumni-profile-create');
    await type(page, page.locator('input[placeholder="e.g. Infosys"]'), 'Deloitte India');
    await type(page, page.locator('input[placeholder="e.g. Business Analyst"]'), 'Senior Analyst');
    await fillDate(page, page.locator('input[type="date"]').first(), '2025-07-14');
    await type(page, page.locator('input[placeholder="e.g. 2025"]'), '2025');
    await attach(page, page.locator('.dt-btn', { hasText: /choose|resume|upload|pdf/i }).first(), page.locator('input[type="file"]'), asset('resume-test-alumnus.pdf'));
    await clickAt(page, page.getByRole('button', { name: /create my profile|save/i }).first());
    await settle(page, 1600);
    await shot(page, 'alumni-profile');
  });
  await step(page, 'jobs', async () => {
    await nav(page, 'Jobs Sheet');
    await say(page, 'Jobs Sheet', 'The same postings the office published — without the match % and eligibility verdict, which need a student\'s marks.');
    await shot(page, 'alumni-jobs');
  });
  await step(page, 'sign out', async () => { await signOut(page); });
}

async function segInterlinked(page) {
  await go(page, '/login', 600);
  await card(page, 'One workflow, three portals', 'A student claims a skill and asks for a meeting · the mentor verifies and records · the office writes SWOC and posts a job · it all lands back on the student\'s screens', 3400);
  // 1. student
  await signIn(page, STUDENT, 'Step 1 — the STUDENT signs in.');
  await step(page, 'student claim', async () => {
    await nav(page, 'Skilling');
    await say(page, '1 · Student', 'Claims a skill: uploads the certificate and picks the badge it proves.');
    const badge = await claimSkill(page, { file: asset('certificate-negotiation.pdf'), categoryIndex: 1, badgeIndexes: [3, 4, 5, 2, 1], issuer: 'Internal assessment', note: 'Negotiation skills workshop, September 2026.' });
    console.log('  interlinked claim:', badge);
    saveState({ lastClaim: badge });
    await shot(page, 'flow-1-claim');
    await page.waitForTimeout(1200);
  });
  await step(page, 'student request', async () => {
    await nav(page, 'Faculty / TPO Log');
    await say(page, '1 · Student', 'Asks the mentor for a 1:1 from the Faculty / TPO Log.');
    await requestMeeting(page, 'Placement season plan — which companies to target first', 'Any morning next week');
    await shot(page, 'flow-1-request');
  });
  await signOut(page);
  // 2. mentor
  await signIn(page, FACULTY, 'Step 2 — the MENTOR signs in.');
  await step(page, 'mentor verify', async () => {
    await nav(page, 'Skill Verifications');
    await say(page, '2 · Mentor', 'The claim is waiting. The certificate opens from the row; Verify lights the badge.');
    await shot(page, 'flow-2-queue');
    await verifyClaim(page, { note: 'Workshop attendance confirmed with the trainer.' });
    await shot(page, 'flow-2-verified');
    await page.waitForTimeout(1000);
  });
  await step(page, 'mentor note', async () => {
    await nav(page, 'Mentee Log');
    await say(page, '2 · Mentor', 'The meeting request is on the Mentee Log. The mentor logs the meeting — the student reads exactly this.');
    await logMeetingNote(page, { studentName: 'Test Student', title: 'Placement season plan', note: 'Target the analytics roles first: Infosys BPM (BA) and the two FA openings. Resume to be updated with the Power BI badge by Friday.' });
    await shot(page, 'flow-2-note');
    await page.waitForTimeout(1000);
  });
  await step(page, 'mentor leave', async () => {
    await nav(page, 'Leave Requests');
    await say(page, '2 · Mentor', 'Applies for leave on the college form; it goes to the Main Admin for sanction.');
    await applyForLeave(page, { from: '2026-10-05', to: '2026-10-05', purpose: 'Placement coordinators\' meeting at the university.', credit: '1 day' });
    await shot(page, 'flow-2-leave');
  });
  await signOut(page);
  // 3. office
  await signIn(page, ADMIN, 'Step 3 — the MAIN ADMIN signs in.');
  await step(page, 'admin swoc', async () => {
    await nav(page, 'SWOC notes');
    await say(page, '3 · Main Admin', 'Writes an Opportunity line for the student; it appears on the student\'s Home.');
    await addSwocLine(page, { studentName: 'Test Student', quadrant: 'STRENGTH', text: 'Verified negotiation and Power BI badges — a strong profile for analyst roles.' });
    await shot(page, 'flow-3-swoc');
  });
  await step(page, 'admin job', async () => {
    await nav(page, 'Job postings');
    await say(page, '3 · Main Admin', 'Publishes a posting; every eligible student sees it with a match %.');
    await postJob(page, { title: 'Financial Analyst Trainee', company: 'Acme Capital', location: 'Bengaluru', level: 'PG', deadline: '2026-10-20', tracks: 'FA', url: 'https://careers.example.com/fa-trainee' });
    await shot(page, 'flow-3-job');
  });
  await step(page, 'admin sanction', async () => {
    await nav(page, 'Leave requests');
    await say(page, '3 · Main Admin', 'Sanctions the mentor\'s leave with one signature.');
    await sanctionLeave(page, { requester: 'Test Mentor', remarks: 'Sanctioned.' });
    await shot(page, 'flow-3-leave');
  });
  await signOut(page);
  // 4. student sees it all
  await signIn(page, STUDENT, 'Step 4 — back to the STUDENT.');
  await step(page, 'student sees', async () => {
    await say(page, '4 · Student', 'Home carries the new SWOC line from the office.');
    await scroll(page, 380);
    await shot(page, 'flow-4-home');
    await page.waitForTimeout(1200);
    await nav(page, 'Skilling');
    await say(page, '4 · Student', 'The verified badge is lit on the board with the mentor\'s blue tick.');
    await scroll(page, 700); await scroll(page, 700);
    await shot(page, 'flow-4-badge');
    await page.waitForTimeout(1500);
    await nav(page, 'Faculty / TPO Log');
    await say(page, '4 · Student', 'The mentor\'s meeting note is on the log, under the request that asked for it.');
    await scroll(page, 650); await scroll(page, 400);
    await shot(page, 'flow-4-log');
    await page.waitForTimeout(1500);
    await nav(page, 'Jobs');
    await say(page, '4 · Student', 'The new posting is in Jobs with the match % computed from this record.');
    await shot(page, 'flow-4-jobs');
    await page.waitForTimeout(1800);
  });
  await signOut(page);
}

async function segOnboarding(page) {
  await go(page, '/login', 600);
  await card(page, 'A new student\'s journey', 'Apply on the public form · the office approves · the emailed setup link: address, code, password · first sign-in · the office assigns a faculty mentor', 3400);
  await step(page, 'register', async () => {
    await go(page, '/register', 1200);
    await say(page, '1 · Apply', 'The public registration form. Every box is compulsory except Specialization, and the CV and photo are checked before the application is created.');
    await shot(page, 'onboard-1-register');
    await type(page, page.locator('#reg-name'), APPLICANT.name);
    await type(page, page.locator('#reg-usn'), APPLICANT.usn);
    await type(page, page.locator('#reg-college-email'), APPLICANT.email);
    await type(page, page.locator('#reg-personal-email'), APPLICANT.personal);
    await type(page, page.locator('#reg-phone'), APPLICANT.phone);
    await type(page, page.locator('#reg-linkedin'), APPLICANT.linkedin);
    await pick(page, page.locator('#reg-college'), { index: 1 });
    await pick(page, page.locator('#reg-dept'), { index: 1 });
    await settle(page, 600);
    if (await page.locator('#reg-course:not([disabled])').count()) await pick(page, page.locator('#reg-course'), { index: 1 });
    await settle(page, 600);
    if (await page.locator('#reg-spec:not([disabled])').count()) await pick(page, page.locator('#reg-spec'), { index: 1 });
    if (await page.locator('#reg-batch:not([disabled])').count()) await pick(page, page.locator('#reg-batch'), { index: 1 });
    const degree = page.locator('#reg-degree');
    await pick(page, degree, (await optionValue(degree, 'PG')) ?? (await optionValue(degree, 'Postgraduate')) ?? { index: 1 });
    await attach(page, page.locator('input.reg-file').nth(0), page.locator('input.reg-file').nth(0), asset('cv-priya-menon.pdf'));
    await attach(page, page.locator('input.reg-file').nth(1), page.locator('input.reg-file').nth(1), asset('photo-priya-menon.png'));
    await scroll(page, 700, 600);
    await clickAt(page, page.locator('button[type="submit"]').first());
    await settle(page, 2200);
    await say(page, 'Applied', 'The application is in the office\'s queue immediately — no email gate in between — with the rule that routed it.');
    await shot(page, 'onboard-1-applied');
    await page.waitForTimeout(1500);
  });
  await signIn(page, ADMIN, '2 · The Main Admin opens the queue.');
  await step(page, 'approve', async () => {
    await nav(page, 'New applications');
    await say(page, '2 · Approve', 'The checklist runs (domain, USN, documents, prior applications). Approve provisions the account and emails the setup link.');
    await approveApplication(page, APPLICANT.name);
    await shot(page, 'onboard-2-approved');
    await page.waitForTimeout(1200);
  });
  await signOut(page);
  await step(page, 'setup link', async () => {
    const mail = await waitForMail(APPLICANT.email, 'approved');
    const m = mail.match(/https?:\/\/[^\s"']+\/onboard\?token=[A-Za-z0-9_\-.~]+/);
    if (!m) throw new Error('no onboarding link in the approval mail');
    const link = m[0].replace(/^https?:\/\/[^/]+/, WEB);
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await settle(page, 1200);
    await say(page, '3 · Set up', 'The emailed link opens three steps on one URL. Step 1: type the address the mail was sent to — a forwarded link alone proves nothing.');
    await shot(page, 'onboard-3-address');
    await type(page, page.locator('input[formcontrolname="email"]'), APPLICANT.email);
    await clickAt(page, page.getByRole('button', { name: /send me a code/i }));
    await settle(page, 1500);
    const codeMail = await waitForMail(APPLICANT.email, 'verification code');
    const c = codeMail.match(/\n\s{2,}(\d{6})\s*\n/) ?? codeMail.match(/\b(\d{6})\b/);
    if (!c) throw new Error('no code in the verification mail');
    await say(page, '3 · Set up', 'Step 2: the six-digit code proves the mailbox is readable right now.');
    await type(page, page.locator('input[formcontrolname="code"]'), c[1]);
    await clickAt(page, page.getByRole('button', { name: /confirm my email/i }));
    await settle(page, 1500);
    await say(page, '3 · Set up', 'Step 3: the password is set with the 15-minute ticket the code earned — never with the link itself. It signs nobody in.');
    await type(page, page.locator('input[formcontrolname="password"]'), APPLICANT.password);
    await type(page, page.locator('input[formcontrolname="confirm"]'), APPLICANT.password);
    await shot(page, 'onboard-3-password');
    await clickAt(page, page.getByRole('button', { name: /set my password/i }));
    await page.waitForURL(/\/login/, { timeout: 20000 }).catch(() => {});
    await settle(page, 1500);
  });
  await step(page, 'first sign-in', async () => {
    await signIn(page, { portal: 'Student', email: APPLICANT.email, password: APPLICANT.password, home: /\/student(\?|$)/ }, '4 · First sign-in through the ordinary front door, with the ordinary limiter and one-device rule.');
    await say(page, '4 · First sign-in', 'A fresh student: the institution card is already filled from the application; the stages wait to be started.');
    await shot(page, 'onboard-4-home');
    await scroll(page, 500); await scroll(page, -500, 600);
    await go(page, '/student/profile');
    await shot(page, 'onboard-4-profile');
    await page.waitForTimeout(1200);
  });
  await signOut(page);
  await signIn(page, ADMIN, '5 · The Main Admin seats the new student under a faculty mentor.');
  await step(page, 'assign', async () => {
    await nav(page, 'Assign faculty');
    await say(page, '5 · Assign faculty', 'Pick the mentor, tick the student in the unassigned pool, write the reason. The mentor group is what scopes every mentee screen.');
    await assignFaculty(page, { mentorName: 'Test Mentor', studentName: APPLICANT.name, reason: 'New admit to the MBA 2024-26 batch; joins the existing Finance group.' });
    await shot(page, 'onboard-5-assigned');
    await page.waitForTimeout(1200);
  });
  await signOut(page);
  await signIn(page, FACULTY, '6 · The mentor now sees the new mentee.');
  await step(page, 'mentor sees', async () => {
    await nav(page, 'Mentee Log');
    await say(page, '6 · Mentee Log', 'The new student is on the mentor\'s list — and nowhere else, because rule 2 scopes staff by the group, never by a missing field.');
    await clickAt(page, page.locator('button.ml-row', { hasText: APPLICANT.name }));
    await settle(page, 1200);
    await shot(page, 'onboard-6-mentee');
    await page.waitForTimeout(1800);
  });
  await signOut(page);
}

const SEGMENTS = {
  student: segStudent,
  faculty: segFaculty,
  admin: segAdmin,
  alumni: segAlumni,
  interlinked: segInterlinked,
  onboarding: segOnboarding,
};

async function record(name, fn) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    recordVideo: { dir: path.join(OUT, '.raw'), size: SIZE },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  await context.addInitScript(OVERLAY);
  narration.items = []; narration.pending = []; narration.endsAt = 0; narration.segment = name;
  narration.videoStart = Date.now();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 160)));
  const started = Date.now();
  console.log(`▶ ${name}`);
  try {
    await fn(page);
  } catch (err) {
    console.log(`  ABORTED ${name}: ${err.message}`);
    await shot(page, `${name}-aborted`).catch(() => {});
  }
  // Let the last spoken line finish before the video ends.
  const tail = narration.endsAt - Date.now();
  await page.waitForTimeout(Math.max(1200, tail + 600));
  const video = page.video();
  await context.close();
  if (TTS_CMD) {
    await Promise.all(narration.pending);
    fs.mkdirSync(path.join(OUT, 'narration'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'narration', `${name}.json`), JSON.stringify({ segment: name, items: narration.items }, null, 2));
    console.log(`  narration: ${narration.items.length} lines`);
  }
  await browser.close();
  const raw = await video.path();
  const dest = path.join(OUT, `${name}.webm`);
  fs.renameSync(raw, dest);
  console.log(`  ${dest}  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SEGMENTS);
for (const name of wanted) {
  if (!SEGMENTS[name]) { console.error(`unknown segment "${name}"; one of ${Object.keys(SEGMENTS).join(', ')}`); process.exit(2); }
}
fs.mkdirSync(path.join(OUT, '.raw'), { recursive: true });
for (const name of wanted) await record(name, SEGMENTS[name]);
console.log(`done: ${wanted.join(', ')} · ${shots.size} screenshots in ${path.join(OUT, 'shots')}`);
