/* REEP v5 prototype — Student screens, part 2: Leaderboards, Documents, Resume,
   Jobs, Interviews, English baseline, Mentor & TPO log, Profile.
   All data is invented and lives in memory (D.*, extended here). */
(() => {
'use strict';

/* ================================================================ shared bits */
const wide2 = () => matchMedia('(min-width: 1024px)').matches;
const nowTime = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const daysTo = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(TODAY + 'T00:00:00Z')) / 864e5);
const note2 = (st, inv) => (st.notice ? `<div class="banner ${st.notice[1] || 'info'}" role="status"${inv}>${ic(st.notice[1] === 'good' ? 'check' : 'info', 'sm')}<span>${esc(st.notice[0])}</span></div>` : '');
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; };
const yes = (b) => (b ? 'Yes' : 'No');
const pane = (html) => `<div class="card" style="min-height:200px">${html}</div>`;

/* ================================================================ data this file adds */
Object.assign(D, {
  lb: { scope: 'batch', label: 'MBA - Finance · 2025-27', dept: 'Management Studies', classmates: 9 },
  ivExtra: {
    11: {
      phaseKey: 'wrap_up',
      report: {
        well: ['Opened with a clear two-line summary of the internship.', 'Used numbers when describing the credit memos.'],
        work: ['Answers to the DCF question wandered before the conclusion.', 'Paused for long stretches in the deep dive.'],
        drill: 'Practise answering "walk me through a DCF" in under 90 seconds, conclusion first.',
      },
      turns: [
        { ph: 'Opening question', who: 'ai', t: 'Hello Aarav. Tell me a little about yourself and why Financial Analytics.' },
        { who: 'me', t: 'Hi, I am Aarav. I did my summer internship in credit at Kaveri Finance, where I built memos for SME borrowers…' },
        { ph: 'Framework probing', who: 'ai', t: 'How would you value a mid-sized dairy co-operative that has no listed peers?' },
        { who: 'me', t: 'Hmm, so…', flag: 'filler' },
        { who: 'me', t: 'I would start from free cash flow, build a five-year projection and pick a discount rate from…' },
        { ph: 'Deep dive', who: 'ai', t: 'Which assumption in that model worries you most, and why?' },
        { who: 'me', t: 'Next question please.', flag: 'skipped' },
        { who: 'ai', t: 'Sure. What would make you lower your growth rate mid-way through the—', cut: true },
        { who: 'me', t: 'Working capital, because milk payments to farmers are weekly while receivables run thirty days.' },
        { ph: 'Wrap-up', who: 'ai', t: 'Do you have any questions for us?' },
        { who: 'me', t: '', unheard: 'Not heard — the transcriber timed out' },
        { who: 'me', t: 'Yes — what does the first year look like for an analyst on your team?' },
      ],
    },
    10: {
      phaseKey: 'probing',
      turns: [
        { ph: 'Opening question', who: 'ai', t: 'Good afternoon. Please introduce yourself.' },
        { who: 'me', t: 'Hi, I am Aarav from the MBA programme.', flag: 'too short' },
        { ph: 'Framework probing', who: 'ai', t: 'How would you handle a grievance from a shift supervisor about overtime pay?' },
        { who: 'me', t: 'How would you handle a grievance from a shift supervisor', flag: 'echo' },
      ],
    },
    9: { phaseKey: 'opening', turns: [{ ph: 'Opening question', who: 'ai', t: 'Hello. Let us begin — tell me about yourself.' }] },
  },
  enExtra: {
    Reading: { subs: [['Comprehension', 80], ['Vocabulary', 76]], report: 'Reads business text accurately; occasionally misses inferred meaning in long paragraphs.' },
    Writing: { subs: [['Task response', 72], ['Grammar', 66]], report: 'Clear structure. Article and preposition errors recur ("discuss about", "in the 2025").' },
    Listening: { subs: [['Detail', 75], ['Gist', 73]], report: null },
    Speaking: { subs: [['Fluency', null], ['Pronunciation', null]], report: null },
  },
  enFeedback: {
    strengths: ['Reads financial news and reports with good accuracy.', 'Organises written answers into clear paragraphs.'],
    focus: ['Articles and prepositions in formal writing.', 'Following fast spoken numbers on the first listen.'],
    next: [['Practise structured answers in a mock interview', '#/student/interviews'], ['Write one 250-word summary of a business article each week', null], ['Sit the Speaking test', null]],
  },
  pf: { entry: '2025-08-01', done: '2027-06-30' },
});
if (!D.interviews.some((x) => x.id === 9)) D.interviews.push({ id: 9, date: '2026-09-20', track: 'Business Analytics', status: 'Failed', answers: 0, len: null, report: 'Unavailable', audio: false, phase: 'Opening', why: 'The connection to the interviewer dropped' });

/* ================================================================ Leaderboards */
const BOARDS = [['overall', 'Overall', I('B-002')], ['skills', 'Skills', I('B-003')], ['vtu', 'VTU results', I('B-004')], ['streak', 'Streak', I('B-005')], ['mocks', 'Mocks taken', I('B-006')]];
const BOARD_UNIT = { overall: (v) => `${v} pts`, skills: (v) => `${v} skill${v === 1 ? '' : 's'}`, vtu: (v) => `CGPA ${v.toFixed(1)}`, streak: (v) => `${v} days`, mocks: (v) => `${v} mock${v === 1 ? '' : 's'}` };
const BOARD_HOW = {
  overall: 'Skills, VTU results, streak and mocks are each worth up to 25 points, scaled against the best in your batch, for a score out of 100. Refreshed every night.',
  skills: 'Ranks skills a mentor has verified on Skilling. Refreshed every night.',
  vtu: 'Ranks your latest recorded CGPA. Updates when results are imported.',
  streak: 'Ranks the number of days you signed in. Refreshed every night.',
  mocks: 'Ranks mock interviews completed through to the verdict. Refreshed every night.',
};
const BOARD_JOIN = {
  overall: 'Sign in, claim a skill or finish a mock interview to appear here.',
  skills: 'Get one skill verified on Skilling to appear on this board.',
  vtu: 'You appear here once your VTU results are imported.',
  streak: 'Sign in on consecutive days to appear here.',
  mocks: 'Finish a mock interview through to the verdict to appear here.',
};
function rankRows(list) {
  const sorted = list.slice().sort((a, b) => b[1] - a[1]);
  let rank = 0, prev = null;
  return sorted.map(([n, v], i) => { if (v !== prev) { rank = i + 1; prev = v; } return { rank, name: n, v, me: n === D.me.student.name }; });
}

R.screen('student/leaderboards', { title: 'Leaderboards', states: 'B-007 B-011', render({ st, query }) {
  const s = D.me.student;
  const scope = query.scope || D.lb.scope;
  const board = st.board || 'overall';
  const scopeLine = scope === 'batch' ? `Ranked within your batch, ${esc(D.lb.label)}`
    : scope === 'department' ? `You are not seated in a batch yet, so you are ranked within ${esc(D.lb.dept)}`
      : 'You are not seated in a batch or a department yet, so there is nobody to rank you against';
  const seg = `<div class="seg" role="group" aria-label="Board" style="margin-bottom:14px">${BOARDS.map(([k, t, id]) => `<button type="button" data-act="board" data-v="${k}" aria-pressed="${k === board}"${id}>${t}</button>`).join('')}</div>`;
  let body;
  if (s.hidden) {
    body = `${note2(st, I('B-010'))}<div class="card"${I('B-008')}>${U.empty('eye', "You're hidden from the leaderboards", 'You see no rankings and appear on no board. Your mentor and the placement office still see your records.',
      `<button class="btn primary" type="button" data-act="rejoin"${st.busy ? ' disabled' : ''}${I('B-009')}>${st.busy ? 'Updating…' : 'Take part again'}</button>`)}</div>`;
  } else if (st.loading) {
    body = `${seg}<div class="card" role="status"${I('B-007')}><p class="muted">Loading the ${esc(BOARDS.find((b) => b[0] === st.loading)[1])} board…</p><div class="skel" style="height:12px;width:80%;margin-top:10px"></div><div class="skel" style="height:12px;width:60%;margin-top:8px"></div></div>`;
  } else {
    const raw = scope === 'none' ? [] : D.board[board] || [];
    const rows = rankRows(raw);
    const mine = rows.find((r) => r.me);
    const fmt = BOARD_UNIT[board];
    const hero = `<div class="card" style="display:flex;gap:16px;align-items:center"${I('B-012')}>
      ${mine ? `<div class="ring" style="--p:${Math.round(100 - ((mine.rank - 1) / Math.max(rows.length, 1)) * 100)}" data-v="${mine.rank}" role="img" aria-label="Rank ${mine.rank}"></div>` : `<span class="lead" style="width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:var(--tint-1);color:var(--brand-purple)">${ic('trophy', 'lg')}</span>`}
      <div class="grow">${mine ? `<div class="xs muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em">Your rank</div><h2 style="font-size:20px;margin:2px 0">${mine.rank} of ${rows.length}</h2>
        <div class="hrow">${chip(fmt(mine.v), 'info')}${mine.rank === 1 ? chip('Top of the board', 'good') : `${(() => { const up = rows.filter((r) => r.v > mine.v).pop(); return up ? `<span class="small muted">Next rank up: ${fmt(up.v)}</span>` : ''; })()}`}</div>`
    : `<h2 style="font-size:17px">Not ranked on this board yet</h2><p class="small muted" style="margin-top:4px">${BOARD_JOIN[board]}</p>`}</div></div>
      <p class="small muted" style="margin:10px 4px 0"${I('B-013')}>${BOARD_HOW[board]}</p>`;
    const table = rows.length ? `<div class="list"${I('B-014')}>${rows.map((r) => U.row({ title: `${esc(r.name)} ${r.me ? chip('You', 'info') : ''}`, sub: board === 'overall' ? 'Total out of 100' : '', lead: `<span class="lead av" style="${r.me ? 'background:var(--seq);color:#fff' : ''}">${r.rank}</span>`, trail: `<b class="num" style="color:var(--ink)">${fmt(r.v)}</b>`, sel: r.me })).join('')}</div>`
      : `<div class="card"${I('B-015')}>${U.empty('trophy', 'No ranking yet', scope === 'none' ? 'You are not seated in a batch yet. The placement office seats you when your batch is set up.' : D.lb.classmates <= 1 ? 'You are the only student in your batch so far.' : 'Nobody in your batch has a record on this board yet.')}</div>`;
    const ranked = new Set(rows.map((r) => r.name));
    const un = scope === 'none' ? [] : [...(ranked.has(s.name) ? [] : [s.name]), ...D.board.unranked].filter((n) => !ranked.has(n));
    const cap = 200;
    const unr = un.length ? U.section('Not ranked on this board yet', `<div class="card flat"${I('B-016')}><p class="xs muted" style="margin-bottom:8px">${un.length} of ${rows.length + un.length} classmates</p><div class="hrow">${un.slice(0, cap).map((n) => chip(n + (n === s.name ? ' (you)' : ''), 'neutral')).join('')}${un.length > cap ? `<span class="xs muted">+${un.length - cap} more</span>` : ''}</div></div>`) : '';
    body = `${note2(st, I('B-010'))}${seg}${hero}${U.section(BOARDS.find((b) => b[0] === board)[1], table)}${unr}`;
  }
  return U.page({ title: 'Leaderboards', lede: `<span${I('B-001')}>${scopeLine}</span>`, body });
},
acts: {
  board(el, ev, st) {
    const v = el.dataset.v; st.req = v; st.loading = v; App.rerender();
    setTimeout(() => { if (st.req !== v) return; st.board = v; st.loading = null; App.rerender(); }, 380); // only the last-requested board's answer is applied
  },
  rejoin(el, ev, st) {
    st.busy = true; App.rerender();
    setTimeout(() => { D.me.student.hidden = false; st.busy = false; st.notice = ["You're now visible on the leaderboards.", 'good']; App.rerender(); }, 500);
  },
} });

/* ================================================================ Documents (uploads) */
const KINDS = ['Certificate proof', 'Resume / CV', 'Profile photo', 'Other document'];
const upTone = { 'Pending review': 'warn', Verified: 'good', Rejected: 'risk', 'Needs changes': 'warn' };
const upIcon = { 'Pending review': 'clock', Verified: 'check', Rejected: 'x', 'Needs changes': 'alert' };
const OK_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

