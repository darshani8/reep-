#!/usr/bin/env node
/**
 * Builds docs/presentation/REEP-portal-walkthrough.pptx from the screenshots
 * the recorder saved (tools/demo/out/shots) and the MP4 durations render.sh
 * produced. Run after `record-walkthrough.mjs` and `render.sh`:
 *
 *   node tools/demo/build-deck.cjs
 *
 * Env: SHOTS (screenshot dir), DECK_OUT (output .pptx), DURATIONS (json of
 * {segment: seconds}, written by render.sh when it runs).
 */
const fs = require('node:fs');
const path = require('node:path');
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const Md = require('react-icons/md');

const SHOTS = process.env.SHOTS ?? path.join(__dirname, 'out', 'shots');
const OUTFILE = process.env.DECK_OUT ?? path.join(__dirname, 'out', 'REEP-portal-walkthrough.pptx');
const DURATIONS = (() => {
  const p = process.env.DURATIONS ?? path.join(__dirname, 'out', 'durations.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
})();

// The product's own palette: ink, the purple→magenta brand gradient, lilac wash.
const C = {
  ink: '1E1338', purple: '6D28D9', magenta: 'DB2777', lilac: 'EFE9F7', lilac2: 'E2D8F3',
  white: 'FFFFFF', muted: '6B6480', body: '2B2340', teal: '0F766E', amber: 'B45309', green: '15803D',
  card: 'F7F4FC', line: 'D9D0EA',
};
const ROLE = {
  Student: { color: C.purple, icon: 'MdSchool' },
  Faculty: { color: C.teal, icon: 'MdGroups' },
  'Main Admin': { color: C.magenta, icon: 'MdAdminPanelSettings' },
  Alumni: { color: C.amber, icon: 'MdWorkspacePremium' },
  Applicant: { color: '4C1D95', icon: 'MdPersonAdd' },
};
const FONT = 'Calibri';

const missing = [];
const cache = new Map();

async function framed(name, radius = 26) {
  if (cache.has(name)) return cache.get(name);
  const src = path.join(SHOTS, `${name}.png`);
  let out = null;
  if (fs.existsSync(src)) {
    const img = sharp(src);
    const { width, height } = await img.metadata();
    const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
    const buf = await img.composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    out = 'image/png;base64,' + buf.toString('base64');
  } else {
    missing.push(name);
  }
  cache.set(name, out);
  return out;
}

async function icon(name, color = C.white, size = 256) {
  const key = `icon:${name}:${color}`;
  if (cache.has(key)) return cache.get(key);
  const Comp = Md[name];
  if (!Comp) throw new Error(`no icon ${name}`);
  const svg = renderToStaticMarkup(React.createElement(Comp, { color: `#${color}`, size }));
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  const data = 'image/png;base64,' + buf.toString('base64');
  cache.set(key, data);
  return data;
}

async function gradient(w = 1920, h = 1080, from = '2A0F55', via = '6D28D9', to = 'BE185D') {
  const svg = `<svg width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${from}"/><stop offset=".55" stop-color="#${via}"/><stop offset="1" stop-color="#${to}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
pres.author = 'REEP';
pres.title = 'REEP — live portal walkthrough';
const W = 13.333, H = 7.5;

let slideNo = 0;
function base(bg = C.white) {
  const s = pres.addSlide();
  s.background = { color: bg };
  slideNo += 1;
  if (bg === C.white) {
    s.addText(`REEP · live portal walkthrough`, { x: 0.55, y: H - 0.42, w: 6, h: 0.3, fontFace: FONT, fontSize: 9, color: C.muted, margin: 0, isTextBox: true });
    s.addText(String(slideNo), { x: W - 1.05, y: H - 0.42, w: 0.5, h: 0.3, fontFace: FONT, fontSize: 9, color: C.muted, align: 'right', margin: 0, isTextBox: true });
  }
  return s;
}

async function chip(s, role, x, y) {
  const r = ROLE[role];
  s.addShape(pres.ShapeType.roundRect, { x, y, w: 0.5 + role.length * 0.11, h: 0.32, fill: { color: r.color }, line: { color: r.color }, rectRadius: 0.16 });
  s.addImage({ data: await icon(r.icon), x: x + 0.09, y: y + 0.06, w: 0.2, h: 0.2 });
  s.addText(role.toUpperCase(), { x: x + 0.33, y, w: role.length * 0.11 + 0.2, h: 0.32, fontFace: FONT, fontSize: 9, bold: true, color: C.white, margin: 0, valign: 'middle', charSpacing: 1, isTextBox: true });
}

function title(s, text, { x = 0.55, y = 0.45, w = 12.2, size = 30, color = C.ink } = {}) {
  s.addText(text, { x, y, w, h: 0.7, fontFace: FONT, fontSize: size, bold: true, color, margin: 0, valign: 'middle', isTextBox: true });
}

function bullets(s, items, { x = 0.55, y = 1.9, w = 3.9, h = 4.4, size = 13 } = {}) {
  s.addText(items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < items.length - 1, paraSpaceAfter: 7 } })),
    { x, y, w, h, fontFace: FONT, fontSize: size, color: C.body, valign: 'top', margin: 0, isTextBox: true });
}

async function picture(s, name, x, y, w, { caption = null } = {}) {
  const h = (w * 9) / 16;
  s.addShape(pres.ShapeType.roundRect, { x: x - 0.05, y: y - 0.05, w: w + 0.1, h: h + 0.1, fill: { color: C.white }, line: { color: C.line, width: 0.75 }, rectRadius: 0.16, shadow: { type: 'outer', blur: 8, offset: 3, angle: 60, color: '1E1338', opacity: 0.22 } });
  const data = await framed(name);
  if (data) s.addImage({ data, x, y, w, h });
  else {
    s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: C.lilac }, line: { color: C.lilac }, rectRadius: 0.14 });
    s.addText(`screenshot: ${name}`, { x, y, w, h, fontFace: FONT, fontSize: 12, color: C.muted, align: 'center', valign: 'middle', isTextBox: true });
  }
  if (caption) s.addText(caption, { x, y: y + h + 0.08, w, h: 0.32, fontFace: FONT, fontSize: 10.5, color: C.muted, margin: 0, isTextBox: true });
  return h;
}

// --- slide kinds ----------------------------------------------------------
async function coverSlide({ heading, sub, foot }) {
  const s = base(C.ink);
  s.background = { data: await gradient() };
  s.addText(heading, { x: 0.8, y: 1.6, w: 11.7, h: 2.2, fontFace: FONT, fontSize: 54, bold: true, color: C.white, margin: 0, valign: 'bottom', isTextBox: true });
  s.addText(sub, { x: 0.8, y: 3.95, w: 11.2, h: 1.2, fontFace: FONT, fontSize: 22, color: 'F3E8FF', margin: 0, valign: 'top', isTextBox: true });
  if (foot) s.addText(foot, { x: 0.8, y: 6.5, w: 11.7, h: 0.5, fontFace: FONT, fontSize: 12, color: 'E9D5FF', margin: 0, charSpacing: 2, isTextBox: true });
  return s;
}

async function sectionSlide({ role, heading, sub, items, video }) {
  const s = base(C.ink);
  s.background = { data: await gradient(1920, 1080, '1E1338', '3B1D6E', ROLE[role]?.color ?? C.magenta) };
  s.addImage({ data: await icon(ROLE[role]?.icon ?? 'MdApps', 'FFFFFF'), x: 0.85, y: 0.9, w: 0.9, h: 0.9 });
  s.addText(heading, { x: 0.8, y: 1.9, w: 11.5, h: 1.3, fontFace: FONT, fontSize: 46, bold: true, color: C.white, margin: 0, valign: 'bottom', isTextBox: true });
  s.addText(sub, { x: 0.8, y: 3.3, w: 11.2, h: 1.3, fontFace: FONT, fontSize: 18, color: 'F3E8FF', margin: 0, valign: 'top', isTextBox: true });
  if (items?.length) {
    s.addText(items.map((t, i) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: i < items.length - 1, paraSpaceAfter: 5 } })),
      { x: 0.85, y: 4.75, w: 8.2, h: 2.2, fontFace: FONT, fontSize: 14, color: 'F3E8FF', valign: 'top', margin: 0, isTextBox: true });
  }
  if (video) {
    const d = DURATIONS[video.file];
    const dur = d ? ` · ${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : '';
    s.addShape(pres.ShapeType.roundRect, { x: 9.35, y: 4.85, w: 3.3, h: 1.2, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' }, rectRadius: 0.16, transparency: 12 });
    s.addImage({ data: await icon('MdPlayCircle', C.ink), x: 9.55, y: 5.07, w: 0.5, h: 0.5 });
    s.addText([{ text: 'Video', options: { bold: true, breakLine: true } }, { text: `${video.file}.mp4${dur}` }],
      { x: 10.15, y: 4.9, w: 2.45, h: 1.1, fontFace: FONT, fontSize: 12, color: C.ink, margin: 0, valign: 'middle', isTextBox: true });
  }
  return s;
}

async function screenSlide({ role, heading, shot, points, caption, notes }) {
  const s = base();
  title(s, heading);
  await chip(s, role, 0.55, 1.28);
  bullets(s, points, { x: 0.55, y: 1.8, w: 3.85, h: 4.6, size: 13 });
  await picture(s, shot, 4.75, 1.35, 8.05, { caption });
  if (notes) s.addNotes(notes);
  return s;
}

async function twoUpSlide({ role, heading, shots, points, notes }) {
  const s = base();
  title(s, heading);
  await chip(s, role, 0.55, 1.28);
  if (points?.length) bullets(s, points, { x: 0.55, y: 1.8, w: 12.2, h: 1.0, size: 13 });
  const y = points?.length ? 2.95 : 1.85;
  const w = 5.95;
  await picture(s, shots[0].name, 0.6, y, w, { caption: shots[0].caption });
  await picture(s, shots[1].name, 6.8, y, w, { caption: shots[1].caption });
  if (notes) s.addNotes(notes);
  return s;
}

async function gridSlide({ role, heading, shots, notes, intro }) {
  const s = base();
  title(s, heading);
  await chip(s, role, 0.55, 1.28);
  if (intro) s.addText(intro, { x: 3.2, y: 1.24, w: 9.5, h: 0.4, fontFace: FONT, fontSize: 12.5, color: C.body, margin: 0, valign: 'middle', isTextBox: true });
  const cols = 3, w = 3.8, gapX = 0.35, gapY = 0.5;
  const h = (w * 9) / 16;
  for (let i = 0; i < shots.length; i++) {
    const x = 0.6 + (i % cols) * (w + gapX);
    const y = 1.78 + Math.floor(i / cols) * (h + gapY);
    await picture(s, shots[i].name, x, y, w, { caption: shots[i].caption });
  }
  if (notes) s.addNotes(notes);
  return s;
}

function stepBox(s, { x, y, w, h, n, role, text, sub }) {
  const color = ROLE[role]?.color ?? C.purple;
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, fill: { color: C.card }, line: { color: C.line, width: 0.75 }, rectRadius: 0.12, shadow: { type: 'outer', blur: 5, offset: 2, angle: 60, color: '1E1338', opacity: 0.14 } });
  s.addShape(pres.ShapeType.ellipse, { x: x + 0.15, y: y + 0.15, w: 0.42, h: 0.42, fill: { color }, line: { color } });
  s.addText(String(n), { x: x + 0.15, y: y + 0.15, w: 0.42, h: 0.42, fontFace: FONT, fontSize: 13, bold: true, color: C.white, align: 'center', valign: 'middle', margin: 0, isTextBox: true });
  s.addText(role.toUpperCase(), { x: x + 0.68, y: y + 0.17, w: w - 0.8, h: 0.24, fontFace: FONT, fontSize: 8.5, bold: true, color, margin: 0, charSpacing: 1, isTextBox: true });
  s.addText(text, { x: x + 0.68, y: y + 0.4, w: w - 0.8, h: 0.5, fontFace: FONT, fontSize: 12.5, bold: true, color: C.ink, margin: 0, valign: 'top', isTextBox: true });
  s.addText(sub, { x: x + 0.15, y: y + 0.95, w: w - 0.3, h: h - 1.05, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: 'top', isTextBox: true });
}

function arrow(s, x1, y1, x2, y2, color = C.purple) {
  s.addShape(pres.ShapeType.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.01, h: Math.abs(y2 - y1) || 0.01, line: { color, width: 1.75, endArrowType: 'triangle' }, flipH: x2 < x1, flipV: y2 < y1 });
}

