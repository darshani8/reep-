/* REEP v5 prototype — Student screens. */
'use strict';

const stTone = { done: 'good', progress: 'warn', todo: 'neutral' };
const stWord = { done: 'Completed', progress: 'In progress', todo: 'Not started yet' };
const pctTone = (p) => (p >= 85 ? 'good' : p >= 75 ? 'warn' : 'risk');
const pctWord = (p) => (p >= 85 ? 'On track' : p >= 75 ? 'Watch' : 'Below 75%');

/* ================================================================ Home */
R.screen('student/home', { title: 'Home', states: 'A-160', render() {
  const s = D.me.student;
  const r = D.readiness;
  const first = s.name.split(' ')[0];
  const quad = ['Strengths', 'Weaknesses', 'Opportunities', 'Challenges'];
  const hero = `<div class="card" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"${I('A-171')}>
      <div class="ring" style="--p:${r.score}" data-v="${r.score}" role="img" aria-label="Readiness ${r.score} of 100"></div>
      <div class="grow"><div class="xs muted" style="font-weight:700;letter-spacing:.05em;text-transform:uppercase">Placement readiness</div>
        <div class="hrow" style="margin:4px 0 8px"><h2 style="font-size:20px">${r.score} / 100</h2>${chip(r.band, 'good')}</div>
        <div class="hrow"${I('A-172')}>${r.factors.map((f) => chip(`${f.name}: ${f.state}`, f.state === 'Met' ? 'good' : f.state === 'Not met' ? 'risk' : 'neutral')).join('')}</div></div></div>`;
  const recs = `<div class="list"${I('A-173')}>${D.recs.map((x) => U.row({ title: esc(x.t), sub: esc(x.why), lead: U.lead('sparkle'), trail: `<span class="btn sm">${esc(x.cta)}</span>`, href: x.to, chev: false })).join('')}</div>`;
  const stages = `<div class="grid-3"${I('A-163', 'A-164')}>${D.stages.map((g) => `<div class="card flat"><div class="card-h"><h3>${g.k}</h3>${g.k === s.stage ? chip('Your stage', 'info') : ''}</div><div class="list" style="border:0">${g.items.map(([t, stt, to]) => U.row({ title: esc(t), trail: chip(stWord[stt], stTone[stt]), href: to || '', chev: !!to })).join('')}</div></div>`).join('')}</div>
    <div class="legend" style="margin-top:8px"${I('A-165')}><span>${chip('Completed', 'good')}</span><span>${chip('In progress', 'warn')}</span><span>${chip('Not started yet', 'neutral')}</span></div>`;
  const swoc = `<div class="grid-2"${I('A-166')}>${quad.map((q) => { const l = D.swoc.filter((x) => x.q === q); return `<div class="card flat"><h3 style="margin-bottom:6px">${q}</h3>${l.length ? l.map((x) => `<p class="small">${esc(x.text)}</p><p class="xs faint">${esc(x.by)} · ${fmtShort(x.when)}</p>`).join('') : '<p class="small muted">Not added yet</p>'}</div>`; }).join('')}</div>`;
  const att = `<div class="card"${I('A-167')}>${D.attendance.map(([c, p]) => `<div style="margin-bottom:10px"><div class="spread small"><span>${esc(c)}</span><span class="hrow"><b class="num">${p}%</b>${chip(pctWord(p), pctTone(p))}</span></div>${U.meter(p, pctTone(p))}</div>`).join('')}</div>`;
  const marks = `<div class="card"${I('A-168')}><div class="bars">${[1, 2, 3, 4].map((n) => { const sm = D.semesters.find((x) => x.n === n); return `<div><span class="num">${sm ? sm.cgpa : '—'}</span><i style="height:${sm ? sm.cgpa * 10 : 4}%;${sm ? '' : 'background:var(--tint-1);outline:1px dashed var(--seq-light)'}"></i><span>Sem ${n}</span></div>`; }).join('')}</div><p class="xs muted" style="margin-top:8px">CGPA out of 10 · Semesters 3–4 not published yet</p></div>`;
  const hist = `<div class="list"${I('A-169', 'A-170')}>${D.academicHistory.map((h) => U.row({ title: `${h.level} · ${h.pct}%`, sub: `${esc(h.inst)} · ${h.board} · ${h.year}`, lead: U.lead('book'), chev: false })).join('')}${U.row({ title: 'Education gaps', sub: `${D.gaps.map(([g, m]) => `${g}: ${m} months`).join(', ')} · drives may apply gap limits`, trail: chip(`${D.gaps.reduce((a, [, m]) => a + m, 0)} months declared`, 'neutral'), href: '#/student/records?tab=history' })}</div>`;
  return U.page({
    title: `Welcome back, ${first}`,
    lede: `<span${I('A-161')}>${s.stage} stage · Semester ${s.sem} · ${s.usn}</span>`,
    acts: s.streak ? chip(`${s.streak}-day login streak`, 'info', I('A-162')) : '',
    body: `<div class="grid-2">${hero}<div>${U.section('Do next', recs).replace('class="section"', 'class="section" style="margin-top:0"')}</div></div>
      ${U.section('Your programme', stages)}
      ${U.section('SWOC from your mentor and TPO', swoc, `<a class="small" href="#/student/mentor-log">Open log</a>`)}
      <div class="grid-2">${U.section('Attendance', att)}${U.section('VTU marks', marks)}</div>
      ${U.section('Academic history', hist)}`,
  });
} });

