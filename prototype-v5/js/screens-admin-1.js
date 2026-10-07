/* REEP v5 prototype — Main Admin console, part 1: Home, Charts & numbers, Leave
   requests, New applications, Assign faculty, Colleges (+ structure + Set up a
   college, merged into one area), Interview records, Interview questions, Job
   postings, Placement & offers. Inventory rows C-001…C-284. */
'use strict';
(() => {
/* ---------------------------------------------------------------- helpers */
const ids = (s) => s.match(/"([^"]*)"/)[1]; // turns an inventory tag back into the id list a screen's states: wants
const can = (cap) => App.role === 'admin' || (App.role === 'faculty' && cap === 'admin.leave_approvals' && D.me.faculty.granted.includes(cap));
const rr = () => App.rerender();
const wide = () => matchMedia('(min-width: 1024px)').matches;
const dayCount = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5) + 1;
const lakh = (n) => (n == null ? '—' : `₹${(+n).toFixed(1).replace(/\.0$/, '')} L`);
const ago = (d) => Math.round((new Date(TODAY + 'T00:00:00') - new Date(d.slice(0, 10) + 'T00:00:00')) / 864e5);
const opt = (arr, all) => (all ? [['', all]] : []).concat(arr);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const dismiss = (el, ev, st) => { st.flash = null; rr(); };
const flashBar = (st, inv) => (st.flash ? `<div class="banner ${st.flash.tone || 'good'} a1-flash" role="${st.flash.tone === 'risk' ? 'alert' : 'status'}"${inv}>${ic(st.flash.tone === 'risk' ? 'alert' : 'check')}<div class="grow">${esc(st.flash.text)}</div>${st.flash.undo ? `<button class="btn sm" type="button" data-act="${st.flash.undo}">Undo</button>` : ''}<button class="btn sm ghost" type="button" data-act="dismiss">Dismiss</button></div>` : '');
const say = (st, text, tone = 'good', undo = '') => { st.flash = { text, tone, undo }; };
const ck = (name, val, checked, attrs = '') => `<label class="a1-ck"><input type="checkbox" data-act-change="ck" data-f="${name}" value="${esc(val)}"${checked ? ' checked' : ''}${attrs}><span class="sr">Select</span></label>`;
/** a row with a checkbox lead and a link body: an <a> cannot hold an <input> */
const crow = ({ box = '', href = '', act = '', data = '', title, sub = '', trail = '', sel = false, inv = '' }) =>
  `<div class="row a1-crow${sel ? ' sel' : ''}"${inv}>${box}${href ? `<a class="body a1-link" href="${href}">` : act ? `<button class="body a1-link" type="button" data-act="${act}"${data}>` : '<div class="body">'}<div class="ttl">${title}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${href ? '</a>' : act ? '</button>' : '</div>'}<div class="trail">${trail}</div></div>`;
const pager = (st, total, sizes, inv, def = sizes[0]) => {
  const size = +(st.size || def); const pages = Math.max(1, Math.ceil(total / size)); st.page = Math.min(st.page || 1, pages);
  const from = total ? (st.page - 1) * size + 1 : 0; const to = Math.min(total, st.page * size);
  return { from, to, size, html: `<div class="hrow a1-pager"${inv}><span class="xs muted">Rows ${from}–${to} of ${total}</span><span class="grow"></span>${U.select('size', sizes.map((n) => [n, `${n} a page`]), size, '', 'Page size')}<button class="btn sm" type="button" data-act="page" data-d="-1"${st.page <= 1 ? ' disabled' : ''}>Previous</button><span class="xs">Page ${st.page} of ${pages}</span><button class="btn sm" type="button" data-act="page" data-d="1"${st.page >= pages ? ' disabled' : ''}>Next</button></div>` };
};
const pageAct = (el, ev, st) => { st.page = (st.page || 1) + +el.dataset.d; rr(); };
/** Columns chooser: a sheet of checkboxes; `cols` = [[key, label]], st.hide = {key:true} */
const chooseCols = (st, cols, title = 'Columns') => Sheet.open({ title, center: true,
  body: `<div class="stack">${cols.map(([k, t]) => `<label class="check"><input type="checkbox" name="${k}"${st.hide && st.hide[k] ? '' : ' checked'}><span>${esc(t)}</span></label>`).join('')}</div>`,
  foot: '<button class="btn primary" type="button" data-act="ok">Done</button>',
  onAct: { ok: (a, ev, el) => { const v = formVals(el); st.hide = {}; cols.forEach(([k]) => { if (!v[k]) st.hide[k] = true; }); Sheet.close(); rr(); } } });
const csv = (name, rows) => { const s = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast(`Saved ${name}`); };
const fakeDownload = (name) => toast(`Downloading ${name}`);
const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const listOr = (items, empty) => (items.length ? items.join('') : `<div class="row"><div class="body"><div class="sub">${empty}</div></div></div>`);