// --- the deck -------------------------------------------------------------
async function build() {
  await coverSlide({
    heading: 'REEP\nLive portal walkthrough',
    sub: 'How the Student, Faculty, Main Admin and Alumni portals work — recorded on the running product, with the workflows that link them.',
    foot: 'STUDENT  ·  FACULTY / MENTOR  ·  MAIN ADMIN  ·  ALUMNI  ·  SIX VIDEOS + THIS DECK',
  });

  // What is in the pack
  {
    const s = base();
    title(s, 'What is in this pack');
    const rows = [
      ['Video', 'Shows', 'Length'],
      ['student.mp4', 'The Student portal, every screen, with a certificate claim, a reconciled time sheet, a meeting request and the assistant', DURATIONS.student],
      ['faculty.mp4', 'The Faculty portal: notebook, mentee log, skill verification, the leave form, upskilling, signature', DURATIONS.faculty],
      ['admin.mp4', 'The Main Admin console: applications, roster, faculty, assignment, leave, jobs, interviews, SWOC, college setup, access, audit', DURATIONS.admin],
      ['interlinked.mp4', 'One workflow across three portals — what a student does, what the mentor and the office do about it, and where it lands', DURATIONS.interlinked],
      ['onboarding.mp4', 'A new student\'s journey: apply → approve → emailed link (address, code, password) → first sign-in → faculty assigned', DURATIONS.onboarding],
      ['alumni.mp4', 'The Alumni portal: first-login profile and the jobs sheet', DURATIONS.alumni],
    ];
    const fmt = (d) => (d ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : '—');
    s.addTable(rows.map((r, i) => r.map((c, j) => ({
      text: i === 0 ? c : j === 2 ? fmt(c) : c,
      options: { fontFace: FONT, fontSize: i === 0 ? 11 : 12, bold: i === 0 || j === 0, color: i === 0 ? C.white : C.body, fill: { color: i === 0 ? C.ink : i % 2 ? C.card : C.white }, valign: 'middle', margin: [4, 8, 4, 8] },
    }))), { x: 0.55, y: 1.35, w: 12.2, colW: [2.1, 8.9, 1.2], rowH: 0.55, border: { type: 'solid', color: C.line, pt: 0.5 } });
    s.addText([
      { text: 'Every video is a real recording of the product: ', options: { bold: true } },
      { text: 'the typing, the clicks and the data are live, and a caption bar explains each screen as it opens. Play them in this order; tools/demo/render.sh also produces reep-full-walkthrough.mp4, all six back to back. The slides that follow use the same screenshots so the deck can be read without the videos.' },
    ], { x: 0.55, y: 5.55, w: 12.2, h: 1.1, fontFace: FONT, fontSize: 13, color: C.body, margin: 0, valign: 'top', isTextBox: true });
    s.addNotes('Six videos, one deck. The videos were recorded by a script that drives the real portal in a browser, so nothing is mocked. Play the role videos in order, then the two workflow videos.');
  }

  // REEP in one slide
  {
    const s = base();
    title(s, 'REEP in one slide');
    const cards = [
      ['MdSchool', C.purple, 'Student', 'Readiness stages, jobs with a match %, the badge board, a 24-hour time ledger, the mentor log, the resume, and a speech-to-speech mock interviewer.'],
      ['MdGroups', C.teal, 'Faculty / Mentor', 'A notebook and a mentee log for their own group only, the skill-verification queue, leave on the college form, their own upskilling shelf.'],
      ['MdAdminPanelSettings', C.magenta, 'Main Admin', 'One office account: applications, the roster, faculty, assignments, leave sanction, jobs, interviews, SWOC, college setup, access grants, the audit trail.'],
      ['MdWorkspacePremium', C.amber, 'Alumni', 'A profile with a resume and the jobs sheet — no student record, so no match %.'],
    ];
    for (let i = 0; i < cards.length; i++) {
      const [ic, color, h, t] = cards[i];
      const x = 0.55 + i * 3.1;
      s.addShape(pres.ShapeType.roundRect, { x, y: 1.4, w: 2.9, h: 3.0, fill: { color: C.card }, line: { color: C.line, width: 0.75 }, rectRadius: 0.14 });
      s.addShape(pres.ShapeType.ellipse, { x: x + 0.2, y: 1.6, w: 0.62, h: 0.62, fill: { color }, line: { color } });
      s.addImage({ data: await icon(ic), x: x + 0.33, y: 1.73, w: 0.36, h: 0.36 });
      s.addText(h, { x: x + 0.2, y: 2.32, w: 2.5, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(t, { x: x + 0.2, y: 2.72, w: 2.55, h: 1.6, fontFace: FONT, fontSize: 11, color: C.body, margin: 0, valign: 'top', isTextBox: true });
    }
    s.addText([
      { text: 'One product, one front door. ', options: { bold: true } },
      { text: 'An Angular single-page app talks to a FastAPI back end over HTTP on PostgreSQL. Every role signs in on the same login screen; the portal picker is a hint, the role on the account is the decision. Sign-in is Google or password, and an account holds one live session at a time.' },
    ], { x: 0.55, y: 4.7, w: 12.2, h: 0.9, fontFace: FONT, fontSize: 13, color: C.body, margin: 0, valign: 'top', isTextBox: true });
    const rules = [
      ['MdLock', 'Rule 1 — student data stays on the machine', 'A resume brief carries a name, USN, marks and attendance. Any path that sends a student\'s record to a model goes through one gate; refused, the resume is composed deterministically and says so.'],
      ['MdShield', 'Rule 2 — staff scope is decided by role', 'A mentor sees only the students in their own group; a mentor with no group sees nobody. Console screens reach a faculty member only as a grant the Main Admin makes, with a reason, on the audit trail.'],
    ];
    for (let i = 0; i < 2; i++) {
      const [ic, h, t] = rules[i];
      const x = 0.55 + i * 6.15;
      s.addShape(pres.ShapeType.roundRect, { x, y: 5.7, w: 6.0, h: 1.25, fill: { color: C.lilac }, line: { color: C.lilac }, rectRadius: 0.12 });
      s.addImage({ data: await icon(ic, C.purple), x: x + 0.18, y: 5.9, w: 0.4, h: 0.4 });
      s.addText(h, { x: x + 0.7, y: 5.78, w: 5.2, h: 0.35, fontFace: FONT, fontSize: 12, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(t, { x: x + 0.7, y: 6.1, w: 5.2, h: 0.8, fontFace: FONT, fontSize: 10, color: C.body, margin: 0, valign: 'top', isTextBox: true });
    }
    s.addNotes('REEP is a college placement-readiness dashboard. Four portals on one login. Two rules shape every screen you are about to see: student data stays on the machine unless an operator allows otherwise, and what staff can see is decided by role and by the mentor group the office assigned — never by a field that happens to be empty.');
  }

  // The door
  await screenSlide({
    role: 'Student', heading: 'One login for every role',
    shot: 'login',
    points: [
      'Choose your portal — Student, Faculty, Alumni — or the dashed Main Admin door for the placement office.',
      'The picker only changes the hint on the ID box; the role on the account decides where you land.',
      'Sign in with the college address (students may type the USN) and a password, or with Google — an unknown Google account is refused, nothing self-provisions.',
      'One device at a time: signing in elsewhere signs the older session out and the screen says so.',
      '“Forgot password?” emails a link; a student who never had a password is mailed the three-step setup walk instead.',
    ],
    notes: 'Every video starts here. The same form serves all four roles. The Main Admin door is a hint, not a bypass: it selects the admin portal so the ID field reads “admin email”; the account\'s role is what opens the console.',
  });

  // ===== STUDENT ============================================================
  await sectionSlide({
    role: 'Student', heading: 'Student portal',
    sub: 'Home · Jobs · Skilling · Leaderboards · Time Sheet · Faculty / TPO Log · Resume Builder — plus Uploads, Profile, Records, English, Interviews and the assistant dock on every screen.',
    items: ['Signs in as student@bgscet.ac.in (Test Student, MBA 2024-26, Semester 2)', 'Claims a skill with a certificate, reconciles and submits the day\'s time sheet, asks the mentor for a meeting', 'Opens the assistant: Ask REEP answers from the record; the Mock interview room picks a round'],
    video: { file: 'student' },
  });
  await screenSlide({
    role: 'Student', heading: 'Home — where the student stands today',
    shot: 'student-home',
    points: [
      'The three programme stages — Reboot, Excel, Elevate — with each module Completed, In progress or Not started.',
      'SWOC: the Strengths, Weaknesses, Opportunities and Challenges the mentor and the placement office wrote, each signed and dated; the student marks a line as read.',
      'Attendance and VTU marks against the placement criteria; a dash where nothing has been imported yet — never a zero.',
      'A login streak in the header, and the readiness score with its weakest factor and the action that lifts it.',
    ],
    notes: 'Home is the student\'s landing. Nothing here is typed by the student: stages come from the milestone rows, SWOC from staff, marks and attendance from the office\'s spreadsheet imports.',
  });
  await twoUpSlide({
    role: 'Student', heading: 'Jobs and Skilling',
    points: ['Jobs: every posting the office published, with this student\'s match % and an eligibility verdict against the placement criteria (CGPA, backlogs, skills). Skilling: the 48-badge board — managerial, sectoral, platform, thinking and readiness — with earned badges lit and claims in review wearing a clock.'],
    shots: [{ name: 'student-jobs', caption: 'Jobs — match % and eligibility are computed from the student\'s own record' }, { name: 'student-skilling', caption: 'Skilling — the badge board; a verified badge carries the mentor\'s blue tick' }],
    notes: 'The match % on Jobs and the eligibility verdict are the same criteria the office maintains on Placement. Skilling is where a certificate becomes a badge — but only after a mentor verifies it.',
  });
  await screenSlide({
    role: 'Student', heading: 'Claim a skill with a certificate',
    shot: 'student-claim-submitted',
    points: [
      '1 · Upload the certificate (PDF or JPEG, up to 5 MB). It is stored under Uploads with its review status.',
      '2 · Pick the skill category and the badge the certificate proves; name the issuer and leave a note for the mentor.',
      '3 · Submit. The claim now waits in the mentor\'s Skill Verifications queue, and the mentor is emailed.',
      'The badge lights up only when the mentor presses Verify — a certificate is evidence, never a badge by itself.',
      'Request changes or Reject come back with the mentor\'s note, on screen and by mail.',
    ],
    notes: 'This is the first half of the student–mentor loop the interlinked video shows end to end. The rule enforced by the write path: a certificate is not a badge; only staff approval mints the earned row.',
  });
  await twoUpSlide({
    role: 'Student', heading: 'Time Sheet and the Faculty / TPO Log',
    points: ['The Time Allocation Ledger: six slots across the day × five activity heads, in half hours; the day must add to exactly 24 h before Submit is allowed, and a submitted day is read-only. The Faculty / TPO Log is the student\'s own record of every 1:1, and Request a meeting sends a note straight to the mentor\'s Mentee Log.'],
    shots: [{ name: 'student-timesheet-submitted', caption: 'The day reconciled to 24 h and submitted' }, { name: 'student-meeting-requested', caption: '“Sent to Test Mentor. It appears in your meeting log below.”' }],
    notes: 'Half hours are stored as integers, so “does this add up to 24” is exact. The meeting request is a mentor note, so both sides read the same row.',
  });
  await gridSlide({
    role: 'Student', heading: 'The rest of the student\'s desk',
    intro: 'Reached from Home and the screens that own the work: the resume, every document and its review status, the locked institution card, imported results, the English baseline and past interviews.',
    shots: [
      { name: 'student-resume', caption: 'Resume Builder — rendered to PDF locally' },
      { name: 'student-uploads', caption: 'Uploads — every document and its verdict' },
      { name: 'student-profile', caption: 'Profile — the institution card read through the spine' },
      { name: 'student-records', caption: 'Records — marks and attendance as imported' },
      { name: 'student-english', caption: 'English baseline — a pending section is a dash' },
      { name: 'student-interviews', caption: 'Interviews — transcript and practice report' },
    ],
    notes: 'These screens are deliberately off the sidebar; each is reached from the screen that owns the work. The profile card is read through the college → department → course → batch join and stored nowhere else.',
  });
  await twoUpSlide({
    role: 'Student', heading: 'The assistant dock: Ask REEP and the Mock interview',
    points: ['The floating orb on every screen opens one dock with two tabs. Ask REEP is the typed agent: it answers from the approved Knowledge Base and the student\'s own record, shows its sources and offers buttons to act. Mock interview is a speech-to-speech campus-round interviewer (Amazon Nova 2 Sonic) with a real arc — opening, probing, deep dive, wrap-up — and a scorecard; the round is preselected from the student\'s batch, and consent is asked before anything is stored.'],
    shots: [{ name: 'student-agent-answer', caption: 'Ask REEP — “Which open jobs am I eligible for?”' }, { name: 'student-mock-interview', caption: 'Mock interview — pick the round, then Start' }],
    notes: 'Both assistants are in the shell, not on a route, so they are on every screen. The interview engine runs inside the API process; on a machine without the cloud engine the room reports itself unavailable and nothing else is affected.',
  });

  // ===== FACULTY ============================================================
  await sectionSlide({
    role: 'Faculty', heading: 'Faculty portal',
    sub: 'Notebook · Mentee Log · Leave Requests · Skill Verifications · Upskilling — and the signature, the account screen and any console screen the office granted.',
    items: ['Signs in as mentor@bgscet.ac.in (Test Mentor), whose group holds Test Student', 'Every mentee screen is scoped to that group: a faculty member with no group sees nobody, never the whole programme', 'Logs a notebook entry, answers the student\'s meeting request, verifies the claim, applies for leave, files a certificate and a signature'],
    video: { file: 'faculty' },
  });
  await twoUpSlide({
    role: 'Faculty', heading: 'Notebook and Mentee Log',
    points: ['The notebook is the faculty member\'s private log per student: date, what was discussed, the agreed action, a remark. The Mentee Log is the shared record: the student\'s meeting request is already on it, and the note written back — heading, linked action, text — is exactly what the student reads on their Faculty / TPO Log. A “Full record” link opens the student\'s complete file when the office has granted that read.'],
    shots: [{ name: 'faculty-notebook-saved', caption: 'Notebook — a private entry per mentee' }, { name: 'faculty-note-saved', caption: 'Mentee Log — the note the student will read' }],
    notes: 'Rule 2 in practice: the mentee list is the faculty member\'s own group and nothing else. The note form is the mentor\'s instrument; a meeting request from the student arrives as one of these notes.',
  });
  await twoUpSlide({
    role: 'Faculty', heading: 'Skill Verifications — one decision writes both rows',
    points: ['The queue lists the claims from this group\'s students with the certificate attached. Verify mints the EARNED badge and marks the certificate VERIFIED in the student\'s Uploads in the same act. Request changes and Reject refuse without a note — the note is the whole of what the student is told, on screen and by mail.'],
    shots: [{ name: 'faculty-verifications', caption: 'The claim, its certificate, and the three decisions' }, { name: 'faculty-verified', caption: 'Verified — the badge is lit on the student\'s board' }],
    notes: 'This is the second half of the student–mentor loop. The mentor was emailed when the claim was filed; the student is emailed the decision with the note.',
  });
  await gridSlide({
    role: 'Faculty', heading: 'Leave, Upskilling, Signature, Account',
    intro: 'Leave is the college\'s own form filled on screen and signed to the Main Admin; Upskilling is the faculty member\'s own certificate shelf; the signature is drawn on every leave paper they sign; My account holds sign-in security and this device.',
    shots: [
      { name: 'faculty-leave', caption: 'Leave Requests — balances, cover and the form' },
      { name: 'faculty-leave-submitted', caption: 'Signed & submitted — awaiting the Main Admin' },
      { name: 'faculty-upskilling-added', caption: 'Upskilling — a record, not evidence' },
      { name: 'faculty-signature-uploaded', caption: 'Signature — normalised on upload' },
      { name: 'faculty-account', caption: 'My account — security, this device, digests' },
      { name: 'faculty-mentee-log', caption: 'Mentee Log — the student\'s request waiting' },
    ],
    notes: 'The leave request dies at the schema if the dates run backwards. The paper PDF is the college\'s own form with the request written onto it, and the signature image is drawn above the name and time — never instead of them.',
  });

  // ===== ADMIN ==============================================================
  await sectionSlide({
    role: 'Main Admin', heading: 'Main Admin console',
    sub: 'People · Every day · Interviews · College setup · Settings — the placement office\'s one account, landing on a list of tasks in plain words.',
    items: ['Signs in through the Main Admin door as admin@bgscet.ac.in', 'Approves an application, opens a student\'s 360, seats a student under a faculty member, sanctions leave, publishes a job, writes a SWOC line, grants a screen to a faculty member', 'Nothing on the console explains itself: a label that needs decoding gets changed, not a tooltip'],
    video: { file: 'admin' },
  });
  await screenSlide({
    role: 'Main Admin', heading: 'Home — what is waiting, and every task as a button',
    shot: 'admin-home',
    points: [
      'Five live counts, each a button to its queue: applications to review, leave to sanction, students without a faculty member, offers, access reviews.',
      'Every screen as a task — “Approve new students”, “Post a job”, “Assign faculty” — grouped as People, Every day, Interviews, College setup, Settings.',
      'Charts & numbers moved one row down: the right first screen for someone who knows the console, the wrong one for someone who does not.',
    ],
    notes: 'The admin lands on tasks, not charts. The sidebar uses the same plain words.',
  });
  await twoUpSlide({
    role: 'Main Admin', heading: 'New applications — approve, hold, reject',
    points: ['Applications land in this queue the moment they are submitted; rules route them and a checklist warns about a missing CV, an off-domain address or a prior application. Approve provisions the account and emails the three-step setup link. Reject requires a reason and emails it, because a rejected applicant is not a user and that mail is the only channel. Hold keeps it with a note.'],
    shots: [{ name: 'admin-registrations', caption: 'The queue, the checklist and the decision panel' }, { name: 'admin-registration-approved', caption: 'Approved — the account exists and the setup link is in the mail' }],
    notes: 'Approval is the ONLY way onto the roster: there is no admin-side create. That is what makes the roster the access control.',
  });
  await twoUpSlide({
    role: 'Main Admin', heading: 'Students & batches, and the Student 360',
    points: ['The roster: edit a student (name, USN, batch, faculty, stage, semester), act on a whole batch with one action repeated — move, assign faculty, set stage or semester — remove-and-restore, or delete for good behind an emailed code. The eye opens the 360: one student across every semester — profile, results, attendance, documents, mentor history, interviews.'],
    shots: [{ name: 'admin-students', caption: 'Students & batches — the roster grid' }, { name: 'admin-student-360', caption: 'Student 360 — the complete record' }],
    notes: 'REMOVE hides a person from every list and can be undone; DELETE FOR GOOD walks every dependent row and needs a six-digit code mailed to the office\'s own address.',
  });
  await twoUpSlide({
    role: 'Main Admin', heading: 'Faculty and Assign faculty',
    points: ['Faculty lists every account with its group size and functions; “Add faculty member” mints the account and shows the activation link to hand over. Assign faculty is where a faculty account becomes a mentor: pick the mentor, tick students in the unassigned pool, write the reason. The group is what scopes every mentee screen, and the history of who mentored whom is kept beside the pointer.'],
    shots: [{ name: 'admin-faculty', caption: 'Faculty — accounts, groups, activation links' }, { name: 'admin-assigned', caption: 'Assign faculty — a student seated, with a reason' }],
    notes: 'A reason is required on every assignment because moving a student changes who may read their marks. Capacity is a number the screen shows, not a rule it enforces.',
  });
  await twoUpSlide({
    role: 'Main Admin', heading: 'Leave requests and Job postings',
    points: ['Leave is one signature, the Main Admin\'s: select the request, Sanction with remarks, and the college-form PDF carries both signatures. Job postings is the jobs sheet: a published posting reaches every eligible student\'s Jobs screen with a match % computed from their own record; the alumni feed gets it without the verdict.'],
    shots: [{ name: 'admin-leave-sanctioned', caption: 'Leave requests — sanctioned with remarks' }, { name: 'admin-job-published', caption: 'Job postings — published to every eligible student' }],
    notes: 'The two-signature chain was retired because it deadlocked every staff request on a one-admin deployment; the office may hand its one signature to a named faculty member in Governance.',
  });
  await twoUpSlide({
    role: 'Main Admin', heading: 'Interviews and SWOC notes',
    points: ['Interview questions is the bank per track — guidance the free-style interviewer rephrases. Interview records lists every mock interview with the student named: transcript, report, score over time, and the college\'s storage policy (transcript, audio, retention, caps). SWOC notes are the four lines on each student\'s Home, with author, semester and whether the student has read them.'],
    shots: [{ name: 'admin-interview-records', caption: 'Interview records — and the policy card' }, { name: 'admin-swoc-added', caption: 'SWOC notes — a line the student sees at once' }],
    notes: 'Consent is a row and the socket enforces it: no live grant, no interview. Audio needs three switches on — the operator\'s, the college\'s and the student\'s.',
  });
  await twoUpSlide({
    role: 'Main Admin', heading: 'College setup — the institutional spine',
    points: ['College → Department → Course → Specialization → Batch → student. “Set up a college” is the spine typed once and created in one press; College structure sees and changes what exists (courses, batches, seating, the mock-interview track mapping, email domains); Colleges lists; Catalogue holds courses and the approved certifications. Course and Specialization are optional and a batch is a year — the links are the spine.'],
    shots: [{ name: 'admin-setup', caption: 'Set up a college — six steps, one press' }, { name: 'admin-institution', caption: 'College structure — see and change' }],
    notes: 'The field that matters on a leaf is its code: it preselects the interview track by exact match, and a student on a batch with no track meets the general interview, which cannot be scored.',
  });
  await gridSlide({
    role: 'Main Admin', heading: 'Access, the audit trail and the numbers',
    intro: 'Access is a decision with a reach, a reason and an expiry; the audit trail records every write; analytics aggregate on the server.',
    shots: [
      { name: 'admin-granted', caption: 'Who can do what — a screen granted to a faculty member' },
      { name: 'admin-audit', caption: 'What changed — the audit trail' },
      { name: 'admin-analytics', caption: 'Charts & numbers' },
      { name: 'admin-placement', caption: 'Placement & offers' },
      { name: 'admin-exports', caption: 'Download reports — every download leaves a receipt' },
      { name: 'admin-imports', caption: 'Upload spreadsheets — attendance and marks' },
    ],
    notes: 'A grant hangs on a rung of the spine (college, department, course, specialization, batch or one student), so a faculty member can hold a screen for one department and not another. The Main Admin\'s own grants are live at once.',
  });

  // ===== INTERLINKED ========================================================
  await sectionSlide({
    role: 'Student', heading: 'One workflow, three portals',
    sub: 'What the student does, what the mentor and the office do about it, and where every action lands back on the student\'s screens.',
    items: ['1 · Student claims a skill and asks for a 1:1', '2 · Mentor verifies the claim, records the meeting, applies for leave', '3 · Main Admin writes a SWOC line, publishes a job, sanctions the leave', '4 · Student: the SWOC line on Home, the lit badge, the mentor\'s note, the new job with a match %'],
    video: { file: 'interlinked' },
  });
  {
    const s = base();
    title(s, 'How the portals link');
    const colX = [0.55, 4.75, 8.95], colW = 3.85;
    const heads = ['Student', 'Faculty', 'Main Admin'];
    for (let i = 0; i < 3; i++) {
      const color = ROLE[heads[i]].color;
      s.addShape(pres.ShapeType.roundRect, { x: colX[i], y: 1.25, w: colW, h: 0.42, fill: { color }, line: { color }, rectRadius: 0.1 });
      s.addText(heads[i].toUpperCase(), { x: colX[i], y: 1.25, w: colW, h: 0.42, fontFace: FONT, fontSize: 13, bold: true, color: C.white, align: 'center', valign: 'middle', margin: 0, charSpacing: 2, isTextBox: true });
    }
    const rowY = [1.85, 3.4, 4.95];
    stepBox(s, { x: colX[0], y: rowY[0], w: colW, h: 1.45, n: 1, role: 'Student', text: 'Claims a skill with a certificate', sub: 'Skilling → Submit claim. Certificate filed under Uploads; mentor emailed.' });
    stepBox(s, { x: colX[1], y: rowY[0], w: colW, h: 1.45, n: 2, role: 'Faculty', text: 'Verifies the claim', sub: 'Skill Verifications → Verify. Badge EARNED and certificate VERIFIED in one act.' });
    stepBox(s, { x: colX[0], y: rowY[1], w: colW, h: 1.45, n: 3, role: 'Student', text: 'Asks for a meeting', sub: 'Faculty / TPO Log → Request a meeting. Arrives as a note on the Mentee Log.' });
    stepBox(s, { x: colX[1], y: rowY[1], w: colW, h: 1.45, n: 4, role: 'Faculty', text: 'Records the 1:1', sub: 'Mentee Log → Save note. The note appears on the student\'s own log.' });
    stepBox(s, { x: colX[2], y: rowY[0], w: colW, h: 1.45, n: 5, role: 'Main Admin', text: 'Writes SWOC, posts a job', sub: 'SWOC notes → Save; Job postings → Publish. The line lands on Home, the job on Jobs.' });
    stepBox(s, { x: colX[1], y: rowY[2], w: colW, h: 1.45, n: 6, role: 'Faculty', text: 'Applies for leave', sub: 'Leave Requests → Sign & submit to Program Director.' });
    stepBox(s, { x: colX[2], y: rowY[2], w: colW, h: 1.45, n: 7, role: 'Main Admin', text: 'Sanctions the leave', sub: 'Leave requests → Sanction with remarks; the college form PDF carries both signatures.' });
    stepBox(s, { x: colX[2], y: rowY[1], w: colW, h: 1.45, n: 8, role: 'Main Admin', text: 'Assigns faculty, grants access', sub: 'Assign faculty seats a student in a group (rule 2); Who can do what lends a screen.' });
    // arrows: 1→2, 3→4, 5→student home, 6→7, 8→faculty
    arrow(s, colX[0] + colW, rowY[0] + 0.6, colX[1], rowY[0] + 0.6);
    arrow(s, colX[0] + colW, rowY[1] + 0.6, colX[1], rowY[1] + 0.6);
    arrow(s, colX[1] + colW, rowY[2] + 0.6, colX[2], rowY[2] + 0.6, C.teal);
    arrow(s, colX[2], rowY[1] + 0.6, colX[1] + colW, rowY[1] + 0.6, C.magenta);
    s.addText('Back to the student: the lit badge on Skilling · the note on the Faculty / TPO Log · the SWOC line on Home · the job on Jobs', { x: 0.55, y: 6.5, w: 12.2, h: 0.32, fontFace: FONT, fontSize: 11, bold: true, color: C.purple, margin: 0, valign: 'middle', isTextBox: true });
    s.addText('Every arrow is a database row the other portal reads through its own gate — nothing is copied between screens, and rule 2 filters every staff read.', { x: 0.55, y: 6.82, w: 12.2, h: 0.28, fontFace: FONT, fontSize: 10.5, color: C.muted, margin: 0, isTextBox: true });
    s.addNotes('Read this slide with interlinked.mp4. Each numbered box is one screen in the video; the arrows are the rows the other side reads: a claim, a note, a SWOC entry, a job, a leave request.');
  }
  await gridSlide({
    role: 'Student', heading: 'The interlinked workflow, as recorded',
    intro: 'Six frames from interlinked.mp4 — the claim, the verification, the note, the SWOC line, and the student\'s Home and Jobs afterwards.',
    shots: [
      { name: 'flow-1-claim', caption: '1 · Student — claim submitted' },
      { name: 'flow-2-verified', caption: '2 · Mentor — verified' },
      { name: 'flow-2-note', caption: '4 · Mentor — the meeting note' },
      { name: 'flow-3-swoc', caption: '5 · Main Admin — SWOC line saved' },
      { name: 'flow-4-home', caption: '4 · Student — Home carries the line' },
      { name: 'flow-4-jobs', caption: '4 · Student — the new posting with a match %' },
    ],
    notes: 'These are frames from the recording, not mock-ups: the same rows that were written in step 1–3 are what the student\'s screens show in step 4.',
  });

  // ===== ONBOARDING =========================================================
  await sectionSlide({
    role: 'Applicant', heading: 'A new student\'s journey',
    sub: 'Apply on the public form → the office approves → the emailed link\'s three steps (address, code, password) → first sign-in → the office assigns a faculty mentor → the mentor sees the new mentee.',
    items: ['Priya Menon applies with USN, phone, personal email, LinkedIn, CV and photo — every box compulsory except Specialization', 'The application is in the queue immediately; no email gate in between', 'The link proves the mail was opened, the code proves the mailbox is readable now, the ticket the code earns is the only thing that sets the password'],
    video: { file: 'onboarding' },
  });
  {
    const s = base();
    title(s, 'From application to mentee — six steps, three roles');
    const steps = [
      ['Applicant', 'Apply', '/register: name, USN, college and personal email, phone, LinkedIn, the spine, CV and photo. Files are checked before the application is created.'],
      ['Main Admin', 'Approve', 'New applications: the checklist runs; Approve provisions User + Student + profile and emails “Your REEP account is approved — set it up”.'],
      ['Applicant', 'Set up', '/onboard?token=…: type the address → a six-digit code is mailed → confirm → set the password with the 15-minute ticket. Signs nobody in.'],
      ['Student', 'First sign-in', 'The ordinary front door: limiter, revocation and the one-device rule all apply. Home and the filled-in Profile card.'],
      ['Main Admin', 'Assign faculty', 'Pick the mentor, tick the new student in the pool, write the reason. The group now scopes every mentee screen.'],
      ['Faculty', 'Sees the mentee', 'Mentee Log lists the new student — and nobody the faculty member does not mentor.'],
    ];
    for (let i = 0; i < steps.length; i++) {
      const [role, text, sub] = steps[i];
      const x = 0.55 + (i % 3) * 4.2, y = 1.35 + Math.floor(i / 3) * 2.5;
      stepBox(s, { x, y, w: 3.85, h: 2.2, n: i + 1, role, text, sub });
      if (i % 3 < 2) arrow(s, x + 3.85, y + 1.1, x + 4.2, y + 1.1);
    }
    { // 3 → 4: an elbow from the end of the first row to the start of the second
      const x3 = 0.55 + 2 * 4.2 + 3.85 / 2, x4 = 0.55 + 3.85 / 2, yTop = 1.35 + 2.2, yMid = yTop + 0.15, yBot = 1.35 + 2.5;
      s.addShape(pres.ShapeType.line, { x: x3, y: yTop, w: 0.01, h: 0.15, line: { color: C.muted, width: 1.5 } });
      s.addShape(pres.ShapeType.line, { x: x4, y: yMid, w: x3 - x4, h: 0.01, line: { color: C.muted, width: 1.5 } });
      arrow(s, x4, yMid, x4, yBot, C.muted);
    }
    s.addText('Three purposes, three proofs: the link proves somebody opened mail sent there; the code proves the mailbox is readable now; the ticket is the only thing the password step accepts — so the code can never be skipped by holding the link.', { x: 0.55, y: 6.35, w: 12.2, h: 0.6, fontFace: FONT, fontSize: 11.5, color: C.body, margin: 0, valign: 'top', isTextBox: true });
    s.addNotes('Read with onboarding.mp4. Approval is the only way a student account is minted; the setup walk is what makes the mailbox proof real; assignment is what makes the mentor able to see the student.');
  }
  await gridSlide({
    role: 'Applicant', heading: 'The new student\'s journey, as recorded',
    intro: 'Six frames from onboarding.mp4.',
    shots: [
      { name: 'onboard-1-register', caption: '1 · The public form' },
      { name: 'onboard-2-approved', caption: '2 · Approved by the office' },
      { name: 'onboard-3-address', caption: '3 · The link: type the address' },
      { name: 'onboard-3-password', caption: '3 · Code confirmed; set the password' },
      { name: 'onboard-4-home', caption: '4 · First sign-in' },
      { name: 'onboard-6-mentee', caption: '6 · On the mentor\'s Mentee Log' },
    ],
  });

  // ===== ALUMNI =============================================================
  await twoUpSlide({
    role: 'Alumni', heading: 'Alumni portal',
    points: ['A real role with no student record and no staff scope. On first sign-in there is no profile row, so the create form appears: current company, designation, batch year and a resume. The jobs sheet is the same postings the office published — without the match % and eligibility verdict, which need a student\'s marks.'],
    shots: [{ name: 'alumni-profile', caption: 'My Profile — created on first sign-in' }, { name: 'alumni-jobs', caption: 'Jobs Sheet — no match %, by design' }],
    notes: 'alumni.mp4. The create-profile form is driven by whether a profile row exists, never by an empty company string.',
  });

  // ===== CLOSE ==============================================================
  {
    const s = base();
    title(s, 'Reproducing this walkthrough');
    const left = [
      'Seeded logins (dev database only): student@bgscet.ac.in / student123 · mentor@bgscet.ac.in / mentor123 · admin@bgscet.ac.in / admin123 · alumni@bgscet.ac.in / alumni123',
      'Stack: docker compose up -d (Postgres 17 + pgvector) · apps/api-py: alembic upgrade head, python -m app.seed, uvicorn on 3300 · apps/web: npx ng serve on 4200',
      'Recorder: tools/demo/record-walkthrough.mjs drives the portal in Chromium and records it; tools/demo/render.sh makes the MP4s; tools/demo/build-deck.cjs rebuilds this deck from the screenshots',
      'Everything the videos show was written to a throwaway seeded database; run tools/demo/reset-dev-db.sh to start again from the same state',
    ];
    bullets(s, left, { x: 0.55, y: 1.4, w: 7.3, h: 4.8, size: 13 });
    s.addShape(pres.ShapeType.roundRect, { x: 8.3, y: 1.4, w: 4.5, h: 3.9, fill: { color: C.lilac }, line: { color: C.lilac }, rectRadius: 0.16 });
    s.addImage({ data: await icon('MdFolderOpen', C.purple), x: 8.55, y: 1.65, w: 0.5, h: 0.5 });
    s.addText([
      { text: 'Where the files are', options: { bold: true, fontSize: 15, breakLine: true } },
      { text: 'docs/presentation/', options: { bold: true, breakLine: true } },
      { text: '  REEP-portal-walkthrough.pptx — this deck', options: { breakLine: true } },
      { text: '  video/*.mp4 — the six recordings and the combined file', options: { breakLine: true } },
      { text: '  screens/*.png — every screenshot the deck uses', options: { breakLine: true } },
      { text: '  README.md — what each video covers, minute by minute', options: { breakLine: true } },
      { text: ' ', options: { breakLine: true } },
      { text: 'tools/demo/', options: { bold: true, breakLine: true } },
      { text: '  the recorder, the renderer, the deck builder and the reset script', options: {} },
    ], { x: 9.2, y: 1.6, w: 3.45, h: 4.2, fontFace: FONT, fontSize: 11.5, color: C.ink, margin: 0, valign: 'top', isTextBox: true });
    s.addNotes('Everything here is reproducible from the repository: reset the dev database, run the recorder, render, rebuild the deck.');
  }

  await pres.writeFile({ fileName: OUTFILE });
  console.log(`wrote ${OUTFILE} (${slideNo} slides)`);
  if (missing.length) console.log('missing screenshots (placeholders drawn):', missing.join(', '));
}

build().catch((e) => { console.error(e); process.exit(1); });