/* ================================================================ Skills (claim a skill, badge board) */
const BADGE_ST = { earned: ['Verified', 'good'], review: ['With your mentor', 'warn'], none: ['Not claimed', 'neutral'] };
R.screen('student/skilling', { title: 'Skills', states: '', render({ st }) {
  const cats = [...new Set(D.badges.filter((b) => !b.staffOnly).map((b) => b.cat))];
  const badgeOpts = D.badges.filter((b) => !b.staffOnly && b.cat === st.cat && b.st === 'none');
  const claim = st.claimed
    ? `<div class="card"${I('A-183')}>${U.empty('check', 'Claim submitted.', 'Your mentor has been mailed.', `<button class="btn" type="button" data-act="again">Claim another skill</button>`)}</div>`
    : `<div class="card stack" data-claim>
      <div class="field">${U.drop('cert', st.file ? 'Replace' : 'Click to upload or drop a file', 'PDF or JPEG · up to 5 MB', I('A-175'))}<div class="err" data-err="cert"></div></div>
      <div class="form-grid">${U.field({ id: 'cat', label: 'Skill category', req: true, opts: [['', 'Choose a category'], ...cats], value: st.cat || '', inv: I('A-177') })}
        ${U.field({ id: 'badge', label: 'Skill badge', req: true, opts: [['', st.cat ? 'Choose a badge' : 'Pick a category first'], ...badgeOpts.map((b) => [b.code, `${b.name} · ${b.track}`])], inv: I('A-178'), attrs: st.cat ? '' : ' disabled' })}
        ${U.field({ id: 'issuer', label: 'Issued by', ph: 'NISM, Coursera, internal assessment', inv: I('A-179') })}${U.field({ id: 'note', label: 'Note for your mentor', inv: I('A-180') })}</div>
      <div class="spread"><span class="xs muted"${I('A-182')}>Typically verified within two working days</span><button class="btn primary" type="button" data-act="claim"${I('A-181')}>Submit claim</button></div></div>`;
  const inprog = D.claims.length ? U.section('Claims in progress', U.table([{ h: 'Badge', k: 'badge' }, { h: 'Status', k: 'chip' }, { h: 'Note from your mentor', k: 'note' }], D.claims.map((c) => ({ ...c, chip: chip(c.status, c.status === 'With your mentor' ? 'warn' : 'risk'), note: c.note || '—' })), I('A-184'))) : '';
  const board = cats.concat('Readiness').map((c) => { const list = D.badges.filter((b) => b.cat === c); return `<div style="margin-bottom:14px"${I('A-186')}><div class="spread"><h3>${c}</h3><span class="xs muted">${list.length} badges</span></div><div class="badges" style="margin-top:8px">${list.map((b) => { const prev = st.preview === b.code; const [w, t] = prev ? ['Preview', 'info'] : BADGE_ST[b.st]; return `<button type="button" class="badge ${b.st === 'earned' || prev ? 'earned' : b.st === 'review' ? 'review' : ''}" data-act="preview" data-c="${b.code}"${I('A-187')}><div class="hx">${b.st === 'earned' ? ic('check') : b.st === 'review' ? ic('clock') : ic('star')}</div>${esc(b.name)}<div style="margin-top:4px">${chip(w, t)}</div></button>`; }).join('')}</div></div>`; }).join('');
  const lit = D.badges.filter((b) => b.st === 'earned').length + (st.preview ? 1 : 0);
  return U.page({ title: 'Skills', lede: `<span${I('A-174')}>Upload a certificate to claim a skill, then track your verified badges.</span>`, acts: `<a class="btn sm" href="#/student/uploads"${I('A-176')}>All my documents</a>`,
    body: `<div class="split" style="grid-template-columns:minmax(320px,440px) 1fr"><div>${U.section('Claim a skill', claim).replace('class="section"', 'class="section" style="margin-top:0"')}${inprog}</div><div style="display:block">${U.section('Badge board', `<div class="legend" style="margin-bottom:10px"${I('A-185')}>${chip('Not claimed', 'neutral')} ${chip('With your mentor', 'warn')} ${chip('Verified by your mentor', 'good')}</div><div class="card">${board}<p class="small muted"${I('A-188')}>${lit} skills currently illuminated</p></div>`).replace('class="section"', 'class="section" style="margin-top:0"')}</div></div>` });
}, acts: {
  'change:cat'(a, e, st) { st.cat = a.value; App.rerender(); },
  'change:cert'(a, e, st) { st.file = a.files[0]; const f = st.file; if (f && (!/pdf|jpeg/.test(f.type) || f.size > 5242880)) { st.file = null; errs(document.querySelector('[data-claim]'), { cert: `${f.name} is not a PDF or JPEG up to 5 MB.` }); } },
  preview(a, e, st) { const b = D.badges.find((x) => x.code === a.dataset.c); st.preview = b.st === 'none' && st.preview !== b.code ? b.code : null; App.rerender(); },
  again(a, e, st) { st.claimed = false; st.file = null; st.cat = ''; App.rerender(); },
  claim(a, e, st) {
    const f = document.querySelector('[data-claim]'); const v = formVals(f); const er = {};
    if (!st.file) er.cert = 'Attach the certificate.'; if (!v.cat) er.cat = 'Choose a category.'; if (!v.badge) er.badge = 'Choose a badge.';
    if (!errs(f, er)) return;
    const b = D.badges.find((x) => x.code === v.badge); b.st = 'review';
    D.claims.push({ badge: b.name, status: 'With your mentor', note: '' });
    D.claimQueue.push({ id: Date.now(), badge: b.name, cat: b.cat, kind: 'Certificate', student: D.me.student.name, usn: D.me.student.usn, at: TODAY, issuer: v.issuer, note: v.note, file: st.file.name });
    st.claimed = true; App.rerender();
  },
} });