/* ---------------------------------------------------------------- the console's shared fake data */
const A = Object.assign(window.ADM ||= {}, {
  serverRecording: false,
  levels: { course: true, spec: false }, // HIERARCHY_LEVELS: which rung a new batch must name
  colleges: [
    { id: 'c1', code: 'NHM', name: 'Nandi Hills School of Management', campus: 'Bengaluru', contact: 'placements@nhsm.edu.in', domains: ['nhsm.edu.in'], status: 'Active', admin: { name: 'Dr. Kavitha Murthy', fns: 6, of: 6, pending: 0 } },
    { id: 'c2', code: 'KIB', name: 'Kaveri Institute of Business', campus: 'Mysuru', contact: 'office@kaveri-ib.edu.in', domains: [], status: 'Active', admin: null },
    { id: 'c3', code: 'TBS', name: 'Tunga Business School', campus: 'Shivamogga', contact: '', domains: ['tbs.ac.in'], status: 'Draft', admin: { name: 'Prof. Raghav Hegde', fns: 2, of: 6, pending: 1 } },
  ],
  depts: [
    { id: 'd1', college: 'c1', code: 'MBA', name: 'Management Studies', head: 'Dr. Lakshmi Narayan', capacity: 5 },
    { id: 'd2', college: 'c1', code: 'MCA', name: 'Computer Applications', head: 'Prof. Vinay Shenoy', capacity: null },
    { id: 'd3', college: 'c2', code: 'MBA', name: 'Business Administration', head: '', capacity: null },
  ],
  courses: [
    { id: 'k1', dept: 'd1', code: 'MBA', name: 'General MBA', degree: 'PG', years: 2, status: 'Active' },
    { id: 'k2', dept: 'd1', code: 'dm', name: 'MBA Digital Marketing', degree: 'PG', years: 2, status: 'Active' },
    { id: 'k3', dept: 'd2', code: 'MCA', name: 'Master of Computer Applications', degree: 'PG', years: 2, status: 'Active' },
    { id: 'k4', dept: 'd3', code: 'MBA', name: 'General MBA', degree: 'PG', years: 2, status: 'Active' },
    { id: 'k5', dept: 'd1', code: 'PGDM', name: 'PGDM (2019 scheme)', degree: 'PG', years: 2, status: 'Archived' },
  ],
  specs: [
    { id: 'sp1', course: 'k1', code: 'fa', name: 'Financial Analytics' },
    { id: 'sp2', course: 'k1', code: 'hr', name: 'Human Resources' },
    { id: 'sp3', course: 'k1', code: 'mkt', name: 'Marketing' },
    { id: 'sp4', course: 'k4', code: 'fin', name: 'Finance' },
  ],
  trackMap: { k3: 'ba' }, // a track mapped to a course or specialization by id
  batches: [
    { id: 'b1', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp1', code: 'NHM-MBA-MBA-FA-2025-27', name: '2025-27', label: '2025-27', entry: '2025-07-01', completion: '2027-06-30', degree: 'PG' },
    { id: 'b2', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp2', code: 'NHM-MBA-MBA-HR-2025-27', name: '2025-27', label: '2025-27', entry: '2025-07-01', completion: '2027-06-30', degree: 'PG' },
    { id: 'b3', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp3', code: 'NHM-MBA-MBA-MKT-2025-27', name: '2025-27', label: '2025-27', entry: '2025-07-01', completion: '2027-06-30', degree: 'PG' },
    { id: 'b4', college: 'c1', dept: 'd1', course: 'k2', spec: null, code: 'NHM-MBA-DM-2025-27', name: '2025-27', label: '2025-27', entry: '2025-07-01', completion: '2027-06-30', degree: 'PG' },
    { id: 'b5', college: 'c1', dept: 'd2', course: 'k3', spec: null, code: 'NHM-MCA-MCA-2025-27', name: '2025-27', label: '2025-27', entry: '2025-07-01', completion: '2027-06-30', degree: 'PG' },
    { id: 'b6', college: 'c1', dept: null, course: null, spec: null, code: 'NHM-EVE-2024', name: '2024-26 Evening', label: '2024-26', entry: '2024-08-01', completion: '2026-07-31', degree: 'PG' },
    { id: 'b7', college: 'c2', dept: 'd3', course: 'k4', spec: 'sp4', code: 'KIB-MBA-MBA-FIN-2026-28', name: '2026-28', label: '2026-28', entry: '2026-07-01', completion: '2028-06-30', degree: 'PG' },
  ],
  faculty: [
    { id: 'f1', name: 'Dr. Meera Iyer', dept: 'd1', college: 'c1' },
    { id: 'f2', name: 'Prof. Sameer Nadig', dept: 'd1', college: 'c1' },
    { id: 'f3', name: 'Dr. Farah Khan', dept: 'd2', college: 'c1' },
    { id: 'f4', name: 'Prof. Anil Kamath', dept: 'd3', college: 'c2', capacity: 2 },
  ],
  defaultCapacity: 6,
  students: [
    { id: 's1', name: 'Aarav Kulkarni', usn: '1NH25MBA014', stage: 'Excel', batch: 'b1', mentor: 'f1', dept: 'd1', att: 84, skills: 3, hours: 6.5, cv: true },
    { id: 's2', name: 'Diya Shetty', usn: '1NH25MBA021', stage: 'Elevate', batch: 'b1', mentor: 'f1', dept: 'd1', att: 91, skills: 5, hours: 8, cv: true },
    { id: 's3', name: 'Rohan Gowda', usn: '1NH25MBA033', stage: 'Excel', batch: 'b2', mentor: 'f1', dept: 'd1', att: 77, skills: 2, hours: 4, cv: false },
    { id: 's4', name: 'Ananya Rao', usn: '1NH25MBA040', stage: 'Reboot', batch: 'b3', mentor: 'f1', dept: 'd1', att: 88, skills: 6, hours: 7, cv: true },
    { id: 's5', name: 'Kabir Menon', usn: '1NH25MBA045', stage: 'Excel-Adv', batch: 'b2', mentor: 'f2', dept: 'd1', att: 69, skills: 1, hours: 3, cv: true },
    { id: 's6', name: 'Nithya Prasad', usn: '1NH25MCA008', stage: 'Excel', batch: 'b5', mentor: 'f2', dept: 'd2', att: 81, skills: 2, hours: 5, cv: false },
    { id: 's7', name: 'Gautam Bhandary', usn: '1NH25MBA047', stage: 'Elevate', batch: 'b4', mentor: 'f2', dept: 'd1', att: 86, skills: 4, hours: 6, cv: true },
    { id: 's8', name: 'Lavanya Gupta', usn: '1KI26MBA003', stage: 'Reboot', batch: 'b7', mentor: 'f4', dept: 'd3', att: 92, skills: 1, hours: 2, cv: true },
    { id: 's9', name: 'Siddharth Rai', usn: '1KI26MBA006', stage: 'Reboot', batch: 'b7', mentor: 'f4', dept: 'd3', att: 75, skills: 0, hours: 1, cv: false },
    { id: 's10', name: 'Ishaan Bhat', usn: '1NH25MBA052', stage: 'Excel', batch: 'b1', mentor: null, dept: 'd1', att: 79, skills: 1, hours: 3, cv: true },
    { id: 's11', name: 'Meghana Hegde', usn: '1NH25MBA055', stage: 'Reboot', batch: 'b1', mentor: null, dept: 'd1', att: 83, skills: 0, hours: 2, cv: false },
    { id: 's12', name: 'Tanvi Pai', usn: '1NH25MBA058', stage: 'Excel', batch: 'b3', mentor: null, dept: 'd1', att: 90, skills: 2, hours: 5, cv: true },
    { id: 's13', name: 'Nikhil Joshi', usn: '1NH25MCA012', stage: 'Elevate', batch: 'b5', mentor: null, dept: 'd2', att: 72, skills: 3, hours: 4, cv: true },
    { id: 's14', name: 'Sneha Kulkarni', usn: '1NH25MBA061', stage: null, batch: null, mentor: null, dept: 'd1', att: null, skills: 0, hours: null, cv: false },
    { id: 's15', name: 'Pranav Iyengar', usn: '1KI26MBA011', stage: null, batch: null, mentor: null, dept: 'd3', att: null, skills: 0, hours: null, cv: false },
  ],
  mentorHist: {
    s1: [
      { mentor: 'f2', from: '2025-07-15', to: '2025-12-10', kind: 'Assigned', by: 'Placement Office', reason: 'First seating of the 2025-27 batch', end: 'Moved on', endBy: 'Placement Office', endReason: 'Balancing Prof. Nadig’s group' },
      { mentor: 'f1', from: '2025-12-10', to: null, kind: 'Moved here', by: 'Placement Office', reason: 'Balancing Prof. Nadig’s group' },
    ],
    s2: [{ mentor: 'f1', from: null, to: null, kind: 'Assigned', by: '—', reason: '' }],
  },
});
const college = (id) => A.colleges.find((c) => c.id === id);
const dept = (id) => A.depts.find((d) => d.id === id);
const course = (id) => A.courses.find((c) => c.id === id);
const spec = (id) => A.specs.find((s) => s.id === id);
const batch = (id) => A.batches.find((b) => b.id === id);
const fac = (id) => A.faculty.find((f) => f.id === id);
const stu = (id) => A.students.find((s) => s.id === id);
/** "General MBA - Finance · 2026-28" — the year leads the tail, the office's words follow unless they already hold the span */
const batchLabel = (b) => { if (!b) return 'No batch'; const c = course(b.course); const s = spec(b.spec); const head = [c && c.name, s && s.name].filter(Boolean).join(' - '); const tail = b.name && b.name !== b.label ? (b.name.includes(b.label) ? b.name : `${b.label} · ${b.name}`) : b.label; return head ? `${head} · ${tail}` : tail; };
const batchCount = (bid) => A.students.filter((s) => s.batch === bid).length;
const batchOpts = (cid) => A.batches.filter((b) => !cid || b.college === cid).map((b) => [b.id, `${batchLabel(b)} · ${batchCount(b.id)} students`]);
const capOf = (f) => f.capacity || (dept(f.dept) && dept(f.dept).capacity) || A.defaultCapacity;
const capSource = (f) => (f.capacity ? 'set for this faculty member' : dept(f.dept) && dept(f.dept).capacity ? 'department capacity' : 'programme default');
const menteesOf = (fid) => A.students.filter((s) => s.mentor === fid);
const stageChip = (s) => (s ? chip(s, s === 'Elevate' ? 'good' : s === 'Reboot' ? 'neutral' : 'info') : chip('Stage not set', 'warn'));
const TRACKS_FALLBACK = [['hr', 'Human Resources'], ['dm', 'Digital Marketing'], ['ba', 'Business Analytics'], ['fa', 'Financial Analytics']];

/* ================================================================ Home */
const TILE_GROUPS = [
  ['Students', I('C-007'), [
    ['Approve new students', '#/admin/registrations', 'applications register admit queue', 'admin.registrations', 'inbox'],
    ['Find a student', '#/admin/students', 'roster batch edit usn search', 'admin.students', 'search'],
    ['Assign faculty to students', '#/admin/mentors', 'mentor mapping group', 'admin.mentors', 'swap'],
    ['Upload marks & attendance', '#/admin/imports', 'import spreadsheet vtu results', 'admin.imports', 'upload']]],
  ['Faculty', I('C-008'), [
    ['Add a faculty member', '#/admin/faculty/new', 'staff account activation link', 'admin.mentors', 'plus'],
    ['See all faculty', '#/admin/faculty', 'staff list disable', 'admin.mentors', 'user'],
    ['Approve leave', '#/admin/leave-approvals', 'leave sanction casual ood', 'admin.leave_approvals', 'cal']]],
  ['Jobs', I('C-009'), [
    ['Post a job', '#/admin/jobs', 'posting company drive', 'admin.jobs', 'briefcase'],
    ['Approve job offers', '#/admin/placement', 'offer letter placement', 'admin.placement', 'trophy']]],
  ['Interviews', I('C-010'), [
    ['Edit interview questions', '#/admin/interview-questions', 'bank track mock', 'admin.interview_questions', 'list'],
    ['See interview records', '#/admin/interviews', 'mock transcript audio report', 'admin.interviews', 'mic'],
    ['Write SWOC notes', '#/admin/swoc', 'strengths weaknesses', 'admin.swoc', 'grid']]],
  ['Reports', I('C-011'), [
    ['See charts & numbers', '#/admin/analytics', 'analytics kpi alerts', 'admin.analytics', 'chart'],
    ['Download a report', '#/admin/exports', 'export csv', 'admin.exports', 'download']]],
  ['Setup', I('C-012'), [
    ['Set up a college', '#/admin/setup', 'new college department course batch', 'admin.institution', 'plus'],
    ['Colleges', '#/admin/colleges', 'college list domains appoint', 'admin.institution', 'building'],
    ['Departments, courses & batches', '#/admin/colleges/c1', 'structure specialization batch', 'admin.institution', 'layers'],
    ['Subjects & certificates', '#/admin/catalogue', 'catalogue subjects certification', 'admin.catalogue', 'book'],
    ['Decide who can do what', '#/admin/governance', 'governance grant capability', 'ADMIN', 'key'],
    ['See what changed', '#/admin/audit', 'audit trail history', 'ADMIN', 'restore'],
    ['Check email delivery', '#/admin/mail', 'mail bounce suppression', 'ADMIN', 'mail'],
    ['Ask REEP', 'dock', 'agent assistant chat', 'ADMIN', 'sparkle']]],
];
R.screen('admin/home', { title: 'Home', render({ st }) {
  const q = (st.q || '').trim().toLowerCase();
  const offersWaiting = (A.offers || []).filter((o) => o.status === 'Awaiting approval').length;
  const unassigned = A.students.filter((s) => !s.mentor).length;
  const queues = [
    [A.regs.filter((r) => r.status === 'Pending review').length, 'New student applications', '#/admin/registrations', 'admin.registrations', I('C-002')],
    [A.leave.filter((l) => l.status === 'Awaiting').length, 'Leave requests', '#/admin/leave-approvals', 'admin.leave_approvals', I('C-003')],
    [unassigned, 'Students without a faculty member', '#/admin/mentors', 'admin.mentors', I('C-004')],
    [offersWaiting, 'Job offers to approve', '#/admin/placement', 'admin.placement', I('C-005')],
    [3, 'Access requests to review', '#/admin/governance', 'ADMIN', I('C-006')],
  ].filter((x) => can(x[3]));
  const waiting = q ? '' : U.section('Waiting for you', `<div class="a1-kpis">${queues.map(([n, l, href, , inv]) => `<a class="kpi a1-q${n ? '' : ' none'}" href="${href}"${inv}><div class="v">${n == null ? '—' : n}</div><div class="l">${esc(l)}</div></a>`).join('')}</div>`);
  const groups = TILE_GROUPS.map(([g, inv, tiles]) => [g, inv, tiles.filter(([l, , kw, cap]) => can(cap) && (!q || `${l} ${kw}`.toLowerCase().includes(q)))]).filter((g) => g[2].length);
  const tiles = groups.length ? groups.map(([g, inv, t]) => U.section(g, `<div class="a1-tiles"${inv}>${t.map(([l, to, , , icn]) => (to === 'dock' ? `<button class="a1-tile" type="button" data-act="dock">${ic(icn)}<span>${esc(l)}</span></button>` : `<a class="a1-tile" href="${to}">${ic(icn)}<span>${esc(l)}</span></a>`)).join('')}</div>`)).join('')
    : U.empty('search', `Nothing called “${esc(st.q)}”.`);
  return U.page({ title: 'Home', lede: `Main Admin · ${A.colleges.length} colleges`,
    body: `<div class="filters" style="overflow:visible">${U.search('q', st.q || '', 'Find a task…', I('C-001'))}</div>${waiting}${tiles}` });
} });

/* ================================================================ Charts & numbers */
const KPI_BASE = { 6: 0, 12: 1, 26: 2, 52: 3 };
const kpisFor = (w) => { const f = KPI_BASE[w] ?? 1; const pend = A.regs.filter((r) => r.status === 'Pending review').length + (A.offers || []).filter((o) => o.status === 'Awaiting approval').length;
  return [
    ['placement_rate', 'Placement rate', `${31 + f * 3}%`, `+${2 + f} pts`, 'good', '#/admin/placement', 'Open placement'],
    ['median_ctc', 'Median CTC', lakh(5.8 + f * 0.2), '+₹0.3 L', 'good', '#/admin/placement', 'Open placement'],
    ['highest_ctc', 'Highest CTC', lakh(11 + f), 'same as before', 'neutral', '#/admin/placement', 'Open placement'],
    ['placement_ready_pct', 'Placement ready %', w === 6 ? null : `${54 + f}%`, w === 6 ? '' : '−2 pts', 'risk', '', '', 'No readiness snapshot in the last 6 weeks'],
    ['attendance_avg', 'Attendance average', `${82 - f}%`, '−1 pt', 'warn', '', ''],
    ['mock_interviews', 'Mock interviews', String(14 + f * 21), `+${3 + f * 4}`, 'good', '', ''],
    ['pending_approvals', 'Pending approvals', String(pend), '', '', '#/admin/registrations', 'Open registrations'],
  ]; };
const SERIES = [
  { k: 'attendance_pct', name: 'Attendance %', axis: 'l', src: 'live', c: 'var(--cat-1)', v: [84, 83, 85, 82, 81, 83, 80, 82, 79, 81, 82, 80] },
  { k: 'readiness_pct', name: 'Readiness %', axis: 'l', src: 'live', c: 'var(--cat-2)', v: [48, 49, 51, 50, 52, 53, 55, 54, 56, 57, 56, 58] },
  { k: 'skilling_hours', name: 'Skilling hours', axis: 'r', src: 'partial', note: 'Only Nandi Hills logs hours; Kaveri and Tunga do not, so the line counts one college.', c: 'var(--cat-3)', v: [3.1, 3.4, null, 3.8, 4.0, 4.4, 4.1, 4.6, 4.9, 5.2, 5.0, 5.4] },
  { k: 'offers', name: 'Offers', axis: 'r', src: 'unavailable', note: 'No offer in this window carries a date, so nothing is drawn.', c: 'var(--cat-4)', v: [] },
];
/** a small two-axis line chart; null points break the line, unavailable series are not drawn */
function lineChart(series, labels, lmax = 100, rmax = 10, inv = '') {
  const W = 640, H = 220, L = 34, Rr = 34, T = 12, B = 26; const n = labels.length;
  const x = (i) => L + (i * (W - L - Rr)) / Math.max(1, n - 1); const yl = (v) => H - B - (v / lmax) * (H - B - T); const yr = (v) => H - B - (v / rmax) * (H - B - T);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => { const y = H - B - g * (H - B - T); return `<line x1="${L}" x2="${W - Rr}" y1="${y}" y2="${y}" stroke="var(--hairline-26)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" class="a1-ax">${Math.round(lmax * g)}</text><text x="${W - Rr + 6}" y="${y + 4}" class="a1-ax">${+(rmax * g).toFixed(1)}</text>`; }).join('');
  const xs = labels.map((l, i) => (i % Math.ceil(n / 6) === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="a1-ax">${esc(l)}</text>` : '')).join('');
  const lines = series.filter((s) => s.src !== 'unavailable').map((s) => { let d = '', pen = false; s.v.forEach((v, i) => { if (v == null) { pen = false; return; } const y = s.axis === 'r' ? yr(v) : yl(v); d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y.toFixed(1)} `; pen = true; }); return `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"${s.src === 'partial' ? ' stroke-dasharray="6 4"' : ''}/>${s.v.map((v, i) => (v == null ? '' : `<circle cx="${x(i)}" cy="${s.axis === 'r' ? yr(v) : yl(v)}" r="3" fill="${s.c}"><title>${esc(s.name)} · ${esc(labels[i])}: ${v}</title></circle>`)).join('')}`; }).join('');
  return `<svg class="a1-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))} by week"${inv}>${grid}${xs}${lines}</svg>`;
}
const legend = (series) => `<div class="legend">${series.map((s) => `<span><i style="background:${s.c}"></i>${esc(s.name)}</span>`).join('')}</div>`;
const ALERT_RULES = [
  { code: 'NO_CHECKIN_N_DAYS', name: 'No sign-in for N days', never: 'a student on sanctioned leave', p: [['days', 'Days of silence', 5]] },
  { code: 'ATTENDANCE_BELOW_THRESHOLD', name: 'Attendance below the cut-off', never: 'a subject with fewer sessions than the minimum', p: [['minAttendancePct', 'Attendance floor %', 75], ['minSessions', 'Minimum sessions', 1]] },
  { code: 'CERT_OVERDUE', name: 'Certification overdue', never: 'a certification with no due date', p: [['graceDays', 'Grace days', 3]] },
  { code: 'PACE_BELOW_THRESHOLD', name: 'Skilling pace below target', never: 'a week with no skilling target', p: [['deviationPct', 'Deviation %', 25]] },
  { code: 'LOW_FOCUS_QUALITY', name: 'Low focus quality', never: 'a ledger day that was not submitted', p: [['minProductivePct', 'Productive floor %', 40], ['days', 'Window in days', 14], ['minDays', 'Minimum submitted days', 3]] },
];
Object.assign(A, {
  alerts: [
    { rule: 'Attendance below the cut-off', sev: 'Critical', msg: 'Attendance 69% against a 75% floor in Business Research', student: 'Kabir Menon', date: '2026-10-06' },
    { rule: 'No sign-in for N days', sev: 'Warning', msg: 'No sign-in for 6 days', student: 'Meghana Hegde', date: '2026-10-05' },
    { rule: 'Skilling pace below target', sev: 'Info', msg: 'Skilling 2 h against a 6 h weekly target', student: 'Siddharth Rai', date: '2026-10-04' },
  ],
  alertRules: { b1: { NO_CHECKIN_N_DAYS: { on: true, sev: 'WARNING', p: { days: '' } }, ATTENDANCE_BELOW_THRESHOLD: { on: true, sev: 'CRITICAL', p: { minAttendancePct: '75', minSessions: '' } }, CERT_OVERDUE: { on: false, sev: 'INFO', p: {} } } },
});
const sevTone = (s) => (s === 'Critical' ? 'risk' : s === 'Warning' ? 'warn' : 'info');
function ruleBody(bid) {
  const set = (bid && A.alertRules[bid]) || {};
  const on = ALERT_RULES.filter((r) => set[r.code] && set[r.code].on).length;
  return `<div class="stack">${U.field({ id: 'rb', label: 'Batch', value: bid || '', opts: opt(batchOpts(), 'Choose a batch'), inv: I('C-031'), attrs: ' data-act-change="x" data-f="rb"' })}
    <p class="small muted">${bid ? `${on} of 5 rules will be evaluated` : 'Choose a batch to see its rules.'}</p>
    ${ALERT_RULES.map((r) => { const s = set[r.code]; const st = !s ? ['Not set', 'neutral'] : s.on ? ['Evaluated', 'good'] : ['Switched off', 'warn'];
    return `<div class="card flat"${I('C-032')}><div class="card-h"><h3 class="grow">${esc(r.name)}</h3>${chip(st[0], st[1])}</div><p class="xs muted" style="margin-bottom:8px">Never alerts on: ${esc(r.never)}</p>
      <label class="check"${I('C-033')}><input type="checkbox" name="on-${r.code}"${s && s.on ? ' checked' : ''}${bid ? '' : ' disabled'}><span>Evaluate this rule</span></label>
      <div class="form-grid">${U.field({ id: `sev-${r.code}`, label: 'Severity', value: s ? s.sev : 'WARNING', opts: [['INFO', 'Info'], ['WARNING', 'Warning'], ['CRITICAL', 'Critical']], inv: I('C-034'), attrs: bid ? '' : ' disabled' })}
      ${r.p.map(([k, l, d]) => U.field({ id: `p-${r.code}-${k}`, label: l, value: s && s.p[k] != null ? s.p[k] : '', ph: `Default ${d}`, inv: I('C-035'), attrs: ` inputmode="decimal"${bid ? '' : ' disabled'}` })).join('')}</div>
      <button class="btn sm" type="button" data-act="setRule" data-code="${r.code}"${bid ? '' : ' disabled'}${I('C-036')}>${s ? 'Save' : 'Set this rule'}</button></div>`; }).join('')}</div>`;
}
function openRules() {
  let bid = '';
  Sheet.open({ title: 'Alert rules', wide: true, body: ruleBody(bid), foot: `<button class="btn" type="button" data-sheet-close${I('C-037')}>Close</button>`,
    onAct: {
      'change:rb': (a, ev, el) => { bid = a.value; el.querySelector('.sh-b').innerHTML = ruleBody(bid); },
      setRule: (a, ev, el) => {
        const r = ALERT_RULES.find((x) => x.code === a.dataset.code); const v = formVals(el); const e = {}; const p = {};
        r.p.forEach(([k, l]) => { const raw = v[`p-${r.code}-${k}`]; if (raw !== '' && !/^\d+(\.\d+)?$/.test(raw)) e[`p-${r.code}-${k}`] = `${l} must be a number, or left blank.`; p[k] = raw; });
        if (!errs(el, e)) return;
        (A.alertRules[bid] ||= {})[r.code] = { on: !!v[`on-${r.code}`], sev: v[`sev-${r.code}`], p };
        el.querySelector('.sh-b').innerHTML = ruleBody(bid); toast(`${r.name}: saved. It applies at the next alert check.`);
      },
    } });
}
R.screen('admin/analytics', { title: 'Charts & numbers', states: ids(I('C-019', 'C-028')), render({ st }) {
  const w = +(st.weeks || 12);
  const labels = Array.from({ length: 12 }, (_, i) => fmtShort(addDays(TODAY, -7 * (11 - i))));
  const kp = kpisFor(w);
  const kpis = `<div class="a1-kpis"${I('C-017')}>${kp.map(([k, l, v, d, tone, href, link, why]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v == null ? '—' : esc(v)}</div>${v == null ? `<div class="xs muted">${esc(why)}</div>` : d ? chip(d, tone) : ''}${href ? `<div style="margin-top:6px"><a class="small" href="${href}"${I('C-018')}>${esc(link)}</a></div>` : ''}</div>`).join('')}</div>`;
  const who = st.who || '';
  let chart;
  if (!who) {
    chart = `${lineChart(SERIES, labels, 100, 6, I('C-020'))}${legend(SERIES.filter((s) => s.src !== 'unavailable'))}
      <div class="stack" style="margin-top:10px"${I('C-021')}>${SERIES.map((s) => `<div class="hrow small">${chip(s.src === 'live' ? 'live' : s.src === 'partial' ? 'partial' : 'unavailable', s.src === 'live' ? 'good' : s.src === 'partial' ? 'warn' : 'neutral')}<b>${esc(s.name)}</b>${s.note ? `<span class="muted">${esc(s.note)}</span>` : ''}</div>`).join('')}</div>`;
  } else {
    const s = stu(who);
    if (s.att == null) chart = `<div class="banner info"${I('C-024')}>${ic('info')}<div>There is nothing to plot for this window: no attendance or hours were recorded for ${esc(s.name)} in the last six weeks.</div></div>`;
    else {
      const six = labels.slice(-6); const ser = [{ name: 'Attendance %', axis: 'l', c: 'var(--cat-1)', v: [0, 1, 2, 3, 4, 5].map((i) => Math.min(100, s.att - 3 + ((i * 7) % 6))) }, { name: 'Hours logged / wk', axis: 'r', c: 'var(--cat-3)', v: [0, 1, 2, 3, 4, 5].map((i) => +(s.hours - 1 + (i % 3) * 0.5).toFixed(1)) }];
      chart = `${lineChart(ser, six, 100, 10)}${legend(ser)}`;
    }
    if (s.cv) chart += `<div style="margin-top:10px"><button class="btn sm" type="button" data-act="cv" data-n="${esc(s.name)}"${I('C-023')}>${ic('download', 'sm')} Download CV</button></div>`;
  }
  const mq = (st.mq || '').toLowerCase();
  const fl = A.faculty.filter((f) => !mq || `${f.name} ${dept(f.dept).name}`.toLowerCase().includes(mq));
  const pg = pager(st, fl.length, [8, 16, 32], '');
  const loadRows = fl.slice(pg.from - 1, pg.to).map((f) => { const m = menteesOf(f.id); const cap = capOf(f); const att = m.filter((x) => x.att != null); const status = !m.length ? chip('No students yet', 'neutral') : m.length >= cap ? chip('At capacity', 'warn') : chip('On track', 'good');
    return { m: esc(f.name), d: esc(dept(f.dept).name), n: `${m.length} / ${cap}`, a: att.length ? `${Math.round(att.reduce((t, x) => t + x.att, 0) / att.length)}%` : '—', s: m.reduce((t, x) => t + x.skills, 0), h: m.length ? `${m.reduce((t, x) => t + (x.hours || 0), 0)} h` : '—', st: status }; });
  const load = `<div class="filters">${U.search('mq', st.mq || '', 'Search mentors…', I('C-026'))}</div>
    ${loadRows.length ? U.table([{ h: 'Mentor', k: 'm' }, { h: 'Department', k: 'd' }, { h: 'Mentees', k: 'n', r: 1 }, { h: 'Attendance', k: 'a', r: 1 }, { h: 'Skills', k: 's', r: 1 }, { h: 'Hours logged', k: 'h', r: 1 }, { h: 'Status', k: 'st' }], loadRows, I('C-025')) : `<div class="card"${I('C-025')}>${U.empty('users', `No mentor matches “${esc(st.mq)}”.`)}</div>`}${pg.html.replace('class="hrow a1-pager"', 'class="hrow a1-pager" style="margin-top:8px"')}`;
  const alerts = `<div class="list"${I('C-029')}>${listOr(A.alerts.map((a) => U.row({ title: esc(a.msg), sub: `${esc(a.student)} · ${fmtDate(a.date)}`, lead: U.lead('bell'), trail: `${chip(a.rule, 'neutral')} ${chip(a.sev, sevTone(a.sev))}`, chev: false })), 'Nothing open.')}</div>`;
  return U.page({ title: 'Charts & numbers',
    lede: `<span${I('C-013')}>${st.busy ? 'Counting…' : `${A.students.length} students · ${A.faculty.filter((f) => menteesOf(f.id).length).length} mentors with a group · Semester 3 · counted ${fmtDate(TODAY)} 09:00`}</span>`,
    acts: `${can('admin.exports') ? `<a class="btn" href="#/admin/exports"${I('C-014')}>${ic('download', 'sm')} Export</a>` : ''}${can('admin.imports') ? `<a class="btn primary" href="#/admin/imports"${I('C-015')}>${ic('upload', 'sm')} Import data</a>` : ''}`,
    body: `<div class="filters">${U.select('weeks', [[6, 'Last 6 weeks'], [12, 'Last 12 weeks'], [26, 'Last 26 weeks'], [52, 'Last 52 weeks']], w, I('C-016'), 'Period')}</div>
      ${kpis}
      ${U.section('Placement health · weekly', `<div class="card"><div class="filters">${U.select('who', opt(A.students.map((s) => [s.id, s.name]), 'Every student in reach'), who, I('C-022'), 'Drawn for')}</div>${chart}</div>`)}
      ${U.section('Mentor load', load, can('admin.mentors') ? `<a class="small" href="#/admin/mentors"${I('C-027')}>Open mentor mapping</a>` : '')}
      ${U.section('Alerts · open', alerts, `<button class="btn sm" type="button" data-act="rules"${I('C-030')}>${ic('settings', 'sm')} Rules</button>`)}` });
}, acts: {
  'change:weeks'(a, ev, st) { st.busy = true; rr(); setTimeout(() => { st.busy = false; rr(); }, 450); },
  rules: () => openRules(), page: pageAct, cv: (el) => fakeDownload(`${el.dataset.n.toLowerCase().replace(/\s+/g, '-')}-cv.pdf`),
} });

/* ================================================================ Leave requests */
Object.assign(A, {
  leave: [
    { id: 41, who: 'Dr. Meera Iyer', role: 'Faculty', dept: 'd1', kind: 'Casual', from: '2026-10-14', to: '2026-10-15', status: 'Awaiting', applied: '2026-10-06', reason: 'Family function in Udupi', covers: [{ date: '2026-10-14', who: 'Prof. Sameer Nadig', row: 'MBA 3A · 10:00 · Finance II', ok: true }, { date: '2026-10-15', who: 'Dr. Farah Khan', row: 'MBA 3B · 11:30 · Analytics Lab', ok: false }], papers: [] },
    { id: 44, who: 'Prof. Sameer Nadig', role: 'Faculty', dept: 'd1', kind: 'OOD', from: '2026-10-20', to: '2026-10-20', status: 'Awaiting', applied: '2026-10-05', reason: 'Industry visit with MBA 3B to the Peenya industrial area', covers: [{ date: '2026-10-20', who: 'Dr. Meera Iyer', row: 'MBA 3B · 09:00 · Marketing II', ok: true }], papers: [['visit-letter.pdf', '210 kB', 'Prof. Sameer Nadig', '2026-10-05']] },
    { id: 45, who: 'Aarav Kulkarni', role: 'Student', dept: 'd1', kind: 'Permission', from: '2026-10-09', to: '2026-10-09', status: 'Awaiting', applied: '2026-10-07', reason: 'Medical appointment, 2 hours in the afternoon', covers: [], papers: [['appointment.pdf', '88 kB', null, '2026-10-07']] },
    { id: 46, who: 'Dr. Farah Khan', role: 'Faculty', dept: 'd2', kind: 'Casual', from: '2026-10-23', to: '2026-10-24', status: 'Awaiting', legacy: true, applied: '2026-09-28', reason: 'Personal work', covers: [], papers: [], firstBy: 'Prof. Vinay Shenoy', firstAt: '2026-09-29 16:10' },
    { id: 47, who: 'Lavanya Gupta', role: 'Student', dept: null, kind: 'LOP', from: '2026-10-12', to: '2026-10-16', status: 'Awaiting', applied: '2026-10-04', reason: '', covers: [], papers: [] },
    { id: 33, who: 'Dr. Meera Iyer', role: 'Faculty', dept: 'd1', kind: 'OOD', from: '2026-09-10', to: '2026-09-10', status: 'Sanctioned', applied: '2026-09-02', reason: 'Industry visit, Peenya', covers: [], papers: [['visit-letter.pdf', '210 kB', 'Dr. Meera Iyer', '2026-09-02']], remarks: 'Approved.', by: 'Placement Office', at: '2026-09-03 10:20', signedAs: 'Main Admin' },
    { id: 30, who: 'Prof. Anil Kamath', role: 'Faculty', dept: 'd3', kind: 'RH', from: '2026-09-17', to: '2026-09-17', status: 'Sanctioned', applied: '2026-09-10', reason: 'Restricted holiday', covers: [], papers: [], remarks: '', by: 'Placement Office', at: '2026-09-11 09:02', signedAs: null },
    { id: 29, who: 'Dr. Meera Iyer', role: 'Faculty', dept: 'd1', kind: 'Permission', from: '2026-08-21', to: '2026-08-21', status: 'Not sanctioned', applied: '2026-08-20', reason: 'Bank work, 2 hours', covers: [], papers: [], remarks: 'Clashes with the internal assessment.', by: 'Placement Office', at: '2026-08-20 15:45', signedAs: 'Main Admin' },
    { id: 27, who: 'Ananya Rao', role: 'Student', dept: 'd1', kind: 'Casual', from: '2026-08-11', to: '2026-08-12', status: 'Withdrawn', applied: '2026-08-05', reason: 'Cousin’s wedding', covers: [], papers: [] },
  ],
  allow: [
    { id: 1, who: 'Dr. Meera Iyer', role: 'Faculty', dept: 'd1', kind: 'Casual', year: '2026-27', ent: 12, taken: 4 },
    { id: 2, who: 'Dr. Meera Iyer', role: 'Faculty', dept: 'd1', kind: 'OOD', year: '2026-27', ent: 10, taken: 3 },
    { id: 3, who: 'Prof. Sameer Nadig', role: 'Faculty', dept: 'd1', kind: 'OOD', year: '2026-27', ent: 10, taken: 11 },
    { id: 4, who: 'Prof. Sameer Nadig', role: 'Faculty', dept: 'd1', kind: 'Casual', year: '2026-27', ent: 12, taken: 2 },
    { id: 5, who: 'Aarav Kulkarni', role: 'Student', dept: 'd1', kind: 'Permission', year: '2026-27', ent: 6, taken: 1 },
  ],
  cal: { c1: [{ date: '2026-10-02', kind: 'holiday', label: 'Gandhi Jayanti' }, { date: '2026-10-17', kind: 'working', label: 'Saturday make-up day' }, { date: '2026-11-01', kind: 'holiday', label: 'Kannada Rajyotsava' }], c2: [], c3: [] },
});
const KINDS = [['Casual', 'Casual'], ['Permission', 'Permission'], ['OOD', 'OOD'], ['RH', 'RH'], ['LOP', 'LOP']];
const lvChip = (l) => (l.status === 'Awaiting' ? (l.legacy ? chip('Sanction pending', 'warn') : chip('Awaiting your decision', 'warn')) : l.status === 'Sanctioned' ? chip('Sanctioned', 'good') : l.status === 'Not sanctioned' ? chip('Not sanctioned', 'risk') : chip('Withdrawn', 'neutral'));
const lvTabOf = { pending: ['Awaiting'], approved: ['Sanctioned'], rejected: ['Not sanctioned'], cancelled: ['Withdrawn'] };
const visibleLeave = () => A.leave.filter((l) => !(App.role === 'faculty' && l.who === D.me.faculty.name));
const chainText = (l) => (l.status === 'Awaiting' ? 'Applied and signed → Sanction' : l.status === 'Withdrawn' ? 'Applied and signed → Withdrawn' : `Applied and signed → ${l.status === 'Sanctioned' ? 'Sanctioned' : 'Not sanctioned'}`);
function leaveDetail(l, st, inPane) {
  if (!l) return `<div class="card">${U.empty('cal', 'Pick a request')}</div>`;
  const al = A.allow.filter((a) => a.who === l.who && a.year === '2026-27');
  const own = App.role === 'faculty' && l.who === D.me.faculty.name;
  const rem = (st.remarks || {})[l.id] || '';
  const facts = `<div class="card"${I('C-047')}><div class="card-h"><h2>${esc(l.who)}</h2>${lvChip(l)}${inPane ? `<a class="icon-btn" href="#/admin/leave-approvals" data-act="closeLeave" aria-label="Close">${ic('x')}</a>` : ''}</div>
    ${kv([['Requester', `${esc(l.who)} · ${l.role}${l.dept ? ` · ${esc(dept(l.dept).name)}` : ' · Department not on record'}`], ['Type', `${l.kind} leave`], ['Dates', `${fmtDate(l.from)}${l.to !== l.from ? ` – ${fmtDate(l.to)}` : ''} · ${dayCount(l.from, l.to)} day${dayCount(l.from, l.to) > 1 ? 's' : ''}`], ['Status', lvChip(l)], ['Credit', l.kind === 'LOP' ? 'Loss of pay — no allowance used' : 'Counts against the allowance'], ['Alternate arrangement', l.covers.length ? `${l.covers.length} class${l.covers.length > 1 ? 'es' : ''} covered` : l.role === 'Student' ? 'Not stated' : 'Nobody named']])}</div>`;
  const covers = `<div class="list"${I('C-048')}>${listOr(l.covers.map((c) => U.row({ title: esc(c.row), sub: `${fmtShort(c.date)} · ${esc(c.who)}`, trail: c.ok ? chip('Accepted', 'good') : chip('Asked · no reply yet', 'warn'), chev: false })), 'No class to cover.')}</div>`;
  const allowance = `<div class="list"${I('C-049')}>${listOr(al.map((a) => { const left = a.ent - a.taken; return U.row({ title: `${a.kind}`, sub: `${a.taken} of ${a.ent} taken`, trail: chip(`${left} left`, left < 0 ? 'risk' : left <= 2 ? 'warn' : 'good'), chev: false }); }), 'No allowance recorded for this person this year — not measured, which is not a balance of zero.')}</div>`;
  const papers = `<div class="list"${I('C-050')}>${listOr(l.papers.map(([n, sz, by, d]) => U.row({ title: esc(n), sub: `${sz} · ${by ? esc(by) : 'account removed'} · ${fmtDate(d)}`, lead: U.lead('file'), act: 'paper', data: ` data-n="${esc(n)}"`, trail: ic('download', 'sm'), chev: false })), 'Nothing was attached.')}</div>`;
  const words = `<div class="card flat"${I('C-051')}><h3>Reason · visible to approvers only</h3><p class="small" style="margin-top:4px">${l.reason ? esc(l.reason) : '<span class="muted">Not stated</span>'}</p>${l.remarks ? `<h3 style="margin-top:12px">${l.status === 'Sanctioned' ? 'Sanctioned' : 'Not sanctioned'} — remarks</h3><p class="small" style="margin-top:4px">${esc(l.remarks)}</p>` : ''}</div>`;
  const chain = `<div class="card flat"${I('C-052')}><div class="stage"><div class="on"><b>Applied and signed</b>${esc(l.who)} · ${fmtShort(l.applied)}</div>${l.legacy ? `<div class="on"><b>First signature</b>${esc(l.firstBy)} · ${esc(l.firstAt)}</div>` : ''}<div class="${l.status === 'Awaiting' ? '' : 'on'}"><b>${l.status === 'Awaiting' ? 'Sanction' : l.status}</b>${l.by ? `${esc(l.by)} · ${esc(l.at)}` : l.status === 'Withdrawn' ? 'By the applicant' : 'One signature decides it'}</div></div>${l.by && !l.signedAs ? '<p class="xs muted" style="margin-top:6px">No signing role was recorded.</p>' : l.signedAs ? `<p class="xs muted" style="margin-top:6px">Signed as ${esc(l.signedAs)}</p>` : ''}</div>`;
  let decide = '';
  if (l.status === 'Awaiting' && !own) {
    const c = st.confirm && st.confirm.id === l.id ? st.confirm.kind : '';
    decide = `<div class="card"><div class="field"${I('C-053')}><label for="remarks-${l.id}">Remarks${c === 'reject' ? ' <span class="req">*</span>' : ''}</label><textarea class="input" id="remarks-${l.id}" data-act-input="x" data-f="remarks" data-id="${l.id}"${st.remErr === l.id ? ' aria-invalid="true"' : ''} placeholder="Optional on Sanction, required on Reject">${esc(rem)}</textarea><div class="err" role="alert">${st.remErr === l.id ? 'Remarks are required.' : ''}</div></div>
      ${c === 'sanction' ? `<p class="small muted" style="margin:8px 0">Your name, the time and your signature image print in the PROGRAM DIRECTOR block.</p>` : ''}
      <div class="hrow" style="margin-top:8px">${c === 'sanction' ? `<button class="btn primary" type="button" data-act="lvDo" data-id="${l.id}" data-k="sanction"${I('C-054')}>Confirm sanction</button><button class="btn" type="button" data-act="lvCancel">Cancel</button>`
        : c === 'reject' ? `<button class="btn danger solid" type="button" data-act="lvDo" data-id="${l.id}" data-k="reject"${I('C-055')}>Confirm reject</button><button class="btn" type="button" data-act="lvCancel">Cancel</button>`
          : `<button class="btn primary" type="button" data-act="lvAsk" data-id="${l.id}" data-k="sanction"${I('C-054')}>Sanction</button><button class="btn danger" type="button" data-act="lvAsk" data-id="${l.id}" data-k="reject"${I('C-055')}>Reject</button>`}</div></div>`;
  } else if (own) decide = `<div class="banner info">${ic('info')}<div>You cannot decide your own request.</div></div>`;
  const pdf = `<button class="btn" type="button" data-act="lvPdf" data-id="${l.id}"${I('C-056')}>${ic('download', 'sm')} ${l.status === 'Sanctioned' ? 'Open the signed form (PDF)' : 'PDF'}</button>`;
  return `<div class="stack">${facts}${decide}${U.section('Approval chain', chain, pdf).replace('class="section"', 'class="section" style="margin-top:0"')}${U.section('Classes covered', covers)}${U.section('Allowance · 2026-27', allowance)}${U.section('Attached papers', papers)}${words}</div>`;
}
function polBody(f) {
  const rows = A.allow.filter((a) => a.year === f.year && (!f.kind || a.kind === f.kind) && (!f.dept || a.dept === f.dept));
  const people = new Set(A.allow.filter((a) => a.year === f.year).map((a) => a.who));
  return `<div class="stack"><div class="form-grid"${I('C-058')}>${U.field({ id: 'py', label: 'Academic year', value: f.year, hint: /^\d{4}-\d{2}$/.test(f.year) ? '' : 'Write it as REEP does (2026-27), or the allowance will never be found.' })}${U.field({ id: 'pk', label: 'Type', value: f.kind, opts: opt(KINDS, 'Every type') })}${U.field({ id: 'pd', label: 'Department', value: f.dept, opts: opt(A.depts.map((d) => [d.id, `${college(d.college).code} · ${d.name}`]), 'Every department') })}<div class="field"><label>&nbsp;</label><button class="btn" type="button" data-act="show">Show</button></div></div>
    <div class="a1-kpis"${I('C-059')}>${U.kpi(A.allow.filter((a) => a.year === f.year).length, 'allowances recorded')}${U.kpi(people.size, 'people covered')}${U.kpi(KINDS.length, 'printed options')}${U.kpi(A.colleges.map((c) => (A.cal[c.id] || []).filter((d) => d.kind === 'holiday').length).join(' · '), 'holidays per college')}</div>
    <div class="card flat"${I('C-060')}><h3 style="margin-bottom:8px">Record one allowance for a department</h3><div class="form-grid">${U.field({ id: 'nd', label: 'Department', req: true, opts: opt(A.depts.map((d) => [d.id, `${college(d.college).code} · ${d.name}`]), 'Choose') })}${U.field({ id: 'nk', label: 'Type', opts: KINDS })}${U.field({ id: 'nn', label: 'Days', type: 'number', value: '12', attrs: ' min="0" max="365"' })}</div>
      <div class="hrow"><label class="check"><input type="checkbox" name="nf" checked><span>Faculty</span></label><label class="check"><input type="checkbox" name="ns"><span>Students</span></label><span class="grow"></span><button class="btn primary" type="button" data-act="record">Record</button></div><p class="xs muted">Existing allowances are left as they are.</p></div>
    ${rows.length ? `<div class="card tight"${I('C-061')}><table class="rtable"><thead><tr><th>Person</th><th>Type</th><th class="r">Entitled</th><th class="r">Taken</th><th class="r">Left</th><th></th></tr></thead><tbody>${rows.map((a) => `<tr><td class="lead-cell" data-l="Person">${esc(a.who)}</td><td data-l="Type">${a.kind}</td><td data-l="Entitled" class="r"><input class="input a1-num" type="number" min="0" value="${a.ent}" data-row="${a.id}" data-k="ent" aria-label="Entitled days"></td><td data-l="Taken" class="r"><input class="input a1-num" type="number" min="0" value="${a.taken}" data-row="${a.id}" data-k="taken" aria-label="Days taken"></td><td data-l="Left" class="r">${chip(String(a.ent - a.taken), a.ent - a.taken < 0 ? 'risk' : 'neutral')}</td><td data-l="" class="r"><span class="hrow" style="justify-content:flex-end"><button class="btn sm" type="button" data-act="saveRow" data-id="${a.id}" disabled${I('C-062')}>Save</button><button class="icon-btn" type="button" data-act="delRow" data-id="${a.id}" aria-label="Remove allowance"${I('C-063')}>${ic('trash')}</button></span></td></tr>`).join('')}</tbody></table><div class="err" role="alert" data-err="rows" style="padding:0 12px 10px"></div></div>` : `<div class="card"${I('C-061')}>${U.empty('cal', 'No allowance matches.')}</div>`}</div>`;
}
function openPolicy() {
  const f = { year: '2026-27', kind: '', dept: '' };
  const el = Sheet.open({ title: 'Leave policy', wide: true, body: polBody(f), foot: '<button class="btn" type="button" data-sheet-close>Close</button>', onAct: {
    show: (a, ev, sh) => { const v = formVals(sh); Object.assign(f, { year: v.py, kind: v.pk, dept: v.pd }); sh.querySelector('.sh-b').innerHTML = polBody(f); },
    record: (a, ev, sh) => { const v = formVals(sh); const e = {}; if (!v.nd) e.nd = 'Choose a department.'; if (!/^\d+$/.test(v.nn) || +v.nn > 365) e.nn = 'Days must be a whole number from 0 to 365.'; if (!v.nf && !v.ns) e.nd = e.nd || 'Tick Faculty, Students or both.'; if (!errs(sh, e)) return;
      const ppl = [...(v.nf ? A.faculty.filter((x) => x.dept === v.nd).map((x) => [x.name, 'Faculty']) : []), ...(v.ns ? A.students.filter((x) => x.dept === v.nd).map((x) => [x.name, 'Student']) : [])];
      let n = 0; ppl.forEach(([who, role]) => { if (A.allow.some((a) => a.who === who && a.kind === v.nk && a.year === f.year)) return; A.allow.push({ id: Date.now() + n, who, role, dept: v.nd, kind: v.nk, year: f.year, ent: +v.nn, taken: 0 }); n++; });
      sh.querySelector('.sh-b').innerHTML = polBody(f); toast(`${n} allowance${n === 1 ? '' : 's'} recorded; ${ppl.length - n} already there.`); },
    saveRow: (a, ev, sh) => { const r = A.allow.find((x) => x.id === +a.dataset.id); const ins = sh.querySelectorAll(`[data-row="${r.id}"]`); const vals = {}; ins.forEach((i) => { vals[i.dataset.k] = i.value; });
      if (!/^\d+$/.test(vals.ent) || !/^\d+$/.test(vals.taken)) { sh.querySelector('[data-err="rows"]').textContent = 'Days must be whole numbers, and neither can be negative.'; return; }
      r.ent = +vals.ent; r.taken = +vals.taken; sh.querySelector('.sh-b').innerHTML = polBody(f); toast(`Saved ${r.who} · ${r.kind}`); },
    delRow: (a, ev, sh) => { const r = A.allow.find((x) => x.id === +a.dataset.id); Sheet.confirm({ title: 'Remove this allowance?', text: `Removing is not the same as zero: with no row, REEP stops checking ${esc(r.who)}’s ${r.kind} balance. A zero would refuse every ${r.kind} request.`, ok: 'Remove', danger: true, onOk: () => { A.allow.splice(A.allow.indexOf(r), 1); sh.querySelector('.sh-b').innerHTML = polBody(f); } }); },
  } });
  el.addEventListener('input', (ev) => { const r = ev.target.dataset.row; if (r) { const b = el.querySelector(`[data-act="saveRow"][data-id="${r}"]`); if (b) b.disabled = false; } });
}
function calBody(cid) {
  const daysR = (A.cal[cid] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  return `<div class="stack">${U.field({ id: 'cc', label: 'College', value: cid, opts: A.colleges.map((c) => [c.id, `${c.code} · ${c.name}`]), inv: I('C-064'), attrs: ' data-act-change="x" data-f="cc"' })}
    <div class="card flat"${I('C-065')}><h3 style="margin-bottom:8px">Record a day</h3><div class="form-grid">${U.field({ id: 'cd', label: 'Date', type: 'date', req: true })}${U.field({ id: 'cl', label: 'Label', ph: 'Republic Day' })}</div>
      <div class="field"><span class="lbl">The college is</span><div class="hrow"><label class="check"><input type="radio" name="ck" value="holiday" checked><span>Shut (holiday)</span></label><label class="check"><input type="radio" name="ck" value="working"><span>Open (working day)</span></label></div></div>
      <button class="btn primary" type="button" data-act="rec">Record</button><p class="xs muted" style="margin-top:6px">Only a day marked shut is subtracted from a leave span.</p></div>
    <div class="list"${I('C-066')}>${listOr(daysR.map((d) => U.row({ title: `${fmtDate(d.date)}${d.label ? ` · ${esc(d.label)}` : ''}`, trail: `${d.kind === 'holiday' ? chip('Shut · not counted', 'warn') : chip('Open · counted', 'good')}<button class="icon-btn" type="button" data-act="rm" data-d="${d.date}" aria-label="Remove ${fmtDate(d.date)}">${ic('trash')}</button>`, chev: false })), 'No day recorded — every day is counted as a working day.')}</div></div>`;
}
function openCalendar() {
  let cid = 'c1';
  Sheet.open({ title: 'Academic calendar', wide: true, body: calBody(cid), foot: '<button class="btn" type="button" data-sheet-close>Close</button>', onAct: {
    'change:cc': (a, ev, sh) => { cid = a.value; sh.querySelector('.sh-b').innerHTML = calBody(cid); },
    rec: (a, ev, sh) => { const v = formVals(sh); if (!errs(sh, v.cd ? {} : { cd: 'Pick a date.' })) return; const list = (A.cal[cid] ||= []); const ex = list.find((d) => d.date === v.cd); if (ex) Object.assign(ex, { kind: v.ck, label: v.cl }); else list.push({ date: v.cd, kind: v.ck, label: v.cl }); sh.querySelector('.sh-b').innerHTML = calBody(cid); toast(`${fmtDate(v.cd)} recorded`); },
    rm: (a, ev, sh) => Sheet.confirm({ title: 'Remove this day?', text: `Remove ${fmtDate(a.dataset.d)} from the calendar?`, ok: 'Remove', danger: true, onOk: () => { A.cal[cid] = A.cal[cid].filter((d) => d.date !== a.dataset.d); sh.querySelector('.sh-b').innerHTML = calBody(cid); } }),
  } });
}
R.screen('admin/leave-approvals', { title: 'Leave requests', states: ids(I('C-057')), render({ id, st }) {
  const admin = App.role === 'admin';
  const all = visibleLeave();
  if (id && !wide()) { const l = all.find((x) => String(x.id) === id); return U.page({ title: l ? `${l.who} · ${l.kind}` : 'Leave request', back: true, body: flashBar(st, I('C-057')) + leaveDetail(l, st, false) }); }
  const tab = st.tab || 'pending';
  const counts = Object.fromEntries(Object.entries(lvTabOf).map(([k, v]) => [k, all.filter((l) => v.includes(l.status)).length]));
  let rows = all.filter((l) => lvTabOf[tab].includes(l.status));
  if (st.dept) rows = rows.filter((l) => (st.dept === 'none' ? !l.dept : l.dept === st.dept));
  if (st.kind) rows = rows.filter((l) => l.kind === st.kind);
  const sel = id || st.sel;
  const selRow = sel === 'none' ? null : all.find((x) => String(x.id) === String(sel)) || (wide() ? rows[0] : null);
  const list = `<div class="list"${I('C-044')}>${listOr(rows.map((l) => U.row({ title: esc(l.who), sub: `${l.kind} · ${fmtShort(l.from)}${l.to !== l.from ? `–${fmtShort(l.to)}` : ''} · ${dayCount(l.from, l.to)} day${dayCount(l.from, l.to) > 1 ? 's' : ''} · ${chainText(l)}`, lead: U.av(l.who), trail: lvChip(l), href: `#/admin/leave-approvals/${l.id}`, sel: selRow && selRow.id === l.id })), tab === 'pending' ? 'Nothing waiting for a decision.' : 'Nothing here.')}</div>
    <p class="xs muted" style="margin-top:8px"${I('C-045')}>Rows ${rows.length} · Selected: ${selRow ? esc(selRow.who) : 'none'}${tab !== 'pending' ? ' · Showing the most recent 50 decided requests' : ''}</p>`;
  const policy = `<div class="card"${I('C-046')}><div class="card-h"><h2>Leave policy</h2>${admin ? `<button class="btn sm" type="button" data-act="policy">Edit</button>` : ''}</div><p class="small">One signature decides a request: the Main Admin’s${App.role === 'faculty' ? ', or yours as the office’s delegate' : ' or a faculty member the office has granted “Approve leave”'}. Allowances are recorded per person, per printed option, per academic year. Refusing a request needs remarks.</p></div>`;
  return U.page({ title: 'Leave requests', lede: `<span class="chip info plain"${I('C-041')}>Reach · every college</span>`,
    acts: admin ? `<button class="btn" type="button" data-act="policy"${I('C-038')}>${ic('settings', 'sm')} Leave policy</button><button class="btn" type="button" data-act="calendar"${I('C-039')}>${ic('cal', 'sm')} Calendar</button>` : '',
    body: `${flashBar(st, I('C-057'))}${U.tabs('tab', [['pending', `Pending · ${counts.pending}`], ['approved', `Approved · ${counts.approved}`], ['rejected', `Rejected · ${counts.rejected}`], ['cancelled', `Cancelled · ${counts.cancelled}`]], tab, I('C-040'))}
      <div class="filters">${U.select('dept', [['', 'All departments'], ...A.depts.map((d) => [d.id, `${college(d.college).code} · ${d.name}`]), ['none', 'Not on record']], st.dept || '', I('C-042'), 'Department')}${U.select('kind', opt(KINDS, 'Every type'), st.kind || '', I('C-043'), 'Type')}</div>
      <div class="split"><div class="stack">${list}${policy}</div><div class="detail-pane">${leaveDetail(selRow, st, true)}</div></div>` });
}, acts: {
  dismiss, policy: () => openPolicy(), calendar: () => openCalendar(),
  closeLeave(el, ev, st) { ev.preventDefault(); st.sel = 'none'; R.go('#/admin/leave-approvals'); },
  'input:remarks'(el, ev, st) { (st.remarks ||= {})[el.dataset.id] = el.value; },
  lvAsk(el, ev, st) { st.confirm = { id: +el.dataset.id, kind: el.dataset.k }; st.remErr = null; rr(); },
  lvCancel(el, ev, st) { st.confirm = null; st.remErr = null; rr(); },
  lvDo(el, ev, st) {
    const l = A.leave.find((x) => x.id === +el.dataset.id); const rem = ((st.remarks || {})[l.id] || '').trim();
    if (App.role === 'faculty' && l.who === D.me.faculty.name) { toast('You cannot decide your own request.', 'risk'); return; }
    if (el.dataset.k === 'reject' && !rem) { st.remErr = l.id; rr(); return; }
    const by = App.role === 'admin' ? 'Placement Office' : D.me.faculty.name;
    Object.assign(l, { status: el.dataset.k === 'sanction' ? 'Sanctioned' : 'Not sanctioned', remarks: rem, by, at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}`, signedAs: App.role === 'admin' ? 'Main Admin' : 'Delegate (Approve leave)' });
    const mine = D.leaves.find((x) => x.id === l.id); if (mine) Object.assign(mine, { status: l.status === 'Sanctioned' ? 'Approved' : 'Rejected', note: rem, decidedBy: by, decidedAt: l.at });
    st.confirm = null; st.remErr = null;
    say(st, l.status === 'Sanctioned' ? `Sanctioned and signed for ${l.who}.` : `Not sanctioned. ${l.who} reads your remarks.`); st.sel = l.id; rr();
  },
  lvPdf: (el) => fakeDownload(`leave-${el.dataset.id}.pdf`), paper: (el) => fakeDownload(el.dataset.n),
} });