function uploadSheet(kind, replaceId) {
  const old = replaceId ? D.uploads.find((u) => u.id === replaceId) : null;
  let changed = false;
  const steps = (n) => `<ol class="hrow" style="list-style:none;padding:0;margin:0 0 14px;gap:6px"${I('B-017')}>${['Choose document type', 'Upload file', 'In review'].map((t, i) => `<li>${chip(`${i < n ? '✓ ' : ''}${i + 1}. ${t}`, i < n ? 'good' : i === n ? 'info' : 'neutral')}</li>`).join('')}</ol>`;
  const body = `<div data-steps>${steps(0)}</div>
    <div data-form class="stack">${U.field({ id: 'kind', label: 'Document type', opts: KINDS, value: kind || 'Certificate proof', inv: I('B-019') })}
    <p class="xs muted"${I('B-020')}>Accepted: PDF, PNG, JPEG · up to 10 MB</p>
    ${U.drop('file', 'Drag & drop a file here, or click to browse', 'PDF, PNG or JPEG', I('B-021'))}
    <div class="banner risk" role="alert" data-uerr hidden${I('B-022')}></div></div>
    <div data-done hidden${I('B-023')}></div>`;
  const el = Sheet.open({ title: old ? `Replace ${old.title}` : 'Upload a document', body,
    foot: `<button class="btn" type="button" data-sheet-close>Cancel</button>`,
    onClose: () => { if (changed) setTimeout(() => App.rerender(), 330); },
    onAct: { 'change:file': (a, ev, sh) => take(a.files[0], sh) } });
  const drop = el.querySelector('.drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--brand-purple)'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.style.borderColor = ''; take(e.dataTransfer.files[0], el); });
  function take(f, sh) {
    const err = sh.querySelector('[data-uerr]');
    if (!f) return;
    if (!OK_TYPES.includes(f.type) || f.size > 10 * 1048576) { err.hidden = false; err.innerHTML = `${ic('alert', 'sm')}<span><b>Upload failed.</b> Only PDF, PNG or JPEG up to 10 MB are accepted.</span>`; return; }
    err.hidden = true;
    sh.querySelector('[data-steps]').innerHTML = steps(1);
    sh.querySelector('.drop [data-file="file"]').textContent = 'Uploading…';
    const k = sh.querySelector('#kind').value;
    setTimeout(() => {
      const row = { id: Date.now(), title: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), kind: k, name: f.name, size: fmtSize(f.size), date: TODAY, status: 'Pending review', note: '', img: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      D.uploads.unshift(row);
      if (old) D.uploads.splice(D.uploads.indexOf(old), 1); // the old row goes only after the new one landed
      sh.querySelector('[data-steps]').innerHTML = steps(2);
      sh.querySelector('[data-form]').hidden = true;
      const done = sh.querySelector('[data-done]'); done.hidden = false;
      done.innerHTML = `<div class="banner good" role="status">${ic('check', 'sm')}<span><b>Uploaded — now in review.</b> A mentor will verify it shortly.</span></div>
        <div class="row" style="padding-left:0">${row.img ? `<img src="${row.img}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:10px">` : U.lead('file')}<div class="body"><div class="ttl">${esc(row.title)}</div><div class="sub">${esc(row.size)}</div></div></div>`;
      sh.querySelector('.sh-f').innerHTML = '<button class="btn primary" type="button" data-sheet-close>Done</button>';
      changed = true;
    }, 700);
  }
}

R.screen('student/uploads', { title: 'Documents', states: 'B-024 B-030', render({ st }) {
  const need = [['Profile photo', 'Profile photo'], ['Resume / CV', 'Resume / CV'], ['Certificate proof', 'Certificate proof']];
  const have = (k) => D.uploads.some((u) => u.kind === k && u.status !== 'Rejected');
  const out = need.filter(([k]) => !have(k)).length;
  const check = `<div class="card"${I('B-018')}><div class="card-h"><h2>Placement documents</h2>${out ? chip(`${out} outstanding`, 'warn') : chip('All in', 'good')}</div>
    <div class="list" style="border:0">${need.map(([k, t]) => U.row({ title: t, lead: U.lead(have(k) ? 'check' : 'file'), trail: have(k) ? chip('In', 'good') : `<button class="btn sm" type="button" data-act="up" data-kind="${k}">Upload</button>`, chev: false })).join('')}</div></div>`;
  const list = D.uploads.length ? `<div class="list"${I('B-024')}>${D.uploads.map((u) => `<div class="row" style="align-items:flex-start;flex-wrap:wrap">
      ${u.img ? `<img src="${u.img}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:10px">` : U.lead(u.kind === 'Profile photo' ? 'user' : 'file')}
      <div class="body"><div class="ttl">${esc(u.title)}</div><div class="sub">${esc(u.name)}</div><div class="xs faint">${esc(u.kind)} · ${esc(u.size)} · ${fmtDate(u.date)}</div>
        ${u.note ? `<p class="small" style="margin-top:6px;color:var(--${upTone[u.status] === 'good' ? 'good' : upTone[u.status] === 'risk' ? 'risk' : 'warn'})"${I('B-026')}><b>Reviewer:</b> ${esc(u.note)}</p>` : ''}
        <div style="margin-top:6px"><span class="chip ${upTone[u.status]}"${I('B-025')}>${ic(upIcon[u.status], 'sm')}${esc(u.status)}</span></div>
        <div class="hrow" style="margin-top:8px"><button class="btn sm" type="button" data-act="replace" data-id="${u.id}"${I('B-027')}>${ic('swap', 'sm')} Replace</button><button class="btn sm danger" type="button" data-act="remove" data-id="${u.id}"${I('B-028')}>${ic('trash', 'sm')} Remove</button></div></div></div>`).join('')}</div>`
    : `<div class="card"${I('B-029')}>${U.empty('inbox', 'Nothing on your record yet', 'Upload your resume, a photo and your certificates.')}</div>`;
  return U.page({ title: 'Documents', lede: 'Your placement documents and what your mentor said about them.',
    acts: `<button class="btn primary" type="button" data-act="up">${ic('upload', 'sm')} Upload a document</button>`,
    body: `${check}${U.section('Your documents', list)}` });
},
acts: {
  up(el) { uploadSheet(el.dataset.kind || 'Certificate proof'); },
  replace(el) { const u = D.uploads.find((x) => x.id === +el.dataset.id); uploadSheet(u.kind, u.id); },
  remove(el) {
    const u = D.uploads.find((x) => x.id === +el.dataset.id);
    Sheet.confirm({ title: `Remove ${u.title}?`, text: 'This permanently deletes the file from your record.', ok: 'Remove', danger: true,
      onOk: () => { el.textContent = 'Removing…'; setTimeout(() => { const i = D.uploads.indexOf(u); if (i >= 0) D.uploads.splice(i, 1); toast('Removed'); App.rerender(); }, 400); } });
  },
} });

/* ================================================================ Jobs */
function deadline(d) {
  if (!d) return chip('No deadline', 'neutral');
  const n = daysTo(d);
  if (n < 0) return chip('Closed', 'risk');
  if (n === 0) return chip('Closes today', 'risk');
  if (n <= 7) return chip(`Closes in ${n} day${n === 1 ? '' : 's'}`, 'warn');
  return chip(`Closes ${fmtShort(d)}`, 'neutral');
}
R.screen('student/jobs', { title: 'Jobs', states: 'B-112', render({ st }) {
  const locs = [...new Set(D.jobs.map((j) => j.loc))].sort();
  const any = st.elig || st.loc || st.dl;
  const rows = D.jobs.filter((j) => (!st.elig || (st.elig === 'yes') === j.eligible) && (!st.loc || j.loc === st.loc)
    && (!st.dl || (st.dl === 'soon' ? daysTo(j.closes) >= 0 && daysTo(j.closes) <= 7 : daysTo(j.closes) >= 0)));
  const filters = `<div class="filters" role="group" aria-label="Filters">
    ${U.select('elig', [['', 'Eligibility: All'], ['yes', 'Eligible'], ['no', 'Not eligible']], st.elig || '', I('B-108'), 'Eligibility')}
    ${U.select('loc', [['', 'All locations'], ...locs], st.loc || '', I('B-109'), 'Location')}
    ${U.select('dl', [['', 'Deadline: All'], ['soon', 'Closing soon'], ['open', 'Open']], st.dl || '', I('B-110'), 'Deadline')}
    ${any ? `<button class="btn sm ghost" type="button" data-act="clear"${I('B-111')}>Clear</button>` : ''}</div>`;
  const card = (j) => {
    const closed = j.closes && daysTo(j.closes) < 0;
    const tone = j.match >= 70 ? 'good' : j.match >= 50 ? 'warn' : 'risk';
    const btn = j.applied ? ['Applied', true] : closed ? ['Closed', true] : !j.eligible ? ['Not eligible', true] : ['Apply', false];
    return `<div class="card${j.eligible ? '' : ' flat'}" style="${j.eligible ? '' : 'background:var(--risk-bg);border-color:var(--risk-bg)'}">
      <div class="spread" style="align-items:flex-start"><div class="grow"><h3>${esc(j.title)}</h3><p class="small muted">${esc(j.company)} · ${esc(j.loc)}</p><div style="margin-top:6px"${I('B-113')}>${deadline(j.closes)}</div></div>
        <span${I('B-114')}>${j.eligible ? chip('Eligible', 'good') : chip('Not eligible', 'risk')}</span></div>
      <div style="margin:12px 0 4px"${I('B-115')}><div class="spread xs"><span class="muted">Skill match</span><b class="num">${j.match}%</b></div>${U.meter(j.match, tone)}</div>
      <div class="spread" style="margin-top:10px"><span class="small"${I('B-116')}${j.reasons.length > 1 ? ` title="${esc(j.reasons.join('; '))}"` : ''}>${!j.eligible ? `<span style="color:var(--risk)">${esc(j.reasons[0])}</span>` : j.applied ? chip('Applied', 'good') : chip('Not applied', 'neutral')}</span>
        <button class="btn ${btn[1] ? '' : 'primary'} sm" type="button" data-act="apply" data-id="${j.id}"${btn[1] ? ' disabled' : ''}${I('B-117')}>${btn[0]}</button></div></div>`;
  };
  const list = !D.jobs.length ? U.empty('briefcase', 'No roles on the board yet') : rows.length ? `<div class="grid-2">${rows.map(card).join('')}</div>` : `<div class="card">${U.empty('filter', 'No roles match these filters.')}</div>`;
  return U.page({ title: 'Jobs', lede: `${D.jobs.length} roles on the placement board`, body: `${filters}<div${I('B-112')}>${list}</div>` });
},
acts: {
  clear(el, ev, st) { st.elig = st.loc = st.dl = ''; App.rerender(); },
  apply(el) { const j = D.jobs.find((x) => x.id === +el.dataset.id); j.applied = true; toast(`Opened ${j.company}'s application page · marked Applied`); App.rerender(); },
} });

/* ================================================================ Interviews */
const ivTone = { 'In progress': 'info', Completed: 'good', 'Ended early': 'warn', Failed: 'risk' };
const repTone = { Ready: 'good', None: 'neutral', Unavailable: 'risk' };
const trackName = (t) => ({ HR: 'Human Resources', DM: 'Digital Marketing', BA: 'Business Analytics', FA: 'Financial Analytics' }[t] || t);