/* ================================================================ Time log (the ledger) */
D.SLOTS = [['5–9 am', 8], ['9 am–12 pm', 6], ['12–3 pm', 6], ['3–6 pm', 6], ['6–10 pm', 8], ['10 pm–5 am', 14]];
D.HEADS = ['Sleep', 'Travel / personal', 'Lectures', 'Coursework', 'Skilling'];
(function reseed() {
  const full = [[0, 3, 0, 2, 3], [0, 0, 6, 0, 0], [0, 2, 4, 0, 0], [0, 0, 0, 3, 3], [0, 4, 0, 2, 2], [14, 0, 0, 0, 0]];
  D.ledger = {};
  for (let i = 1; i <= 13; i++) { if (i === 6 || i === 9) continue; D.ledger[addDays(TODAY, -i)] = { status: i <= 2 ? 'DRAFT' : 'SUBMITTED', cells: full.map((r) => r.slice()) }; }
  D.ledger[addDays(TODAY, -1)].cells[5] = [13, 0, 0, 0, 0]; // 0.5 h short — the state a fresh seed shows
})();
const WINDOW = 2;
const dayState = (d) => (d > TODAY ? 'future' : d < addDays(TODAY, -WINDOW) ? 'locked' : 'open');
const sumDay = (c) => c.flat().reduce((a, b) => a + b, 0);
const hrs = (h) => `${(h / 2).toFixed(1).replace(/\.0$/, '')} h`;
R.screen('student/time-log', { title: 'Time log', states: 'A-196', render({ st }) {
  const day = st.day || TODAY;
  const rec = (st.edit && st.edit.day === day ? st.edit : null) || D.ledger[day] || { status: 'EMPTY', cells: D.SLOTS.map(() => [0, 0, 0, 0, 0]) };
  const win = dayState(day); const editable = win === 'open' && rec.status !== 'SUBMITTED';
  const total = sumDay(rec.cells); const gap = 48 - total;
  const prev = D.ledger[addDays(day, -1)];
  const strip = Array.from({ length: 14 }, (_, i) => addDays(TODAY, -13 + i)).map((d) => { const r = D.ledger[d]; const lk = dayState(d) === 'locked'; const cls = r ? (r.status === 'SUBMITTED' ? 's' : 'd') : ''; const word = r ? (r.status === 'SUBMITTED' ? 'Submitted' : lk ? `${hrs(sumDay(r.cells))} · locked` : `Draft · ${hrs(sumDay(r.cells))}`) : lk ? 'Locked' : 'Not logged'; return `<button type="button" class="${cls}${lk ? ' l' : ''}" data-act="day" data-d="${d}" aria-pressed="${d === day}" aria-label="${fmtShort(d)} · ${word}">${d === TODAY ? 'Today' : new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })}<b>${+d.slice(8)}</b><i></i></button>`; }).join('');
  const subN = Object.entries(D.ledger).filter(([d, r]) => r.status === 'SUBMITTED' && d >= addDays(TODAY, -13)).length;
  const grid = `<div style="overflow-x:auto"><div class="ledger" style="min-width:560px"${I('A-198')}><span></span>${D.HEADS.map((h, j) => `<span class="h"><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--series-${['sleep', 'personal', 'lectures', 'coursework', 'skilling'][j]})"></i> ${h}</span>`).join('')}<span class="h">Logged</span>
    ${D.SLOTS.map(([lab, cap], i) => { const s = rec.cells[i].reduce((a, b) => a + b, 0); const ch = s === 0 ? ['Empty', 'neutral'] : s < cap ? [`${hrs(cap - s)} open`, 'warn'] : s > cap ? [`${hrs(s - cap)} over`, 'risk'] : ['Balanced', 'good']; return `<span class="slot">${lab}</span>${rec.cells[i].map((v, j) => `<input type="number" min="0" step="0.5" max="${cap / 2}" inputmode="decimal" value="${v ? v / 2 : ''}" data-act-input="cell" data-f="c${i}-${j}" data-i="${i}" data-j="${j}" aria-label="${lab} ${D.HEADS[j]}"${editable ? '' : ' disabled'}>`).join('')}<span class="tot"${I('A-199')}>${chip(ch[0], ch[1])}</span>`; }).join('')}
    <span class="slot">Total</span>${D.HEADS.map((_, j) => `<span class="tot">${hrs(rec.cells.reduce((a, r) => a + r[j], 0))}</span>`).join('')}<span class="tot"${I('A-200')}>${chip(gap > 0 ? `${hrs(gap)} to reconcile` : gap < 0 ? `${hrs(-gap)} over` : 'Reconciled', gap === 0 ? 'good' : gap > 0 ? 'warn' : 'risk')}</span></div></div>`;
  const prod = rec.cells.reduce((a, r) => a + r[2] + r[3] + r[4], 0); const sleep = rec.cells.reduce((a, r) => a + r[0], 0);
  const kpis = `<div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))"${I('A-197')}>${U.kpi(`${Math.round((total / 48) * 100)}%`, 'Day accounted')}${U.kpi(hrs(prod), 'Productive')}${U.kpi(`${Math.round((prod / Math.max(1, 48 - sleep)) * 100)}%`, 'Waking utilisation')}${U.kpi(hrs(sleep), 'Rest')}</div>`;
  const wk = Object.entries(D.ledger).filter(([d]) => d > addDays(TODAY, -7)).reduce((a, [, r]) => a + r.cells.reduce((x, c) => x + c[4], 0), 0) / 2; const target = 10;
  const chips = [rec.status === 'SUBMITTED' ? chip('Submitted — this day is closed', 'good', I('A-201')) : '', win === 'locked' ? chip(`Locked: days lock ${WINDOW} days after they end`, 'risk', I('A-202')) : '', win === 'open' && rec.status !== 'SUBMITTED' ? chip(`Open until ${fmtShort(addDays(day, WINDOW))}`, 'info', I('A-203')) : '', editable && gap !== 0 ? chip('Submit needs exactly 24 h', 'warn', I('A-203')) : ''].join(' ');
  return U.page({ title: 'Time log', lede: `<span${I('A-189')}>Daily log · Semester ${D.me.student.sem} · six slots, five heads, to the nearest half hour</span>`,
    body: `<div class="card"${I('A-194')}><div class="spread small"><b>Last 14 days · ${subN} submitted</b><span class="muted">Each day can be filled in for ${WINDOW} days after it ends, then it locks.</span></div><div class="daystrip" style="margin-top:10px"${I('A-195')}>${strip}</div></div>
      <div class="spread" style="margin:16px 0 8px"${I('A-190')}><button class="icon-btn" type="button" data-act="step" data-n="-1" aria-label="Previous day">${ic('back')}</button><h2>${day === TODAY ? 'Today' : ''} ${fmtDate(day)}</h2><button class="icon-btn" type="button" data-act="step" data-n="1" aria-label="Next day"${day >= TODAY ? ' disabled' : ''}>${ic('chev')}</button></div>
      <div class="hrow" style="margin-bottom:10px">${chips}</div>
      ${st.err ? `<div class="banner risk small" role="alert" style="margin-bottom:10px"${I('A-193')}>${esc(st.err)}</div>` : `<span hidden${I('A-193')}></span>`}
      ${kpis}<div class="card" style="margin-top:12px">${grid}<p class="xs muted" style="margin-top:8px"${I('A-205')}>A slot cannot hold more than its length; the day must add up to 24 h before you submit.</p></div>
      ${U.section('Skilling this week', `<div class="card"${I('A-206')}><div class="spread small"><span>${wk} h of a ${target} h target</span>${chip(`${Math.round((wk / target) * 100)}%`, wk >= target ? 'good' : 'warn')}</div>${U.meter((wk / target) * 100, wk >= target ? 'good' : '')}</div>`)}
      <div class="sticky-act">${editable && prev && prev.status === 'SUBMITTED' ? `<button class="btn" type="button" data-act="copy"${I('A-191')}>Copy yesterday</button>` : `<span hidden${I('A-191')}></span>`}<button class="btn" type="button" data-act="save"${editable && st.edit ? '' : ' disabled'}${I('A-204')}>Save draft</button><button class="btn primary" type="button" data-act="submit"${editable && gap === 0 ? '' : ' disabled'}${I('A-192')}>${rec.status === 'SUBMITTED' ? 'Submitted' : win === 'locked' ? 'Locked' : 'Submit day'}</button></div>` });
}, acts: {
  day(a, e, st) { st.day = a.dataset.d; st.edit = null; st.err = ''; App.rerender(); },
  step(a, e, st) { const d = addDays(st.day || TODAY, +a.dataset.n); if (d > TODAY) return; st.day = d; st.edit = null; st.err = ''; App.rerender(); },
  'input:cell'() {},
  copy(a, e, st) { const day = st.day || TODAY; st.edit = { day, status: 'DRAFT', cells: D.ledger[addDays(day, -1)].cells.map((r) => r.slice()) }; App.rerender(); },
  save(a, e, st) { const day = st.day || TODAY; if (dayState(day) !== 'open') { st.err = 'This day is locked.'; return App.rerender(); } D.ledger[day] = { status: 'DRAFT', cells: st.edit.cells }; st.edit = null; toast('Draft saved'); App.rerender(); },
  submit(a, e, st) { const day = st.day || TODAY; const rec = st.edit || D.ledger[day]; if (!rec || sumDay(rec.cells) !== 48) { st.err = 'The day must add up to exactly 24 h.'; return App.rerender(); } D.ledger[day] = { status: 'SUBMITTED', cells: rec.cells }; st.edit = null; toast('Day submitted'); App.rerender(); },
}, mount(main, { st }) {
  main.querySelectorAll('[data-act-input="cell"]').forEach((inp) => inp.addEventListener('change', () => {
    const day = st.day || TODAY; const base = st.edit && st.edit.day === day ? st.edit : (D.ledger[day] || { cells: D.SLOTS.map(() => [0, 0, 0, 0, 0]) });
    const cells = base.cells.map((r) => r.slice()); const i = +inp.dataset.i, j = +inp.dataset.j;
    let v = Math.round((parseFloat(inp.value) || 0) * 2); v = Math.max(0, v);
    const cap = D.SLOTS[i][1]; const others = cells[i].reduce((a, b, k) => a + (k === j ? 0 : b), 0);
    if (v > cap - others) { v = cap - others; toast(`${D.SLOTS[i][0]} holds ${hrs(cap)}`, 'risk'); }
    cells[i][j] = v; st.edit = { day, status: 'DRAFT', cells }; App.rerender();
  }));
} });