/* ================================================================ New applications */
const ok = (t) => ['ok', t]; const warn = (t) => ['warn', t]; const block = (t) => ['blocked', t];
Object.assign(A, {
  regs: [
    { id: 101, name: 'Harsha Vardhan', email: '1nh25mba062@nhsm.edu.in', personal: 'harsha.v@gmail.com', usn: '1NH25MBA062', phone: '+91 98861 40217', linkedin: 'https://in.linkedin.com/in/harsha-vardhan', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp1', spec2: null, batch: 'b1', submitted: '2026-10-06 18:22', docs: ['cv', 'photo'], status: 'Pending review', rule: null,
      checks: [ok('nhsm.edu.in is a college domain'), ok('No account on this address'), ok('USN 1NH25MBA062 is free'), ok('USN matches the college pattern'), ok('CV and photo attached'), ok('No rule matched — waiting for review'), ok('Approving seats them in General MBA - Financial Analytics · 2025-27')] },
    { id: 102, name: 'Pooja Naik', email: 'pooja.naik@gmail.com', personal: 'pooja.naik@gmail.com', usn: '1NH25MBA063', phone: '+91 99001 23845', linkedin: 'https://www.linkedin.com/in/poojanaik', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp3', spec2: null, batch: 'b3', submitted: '2026-10-05 09:41', docs: ['cv', 'photo'], status: 'Pending review', rule: null,
      checks: [block('gmail.com is not a college domain — Approve refuses an off-domain address'), ok('No account on this address'), ok('USN 1NH25MBA063 is free'), ok('CV and photo attached'), ok('Approving seats them in General MBA - Marketing · 2025-27')] },
    { id: 103, name: 'Varun Shetty', email: '1nh25mba064@nhsm.edu.in', personal: 'varun.shetty@outlook.com', usn: '1NH25MBA064', phone: '+91 97411 55032', linkedin: 'https://www.linkedin.com/in/varun-shetty', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp1', spec2: 'sp2', batch: 'b1', submitted: '2026-10-03 21:07', docs: ['cv', 'photo'], status: 'Pending review', rule: null,
      checks: [ok('nhsm.edu.in is a college domain'), ok('No account on this address'), ok('USN 1NH25MBA064 is free'), warn('Applied before — rejected 1, last on 12 Sep'), warn('Opted for a dual specialization'), ok('CV and photo attached'), ok('Approving seats them in General MBA - Financial Analytics · 2025-27')], prior: 'USN did not match the VTU record' },
    { id: 104, name: 'Shruti Patil', email: '1nh25mba014@nhsm.edu.in', personal: 'shruti.patil@gmail.com', usn: '1NH25MBA014', phone: '+91 90080 77412', linkedin: 'https://www.linkedin.com/in/shrutipatil', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp2', spec2: null, batch: 'b2', submitted: '2026-09-29 12:15', docs: ['cv', 'photo'], status: 'Pending review', rule: null,
      checks: [ok('nhsm.edu.in is a college domain'), block('An account already uses 1nh25mba014@nhsm.edu.in'), block('USN 1NH25MBA014 already belongs to a student'), ok('CV and photo attached')] },
    { id: 105, name: 'Mohammed Irfan', email: 'irfan.m@kaveri-ib.edu.in', personal: 'irfan.m95@gmail.com', usn: '1KI26MBA014', phone: '+91 81230 66790', linkedin: '', college: 'c2', dept: 'd3', course: 'k4', spec: 'sp4', spec2: null, batch: 'b7', submitted: '2026-08-30 10:02', docs: [], status: 'Pending review', rule: 'KIB review all',
      checks: [warn('Kaveri Institute has not named its domains — the deployment list applies'), ok('No account on this address'), ok('USN 1KI26MBA014 is free'), warn('No CV or photo attached — written before files were required'), ok('Routed by rule “KIB review all”'), ok('Approving seats them in General MBA - Finance · 2026-28')] },
    { id: 106, name: 'Keerthana Reddy', email: '1nh25mba060@nhsm.edu.in', personal: 'keerthana.r@gmail.com', usn: '1NH25MBA060', phone: '+91 96320 14455', linkedin: 'https://www.linkedin.com/in/keerthana-reddy', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp1', spec2: null, batch: 'b1', submitted: '2026-10-04 08:30', docs: ['cv', 'photo'], status: 'Auto-approved', rule: 'NHM MBA 2025-27 auto-admit', checks: null },
    { id: 107, name: 'Rahul Desai', email: '1nh25mca015@nhsm.edu.in', personal: 'rahul.desai@yahoo.in', usn: '1NH25MCA015', phone: '+91 98450 99102', linkedin: 'https://www.linkedin.com/in/rahuldesai', college: 'c1', dept: 'd2', course: 'k3', spec: null, spec2: null, batch: 'b5', submitted: '2026-09-25 16:48', docs: ['cv', 'photo'], status: 'Held', rule: null, hold: { note: 'Waiting for a clearer scan of the UG marksheet', at: '2026-09-26 11:05' }, checks: [ok('nhsm.edu.in is a college domain'), ok('No account on this address'), ok('USN 1NH25MCA015 is free'), ok('CV and photo attached')] },
    { id: 108, name: 'Divya Menon', email: '1nh25mba070@nhsm.edu.in', personal: '', usn: '1NH25MBA070', phone: '+91 94480 30021', linkedin: '', college: 'c1', dept: 'd1', course: 'k1', spec: 'sp3', spec2: null, batch: 'b3', submitted: '2026-09-12 13:20', docs: ['cv'], status: 'Rejected', rule: null, reason: 'USN does not match the VTU record — please apply again with the correct USN.', checks: null },
  ],
  rules: [
    { id: 1, name: 'NHM MBA 2025-27 auto-admit', priority: 10, domain: 'nhsm.edu.in', degree: 'PG', usn: '^1NH25MBA[0-9]{3}$', batch: 'b1', auto: true, enabled: true, matches: 14 },
    { id: 2, name: 'KIB review all', priority: 20, domain: '', degree: 'any', usn: '', batch: 'b7', auto: false, enabled: true, matches: 3 },
    { id: 3, name: 'MCA lateral entry', priority: 30, domain: 'nhsm.edu.in', degree: 'PG', usn: '^1NH25MCA4[0-9]{2}$', batch: 'b5', auto: true, enabled: false, matches: 0 },
  ],
});
const REG_TABS = { pending: 'Pending review', auto: 'Auto-approved', held: 'Held', rejected: 'Rejected' };
const REG_COLS = [['usn', 'USN'], ['domain', 'Email domain'], ['submitted', 'Submitted'], ['docs', 'Documents'], ['rule', 'Rule']];
const onDomain = (r) => { const c = college(r.college); const d = r.email.split('@')[1]; return c.domains.length ? c.domains.includes(d) : !/gmail|yahoo|outlook|hotmail/.test(d); };
const docsChip = (r) => (r.docs.length === 2 ? chip('CV and photo', 'good') : r.docs.length ? chip(`${r.docs.includes('cv') ? 'CV' : 'Photo'} only`, 'warn') : chip('No documents', 'warn'));
const specWords = (r) => [spec(r.spec), spec(r.spec2)].filter(Boolean).map((s) => s.name).join(' and ') || 'Not named';
const blocked = (r) => (r.checks || []).some((c) => c[0] === 'blocked');
function regFiltered(st) {
  const tab = st.tab || 'pending'; const q = (st.q || '').toLowerCase();
  return A.regs.filter((r) => r.status === REG_TABS[tab]).filter((r) => (!st.col || r.college === st.col) && (!st.bat || r.batch === st.bat) && (!st.dom || (st.dom === 'on') === onDomain(r)) && (!st.days || ago(r.submitted) <= +st.days) && (!q || `${r.name} ${r.email} ${r.usn}`.toLowerCase().includes(q)));
}
function regDetail(r, st) {
  if (!r) return `<div class="card">${U.empty('inbox', 'Pick an application')}</div>`;
  const pend = r.status === 'Pending review';
  const facts = `<div class="card"${I('C-082')}><div class="card-h"><h2>${esc(r.name)}</h2>${chip(r.status, r.status === 'Pending review' ? 'warn' : r.status === 'Rejected' ? 'risk' : r.status === 'Held' ? 'info' : 'good')}</div>
    ${kv([['Batch', esc(batchLabel(batch(r.batch)))], ['Specialization', esc(specWords(r))], ['College', esc(college(r.college).name)], ['Department', r.dept ? esc(dept(r.dept).name) : 'Not on record'], ['USN', esc(r.usn)], ['Phone', esc(r.phone) || 'Not on record'], ['College email', esc(r.email)], ['Personal email', r.personal ? esc(r.personal) : 'Not on record'], ['LinkedIn', r.linkedin ? `<a href="${esc(r.linkedin)}" target="_blank" rel="noopener">Open profile</a>` : 'Not on record'], ['Documents', docsChip(r)]])}
    <div class="hrow" style="margin-top:12px">${r.docs.includes('cv') ? `<button class="btn sm" type="button" data-act="doc" data-n="${r.usn}-cv.pdf"${I('C-083')}>${ic('download', 'sm')} Open CV</button>` : ''}${r.docs.includes('photo') ? `<button class="btn sm" type="button" data-act="doc" data-n="${r.usn}-photo.jpg"${I('C-083')}>${ic('download', 'sm')} Open photo</button>` : ''}</div></div>`;
  const hold = r.hold && r.status === 'Held' ? `<div class="banner info"${I('C-084')}>${ic('clock')}<div><b>On hold</b> since ${esc(r.hold.at)} — ${esc(r.hold.note)}<br><span class="xs">Staff-only note. Nothing was emailed to the applicant.</span></div></div>` : '';
  const checks = r.checks ? `<div class="list"${I('C-085')}>${r.checks.map(([v, t]) => U.row({ title: esc(t), lead: U.lead(v === 'ok' ? 'check' : v === 'warn' ? 'alert' : 'x'), trail: chip(v === 'ok' ? 'OK' : v === 'warn' ? 'Check' : 'Blocks approval', v === 'ok' ? 'good' : v === 'warn' ? 'warn' : 'risk'), chev: false })).join('')}</div>${r.prior ? `<p class="xs muted" style="margin-top:6px">Reason given last time: ${esc(r.prior)}</p>` : ''}${blocked(r) && pend ? `<div class="banner risk" style="margin-top:8px"${I('C-086')}>${ic('alert')}<div>Approve will refuse this application while the lines marked above stand.</div></div>` : ''}`
    : `<div class="card flat"${I('C-085')}><p class="small muted">No checklist — this application has been decided.</p>${r.reason ? `<p class="small" style="margin-top:6px">Reason sent: ${esc(r.reason)}</p>` : ''}</div>`;
  const decide = pend ? decisionBox(st, [r.id], `${r.id}`) : r.status === 'Held' ? `<button class="btn" type="button" data-act="regBack" data-ids="${r.id}"${I('C-076')}>Release hold</button>` : r.status === 'Rejected' ? `<button class="btn" type="button" data-act="regBack" data-ids="${r.id}"${I('C-076')}>Reopen</button>` : '';
  return `<div class="stack">${facts}${hold}${U.section('Checks', checks).replace('class="section"', 'class="section" style="margin-top:0"')}${decide}</div>`;
}
function decisionBox(st, idsArr, key) {
  const n = idsArr.length; const e = st.noteErr && st.noteErr.key === key ? st.noteErr.msg : '';
  return `<div class="card"><div class="field"${I('C-088')}><label for="note-${key}">Decision note</label><textarea class="input" id="note-${key}" data-act-input="x" data-f="note" data-k="${key}"${n ? '' : ' disabled'}${e ? ' aria-invalid="true"' : ''} placeholder="Required to reject or hold. Kept with the decision.">${esc((st.notes || {})[key] || '')}</textarea><div class="err" role="alert">${esc(e)}</div></div>
    <div class="hrow"><button class="btn primary" type="button" data-act="regDo" data-k="approve" data-ids="${idsArr.join(',')}" data-key="${key}"${n ? '' : ' disabled'}${I('C-089')}>${n > 1 ? `Approve & invite ${n}` : 'Approve & invite'}</button><button class="btn" type="button" data-act="regDo" data-k="hold" data-ids="${idsArr.join(',')}" data-key="${key}"${n ? '' : ' disabled'}${I('C-091')}>Hold</button><button class="btn danger" type="button" data-act="regDo" data-k="reject" data-ids="${idsArr.join(',')}" data-key="${key}"${n ? '' : ' disabled'}${I('C-090')}>Reject</button></div></div>`;
}
function ruleRows() {
  const sorted = A.rules.slice().sort((a, b) => a.priority - b.priority || a.id - b.id);
  return `<div class="stack"><div class="hrow"><p class="small muted grow">Lowest priority wins; a tie goes to the older rule.</p><button class="btn primary sm" type="button" data-act="new"${I('C-097')}>${ic('plus', 'sm')} New rule</button></div>
    <div class="list"${I('C-093')}>${listOr(sorted.map((r) => `<div class="row"><span class="lead"><b class="num">${r.priority}</b></span><div class="body"><div class="ttl">${esc(r.name)} ${r.enabled ? '' : chip('Off', 'neutral')}</div><div class="sub">Matches ${[r.domain && `@${esc(r.domain)}`, r.degree !== 'any' && `${r.degree} only`, r.usn && `USN ${esc(r.usn)}`].filter(Boolean).join(' · ') || 'every application'} · Seats in ${esc(batchLabel(batch(r.batch)))} · ${r.matches} routed</div><div style="margin-top:4px">${r.auto ? chip('Auto-approves', 'good') : chip('Waits for review', 'info')}</div></div>
      <div class="trail"><button class="icon-btn" type="button" data-act="edit" data-id="${r.id}" aria-label="Edit ${esc(r.name)}"${I('C-094')}>${ic('pen')}</button><button class="btn sm" type="button" data-act="toggle" data-id="${r.id}"${I('C-095')}>${r.enabled ? 'Disable' : 'Enable'}</button><button class="icon-btn" type="button" data-act="del" data-id="${r.id}" aria-label="Delete ${esc(r.name)}"${I('C-096')}>${ic('trash')}</button></div></div>`), 'No rule yet — every application waits for review.')}</div></div>`;
}
function ruleForm(r) {
  r = r || { name: '', priority: '', domain: '', degree: 'any', usn: '', batch: '', auto: false, enabled: true };
  return `<div class="stack"${I('C-098')}>${U.field({ id: 'rn', label: 'Name', req: true, value: r.name, ph: 'MBA 2026-28 auto-admit' })}<div class="form-grid">${U.field({ id: 'rp', label: 'Priority', req: true, type: 'number', value: r.priority, hint: 'Lowest wins.' })}${U.field({ id: 'rd', label: 'Email domain', value: r.domain, ph: 'nhsm.edu.in' })}${U.field({ id: 'rg', label: 'Degree level', value: r.degree, opts: [['any', 'Any'], ['UG', 'UG only'], ['PG', 'PG only']] })}${U.field({ id: 'ru', label: 'USN pattern', value: r.usn, ph: '^1NH25MBA[0-9]{3}$' })}${U.field({ id: 'rb2', label: 'Seats in', value: r.batch, opts: opt(batchOpts(), 'No batch') })}</div>
    <label class="check"${I('C-099')}><input type="checkbox" name="ra"${r.auto ? ' checked' : ''}><span>Auto-approve a matching application<br><span class="xs muted">Creates the login, seats them and emails the link with no human. Off-domain addresses still go to review.</span></span></label>
    <label class="check"${I('C-100')}><input type="checkbox" name="re"${r.enabled ? ' checked' : ''}><span>Enabled</span></label></div>`;
}
function openRegRules() {
  let editing = null; // null = list, 0 = new, id = edit
  const foot = () => (editing === null ? `<button class="btn" type="button" data-sheet-close${I('C-101')}>Close</button>` : `<button class="btn" type="button" data-act="cancel"${I('C-101')}>Cancel</button><button class="btn primary" type="button" data-act="save"${I('C-101')}>${editing ? 'Save rule' : 'Create rule'}</button>`);
  const paint = (sh) => { sh.querySelector('.sh-b').innerHTML = editing === null ? ruleRows() : ruleForm(A.rules.find((x) => x.id === editing)); sh.querySelector('.sh-f').innerHTML = foot(); };
  Sheet.open({ title: 'Auto-approve rules', wide: true, body: ruleRows(), foot: foot(), onClose: () => setTimeout(rr), onAct: {
    new: (a, ev, sh) => { editing = 0; paint(sh); }, edit: (a, ev, sh) => { editing = +a.dataset.id; paint(sh); }, cancel: (a, ev, sh) => { editing = null; paint(sh); },
    toggle: (a, ev, sh) => { const r = A.rules.find((x) => x.id === +a.dataset.id); r.enabled = !r.enabled; paint(sh); toast(r.enabled ? `${r.name} is evaluated again` : `${r.name} is off — it stays, and is never evaluated`); },
    del: (a, ev, sh) => { const r = A.rules.find((x) => x.id === +a.dataset.id); Sheet.confirm({ title: 'Delete this rule?', text: `${r.matches} routed application${r.matches === 1 ? '' : 's'} will lose the pointer to “${esc(r.name)}”. Disable keeps it instead.`, ok: 'Delete', danger: true, onOk: () => { A.rules.splice(A.rules.indexOf(r), 1); paint(sh); } }); },
    save: (a, ev, sh) => {
      const v = formVals(sh); const e = {};
      if (!v.rn) e.rn = 'Name is required.'; if (!/^\d+$/.test(v.rp)) e.rp = 'Priority must be a whole number, 0 or more.';
      if (v.ru) { try { new RegExp(v.ru); } catch (x) { e.ru = `That pattern does not read: ${x.message.replace(/^Invalid regular expression: /, '')}`; } }
      if (!errs(sh, e)) return;
      a.textContent = 'Saving…'; a.disabled = true;
      setTimeout(() => { const row = { name: v.rn, priority: +v.rp, domain: v.rd.replace(/^@/, '').toLowerCase(), degree: v.rg, usn: v.ru, batch: v.rb2, auto: v.ra, enabled: v.re };
        if (editing) Object.assign(A.rules.find((x) => x.id === editing), row); else A.rules.push({ id: Date.now(), matches: 0, ...row });
        editing = null; paint(sh); toast('Rule saved'); }, 350);
    },
  } });
}
R.screen('admin/registrations', { title: 'New applications', states: ids(I('C-092')), render({ id, st }) {
  const tab = st.tab || 'pending';
  if (id && !wide()) { const r = A.regs.find((x) => String(x.id) === id); return U.page({ title: r ? r.name : 'Application', back: true, body: flashBar(st, I('C-092')) + regDetail(r, st) }); }
  const rows = regFiltered(st);
  const pg = pager(st, rows.length, [10, 25, 50], I('C-079'));
  const picked = (st.picked || []).filter((x) => rows.some((r) => r.id === x));
  st.picked = picked;
  const hide = st.hide || {};
  const canTick = tab !== 'auto';
  const list = `<div class="list${st.compact ? ' a1-compact' : ''}"${I('C-074')}>${listOr(rows.slice(pg.from - 1, pg.to).map((r) => crow({ box: canTick ? ck('pick', r.id, picked.includes(r.id)) : '', href: `#/admin/registrations/${r.id}`, sel: String(st.sel || id) === String(r.id),
    title: esc(r.name), sub: [!hide.usn && esc(r.usn), !hide.domain && `<span class="${onDomain(r) ? '' : 'a1-risk'}">@${esc(r.email.split('@')[1])}${onDomain(r) ? '' : ' · off-domain'}</span>`, !hide.submitted && fmtShort(r.submitted.slice(0, 10)), !hide.rule && (r.rule ? `Rule: ${esc(r.rule)}` : '')].filter(Boolean).join(' · '),
    trail: hide.docs ? '' : docsChip(r) })), tab === 'pending' ? 'No application is waiting.' : 'Nothing here.')}</div>`;
  const bar = `<div class="hrow a1-bar">${tab === 'pending' ? `<button class="btn sm primary" type="button" data-act="bulk" data-k="approve"${picked.length ? '' : ' disabled'}${I('C-075')}>Approve</button><button class="btn sm" type="button" data-act="bulk" data-k="hold"${picked.length ? '' : ' disabled'}${I('C-075')}>Hold</button><button class="btn sm danger" type="button" data-act="bulk" data-k="reject"${picked.length ? '' : ' disabled'}${I('C-075')}>Reject</button>`
    : tab === 'held' ? `<button class="btn sm" type="button" data-act="regBack" data-ids="${picked.join(',')}"${picked.length ? '' : ' disabled'}${I('C-076')}>Release hold</button>` : tab === 'rejected' ? `<button class="btn sm" type="button" data-act="regBack" data-ids="${picked.join(',')}"${picked.length ? '' : ' disabled'}${I('C-076')}>Reopen</button>` : ''}
    <span class="grow"></span><button class="btn sm ghost" type="button" data-act="cols"${I('C-077')}>${ic('list', 'sm')} Columns</button><button class="btn sm ghost" type="button" data-act="compact" aria-pressed="${!!st.compact}"${I('C-078')}>Compact rows</button></div>`;
  const sel = id || st.sel; const selRow = A.regs.find((x) => String(x.id) === String(sel) && x.status === REG_TABS[tab]) || (wide() ? rows[0] : null);
  const multi = picked.length > 1 && tab === 'pending' ? `<div class="card"${I('C-087')}><div class="card-h"><h2>${picked.length} selected</h2></div><p class="small muted" style="margin-bottom:8px">One request per application; the note applies to every one.</p>${decisionBox(st, picked, 'multi')}</div>` : '';
  const autos = A.rules.filter((r) => r.enabled && r.auto).length;
  return U.page({ title: 'New applications', lede: `${A.regs.filter((r) => r.status === 'Pending review').length} waiting for review`,
    acts: `<button class="btn" type="button" data-act="export"${I('C-080')}>${ic('download', 'sm')} Export</button><button class="btn" type="button" data-act="regRules"${I('C-081')}>${ic('settings', 'sm')} Auto-approve rules</button>`,
    body: `${flashBar(st, I('C-092'))}${U.tabs('tab', [['pending', `Pending · ${A.regs.filter((r) => r.status === 'Pending review').length}`], ['auto', 'Auto-approved'], ['held', 'Held'], ['rejected', 'Rejected']], tab, I('C-067'))}
      <div class="filters">${U.search('q', st.q || '', 'Quick filter…', I('C-073'))}</div>
      <div class="filters">${U.select('col', opt(A.colleges.map((c) => [c.id, c.name]), 'All colleges'), st.col || '', I('C-068'), 'College')}${U.select('bat', opt(A.batches.map((b) => [b.id, batchLabel(b)]), 'All batches'), st.bat || '', I('C-069'), 'Batch')}${U.select('dom', [['', 'Any domain'], ['on', 'On a college domain'], ['off', 'Off-domain (Approve refuses)']], st.dom || '', I('C-070'), 'Domain check')}${U.select('days', [['', 'Any time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']], st.days || '', I('C-071'), 'Submitted')}</div>
      <p class="xs muted" style="margin:-4px 0 10px"${I('C-072')}>${autos ? `${autos} enabled rule${autos > 1 ? 's' : ''} auto-approve${autos > 1 ? '' : 's'} matching applications.` : 'No rule auto-approves — every application waits for review.'}</p>
      <div class="split"><div class="stack">${bar}${wide() ? '' : multi}${list}<p class="xs muted">Rows ${rows.length} · Selected ${picked.length}</p>${pg.html}</div><div class="detail-pane">${multi || regDetail(selRow, st)}</div></div>` });
}, acts: {
  dismiss, page: pageAct,
  'change:pick'(el, ev, st) { const v = +el.value; st.picked = el.checked ? [...new Set([...(st.picked || []), v])] : (st.picked || []).filter((x) => x !== v); rr(); },
  'input:note'(el, ev, st) { (st.notes ||= {})[el.dataset.k] = el.value; },
  compact(el, ev, st) { st.compact = !st.compact; rr(); },
  cols(el, ev, st) { chooseCols(st, REG_COLS); },
  regRules: () => openRegRules(),
  doc: (el) => fakeDownload(el.dataset.n),
  export(el, ev, st) { csv('reep-registrations.csv', [['Applicant', 'USN', 'Email', 'Submitted', 'Documents', 'Rule', 'Status'], ...regFiltered(st).map((r) => [r.name, r.usn, r.email, r.submitted, r.docs.join(' + ') || 'none', r.rule || '', r.status])]); },
  bulk(el, ev, st) {
    const k = el.dataset.k; const list = st.picked || [];
    if (k === 'approve') return regDecide(st, list, 'approve', '');
    Sheet.reason({ title: k === 'reject' ? `Reject ${list.length}` : `Hold ${list.length}`, label: 'Decision note', ok: k === 'reject' ? 'Reject' : 'Hold', danger: k === 'reject', inv: I('C-088'), onOk: (v) => regDecide(st, list, k, v) });
  },
  regDo(el, ev, st) {
    const k = el.dataset.k; const key = el.dataset.key; const note = ((st.notes || {})[key] || '').trim();
    if (k === 'reject' && !note) { st.noteErr = { key, msg: 'A reason is required when rejecting an application.' }; return rr(); }
    if (k === 'hold' && !note) { st.noteErr = { key, msg: 'Say what it is waiting on.' }; return rr(); }
    st.noteErr = null; regDecide(st, el.dataset.ids.split(',').map(Number), k, note); if (st.notes) delete st.notes[key];
  },
  regBack(el, ev, st) { const list = el.dataset.ids.split(',').filter(Boolean).map(Number); list.forEach((i) => { const r = A.regs.find((x) => x.id === i); r.status = 'Pending review'; r.hold = null; }); st.picked = []; say(st, `${list.length} application${list.length > 1 ? 's' : ''} back in Pending.`); rr(); },
  undoReject(el, ev, st) { say(st, 'Reopening…', 'info'); rr(); setTimeout(() => { (st.lastRejected || []).forEach((i) => { const r = A.regs.find((x) => x.id === i); r.status = 'Pending review'; r.reason = ''; }); say(st, `Reopened ${(st.lastRejected || []).length}. Back in Pending.`); st.lastRejected = []; rr(); }, 500); },
} });
function regDecide(st, list, k, note) {
  const regs = list.map((i) => A.regs.find((x) => x.id === i)).filter(Boolean);
  if (k === 'approve') {
    const refused = regs.filter(blocked); const okRegs = regs.filter((r) => !blocked(r));
    okRegs.forEach((r) => { r.status = 'Approved'; r.note = note; if (!A.students.some((s) => s.usn === r.usn)) A.students.push({ id: `s${Date.now()}${r.id}`, name: r.name, usn: r.usn, stage: 'Reboot', batch: r.batch, mentor: null, dept: r.dept, att: null, skills: 0, hours: null, cv: r.docs.includes('cv') }); });
    say(st, `${okRegs.length ? `Approved and invited ${okRegs.map((r) => r.name).join(', ')} — the setup link is on its way.` : ''}${refused.length ? ` ${refused.length} refused: Approve will refuse ${refused.map((r) => r.name).join(', ')} while the blocking checks stand.` : ''}`.trim(), refused.length ? 'risk' : 'good');
  } else if (k === 'reject') { regs.forEach((r) => { r.status = 'Rejected'; r.reason = note; r.checks = null; }); st.lastRejected = regs.map((r) => r.id); say(st, `Rejected ${regs.length}. The reason was emailed.`, 'good', 'undoReject'); }
  else { regs.forEach((r) => { r.status = 'Held'; r.hold = { note, at: `${TODAY} ${new Date().toTimeString().slice(0, 5)}` }; }); say(st, `Held ${regs.length}. Nothing was emailed.`); }
  st.picked = []; st.sel = null; if (R.parse().parts[2]) R.go('#/admin/registrations'); else rr();
}

/* ================================================================ Assign faculty */
const collegeOfStudent = (s) => (s.batch ? batch(s.batch).college : dept(s.dept) ? dept(s.dept).college : null);
function recordMentor(sid, fid, reason, endKind = 'Moved on') {
  const h = (A.mentorHist[sid] ||= []); const open = h.find((x) => !x.to);
  if (open && open.mentor === fid) return;
  if (open) Object.assign(open, { to: TODAY, end: fid ? endKind : 'Released', endBy: 'Placement Office', endReason: reason });
  if (fid) h.push({ mentor: fid, from: TODAY, to: null, kind: open ? 'Moved here' : 'Assigned', by: 'Placement Office', reason });
}
function openHistory(sid) {
  const s = stu(sid); const h = (A.mentorHist[sid] || []).slice().reverse();
  Sheet.open({ title: `Assignment history · ${s.name}`, body: `<div class="list"${I('C-120')}>${listOr(h.map((x) => U.row({ title: `${esc(fac(x.mentor).name)} ${x.to ? chip('Ended', 'neutral') : chip('Current', 'good')}`,
    sub: `${x.from ? fmtDate(x.from) : 'Since before this was recorded'} – ${x.to ? fmtDate(x.to) : 'now'}<br>${esc(x.kind)} by ${esc(x.by)}${x.reason ? ` · “${esc(x.reason)}”` : ''}${x.end ? `<br>${esc(x.end)} by ${esc(x.endBy)}${x.endReason ? ` · “${esc(x.endReason)}”` : ''}` : ''}`, lead: U.av(fac(x.mentor).name), chev: false })),
    s.mentor ? 'This pairing predates the history — nothing was recorded before it.' : 'Never assigned — this student is waiting to be seated with a faculty member.')}</div>`,
    foot: '<button class="btn" type="button" data-sheet-close>Close</button>' });
}
const assignWhy = (st) => (!st.fac ? 'Pick a faculty member first.' : !(st.pool || []).length ? 'Tick at least one student.' : !(st.reason || '').trim() ? 'Give a reason.' : '');
function syncAssign(st) {
  const b = document.querySelector('[data-act="assign"]'); const why = assignWhy(st); if (!b) return;
  b.disabled = !!why; const h = document.querySelector('[data-why]'); if (h) h.textContent = why;
}
R.screen('admin/mentors', { title: 'Assign faculty', states: ids(I('C-109', 'C-119')), render({ st }) {
  const facs = A.faculty.filter((f) => !st.dept || f.dept === st.dept);
  const studs = A.students.filter((s) => (!st.dept || s.dept === st.dept) && (!st.bat || s.batch === st.bat));
  const pool = studs.filter((s) => !s.mentor);
  const q = (st.q || '').toLowerCase(); const shown = pool.filter((s) => !q || `${s.name} ${s.usn}`.toLowerCase().includes(q));
  st.pool = (st.pool || []).filter((x) => pool.some((s) => s.id === x));
  const f = st.fac && fac(st.fac);
  const narrowed = st.dept || st.bat;
  const head = pool.length ? `${pool.length} student${pool.length > 1 ? 's have' : ' has'} no faculty member${narrowed ? ' in this view' : ''}` : `Every student${narrowed ? ' in this view' : ''} has a faculty member.`;
  const rail = `<div class="list"${I('C-110')}>${listOr(facs.map((x) => { const n = menteesOf(x.id).length; const cap = capOf(x);
    return `<button class="row${st.fac === x.id ? ' sel' : ''}" type="button" data-act="pickFac" data-id="${x.id}" aria-pressed="${st.fac === x.id}"${I('C-111')}>${U.av(x.name)}<div class="body"><div class="ttl">${esc(x.name)}</div><div class="sub">${esc(dept(x.dept).name)} · ${n ? `${n} of ${cap} · ${capSource(x)}` : 'Becomes a mentor on first assignment'}</div>${U.meter(Math.round((n / cap) * 100), n >= cap ? 'warn' : 'good')}</div><div class="trail">${n >= cap ? chip('At capacity', 'warn') : `<span class="num small">${n}/${cap}</span>`}</div></button>`; }), 'No faculty account under this department.')}</div>`;
  const mine = f ? menteesOf(f.id).filter((s) => !st.bat || s.batch === st.bat) : [];
  const mentees = f ? U.section(st.bat ? 'Mentees in this batch' : 'Current mentees', `<div class="list"${I('C-112')}>${listOr(mine.map((s) => `<div class="row">${U.av(s.name)}<div class="body"><div class="ttl">${esc(s.name)} ${s.dept !== f.dept ? chip('Different department', 'warn') : ''}</div><div class="sub">${esc(s.usn)} · ${esc(batchLabel(batch(s.batch)))} · attendance ${s.att == null ? '—' : `${s.att}%`} · ${s.skills} skills</div></div><div class="trail"><button class="icon-btn" type="button" data-act="hist" data-id="${s.id}" aria-label="Assignment history for ${esc(s.name)}"${I('C-113')}>${ic('restore')}</button><button class="icon-btn" type="button" data-act="release" data-id="${s.id}" aria-label="Release ${esc(s.name)}"${I('C-114')}>${ic('minus')}</button></div></div>`), 'No mentees yet — add students from the pool.')}</div>`) : '';
  const poolList = `<div class="filters">${U.search('q', st.q || '', 'Search students…', I('C-116'))}</div>
    <div class="list"${I('C-115')}>${listOr(shown.map((s) => crow({ box: ck('pool', s.id, st.pool.includes(s.id)), title: esc(s.name), sub: `${esc(s.usn)} · ${esc(batchLabel(batch(s.batch)))}`, trail: `${stageChip(s.stage)}<button class="icon-btn" type="button" data-act="hist" data-id="${s.id}" aria-label="Assignment history for ${esc(s.name)}">${ic('restore')}</button>` })), q ? `No student matches “${esc(st.q)}”.` : 'Nobody is waiting.')}</div>
    <p class="xs muted" style="margin-top:6px">${pool.length} without a mentor · ${st.pool.length} selected</p>`;
  const why = assignWhy(st);
  const act = `<div class="card"><div class="field"${I('C-117')}><label for="reason">Reason <span class="req">*</span></label><input class="input" id="reason" maxlength="400" data-act-input="x" data-f="reason" value="${esc(st.reason || '')}" placeholder="Recorded on the student’s history"${st.reasonErr ? ' aria-invalid="true"' : ''}><div class="err" role="alert">${st.reasonErr ? esc(st.reasonErr) : ''}</div><div class="hint">Required. Recorded on the student’s history.</div></div>
    <button class="btn primary block" type="button" data-act="assign"${why ? ' disabled' : ''}${I('C-118')}>Assign ${st.pool.length || ''} selected${f ? ` to ${esc(f.name)}` : ''}</button><p class="xs muted" data-why style="margin-top:6px">${esc(why)}</p></div>`;
  const bb = st.bb ? `<div class="card" style="margin-bottom:12px"><h3 style="margin-bottom:8px">Assign a whole batch${f ? ` to ${esc(f.name)}` : ''}</h3><div class="form-grid"><div class="field"${I('C-104')}><label>Batch</label>${U.select('bbat', opt(batchOpts(), 'Choose a batch'), st.bbat || '', '', 'Batch')}</div><div class="field"${I('C-105')}><label for="breason">Reason (optional)</label><input class="input" id="breason" maxlength="400" data-act-input="x" data-f="breason" value="${esc(st.breason || '')}"></div></div>
    <button class="btn" type="button" data-act="bulkAssign"${st.bbat && f ? '' : ' disabled'}${I('C-106')}>${f ? `Assign to ${esc(f.name)}` : 'Pick a faculty member first'}</button></div>` : '';
  return U.page({ title: 'Assign faculty', lede: `<span${I('C-102')}>${head}</span>`,
    acts: `<button class="btn" type="button" data-act="bb" aria-expanded="${!!st.bb}"${I('C-103')}>${ic('users', 'sm')} Assign a whole batch</button>`,
    body: `${flashBar(st, I('C-119'))}${bb}<div class="filters">${U.select('dept', opt(A.depts.map((d) => [d.id, `${college(d.college).code} · ${d.name}`]), 'All departments'), st.dept || '', I('C-107'), 'Department')}${U.select('bat', opt(A.batches.filter((b) => !st.dept || b.dept === st.dept).map((b) => [b.id, batchLabel(b)]), 'All batches'), st.bat || '', I('C-108'), 'Batch')}</div>
      <div class="grid-2"><div>${U.section('Faculty', rail).replace('class="section"', 'class="section" style="margin-top:0"')}${mentees}</div><div>${U.section('Unassigned students', poolList).replace('class="section"', 'class="section" style="margin-top:0"')}${act}</div></div>` });
}, acts: {
  dismiss,
  bb(el, ev, st) { st.bb = !st.bb; rr(); },
  pickFac(el, ev, st) { st.fac = st.fac === el.dataset.id ? null : el.dataset.id; rr(); },
  hist: (el) => openHistory(el.dataset.id),
  'change:pool'(el, ev, st) { const v = el.value; st.pool = el.checked ? [...new Set([...(st.pool || []), v])] : (st.pool || []).filter((x) => x !== v); rr(); },
  'input:reason'(el, ev, st) { st.reason = el.value; st.reasonErr = ''; el.removeAttribute('aria-invalid'); syncAssign(st); },
  'input:breason'(el, ev, st) { st.breason = el.value; },
  assign(el, ev, st) {
    const f = fac(st.fac); const reason = (st.reason || '').trim();
    if (!reason) { st.reasonErr = 'Required. Recorded on the student’s history.'; return rr(); }
    const picked = st.pool.map(stu); const other = picked.filter((s) => collegeOfStudent(s) && collegeOfStudent(s) !== f.college); const okS = picked.filter((s) => !other.includes(s));
    okS.forEach((s) => { recordMentor(s.id, f.id, reason); s.mentor = f.id; });
    say(st, `${okS.length ? `Assigned ${okS.map((s) => s.name).join(', ')} to ${f.name}.` : ''}${other.length ? ` Refused ${other.map((s) => s.name).join(', ')}: a faculty member mentors only within their own college.` : ''}`.trim(), other.length ? 'risk' : 'good');
    st.pool = []; st.reason = ''; rr();
  },
  release(el, ev, st) {
    const s = stu(el.dataset.id); const reason = (st.reason || '').trim();
    if (!reason) { st.reasonErr = `Say why ${s.name} is being released, then press release again.`; rr(); const r = document.getElementById('reason'); if (r) r.focus(); return; }
    recordMentor(s.id, null, reason); s.mentor = null; st.reason = '';
    say(st, `${s.name} is back in the unassigned pool. ${fac(st.fac).name} keeps read-only access to their records for 90 days.`); rr();
  },
  bulkAssign(el, ev, st) {
    const f = fac(st.fac); const b = batch(st.bbat); const inB = A.students.filter((s) => s.batch === b.id); const elsewhere = inB.filter((s) => s.mentor && s.mentor !== f.id).length;
    Sheet.confirm({ title: `Assign ${batchLabel(b)}?`, text: `This moves EVERY student in the batch — ${inB.length} in all, ${elsewhere} of them currently with another faculty member — to ${esc(f.name)}.`, ok: `Assign ${inB.length}`, onOk: () => {
      if (b.college !== f.college) { say(st, `Refused: ${f.name} is not at ${college(b.college).name}.`, 'risk'); return rr(); }
      inB.forEach((s) => { recordMentor(s.id, f.id, (st.breason || '').trim(), 'Moved on'); s.mentor = f.id; }); say(st, `${inB.length} students in ${batchLabel(b)} now have ${f.name}.`); st.bb = false; rr(); } });
  },
} });

/* ================================================================ Colleges — ONE area: the list (/admin/colleges),
   a college's structure (/admin/colleges/<id>, was /admin/institution) and Set up a college (/admin/setup).
   Setup ADDS, the structure SEES AND CHANGES, the list LISTS. */
const enabledTracks = () => (A.tracks || []).filter((t) => t.enabled);
/** _default_track: mapped to the specialization, its code, mapped to the course, its code — exact, case-folded; no match = general */
function defaultTrack(courseObj, specObj) {
  const byCode = (code) => code && enabledTracks().find((t) => t.code.toLowerCase() === String(code).toLowerCase());
  const byMap = (id) => id && A.trackMap[id] && enabledTracks().find((t) => t.code === A.trackMap[id]);
  return (specObj && (byMap(specObj.id) || byCode(specObj.code))) || (courseObj && (byMap(courseObj.id) || byCode(courseObj.code))) || null;
}
const mockChip = (t) => (t ? chip(`Mock interview: ${t.label}`, 'good') : chip('Mock interview: general', 'warn'));
const peopleUnder = (cid) => ({ students: A.students.filter((s) => collegeOfStudent(s) === cid).length, faculty: A.faculty.filter((f) => f.college === cid).length, apps: A.regs.filter((r) => r.college === cid && ['Pending review', 'Held'].includes(r.status)).length });
const deptsOf = (cid) => A.depts.filter((d) => d.college === cid);
function openAppoint(c) {
  const eligible = A.faculty.filter((f) => f.college === c.id);
  Sheet.open({ title: `Appoint a college admin · ${c.code}`, body: eligible.length ? `<div class="stack"${I('C-129')}>${U.field({ id: 'af', label: 'Faculty account', req: true, opts: opt(eligible.map((f) => [f.id, f.name]), 'Choose') })}${U.field({ id: 'ar', label: 'Reason', type: 'textarea', req: true, hint: '<span data-count>0 of 20 characters</span>', attrs: ' data-act-input="x" data-f="ar"' })}</div>`
    : `<div${I('C-129')}>${U.empty('user', 'No faculty account at this college yet', '', '<a class="btn" href="#/admin/faculty">Add a faculty member</a>')}</div>`,
    foot: `<button class="btn" type="button" data-sheet-close${I('C-130')}>Cancel</button><button class="btn primary" type="button" data-act="ok"${eligible.length ? '' : ' disabled'}${I('C-130')}>Appoint</button>`,
    onAct: { 'input:ar': (a, ev, el) => { el.querySelector('[data-count]').textContent = `${a.value.trim().length} of 20 characters`; },
      ok: (a, ev, el) => { const v = formVals(el); const e = {}; if (!v.af) e.af = 'Choose a faculty account.'; if (v.ar.length < 20) e.ar = 'Say why in at least 20 characters — it goes on the audit trail.'; if (!errs(el, e)) return;
        c.admin = { name: fac(v.af).name, fns: 6, of: 6, pending: 0 }; Sheet.close(); toast(`${fac(v.af).name} is ${c.code}’s college admin. Your grants are live at once.`); rr(); } } });
}
function openDeleteCollege(c) {
  let mode = 'remove'; let code = null; let counted = false;
  const body = () => { const p = peopleUnder(c.id); const refuse = [p.students && `${p.students} student${p.students > 1 ? 's are' : ' is'} seated or filed under it`, p.faculty && `${p.faculty} faculty account${p.faculty > 1 ? 's are' : ' is'} filed under it`, p.apps && `${p.apps} application${p.apps > 1 ? 's are' : ' is'} still in the review queue`].filter(Boolean);
    const d = deptsOf(c.id); const k = A.courses.filter((x) => d.some((y) => y.id === x.dept)); const b = A.batches.filter((x) => x.college === c.id);
    return `<div class="stack">${U.seg('dm', [['remove', 'Remove — keep the record'], ['delete', 'Delete for good']], mode, I('C-134'))}
      <p class="small muted">${mode === 'remove' ? 'Remove hides the college from every list and picker. Restore brings it back with nothing lost.' : 'Delete destroys the rows and files below. It needs a code from your email and cannot be undone.'}</p>
      <div class="card flat"${I('C-135')}>${!counted ? '<p class="small muted">Counting what would go…</p>' : refuse.length ? `<div class="banner risk">${ic('alert')}<div><b>Refused while anybody is under it:</b><br>${refuse.map(esc).join('<br>')}</div></div>` : `<ul class="small" style="padding-left:18px"><li>The college ${esc(c.name)} goes.</li><li>${d.length} department${d.length === 1 ? '' : 's'}, ${k.length} course${k.length === 1 ? '' : 's'} and ${b.length} batch${b.length === 1 ? '' : 'es'} go with it, with their calendar and interview policies.</li><li>Job postings and interview tracks that named it stay, and lose the pointer.</li></ul>`}</div>
      ${U.field({ id: 'dr', label: 'Reason', type: 'textarea', req: true, inv: I('C-136') })}
      ${mode === 'delete' ? `<div class="stack"${I('C-137')}><button class="btn" type="button" data-act="code">${code ? 'Send another code' : 'Email me a code'}</button>${U.field({ id: 'dc', label: 'Code from your email', ph: '6 digits', attrs: ' inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })}</div>` : ''}</div>`; };
  const refused = () => { const p = peopleUnder(c.id); return mode === 'delete' && (p.students || p.faculty || p.apps); };
  const el = Sheet.open({ title: `Delete ${c.name}?`, body: body(), foot: `<button class="btn" type="button" data-sheet-close${I('C-138')}>Cancel</button><button class="btn danger solid" type="button" data-act="go2"${I('C-138')}>Confirm</button>`,
    onAct: {
      'seg:dm': (a) => { const r = el.querySelector('#dr').value; mode = a.dataset.v; el.querySelector('.sh-b').innerHTML = body(); el.querySelector('#dr').value = r; },
      code: () => { code = String(Math.floor(100000 + Math.random() * 900000)); toast(`Code sent to ${D.me.admin.email} (prototype: ${code})`); el.querySelector('.sh-b [data-act="code"]').textContent = 'Send another code'; },
      go2: (a, ev, sh) => { const v = formVals(sh); const e = {}; if (!v.dr) e.dr = 'Reason is required — it goes on the audit trail.'; if (mode === 'delete' && !code) e.dc = 'Press “Email me a code” first.'; else if (mode === 'delete' && v.dc !== code) e.dc = 'That code is not right.'; if (!errs(sh, e)) return;
        if (refused()) { code = null; toast('Refused while anybody is under this college. The code was spent.', 'risk'); sh.querySelector('.sh-b').innerHTML = body(); return; }
        if (mode === 'remove') { c.removed = true; c.prevStatus = c.status; c.status = 'Archived'; toast(`${c.name} removed. Restore brings it back.`); }
        else { A.colleges.splice(A.colleges.indexOf(c), 1); const ds = deptsOf(c.id).map((d) => d.id); A.batches = A.batches.filter((b) => b.college !== c.id); A.courses = A.courses.filter((k) => !ds.includes(k.dept)); A.depts = A.depts.filter((d) => d.college !== c.id); toast(`${c.name} deleted.`); }
        Sheet.close(); rr(); },
    } });
  setTimeout(() => { counted = true; const r = el.querySelector('#dr'); const keep = r ? r.value : ''; el.querySelector('.sh-b').innerHTML = body(); el.querySelector('#dr').value = keep; }, 500);
}
function collegesList(st) {
  const status = st.status || 'all';
  const campuses = [...new Set(A.colleges.map((c) => c.campus).filter(Boolean))];
  const rows = A.colleges.filter((c) => (status === 'all' || c.status.toLowerCase() === status) && (!st.campus || c.campus === st.campus));
  const active = A.colleges.filter((c) => c.status === 'Active').length;
  const cards = rows.map((c) => { const a = c.admin; const dcount = deptsOf(c.id).length;
    return `<div class="card"${I('C-126')}><div class="card-h"><h2>${esc(c.name)}</h2>${chip(c.status, c.status === 'Active' ? 'good' : c.status === 'Draft' ? 'warn' : 'neutral')}</div>
      <p class="small muted" style="margin:-6px 0 10px">${esc(c.code)} · ${esc(c.campus || 'Campus not recorded')} · ${dcount} department${dcount === 1 ? '' : 's'}</p>
      ${kv([['Email domains', c.domains.length ? c.domains.map((d) => esc(d)).join(', ') : 'Deployment list'], ['College admin', `<span${I('C-127')}>${a ? `${esc(a.name)} ${a.pending ? chip(`${a.pending} awaiting approval`, 'warn') : a.fns === a.of ? chip(`${a.fns} functions`, 'good') : chip(`${a.fns} of ${a.of} functions`, 'info')}` : 'Not appointed'}</span>`], ['Contact', esc(c.contact) || '—']])}
      <div class="hrow" style="margin-top:12px">${c.removed ? `<button class="btn primary" type="button" data-act="restore" data-id="${c.id}">${ic('restore', 'sm')} Restore</button>` : `<a class="btn primary" href="#/admin/colleges/${c.id}"${I('C-131')}>Open</a><a class="btn" href="#/admin/setup?college=${c.id}"${I('C-132')}>Add departments, courses, batches</a>`}
        <span class="grow"></span>${App.role === 'admin' ? `<button class="btn sm ghost" type="button" data-act="appoint" data-id="${c.id}"${I('C-128')}>Appoint</button><button class="btn sm ghost danger" type="button" data-act="delCollege" data-id="${c.id}"${I('C-133')}>Delete college…</button>` : ''}</div></div>`; }).join('');
  return U.page({ title: 'Colleges', lede: `<span${I('C-121')}>${A.colleges.length} colleges · ${active} active${rows.length !== A.colleges.length ? ` · showing ${rows.length} of ${A.colleges.length}` : ''}</span>`,
    acts: `<a class="btn primary" href="#/admin/setup"${I('C-122')}>${ic('plus', 'sm')} Set up a college</a>`,
    body: `<div class="filters">${U.seg('status', [['all', 'All'], ['active', 'Active'], ['draft', 'Draft'], ['archived', 'Archived']], status, I('C-124'))}${campuses.length > 1 ? U.select('campus', opt(campuses.map((x) => [x, x]), 'Every campus'), st.campus || '', I('C-125'), 'Campus') : ''}</div>
      ${rows.length ? `<div class="grid-2">${cards}</div>` : `<div class="card"${I('C-139')}>${U.empty('building', A.colleges.length ? 'No college matches this filter.' : 'No college yet.', '', A.colleges.length ? '' : '<a class="btn primary" href="#/admin/setup">Set up a college</a>')}</div>`}` });
}

const missingLevels = (b) => [A.levels.course && !b.course && 'Course', A.levels.spec && !b.spec && 'Specialization'].filter(Boolean);
const YEARS = Array.from({ length: 12 }, (_, i) => 2020 + i);
function batchForm(c, b, deptId) {
  const isNew = !b; b = b || { code: '', name: '', label: '', entry: '', completion: '', degree: 'PG', course: '', spec: '' };
  const m = /^(\d{4})-(\d{2})$/.exec(b.label || ''); const sy = m ? m[1] : ''; const ey = m ? `20${m[2]}` : '';
  const free = b.label && !m;
  const courses = A.courses.filter((k) => k.dept === (b.dept || deptId));
  const specs = A.specs.filter((s) => s.course === b.course);
  const grand = !isNew && !b.course;
  return `<div class="stack"${I('C-188')}>${isNew ? U.field({ id: 'bc', label: 'Code', req: true, ph: 'NHM-MBA-2026-B' }) : `<p class="small"><b>${esc(b.code)}</b> · ${b.degree}</p>`}
    <label class="check"><input type="checkbox" name="bfree" data-act-change="x" data-f="bfree"${free ? ' checked' : ''}><span>Not a year span</span></label>
    <div class="form-grid" data-span${free ? ' hidden' : ''}>${U.field({ id: 'bs', label: 'Start year', req: true, value: sy, opts: opt(YEARS.map((y) => [y, y]), 'Choose') })}${U.field({ id: 'be', label: 'End year', req: true, value: ey, opts: opt(YEARS.map((y) => [y, y]), 'Choose') })}</div>
    <div data-free${free ? '' : ' hidden'}>${U.field({ id: 'bl', label: 'Batch label', req: true, value: free ? b.label : '' })}</div>
    ${U.field({ id: 'bn', label: 'Name', value: b.name !== b.label ? b.name : '', ph: 'Optional, e.g. 2024-26 Section B', hint: 'Left blank, the batch reads as its year.' })}
    ${isNew ? U.field({ id: 'bg', label: 'Degree level', value: 'PG', opts: [['PG', 'PG'], ['UG', 'UG']] }) : ''}
    <div class="form-grid">${U.field({ id: 'bi', label: 'Entry date', req: true, type: 'date', value: b.entry })}${U.field({ id: 'bx', label: 'Expected completion', req: true, type: 'date', value: b.completion })}</div>
    <div class="form-grid"${I('C-189')}><div>${U.field({ id: 'bk', label: 'Course', value: b.course || '', opts: opt(courses.map((k) => [k.id, k.name]), 'No course'), attrs: ' data-act-change="x" data-f="bk"' })}${A.levels.course ? chip(grand ? 'Created before Course was required' : 'Required', grand ? 'neutral' : 'info') : chip('Optional', 'neutral')}</div>
      <div>${U.field({ id: 'bp', label: 'Specialization', value: b.spec || '', opts: opt(specs.map((s) => [s.id, s.name]), b.course ? 'No specialization' : 'Needs a course first.'), attrs: b.course ? '' : ' disabled' })}${A.levels.spec ? chip('Required', 'info') : chip('Optional', 'neutral')}</div></div></div>`;
}
function batchErrors(v, isNew, b, c) {
  const e = {};
  if (isNew && !v.bc) e.bc = 'Code is required.'; else if (isNew && A.batches.some((x) => x.code.toLowerCase() === v.bc.toLowerCase())) e.bc = `${v.bc} is already a batch code.`;
  if (v.bfree) { if (!v.bl) e.bl = 'Give the batch a label.'; } else { if (!v.bs) e.bs = 'Choose a start year.'; if (!v.be) e.be = v.bs ? 'Choose an end year.' : 'Choose the start year first.'; else if (+v.be <= +v.bs) e.be = 'The end year must come after the start.'; }
  if (!v.bi) e.bi = 'Entry date is required.'; if (!v.bx) e.bx = 'Expected completion is required.'; else if (v.bi && v.bx <= v.bi) e.bx = 'Completion must come after entry.';
  const grand = !isNew && !b.course;
  if (A.levels.course && !v.bk && !grand) e.bk = 'Course is required.';
  if (A.levels.spec && !v.bp) e.bp = 'Specialization is required.';
  return e;
}
function openBatch(c, b, deptId, st) {
  const isNew = !b;
  const el = Sheet.open({ title: isNew ? 'New batch' : `Edit ${b.code}`, body: batchForm(c, b, deptId), foot: `<button class="btn" type="button" data-sheet-close${I('C-190')}>Cancel</button><button class="btn primary" type="button" data-act="save"${I('C-190')}>${isNew ? 'Create batch' : 'Save'}</button>`,
    onAct: {
      'change:bfree': (a, ev, sh) => { sh.querySelector('[data-span]').hidden = a.checked; sh.querySelector('[data-free]').hidden = !a.checked; },
      'change:bk': (a, ev, sh) => { const sel = sh.querySelector('#bp'); const specs = A.specs.filter((s) => s.course === a.value); sel.innerHTML = opt(specs.map((s) => [s.id, s.name]), a.value ? 'No specialization' : 'Needs a course first.').map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join(''); sel.disabled = !a.value; },
      save: (a, ev, sh) => {
        const v = formVals(sh); if (!errs(sh, batchErrors(v, isNew, b, c))) return;
        const label = v.bfree ? v.bl : `${v.bs}-${String(v.be).slice(2)}`; const k = course(v.bk);
        const row = { label, name: v.bn || label, entry: v.bi, completion: v.bx, course: v.bk || null, spec: v.bp || null, dept: k ? k.dept : (b ? b.dept : deptId) };
        if (isNew) A.batches.push({ id: `b${Date.now()}`, college: c.id, code: v.bc, degree: v.bg, ...row }); else Object.assign(b, row);
        Sheet.close(); say(st, isNew ? `Created batch ${v.bc}.` : `Saved ${b.code}.`); rr();
      },
    } });
  const sync = () => { const v = formVals(el); el.querySelector('[data-act="save"]').disabled = Object.keys(batchErrors(v, isNew, b, c)).length > 0; };
  el.addEventListener('input', sync); el.addEventListener('change', sync); sync();
}
function openSeating(b, st) {
  const body = () => { const inB = A.students.filter((s) => s.batch === b.id); const free = A.students.filter((s) => !s.batch);
    return `<div class="stack"><div class="hrow"${I('C-185')}><select class="input grow" id="seat" aria-label="Add a student">${opt(free.map((s) => [s.id, `${s.name} · ${s.usn}`]), free.length ? 'Choose a student not in any batch' : 'Every student is in a batch').map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select><button class="btn primary" type="button" data-act="seat">Add</button></div>
      <div class="list"${I('C-186')}>${listOr(inB.map((s) => U.row({ title: esc(s.name), sub: `${esc(s.usn)} · ${s.usn.toLowerCase()}@${college(b.college).domains[0] || 'mail'}`, trail: `${stageChip(s.stage)}<button class="btn sm" type="button" data-act="unseat" data-id="${s.id}">Remove</button>`, chev: false })), 'Nobody is seated in this batch.')}</div></div>`; };
  Sheet.open({ title: `Students in ${b.code}`, body: body(), foot: '<button class="btn" type="button" data-sheet-close>Close</button>', onClose: () => setTimeout(rr), onAct: {
    seat: (a, ev, sh) => { const id = sh.querySelector('#seat').value; if (!id) return toast('Choose a student first.', 'risk'); const s = stu(id); s.batch = b.id; sh.querySelector('.sh-b').innerHTML = body(); toast(`${s.name} seated in ${b.code}`); },
    unseat: (a, ev, sh) => { const s = stu(a.dataset.id); s.batch = null; sh.querySelector('.sh-b').innerHTML = body(); toast(`${s.name} is no longer in ${b.code}`); },
  } });
}
function openCourse(k, st) {
  Sheet.open({ title: `Edit ${k.name}`, body: `<div class="form-grid"${I('C-176')}>${U.field({ id: 'kc', label: 'Code', req: true, value: k.code })}${U.field({ id: 'kn', label: 'Name', req: true, value: k.name })}${U.field({ id: 'ks', label: 'Status', value: k.status, opts: ['Active', 'Archived'] })}${U.field({ id: 'km', label: 'Months', type: 'number', value: k.years * 12 })}</div>`,
    foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="ok"${I('C-177')}>Save changes</button>`,
    onAct: { ok: (a, ev, sh) => { const v = formVals(sh); const e = {}; if (!v.kc) e.kc = 'Code is required.'; if (!v.kn) e.kn = 'Name is required.'; if (!errs(sh, e)) return; Object.assign(k, { code: v.kc, name: v.kn, status: v.ks, years: Math.max(1, Math.round(+v.km / 12) || k.years) }); Sheet.close(); say(st, `Saved course ${k.name}.`); rr(); } } });
}
function openMapping(k, st) {
  const tracks = (A.tracks || []).filter((t) => !t.builtin);
  Sheet.open({ title: `Map a mock interview · ${k.name}`, center: true, body: `<div class="stack"${I('C-180')}>${U.field({ id: 'mt', label: 'Mock interview', opts: tracks.map((t) => [t.code, `${t.label}${t.enabled ? '' : ' · off'}`]) })}${U.field({ id: 'mf', label: 'For', opts: [['', 'Every specialization (the course)'], ...A.specs.filter((s) => s.course === k.id).map((s) => [s.id, s.name])] })}</div>`,
    foot: '<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="ok">Save</button>',
    onAct: { ok: (a, ev, sh) => { const v = formVals(sh); A.trackMap[v.mf || k.id] = v.mt; Sheet.close(); say(st, `${tracks.find((t) => t.code === v.mt).label} now preselects for ${v.mf ? spec(v.mf).name : `every ${k.name} student`}.`); rr(); } } });
}
function structure(c, st) {
  if (!c) return U.page({ title: 'College structure', back: true, body: `<div class="card"${I('C-166')}>${U.empty('building', 'No college yet.', '', `<a class="btn primary" href="#/admin/setup">Set up the first college</a>`)}</div>` });
  const q = (st.find || '').toLowerCase(); const hit = (...xs) => !q || xs.join(' ').toLowerCase().includes(q);
  const depts = deptsOf(c.id); const dsel = depts.find((d) => d.id === st.dept) || depts[0];
  const courses = dsel ? A.courses.filter((k) => k.dept === dsel.id) : []; const ksel = courses.find((k) => k.id === st.course) || courses[0];
  const specs = ksel ? A.specs.filter((s) => s.course === ksel.id) : [];
  const batches = A.batches.filter((b) => b.college === c.id && dsel && b.dept === dsel.id);
  const incomplete = A.batches.filter((b) => b.college === c.id && missingLevels(b).length);
  const unfiled = A.batches.filter((b) => b.college === c.id && !b.dept);
  const setupLink = (step, label, inv) => `<a class="small" href="#/admin/setup?college=${c.id}&step=${step}"${inv}>${ic('plus', 'sm')} ${label}</a>`;
  const deptList = `<div class="list"${I('C-172')}>${listOr(depts.filter((d) => hit(d.code, d.name, d.head)).map((d) => U.row({ title: `${esc(d.code)} · ${esc(d.name)}`, sub: `${d.head ? esc(d.head) : 'Head not recorded'} · ${A.batches.filter((b) => b.dept === d.id).length} batches`, act: 'pickDept', data: ` data-id="${d.id}"`, sel: dsel && d.id === dsel.id })), q ? `Nothing matches “${esc(st.find)}”.` : 'No department yet.')}</div>`;
  const courseList = dsel ? `<div class="list"${I('C-174')}>${listOr(courses.filter((k) => hit(k.code, k.name)).map((k) => U.row({ title: `${esc(k.code)} · ${esc(k.name)}`, sub: `${k.degree} · ${k.years} years · ${A.specs.filter((s) => s.course === k.id).length} specializations`, trail: k.status === 'Archived' ? chip('Archived', 'neutral') : '', act: 'pickCourse', data: ` data-id="${k.id}"`, sel: ksel && k.id === ksel.id })), q ? `Nothing matches “${esc(st.find)}”.` : 'No course yet.')}</div>` : '';
  const tracksRead = !!A.tracks;
  const specRows = specs.filter((s) => hit(s.code, s.name)).map((s) => { const t = defaultTrack(ksel, s); const mapped = A.trackMap[s.id] || A.trackMap[ksel.id] || t; return { c: esc(s.code), n: esc(s.name), m: !tracksRead ? chip('Not read', 'neutral') : mapped && t ? chip(`${t.label}${t.enabled ? '' : ' · off'}`, 'good') : chip('Not mapped', 'warn'), b: A.batches.filter((b) => b.spec === s.id).length }; });
  const kTrack = ksel && defaultTrack(ksel, null);
  const courseCard = ksel ? `<div class="card"><div class="card-h"><h2>${esc(ksel.name)}</h2>${chip(ksel.status, ksel.status === 'Active' ? 'good' : 'neutral')}</div><p class="small muted">${esc(ksel.code)} · ${ksel.degree} · ${ksel.years * 12} months · ${specs.length ? `${specs.length} specializations` : `the course is the whole programme · ${kTrack ? `Mock interview: ${esc(kTrack.label)}` : 'Mock interview: general'}`}</p>
      <div class="hrow" style="margin-top:10px"><button class="btn sm" type="button" data-act="editCourse" data-id="${ksel.id}"${I('C-176')}>${ic('pen', 'sm')} Edit course</button><button class="btn sm" type="button" data-act="archiveCourse" data-id="${ksel.id}"${ksel.status === 'Archived' ? ' disabled' : ''}${I('C-177')}>Archive</button><button class="btn sm" type="button" data-act="mapTrack" data-id="${ksel.id}"${(A.tracks || []).some((t) => !t.builtin) ? '' : ' disabled title="No editable track yet"'}${I('C-179')}>${ic('mic', 'sm')} Map mock interview</button></div></div>
    ${specRows.length ? U.table([{ h: 'Code', k: 'c' }, { h: 'Specialization', k: 'n' }, { h: 'Mock interview', k: 'm' }, { h: 'Batches', k: 'b', r: 1 }], specRows, I('C-178')) : `<div class="card flat"${I('C-178')}><p class="small muted">No specialization — the course is the whole programme.</p></div>`}<div style="margin-top:6px">${setupLink(4, 'Add a specialization', I('C-181'))}</div>` : '';
  const batchRows = batches.filter((b) => hit(b.code, b.name, batchLabel(b))).map((b) => ({ c: `<b>${esc(b.code)}</b><div class="xs muted">${esc(batchLabel(b))}</div>`, k: `${course(b.course) ? esc(course(b.course).name) : '—'}${spec(b.spec) ? ` · ${esc(spec(b.spec).name)}` : ''} ${missingLevels(b).map((l) => chip(`Needs ${l.toLowerCase()}`, 'warn')).join(' ')}`, s: batchCount(b.id), e: `${b.completion} UTC`, a: `<span class="hrow" style="justify-content:flex-end"><button class="btn sm" type="button" data-act="editBatch" data-id="${b.id}"${I('C-183')}>Edit</button><button class="btn sm" type="button" data-act="seating" data-id="${b.id}"${I('C-184')}>Students</button></span>` }));
  return U.page({ title: c.name, back: true,
    lede: `<span${I('C-161')}>${esc(c.code)} · ${depts.length} departments${dsel ? ` · ${esc(dsel.code)}: ${batches.length} batches` : ''} · New batches must name a ${[A.levels.course && 'course', A.levels.spec && 'specialization'].filter(Boolean).join(' and ') || 'nothing'}</span>`,
    acts: `<a class="btn" href="#/admin/setup"${I('C-162')}>${ic('plus', 'sm')} Set up a college</a>`,
    body: `${flashBar(st, '')}
      ${incomplete.length ? `<div class="banner warn" style="margin-bottom:10px"${I('C-164')}>${ic('alert')}<div>${incomplete.length} batch${incomplete.length > 1 ? 'es are' : ' is'} missing a level that is now required.</div></div>` : ''}
      ${unfiled.length && dsel ? `<div class="banner info" style="margin-bottom:10px"${I('C-165')}>${ic('info')}<div class="grow">Not filed under any department: ${unfiled.map((b) => `<button class="btn sm" type="button" data-act="file" data-id="${b.id}" data-d="${dsel.id}">File ${esc(b.code)} under ${esc(dsel.code)}</button>`).join(' ')}</div></div>` : ''}
      <div class="filters">${U.select('cpick', A.colleges.map((x) => [x.id, `${x.code} · ${x.name}`]), c.id, I('C-167'), 'College')}${U.search('find', st.find || '', 'Department, course, specialization or batch', I('C-168'))}</div>
      <div class="card"${I('C-169')}><div class="card-h"><h2>${esc(c.name)}</h2>${chip(c.status === 'Archived' ? 'Archived' : 'Active', c.status === 'Archived' ? 'neutral' : 'good')}</div><p class="small muted">${esc(c.code)} · ${esc(c.campus || '—')} · ${depts.length} departments</p>
        <h3 style="margin:12px 0 6px">Email domains</h3><div class="hrow"${I('C-170')}>${c.domains.length ? c.domains.map((d) => `<span class="chip info">${esc(d)}<button class="a1-x" type="button" data-act="rmDomain" data-d="${esc(d)}" aria-label="Remove ${esc(d)}">${ic('x', 'sm')}</button></span>`).join('') : chip('Deployment list', 'neutral')}</div>
        <form class="hrow" style="margin-top:8px" data-domain-form${I('C-171')}><input class="input grow" id="newDomain" placeholder="college.edu.in" aria-label="Email domain" style="max-width:280px"><button class="btn sm" type="submit">Add domain</button></form><div class="err small" role="alert" data-derr style="color:var(--risk)"></div></div>
      <div class="grid-2" style="margin-top:12px"><div>${U.section('Departments', deptList, setupLink(2, 'Add a department', I('C-173')))}</div><div>${dsel ? U.section(`Courses · ${dsel.code}`, courseList, setupLink(3, 'Add a course', I('C-175'))) : ''}</div></div>
      ${ksel ? U.section(`Specializations · ${ksel.name}`, courseCard) : ''}
      ${dsel ? U.section(`Batches · ${dsel.code}`, batchRows.length ? U.table([{ h: 'Batch', k: 'c' }, { h: 'Course · Spec.', k: 'k' }, { h: 'Students', k: 's', r: 1 }, { h: 'Ends', k: 'e' }, { h: '', k: 'a', r: 1 }], batchRows, I('C-182')) : `<div class="card"${I('C-182')}>${U.empty('layers', q ? `Nothing matches “${esc(st.find)}”.` : 'No batch under this department.')}</div>`, `<button class="btn sm" type="button" data-act="addBatch"${I('C-187')}>${ic('plus', 'sm')} Add batch</button>`) : ''}` });
}
R.screen('admin/colleges', { title: 'Colleges', states: ids(I('C-123', 'C-163')), render({ id, st }) {
  if (!id) return collegesList(st);
  const c = college(id);
  if (st.cid !== id) { st.cid = id; st.dept = null; st.course = null; }
  return structure(c, st);
}, mount(main, { id, st }) {
  const f = main.querySelector('[data-domain-form]'); if (!f) return;
  f.addEventListener('submit', (ev) => { ev.preventDefault(); const c = college(id); const inp = f.querySelector('input'); const d = inp.value.trim().toLowerCase().replace(/^@+/, ''); const box = main.querySelector('[data-derr]');
    if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) { box.textContent = 'Write a domain such as college.edu.in.'; inp.setAttribute('aria-invalid', 'true'); return; }
    if (c.domains.includes(d)) { box.textContent = `${d} is already on this college.`; inp.setAttribute('aria-invalid', 'true'); return; }
    c.domains.push(d); say(st, `${d} added. Only these domains may hold an account at ${c.code}.`); rr(); });
}, acts: {
  dismiss,
  appoint: (el) => openAppoint(college(el.dataset.id)),
  delCollege: (el) => openDeleteCollege(college(el.dataset.id)),
  restore(el) { const c = college(el.dataset.id); c.removed = false; c.status = c.prevStatus || 'Active'; toast(`${c.name} restored.`); rr(); },
  'change:cpick': (el) => R.go(`#/admin/colleges/${el.value}`),
  pickDept(el, ev, st) { st.dept = el.dataset.id; st.course = null; rr(); },
  pickCourse(el, ev, st) { st.course = el.dataset.id; rr(); },
  rmDomain(el, ev, st) { const c = college(st.cid); c.domains = c.domains.filter((d) => d !== el.dataset.d); say(st, `${el.dataset.d} removed.${c.domains.length ? '' : ' The deployment list applies now.'}`); rr(); },
  file(el, ev, st) { const b = batch(el.dataset.id); b.dept = el.dataset.d; say(st, `Filed ${b.code} under ${dept(el.dataset.d).name}.`); rr(); },
  editCourse: (el, ev, st) => openCourse(course(el.dataset.id), st),
  archiveCourse(el, ev, st) { const k = course(el.dataset.id); Sheet.confirm({ title: `Archive ${k.name}?`, text: 'Its batches stay. New batches can no longer name it.', ok: 'Archive', onOk: () => { k.status = 'Archived'; say(st, `Archived course ${k.name}.`); rr(); } }); },
  mapTrack: (el, ev, st) => openMapping(course(el.dataset.id), st),
  editBatch: (el, ev, st) => { const b = batch(el.dataset.id); openBatch(college(b.college), b, b.dept, st); },
  addBatch: (el, ev, st) => { const c = college(st.cid); const d = deptsOf(c.id).find((x) => x.id === st.dept) || deptsOf(c.id)[0]; openBatch(c, null, d && d.id, st); },
  seating: (el, ev, st) => openSeating(batch(el.dataset.id), st),
} });

