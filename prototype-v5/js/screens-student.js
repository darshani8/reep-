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