/* ================================================================ Results & courses (Records + Courses merged) */
R.screen('student/records', { title: 'Results & courses', states: 'A-208 A-218 A-227', render({ st, query }) {
  const tab = st.tab || query.tab || 'results';
  const last = D.semesters.at(-1); const allAtt = Math.round(D.attendance.reduce((a, [, p]) => a + p, 0) / D.attendance.length);
  const stats = `<div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:12px"${I('A-217')}>${U.kpi(last.cgpa, 'Latest CGPA')}${U.kpi(D.semesters.length, 'Semesters on record')}${U.kpi(0, 'Live backlogs')}${U.kpi(allAtt + '%', 'Overall attendance')}</div>`;
  let body = '';
  if (tab === 'results') body = stats + D.semesters.slice().reverse().map((s) => `<div class="card" style="margin-bottom:12px"${I('A-219')}><div class="spread"><h2>Semester ${s.n}</h2>${chip(s.backlogs ? `${s.backlogs} live backlogs` : 'No live backlogs', s.backlogs ? 'risk' : 'good', I('A-220'))}</div><p class="small muted" style="margin:4px 0 10px">CGPA ${s.cgpa} · SGPA ${s.sgpa} · ${s.cls}</p>
      ${U.table([{ h: 'Code', k: 0 }, { h: 'Subject', k: 1 }, { h: 'Credits', k: 2, r: 1 }, { h: 'Internal', k: 3, r: 1 }, { h: 'External', k: 4, r: 1 }, { h: 'Total', k: 5, r: 1 }, { h: 'Result', k: 'res' }], s.subjects.map((r) => ({ ...r, res: chip(r[6], r[6] === 'Pass' ? 'good' : 'risk') })), I('A-221'))}</div>`).join('') + `<p class="xs muted"${I('A-218')}>Imported by the examination office from VTU.</p>`;
  if (tab === 'attendance') body = `<div class="card"${I('A-222', 'A-223')}><div class="spread"><div><div class="kpi" style="border:0;box-shadow:none;padding:0"><div class="v">${allAtt}%</div><div class="l">present across ${D.attendance.length} courses</div></div></div>${chip(`${allAtt}% · ${pctWord(allAtt)}`, pctTone(allAtt))}</div>${U.meter(allAtt, pctTone(allAtt))}</div>
      ${U.section('By course', `<div class="list"${I('A-224')}>${D.attendance.map(([c, p]) => U.row({ title: esc(c), sub: U.meter(p, pctTone(p)), trail: chip(`${p}%`, pctTone(p)), chev: false })).join('')}</div>`)}`;
  if (tab === 'courses') body = `<p class="small muted" style="margin-bottom:10px"${I('A-207', 'A-216')}>${D.courses.length} enrolled · ${D.courses.filter((c) => c.status === 'In progress').length} in progress · ${D.courses.filter((c) => c.status === 'Completed').length} completed</p><div class="grid-2"${I('A-208')}>${D.courses.map((c) => `<div class="card"${I('A-209')}><div class="spread"><h3>${esc(c.name)}</h3>${chip(c.status, { Completed: 'good', 'In progress': 'info', Overdue: 'risk', 'Not started': 'neutral' }[c.status], I('A-210'))}</div><p class="xs muted">${c.code} · Sem ${c.sem} · ${c.stage}</p>
      <div style="margin:10px 0"${I('A-211')}>${U.meter(c.pct)}<span class="xs muted">${c.pct}% complete</span></div><p class="small"${I('A-212')}>Next: ${esc(c.next)}</p><p class="xs muted"${I('A-213')}>${c.att}/${c.total} lectures${c.status !== 'Completed' && c.total - c.att > 0 ? ` · ${c.total - c.att} lectures left` : ''}</p>
      <div class="spread" style="margin-top:10px">${c.unlocks ? chip(`Unlocks: ${c.unlocks}`, 'info', I('A-215')) : '<span></span>'}<button class="btn sm" type="button" data-act="continue" data-c="${c.code}"${I('A-214')}>Continue</button></div></div>`).join('')}</div>`;
  if (tab === 'history') body = `<div class="grid-2"${I('A-225')}>${D.academicHistory.map((h) => `<div class="card"><div class="spread"><h3>${h.level}</h3>${chip(`${h.pct}%`, 'info')}</div><dl class="kv" style="margin-top:8px"><dt>Institution</dt><dd>${esc(h.inst)}</dd><dt>Board</dt><dd>${h.board}</dd><dt>Year</dt><dd>${h.year}</dd></dl></div>`).join('')}</div>
      ${U.section('Declared education gaps', `<div class="card"${I('A-226')}><div class="spread"><b>${D.gaps.reduce((a, [, m]) => a + m, 0)} months total</b></div>${D.gaps.map(([g, m]) => `<p class="small">${g}: ${m} months</p>`).join('')}</div>`)}`;
  return U.page({ title: 'Results & courses', body: U.tabs('tab', [['results', 'Results'], ['attendance', 'Attendance'], ['courses', 'Courses'], ['history', 'Academic history']], tab) + body });
}, acts: { continue(a) { toast(`Opening ${a.dataset.c}`); } } });
R.screen('student/courses', { title: 'Courses', render() { setTimeout(() => { App.s('student/records').tab = 'courses'; R.go('#/student/records'); }, 0); return ''; } });