/* ---------------------------------------------------------------- Set up a college: six steps, the same five writes, additive and re-runnable */
const STEP_NAMES = ['College', 'Departments', 'Courses', 'Specializations', 'Batches', 'Create'];
let wkey = 0; const nk = () => `n${++wkey}`;
const blankWizard = () => ({ cid: '', college: { code: '', name: '', campus: '', contact: '', domains: '' }, depts: [{ key: nk(), code: '', name: '', head: '' }], courses: [], specs: [], start: 2026, leaves: {}, step: 1, max: 1, plan: null, loading: false });
function loadCollege(w, cid) {
  const c = college(cid); w.cid = cid; w.college = { code: c.code, name: c.name, campus: c.campus, contact: c.contact, domains: c.domains.join(', ') };
  w.depts = deptsOf(cid).map((d) => ({ key: d.id, id: d.id, code: d.code, name: d.name, head: d.head, locked: true }));
  w.courses = A.courses.filter((k) => k.status !== 'Archived' && w.depts.some((d) => d.id === k.dept)).map((k) => ({ key: k.id, id: k.id, dept: k.dept, code: k.code, name: k.name, degree: k.degree, years: k.years, locked: true }));
  w.specs = A.specs.filter((s) => w.courses.some((k) => k.id === s.course)).map((s) => ({ key: s.id, id: s.id, course: s.course, code: s.code, name: s.name, locked: true }));
  if (!w.depts.length) w.depts = [{ key: nk(), code: '', name: '', head: '' }];
  w.leaves = {}; w.plan = null;
}
const leavesOf = (w) => w.courses.flatMap((k) => { const sp = w.specs.filter((s) => s.course === k.key); return sp.length ? sp.map((s) => ({ key: `${k.key}/${s.key}`, k, s })) : [{ key: `${k.key}/`, k, s: null }]; });
const leafState = (w, lf) => { if (!w.leaves[lf.key]) { const has = existingBatch(w, lf); w.leaves[lf.key] = { inc: !has, start: w.start, end: w.start + (+lf.k.years || 2) }; } return w.leaves[lf.key]; };
const existingBatch = (w, lf) => lf.k.id && A.batches.find((b) => b.course === lf.k.id && (lf.s ? b.spec === lf.s.id : !b.spec));
const spanLabel = (a, b) => `${a}-${String(b).slice(2)}`;
const leafCode = (w, lf, st) => { const d = w.depts.find((x) => x.key === lf.k.dept); return [w.college.code, d && d.code, lf.k.code, lf.s && lf.s.code, spanLabel(st.start, st.end)].filter(Boolean).join('-').toUpperCase(); };
const normDomains = (s) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^@+/, '')).filter(Boolean))];
function stepProblem(w, n = w.step) {
  if (w.loading) return 'Reading…';
  if (n === 1) return w.cid || (w.college.code && w.college.name) ? '' : 'Code and name are needed.';
  if (n === 2) return !w.depts.length ? 'Add at least one department.' : w.depts.some((d) => !d.locked && (!d.code || !d.name)) ? 'Every department needs a code and a name.' : '';
  if (n === 3) return !w.courses.length ? 'Add at least one course.' : w.courses.some((k) => !k.locked && (!k.code || !k.name || !(+k.years >= 1 && +k.years <= 6))) ? 'Every course needs a code, a name and 1–6 years.' : '';
  if (n === 4) return w.specs.some((s) => !s.locked && (!s.code || !s.name)) ? 'A specialization you add needs a code and a name.' : '';
  if (n === 5) return leavesOf(w).some((lf) => { const s = leafState(w, lf); return s.inc && !(+s.end > +s.start); }) ? 'Each ticked batch needs an end year after its start.' : '';
  return '';
}
const winp = (path, val, label, attrs = '') => `<input class="input" data-act-input="x" data-f="w" data-p="${path}" value="${esc(val)}" aria-label="${esc(label)}" placeholder="${esc(label)}"${attrs}>`;
const wsel = (path, val, opts, label, attrs = '') => `<select class="input" data-act-change="x" data-f="w" data-p="${path}" aria-label="${esc(label)}"${attrs}>${opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
const lockedRow = (title, sub) => `<div class="row"><span class="lead">${ic('lock', 'sm')}</span><div class="body"><div class="ttl">${title}</div><div class="sub">${sub}</div></div><div class="trail">${chip('Already there', 'neutral')}</div></div>`;
function runPlan(w) {
  const out = []; const bad = (code) => !/^[A-Za-z0-9-]+$/.test(code);
  const put = (kind, name, status, detail = '') => { out.push({ kind, name, status, detail }); return status; };
  // 1. the college
  let cid = w.cid;
  if (!cid) { const code = w.college.code.trim(); const ex = A.colleges.find((c) => c.code.toLowerCase() === code.toLowerCase());
    if (ex) { cid = ex.id; put('College', ex.name, 'Already there'); } else if (bad(code)) put('College', w.college.name, 'Failed', 'a code holds letters, digits and hyphens only');
    else { cid = `c${Date.now()}`; A.colleges.push({ id: cid, code, name: w.college.name, campus: w.college.campus, contact: w.college.contact, domains: normDomains(w.college.domains), status: 'Draft', admin: null }); A.cal[cid] = []; put('College', w.college.name, 'Created'); } }
  else put('College', w.college.name, 'Already there');
  w.cid = cid || '';
  w.depts.forEach((d) => {
    if (d.locked) return put('Department', `${d.code} · ${d.name}`, 'Already there');
    if (!cid) return put('Department', `${d.code} · ${d.name}`, 'Skipped', 'the college was not created');
    const ex = A.depts.find((x) => x.college === cid && x.code.toLowerCase() === d.code.toLowerCase());
    if (ex) { Object.assign(d, { id: ex.id, locked: true }); return put('Department', `${d.code} · ${d.name}`, 'Already there'); }
    if (bad(d.code)) return put('Department', `${d.code} · ${d.name}`, 'Failed', 'a code holds letters, digits and hyphens only');
    d.id = `d${Date.now()}${d.key}`; A.depts.push({ id: d.id, college: cid, code: d.code, name: d.name, head: d.head, capacity: null }); d.locked = true; put('Department', `${d.code} · ${d.name}`, 'Created');
  });
  w.courses.forEach((k) => { const d = w.depts.find((x) => x.key === k.dept);
    if (k.locked) return put('Course', k.name, 'Already there');
    if (!d || !d.id) return put('Course', k.name, 'Skipped', 'its department was not created');
    const ex = A.courses.find((x) => x.dept === d.id && x.code.toLowerCase() === k.code.toLowerCase());
    if (ex) { Object.assign(k, { id: ex.id, locked: true }); return put('Course', k.name, 'Already there'); }
    if (bad(k.code)) return put('Course', k.name, 'Failed', 'a code holds letters, digits and hyphens only');
    k.id = `k${Date.now()}${k.key}`; A.courses.push({ id: k.id, dept: d.id, code: k.code, name: k.name, degree: k.degree, years: +k.years, status: 'Active' }); k.locked = true; put('Course', k.name, 'Created');
  });
  w.specs.forEach((s) => { const k = w.courses.find((x) => x.key === s.course);
    if (s.locked) return put('Specialization', s.name, 'Already there');
    if (!k || !k.id) return put('Specialization', s.name, 'Skipped', 'its course was not created');
    const ex = A.specs.find((x) => x.course === k.id && x.code.toLowerCase() === s.code.toLowerCase());
    if (ex) { Object.assign(s, { id: ex.id, locked: true }); return put('Specialization', s.name, 'Already there'); }
    if (bad(s.code)) return put('Specialization', s.name, 'Failed', 'a code holds letters, digits and hyphens only');
    s.id = `sp${Date.now()}${s.key}`; A.specs.push({ id: s.id, course: k.id, code: s.code, name: s.name }); s.locked = true; put('Specialization', s.name, 'Created');
  });
  leavesOf(w).forEach((lf) => { const st = leafState(w, lf); if (!st.inc) return; const label = spanLabel(st.start, st.end); const code = leafCode(w, lf, st);
    if (!lf.k.id || (lf.s && !lf.s.id)) return put('Batch', `${code}`, 'Skipped', 'its course or specialization was not created');
    if (A.batches.some((b) => b.code.toLowerCase() === code.toLowerCase())) { st.inc = false; return put('Batch', code, 'Already there'); }
    const d = w.depts.find((x) => x.key === lf.k.dept);
    A.batches.push({ id: `b${Date.now()}${lf.key}`, college: cid, dept: d.id, course: lf.k.id, spec: lf.s ? lf.s.id : null, code, name: label, label, entry: `${st.start}-07-01`, completion: `${st.end}-06-30`, degree: lf.k.degree }); st.inc = false; put('Batch', code, 'Created');
  });
  return out;
}
function planPreview(w) {
  const rows = [['College', w.college.name || w.college.code, w.cid ? 'Already there' : 'New'], ...w.depts.map((d) => ['Department', `${d.code} · ${d.name}`, d.locked ? 'Already there' : 'New']), ...w.courses.map((k) => ['Course', k.name, k.locked ? 'Already there' : 'New']), ...w.specs.map((s) => ['Specialization', s.name, s.locked ? 'Already there' : 'New']),
    ...leavesOf(w).filter((lf) => leafState(w, lf).inc).map((lf) => ['Batch', leafCode(w, lf, leafState(w, lf)), 'New'])];
  return rows.map(([kind, name, status]) => ({ kind, name, status, detail: '' }));
}
const outcomeChip = (r) => (r.status === 'Created' ? chip('Created', 'good') : r.status === 'Already there' ? chip('Already there', 'neutral') : r.status === 'New' ? chip('New', 'info') : r.status === 'Skipped' ? `<span class="chip warn" title="${esc(r.detail)}">Skipped</span>` : chip(`Failed · ${r.detail}`, 'risk'));
function wizardStep(w) {
  const n = w.step;
  if (w.loading) return `<div class="card"><p class="small muted" role="status">Reading what ${esc(college(w.cid).name)} already has…</p></div>`;
  if (n === 1) {
    const pick = `<div class="field"${I('C-142')}><label>Continue a college that is already here</label>${wsel('cid', w.cid, [['', '— New college —'], ...A.colleges.map((c) => [c.id, `${c.code} · ${c.name}`])], 'College')}</div>`;
    if (w.cid) return `<div class="card">${pick}<div${I('C-143')}>${kv([['Code', esc(w.college.code)], ['Name', esc(w.college.name)], ['Campus', esc(w.college.campus) || '—'], ['Contact', esc(w.college.contact) || '—'], ['Email domains', esc(w.college.domains) || 'Deployment list']])}</div></div>`;
    return `<div class="card">${pick}<div class="form-grid" style="margin-top:8px"${I('C-144')}>${[['code', 'Code *', 'e.g. NHM'], ['name', 'Name *', 'Nandi Hills School of Management'], ['campus', 'Campus', 'Bengaluru'], ['contact', 'Contact', 'placements@college.edu.in'], ['domains', 'Email domains', 'college.edu.in, alumni.college.edu.in']].map(([k, l, ph]) => `<div class="field"><label>${l}</label>${winp(`college.${k}`, w.college[k], ph)}</div>`).join('')}</div>
      ${w.college.domains ? `<p class="xs muted">Saved as: ${normDomains(w.college.domains).map(esc).join(', ') || '—'}</p>` : ''}</div>`;
  }
  if (n === 2) return `<div class="card"><div class="list"${I('C-145')}>${w.depts.map((d, i) => (d.locked ? lockedRow(`${esc(d.code)} · ${esc(d.name)}`, d.head ? esc(d.head) : 'Head not recorded') : `<div class="row a1-edit"><div class="a1-cells">${winp(`depts.${i}.code`, d.code, 'Code (MBA)', ' style="max-width:140px"')}${winp(`depts.${i}.name`, d.name, 'Name *')}${winp(`depts.${i}.head`, d.head, 'Head')}</div>${w.depts.filter((x) => !x.locked).length > 1 ? `<button class="icon-btn" type="button" data-act="wRm" data-list="depts" data-i="${i}" aria-label="Remove department"${I('C-146')}>${ic('trash')}</button>` : ''}</div>`)).join('')}</div>
    <button class="btn sm" type="button" data-act="wAdd" data-list="depts" style="margin-top:10px"${I('C-146')}>${ic('plus', 'sm')} Add a department</button></div>`;
  if (n === 3) return `<div class="stack"${I('C-147')}>${w.depts.filter((d) => d.code || d.locked).map((d) => { const ks = w.courses.map((k, i) => [k, i]).filter(([k]) => k.dept === d.key);
    return `<div class="card"><h3 style="margin-bottom:8px">${esc(d.code)} · ${esc(d.name)}</h3><div class="list">${ks.length ? ks.map(([k, i]) => (k.locked ? lockedRow(esc(k.name), `${esc(k.code)} · ${k.degree} · ${k.years} years`) : `<div class="row a1-edit"><div class="a1-cells">${winp(`courses.${i}.code`, k.code, 'Code *', ' style="max-width:120px"')}${winp(`courses.${i}.name`, k.name, 'Name * (General MBA)')}${wsel(`courses.${i}.degree`, k.degree, [['PG', 'PG'], ['UG', 'UG']], 'Degree', ' style="max-width:90px"')}${wsel(`courses.${i}.years`, k.years, [1, 2, 3, 4, 5, 6].map((y) => [y, `${y} year${y > 1 ? 's' : ''}`]), 'Years', ' style="max-width:110px"')}</div><button class="icon-btn" type="button" data-act="wRm" data-list="courses" data-i="${i}" aria-label="Remove course"${I('C-148')}>${ic('trash')}</button></div>`)).join('') : '<div class="row"><div class="body"><div class="sub">No course yet.</div></div></div>'}</div>
      <button class="btn sm" type="button" data-act="wAdd" data-list="courses" data-parent="${d.key}" style="margin-top:10px"${I('C-148')}>${ic('plus', 'sm')} Add a course</button></div>`; }).join('')}</div>`;
  if (n === 4) return `<div class="stack"${I('C-149')}>${w.courses.map((k) => { const sp = w.specs.map((s, i) => [s, i]).filter(([s]) => s.course === k.key);
    return `<div class="card"><h3 style="margin-bottom:8px">${esc(k.name)}</h3><div class="list">${sp.length ? sp.map(([s, i]) => (s.locked ? lockedRow(esc(s.name), esc(s.code)) : `<div class="row a1-edit"><div class="a1-cells">${winp(`specs.${i}.code`, s.code, 'Code * (fa)', ' style="max-width:120px"')}${winp(`specs.${i}.name`, s.name, 'Name * (Financial Analytics)')}</div><button class="icon-btn" type="button" data-act="wRm" data-list="specs" data-i="${i}" aria-label="Remove specialization"${I('C-150')}>${ic('trash')}</button></div>`)).join('') : '<div class="row"><div class="body"><div class="sub">None — the course is the whole programme.</div></div></div>'}</div>
      <button class="btn sm" type="button" data-act="wAdd" data-list="specs" data-parent="${k.key}" style="margin-top:10px"${I('C-150')}>${ic('plus', 'sm')} Add a specialization</button></div>`; }).join('')}</div>`;
  if (n === 5) { const yrs = YEARS.map((y) => [y, y]);
    return `<div class="stack"><div class="field" style="max-width:220px"${I('C-151')}><label>Starting year</label>${wsel('start', w.start, yrs, 'Starting year')}</div>
      ${leavesOf(w).map((lf) => { const s = leafState(w, lf); const has = existingBatch(w, lf); const t = defaultTrack(lf.k.id ? course(lf.k.id) : { code: lf.k.code }, lf.s ? (lf.s.id ? spec(lf.s.id) : { code: lf.s.code }) : null); const badSpan = s.inc && !(+s.end > +s.start);
        return `<div class="card"><label class="check"${I('C-152')}><input type="checkbox" data-act-change="x" data-f="w" data-p="leaves.${lf.key}.inc"${s.inc ? ' checked' : ''}><span><b>${esc(lf.k.name)}${lf.s ? ` · ${esc(lf.s.name)}` : ''}</b></span></label>
          <div class="form-grid"${I('C-153')}><div class="field"><label>Start year</label>${wsel(`leaves.${lf.key}.start`, s.start, yrs, 'Start year', s.inc ? '' : ' disabled')}</div><div class="field"><label>End year</label>${wsel(`leaves.${lf.key}.end`, s.end, yrs, 'End year', `${s.inc ? '' : ' disabled'}${badSpan ? ' aria-invalid="true"' : ''}`)}${badSpan ? '<div class="err" role="alert">The end year must come after the start.</div>' : ''}</div></div>
          <div${I('C-154')}>${kv([['Code', esc(leafCode(w, lf, s))], ['Reads as', `${esc(lf.k.name)}${lf.s ? ` - ${esc(lf.s.name)}` : ''} · ${spanLabel(s.start, s.end)}`], ['Runs', `${fmtDate(`${s.start}-07-01`)} → ${fmtDate(`${s.end}-06-30`)}`], ['Degree', lf.k.degree]])}</div>
          <div class="hrow" style="margin-top:8px"${I('C-155')}>${has ? chip('Has a batch already', 'neutral') : ''}${mockChip(t)}</div></div>`; }).join('') || `<div class="card">${U.empty('layers', 'No course to make a batch for')}</div>`}</div>`; }
  const plan = w.plan || planPreview(w); const failed = (w.plan || []).filter((r) => r.status === 'Failed').length; const created = w.plan && !failed;
  return `<div class="stack"><div class="list"${I('C-156')}>${plan.map((r) => U.row({ title: esc(r.name), sub: r.kind, trail: outcomeChip(r), chev: false })).join('')}</div>
    ${failed ? `<div class="banner risk"${I('C-158')}>${ic('alert')}<div class="grow">${failed} row${failed > 1 ? 's' : ''} could not be created. Fix and press Create again; what landed stays.</div><button class="btn sm" type="button" data-act="wRun">Create again</button></div>` : ''}
    ${created ? `<div class="card"${I('C-159')}><h3>Everything is in place.</h3><div class="hrow" style="margin-top:10px"><a class="btn primary" href="#/admin/colleges/${w.cid}">Open College structure</a><a class="btn" href="#/admin/registrations">Approve new students</a><button class="btn" type="button" data-act="wReset">Set up another college</button></div></div>`
      : !failed ? `<button class="btn primary" type="button" data-act="wRun"${I('C-157')}>Create everything · ${plan.filter((r) => r.status === 'New').length}</button>` : ''}</div>`;
}
R.screen('admin/setup', { title: 'Set up a college', render({ query, st }) {
  const qk = `${query.college || ''}|${query.step || ''}`;
  if (!st.w || st.qk !== qk) {
    st.qk = qk; st.w = blankWizard();
    if (query.college && college(query.college)) { loadCollege(st.w, query.college); const s = Math.min(6, Math.max(1, +query.step || 1)); st.w.step = s; st.w.max = s; }
  }
  const w = st.w; const prob = stepProblem(w);
  const leafN = leavesOf(w).filter((lf) => leafState(w, lf).inc).length;
  const rail = `<div class="a1-steps" role="list"${I('C-141')}>${STEP_NAMES.map((t, i) => { const k = i + 1; return `<button type="button" role="listitem" class="${k === w.step ? 'on' : k < w.max || k <= w.max ? 'done' : ''}" data-act="wJump" data-s="${k}"${k <= w.max && k !== w.step ? '' : ' disabled'}${k === w.step ? ' aria-current="step"' : ''}><b>${k}</b><span>${t}</span></button>`; }).join('')}</div>`;
  const foot = w.plan && !w.plan.some((r) => r.status === 'Failed') && w.step === 6 ? '' : `<div class="sticky-act"${I('C-160')}><span class="small muted a1-stepn">Step ${w.step} of 6</span>${w.step > 1 && !w.running ? '<button class="btn" type="button" data-act="wBack">Back</button>' : ''}${w.step < 6 ? `<button class="btn primary" type="button" data-act="wNext"${prob ? ' disabled' : ''}>Continue</button>` : ''}</div><p class="xs muted" data-prob style="margin-top:6px">${w.step < 6 ? esc(prob) : ''}</p>`;
  return U.page({ title: 'Set up a college', back: !!query.college,
    lede: `<span${I('C-140')}>${w.college.name || w.college.code ? `${esc(w.college.name || w.college.code)} · ${w.depts.filter((d) => d.code).length} departments · ${w.courses.length} courses · ${leafN} batches` : 'College, departments, courses, batches — in one go.'}</span>`,
    body: `${rail}<h2 style="margin:4px 0 12px">${w.step}. ${STEP_NAMES[w.step - 1]}</h2>${wizardStep(w)}${foot}` });
}, acts: {
  'input:w'(el, ev, st) { setPath(st.w, el.dataset.p, el.value); const p = stepProblem(st.w); const b = document.querySelector('[data-act="wNext"]'); if (b) b.disabled = !!p; const t = document.querySelector('[data-prob]'); if (t) t.textContent = p; },
  'change:w'(el, ev, st) {
    const w = st.w; const p = el.dataset.p;
    if (p === 'cid') { if (!el.value) { st.w = blankWizard(); st.qk = st.qk; return rr(); } w.cid = el.value; w.loading = true; rr(); setTimeout(() => { w.loading = false; loadCollege(w, el.value); rr(); }, 450); return; }
    if (p === 'start') { w.start = +el.value; Object.values(w.leaves).forEach((l) => { const len = l.end - l.start; l.start = w.start; l.end = w.start + len; }); return rr(); }
    setPath(w, p, el.type === 'checkbox' ? el.checked : /\.(start|end|years)$/.test(p) ? +el.value : el.value); rr();
  },
  wAdd(el, ev, st) { const w = st.w; const l = el.dataset.list; if (l === 'depts') w.depts.push({ key: nk(), code: '', name: '', head: '' }); else if (l === 'courses') w.courses.push({ key: nk(), dept: el.dataset.parent, code: '', name: '', degree: 'PG', years: 2 }); else w.specs.push({ key: nk(), course: el.dataset.parent, code: '', name: '' }); w.plan = null; rr(); },
  wRm(el, ev, st) { const w = st.w; const list = w[el.dataset.list]; const [gone] = list.splice(+el.dataset.i, 1); if (el.dataset.list === 'depts') w.courses = w.courses.filter((k) => k.dept !== gone.key); if (el.dataset.list !== 'specs') w.specs = w.specs.filter((s) => w.courses.some((k) => k.key === s.course)); w.plan = null; rr(); },
  wNext(el, ev, st) { const w = st.w; if (stepProblem(w)) return; w.step++; w.max = Math.max(w.max, w.step); rr(); },
  wBack(el, ev, st) { st.w.step--; rr(); },
  wJump(el, ev, st) { const s = +el.dataset.s; if (s <= st.w.max) { st.w.step = s; rr(); } },
  wRun(el, ev, st) { const w = st.w; w.running = true; el.disabled = true; el.textContent = 'Creating…'; setTimeout(() => { w.plan = runPlan(w); w.running = false; rr(); }, 500); },
  wReset(el, ev, st) { st.w = blankWizard(); R.go('#/admin/setup'); rr(); },
} });
function setPath(o, path, v) { const ks = path.split('.'); let t = o; for (let i = 0; i < ks.length - 1; i++) { const k = ks[i]; if (k.includes('/')) { t = (t[k] ||= {}); continue; } t = t[k]; } t[ks.at(-1)] = v; }

/* ================================================================ Interview records */
const rep = (o, c, d, s, summary, good, work, next) => ({ overall: o, communication: c, domain: d, structure: s, summary, good, work, next });
Object.assign(A, {
  ivs: [
    { id: 901, sid: 's1', track: 'fa', started: '2026-10-06 15:20', dur: '7:42', status: 'Completed', audio: true, skip: null, emitted: 18, persisted: 18, ended: 'verdict and scorecard', report: rep(66, 71, 64, 62, 'Clear on DCF basics; answers lose structure under follow-up questions.', ['Explained WACC with a worked example', 'Calm under a hard follow-up'], ['Lead with the conclusion, then the reasoning'], ['Two-minute pitches on a valuation you have done']), turns: [['Interviewer', 'Welcome, Aarav. Tell me briefly about yourself and why financial analytics.'], ['Student', 'I am an MBA student specialising in financial analytics; my internship was in credit analysis at a regional NBFC.'], ['Interviewer', 'Walk me through how you would value a mid-size FMCG company.'], ['Student', 'I would start with a DCF — projecting free cash flows for five years, then a terminal value…'], ['Interviewer', ''], ['Student', 'Should I continue with the terminal value?']] },
    { id: 902, sid: 's1', track: 'fa', started: '2026-09-26 11:05', dur: '2:10', status: 'Abandoned', audio: false, skip: 'policy_off', emitted: 6, persisted: 6, ended: 'the student ended it', report: null, reportStatus: 'not requested', turns: [['Interviewer', 'Good morning. Shall we begin?'], ['Student', 'Yes, please.']] },
    { id: 903, sid: 's2', track: 'hr', started: '2026-10-05 10:30', dur: '8:00', status: 'Completed', audio: false, skip: 'operator_off', emitted: 20, persisted: 20, ended: 'verdict and scorecard', report: rep(78, 82, 74, 77, 'Confident, specific examples; strong on stakeholder handling.', ['STAR answers with numbers'], ['Shorter openings'], ['Practise a policy-change scenario']), turns: [['Interviewer', 'Tell me about a time you handled conflict in a team.'], ['Student', 'During our CSR project two members disagreed on budget…']] },
    { id: 904, sid: 's5', track: 'hr', started: '2026-10-04 17:45', dur: '4:12', status: 'Failed', audio: false, skip: 'no_consent', emitted: 9, persisted: 6, ended: 'the connection dropped', report: null, reportStatus: 'failed', turns: [['Interviewer', 'Hello Kabir, welcome.'], ['Student', ''], ['Interviewer', 'Could you tell me about your internship?']] },
    { id: 905, sid: 's7', track: 'dm', started: TODAY + ' 09:10', dur: '3:05', status: 'Running', audio: true, skip: null, emitted: 5, persisted: 5, ended: 'still running', report: null, reportStatus: 'pending', turns: [['Interviewer', 'What is a sensible CAC to LTV ratio for a D2C brand?']] },
    { id: 906, sid: 's13', track: null, started: '2026-10-02 14:00', dur: '6:30', status: 'Completed', audio: false, skip: 'nothing_captured', emitted: 14, persisted: 14, ended: 'time limit', report: null, reportStatus: 'not scored — a general interview has no wrap-up', turns: [['Interviewer', 'Tell me about yourself.'], ['Student', 'I am Nikhil, an MCA student who enjoys data work.']] },
    { id: 907, sid: 's2', track: 'hr', started: '2026-09-21 16:00', dur: '7:55', status: 'Completed', audio: true, skip: null, emitted: 19, persisted: 19, ended: 'verdict and scorecard', report: rep(71, 75, 68, null, 'Good examples; structure was not scored.', ['Specific examples'], ['Signpost the answer'], ['A salary negotiation drill']), turns: [] },
    { id: 908, sid: 's8', track: 'fa', started: '2026-08-14 12:20', dur: '7:20', status: 'Completed', audio: false, skip: 'store_full', emitted: 16, persisted: 16, ended: 'verdict and scorecard', report: rep(58, 60, 55, 59, 'Fundamentals present; examples thin.', ['Clear accounting basics'], ['Use one worked example per answer'], ['Ratio analysis on a listed company']), turns: [] },
  ],
  ipol: { 'c1|': { by: 'Placement Office', at: '2026-09-20', transcript: true, audio: false, keep: 180, limit: 900, daily: 8, attempts: 20 } },
});
const IV_TRACKS = [['hr', 'Human Resources'], ['dm', 'Digital Marketing'], ['ba', 'Business Analytics'], ['fa', 'Financial Analytics'], ['generic', 'Generic interview']];
const trackName = (c) => (c ? (IV_TRACKS.find((t) => t[0] === c) || [c, c])[1] : 'Generic interview');
const ivTone = (s) => (s === 'Completed' ? 'good' : s === 'Running' ? 'info' : s === 'Failed' ? 'risk' : 'warn');
const SKIP = { operator_off: 'Recording is switched off on this server, so nothing was captured.', policy_off: 'The college’s interview policy does not allow voice recording.', no_consent: 'The student had not agreed to recording under the current terms.', store_full: 'The recording store was full when this interview ran.', open_failed: 'The recorder could not open a file.', nothing_captured: 'The recorder ran and captured nothing.' };
function ivFiltered(st) {
  const q = (st.q || '').toLowerCase();
  return A.ivs.filter((v) => { const s = stu(v.sid); return (!st.bat || s.batch === st.bat) && (!st.trk || (st.trk === 'generic' ? !v.track : v.track === st.trk)) && (!st.sts || v.status === st.sts) && (!st.rec || v.audio) && (!st.days || ago(v.started) <= +st.days) && (!q || `${s.name} ${s.usn} ${trackName(v.track)}`.toLowerCase().includes(q)); }).sort((a, b) => b.started.localeCompare(a.started));
}
function scoreChart(sid) {
  const mine = A.ivs.filter((v) => v.sid === sid).sort((a, b) => a.started.localeCompare(b.started)); const scored = mine.filter((v) => v.report && v.report.overall != null);
  return `<div class="card flat"${I('C-211')}><h3>Score over time</h3><p class="xs muted" style="margin:2px 0 8px">${mine.length} interview${mine.length === 1 ? '' : 's'} · ${scored.length} scored</p>${scored.length ? `<div class="bars">${scored.map((v) => `<div><span class="num">${v.report.overall}</span><i style="height:${v.report.overall}%"></i><span>${fmtShort(v.started.slice(0, 10))}</span></div>`).join('')}</div>` : '<p class="small muted">No interview scored yet.</p>'}</div>`;
}
function ivDetail(v, st, inPane) {
  if (!v) return `<div class="card">${U.empty('mic', 'Pick an interview')}</div>`;
  const s = stu(v.sid); const tab = st.itab || 'report'; const r = v.report;
  const head = `<div class="card"${I('C-204')}><div class="card-h"><h2>${esc(s.name)}</h2>${chip(v.status, ivTone(v.status))}${inPane ? `<button class="icon-btn" type="button" data-act="closeIv" aria-label="Close">${ic('x')}</button>` : ''}</div><p class="small muted">${esc(s.usn)} · ${trackName(v.track)} · ${esc(v.started)} · ${v.dur}</p>
    <div class="hrow" style="margin-top:10px"${I('C-205')}>${v.audio ? `${chip('Audio stored', 'good')}<button class="btn sm" type="button" data-act="ivAudio" data-id="${v.id}">${ic('download', 'sm')} Download recording</button>` : chip('No audio', 'neutral')}</div>
    <p class="small" style="margin-top:8px"${I('C-206')}>Ended: ${esc(v.ended)} · ${v.emitted} turns, ${v.persisted} saved${v.emitted !== v.persisted ? ` ${chip(`${v.emitted - v.persisted} not saved`, 'risk')}` : ''}</p>
    ${v.skip ? `<div class="banner info" style="margin-top:8px"${I('C-207')}>${ic('info')}<div class="grow">${esc(SKIP[v.skip])}</div>${v.skip === 'policy_off' ? '<button class="btn sm" type="button" data-act="toPolicy">Open the policy card</button>' : ''}</div>` : ''}</div>`;
  const tile = (l, x) => `<div class="kpi"><div class="l">${l}</div><div class="v">${x == null ? '—' : x}</div>${x == null ? '<div class="xs muted">not scored</div>' : '<div class="xs muted">/ 100</div>'}</div>`;
  const report = r ? `<div${I('C-209')}><div class="a1-kpis">${tile('Overall', r.overall)}${tile('Communication', r.communication)}${tile('Domain', r.domain)}${tile('Structure', r.structure)}</div><p class="xs muted" style="margin:8px 0">AI practice score, not a placement decision.</p><p class="small">${esc(r.summary)}</p>
      <div class="grid-3" style="margin-top:10px">${[['What went well', r.good], ['What to work on', r.work], ['Practise next', r.next]].map(([t, l]) => `<div class="card flat"><h3>${t}</h3><ul class="small" style="padding-left:18px;margin-top:6px">${l.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div></div>`
    : `<div class="card flat"${I('C-209')}><p class="small muted">No readable report (${esc(v.reportStatus || 'none')}).</p></div>`;
  const trans = `<div class="chat"${I('C-210')}>${v.turns.length ? v.turns.map(([who, t]) => `<div class="bubble ${who === 'Student' ? 'me' : 'ai'}"><div class="xs" style="opacity:.8">${who}</div>${t ? esc(t) : `<i>not transcribed (${esc(v.status.toLowerCase())})</i>`}</div>`).join('') : '<p class="small muted">No turns were saved.</p>'}</div>`;
  return `<div class="stack">${head}<div class="card">${U.tabs('itab', [['report', 'Report'], ['transcript', 'Transcript']], tab, I('C-208'))}${tab === 'report' ? report : trans}</div>${scoreChart(v.sid)}</div>`;
}
function policyCard(st) {
  const cid = st.pc || 'c1'; const kid = st.pk || ''; const key = `${cid}|${kid}`; const p = A.ipol[key];
  const d = p || { transcript: true, audio: false, keep: 180, limit: 900, daily: 8, attempts: 20 };
  const coursesHere = A.courses.filter((k) => deptsOf(cid).some((x) => x.id === k.dept));
  return `<div class="card" id="policy-card" data-pol><div class="card-h"><h2>Interview policy</h2><span${I('C-213')}>${p ? chip(`Configured · ${p.by}, ${fmtShort(p.at)}`, 'good') : chip('Not configured · deployment defaults', 'neutral')}</span></div>
    <div class="filters"${I('C-212')}>${U.select('pc', A.colleges.map((c) => [c.id, c.name]), cid, '', 'College')}${U.select('pk', [['', 'The whole college'], ...coursesHere.map((k) => [k.id, `${k.name} only`])], kid, '', 'Applies to')}</div>
    ${A.serverRecording ? '' : `<div class="banner warn" style="margin-bottom:10px"${I('C-214')}>${ic('alert')}<div>Recording is switched off on this server. “Allow voice recording” records nothing until the operator turns it on.</div></div>`}
    <label class="check"${I('C-215')}><input type="checkbox" name="transcript"${d.transcript ? ' checked' : ''}><span>Keep the transcript</span></label>
    <label class="check"${I('C-216')}><input type="checkbox" name="audio"${d.audio ? ' checked' : ''}><span>Allow voice recording<br><span class="xs muted">Staff can listen. The student is shown these terms at their next Start.</span></span></label>
    <div class="form-grid"${I('C-217')}>${U.field({ id: 'keep', label: 'Keep for (days)', type: 'number', value: d.keep, attrs: ' min="1" max="3650"' })}${U.field({ id: 'limit', label: 'Time limit (seconds)', type: 'number', value: d.limit, attrs: ' min="60" max="3600"' })}${U.field({ id: 'daily', label: 'Completed per day', type: 'number', value: d.daily, attrs: ' min="1" max="100"' })}${U.field({ id: 'attempts', label: 'Attempts per day', type: 'number', value: d.attempts, attrs: ' min="1" max="500"' })}</div>
    <div class="err" role="alert" data-err="caporder"${I('C-218')}></div>
    <button class="btn primary" type="button" data-act="savePol" style="margin-top:8px"${I('C-219')}>Save policy</button></div>`;
}
R.screen('admin/interviews', { title: 'Interview records', states: ids(I('C-203')), render({ id, st }) {
  if (id && !wide()) { const v = A.ivs.find((x) => String(x.id) === id); return U.page({ title: v ? stu(v.sid).name : 'Interview', back: true, body: ivDetail(v, st, false) }); }
  const rows = ivFiltered(st); const shown = rows.slice(0, st.more ? rows.length : 6);
  const picked = (st.picked || []).filter((x) => rows.some((v) => v.id === x)); st.picked = picked;
  const withAudio = picked.filter((x) => A.ivs.find((v) => v.id === x).audio).length;
  const scored = rows.filter((v) => v.report && v.report.overall != null);
  const filtering = st.bat || st.trk || st.sts || st.rec || st.days || st.q;
  const list = shown.length ? `<div class="list"${I('C-201')}>${shown.map((v) => { const s = stu(v.sid); return crow({ box: ck('pick', v.id, picked.includes(v.id)), href: `#/admin/interviews/${v.id}`, sel: String(st.sel || id) === String(v.id), title: esc(s.name), sub: `${esc(s.usn)} · ${trackName(v.track)} · ${esc(v.started)} · ${v.dur} · score ${v.report && v.report.overall != null ? v.report.overall : '—'} · ${v.audio ? '<b>Audio</b>' : `<span title="${esc(SKIP[v.skip] || '')}">No audio</span>`}`, trail: chip(v.status, ivTone(v.status)) }); }).join('')}</div>`
    : `<div class="card"${I('C-203')}>${U.empty('mic', filtering ? 'No interview matches these filters.' : 'No interview yet.')}</div>`;
  const selRow = A.ivs.find((x) => String(x.id) === String(id || st.sel)) || (wide() ? shown[0] : null);
  return U.page({ title: 'Interview records', lede: `<span${I('C-191')}>${rows.length} interviews · ${new Set(rows.map((v) => v.sid)).size} students</span>`,
    acts: `<button class="btn" type="button" data-act="ivCsv"${I('C-192')}>${ic('download', 'sm')} Export CSV</button><button class="btn" type="button" data-act="ivZip"${withAudio ? '' : ' disabled'}${I('C-193')}>${ic('download', 'sm')} Download selected audio${withAudio ? ` · ${withAudio}` : ''}</button>`,
    body: `<div class="filters">${U.select('bat', opt(A.batches.map((b) => [b.id, batchLabel(b)]), 'All batches'), st.bat || '', I('C-194'), 'Batch')}${U.select('trk', opt(IV_TRACKS, 'All tracks'), st.trk || '', I('C-195'), 'Track')}${U.select('sts', opt(['Completed', 'Abandoned', 'Failed', 'Running'].map((x) => [x, x]), 'All statuses'), st.sts || '', I('C-196'), 'Status')}${U.select('rec', [['', 'Any recording'], ['1', 'Recorded only']], st.rec || '', I('C-197'), 'Recording')}${U.select('days', [['', 'Whole record'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']], st.days || '', I('C-198'), 'Date')}</div>
      <div class="a1-kpis" style="margin-bottom:12px"${I('C-199')}>${U.kpi(rows.length, `Interviews · ${rows.filter((v) => v.audio).length} with a recording`)}${U.kpi(scored.length ? Math.round(scored.reduce((t, v) => t + v.report.overall, 0) / scored.length) : '—', 'Average score')}${U.kpi(rows.filter((v) => v.status === 'Completed').length, `Completed · ${rows.filter((v) => v.status === 'Abandoned').length} abandoned · ${rows.filter((v) => v.status === 'Failed').length} failed · ${rows.filter((v) => v.status === 'Running').length} running`)}</div>
      <div class="filters">${U.search('q', st.q || '', 'Search…', I('C-200'))}</div>
      <div class="split"><div class="stack">${list}<div class="hrow"${I('C-202')}><span class="xs muted grow">${rows.length} match · the newest ${shown.length} are loaded · ${picked.length} ticked</span>${shown.length < rows.length ? '<button class="btn sm" type="button" data-act="more">Load more</button>' : ''}</div></div><div class="detail-pane">${ivDetail(selRow, st, true)}</div></div>
      ${U.section('Interview policy', policyCard(st))}` });
}, mount(main, { st }) { if (st.scrollPolicy) { st.scrollPolicy = false; const c = main.querySelector('#policy-card'); if (c) c.scrollIntoView({ behavior: 'smooth' }); } },
acts: {
  'change:pick'(el, ev, st) { const v = +el.value; st.picked = el.checked ? [...new Set([...(st.picked || []), v])] : (st.picked || []).filter((x) => x !== v); rr(); },
  more(el, ev, st) { st.more = true; rr(); },
  closeIv(el, ev, st) { st.sel = 'none'; R.go('#/admin/interviews'); rr(); },
  toPolicy(el, ev, st) { st.scrollPolicy = true; if (R.parse().parts[2]) R.go('#/admin/interviews'); else rr(); },
  ivAudio: (el) => fakeDownload(`interview-${el.dataset.id}.zip`),
  ivZip(el, ev, st) { const n = st.picked.filter((x) => A.ivs.find((v) => v.id === x).audio); fakeDownload(`reep-interview-audio-${n.length}.zip`); },
  ivCsv(el, ev, st) { el.textContent = 'Preparing…'; el.disabled = true; setTimeout(() => { csv('reep-interviews.csv', [['USN', 'Student', 'Track', 'Started', 'Duration', 'Score', 'Audio', 'Status'], ...ivFiltered(st).map((v) => { const s = stu(v.sid); return [s.usn, s.name, trackName(v.track), v.started, v.dur, v.report && v.report.overall != null ? v.report.overall : '', v.audio ? 'yes' : 'no', v.status]; })]); rr(); }, 400); },
  savePol(el, ev, st) {
    const root = el.closest('[data-pol]'); const v = formVals(root); const e = {};
    [['keep', 1, 3650, 'Keep for'], ['limit', 60, 3600, 'Time limit'], ['daily', 1, 100, 'Completed per day'], ['attempts', 1, 500, 'Attempts per day']].forEach(([k, lo, hi, l]) => { if (!/^\d+$/.test(v[k]) || +v[k] < lo || +v[k] > hi) e[k] = `${l} must be a whole number from ${lo} to ${hi}.`; });
    if (!e.daily && !e.attempts && +v.attempts < +v.daily) e.caporder = 'Attempts per day cannot be lower than completed per day.';
    if (!errs(root, e)) return;
    const key = `${st.pc || 'c1'}|${st.pk || ''}`; const prev = A.ipol[key];
    A.ipol[key] = { by: 'Placement Office', at: TODAY, transcript: v.transcript, audio: v.audio, keep: +v.keep, limit: +v.limit, daily: +v.daily, attempts: +v.attempts };
    toast(prev && ((prev.transcript && !v.transcript) || (prev.audio && !v.audio)) ? 'Saved. Running interviews that relied on the removed scope stop now.' : 'Policy saved'); rr();
  },
} });

/* ================================================================ Interview questions */
const PHASES = [['opening', 'Opening'], ['probing', 'Probing'], ['deep_dive', 'Deep dive'], ['wrap_up', 'Wrap-up']];
const phaseName = (p) => (PHASES.find((x) => x[0] === p) || [p, p])[1];
const NOVA = ['ambre', 'amy', 'arjun', 'beatrice', 'carlos', 'carolina', 'florian', 'kiara', 'lennart', 'leo', 'lorenzo', 'lupe', 'matthew', 'olivia', 'tiffany'];
let qid = 500;
const qs = (list) => list.map(([phase, text, enabled = true]) => ({ id: ++qid, phase, text, enabled }));
A.tracks ||= [
  { code: 'hr', label: 'Human Resources', voice: 'kiara', persona: 'Senior HR business partner at a large IT services company', sample: 'Tell me about a time you handled a conflict between two team members.', frameworks: 'STAR, Ulrich model', syllabus: 'Recruitment, appraisal, labour law basics', enabled: true, scope: 'Every college', builtin: false,
    questions: qs([['opening', 'Introduce yourself and tell me why you chose HR.'], ['probing', 'How would you design an onboarding plan for 200 freshers?'], ['probing', 'What would you do if a manager refuses to follow the appraisal calendar?'], ['deep_dive', 'Walk me through how you would reduce first-year attrition by a third.'], ['wrap_up', 'What questions do you have for us?'], ['probing', 'Explain the difference between CTC and take-home pay to a new joiner.', false]]) },
  { code: 'dm', label: 'Digital Marketing', voice: 'tiffany', persona: 'Growth CMO at a D2C consumer brand', sample: 'How would you bring down customer acquisition cost for a new skincare launch?', frameworks: 'AARRR, 4Ps', syllabus: 'SEO, paid media, analytics', enabled: true, scope: 'Every college', builtin: false,
    questions: qs([['opening', 'Tell me about a campaign you admired and why.'], ['probing', 'What is a sensible CAC to LTV ratio, and why?'], ['deep_dive', 'Plan a 90-day launch with a ₹10 lakh budget.']]) },
  { code: 'ba', label: 'Business Analytics', voice: 'arjun', persona: 'Analytics lead at a retail bank', sample: 'How would you decide which branches to close using data?', frameworks: 'CRISP-DM', syllabus: 'SQL, regression, dashboards', enabled: true, scope: 'Every college', builtin: false,
    questions: qs([['opening', 'Which analysis are you proudest of?'], ['probing', 'How do you explain a p-value to a branch manager?']]) },
  { code: 'fa', label: 'Financial Analytics', voice: 'matthew', persona: 'Equity research head at a mid-size brokerage', sample: 'Walk me through valuing a mid-size FMCG company.', frameworks: 'DCF, comparables', syllabus: 'Valuation, ratio analysis, credit', enabled: true, scope: 'Every college', builtin: false,
    questions: qs([['opening', 'Why financial analytics, and why now?'], ['probing', 'What drives working capital in an FMCG business?'], ['deep_dive', 'Build a quick DCF for a company growing 12% a year.'], ['wrap_up', 'Anything you would like to ask me?']]) },
  { code: 'lsc', label: 'Logistics & Supply Chain', voice: 'leo', persona: 'Supply chain head at a third-party logistics firm', sample: 'How would you cut last-mile delivery cost in a tier-2 city?', frameworks: 'SCOR', syllabus: '', enabled: false, scope: 'One college', builtin: false, questions: [] },
  { code: 'generic', label: 'Generic interview', voice: '', persona: 'Campus recruiter', sample: 'Tell me about yourself.', frameworks: '', syllabus: '', enabled: true, scope: 'Every college', builtin: true, questions: [] },
];
const trackErrs = (v, isNew) => { const e = {}; if (isNew) { if ((v.tc || '').length < 2) e.tc = 'Code needs at least 2 characters.'; else if (A.tracks.some((t) => t.code === v.tc.toLowerCase())) e.tc = `${v.tc} is already a track.`; if ((v.tn || '').length < 2) e.tn = 'Name needs at least 2 characters.'; }
  if ((v.tp || '').length < 3) e.tp = 'Interviewer role is required.'; if ((v.ts || '').length < 12) e.ts = 'The sample question needs at least 12 characters.'; if (v.tv && !NOVA.includes(v.tv)) e.tv = 'Pick a known voice.'; return e; };
const trackFields = (t, isNew) => `${isNew ? `<div class="form-grid">${U.field({ id: 'tc', label: 'Code', req: true, ph: 'ops' })}${U.field({ id: 'tn', label: 'Name', req: true, ph: 'Operations' })}</div>` : ''}
  ${U.field({ id: 'tp', label: 'Interviewer role', req: true, value: t.persona, ph: 'Plant head at an auto-components maker' })}${U.field({ id: 'ts', label: 'Sample question', type: 'textarea', req: true, value: t.sample })}
  <div class="form-grid">${U.field({ id: 'tf', label: 'Frameworks', value: t.frameworks, ph: 'Lean, Six Sigma' })}${isNew ? '' : U.field({ id: 'ty', label: 'Syllabus', value: t.syllabus })}${U.field({ id: 'tv', label: 'Voice', value: t.voice, opts: [['', 'Default'], ...NOVA.map((n) => [n, n])] })}</div>`;
function openNewTrack(st) {
  const el = Sheet.open({ title: 'New track', body: `<div class="stack"${I('C-224')}>${trackFields({ persona: '', sample: '', frameworks: '', voice: '' }, true)}</div>`,
    foot: `<button class="btn" type="button" data-sheet-close${I('C-225')}>Cancel</button><button class="btn primary" type="button" data-act="ok" disabled${I('C-225')}>Create track</button>`,
    onAct: { ok: (a, ev, sh) => { const v = formVals(sh); if (!errs(sh, trackErrs(v, true))) return; const code = v.tc.toLowerCase();
      A.tracks.splice(A.tracks.length - 1, 0, { code, label: v.tn, voice: v.tv, persona: v.tp, sample: v.ts, frameworks: v.tf, syllabus: '', enabled: true, scope: 'Every college', builtin: false, questions: [] });
      Sheet.close(); st.track = code; const users = [...A.specs, ...A.courses].filter((x) => x.code.toLowerCase() === code); say(st, users.length ? `Created ${v.tn}. Students on ${users.map((x) => x.name).join(', ')} are preselected for it.` : `Created ${v.tn}. No course or specialization uses the code ${code} yet.`); rr(); } } });
  const sync = () => { el.querySelector('[data-act="ok"]').disabled = Object.keys(trackErrs(formVals(el), true)).length > 0; }; el.addEventListener('input', sync); el.addEventListener('change', sync);
}
function parseLines(text) {
  const added = [], bad = [];
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => { const m = /^\[([^\]]+)\]\s*(.*)$/.exec(l); let phase = 'probing', q = l;
    if (m) { const p = PHASES.find(([k, n]) => k === m[1].toLowerCase().replace(/[\s-]/g, '_') || n.toLowerCase() === m[1].toLowerCase()); if (!p) { bad.push([l, `unknown phase “${m[1]}”`]); return; } phase = p[0]; q = m[2]; }
    q = q.replace(/^"|"$/g, ''); if (q.length < 8) bad.push([l, 'shorter than 8 characters']); else if (q.length > 600) bad.push([l.slice(0, 40) + '…', 'longer than 600 characters']); else added.push({ phase, text: q }); });
  return { added, bad };
}
R.screen('admin/interview-questions', { title: 'Interview questions', render({ st }) {
  const tracks = A.tracks; const t = tracks.find((x) => x.code === st.track) || tracks[0];
  const total = tracks.reduce((n, x) => n + x.questions.length, 0);
  const pills = tracks.length ? `<div class="a1-pills" role="tablist"${I('C-223')}>${tracks.map((x) => `<button type="button" role="tab" data-act="pickTrack" data-c="${x.code}" aria-selected="${x === t}"><i class="a1-dot${x.enabled ? ' on' : ''}"></i>${esc(x.label)} <span class="num muted">${x.questions.length}</span></button>`).join('')}</div>` : `<div${I('C-223')}>${U.empty('mic', 'No interview track yet.')}</div>`;
  if (!t) return U.page({ title: 'Interview questions', body: pills });
  const ro = t.builtin;
  const card = `<div class="card" data-track><div class="card-h"><h2>${esc(t.label)} <span class="xs muted">${esc(t.code)}</span></h2><span class="hrow"${I('C-226')}>${chip(t.scope, 'info')}${t.enabled ? chip('Offered', 'good') : chip('Not offered', 'neutral')}</span></div>
    ${ro ? `<div class="banner info" style="margin-bottom:10px"${I('C-227')}>${ic('lock')}<div>Built-in track, not editable here. Save a copy as a new track to change it.</div></div>` : ''}
    <fieldset class="a1-fs" ${ro ? 'disabled' : ''}${I('C-228')}>${trackFields(t, false)}</fieldset>
    <label class="check"${I('C-229')}><input type="checkbox" name="ten"${t.enabled ? ' checked' : ''}${ro ? ' disabled' : ''}><span>Offered to students</span></label>
    ${st.notes && st.notes.length ? `<div class="banner warn" style="margin:6px 0"><div><b>Saved, with a note:</b><ul style="padding-left:18px">${st.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></div>` : ''}
    <div class="hrow"><button class="btn primary" type="button" data-act="saveTrack"${ro ? ' disabled' : ''}${I('C-230')}>Save</button><button class="btn danger" type="button" data-act="rmTrack"${ro ? ' disabled' : ''}${I('C-231')}>Remove</button></div></div>`;
  const q = (st.q || '').toLowerCase(); const searching = !!q;
  const all = t.questions; const rows = all.filter((x) => !q || `${x.text} ${phaseName(x.phase)}`.toLowerCase().includes(q));
  const pg = pager(st, rows.length, [10, 25, 50, 100], I('C-243'));
  const page = rows.slice(pg.from - 1, pg.to); const picked = (st.picked || []).filter((x) => all.some((y) => y.id === x)); st.picked = picked;
  const allTicked = page.length && page.every((x) => picked.includes(x.id));
  const addOne = st.addOne ? `<div class="card flat" data-addone${I('C-233')}><div class="form-grid">${U.field({ id: 'qp', label: 'Phase', opts: PHASES, value: 'probing' })}</div>${U.field({ id: 'qt', label: 'Question', type: 'textarea', hint: '<span data-qcount>0</span> / 600', attrs: ' maxlength="600"' })}<div class="hrow"><button class="btn primary" type="button" data-act="addQ">Add to ${esc(t.label)}</button><button class="btn" type="button" data-act="tog" data-k="addOne">Cancel</button></div></div>` : '';
  const addMany = st.addMany ? `<div class="card flat" data-addmany${I('C-234')}>${U.field({ id: 'qm', label: 'One question per line', type: 'textarea', hint: '[phase] prefix optional, e.g. [Deep dive] Walk me through…', value: st.many || '' })}
      <label class="btn sm" style="cursor:pointer"${I('C-235')}>${ic('upload', 'sm')} Choose a .txt or .csv<input class="a1-file" type="file" accept=".txt,.csv,text/plain,text/csv" data-qfile></label>
      ${st.notAdded && st.notAdded.length ? `<div class="banner warn" style="margin-top:8px"><div><b>Not added:</b><ul style="padding-left:18px">${st.notAdded.map(([l, why]) => `<li>${esc(l)} — ${esc(why)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="hrow" style="margin-top:8px"${I('C-236')}><button class="btn primary" type="button" data-act="addMany">Add all</button><button class="btn" type="button" data-act="tog" data-k="addMany">Cancel</button></div></div>` : '';
  const table = page.length ? `<div class="list"${I('C-239')}>${page.map((x) => { const i = all.indexOf(x);
    return `<div class="row a1-q-row"><label class="a1-ck"><input type="checkbox" data-act-change="x" data-f="qpick" value="${x.id}"${picked.includes(x.id) ? ' checked' : ''}${ro ? ' disabled' : ''}><span class="sr">Select</span></label><span class="num small muted">${i + 1}</span>
      <div class="body"><select class="input a1-phase" data-act-change="x" data-f="qphase" data-id="${x.id}" aria-label="Phase"${ro ? ' disabled' : ''}>${PHASES.map(([k, n]) => `<option value="${k}"${k === x.phase ? ' selected' : ''}>${n}</option>`).join('')}</select><textarea class="input a1-qtext" data-qedit="${x.id}" aria-label="Question ${i + 1}"${ro ? ' disabled' : ''}>${esc(x.text)}</textarea><div class="err" role="alert" data-qerr="${x.id}"></div></div>
      <div class="trail a1-qtools"><button class="chip ${x.enabled ? 'good' : 'neutral'} a1-chipbtn" type="button" data-act="qToggle" data-id="${x.id}"${ro ? ' disabled' : ''}${I('C-240')}>${x.enabled ? 'Asked' : 'Paused'}</button>
        <button class="icon-btn" type="button" data-act="qMove" data-id="${x.id}" data-d="-1" aria-label="Move up"${i === 0 || searching || ro ? ' disabled' : ''}${I('C-241')}>${ic('back', 'sm')}</button><button class="icon-btn" type="button" data-act="qMove" data-id="${x.id}" data-d="1" aria-label="Move down"${i === all.length - 1 || searching || ro ? ' disabled' : ''}${I('C-241')}>${ic('chev', 'sm')}</button>
        <button class="icon-btn" type="button" data-act="qDel" data-id="${x.id}" aria-label="Remove question"${ro ? ' disabled' : ''}${I('C-242')}>${ic('trash')}</button></div></div>`; }).join('')}</div>`
    : `<div class="card"${I('C-239')}>${U.empty('list', q ? `No question matches “${esc(st.q)}”.` : 'No question on this track yet.')}</div>`;
  const qcard = `<div class="card"><div class="card-h"><h2${I('C-232')}>Questions · ${all.length} <span class="xs muted">${all.filter((x) => x.enabled).length} asked · ${all.filter((x) => !x.enabled).length} paused</span></h2></div>
    ${ro ? '' : `<div class="hrow" style="margin-bottom:10px"><button class="btn sm" type="button" data-act="tog" data-k="addOne" aria-expanded="${!!st.addOne}">${ic('plus', 'sm')} Add one</button><button class="btn sm" type="button" data-act="tog" data-k="addMany" aria-expanded="${!!st.addMany}">${ic('list', 'sm')} Add many</button></div>`}${addOne}${addMany}
    <div class="filters" style="margin-top:8px">${U.search('q', st.q || '', 'Search questions…', I('C-237'))}</div>
    <div class="hrow" style="margin-bottom:8px"${I('C-238')}><label class="check" style="min-height:0;padding:0"><input type="checkbox" data-act-change="x" data-f="qall"${allTicked ? ' checked' : ''}${ro ? ' disabled' : ''}><span class="small">Tick this page</span></label><span class="grow"></span><button class="btn sm" type="button" data-act="qBulk" data-on="1"${picked.length ? '' : ' disabled'}>Enable</button><button class="btn sm" type="button" data-act="qBulk" data-on="0"${picked.length ? '' : ' disabled'}>Pause</button></div>
    ${table}<p class="xs muted" style="margin-top:6px">Rows ${rows.length} · Selected ${picked.length}</p>${pg.html}</div>`;
  return U.page({ title: 'Interview questions', lede: `<span${I('C-220')}>${tracks.length} tracks · ${total} questions</span>`,
    acts: `<button class="btn primary" type="button" data-act="newTrack"${I('C-221')}>${ic('plus', 'sm')} Add track</button>`,
    body: `${flashBar(st, I('C-222'))}${pills}<div class="grid-2" style="align-items:start">${card}${qcard}</div>` });
}, mount(main, { st }) {
  main.querySelectorAll('[data-qedit]').forEach((ta) => ta.addEventListener('blur', () => { const t = A.tracks.find((x) => x.code === (st.track || A.tracks[0].code)); const q = t.questions.find((x) => x.id === +ta.dataset.qedit); const v = ta.value.trim(); const box = main.querySelector(`[data-qerr="${q.id}"]`);
    if (v === q.text) return; if (v.length < 8) { ta.value = q.text; box.textContent = 'A question needs at least 8 characters. Put back as it was.'; return; } q.text = v.slice(0, 600); box.textContent = ''; toast('Question saved'); }));
  const qt = main.querySelector('#qt'); if (qt) qt.addEventListener('input', () => { main.querySelector('[data-qcount]').textContent = qt.value.length; });
  const f = main.querySelector('[data-qfile]'); if (f) f.addEventListener('change', () => { const file = f.files[0]; if (!file) return; const r = new FileReader(); r.onload = () => { const box = main.querySelector('#qm'); box.value = String(r.result).split(/\r?\n/).map((l) => l.replace(/^"|"$/g, '').replace(/",".*$/, '')).join('\n'); st.many = box.value; toast(`${file.name} loaded — check it, then Add all`); }; r.readAsText(file); });
}, acts: {
  dismiss, page: pageAct,
  newTrack: (el, ev, st) => openNewTrack(st),
  pickTrack(el, ev, st) { st.track = el.dataset.c; st.picked = []; st.page = 1; st.notes = null; st.notAdded = null; rr(); },
  tog(el, ev, st) { st[el.dataset.k] = !st[el.dataset.k]; st.notAdded = null; rr(); },
  saveTrack(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; const root = el.closest('[data-track]'); const v = formVals(root); if (!errs(root, trackErrs(v, false))) return;
    Object.assign(t, { persona: v.tp, sample: v.ts, frameworks: v.tf, syllabus: v.ty, voice: v.tv, enabled: v.ten });
    const users = [...A.specs, ...A.courses].filter((x) => x.code.toLowerCase() === t.code); st.notes = []; if (!users.length) st.notes.push(`No course or specialization uses the code ${t.code}, so no student is preselected for this track.`); if (!t.enabled) st.notes.push('An unoffered track is not preselected for anybody.');
    if (!st.notes.length) { st.notes = null; say(st, `Saved ${t.label}.`); } rr(); },
  rmTrack(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; Sheet.confirm({ title: 'Remove this track?', text: `Remove the ${esc(t.label)} track? Its questions stay in the bank.`, ok: 'Remove', danger: true, onOk: () => { A.tracks.splice(A.tracks.indexOf(t), 1); st.track = null; say(st, `${t.label} removed.`); rr(); } }); },
  addQ(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; const root = el.closest('[data-addone]'); const v = formVals(root); if (!errs(root, v.qt.length < 8 ? { qt: 'A question needs 8 to 600 characters.' } : {})) return; t.questions.push({ id: ++qid, phase: v.qp, text: v.qt, enabled: true }); say(st, `Added to ${t.label}.`); rr(); },
  addMany(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; const box = document.getElementById('qm'); const { added, bad } = parseLines(box.value); added.forEach((x) => t.questions.push({ id: ++qid, ...x, enabled: true })); st.notAdded = bad; st.many = bad.map(([l]) => l).join('\n'); say(st, `Added ${added.length}, skipped ${bad.length}.`, bad.length ? 'warn' : 'good'); if (!bad.length) st.addMany = false; rr(); },
  'change:qpick'(el, ev, st) { const v = +el.value; st.picked = el.checked ? [...new Set([...(st.picked || []), v])] : (st.picked || []).filter((x) => x !== v); rr(); },
  'change:qall'(el, ev, st) { const page = [...document.querySelectorAll('[data-f="qpick"]')].map((x) => +x.value); st.picked = el.checked ? [...new Set([...(st.picked || []), ...page])] : (st.picked || []).filter((x) => !page.includes(x)); rr(); },
  'change:qphase'(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; t.questions.find((x) => x.id === +el.dataset.id).phase = el.value; toast(`Moved to ${phaseName(el.value)}`); },
  qBulk(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; t.questions.filter((x) => st.picked.includes(x.id)).forEach((x) => { x.enabled = el.dataset.on === '1'; }); say(st, `${st.picked.length} question${st.picked.length > 1 ? 's' : ''} ${el.dataset.on === '1' ? 'enabled' : 'paused'}.`); st.picked = []; rr(); },
  qToggle(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; const q = t.questions.find((x) => x.id === +el.dataset.id); q.enabled = !q.enabled; rr(); },
  qMove(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; const l = t.questions; const i = l.findIndex((x) => x.id === +el.dataset.id); const j = i + +el.dataset.d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; rr(); },
  qDel(el, ev, st) { const t = A.tracks.find((x) => x.code === st.track) || A.tracks[0]; Sheet.confirm({ title: 'Remove this question?', text: 'Remove this question?', ok: 'Remove', danger: true, onOk: () => { t.questions = t.questions.filter((x) => x.id !== +el.dataset.id); rr(); } }); },
} });

/* ================================================================ Job postings */
Object.assign(A, {
  criteria: { cgpa: 6.0, backlogs: 0 },
  jobs: [
    { id: 1, title: 'Credit Analyst', company: 'Kaveri Finance Ltd', loc: 'Bengaluru', tracks: ['FA'], ctc: 6.5, deadline: addDays(TODAY, 3), applied: 12, withdrawn: false, college: 'c1', course: 'k1', level: 'PG', link: 'https://careers.kaverifinance.example.com/credit-analyst', skills: ['Excel', 'Ratio analysis'] },
    { id: 2, title: 'Management Trainee — Sales', company: 'Deccan Consumer Goods', loc: 'Hyderabad', tracks: [], ctc: 5.2, deadline: addDays(TODAY, 15), applied: 31, withdrawn: false, college: null, course: null, level: 'PG', link: 'https://jobs.deccancg.example.com/mt-sales', skills: [] },
    { id: 3, title: 'Business Analyst', company: 'Tungabhadra Analytics', loc: 'Pune', tracks: ['BA'], ctc: 7.0, deadline: TODAY, applied: 8, withdrawn: false, college: null, course: null, level: 'PG', link: 'https://tungabhadra.example.com/apply/ba', skills: ['SQL'] },
    { id: 4, title: 'Equity Research Associate', company: 'Western Ghats Capital', loc: 'Mumbai', tracks: ['FA'], ctc: 9.0, deadline: addDays(TODAY, -2), applied: 5, withdrawn: false, college: 'c1', course: null, level: 'PG', link: 'https://wgcapital.example.com/careers/era', skills: [] },
    { id: 5, title: 'HR Generalist', company: 'Hampi Hospitality Group', loc: 'Mysuru', tracks: ['HR'], ctc: 4.8, deadline: null, applied: 0, withdrawn: false, college: 'c2', course: null, level: 'PG', link: 'https://hampihg.example.com/jobs/hr', skills: [] },
    { id: 6, title: 'Digital Marketing Executive', company: 'Malnad Coffee Co.', loc: 'Chikkamagaluru', tracks: ['DM'], ctc: 4.2, deadline: addDays(TODAY, -20), applied: 14, withdrawn: true, college: null, course: null, level: 'PG', link: 'https://malnadcoffee.example.com/dm', skills: [] },
    { id: 7, title: 'Operations Associate', company: 'Coastal Freight Lines', loc: 'Mangaluru', tracks: [], ctc: null, deadline: addDays(TODAY, 40), applied: 2, withdrawn: false, college: null, course: null, level: 'UG', link: 'https://coastalfreight.example.com/ops', skills: [] },
  ],
});
const daysTo = (d) => -ago(d);
const jobStatus = (j) => (j.withdrawn ? ['Withdrawn', 'neutral'] : !j.deadline ? ['Open · no deadline', 'good'] : daysTo(j.deadline) < 0 ? ['Past deadline', 'risk'] : daysTo(j.deadline) === 0 ? ['Closes today', 'warn'] : daysTo(j.deadline) <= 7 ? [`Closes in ${daysTo(j.deadline)} days`, 'warn'] : ['Open', 'good']);
const JOB_COLS = [['track', 'Track'], ['ctc', 'CTC'], ['deadline', 'Deadline'], ['applied', 'Applied'], ['college', 'College'], ['course', 'Course'], ['cgpa', 'Min CGPA'], ['backlogs', 'Max backlogs'], ['level', 'Level']];
function jobFiltered(st) {
  const q = (st.q || '').toLowerCase();
  const sc = (val, f) => !f || (f === 'every' ? !val : val === f || !val);
  return A.jobs.filter((j) => sc(j.college, st.col) && sc(j.course, st.crs) && (!st.trk || (st.trk === 'every' ? !j.tracks.length : j.tracks.includes(st.trk) || !j.tracks.length))
    && (!st.sts || (st.sts === 'boards' ? !j.withdrawn : st.sts === 'week' ? !j.withdrawn && j.deadline && daysTo(j.deadline) >= 0 && daysTo(j.deadline) <= 7 : st.sts === 'past' ? !j.withdrawn && j.deadline && daysTo(j.deadline) < 0 : j.withdrawn))
    && (!q || `${j.title} ${j.company} ${j.loc}`.toLowerCase().includes(q)));
}
function openPost(st, from) {
  const j = from || { title: '', company: '', loc: '', level: 'PG', deadline: '', tracks: [], college: '', course: '', link: '', skills: [] };
  const where = (c, k) => (k ? `Publishes to ${course(k).name} students at ${college(c).name}.` : c ? `Publishes to every course at ${college(c).name}.` : 'Publishes to every college and course.');
  const el = Sheet.open({ title: from ? `Post a copy of ${from.title}` : 'Post a job', body: `<div class="stack"><div class="form-grid"${I('C-261')}>${U.field({ id: 'jt', label: 'Title', req: true, value: j.title, ph: 'HR Generalist' })}${U.field({ id: 'jc', label: 'Company', req: true, value: j.company, ph: 'Hampi Hospitality Group' })}${U.field({ id: 'jl', label: 'Location', value: j.loc, ph: 'Mysuru' })}</div>
    <div class="form-grid"${I('C-262')}>${U.field({ id: 'jv', label: 'Level', value: j.level, opts: [['PG', 'PG'], ['UG', 'UG']], hint: 'Decides which board it appears on.' })}${U.field({ id: 'jd', label: 'Deadline', type: 'date', value: j.deadline || '' })}</div>
    <div${I('C-263')}>${U.field({ id: 'jk', label: 'Tracks', value: j.tracks.join(', '), ph: 'HR, DM', hint: '<span data-tprev>Empty — every track sees it.</span>', attrs: ' data-act-input="x" data-f="jk"' })}</div>
    <div class="hrow"${I('C-264')}>${chip(`Min CGPA ${A.criteria.cgpa.toFixed(1)}`, 'neutral')}${chip(`Max backlogs ${A.criteria.backlogs}`, 'neutral')}<span class="chip info">${ic('lock', 'sm')} Synced</span></div>
    ${j.skills.length ? `<p class="xs muted">Required skills carried over: ${j.skills.map(esc).join(', ')}</p>` : ''}
    <div class="form-grid"${I('C-265')}>${U.field({ id: 'js', label: 'College', value: j.college || '', opts: opt(A.colleges.map((c) => [c.id, c.name]), 'Every college'), attrs: ' data-act-change="x" data-f="js"' })}${U.field({ id: 'jo', label: 'Course', value: j.course || '', opts: opt(A.courses.filter((k) => k.status === 'Active').map((k) => [k.id, `${k.name} · ${college(dept(k.dept).college).code}`]), 'Every course'), attrs: ' data-act-change="x" data-f="jo"' })}</div>
    <p class="small muted" data-where>${where(j.college, j.course)}</p>
    <div${I('C-266')}>${U.field({ id: 'ja', label: 'Apply link', type: 'url', value: j.link, ph: 'https://careers.example.com/…' })}</div></div>`,
    foot: `<button class="btn" type="button" data-sheet-close${I('C-267')}>Cancel</button><button class="btn primary" type="button" data-act="pub"${I('C-267')}>Publish</button>`,
    onAct: {
      'input:jk': (a, ev, sh) => { const t = a.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); sh.querySelector('[data-tprev]').textContent = t.length ? `Sent as ${t.join(' · ')}` : 'Empty — every track sees it.'; },
      'change:jo': (a, ev, sh) => { if (a.value) sh.querySelector('#js').value = dept(course(a.value).dept).college; sh.querySelector('[data-where]').textContent = where(sh.querySelector('#js').value, a.value); },
      'change:js': (a, ev, sh) => { const k = sh.querySelector('#jo'); if (k.value && dept(course(k.value).dept).college !== a.value) k.value = ''; sh.querySelector('[data-where]').textContent = where(a.value, k.value); },
      pub: (a, ev, sh) => { const v = formVals(sh); const e = {}; if (!v.jt || !v.jc) { if (!v.jt) e.jt = 'Role and company are required.'; if (!v.jc) e.jc = 'Role and company are required.'; } if (v.ja && !/^https?:\/\//i.test(v.ja)) e.ja = 'The link must start with http:// or https://.'; if (!errs(sh, e)) return;
        A.jobs.unshift({ id: Date.now(), title: v.jt, company: v.jc, loc: v.jl, tracks: v.jk.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), ctc: null, deadline: v.jd || null, applied: 0, withdrawn: false, college: v.js || null, course: v.jo || null, level: v.jv, link: v.ja, skills: j.skills });
        Sheet.close(); say(st, `Published ${v.jt} at ${v.jc} to the student and alumni boards.`); st.pick = null; rr(); },
    } });
  if (j.tracks.length) el.querySelector('[data-tprev]').textContent = `Sent as ${j.tracks.join(' · ')}`;
}
R.screen('admin/jobs', { title: 'Job postings', render({ st }) {
  const rows = jobFiltered(st); const pg = pager(st, rows.length, [10, 25, 50], I('C-260'));
  const sel = A.jobs.find((j) => j.id === st.pick); const hide = st.hide || {};
  const live = A.jobs.filter((j) => !j.withdrawn); const week = live.filter((j) => j.deadline && daysTo(j.deadline) >= 0 && daysTo(j.deadline) <= 7).length; const past = live.filter((j) => j.deadline && daysTo(j.deadline) < 0).length;
  const cols = [{ h: 'Posting', k: 'p' }, ...JOB_COLS.filter(([k]) => !hide[k]).map(([k, h]) => ({ h, k, r: ['ctc', 'applied', 'cgpa', 'backlogs'].includes(k) ? 1 : 0 })), { h: 'Status', k: 'status' }];
  const data = rows.slice(pg.from - 1, pg.to).map((j) => { const [s, t] = jobStatus(j); return { p: `<label class="hrow" style="gap:10px;cursor:pointer"><input type="checkbox" class="a1-box" data-act-change="x" data-f="jpick" value="${j.id}"${st.pick === j.id ? ' checked' : ''} aria-label="Select ${esc(j.title)}"><span>${esc(j.title)} <span class="muted">@ ${esc(j.company)}</span></span></label>`, track: j.tracks.join(' · ') || 'Every track', ctc: lakh(j.ctc), deadline: j.deadline ? fmtShort(j.deadline) : '—', applied: j.applied, college: j.college ? college(j.college).code : 'Every college', course: j.course ? esc(course(j.course).name) : 'Every course', cgpa: A.criteria.cgpa.toFixed(1), backlogs: A.criteria.backlogs, level: j.level, status: chip(s, t), _attrs: st.compact ? ' class="a1-tight"' : '' }; });
  const colOpts = (key, all, list) => [['', all], ...list, ['every', key]];
  const noCourses = !A.courses.length;
  return U.page({ title: 'Job postings', lede: `<span${I('C-252')}>${live.length} on the boards · ${week} closing this week · ${past ? `<b class="a1-risk">${past} past deadline, still listed</b>` : '0 past deadline'} · ${A.jobs.reduce((n, j) => n + j.applied, 0)} applications</span>`,
    acts: `${can('admin.placement') ? `<a class="btn" href="#/admin/placement"${I('C-244')}>${ic('trophy', 'sm')} Placement & offers</a>` : ''}<button class="btn primary" type="button" data-act="post"${I('C-245')}>${ic('plus', 'sm')} Post a job</button>`,
    body: `${flashBar(st, I('C-247'))}${can('admin.placement') ? `<div class="tabs" role="tablist"${I('C-246')}><button type="button" role="tab" aria-selected="true">Jobs</button><a role="tab" class="a1-tab" href="#/admin/placement">Placement</a><a role="tab" class="a1-tab" href="#/admin/placement?tab=offers">Offers</a></div>` : ''}
      <div class="filters">${U.search('q', st.q || '', 'Search postings…', I('C-254'))}</div>
      <div class="filters">${U.select('col', colOpts('Every college (no college named)', 'All colleges', A.colleges.map((c) => [c.id, c.name])), st.col || '', I('C-248'), 'College')}${U.select('crs', colOpts('Every course (no course named)', 'All courses', A.courses.map((k) => [k.id, k.name])), st.crs || '', I('C-249') + (noCourses ? ' disabled' : ''), 'Course')}${U.select('trk', colOpts('Every track (none named)', 'All tracks', ['HR', 'DM', 'BA', 'FA'].map((t) => [t, t])), st.trk || '', I('C-250'), 'Track')}${U.select('sts', [['', 'All'], ['boards', 'On the boards'], ['week', 'Closing this week'], ['past', 'Past deadline'], ['withdrawn', 'Withdrawn']], st.sts || '', I('C-251'), 'Status')}</div>
      <div class="banner info" style="margin-bottom:12px"${I('C-253')}>${ic('info')}<div>Only Close posting takes a posting off the boards — a passed deadline does not.</div></div>
      <div class="hrow a1-bar"><button class="btn sm" type="button" data-act="close"${sel && !sel.withdrawn ? '' : ' disabled'}${I('C-255')}>Close posting</button><button class="btn sm" type="button" data-act="dup"${sel ? '' : ' disabled'}${I('C-256')}>Duplicate</button><button class="btn sm danger" type="button" data-act="rmJob"${sel && !sel.applied ? '' : ' disabled'}${sel && sel.applied ? ` title="${sel.applied} people have applied"` : ''}${I('C-257')}>Remove</button><span class="grow"></span><span${I('C-258')} class="hrow"><button class="btn sm ghost" type="button" data-act="cols">${ic('list', 'sm')} Columns</button><button class="btn sm ghost" type="button" data-act="compact" aria-pressed="${!!st.compact}">Compact rows</button></span></div>
      ${data.length ? U.table(cols, data, I('C-259')) : `<div class="card"${I('C-259')}>${U.empty('briefcase', 'No posting matches.')}</div>`}<p class="xs muted" style="margin:6px 0">Rows ${rows.length} · Selected ${sel ? 1 : 0}</p>${pg.html}` });
}, acts: {
  dismiss, page: pageAct,
  post: (el, ev, st) => openPost(st),
  dup: (el, ev, st) => openPost(st, A.jobs.find((j) => j.id === st.pick)),
  cols: (el, ev, st) => chooseCols(st, JOB_COLS),
  compact(el, ev, st) { st.compact = !st.compact; rr(); },
  'change:jpick'(el, ev, st) { st.pick = el.checked ? +el.value : null; rr(); },
  close(el, ev, st) { const j = A.jobs.find((x) => x.id === st.pick); Sheet.confirm({ title: `Close ${j.title}?`, text: `It leaves the student and alumni boards. The ${j.applied} applications stay. A closed posting cannot be reopened.`, ok: 'Close posting', danger: true, onOk: () => { j.withdrawn = true; say(st, `${j.title} at ${j.company} is closed.`); rr(); } }); },
  rmJob(el, ev, st) { const j = A.jobs.find((x) => x.id === st.pick); if (j.applied) { say(st, `${j.applied} people have applied — close it instead.`, 'risk'); return rr(); } Sheet.confirm({ title: `Remove ${j.title}?`, text: 'Nobody has applied, so it can be removed entirely.', ok: 'Remove', danger: true, onOk: () => { A.jobs.splice(A.jobs.indexOf(j), 1); st.pick = null; say(st, `${j.title} removed.`); rr(); } }); },
} });

/* ================================================================ Placement & offers */
A.offers ||= [
  { id: 1, sid: 's2', company: 'Kaveri Finance Ltd', role: 'Credit Analyst', ctc: 6.5, date: '2026-09-28', evidence: 'kaveri-offer.pdf', status: 'Approved' },
  { id: 2, sid: 's7', company: 'Malnad Coffee Co.', role: 'Digital Marketing Executive', ctc: 4.2, date: '2026-09-18', evidence: 'malnad-offer.pdf', status: 'Approved' },
  { id: 3, sid: 's7', company: 'Deccan Consumer Goods', role: 'Management Trainee — Sales', ctc: 5.2, date: '2026-10-03', evidence: 'deccan-offer.pdf', status: 'Awaiting approval' },
  { id: 4, sid: 's1', company: 'Western Ghats Capital', role: 'Equity Research Associate', ctc: 9.0, date: '2026-10-05', evidence: 'wgc-letter.pdf', status: 'Awaiting approval' },
  { id: 5, sid: 's5', company: 'Hampi Hospitality Group', role: 'HR Generalist', ctc: 4.8, date: '2026-09-30', evidence: null, status: 'Awaiting approval' },
  { id: 6, sid: 's3', company: 'Tungabhadra Analytics', role: 'Business Analyst', ctc: 7.0, date: '2026-09-11', evidence: 'tba-offer.pdf', status: 'Not approved', remarks: 'The letter is unsigned.' },
  { id: 7, sid: 's8', company: 'Coastal Freight Lines', role: 'Operations Associate', ctc: null, date: '2025-11-20', evidence: 'cfl.pdf', status: 'Approved' },
];
const ofTone = (s) => (s === 'Approved' ? 'good' : s === 'Awaiting approval' ? 'warn' : 'risk');
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
R.screen('admin/placement', { title: 'Placement & offers', render({ query, st }) {
  if (query.tab === 'offers' && !st.jumped) { st.jumped = true; st.toOffers = true; }
  const inScope = (s) => (!st.bat || s.batch === st.bat);
  const elig = A.students.filter((s) => s.batch && inScope(s));
  const offers = A.offers.filter((o) => inScope(stu(o.sid)) && (!st.yr || o.date.startsWith(st.yr)));
  const applied = Math.round(elig.length * 0.73); const holding = new Set(offers.filter((o) => o.status !== 'Not approved').map((o) => o.sid)).size; const placed = new Set(offers.filter((o) => o.status === 'Approved').map((o) => o.sid)).size;
  const funnel = [['Eligible students', elig.length], ['Applied to ≥1 job', applied], ['Holding an offer', holding], ['Placed (approved offer)', placed]];
  const max = Math.max(1, elig.length);
  const waiting = offers.filter((o) => o.status === 'Awaiting approval');
  const oldest = waiting.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
  const ctcs = offers.filter((o) => o.status === 'Approved' && o.ctc != null).map((o) => o.ctc);
  const multi = Object.values(offers.filter((o) => o.status !== 'Not approved').reduce((m, o) => ((m[o.sid] = (m[o.sid] || 0) + 1), m), {})).filter((n) => n > 1).length;
  const tracks = {}; elig.forEach((s) => { const b = batch(s.batch); const k = b && spec(b.spec) ? spec(b.spec).name : 'Not filed'; (tracks[k] ||= { e: 0, p: 0 }).e++; if (offers.some((o) => o.sid === s.id && o.status === 'Approved')) tracks[k].p++; });
  const recruiters = Object.entries(offers.filter((o) => o.status === 'Approved').reduce((m, o) => ((m[o.company] = (m[o.company] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const q = (st.q || '').toLowerCase(); const grid = offers.filter((o) => { const s = stu(o.sid); return !q || `${s.name} ${o.company} ${o.role}`.toLowerCase().includes(q); }).sort((a, b) => (a.status === 'Awaiting approval' ? -1 : 0) - (b.status === 'Awaiting approval' ? -1 : 0) || b.date.localeCompare(a.date));
  const picked = (st.picked || []).filter((x) => waiting.some((o) => o.id === x)); st.picked = picked;
  const years = [...new Set(A.offers.map((o) => o.date.slice(0, 4)))].sort().reverse();
  const counts = [['Approved', offers.filter((o) => o.status === 'Approved').length, 'var(--st-good)'], ['Awaiting approval', waiting.length, 'var(--st-warn)'], ['Not approved', offers.filter((o) => o.status === 'Not approved').length, 'var(--st-risk)']];
  const cmax = Math.max(1, ...counts.map((c) => c[1]));
  const offerRows = grid.map((o) => { const s = stu(o.sid); const can2 = o.status === 'Awaiting approval';
    return crow({ box: can2 ? ck('opick', o.id, picked.includes(o.id)) : '<span class="a1-ck"></span>', title: `${esc(s.name)} · ${esc(o.company)}`, sub: `${esc(o.role)} · ${lakh(o.ctc)} · ${fmtShort(o.date)} · ${o.evidence ? `<a href="#" data-act="ev" data-n="${esc(o.evidence)}">${esc(o.evidence)}</a>` : 'No evidence'}${o.remarks ? ` · “${esc(o.remarks)}”` : ''}`, trail: chip(o.status, ofTone(o.status)) }); });
  const rej = st.rejecting ? `<div class="card flat" style="margin-top:8px"${I('C-284')}><div class="field"><label for="orem">Remarks <span class="req">*</span></label><textarea class="input" id="orem" data-act-input="x" data-f="orem"${st.oremErr ? ' aria-invalid="true"' : ''} placeholder="Shown to the student">${esc(st.orem || '')}</textarea><div class="err" role="alert">${st.oremErr ? 'Remarks are required.' : ''}</div></div><div class="hrow"><button class="btn danger solid" type="button" data-act="oRejectDo">Confirm reject</button><button class="btn" type="button" data-act="oRejectCancel">Cancel</button></div></div>` : '';
  return U.page({ title: 'Placement & offers', lede: `<span${I('C-268')}>Semester 3 · ${st.bat ? `narrowed to ${esc(batchLabel(batch(st.bat)))}` : 'every batch in reach'}${st.yr ? ` · ${st.yr}` : ''}</span>`,
    acts: `<button class="btn" type="button" data-act="oCsv"${I('C-269')}>${ic('download', 'sm')} ${st.bat ? 'Export this batch' : 'Export offers'}</button>`,
    body: `${flashBar(st, '')}<div class="tabs" role="tablist"${I('C-270')}><a role="tab" class="a1-tab" href="#/admin/jobs">Jobs</a><button type="button" role="tab" aria-selected="true">Placement</button><button type="button" role="tab" data-act="toOffers">Offers · ${waiting.length} pending</button></div>
      <div class="filters">${U.select('bat', opt(batchOpts(), 'All batches'), st.bat || '', I('C-271'), 'Batch')}${U.select('yr', opt(years.map((y) => [y, y]), 'Whole record'), st.yr || '', I('C-272') + (years.length ? '' : ' disabled'), 'Period')}</div>
      <div class="grid-2"><div class="card"${I('C-273')}><h3 style="margin-bottom:10px">Placement funnel</h3>${funnel.map(([l, n]) => `<div style="margin-bottom:10px"><div class="spread small"><span>${l}</span><b class="num">${n}</b></div><div class="a1-hbar"><i style="width:${(n / max) * 100}%"></i></div></div>`).join('')}
          <p class="small muted">Apply rate ${pct(applied, elig.length) ?? '—'}% · Placement rate ${pct(placed, elig.length) ?? '—'}%</p>
          <div class="banner warn" style="margin-top:10px"${I('C-274')}>${ic('info')}<div><b>Interviewed — not counted.</b> No interview stage is recorded against a posting. <b>Shortlisted — not counted.</b> Companies do not report shortlists back.</div></div></div>
        <div class="card"><h3 style="margin-bottom:10px">Where students drop off</h3><div class="list">
          ${U.row({ title: `${elig.length - applied} eligible students never applied`, act: 'go', data: ' data-to="#/admin/students"', inv: I('C-275'), trail: '<span class="btn sm">Students</span>', chev: false })}
          ${U.row({ title: `${waiting.length} offers waiting for approval${oldest ? ` (oldest ${fmtShort(oldest.date)})` : ''}`, act: 'toOffers', inv: I('C-276'), trail: '<span class="btn sm">Offers</span>', chev: false })}</div>
          <div class="a1-kpis" style="margin-top:12px"${I('C-277')}>${U.kpi(`${pct(placed, elig.length) ?? '—'}%`, `Placement rate · ${placed} of ${elig.length} eligible`)}${U.kpi(lakh(median(ctcs)), 'Median CTC')}${U.kpi(lakh(ctcs.length ? Math.max(...ctcs) : null), 'Highest')}${U.kpi(multi, 'Multiple offers')}</div></div></div>
      <div class="grid-2">${U.section('Offers by status', offers.length ? `<div class="card"${I('C-278')}>${counts.map(([l, n, c]) => `<div style="margin-bottom:10px"><div class="spread small"><span>${l}</span><b class="num">${n}</b></div><div class="a1-hbar"><i style="width:${(n / cmax) * 100}%;background:${c}"></i></div></div>`).join('')}</div>` : `<div class="card"${I('C-278')}><p class="small muted">No offers recorded yet.</p></div>`)}
        ${U.section('By track', U.table([{ h: 'Track', k: 't' }, { h: 'Placed', k: 'p', r: 1 }, { h: 'Eligible', k: 'e', r: 1 }, { h: 'Rate', k: 'r', r: 1 }], Object.entries(tracks).map(([t, v]) => ({ t: esc(t), p: v.p, e: v.e, r: chip(`${pct(v.p, v.e)}%`, pct(v.p, v.e) >= 40 ? 'good' : pct(v.p, v.e) >= 20 ? 'warn' : 'risk') })), I('C-279')))}</div>
      ${U.section('Top recruiters', `<div class="hrow"${I('C-280')}>${recruiters.length ? recruiters.map(([c, n]) => chip(`${c} · ${n}`, 'info')).join('') : '<span class="small muted">No approved offer yet.</span>'}</div>`)}
      <section class="section" id="offers"><div class="sh"><h2>Offers</h2></div>
        <div class="filters">${U.search('q', st.q || '', 'Search offers…', I('C-282'))}</div><p class="xs muted" style="margin:-4px 0 8px">${picked.length} selected · the newest 25 and every waiting offer</p>
        <div class="list"${I('C-281')}>${listOr(offerRows, 'No offer matches.')}</div>
        <div class="sticky-act"><button class="btn primary" type="button" data-act="oApprove"${picked.length ? '' : ' disabled'}${I('C-283')}>Approve offer${picked.length > 1 ? `s · ${picked.length}` : ''}</button><button class="btn danger" type="button" data-act="oReject"${picked.length ? '' : ' disabled'}${I('C-284')}>Reject</button></div>${rej}</section>` });
}, mount(main, { st }) { if (st.toOffers) { st.toOffers = false; const o = main.querySelector('#offers'); if (o) { o.scrollIntoView({ behavior: 'smooth' }); const f = o.querySelector('input'); if (f) f.focus({ preventScroll: true }); } } },
acts: {
  dismiss,
  toOffers(el, ev, st) { st.toOffers = true; rr(); },
  ev: (el) => fakeDownload(el.dataset.n),
  'change:opick'(el, ev, st) { const v = +el.value; st.picked = el.checked ? [...new Set([...(st.picked || []), v])] : (st.picked || []).filter((x) => x !== v); rr(); },
  'input:orem'(el, ev, st) { st.orem = el.value; },
  oApprove(el, ev, st) { const n = st.picked.length; st.picked.forEach((i) => { A.offers.find((o) => o.id === i).status = 'Approved'; }); st.picked = []; say(st, `${n} offer${n > 1 ? 's' : ''} approved. The student${n > 1 ? 's are' : ' is'} told.`); rr(); },
  oReject(el, ev, st) { st.rejecting = true; st.oremErr = false; rr(); },
  oRejectCancel(el, ev, st) { st.rejecting = false; rr(); },
  oRejectDo(el, ev, st) { const r = (st.orem || '').trim(); if (!r) { st.oremErr = true; return rr(); } st.picked.forEach((i) => Object.assign(A.offers.find((o) => o.id === i), { status: 'Not approved', remarks: r })); say(st, `${st.picked.length} offer${st.picked.length > 1 ? 's' : ''} not approved. The student reads your remarks.`); st.picked = []; st.rejecting = false; st.orem = ''; rr(); },
  oCsv(el, ev, st) { csv('reep-placement-summary.csv', [['Student', 'USN', 'Company', 'Role', 'CTC (lakh)', 'Offer date', 'Status'], ...A.offers.filter((o) => !st.bat || stu(o.sid).batch === st.bat).map((o) => { const s = stu(o.sid); return [s.name, s.usn, o.company, o.role, o.ctc ?? '', o.date, o.status]; })]); toast('Export recorded on the receipts list'); },
} });

})();