function ivDetail(iv) {
  const x = D.ivExtra[iv.id] || { turns: [] };
  const head = `<div class="card"${I('B-127')}><h2>${esc(trackName(iv.track))}</h2><p class="small muted" style="margin-top:4px">${fmtDate(iv.date)} · ${iv.len || '—'} · reached ${esc(iv.phase)}</p>
    <div class="hrow" style="margin-top:8px">${chip(iv.status, ivTone[iv.status])}${iv.audio ? chip('Audio saved', 'info') : ''}</div>
    ${iv.status !== 'Completed' && iv.why ? `<p class="small" style="margin-top:8px"><b>Ended because:</b> ${esc(iv.why)}</p>` : ''}
    <p class="small" style="margin-top:10px"${I('B-128')}>${ic(iv.audio ? 'mic' : 'info', 'sm')} ${iv.audio ? 'A voice recording of this interview was kept. Your mentor and the placement office can listen to it.' : 'No voice recording was kept for this interview.'}</p></div>`;
  const sc = iv.scores || {};
  const rep = iv.report === 'Ready' ? `<div class="card"${I('B-129')}><div class="card-h"><h2>Practice report</h2>${chip('Ready', 'good')}</div>
      <div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr))">${[['overall', 'Overall'], ['communication', 'Communication'], ['domain', 'Domain'], ['structure', 'Structure']].map(([k, t]) => U.kpi(sc[k] == null ? '—' : `${sc[k]}<span class="xs muted"> / 100</span>`, t)).join('')}</div>
      <p class="xs muted" style="margin-top:10px">Scored against a campus round at a Tier-1 multinational. A practice score is not a placement decision.</p>
      ${x.report ? `<h3 style="margin-top:14px">What went well</h3><ul class="small">${x.report.well.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><h3>What to work on</h3><ul class="small">${x.report.work.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><h3>Practise this next</h3><p class="small">${esc(x.report.drill)}</p>` : ''}</div>`
    : `<div class="card"${I('B-130')}>${U.empty('file', 'No report for this interview', iv.status === 'In progress' ? 'It is written when the interview finishes.' : 'This interview ended before the verdict, or predates reports.')}</div>`;
  const tr = x.turns.length ? `<div class="card"${I('B-131')}><div class="chat">${x.turns.map((t) => `${t.ph ? `<div class="xs faint" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:6px">${t.ph}</div>` : ''}
      <div class="bubble ${t.who === 'me' ? 'me' : 'ai'}"><div class="xs" style="opacity:.75;font-weight:700">${t.who === 'me' ? 'You' : 'Interviewer'}</div>${t.unheard ? `<i>${esc(t.unheard)}</i>` : esc(t.t)}
      ${t.cut ? `<div class="xs" style="margin-top:4px">${chip('cut off — you spoke over it', 'warn')}</div>` : ''}${t.flag ? `<div class="xs" style="margin-top:4px">${chip(t.flag, 'neutral')}</div>` : ''}</div>`).join('')}</div></div>` : '';
  return `<div class="stack">${head}${rep}${tr ? U.section('Transcript', tr) : ''}</div>`;
}
R.screen('student/interviews', { title: 'Interviews', render({ id, st, query }) {
  const list = query.fresh ? [] : D.interviews.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  if (id) { const iv = D.interviews.find((x) => String(x.id) === id); return U.page({ title: iv ? trackName(iv.track) : 'Interview', back: true, body: iv ? ivDetail(iv) : U.empty('alert', 'That interview is not on your record') }); }
  const start = `<a class="btn primary" href="#/student/assistant"${I('B-118')}>${ic('mic', 'sm')} Start a new interview</a>`;
  if (!list.length) return U.page({ title: 'Interviews', lede: `<span${I('B-119')}>Kept on the college server. Your mentor and the placement office can read them; clearing the conversation does not delete them.</span>`, acts: start, body: `<div class="card"${I('B-120')}>${U.empty('mic', 'No interviews yet', '', `<a class="btn primary" href="#/student/assistant">Take your first interview</a>`)}</div>` });
  const sel = st.sel === undefined ? list[0].id : st.sel;
  const tiles = `<div class="grid-3" style="grid-template-columns:repeat(3,1fr);gap:8px"${I('B-121')}>${U.kpi(list.length, 'Interviews taken')}${U.kpi(list.filter((x) => x.status === 'Completed').length, 'Completed to the end')}${U.kpi(list.filter((x) => x.report === 'Ready').length, 'Reports written')}</div>`;
  const rows = `<div class="list"${I('B-122')}>${list.map((iv) => `<button class="row${wide2() && iv.id === sel ? ' sel' : ''}" type="button" data-act="openIv" data-id="${iv.id}" aria-expanded="${wide2() && iv.id === sel}"${I('B-126')}>
      ${U.lead('mic')}<div class="body"><div class="ttl">${esc(trackName(iv.track))}</div><div class="sub">${fmtShort(iv.date)} · ${iv.answers} answers · ${iv.len || '—'}</div>
      <div class="hrow" style="margin-top:6px"><span${I('B-123')}>${chip(iv.status, ivTone[iv.status])}</span>${iv.audio ? `<span${I('B-124')}>${chip('Audio saved', 'info')}</span>` : ''}<span${I('B-125')}>${iv.report ? chip(`Report: ${iv.report}`, repTone[iv.report]) : '—'}</span></div></div>
      <span class="trail small" style="color:var(--brand-purple);font-weight:600">${wide2() && iv.id === sel ? 'Close' : 'Open'}</span></button>`).join('')}</div>`;
  const cur = list.find((x) => x.id === sel);
  return U.page({ title: 'Interviews', lede: `<span${I('B-119')}>Kept on the college server. Your mentor and the placement office can read them; clearing the conversation does not delete them.</span>`, acts: start,
    body: `${tiles}<div class="split" style="margin-top:16px"><div>${rows}</div><div class="detail-pane">${cur ? ivDetail(cur) : pane(U.empty('mic', 'Pick an interview'))}</div></div>` });
},
acts: { openIv(el, ev, st) { const id = +el.dataset.id; if (wide2()) { st.sel = st.sel === id ? null : id; App.rerender(); } else R.go(`#/student/interviews/${id}`); } } });

/* ================================================================ English baseline */
const SECTION_ORDER = ['Reading', 'Writing', 'Listening', 'Speaking'];
R.screen('student/english', { title: 'English baseline', states: 'B-135', render({ st, query }) {
  const e = D.english;
  const started = e.started && !query.fresh;
  const startBtn = (label, inv) => `<button class="btn primary" type="button" data-act="start"${st.busy ? ' disabled' : ''}${inv}>${st.busy ? 'Working…' : label}</button>`;
  if (!started) return U.page({ title: 'English baseline', body: `${note2(st, I('B-134'))}<div class="card"${I('B-136')}>${U.empty('book', 'You have not taken the English baseline', 'About 70 minutes, four sections, banded on the CEFR scale. Your mentor sees your band, not your answers.', startBtn('Start assessment', ''))}</div>` });
  const scored = e.sections.filter((s) => s[1] != null);
  const pending = e.sections.filter((s) => s[1] == null);
  const pct = Math.round((scored.length / 4) * 100);
  const dial = `<div class="card" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"${I('B-137')}>
    <div class="ring" style="--p:${e.overall == null ? 0 : e.overall}" data-v="${e.overall == null ? '--' : e.overall}" role="img" aria-label="Overall ${e.overall == null ? 'not scored' : e.overall + ' of 100'}"></div>
    <div class="grow"><div class="xs muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em">Overall / 100</div>
      <h2 style="font-size:20px;margin:4px 0">${e.band ? `${e.provisional ? 'Provisional band' : 'Band'} ${esc(e.band)}` : 'Not yet banded'}</h2>
      <div class="hrow"${I('B-138')}>${chip(`${scored.length} of 4 sections scored`, scored.length === 4 ? 'good' : 'info')}${pending.length ? chip(`${pending[0][0]} pending`, 'warn') : ''}${e.taken ? chip(`Taken ${fmtDate(e.taken)}`, 'neutral') : ''}</div></div></div>
    <div class="card flat" style="margin-top:12px"${I('B-139')}><div class="spread small"><b>Assessment progress</b><span class="num">${pct}%</span></div><div role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">${U.meter(pct)}</div>
      ${e.provisional && pending.length ? `<p class="xs muted" style="margin-top:6px">The band is provisional until ${pending[0][0]} is scored.</p>` : ''}</div>`;
  const sec = (s) => {
    const [name, score, band] = s; const x = D.enExtra[name] || { subs: [] }; const open = st.rep === name;
    return `<div class="card"${I('B-140')}><div class="card-h"><h2>${name}</h2>${score != null ? chip('Scored', 'good') : chip('Pending', 'warn')}</div>
      <p class="small">${score != null ? `<b class="num">${score} / 100</b> · CEFR ${esc(band)}` : '<b>--</b> / 100'}</p>
      ${x.subs.map(([t, v]) => `<div style="margin-top:8px"><div class="spread xs"><span class="muted">${t}</span><b class="num">${v == null ? '--' : v}</b></div>${U.meter(v || 0)}</div>`).join('')}
      <div style="margin-top:12px">${score == null ? `<button class="btn sm" type="button" data-act="start"${I('B-142')}>Start ${name.toLowerCase()} test</button>`
    : x.report ? `<button class="btn sm ghost" type="button" data-act="rep" data-s="${name}" aria-expanded="${open}"${I('B-141')}>${open ? 'Hide AI report' : 'View AI report'}</button>${open ? `<p class="small" style="margin-top:8px">${esc(x.report)}</p>` : ''}`
      : '<p class="xs muted">No written report for this section.</p>'}</div></div>`;
  };
  const fb = D.enFeedback;
  const feedback = `<div class="grid-2"${I('B-143')}><div class="card flat"><h3>Strengths</h3>${scored.length ? `<ul class="small">${fb.strengths.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="small muted">Shown once a section is scored.</p>'}</div>
    <div class="card flat"><h3>Focus areas</h3>${scored.length ? `<ul class="small">${fb.focus.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="small muted">Shown once a section is scored.</p>'}</div></div>`;
  const next = `<div class="list"${I('B-144')}>${scored.length ? fb.next.map(([t, to]) => U.row({ title: esc(t), lead: U.lead('sparkle'), href: to || '', chev: !!to })).join('') : U.row({ title: 'Recommendations appear once a section is scored.', chev: false })}</div>`;
  return U.page({ title: 'English baseline', lede: 'One attempt per semester. Your mentor sees the band, not your answers.',
    acts: `<button class="btn" type="button" data-act="dl"${I('B-132')}>${ic('download', 'sm')} Download report</button>${startBtn(pending.length ? 'Resume assessment' : 'Start assessment', I('B-133'))}`,
    body: `${note2(st, I('B-134'))}${dial}${U.section('Sections', `<div class="grid-2">${SECTION_ORDER.map((n) => sec(e.sections.find((s) => s[0] === n))).join('')}</div>`)}${U.section('AI feedback', feedback)}${U.section('Recommended next', next)}` });
},
acts: {
  start(el, ev, st) { st.busy = true; App.rerender(); setTimeout(() => { st.busy = false; D.english.started = true; st.notice = ['Your assessment is open where you left it. Sections you finished stay scored.', 'info']; App.rerender(); }, 600); },
  rep(el, ev, st) { st.rep = st.rep === el.dataset.s ? null : el.dataset.s; App.rerender(); },
  dl(el, ev, st) {
    const e = D.english; const txt = `REEP — English baseline report\n${D.me.student.name} · ${D.me.student.usn}\nTaken ${e.taken}\nOverall: ${e.overall ?? '--'} / 100 · ${e.provisional ? 'Provisional band' : 'Band'} ${e.band || '—'}\n\n${e.sections.map(([n, s, b]) => `${n}: ${s ?? '--'} / 100 ${b ? '· ' + b : '(pending)'}`).join('\n')}\n`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = 'english-baseline-report.txt'; a.click();
    st.notice = ['Report downloaded.', 'good']; App.rerender();
  },
} });

/* ================================================================ Mentor & TPO log */
const actTone = (a) => (a === 'None' ? 'neutral' : 'warn');
R.screen('student/mentor-log', { title: 'Mentor & TPO log', states: 'B-151', render({ st }) {
  const quads = ['Strengths', 'Weaknesses', 'Opportunities', 'Challenges'];
  const swoc = D.swoc.length ? `<div class="grid-2"${I('B-148')}>${quads.map((q) => { const l = D.swoc.filter((x) => x.q === q); return `<div class="card flat"><h3 style="margin-bottom:8px">${q}</h3>${l.length ? l.map((x) => `<div style="padding:8px 0;border-top:1px solid var(--hairline-26)"><p class="small">${esc(x.text)}</p>
      <p class="xs faint" style="margin-top:2px">${esc(x.by)} · ${x.src === 'MENTOR' ? 'Mentor' : 'Placement office'} · ${fmtShort(x.when)}</p>
      <div style="margin-top:6px">${x.ack ? `<span class="xs" style="color:var(--good)">${ic('check', 'sm')} You read this on ${fmtDate(x.ack)}</span>` : `<button class="btn sm" type="button" data-act="ack" data-id="${x.id}" aria-label="Mark as read: ${esc(x.text)}"${I('B-149')}>Mark as read</button>`}</div></div>`).join('') : '<p class="small muted">No entries yet</p>'}</div>`; }).join('')}</div>`
    : `<div class="card"${I('B-148')}>${U.empty('grid', 'No SWOC inputs yet')}</div>`;
  const hist = D.meetings.length ? `<div class="list"${I('B-152')}>${D.meetings.map((m) => { const d = new Date(m.date + 'T00:00:00'); return `<div class="row" style="align-items:flex-start">
      <span class="lead" style="flex-direction:column;line-height:1.05;font-weight:800;font-family:var(--font-display)"><span>${d.getDate()}</span><span class="xs" style="font-weight:600">${d.toLocaleString('en-IN', { month: 'short' })}</span></span>
      <div class="body"><div class="ttl">${esc(m.title)}</div><div class="sub">${esc(m.loc)}</div>${m.note ? `<p class="small" style="margin-top:4px">${esc(m.note)}</p>` : ''}<p class="xs faint" style="margin-top:4px">Logged by ${esc(m.by)}</p></div>
      <span${I('B-153')}>${chip(m.action, actTone(m.action))}</span></div>`; }).join('')}</div>`
    : `<div class="card"${I('B-152')}>${U.empty('cal', 'No meetings logged yet')}</div>`;
  return U.page({ title: 'Mentor & TPO log', lede: `Your mentor: ${esc(D.me.student.mentor)}`,
    acts: `<button class="btn primary" type="button" data-act="req"${st.reqOpen ? ' disabled' : ''}${I('B-145')}>${ic('cal', 'sm')} Request a meeting</button>`,
    body: `${note2(st, I('B-150'))}${U.section('SWOC from your mentor and TPO', swoc)}${U.section('Meeting history', hist)}` });
},
acts: {
  req(el, ev, st) {
    st.reqOpen = true; el.disabled = true;
    const sh = Sheet.open({ title: 'Request a meeting', onClose: () => { st.reqOpen = false; setTimeout(() => App.rerender(), 330); },
      body: `<div class="stack"${I('B-146')}>${U.field({ id: 'why', label: 'What would you like to discuss?', type: 'textarea', req: true, attrs: ' data-act-input="x" data-f="why"' })}${U.field({ id: 'when', label: 'Preferred time (optional)', ph: 'e.g. Thursday after 2 pm' })}</div>`,
      foot: `<button class="btn" type="button" data-sheet-close${I('B-147')}>Cancel</button><button class="btn primary" type="button" data-act="send" disabled${I('B-147')}>Send request</button>`,
      onAct: {
        'input:why': (a, e2, s) => { s.querySelector('[data-act="send"]').disabled = !a.value.trim(); },
        send: (a, e2, s) => {
          const v = formVals(s); if (!v.why) return errs(s, { why: 'Say what you would like to discuss.' });
          a.disabled = true; a.textContent = 'Sending…';
          setTimeout(() => { D.meetings.unshift({ date: TODAY, title: 'Meeting requested', loc: v.when || 'Time to be agreed', action: 'None', note: v.why, by: 'You (request)' }); st.notice = [`Request sent to ${D.me.student.mentor}.`, 'good']; Sheet.close(); }, 500);
        },
      } });
    return sh;
  },
  ack(el, ev, st) { const x = D.swoc.find((s) => s.id === +el.dataset.id); x.ack = TODAY; st.notice = ['Marked as read. Your mentor can see that you read it.', 'info']; App.rerender(); },
} });

/* ================================================================ Profile */
const PF = ['phone', 'email', 'linkedin', 'github', 'portfolio', 'city', 'summary', 'jobs', 'internships', 'hidden'];
const hostIs = (v, h) => { try { const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); return u.hostname === h || u.hostname.endsWith('.' + h); } catch { return false; } };
const PF_RULE = {
  phone: (v) => !v || (/^\+?[\d ]+$/.test(v) && (v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15)) || 'Use digits and spaces, with an optional leading +; 7 to 15 digits.',
  email: (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || 'Enter an address like name@domain.com.',
  linkedin: (v) => !v || hostIs(v, 'linkedin.com') || 'This must be a linkedin.com address.',
  github: (v) => !v || hostIs(v, 'github.com') || 'This must be a github.com address.',
  portfolio: (v) => { if (!v) return true; try { const u = new URL(v); return (/^https?:$/.test(u.protocol) && u.hostname.includes('.')) || 'Enter a full http(s) address.'; } catch { return 'Enter a full http(s) address.'; } },
};
const pfErr = (d) => Object.fromEntries(Object.entries(PF_RULE).map(([k, f]) => [k, f(d[k])]).filter(([, r]) => r !== true));
function pfCompletion(d) {
  const e = pfErr(d);
  const items = [['phone', 'a phone number'], ['email', 'a contact email'], ['linkedin', 'LinkedIn'], ['city', 'a city'], ['summary', 'a career summary'], ['jobs', 'a jobs preference'], ['internships', 'an internships preference']];
  const done = items.filter(([k]) => d[k] && !e[k]);
  return { n: done.length, missing: items.filter(([k]) => !(d[k] && !e[k])).map((x) => x[1]) };
}
function pfSync(main, st) {
  const d = st.d; const e = pfErr(d);
  const dirty = PF.some((k) => d[k] !== D.me.student[k === 'linkedin' ? 'linkedin' : k]);
  st.dirty = dirty;
  for (const k of Object.keys(PF_RULE)) {
    const show = (st.touched[k] || st.tried) && e[k];
    const box = main.querySelector(`[data-err="pf-${k}"]`); if (box) box.textContent = show ? e[k] : '';
    const inp = main.querySelector(`#pf-${k}`); if (inp) { if (show) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
  }
  const valid = !Object.keys(e).length;
  const btn = main.querySelector('[data-act="psave"]'); if (btn) btn.disabled = !dirty || !valid || st.saving;
  const ss = main.querySelector('[data-pfstate]');
  if (ss) ss.innerHTML = st.saving ? chip('Saving…', 'info') : dirty ? chip('Unsaved changes', 'warn') : st.savedAt ? chip(`Saved just now · ${st.savedAt}`, 'good') : chip('Up to date', 'neutral');
  const sum = main.querySelector('[data-pfsum]'); if (sum) sum.hidden = valid;
  const c = pfCompletion(d); const pct = Math.round((c.n / 7) * 100);
  const m = main.querySelector('[data-pfmeter]');
  if (m) m.innerHTML = `<div class="spread small"><b>Placement profile completion</b><span class="num">${c.n} of 7</span></div>${U.meter(pct, pct < 60 ? 'risk' : pct < 100 ? 'warn' : 'good')}${c.missing.length ? `<p class="xs muted" style="margin-top:6px">Add ${c.missing.join(', ')}.</p>` : ''}`;
}
R.screen('student/profile', { title: 'Profile', states: 'B-154', render({ st }) {
  const s = D.me.student;
  if (!st.d || !st.dirty) st.d = Object.fromEntries(PF.map((k) => [k, s[k]]));
  st.touched ||= {};
  const d = st.d;
  const inp = (k, label, type = 'text', ph = '', inv = '') => U.field({ id: `pf-${k}`, label, type, value: d[k] || '', ph, inv, attrs: ` data-pf="${k}"` });
  const ro = (label, val, extra = '') => `<div class="field"><div class="lbl">${label}</div><div class="input" style="background:var(--tint-3);display:flex;align-items:center;gap:8px" aria-readonly="true"><span class="grow">${val ? esc(val) : '<span class="muted">—</span>'}</span>${chip('Synced · read-only', 'neutral')}</div>${extra}</div>`;
  const levels = [['College', COLLEGE.name, 'set'], ['Department', s.dept, 'set'], ['Course', s.course, 'set'], ['Specialization', s.spec2 ? `${s.spec} and ${s.spec2}` : s.spec, 'set'], ['Batch', s.batch, 'set']];
  const identity = `<div class="card"><div class="card-h"><h2>Identity</h2></div><div class="form-grid"${I('B-158')}>${ro('Full name', s.name)}${ro('USN', s.usn, s.usn ? '' : '<p class="xs" style="color:var(--warn)">No USN on your record — ask the placement office.</p>')}</div>
    <div class="divider"></div><dl class="kv"${I('B-159')}>${levels.filter((l) => l[2] !== 'not_in_use').map(([t, v, state]) => `<dt>${t}</dt><dd>${state === 'pending' ? '— <span class="xs muted">Not yet recorded</span>' : esc(v)}</dd>`).join('')}<dt>Entry date</dt><dd>${fmtDate(D.pf.entry)}</dd><dt>Expected completion</dt><dd>${fmtDate(D.pf.done)}</dd></dl>
    <p class="xs muted" style="margin-top:8px">${ic('shield', 'sm')} Verified by Main Admin</p></div>`;
  const contact = `<div class="card"><div class="card-h"><h2>Contact and links</h2></div><div class="form-grid">
    ${inp('phone', 'Phone', 'tel', '+91 98450 22113', I('B-160'))}${inp('email', 'Contact email', 'email', 'name@domain.com', I('B-161'))}
    ${inp('linkedin', 'LinkedIn', 'url', 'linkedin.com/in/you', I('B-162'))}${inp('github', 'GitHub', 'url', 'github.com/you', I('B-163'))}
    <div${I('B-164')} style="display:contents">${inp('portfolio', 'Portfolio', 'url', 'https://')}${inp('city', 'City')}</div></div>
    <div style="margin-top:12px">${U.field({ id: 'pf-summary', label: 'Career summary', type: 'textarea', value: d.summary || '', inv: I('B-165'), attrs: ' data-pf="summary"' })}</div></div>`;
  const prefs = `<div class="card"><div class="card-h"><h2>Placement</h2><span${I('B-167')}>${s.cleared ? chip('Cleared for placements', 'good') : chip('Not cleared', 'risk')}</span></div>
    <div${I('B-166')}><label class="check"><input type="checkbox" data-pf="jobs"${d.jobs ? ' checked' : ''}><span>Interested in jobs</span></label><label class="check"><input type="checkbox" data-pf="internships"${d.internships ? ' checked' : ''}><span>Interested in internships</span></label></div>
    <div class="divider"></div><label class="check spread"${I('B-168')}><span>Hide me from the leaderboards<br><span class="xs muted">Privacy only — job matching is not affected.</span></span><input class="switch" type="checkbox" data-pf="hidden"${d.hidden ? ' checked' : ''}></label></div>`;
  const earned = D.badges.filter((b) => b.st === 'earned');
  const skills = `<div class="card"${I('B-169')}><div class="card-h"><h2>Skills</h2>${chip('From Skilling', 'info')}</div>${earned.length ? `<div class="hrow">${earned.map((b) => chip(b.name, 'good')).join('')}</div>` : '<p class="small muted">No skills yet — claim skills on the <a href="#/student/skilling">Skilling</a> page.</p>'}</div>`;
  return U.page({ title: 'Profile', lede: `<span data-pfstate aria-live="polite"${I('B-154')}></span>`,
    body: `<div class="banner risk" role="alert" data-pfsum hidden${I('B-156')}>${ic('alert', 'sm')}<span>Some fields need fixing before you can save.</span></div>
      <div class="card" style="margin:12px 0" data-pfmeter${I('B-157')}></div>
      <div class="grid-2" style="align-items:start"><div class="stack-4">${identity}${skills}</div><div class="stack-4">${contact}${prefs}</div></div>
      <div class="sticky-act"><button class="btn primary" type="button" data-act="psave" disabled${I('B-155')}>Save changes</button></div>` });
},
mount(main, { st }) {
  const set = (t) => { const k = t.dataset.pf; st.d[k] = t.type === 'checkbox' ? t.checked : t.value.trim(); if (k === 'hidden' && st.savedAt) st.savedAt = null; pfSync(main, st); };
  main.addEventListener('input', (e) => { const t = e.target.closest('[data-pf]'); if (t) set(t); });
  main.addEventListener('change', (e) => { const t = e.target.closest('[data-pf]'); if (t) set(t); });
  main.addEventListener('focusout', (e) => {
    const t = e.target.closest('[data-pf]'); if (!t || t.type === 'checkbox') return;
    const k = t.dataset.pf;
    if (k === 'linkedin' && t.value.trim() && !/^https?:\/\//i.test(t.value.trim())) { t.value = `https://${t.value.trim()}`; st.d.linkedin = t.value; }
    st.touched[k] = true; pfSync(main, st);
  });
  pfSync(main, st);
},
acts: {
  psave(el, ev, st) {
    st.tried = true; const main = document.getElementById('main');
    if (Object.keys(pfErr(st.d)).length) return pfSync(main, st);
    st.saving = true; pfSync(main, st);
    setTimeout(() => { Object.assign(D.me.student, st.d); st.saving = false; st.savedAt = nowTime(); App.rerender(); toast('Profile saved'); }, 500);
  },
} });

/* ================================================================ Resume */
const RS = D.rs = {
  goal: { role: 'Credit Analyst', loc: 'Any', job: '' },
  saved: '09:40', dirty: false, saving: false,
  basic: { photo: null, middle: '', gender: 'Male', dob: '2002-04-11', blood: 'B+', marital: 'Single', languages: ['English', 'Kannada', 'Hindi'], dream: 'Kaveri Finance Ltd', medical: '' },
  contact: { phones: ['+91 80 2345 6789'], emails: ['aarav.k@mailbox.in'], links: [{ type: 'LinkedIn', url: D.me.student.linkedin }],
    cur: { l1: '14, 3rd Cross, Sanjay Nagar', l2: '', country: 'India', state: 'Karnataka', city: 'Bengaluru', pin: '560094' }, same: true,
    perm: { l1: '', l2: '', country: 'India', state: '', city: '', pin: '' } },
  family: { father: { name: 'Suresh Kulkarni', occ: 'Business', org: 'Kulkarni Traders', des: 'Proprietor', email: '', phone: '' }, mother: { name: 'Lata Kulkarni', occ: 'Teacher', org: 'Govt. High School, Tumakuru', des: 'Assistant Teacher', email: '', phone: '' }, others: [] },
  correction: null,
  skills: ['Negotiation'],
  experience: [],
  internship: (D.resume.experience || []).map((x) => ({ title: x.role, org: x.org, sector: 'Banking & finance', loc: 'Bengaluru', start: x.start, end: x.end, desc: 'Built credit memos for 14 SME borrowers and tracked covenant breaches.' })),
  projects: [{ title: 'Working-capital model for a dairy co-operative', desc: 'Three-statement model with a weekly cash bridge.', tech: ['Excel', 'Power BI'], link: '' }],
  publications: [],
  seminars: [{ title: 'Bloomberg Market Concepts', provider: 'Bloomberg', date: '2026-08' }],
  certs: [{ title: 'NISM Series VIII — Equity Derivatives', provider: 'NISM', year: '2026', link: '', st: 'awaiting verification' }],
  reepCerts: [{ title: 'Financial Modelling', st: 'In progress', pct: 64, hours: 18, prov: 'REEP · provider-verified' }, { title: 'Business Communication', st: 'Completed', pct: 100, hours: 14, prov: 'REEP · provider-verified' }],
  por: [{ title: 'Secretary, Finance club', org: 'NHSM Finance Club', dur: '2025–26', desc: 'Ran weekly market briefings for 60 members.' }],
  other: { objective: 'Finance graduate student seeking a credit or equity research role where analysis drives lending and investment decisions.', expertise: ['Financial modelling', 'Credit appraisal'], achievements: ['Top 5 in the inter-college valuation challenge 2026'], awards: [], cocurr: ['Organised the 2026 finance fest'], extra: [], links: [] },
  references: [],
  policy: { accepted: D.resume.policyAccepted, eligible: true },
  gen: null, ats: false, appendix: false, consent: false, genTitle: '',
};
const SECTIONS = [
  ['Identity', [['basic', 'Basic Details', 'Identity and demographics. Fields synced from the university record are locked.'], ['contact', 'Contact Details', 'Phone, email, links and addresses.'], ['family', 'Family Details', 'Next-of-kin information required by the placement office.']]],
  ['Academics', [['education', 'Education', 'Semester record, prior qualifications and declared academic gaps.'], ['attachments', 'Attachments', 'Every document, routed from the section that owns it.'], ['evidence_skills', 'Evidence-backed Skills', 'Skills a mentor has verified, and which of them this resume claims.']]],
  ['Experience', [['experience', 'Professional Experience', 'Full-time roles.'], ['internship', 'Internship', 'Internships, tracked separately from full-time experience.'], ['projects', 'Projects', 'Academic, capstone and personal projects.']]],
  ['Achievement', [['publications', 'Publications / Research', 'Published or in-review research output.'], ['seminars', 'Seminars / Trainings', 'Short-form learning that is not a full certification.'], ['certifications', 'Certification / Assessments', 'REEP certifications sync automatically; add outside ones yourself.'], ['por', 'Positions of Responsibility', 'Leadership and committee roles.']]],
  ['Final', [['other', 'Other Details', 'Objective, key expertise, achievements, awards and activities.'], ['references', 'References', 'Referees a recruiter may contact.'], ['policy', 'Placement Policy', 'Controls which opportunities you appear against.']]],
];
const SEC = Object.fromEntries(SECTIONS.flatMap(([, l]) => l.map(([k, t, sub]) => [k, { t, sub }])));
const ENTRY = {
  experience: { noun: 'experience', title: 'Role / title', inv: I('B-068'), fields: [['org', 'Organisation'], ['sector', 'Sector'], ['loc', 'Location'], ['start', 'Start', 'month'], ['end', 'End', 'month'], ['desc', 'Description', 'textarea']] },
  internship: { noun: 'internship', title: 'Role / title', inv: I('B-070'), fields: [['org', 'Organisation'], ['sector', 'Sector'], ['loc', 'Location'], ['start', 'Start', 'month'], ['end', 'End', 'month'], ['desc', 'Description', 'textarea']] },
  projects: { noun: 'project', title: 'Project title', inv: I('B-071'), fields: [['desc', 'Description', 'textarea'], ['tech', 'Tech / skills', 'tags'], ['link', 'Link', 'url']] },
  publications: { noun: 'publication', title: 'Title', inv: I('B-072'), fields: [['publisher', 'Publisher / journal'], ['date', 'Date', 'month'], ['coauthors', 'Co-authors'], ['link', 'DOI / link', 'url']] },
  seminars: { noun: 'training', title: 'Title', inv: I('B-073'), fields: [['provider', 'Provider'], ['date', 'Date', 'month']] },
  por: { noun: 'position', title: 'Title / role', inv: I('B-077'), fields: [['org', 'Organisation'], ['dur', 'Duration'], ['desc', 'What you were accountable for', 'textarea']] },
  certs: { noun: 'certification', title: 'Certification name', inv: I('B-075'), req: 'A certification name is required.', fields: [['provider', 'Provider'], ['year', 'Year', 'number'], ['link', 'Credential link', 'url']] },
};
const verified = () => D.badges.filter((b) => b.st === 'earned').map((b) => b.name);
function secState(k) {
  const r = RS;
  const st = {
    basic: [r.basic.gender, r.basic.dob].filter(Boolean).length,
    contact: ['l1', 'country', 'state', 'city'].filter((f) => r.contact.cur[f]).length === 4 ? 2 : 1,
    family: r.family.father.name || r.family.mother.name ? 2 : 0,
    education: 2, attachments: D.uploads.length ? 2 : 0, evidence_skills: r.skills.length ? 2 : 0,
    certifications: r.certs.length || r.reepCerts.length ? 2 : 0,
    other: (r.other.objective ? 1 : 0) + (r.other.expertise.length ? 1 : 0),
    references: r.references.length ? 2 : 0, policy: r.policy.accepted ? 2 : 0,
  }[k];
  const v = st === undefined ? (r[k] && r[k].length ? 2 : 0) : st;
  return v >= 2 ? 'done' : v === 1 ? 'partial' : 'empty';
}
const stChip = (s) => (s === 'done' ? chip('Done', 'good') : s === 'partial' ? chip('Partly done', 'warn') : chip('Empty', 'neutral'));
const rsComplete = () => { const all = SECTIONS.flatMap(([, l]) => l.map((x) => secState(x[0]))); return Math.round(((all.filter((s) => s === 'done').length + all.filter((s) => s === 'partial').length / 2) / all.length) * 100); };
const rsJob = () => D.jobs.find((j) => String(j.id) === String(RS.goal.job));
function rsSaveChip() {
  return RS.saving ? chip('Saving…', 'info') : RS.dirty ? chip('Unsaved changes', 'warn') : RS.saved ? chip(`Saved ${RS.saved}`, 'good') : chip('Not saved yet', 'neutral');
}
let rsTimer;
function rsDirty() {
  RS.dirty = true; const b = document.querySelector('[data-rssave]'); if (b) b.innerHTML = rsSaveChip();
  clearTimeout(rsTimer); rsTimer = setTimeout(() => rsSave(), 2500); // autosaved, versioned
}
function rsSave(cb) {
  clearTimeout(rsTimer); RS.saving = true; const b = document.querySelector('[data-rssave]'); if (b) b.innerHTML = rsSaveChip();
  setTimeout(() => { RS.saving = false; RS.dirty = false; RS.saved = nowTime(); const b2 = document.querySelector('[data-rssave]'); if (b2) b2.innerHTML = rsSaveChip(); if (cb) cb(); }, 450);
}
/* field helpers bound to RS by path */
const rf = (path, label, { type = 'text', req = false, ph = '', id = '', hint = '', opts = null, inv = '', max = 0 } = {}) => U.field({ id: id || ('rf-' + path.replace(/\./g, '-')), label, type, req, ph, hint, opts, inv, value: getPath(RS, path) ?? '', attrs: ` data-rf="${path}"${max ? ` maxlength="${max}"` : ''}` });
const lockedF = (label, val) => `<div class="field"><div class="lbl">${label}</div><div class="input" style="background:var(--tint-3);display:flex;gap:8px;align-items:center"><span class="grow">${esc(val)}</span>${chip('Synced', 'neutral')}${ic('lock', 'sm')}</div></div>`;
const tagBox = (path, label, inv, ph = 'Type and press Enter') => `<div class="field"${inv}><label for="tag-${path}">${label}</label><div class="hrow">${getPath(RS, path).map((t, i) => `<span class="chip info">${esc(t)}<button type="button" class="tag-x" data-act="untag" data-path="${path}" data-i="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('')}</div><input class="input" id="tag-${path}" data-tag="${path}" placeholder="${ph}"></div>`;
const repeat = (path, label, addLabel, inv, ph = '', type = 'text') => `<div class="field"${inv}><div class="lbl">${label}</div>${getPath(RS, path).map((v, i) => `<div class="hrow" style="flex-wrap:nowrap"><input class="input" type="${type}" aria-label="${esc(label)} ${i + 1}" data-rf="${path}.${i}" value="${esc(v)}" placeholder="${esc(ph)}"><button class="icon-btn" type="button" data-act="delRow" data-path="${path}" data-i="${i}" aria-label="Remove">${ic('trash', 'sm')}</button></div>`).join('')}<button class="btn sm ghost" type="button" data-act="addRow" data-path="${path}" data-blank="">${ic('plus', 'sm')} ${addLabel}</button></div>`;
const LINK_TYPES = ['LinkedIn', 'GitHub', 'Portfolio', 'Other'];
const linkRows = (path, addLabel, inv) => `<div class="field"${inv}><div class="lbl">Web links / professional profiles</div>${getPath(RS, path).map((l, i) => `<div class="hrow" style="flex-wrap:nowrap"><select class="input" style="width:130px;flex:none" aria-label="Link type" data-rf="${path}.${i}.type">${LINK_TYPES.map((t) => `<option${t === l.type ? ' selected' : ''}>${t}</option>`).join('')}</select><input class="input" type="url" aria-label="Link URL" data-rf="${path}.${i}.url" value="${esc(l.url)}" placeholder="https://"><button class="icon-btn" type="button" data-act="delRow" data-path="${path}" data-i="${i}" aria-label="Remove link">${ic('trash', 'sm')}</button></div>`).join('')}<button class="btn sm ghost" type="button" data-act="addRow" data-path="${path}" data-blank="link">${ic('plus', 'sm')} ${addLabel}</button></div>`;
const address = (p, inv) => `<div class="form-grid"${inv}>${rf(p + '.l1', 'Address line 1', { req: true })}${rf(p + '.l2', 'Address line 2')}${rf(p + '.country', 'Country', { req: true, opts: ['India', 'Other'] })}${rf(p + '.state', 'State', { req: true })}${rf(p + '.city', 'City', { req: true })}${rf(p + '.pin', 'Postal code', { ph: '560001' })}</div>`;

function entryList(k, st) {
  const cfg = ENTRY[k]; const list = RS[k];
  const rows = list.map((e, i) => {
    const sub = [e.org || e.provider || e.publisher, e.loc, e.start && `${e.start} – ${e.end || 'now'}`, e.date, e.dur, e.year].filter(Boolean).join(' · ');
    const del = st.del === `${k}:${i}`;
    const extra = k === 'certs' ? `<div class="hrow" style="margin-top:4px"${I('B-076')}>${chip('Self-added', 'neutral')}${e.st === 'complete' ? chip('Self-reported complete', 'good') : chip('Self-reported · awaiting verification', 'warn')}</div>` : '';
    return `<div class="row" style="align-items:flex-start"><div class="body"><div class="ttl">${esc(e.title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${e.tech && e.tech.length ? `<div class="xs muted">${e.tech.map(esc).join(', ')}</div>` : ''}${extra}</div>
      <div class="trail"${I(k === 'certs' ? 'B-076' : 'B-069')}>${del ? `<span class="small" style="color:var(--risk);font-weight:700">Delete?</span><button class="icon-btn" type="button" data-act="entryDelYes" data-k="${k}" data-i="${i}" aria-label="Confirm delete">${ic('check')}</button><button class="icon-btn" type="button" data-act="entryDelNo" aria-label="Keep it">${ic('x')}</button>`
    : `${k === 'certs' ? '' : `<button class="icon-btn" type="button" data-act="entryEdit" data-k="${k}" data-i="${i}" aria-label="Edit ${esc(e.title)}">${ic('pen', 'sm')}</button>`}<button class="icon-btn" type="button" data-act="entryDel" data-k="${k}" data-i="${i}" aria-label="Delete ${esc(e.title)}">${ic('trash', 'sm')}</button>`}</div></div>`;
  }).join('');
  return `${list.length ? `<div class="list">${rows}</div>` : ''}<button class="btn ${list.length ? '' : 'primary'}" style="margin-top:10px" type="button" data-act="entryAdd" data-k="${k}"${cfg.inv}>${ic('plus', 'sm')} ${list.length ? `Add ${cfg.noun}` : `Add your first ${cfg.noun}`}</button>`;
}
function entrySheet(k, i) {
  const cfg = ENTRY[k]; const cur = i == null ? {} : RS[k][i];
  const tags = cur.tech ? cur.tech.slice() : [];
  const fields = cfg.fields.map(([f, label, type]) => (type === 'tags' ? `<div class="field"><label for="ent-tag">${label}</label><div class="hrow" data-tags></div><input class="input" id="ent-tag" placeholder="Type and press Enter"></div>`
    : U.field({ id: `e_${f}`, label, type: type || 'text', value: cur[f] || '' }))).join('');
  const el = Sheet.open({ title: i == null ? `Add ${cfg.noun}` : `Edit ${cfg.noun}`,
    body: `<div class="stack"${cfg.inv}>${U.field({ id: 'e_title', label: cfg.title, req: true, value: cur.title || '', attrs: ' data-act-input="x" data-f="t"' })}${fields}</div>`,
    foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="save"${cur.title ? '' : ' disabled'}>${i == null ? 'Add' : 'Save'}</button>`,
    onAct: {
      'input:t': (a, ev, sh) => { sh.querySelector('[data-act="save"]').disabled = !a.value.trim(); },
      save: (a, ev, sh) => {
        const v = formVals(sh); if (!v.e_title) return errs(sh, { e_title: cfg.req || `${cfg.title} is required.` });
        const o = { title: v.e_title }; cfg.fields.forEach(([f, , type]) => { o[f] = type === 'tags' ? tags : v['e_' + f]; });
        if (k === 'certs') o.st = 'awaiting verification';
        if (i == null) RS[k].push(o); else RS[k][i] = o;
        Sheet.close(); rsDirty(); App.rerender();
      },
    } });
  const tb = el.querySelector('[data-tags]');
  if (tb) {
    const draw = () => { tb.innerHTML = tags.map((t, j) => `<span class="chip info">${esc(t)}<button type="button" class="tag-x" data-j="${j}" aria-label="Remove ${esc(t)}">×</button></span>`).join(''); };
    draw();
    tb.addEventListener('click', (e) => { const b = e.target.closest('[data-j]'); if (b) { tags.splice(+b.dataset.j, 1); draw(); } });
    el.querySelector('#ent-tag').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim(); if (v && !tags.includes(v)) tags.push(v); e.target.value = ''; draw(); } });
  }
}

function secBody(k, st) {
  const s = D.me.student; const [first, ...rest] = s.name.split(' ');
  switch (k) {
    case 'basic': return `<div class="banner info"${I('B-043')}>${ic('lock', 'sm')}<span>USN, name, course and specialization come from your university record. For a correction, write to the registrar.</span></div>
      <div class="hrow" style="margin:14px 0"${I('B-044')}>${RS.basic.photo ? `<img src="${RS.basic.photo}" alt="Your photo" style="width:72px;height:72px;border-radius:50%;object-fit:cover">` : `<span class="avatar" style="width:72px;height:72px;font-size:22px">${initials(s.name)}</span>`}
        <label class="btn sm">${ic('upload', 'sm')} ${RS.basic.photo ? 'Replace photo' : 'Click to upload'}<input type="file" accept="image/png,image/jpeg" class="sr" data-act-change="x" data-f="photo"></label><span class="xs muted">PNG or JPEG</span>
        <div class="err small" role="alert" style="color:var(--risk);font-weight:600;width:100%">${st.photoErr || ''}</div></div>
      <div class="form-grid"><div style="display:contents"${I('B-045')}>${lockedF('USN *', s.usn)}${lockedF('First name', first)}${lockedF('Last name', rest.join(' '))}${lockedF('Course', s.course)}${lockedF('Primary specialization', s.spec)}</div>
        ${rf('basic.middle', 'Middle name', { inv: I('B-046') })}
        ${rf('basic.gender', 'Gender', { req: true, id: 'rs-gender', opts: [['', 'Choose'], 'Female', 'Male', 'Prefer not to say'], hint: 'Required for your placement profile', inv: I('B-047') })}
        ${rf('basic.dob', 'Date of birth', { type: 'date', req: true, id: 'rs-dob', hint: 'Used for eligibility only; never printed on your resume', inv: I('B-048') })}
        <div style="display:contents"${I('B-049')}>${rf('basic.blood', 'Blood group', { opts: [['', 'Not given'], 'A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'] })}${rf('basic.marital', 'Marital status', { opts: [['', 'Not given'], 'Single', 'Married'] })}</div>
        ${tagBox('basic.languages', 'Known languages', I('B-050'))}
        <div style="display:contents"${I('B-051')}>${rf('basic.dream', 'Dream company')}${rf('basic.medical', 'Medical history', { type: 'textarea', hint: 'Seen by your mentor and the placement office only — never by recruiters' })}</div></div>`;
    case 'contact': return `<div class="form-grid"${I('B-052')}>${lockedF('Primary phone *', s.phone)}${lockedF('Primary email *', s.email)}</div>
      <div class="stack" style="margin-top:14px">${repeat('contact.phones', 'Other phone number(s)', 'Add another number', I('B-053'), '+91', 'tel')}${repeat('contact.emails', 'Personal email', 'Add another email', I('B-054'), 'you@example.com', 'email')}${linkRows('contact.links', 'Add a link', I('B-055'))}</div>
      <h3 style="margin:18px 0 8px">Current address</h3>${address('contact.cur', I('B-056'))}
      <h3 style="margin:18px 0 4px">Permanent address</h3><div${I('B-057')}><label class="check"><input type="checkbox" data-act-change="x" data-f="same"${RS.contact.same ? ' checked' : ''}><span>Same as current address</span></label>${RS.contact.same ? '' : address('contact.perm', '')}</div>`;
    case 'family': {
      const p = (w, t) => `<h3 style="margin:14px 0 8px">${t}</h3><div class="form-grid">${rf(`family.${w}.name`, 'Name')}${rf(`family.${w}.occ`, 'Occupation')}${rf(`family.${w}.org`, 'Organisation')}${rf(`family.${w}.des`, 'Designation')}${rf(`family.${w}.email`, 'Email', { type: 'email' })}${rf(`family.${w}.phone`, 'Phone', { type: 'tel', ph: '+91' })}</div>`;
      return `<div${I('B-058')}>${p('father', "Father's details")}${p('mother', "Mother's details")}</div>
        <h3 style="margin:18px 0 8px">Guardian / siblings</h3><div class="stack"${I('B-059')}>${RS.family.others.map((o, i) => `<div class="card flat"><div class="form-grid">${rf(`family.others.${i}.name`, 'Name')}${rf(`family.others.${i}.rel`, 'Relationship')}${rf(`family.others.${i}.phone`, 'Phone', { type: 'tel', ph: '+91' })}</div><button class="btn sm danger" style="margin-top:8px" type="button" data-act="delRow" data-path="family.others" data-i="${i}">${ic('trash', 'sm')} Remove</button></div>`).join('')}
        <button class="btn sm ghost" type="button" data-act="addRow" data-path="family.others" data-blank="person">${ic('plus', 'sm')} Add guardian or sibling</button></div>`;
    }
    case 'education': {
      const sems = D.semesters;
      const tbl = sems.length ? U.table([{ h: 'Semester', k: 's' }, { h: 'Year', k: 'y' }, { h: 'Aggregate CGPA', k: 'c', r: true }, { h: 'Closed backlogs', k: 'cb', r: true }, { h: 'Live backlogs', k: 'lb', r: true }, { h: 'Marksheet', k: 'm' }],
        [...sems.map((x) => ({ s: `Semester ${x.n}`, y: x.n <= 2 ? '2025–26' : '2026–27', c: x.cgpa.toFixed(2), cb: 0, lb: x.backlogs, m: '<span class="xs muted">In Attachments</span>' })), { s: '<b>Aggregate</b>', y: '', c: `<b>${sems[sems.length - 1].cgpa.toFixed(2)}</b>`, cb: 0, lb: 0, m: '' }]) : '<p class="small muted">No semester results imported yet.</p>';
      const quals = [['Other degrees', D.academicHistory.filter((h) => h.level === 'Undergraduate')], ['12th Standard', D.academicHistory.filter((h) => h.level === '12th Standard')], ['10th Standard', D.academicHistory.filter((h) => h.level === '10th Standard')], ['Diploma', []]];
      const gaps = [['After 10th', 0], ['After 12th', 0], ['After graduation', 30], ['During PG', 0]];
      return `<div class="banner info"${I('B-060')}>${ic('lock', 'sm')}<span>Imported from your university record. Changes need your mentor's approval.</span></div><div style="margin-top:12px"${I('B-060')}>${tbl}</div>
        <div class="grid-2" style="margin-top:14px"${I('B-061')}>${quals.map(([t, l]) => `<div class="card flat"><h3>${t}</h3>${l.length ? l.map((h) => `<p class="small" style="margin-top:6px">${esc(h.inst)}<br><span class="muted">${esc(h.board)} · ${h.year} · ${h.pct}%</span></p>`).join('') : '<p class="small muted" style="margin-top:6px">None on record</p>'}</div>`).join('')}</div>
        <h3 style="margin:18px 0 8px">Academic gaps (months)</h3><div class="form-grid"${I('B-062')}>${gaps.map(([t, m]) => `<div class="field"><label>${t}</label><input class="input" type="number" value="${m}" disabled></div>`).join('')}<div class="field"><label>Total</label><input class="input" value="${gaps.reduce((a, g) => a + g[1], 0)}" disabled></div></div>
        <div class="card flat" style="margin-top:16px"${I('B-063')}>${RS.correction ? `<div class="banner good" role="status">${ic('check', 'sm')}<span>Sent to ${esc(s.mentor)} on ${fmtDate(RS.correction.date)}. They will raise it with the registrar.</span></div>`
    : `${U.field({ id: 'rs-corr', label: 'Request a correction', type: 'textarea', req: true, ph: 'Which entry is wrong and what it should say', attrs: ' maxlength="1000"' })}<button class="btn" style="margin-top:8px" type="button" data-act="sendCorr">${ic('send', 'sm')} Send to my mentor</button>`}</div>`;
    }
    case 'attachments': {
      const rows = [...D.uploads.map((u) => ({ d: esc(u.title), s: u.kind === 'Profile photo' ? 'Basic Details' : u.kind === 'Resume / CV' ? 'Final' : 'Certification / Assessments', st: `<span class="chip ${upTone[u.status]}">${esc(u.status)}</span>`, u: fmtShort(u.date) })),
        ...D.semesters.map((x) => ({ d: `Semester ${x.n} marksheet`, s: 'Education', st: chip('Verified', 'good'), u: '—' }))];
      return `${U.table([{ h: 'Document', k: 'd' }, { h: 'Source section', k: 's' }, { h: 'Status', k: 'st' }, { h: 'Uploaded', k: 'u' }], rows, I('B-064'))}
        <div class="drop" style="margin-top:14px;cursor:default" aria-disabled="true"${I('B-065')}>${ic('upload', 'lg')}<div style="margin-top:6px;font-weight:600;color:var(--ink)">Other documents</div><div class="xs">Documents are uploaded from the section they belong to · PDF, JPG, PNG up to 10 MB</div></div>`;
    }
    case 'evidence_skills': {
      const all = D.badges.filter((b) => b.st !== 'none' && !b.staffOnly);
      const v = verified();
      return `<p class="small muted"${I('B-066')}>${RS.skills.filter((x) => v.includes(x)).length} of ${v.length} verified included</p><div class="list" style="margin-top:8px"${I('B-066')}>${all.map((b) => { const ok = b.st === 'earned'; const inc = RS.skills.includes(b.name);
        return U.row({ title: esc(b.name), sub: `${esc(b.cat)} · <a href="#/student/skilling">View proof</a>`, lead: U.lead(ok ? 'check' : 'lock'), chev: false,
          trail: `${ok ? chip('Verified', 'good') : chip('In review', 'warn')}${ok ? `<button class="btn sm${inc ? ' primary' : ''}" type="button" data-act="include" data-n="${esc(b.name)}" aria-pressed="${inc}"${I('B-067')}>${inc ? 'Included ✓' : 'Include'}</button>` : ''}` }); }).join('')}</div>`;
    }
    case 'certifications': return `<h3 style="margin-bottom:8px">REEP programme certifications</h3><div class="list"${I('B-074')}>${RS.reepCerts.map((c) => U.row({ title: esc(c.title), sub: `${c.st} — ${c.pct}% · ${c.hours} h · ${c.prov}`, lead: U.lead('lock'), trail: `${chip('From REEP record', 'info')}${chip('Locked', 'neutral')}`, chev: false })).join('')}</div>
      <h3 style="margin:18px 0 8px">Added by you</h3>${entryList('certs', st)}`;
    case 'other': {
      const o = RS.other;
      const lists = [['achievements', 'Achievements', 'Add achievement'], ['awards', 'Awards & scholarships', 'Add award'], ['cocurr', 'Co-curricular activities', 'Add activity'], ['extra', 'Extra-curricular activities', 'Add activity']];
      return `<div class="field"${I('B-078')}><label for="rf-other-objective">Career objective</label><textarea class="input" id="rf-other-objective" data-rf="other.objective" data-count maxlength="6000">${esc(o.objective)}</textarea><div class="hint"><span data-counter>${o.objective.length}</span> / 6000 · opens your generated resume</div></div>
        <div style="margin-top:12px">${tagBox('other.expertise', 'Key expertise', I('B-079'), 'Press Enter after each skill')}<p class="xs muted" style="margin-top:4px">Skills that match a verified badge weigh more in your job match.</p></div>
        <div class="stack" style="margin-top:12px"${I('B-080')}>${lists.map(([kk, t, add]) => repeat(`other.${kk}`, t, add, '')).join('')}</div>
        <div style="margin-top:12px">${linkRows('other.links', 'Add link', I('B-081'))}</div>`;
    }
    case 'references': {
      const has = RS.references.some((r) => r.name === s.mentor);
      return `<div class="card flat" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"${I('B-082')}>${U.av(s.mentor)}<div class="grow"><b>${esc(s.mentor)}</b><div class="small muted">Your faculty mentor · ${esc(COLLEGE.name)}</div></div><button class="btn sm" type="button" data-act="mentorRef"${has ? ' disabled' : ''}>${has ? 'Already a referee' : 'Add as reference'}</button></div>
        <div class="stack" style="margin-top:14px"${I('B-083')}>${RS.references.length ? RS.references.map((r, i) => `<div class="card flat"><div class="form-grid">${rf(`references.${i}.name`, 'Name')}${rf(`references.${i}.des`, 'Designation')}${rf(`references.${i}.org`, 'Organisation')}${rf(`references.${i}.rel`, 'Relationship')}${rf(`references.${i}.email`, 'Email', { type: 'email' })}${rf(`references.${i}.phone`, 'Phone', { type: 'tel' })}</div><button class="btn sm danger" style="margin-top:8px" type="button" data-act="delRow" data-path="references" data-i="${i}">${ic('trash', 'sm')} Remove</button></div>`).join('') : '<p class="small muted">No references added yet.</p>'}
        <button class="btn sm ghost" type="button" data-act="addRow" data-path="references" data-blank="ref">${ic('plus', 'sm')} Add reference</button></div>`;
    }
    case 'policy': {
      const p = RS.policy;
      return `<div class="card flat"><h3>Placement policy · 2026–27 season</h3><ul class="small"><li>One offer per student; accepting an offer closes further applications.</li><li>Attendance at a drive you applied to is compulsory.</li><li>Offers are released only through the placement office.</li></ul>
        <label class="check"${I('B-084')}><input type="checkbox" data-act-change="x" data-f="accept"${p.accepted ? ' checked' : ''}><span>I have read and accept the placement policy for this season.</span></label>
        ${p.accepted ? `<div class="spread" style="margin-top:4px"${I('B-085')}><span class="small">${chip(`Accepted on ${fmtDate(p.accepted)}`, 'good')}</span><button class="btn sm ghost" type="button" data-act="withdraw">Withdraw my acceptance</button></div>` : ''}</div>
        <div class="spread" style="margin-top:14px"${I('B-086')}><b>Eligible for placements</b>${p.eligible ? chip('Eligible', 'good') : chip('Not eligible', 'risk')}</div><p class="xs muted">Set by the placement office.</p>
        <div class="form-grid" style="margin-top:14px"${I('B-087')}>${['jobs', 'internships'].map((w) => `<div class="field"><label for="pol-${w}">Interested in ${w} <span class="req">*</span></label><select class="input" id="pol-${w}" data-act-change="x" data-f="pol-${w}"><option${D.me.student[w] ? ' selected' : ''}>Yes</option><option${D.me.student[w] ? '' : ' selected'}>No</option></select></div>`).join('')}
          <p class="xs" role="status" style="grid-column:1/-1;color:var(--good)">${st.polMsg || ''}</p></div>`;
    }
    default: return entryList(k, st);
  }
}
function secPane(k, st, phone) {
  const ro = k === 'education' || k === 'attachments';
  return `<div class="${phone ? '' : 'card'}" data-sec="${k}">${phone ? '' : `<h2>${esc(SEC[k].t)}</h2><p class="small muted" style="margin:4px 0 14px">${esc(SEC[k].sub)}</p>`}${secBody(k, st)}
    ${ro ? `<p class="xs muted" style="margin-top:14px">Imported from your university record — nothing to save here.</p>` : `<div class="${phone ? 'sticky-act' : 'hrow'}" style="${phone ? '' : 'margin-top:16px;justify-content:flex-end'}"><button class="btn primary" type="button" data-act="saveSec" data-k="${k}"${I('B-042')}>Save section</button></div>`}</div>`;
}
const secList = (cur) => `<nav aria-label="Resume sections"${I('B-038')}>${SECTIONS.map(([g, l]) => `<div class="xs faint" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin:12px 4px 6px">${g}</div><div class="list">${l.map(([k, t, sub]) => `<button class="row${cur === k ? ' sel' : ''}" type="button" data-act="sec" data-k="${k}" title="${esc(sub)}"><div class="body"><div class="ttl">${esc(t)}</div></div><div class="trail">${stChip(secState(k))}${ic('chev', 'sm')}</div></button>`).join('')}</div>`).join('')}</nav>`;

function rsHead(st) {
  const j = rsJob();
  const roles = ['Credit Analyst', 'Business Analyst', 'Equity Research Associate', 'Management Trainee'];
  const locs = ['Any', ...new Set(D.jobs.map((x) => x.loc))];
  const match = j ? chip(`${j.match}% match · ${j.eligible ? 'Eligible' : 'Not eligible'}`, j.eligible ? (j.match >= 70 ? 'good' : 'warn') : 'risk') : chip('Pick an opportunity to see your match', 'neutral');
  const pct = rsComplete();
  const flow = st.flow || 'build';
  return `<div class="seg" role="group" aria-label="Steps" style="margin-bottom:12px;width:100%"${I('B-031')}>${[['build', '1 Build content'], ['tailor', '2 Tailor to opportunity'], ['preview', '3 Preview'], ['export', '4 Export & share']].map(([k, t]) => `<button type="button" data-act="flow" data-v="${k}" aria-pressed="${flow === k}" style="flex:1">${t}</button>`).join('')}</div>
    <div class="card flat" style="margin-bottom:12px"><div class="filters" style="margin-bottom:8px">
      ${U.select('rsrole', [['', 'Target role: Not set'], ...roles.map((r) => [r, `Role: ${r}`])], RS.goal.role, I('B-032'), 'Target role')}${U.select('rsloc', locs.map((l) => [l, l === 'Any' ? 'Location: Any' : l]), RS.goal.loc, I('B-033'), 'Location')}
      ${U.select('rsjob', [['', 'Opportunity: Not chosen'], ...D.jobs.map((x) => [String(x.id), `${x.company} — ${x.title} · ${x.loc}`])], RS.goal.job, I('B-034'), 'Selected opportunity')}</div>
      <div class="spread" style="flex-wrap:wrap"><span${I('B-035')}>${match}</span><div style="min-width:200px;flex:1;max-width:360px"${I('B-036')}><div class="spread xs"><span class="muted">Profile complete</span><b class="num">${pct}%</b></div>${U.meter(pct, pct >= 70 ? 'good' : 'warn')}${pct < 70 ? '<p class="xs muted" style="margin-top:3px">70% or more makes a stronger resume.</p>' : ''}</div></div></div>`;
}
function genResume() {
  const s = D.me.student; const o = RS.other; const v = verified();
  const blocks = [['title', s.name], ['p', [s.phone, s.email, s.city].join(' · ')]];
  if (o.objective) blocks.push(['sec', 'Objective'], ['p', o.objective]);
  blocks.push(['sec', 'Education'], ['b', `${s.course} (${s.spec}), ${COLLEGE.name} — CGPA ${D.semesters[D.semesters.length - 1].cgpa.toFixed(2)}`], ...D.academicHistory.slice().reverse().map((h) => ['b', `${h.level}, ${h.inst} — ${h.pct}% (${h.year})`]));
  const ex = [...RS.experience, ...RS.internship];
  if (ex.length) blocks.push(['sec', 'Experience'], ...ex.map((e) => ['b', `${e.title}, ${e.org}${e.start ? ` (${e.start} – ${e.end || 'now'})` : ''}${e.desc ? ' — ' + e.desc : ''}`]));
  if (RS.projects.length) blocks.push(['sec', 'Projects'], ...RS.projects.map((p) => ['b', `${p.title}${p.desc ? ' — ' + p.desc : ''}`]));
  const sk = RS.skills.filter((x) => v.includes(x));
  if (sk.length || o.expertise.length) blocks.push(['sec', 'Skills'], ['p', [...sk.map((x) => x + ' (verified)'), ...o.expertise].join(', ')]);
  blocks.push(['sec', 'Certifications'], ...RS.reepCerts.filter((c) => c.st === 'Completed').map((c) => ['b', `${c.title} — REEP, ${c.hours} h`]));
  if (RS.por.length) blocks.push(['sec', 'Positions of responsibility'], ...RS.por.map((p) => ['b', `${p.title}, ${p.org} (${p.dur})`]));
  const warnings = [];
  if (!RS.experience.length) warnings.push('No professional experience listed.');
  if (o.objective.length > 600) warnings.push('Career objective is long; recruiters read the first two lines.');
  const pages = blocks.length > 26 ? 2 : 1;
  return { title: RS.genTitle || `${RS.goal.role || 'General'} resume`, at: TODAY, blocks, warnings, pages };
}
const paper = (g) => `<div class="rs-paper${RS.ats ? ' ats' : ''}">${g.blocks.map(([t, x]) => (t === 'title' ? `<h2>${esc(x)}</h2>` : t === 'sec' ? `<h3>${esc(x)}</h3>` : t === 'b' ? `<p>• ${esc(x)}</p>` : `<p>${esc(x)}</p>`)).join('')}</div>`;
function openPaper(g, download) {
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(g.title)}</title><body style="font-family:Georgia,serif;max-width:720px;margin:40px auto;line-height:1.45">${paper(g)}</body>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  if (download) { const a = document.createElement('a'); a.href = url; a.download = `${g.title.replace(/\W+/g, '-')}.html`; a.click(); } else window.open(url, '_blank', 'noopener');
}

function flowBody(flow, st) {
  const j = rsJob();
  if (flow === 'tailor') {
    const verdict = j ? `<div class="card"${I('B-089')}><div class="card-h"><h2>${j.eligible ? 'You are eligible to apply' : 'Not yet eligible'}</h2>${j.eligible ? chip('Eligible', 'good') : chip('Not eligible', 'risk')}</div>
      ${j.reasons.length ? `<ul class="small">${j.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}<p class="small">Skill match <b>${j.match}%</b></p><p class="xs muted" style="margin-top:6px">Your resume does not change the posting's cut-offs.</p></div>`
      : `<div class="card"${I('B-089')}>${U.empty('briefcase', 'Pick an opportunity above to see your verdict')}</div>`;
    const need = [['projects', 'Projects'], ['certifications', 'Certification / Assessments'], ['experience', 'Professional Experience'], ['references', 'References']];
    const missing = need.filter(([k]) => secState(k) !== 'done');
    const ess = [['basic', 'Basic Details'], ['contact', 'Contact Details'], ['policy', 'Placement Policy']].filter(([k]) => secState(k) !== 'done');
    const guide = `<div class="card"${I('B-090')}><h2>Tailored for ${esc(RS.goal.role || 'your target role')}</h2>${!j ? '<p class="small muted" style="margin-top:4px">Choose an opportunity to tailor against a real posting.</p>' : ''}
      ${missing.length ? `<h3 style="margin-top:12px">Still missing for this role</h3><div class="list" style="margin-top:6px">${missing.map(([k, t]) => U.row({ title: t, trail: stChip(secState(k)), act: 'sec', data: ` data-k="${k}"` })).join('')}</div>` : '<p class="small" style="margin-top:10px;color:var(--good)">Everything this role asks for is covered.</p>'}
      ${ess.length ? `<h3 style="margin-top:12px">Missing essentials</h3><p class="small">${ess.map((x) => x[1]).join(', ')}</p>` : ''}</div>`;
    return `<div class="stack">${verdict}${guide}<div class="hrow"${I('B-088')}><button class="btn" type="button" data-act="flow" data-v="build">${ic('back', 'sm')} Back to content</button><button class="btn primary" type="button" data-act="flow" data-v="preview">Preview ${ic('chev', 'sm')}</button></div></div>`;
  }
  if (flow === 'preview') {
    const g = RS.gen;
    const empties = ['experience', 'publications', 'seminars', 'references', 'projects', 'por'].filter((k) => secState(k) === 'empty').slice(0, 2);
    const left = `<div class="card"><div class="stack">${U.field({ id: 'rs-gentitle', label: 'Resume title', value: RS.genTitle, ph: 'e.g. Credit roles', attrs: ' data-rf="genTitle"' })}
        <button class="btn primary" type="button" data-act="gen"${st.gening ? ' disabled' : ''}${I('B-094')}>${ic('sparkle', 'sm')} ${st.gening ? 'Generating…' : g ? 'Regenerate' : 'Generate Resume'}</button>
        <label class="check"${I('B-095')}><input type="checkbox" data-act-change="x" data-f="ats"${RS.ats ? ' checked' : ''}><span>ATS-safe preview</span></label>
        <div class="hrow"><button class="btn" type="button" data-act="flow" data-v="build"${I('B-091')}>${ic('pen', 'sm')} Edit profile</button><button class="btn" type="button" data-act="dlPdf"${g ? '' : ' disabled'}${I('B-092')}>${ic('download', 'sm')} Download PDF</button>
        <button class="btn" type="button" disabled title="Approval by the office is not open yet"${I('B-093')}>Submit for approval</button></div></div></div>
      ${g ? `<div class="card flat" style="margin-top:12px"${I('B-096')}><b>${g.pages} page${g.pages > 1 ? 's' : ''}</b>${g.pages > 1 ? ' — consider trimming to one page' : ''}${g.warnings.map((w) => `<p class="small" style="color:var(--warn);margin-top:4px">⚠ ${esc(w)}</p>`).join('')}</div>
      <div class="card flat" style="margin-top:12px"${I('B-098')}><h3>Generation trace</h3><p class="small" style="margin-top:4px">Deterministic draft composed on this machine.</p><p class="xs muted">Your records were not sent to an outside model, so nothing was polished by one.</p></div>
      <div class="card flat" style="margin-top:12px"${I('B-099')}><h3>Evidence pack</h3>${['Only saved records were used', 'Data comes from its source section', 'Nothing was invented', 'Self-reported certifications are left out'].map((t) => `<p class="small" style="margin-top:4px">${ic('check', 'sm')} ${t}</p>`).join('')}</div>` : ''}
      ${empties.length ? `<div class="card flat" style="margin-top:12px"${I('B-100')}><h3>What would strengthen this</h3><p class="small" style="margin:4px 0 8px">${empties.map((k) => SEC[k].t).join(' and ')}</p><button class="btn sm" type="button" data-act="sec" data-k="${empties[0]}">Complete those sections</button></div>` : ''}`;
    const right = `<div${I('B-097')}>${st.gening ? `<div class="card" role="status"><p class="muted">Composing your resume…</p><div class="skel" style="height:12px;margin-top:10px"></div><div class="skel" style="height:12px;width:70%;margin-top:8px"></div></div>` : g ? paper(g) : `<div class="card">${U.empty('file', 'No resume generated yet', 'Generate one to see it here.')}</div>`}</div>`;
    return `<div class="grid-2" style="grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));align-items:start"><div>${left}</div>${right}</div>`;
  }
  if (flow === 'export') {
    const vs = D.resume.versions;
    const sel = vs.find((x) => x.id === D.resume.selected);
    const proofs = RS.skills.filter((x) => verified().includes(x)).length;
    const can = RS.consent && sel;
    return `<button class="btn" type="button" data-act="flow" data-v="preview"${I('B-101')}>${ic('back', 'sm')} Back to preview</button>
      ${U.section('All resumes', vs.length ? `<div class="list"${I('B-102')}>${vs.slice().reverse().map((x) => U.row({ title: `${esc(x.title)} ${chip(x.label, 'neutral')}`, sub: `Updated ${fmtDate(x.updated)}`, lead: U.lead('file'), chev: false,
        trail: `${x.id === D.resume.selected ? chip('Selected', 'good') : ''}<button class="btn sm" type="button" data-act="useVer" data-id="${x.id}"${x.id === D.resume.selected ? ' disabled' : ''}${I('B-103')}>${x.id === D.resume.selected ? 'In use' : 'Use for application'}</button>` })).join('')}</div>`
    : `<div class="card"${I('B-102')}>${U.empty('file', 'No resumes yet', '', '<button class="btn primary" type="button" data-act="flow" data-v="preview">Generate your first resume</button>')}</div>`)}
      <div class="card" style="margin-top:16px"><div${I('B-104')}>${j ? `<p class="small"><b>Sending for</b> ${esc(j.company)} — ${esc(j.title)}</p>${j.eligible ? '' : `<div class="banner warn" style="margin-top:8px">${ic('alert', 'sm')}<span>You are not eligible for this posting: ${esc(j.reasons[0])}</span></div>`}` : '<p class="small muted">No opportunity chosen — this exports a general resume.</p>'}</div>
        <label class="check"${I('B-105')}><input type="checkbox" data-act-change="x" data-f="appendix"${RS.appendix ? ' checked' : ''}><span>Include an evidence appendix<br><span class="xs muted">Binds ${proofs} certificate${proofs === 1 ? '' : 's'} behind your included verified skills</span></span></label>
        <label class="check"${I('B-106')}><input type="checkbox" data-act-change="x" data-f="consent"${RS.consent ? ' checked' : ''}><span>I confirm this resume shares only what I intend recruiters to see.</span></label>
        <button class="btn primary" type="button" data-act="export"${can ? '' : ' disabled'}${I('B-107')}>${ic('send', 'sm')} Export & share</button><p class="xs muted" style="margin-top:6px">Nothing is sent on your behalf.</p></div>`;
  }
  return '';
}

R.screen('student/resume', { title: 'Resume', render({ id, st }) {
  if (id && SEC[id]) {
    if (!wide2()) return U.page({ title: SEC[id].t, lede: esc(SEC[id].sub), back: true, acts: `<span data-rssave${I('B-041')}>${rsSaveChip()}</span>`, body: secPane(id, st, true) });
    st.sec = id; st.flow = 'build';
  }
  const flow = st.flow || 'build';
  const cur = st.sec || 'basic';
  const body = flow === 'build' ? `<div class="split"><div>${secList(wide2() ? cur : null)}</div><div class="detail-pane">${secPane(cur, st, false)}</div></div>` : flowBody(flow, st);
  return U.page({ title: 'Resume', lede: `<span data-rssave${I('B-041')}>${rsSaveChip()}</span> <span class="xs muted">Changes are versioned & autosaved</span>`,
    acts: `<button class="btn sm" type="button" data-act="import"${I('B-037')}>${ic('checks', 'sm')} Import verified record</button><button class="btn sm" type="button" data-act="flow" data-v="export"${I('B-039')}>All Resumes</button><button class="btn sm primary" type="button" data-act="flow" data-v="preview"${I('B-040')}>Generate Resume</button>`,
    body: rsHead(st) + body });
},
mount(main) {
  main.addEventListener('input', (e) => {
    const t = e.target.closest('[data-rf]'); if (!t) return;
    setPath(RS, t.dataset.rf, t.value);
    if (t.hasAttribute('data-count')) { const c = main.querySelector('[data-counter]'); if (c) c.textContent = t.value.length; }
    if (t.dataset.rf !== 'genTitle') rsDirty();
  });
  main.addEventListener('keydown', (e) => {
    const t = e.target.closest('[data-tag]'); if (!t || e.key !== 'Enter') return;
    e.preventDefault(); const v = t.value.trim(); const arr = getPath(RS, t.dataset.tag);
    if (v && !arr.includes(v)) { arr.push(v); rsDirty(); }
    App.rerender(); const n = document.querySelector(`[data-tag="${t.dataset.tag}"]`); if (n) n.focus();
  });
},
acts: {
  flow(el, ev, st) { st.flow = el.dataset.v; if (App.cur.id) R.go('#/student/resume'); else App.rerender(); },
  sec(el, ev, st) { const k = el.dataset.k; st.flow = 'build'; if (wide2()) { st.sec = k; if (App.cur.id) R.go('#/student/resume'); else App.rerender(); } else R.go(`#/student/resume/${k}`); },
  'change:rsrole'(el) { RS.goal.role = el.value; App.rerender(); },
  'change:rsloc'(el) { RS.goal.loc = el.value; App.rerender(); },
  'change:rsjob'(el) { RS.goal.job = el.value; App.rerender(); },
  import() { const v = verified().filter((n) => !RS.skills.includes(n)); RS.skills.push(...v); toast(v.length ? `${v.length} verified skill${v.length > 1 ? 's' : ''} added ✓` : 'Everything verified is already included ✓'); if (v.length) rsDirty(); App.rerender(); },
  saveSec(el, ev, st) {
    const k = el.dataset.k; const main = document.getElementById('main');
    if (k === 'basic') { const m = {}; if (!RS.basic.gender) m['rs-gender'] = 'Choose a gender.'; if (!RS.basic.dob) m['rs-dob'] = 'Enter your date of birth.'; if (!errs(main, m)) return; }
    if (k === 'contact') {
      const m = {}; const chk = (p) => ['l1', 'country', 'state', 'city'].forEach((f) => { if (!RS.contact[p][f]) m[`rf-contact-${p}-${f}`] = 'Required.'; });
      chk('cur'); if (!RS.contact.same) chk('perm'); if (!errs(main, m)) return;
    }
    el.textContent = 'Saving…'; rsSave(() => { toast('Section saved'); App.rerender(); });
  },
  addRow(el) {
    const blank = { '': '', link: { type: 'LinkedIn', url: '' }, person: { name: '', rel: '', phone: '' }, ref: { name: '', des: '', org: '', rel: '', email: '', phone: '' } }[el.dataset.blank];
    getPath(RS, el.dataset.path).push(typeof blank === 'object' ? { ...blank } : blank); rsDirty(); App.rerender();
  },
  delRow(el) { getPath(RS, el.dataset.path).splice(+el.dataset.i, 1); rsDirty(); App.rerender(); },
  untag(el) { getPath(RS, el.dataset.path).splice(+el.dataset.i, 1); rsDirty(); App.rerender(); },
  entryAdd(el) { entrySheet(el.dataset.k, null); },
  entryEdit(el) { entrySheet(el.dataset.k, +el.dataset.i); },
  entryDel(el, ev, st) { st.del = `${el.dataset.k}:${el.dataset.i}`; App.rerender(); },
  entryDelNo(el, ev, st) { st.del = null; App.rerender(); },
  entryDelYes(el, ev, st) { RS[el.dataset.k].splice(+el.dataset.i, 1); st.del = null; rsDirty(); App.rerender(); toast('Deleted'); },
  include(el) { const n = el.dataset.n; const i = RS.skills.indexOf(n); if (i >= 0) RS.skills.splice(i, 1); else RS.skills.push(n); rsDirty(); App.rerender(); },
  'change:photo'(el, ev, st) { el.blur();
    const f = el.files[0]; if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) { st.photoErr = 'Use a PNG or JPEG image.'; return App.rerender(); }
    st.photoErr = ''; RS.basic.photo = URL.createObjectURL(f); rsDirty(); App.rerender();
  },
  'change:same'(el) { el.blur(); RS.contact.same = el.checked; rsDirty(); App.rerender(); },
  sendCorr() { const t = document.getElementById('rs-corr'); const main = document.getElementById('main'); if (!t.value.trim()) return errs(main, { 'rs-corr': 'Say what needs correcting.' }); RS.correction = { date: TODAY, text: t.value.trim() }; toast('Sent to your mentor'); App.rerender(); },
  mentorRef() { RS.references.push({ name: D.me.student.mentor, des: 'Associate Professor', org: COLLEGE.name, rel: 'Faculty mentor', email: 'meera.iyer@nhsm.edu.in', phone: '' }); rsDirty(); App.rerender(); },
  'change:accept'(el) { el.blur(); RS.policy.accepted = el.checked ? TODAY : null; rsDirty(); App.rerender(); },
  withdraw() { Sheet.confirm({ title: 'Withdraw your acceptance?', text: 'You will not appear against opportunities until you accept the policy again.', ok: 'Withdraw', danger: true, onOk: () => { RS.policy.accepted = null; rsDirty(); App.rerender(); } }); },
  'change:pol-jobs'(el, ev, st) { polSave('jobs', el.value === 'Yes', st); },
  'change:pol-internships'(el, ev, st) { polSave('internships', el.value === 'Yes', st); },
  gen(el, ev, st) {
    st.gening = true; App.rerender();
    setTimeout(() => { st.gening = false; RS.gen = genResume(); const vs = D.resume.versions; const id = Math.max(0, ...vs.map((x) => x.id)) + 1; vs.push({ id, title: RS.gen.title, label: `v${vs.length + 1}`, updated: TODAY }); D.resume.selected = id; App.rerender(); toast('Resume generated'); }, 900);
  },
  'change:ats'(el) { el.blur(); RS.ats = el.checked; App.rerender(); },
  dlPdf() { if (RS.gen) openPaper(RS.gen, true); },
  useVer(el) { D.resume.selected = +el.dataset.id; App.rerender(); },
  'change:appendix'(el) { RS.appendix = el.checked; },
  'change:consent'(el) { el.blur(); RS.consent = el.checked; App.rerender(); },
  export() { const sel = D.resume.versions.find((x) => x.id === D.resume.selected); openPaper(RS.gen || { ...genResume(), title: sel.title }, false); toast('Opened your resume. Nothing was sent on your behalf.'); },
} });
function polSave(w, v, st) {
  st.polMsg = 'Saving…'; App.rerender();
  setTimeout(() => { D.me.student[w] = v; st.polMsg = 'Saved to your profile.'; App.rerender(); }, 400);
}
})();
