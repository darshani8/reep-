/* REEP v5 prototype — Main Admin console, part 2.
   Students & batches (+ Student 360), Faculty (+ Add faculty), Upload spreadsheets,
   SWOC notes, Who can do what (Grants · Review · Access types · Groups · Feature switches),
   What changed, Email delivery, Catalogue, Download reports, and the shared
   Remove-or-delete dialog (window.PersonDelete). Everything is fake and in memory. */
'use strict';
(() => {
const A = (window.ADM ||= {});
const ME = 'Placement Office';
const wide = () => matchMedia('(min-width: 1024px)').matches;
const stamp = () => `${TODAY} ${new Date().toTimeString().slice(0, 5)}`;
const by = (k) => (a, b) => String(a[k]).localeCompare(String(b[k]));
const uid = (p) => `${p}${Math.random().toString(36).slice(2, 7)}`;
const words = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const copy = (text, msg = 'Copied') => { try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* no clipboard */ } toast(msg); };
const dl = (name, text) => { try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { /* prototype */ } };
const STAGES = ['Reboot', 'Excel', 'Excel-Adv', 'Elevate'];

/* ================================================================ institution */
const COLL = [
  { id: 'c1', code: 'NHM', name: 'Nandi Hills School of Management', domains: ['nhsm.edu.in'], archived: false },
  { id: 'c2', code: 'KIC', name: 'Kaveri Institute of Commerce', domains: ['kic.edu.in'], archived: false },
  { id: 'c3', code: 'MCA', name: 'Malnad Commerce Academy', domains: [], archived: true },
];
const DEPT = [
  { id: 'd1', college: 'c1', name: 'Management Studies' },
  { id: 'd3', college: 'c1', name: 'Business Analytics', archived: true },
  { id: 'd2', college: 'c2', name: 'Commerce' },
];
const COURSE = [{ id: 'k1', dept: 'd1', name: 'General MBA', years: 2, sems: 4 }, { id: 'k2', dept: 'd2', name: 'M.Com', years: 2, sems: 4 }];
const SPEC = [{ id: 'p1', course: 'k1', name: 'Finance' }, { id: 'p2', course: 'k1', name: 'Marketing' }, { id: 'p3', course: 'k1', name: 'Human Resources' }, { id: 'p4', course: 'k2', name: 'Accounting & Tax' }];
const BATCH = [
  { id: 'b1', course: 'k1', spec: 'p1', year: '2025-27', sem: 3 },
  { id: 'b2', course: 'k1', spec: 'p2', year: '2025-27', sem: 3 },
  { id: 'b3', course: 'k1', spec: 'p1', year: '2026-28', sem: 1 },
  { id: 'b5', course: 'k1', spec: 'p3', year: '2026-28', sem: 1 },
  { id: 'b4', course: 'k2', spec: 'p4', year: '2024-26', sem: 4 },
  { id: 'b6', course: 'k1', spec: 'p2', year: '2023-25', sem: 4, ended: true, graduated: { at: '2026-09-20', count: 2 } },
];
const col = (id) => COLL.find((c) => c.id === id);
const dep = (id) => DEPT.find((d) => d.id === id);
const crs = (id) => COURSE.find((c) => c.id === id);
const spc = (id) => SPEC.find((s) => s.id === id);
const bat = (id) => BATCH.find((b) => b.id === id);
const bDept = (b) => crs(b.course).dept;
const bCollege = (b) => dep(bDept(b)).college;
const blabel = (b) => (b ? `${crs(b.course).name}${b.spec ? ' - ' + spc(b.spec).name : ''} · ${b.year}` : 'No batch');
const bTerm = (b) => { const y = +b.year.slice(0, 4); return `Jul ${y} – Jun ${y + crs(b.course).years}`; };

/* ================================================================ people */
const mk = (id, name, usn, batch, fac, stage, sem, extra = {}) => ({ id, name, usn, email: `${usn.toLowerCase()}@${usn.startsWith('1KC') ? 'kic.edu.in' : 'nhsm.edu.in'}`, batch, dept: batch ? bDept(bat(batch)) : 'd1', fac, stage, sem, status: 'Active', removed: null, spec2: null, last: '2026-10-06 19:20', enrolled: '2025-07-14', ...extra });
const ROSTER = [
  mk('s1', 'Aarav Kulkarni', '1NH25MBA014', 'b1', 'f1', 'Excel', 3, { spec2: 'p2', last: '2026-10-07 09:12' }),
  mk('s2', 'Diya Shetty', '1NH25MBA021', 'b1', 'f1', 'Elevate', 3),
  mk('s3', 'Rohan Gowda', '1NH25MBA033', 'b1', 'f1', 'Excel', 3, { backlogs: 2 }),
  mk('s4', 'Ananya Rao', '1NH25MBA040', 'b2', 'f1', 'Reboot', 3),
  mk('s5', 'Kabir Menon', '1NH25MBA045', 'b1', 'f2', 'Excel', 3),
  mk('s6', 'Ishaan Bhat', '1NH25MBA052', 'b2', null, 'Excel', 3, { status: 'Invited', last: null }),
  mk('s7', 'Meghana Hegde', '1NH25MBA058', 'b2', 'f2', 'Excel', 3),
  mk('s8', 'Tanvi Pai', '1NH26MBA003', 'b3', null, 'Reboot', 1, { status: 'Invited', last: null, enrolled: '2026-07-15' }),
  mk('s9', 'Nikhil Shenoy', '1NH26MBA011', 'b3', 'f3', 'Reboot', 1, { enrolled: '2026-07-15' }),
  mk('s10', 'Pooja Kamath', '1KC24MCM007', 'b4', 'f5', 'Elevate', 4, { enrolled: '2024-07-10' }),
  mk('s11', 'Varun Acharya', '1KC24MCM019', 'b4', 'f5', 'Excel-Adv', 4, { enrolled: '2024-07-10' }),
  mk('s12', 'Sneha Bhandary', '1NH26MBA020', null, null, 'Reboot', 1, { status: 'Invited', last: null, enrolled: '2026-08-02' }),
  mk('s13', 'Rahul Naik', '1NH25MBA061', 'b1', 'f2', 'Excel', 3, { removed: { at: '2026-09-28', by: ME, reason: 'Withdrew from the programme' } }),
  mk('s14', 'Lakshmi Prabhu', '1NH25MBA066', 'b2', 'f1', 'Excel', 3, { unreadable: true }),
  mk('s15', 'Harsha Poojary', '1NH23MBA030', 'b6', null, 'Elevate', 4, { alumni: true, enrolled: '2023-07-12' }),
  mk('s16', 'Chaitra Kini', '1NH23MBA034', 'b6', null, 'Elevate', 4, { alumni: true, enrolled: '2023-07-12' }),
];
const FAC = [
  { id: 'f1', name: 'Dr. Meera Iyer', email: 'meera.iyer@nhsm.edu.in', dept: 'd1', desig: 'Associate Professor', status: 'Active', removed: null, disabled: null, created: '2024-06-10' },
  { id: 'f2', name: 'Prof. Sameer Nadig', email: 'sameer.nadig@nhsm.edu.in', dept: 'd1', desig: 'Assistant Professor', status: 'Active', removed: null, disabled: null, created: '2024-06-10' },
  { id: 'f3', name: 'Dr. Kavitha Rao', email: 'kavitha.rao@nhsm.edu.in', dept: 'd1', desig: 'Professor', status: 'Active', removed: null, disabled: null, created: '2023-01-05' },
  { id: 'f4', name: 'Prof. Arjun Hegde', email: 'arjun.hegde@nhsm.edu.in', dept: 'd1', desig: 'Assistant Professor', status: 'Disabled', removed: null, disabled: { at: '2026-09-30', reason: 'Resigned; last working day 30 Sep' }, created: '2025-01-12' },
  { id: 'f5', name: 'Ms. Nisha Pai', email: 'nisha.pai@kic.edu.in', dept: 'd2', desig: 'Assistant Professor', status: 'Active', removed: null, disabled: null, created: '2025-03-02' },
  { id: 'f6', name: 'Dr. Farhan Qureshi', email: 'farhan.qureshi@nhsm.edu.in', dept: 'd1', desig: 'Visiting Faculty', status: 'Active', removed: null, disabled: null, created: '2026-08-20' },
  { id: 'f7', name: 'Mr. Rakesh Gowda', email: 'rakesh.gowda@kic.edu.in', dept: 'd2', desig: 'Lecturer', status: 'Active', removed: { at: '2026-09-12', by: ME, reason: 'Contract ended' }, disabled: null, created: '2025-03-02' },
];
const CAPACITY = 12;
const fac = (id) => FAC.find((f) => f.id === id);
const stu = (id) => ROSTER.find((s) => s.id === id);
const facName = (id) => (id && fac(id) ? fac(id).name : '—');
const sCollege = (s) => dep(s.dept).college;
const menteesOf = (fid) => ROSTER.filter((s) => s.fac === fid && !s.removed && !s.alumni);
const sStatus = (s) => (s.removed ? 'Removed' : s.status);
const tone = { Active: 'good', Invited: 'warn', Removed: 'risk', Disabled: 'risk' };
const fStatus = (f) => (f.removed ? 'Removed' : f.status);
A.roster ||= ROSTER; A.facultyDir ||= FAC; A.batches ||= BATCH;

const MOVES = [
  { batch: 'b1', kind: 'Promoted', sid: 's1', move: 'Semester 2 → 3', eff: '2026-07-15', by: ME, reason: 'Semester 2 results published' },
  { batch: 'b1', kind: 'Promoted', sid: 's2', move: 'Semester 2 → 3', eff: '2026-07-15', by: ME, reason: 'Semester 2 results published' },
  { batch: 'b1', kind: 'Held back', sid: 's3', move: 'Stays on 2 → later 3', eff: '2026-07-15', by: ME, reason: '' },
  { batch: 'b2', kind: 'Promoted', sid: 's4', move: 'Semester 2 → 3', eff: '2026-07-15', by: ME, reason: '' },
  { batch: 'b6', kind: 'Graduated', sid: 's15', move: 'Semester 4 → Alumni', eff: '2026-09-20', by: ME, reason: 'Convocation 2026' },
  { batch: 'b6', kind: 'Graduated', sid: 's16', move: 'Semester 4 → Alumni', eff: '2026-09-20', by: ME, reason: 'Convocation 2026' },
];
const SPELLS = [
  { sid: 's1', fid: 'f2', from: '2025-07-20', to: '2026-08-01', kind: 'Assigned', by: ME, endKind: 'Reassigned', endReason: 'Load balancing for semester 3' },
  { sid: 's1', fid: 'f1', from: '2026-08-01', to: null, kind: 'Reassigned', by: ME, reason: 'Load balancing for semester 3' },
  { sid: 's2', fid: 'f1', from: null, to: null, kind: 'Assigned', by: ME },
];

/* ================================================================ audit trail */
const AUD = [
  { id: 'e1', at: '2026-10-07 09:40', actor: ME, action: 'capability_grant.create', type: 'capability_grant', tid: 'g1', tl: 'Approve leave · Dr. Meera Iyer', route: 'POST /api/admin/governance/grants', before: null, after: { capability: 'admin.leave_approvals', scope: null, expires: '2026-12-31' }, meta: { reason: 'Covers leave approvals while the office is short-staffed this term.' } },
  { id: 'e2', at: '2026-10-06 16:05', actor: ME, action: 'user.sign_out_everywhere', type: 'user', tid: 's5', tl: 'Kabir Menon', route: 'POST /api/admin/users/{id}/sign-out-everywhere', before: { token_version: 6 }, after: { token_version: 7 }, meta: {} },
  { id: 'e3', at: '2026-10-05 11:20', actor: 'Dr. Meera Iyer', action: 'swoc_entry.update', type: 'swoc_entry', tid: 'w2', tl: 'Weakness · Aarav Kulkarni', route: 'PATCH /api/admin/swoc/entries/{id}', before: { text: 'Speaks late in GDs.' }, after: { text: 'Hesitant in group discussions; speaks late.' }, meta: {} },
  { id: 'e4', at: '2026-10-02 10:00', actor: ME, action: 'feature_override.set', type: 'feature_override', tid: 'o1', tl: 'Jobs · 2026-28 Finance', route: 'PUT /api/admin/governance/features', before: null, after: { value: 'off', scope: 'COHORT' }, meta: { students_affected: 2 } },
  { id: 'e5', at: '2026-09-30 17:45', actor: ME, action: 'user.disable', type: 'faculty', tid: 'f4', tl: 'Prof. Arjun Hegde', route: 'POST /api/admin/users/{id}/disable', before: { disabled_at: null }, after: { disabled_at: '2026-09-30' }, meta: { reason: 'Resigned; last working day 30 Sep' } },
  { id: 'e6', at: '2026-09-28 12:12', actor: ME, action: 'user.remove', type: 'student', tid: 's13', tl: 'Rahul Naik', route: 'POST /api/admin/students/{id}/remove', before: { deleted_at: null }, after: { deleted_at: '2026-09-28' }, meta: { reason: 'Withdrew from the programme' } },
  { id: 'e7', at: '2026-09-20 15:30', actor: ME, action: 'cohort.graduate', type: 'cohort', tid: 'b6', tl: 'General MBA - Marketing · 2023-25', route: 'POST /api/admin/cohorts/{id}/graduate', before: { role: 'STUDENT' }, after: { role: 'ALUMNI', count: 2 }, meta: { reason: 'Convocation 2026' } },
  { id: 'e8', at: '2026-09-12 09:05', actor: 'Account deleted', action: 'registration.rule_updated', type: 'registration', tid: 'r4', tl: 'Auto-approve rule · NHM', route: 'PUT /api/register/rules/{id}', before: { auto: false }, after: { auto: true }, meta: {} },
  { id: 'e9', at: '2026-08-01 10:15', actor: ME, action: 'roster.mentor_change', type: 'student', tid: 's1', tl: 'Aarav Kulkarni', route: 'POST /api/admin/students/{id}/mentor', before: { mentor: 'Prof. Sameer Nadig' }, after: { mentor: 'Dr. Meera Iyer' }, meta: { reason: 'Load balancing for semester 3' } },
  { id: 'e10', at: '2026-07-02 14:00', actor: ME, action: 'export.download', type: 'export', tid: 'x1', tl: 'reep-students-mentor-map.csv', route: 'GET /api/admin/exports/students.csv', before: null, after: null, meta: { rows: 14 } },
];
A.audit ||= AUD;
let eSeq = 20;
function audit(action, type, tid, tl, before = null, after = null, meta = {}) {
  AUD.unshift({ id: `e${++eSeq}`, at: stamp(), actor: ME, action, type, tid, tl, route: '', before, after, meta });
}

/* ================================================================ small shared UI */
function flashBox(st, inv = '') {
  if (!st.flash) return '';
  const f = st.flash; st.flash = null;
  return `<div class="banner ${f.tone || 'good'}" role="${f.tone === 'risk' ? 'alert' : 'status'}" style="margin-bottom:12px"${f.inv || inv}>${ic(f.tone === 'risk' ? 'alert' : 'check', 'sm')}<div>${esc(f.msg)}</div></div>`;
}
const flash = (st, msg, t = 'good', inv = '') => { st.flash = { msg, tone: t, inv }; };
function paged(st, rows) {
  const ps = +(st.ps || 10); const pages = Math.max(1, Math.ceil(rows.length / ps));
  if ((st.pg || 0) >= pages) st.pg = pages - 1;
  const p = st.pg || 0;
  return { rows: rows.slice(p * ps, p * ps + ps), p, pages, from: rows.length ? p * ps + 1 : 0, to: Math.min(rows.length, (p + 1) * ps) };
}
function pagerBar(st, total, pi, facts, inv) {
  return `<div class="pager"${inv}><div class="hrow xs muted grow">${facts}</div><div class="hrow"><label class="hrow xs muted">Page size ${U.select('ps', [10, 25, 50, 100], st.ps || 10, '', 'Page size')}</label><span class="xs num">${pi.from}–${pi.to} of ${total}</span>
    <button class="icon-btn" type="button" data-act="pg" data-d="-1" aria-label="Previous page"${pi.p === 0 ? ' disabled' : ''}>${ic('back')}</button><button class="icon-btn" type="button" data-act="pg" data-d="1" aria-label="Next page"${pi.p >= pi.pages - 1 ? ' disabled' : ''}>${ic('chev')}</button></div></div>`;
}
const toolBtns = (st, set, inv) => `<span class="hrow"${inv}><button class="btn sm" type="button" data-act="cols" data-set="${set}">${ic('layers', 'sm')}Columns</button><button class="btn sm" type="button" data-act="compact" aria-pressed="${!!st.compact}">${ic('list', 'sm')}Compact</button></span>`;
const COLSETS = {};
const COMMON = {
  pg(el, ev, st) { st.pg = Math.max(0, (st.pg || 0) + +el.dataset.d); App.rerender(); },
  compact(el, ev, st) { st.compact = !st.compact; App.rerender(); },
  'change:ps'(el, ev, st) { st.pg = 0; App.rerender(); },
  cols(el, ev, st) {
    const set = COLSETS[el.dataset.set]; const hide = (st.hide ||= {});
    Sheet.open({ title: 'Columns', center: true,
      body: `<div class="stack">${set.map(([k, t, lock]) => `<label class="check"><input type="checkbox" name="c_${k}"${hide[k] ? '' : ' checked'}${lock ? ' disabled' : ''}><span>${esc(t)}${lock ? ' <span class="xs muted">· always shown</span>' : ''}</span></label>`).join('')}</div>`,
      foot: `<button class="btn primary" type="button" data-act="ok">Done</button>`,
      onAct: { ok(a, e, sh) { set.forEach(([k, , lock]) => { if (!lock) hide[k] = !sh.querySelector(`[name="c_${k}"]`).checked; }); Sheet.close(); App.rerender(); } } });
  },
};
const withCommon = (acts) => Object.assign({}, COMMON, acts);
const cbx = (act, id, on, label) => `<input type="checkbox" class="tick" data-act="${act}" data-id="${id}"${on ? ' checked' : ''} aria-label="${esc(label)}">`;
const kv = (pairs, inv = '') => `<dl class="kv"${inv}>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const opt = (v, t, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(t)}</option>`;
const sel = (name, opts, value, attrs = '') => `<select class="input" id="${name}" name="${name}"${attrs}>${opts.map(([v, t]) => opt(v, t, value)).join('')}</select>`;
const fld = (id, label, ctl, { req = false, hint = '', inv = '' } = {}) => `<div class="field"${inv}><label for="${id}">${esc(label)}${req ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>${ctl}${hint ? `<div class="hint">${hint}</div>` : ''}<div class="err" role="alert" data-err="${id}"></div></div>`;
const facOpts = (first = ['', 'Not assigned']) => [first, ...FAC.filter((f) => f.status === 'Active' && !f.removed).map((f) => [f.id, `${f.name} — ${menteesOf(f.id).length} of ${CAPACITY}`])];
const batchOpts = (first = ['', 'No batch']) => [first, ...BATCH.filter((b) => !b.ended).map((b) => [b.id, blabel(b)])];

/* ================================================================ the shared Remove-or-delete dialog */
const PLANS = {
  student: (n) => ({ goes: [`${n}'s account and every way of signing in`, '2 semesters of results and 41 ledger days', '3 documents, and their files', '2 mock interviews, their transcripts and recordings', '4 SWOC lines and meeting notes about them'], stays: ['Promotion history rows stay without the name', 'Download receipts stay'] }),
  faculty: (n) => ({ goes: [`${n}'s account and every way of signing in`, 'Their signature image and upskilling shelf', 'Their meeting notes about students (6) — they cannot outlive the group', 'Their own leave requests (3)'], stays: ['Their mentees are released and wait for a new faculty member', 'Grants they made stay, without the name'] }),
  college: () => ({ goes: ['Its departments, courses, specializations and batches', 'Its academic calendar and interview policies'], stays: ['Job postings, interview tracks and approved certifications lose the pointer to it'] }),
};
const REMOVE_LINES = { student: ['Off every roster, picker and queue.', 'Cannot sign in by any door; every device is signed out.', 'Every record stays exactly where it is. Restore brings them back.'], faculty: ['Off every list and unable to sign in; every device is signed out.', 'Their mentees are released.', 'Every record stays. Restore brings the account back.'] };
window.PersonDelete = {
  /** open({kind:'student'|'faculty'|'college', name, onRemoved(reason), onDeleted(reason), plan?, refused?}) */
  open({ kind = 'student', name, onRemoved = () => {}, onDeleted = () => {}, plan = null, refused = '' }) {
    const college = kind === 'college';
    const m = { mode: college ? 'delete' : 'remove', sent: false, why: '', code: '' };
    const pl = plan || (PLANS[kind] || PLANS.student)(name);
    const valid = () => words(m.why).length >= 3 && (m.mode === 'remove' || (m.sent && m.code.replace(/\s/g, '').length === 6 && /^\d{6}$/.test(m.code.replace(/\s/g, '')))) && !refused;
    const why = () => (refused ? refused : words(m.why).length < 3 ? 'Give a reason first.' : m.mode === 'delete' && !m.sent ? 'Email yourself a code first.' : m.mode === 'delete' ? 'Type the six-digit code from your email.' : '');
    const body = () => `<div class="stack"${I('D-060')}>
      ${college ? `<label class="check"${I('D-062')}><input type="radio" name="mode" value="delete" checked disabled><span><b>Delete for good</b><br><span class="xs muted">The college's structure is destroyed. There is no undo.</span></span></label>` : `<div role="radiogroup" aria-label="What to do">
        <label class="check"${I('D-061')}><input type="radio" name="mode" value="remove" data-act-change="pd" data-f="mode"${m.mode === 'remove' ? ' checked' : ''}><span><b>Remove — keep the record</b><br><span class="xs muted">Off every screen and unable to sign in; every row stays and Restore undoes it.</span></span></label>
        <label class="check"${I('D-062')}><input type="radio" name="mode" value="delete" data-act-change="pd" data-f="mode"${m.mode === 'delete' ? ' checked' : ''}><span><b>Delete for good</b><br><span class="xs muted">Rows, files and recordings destroyed. Needs the code emailed to you. There is no undo.</span></span></label></div>`}
      ${refused ? `<div class="banner risk" role="alert"${I('D-064')}>${ic('lock', 'sm')}<div>${esc(refused)}</div></div>` : ''}
      ${m.mode === 'remove' ? `<div class="list">${(REMOVE_LINES[kind] || REMOVE_LINES.student).map((t) => U.row({ title: `<span class="small" style="white-space:normal">${esc(t)}</span>`, lead: U.lead('check'), chev: false })).join('')}</div>`
        : `<div class="card flat"${I('D-063')}><h3 style="margin-bottom:6px">What goes</h3>${pl.goes.length ? `<ul class="plan">${pl.goes.map((t) => `<li>${ic('trash', 'sm')}<span>${esc(t)}</span></li>`).join('')}</ul>` : '<p class="small">The row itself and nothing else on record.</p>'}
          ${pl.stays.length ? `<h3 style="margin:10px 0 6px">What stays</h3><ul class="plan">${pl.stays.map((t) => `<li>${ic('check', 'sm')}<span>${esc(t)}</span></li>`).join('')}</ul>` : ''}
          ${college ? '' : `<p class="xs muted" style="margin-top:8px">${ic('restore', 'sm')} The audit trail keeps that this was done, by whom and why.</p>`}</div>`}
      ${U.field({ id: 'why', label: 'Reason', type: 'textarea', req: true, value: m.why, inv: I('D-065'), attrs: ' data-act-input="pd" data-f="why" maxlength="400"' })}
      ${m.mode === 'delete' ? `<div class="card flat stack">
        <div class="spread"><b class="small">A code goes to ${esc(D.me.admin.email)}</b><button class="btn sm" type="button" data-act="send"${I('D-067')}>${ic('mail', 'sm')}${m.sent ? 'Send another code' : 'Email me a code'}</button></div>
        ${U.field({ id: 'code', label: 'Code from your email', value: m.code, inv: I('D-066'), attrs: ` inputmode="numeric" autocomplete="one-time-code" maxlength="9" style="letter-spacing:.4em;text-align:center;font-size:22px" data-act-input="pd" data-f="code"${m.sent ? '' : ' disabled'}` })}</div>` : ''}
    </div>`;
    const foot = () => `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn ${m.mode === 'delete' ? 'danger solid' : 'primary'}" type="button" data-act="go"${I('D-068')}${valid() ? '' : ` disabled title="${esc(why())}"`}>${college ? 'Delete this college for good' : m.mode === 'delete' ? 'Delete for good' : 'Remove from the roster'}</button>`;
    const paint = (el) => { el.querySelector('.sh-b').innerHTML = body(); el.querySelector('.sh-f').innerHTML = foot(); };
    const refreshFoot = (el) => { el.querySelector('.sh-f').innerHTML = foot(); };
    Sheet.open({ title: college ? `Delete ${name}` : `Remove or delete ${name}`, body: body(), foot: foot(),
      onAct: {
        'change:mode'(a, ev, el) { m.mode = a.value; paint(el); },
        'input:why'(a, ev, el) { m.why = a.value; refreshFoot(el); },
        'input:code'(a, ev, el) { m.code = a.value; refreshFoot(el); },
        send(a, ev, el) { m.sent = true; paint(el); toast(`Code sent to ${D.me.admin.email}`); el.querySelector('#code').focus(); },
        go(a, ev, el) {
          if (!valid()) return;
          const reason = words(m.why);
          if (m.mode === 'delete' && m.code.replace(/\s/g, '') !== '246810') { errs(el, { code: 'That code is not right.' }); return toast('That code is not right. Nothing was changed.', 'risk'); }
          Sheet.close();
          if (m.mode === 'delete') onDeleted(reason); else onRemoved(reason);
        },
      } });
  },
};

/* ================================================================ Students & batches */
COLSETS.roster = [['usn', 'USN', true], ['student', 'Student'], ['spec', 'Spec.'], ['sem', 'Sem'], ['stage', 'Stage'], ['fac', 'Faculty'], ['batch', 'Batch'], ['status', 'Status']];
const specLabel = (s) => { const b = s.batch && bat(s.batch); const f = b && b.spec ? spc(b.spec).name : ''; return [f, s.spec2 ? spc(s.spec2).name : ''].filter(Boolean).join(' and ') || '—'; };
const domainsOf = (cid) => (col(cid).domains.length ? col(cid).domains : ['nhsm.edu.in']);
function rosterRows(st) {
  const removed = st.status === 'Removed'; const q = (st.q || '').toLowerCase();
  return ROSTER.filter((s) => !s.alumni && (removed ? !!s.removed : !s.removed)).filter((s) => {
    const b = s.batch && bat(s.batch);
    if (st.dept && s.dept !== st.dept) return false;
    if (st.course && (!b || b.course !== st.course)) return false;
    if (st.spec && (!b || (b.spec !== st.spec && s.spec2 !== st.spec))) return false;
    if (st.batch === 'none' && b) return false;
    if (st.batch && st.batch !== 'none' && (!b || b.year !== st.batch)) return false;
    if ((st.status === 'Active' || st.status === 'Invited') && s.status !== st.status) return false;
    return !q || `${s.name} ${s.email} ${s.usn}`.toLowerCase().includes(q);
  }).sort(by('usn'));
}
const batchesInView = (st) => (!st.batch || st.batch === 'none' ? [] : BATCH.filter((b) => b.year === st.batch && (!st.dept || bDept(b) === st.dept) && (!st.course || b.course === st.course) && (!st.spec || b.spec === st.spec)));
const liveIn = (b) => ROSTER.filter((s) => s.batch === b.id && !s.removed && !s.alumni);

function openEditStudent(s, st) {
  const removed = !!s.removed;
  const spec2Opts = (bid) => { const b = bid && bat(bid); if (!b) return [['', 'None available']]; const o = SPEC.filter((p) => p.course === b.course && p.id !== b.spec); return o.length ? [['', 'None'], ...o.map((p) => [p.id, p.name])] : [['', 'None available']]; };
  const spec2Field = (bid, v) => { const b = bid && bat(bid); return fld('spec2', 'Second specialization', sel('spec2', spec2Opts(bid), v), { inv: I('D-033'), hint: b && b.spec ? `Dual with ${esc(spc(b.spec).name)}, from the batch.` : '' }); };
  const body = `<p class="small muted"${I('D-030')}>Nothing here sets a password.</p><div class="stack">
    ${removed ? `<div class="banner risk" role="status">${ic('alert', 'sm')}<div>Removed ${fmtDate(s.removed.at)} — ${esc(s.removed.reason)}</div></div>` : ''}
    <div class="stack"${I('D-031')}>${U.field({ id: 'name', label: 'Name', value: s.name, req: true })}${U.field({ id: 'email', label: 'College email', type: 'email', value: s.email, req: true })}${U.field({ id: 'usn', label: 'USN', value: s.usn, req: true })}</div>
    ${fld('batch', 'Batch', sel('batch', batchOpts(), s.batch || '', ' data-act-change="ed" data-f="batch"'), { inv: I('D-032') })}
    <div data-slot="spec2">${spec2Field(s.batch, s.spec2 || '')}</div>
    ${fld('dept', 'Department', sel('dept', [['', 'Not filed'], ...DEPT.map((d) => [d.id, `${d.name} · ${col(d.college).code}`])], s.dept), { inv: I('D-034'), hint: 'The batch decides the department whenever it names one.' })}
    ${fld('fac', 'Faculty member', sel('fac', facOpts(), s.fac || ''), { inv: I('D-035') })}
    <div class="form-grid"${I('D-036')}>${fld('stage', 'Stage', sel('stage', STAGES.map((x) => [x, x]), s.stage))}${fld('sem', 'Semester', sel('sem', [1, 2, 3, 4].map((x) => [x, `Semester ${x}`]), s.sem))}</div>
    <div class="hrow">${removed ? `<button class="btn" type="button" data-act="restore"${I('D-039')}>${ic('restore', 'sm')}Restore to the roster</button>` : `<button class="btn danger" type="button" data-act="del"${I('D-038')}>${ic('trash', 'sm')}Remove or delete…</button>`}</div></div>`;
  Sheet.open({ title: `Edit ${s.name}`, body,
    foot: `<span class="hrow"${I('D-037')}><button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="save"${removed ? ' disabled' : ''}>Save</button></span>`,
    onAct: {
      'change:batch'(a, ev, el) { el.querySelector('[data-slot="spec2"]').innerHTML = spec2Field(a.value, ''); },
      restore() { s.removed = null; audit('user.restore', 'student', s.id, s.name); Sheet.close(); flash(st, `${s.name} is back on the roster. Nothing was lost.`); App.rerender(); },
      del() { Sheet.close(); setTimeout(() => removeStudent(s, st), 0); },
      save(a, ev, el) {
        const v = formVals(el); const e = {};
        const nb = v.batch ? bat(v.batch) : null; const ndept = nb ? bDept(nb) : v.dept || s.dept; const cid = dep(ndept).college;
        if (!v.name) e.name = 'Name is required.';
        if (!v.email) e.email = 'College email is required.';
        else if (!domainsOf(cid).some((d) => v.email.toLowerCase().endsWith('@' + d))) e.email = `Only a college address is accepted (${domainsOf(cid).join(', ')}).`;
        if (!v.usn) e.usn = 'USN is required.';
        else if (ROSTER.some((o) => o !== s && o.usn.toLowerCase() === v.usn.toLowerCase())) e.usn = 'Another student already holds this USN.';
        if (v.fac && dep(fac(v.fac).dept).college !== cid) e.fac = `${fac(v.fac).name} teaches at another college.`;
        if (!errs(el, e)) return;
        const next = { name: v.name, email: v.email.toLowerCase(), usn: v.usn.toUpperCase(), batch: v.batch || null, spec2: v.spec2 || null, dept: ndept, fac: v.fac || null, stage: v.stage, sem: +v.sem };
        if (next.spec2 && nb && (next.spec2 === nb.spec || spc(next.spec2).course !== nb.course)) next.spec2 = null;
        const changed = Object.keys(next).filter((k) => String(next[k] ?? '') !== String(s[k] ?? ''));
        Sheet.close();
        if (!changed.length) { flash(st, 'Nothing changed.', 'info'); return App.rerender(); }
        const before = Object.fromEntries(changed.map((k) => [k, s[k]]));
        if (changed.includes('fac')) SPELLS.push({ sid: s.id, fid: next.fac, from: TODAY, to: null, kind: next.fac ? 'Assigned' : 'Released', by: ME });
        Object.assign(s, next); audit('student.update', 'student', s.id, s.name, before, Object.fromEntries(changed.map((k) => [k, s[k]])));
        flash(st, 'Saved.'); App.rerender();
      },
    } });
}
function removeStudent(s, st, goBack = false) {
  PersonDelete.open({ kind: 'student', name: s.name,
    onRemoved(reason) { s.removed = { at: TODAY, by: ME, reason }; audit('user.remove', 'student', s.id, s.name, { deleted_at: null }, { deleted_at: TODAY }, { reason }); flash(st, `${s.name} was removed. Restore brings them back with nothing lost.`); App.rerender(); },
    onDeleted(reason) { ROSTER.splice(ROSTER.indexOf(s), 1); audit('user.delete_permanent', 'student', s.id, s.name, { exists: true }, null, { reason }); flash(st, `${s.name} was deleted for good.`); if (goBack) R.go('#/admin/students'); else App.rerender(); } });
}
function openSelection(kind, ids, st) {
  const assign = kind === 'assign';
  const opts = assign ? [['', 'Choose a faculty member'], ['none', 'Nobody · release them'], ...facOpts().slice(1)] : [['', 'Choose a batch'], ...batchOpts().slice(1)];
  const foot = (v) => `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="apply"${I('D-042')}${v ? '' : ' disabled'}>Apply to ${ids.length} student${ids.length === 1 ? '' : 's'}</button>`;
  Sheet.open({ title: assign ? 'Assign a faculty member' : 'Move to another batch',
    body: `<div${I(assign ? 'D-040' : 'D-041')}>${fld('dest', assign ? 'Faculty member' : 'Destination batch', sel('dest', opts, '', ' data-act-change="x" data-f="dest"'))}<p class="xs muted">${ids.length} ticked: ${ids.map((i) => esc(stu(i).name)).join(', ')}</p></div>`,
    foot: foot(''),
    onAct: {
      'change:dest'(a, ev, el) { el.querySelector('.sh-f').innerHTML = foot(a.value); },
      apply(a, ev, el) {
        const v = el.querySelector('#dest').value; if (!v) return;
        let done = 0; let refusal = '';
        for (const id of ids) {
          const s = stu(id);
          if (assign) {
            if (v !== 'none' && dep(fac(v).dept).college !== sCollege(s)) { refusal = `${fac(v).name} teaches at another college than ${s.name}.`; break; }
            s.fac = v === 'none' ? null : v; SPELLS.push({ sid: s.id, fid: s.fac, from: TODAY, to: null, kind: s.fac ? 'Assigned' : 'Released', by: ME });
          } else {
            const b = bat(v); if (bCollege(b) !== sCollege(s)) { refusal = `${blabel(b)} belongs to another college than ${s.name}.`; break; }
            s.batch = v; s.dept = bDept(b); if (s.spec2 === b.spec) s.spec2 = null;
          }
          done++;
        }
        Sheet.close(); st.sel = {};
        const what = assign ? (v === 'none' ? 'released' : 'assigned') : 'moved';
        flash(st, refusal ? `${done} ${what}, then the next was refused: ${refusal}` : `${done} ${what}.`, refusal ? 'risk' : 'good');
        if (done) audit(assign ? 'roster.mentor_change' : 'roster.move', 'roster', ids[0], `${done} students`);
        App.rerender();
      },
    } });
}
function openBatchActions(b, st) {
  const live = liveIn(b); const empty = !live.length;
  const row = (inv, label, id, opts, act, btn) => `<div class="card flat"${inv}><div class="field"><label for="${id}">${label}</label><div class="hrow" style="flex-wrap:nowrap">${sel(id, opts, '', ` data-act-change="x" data-f="${id}"`)}<button class="btn" type="button" data-act="${act}" disabled>${btn}</button></div></div></div>`;
  const body = `<div class="stack"${I('D-043')}><p class="small">${live.length} student${live.length === 1 ? '' : 's'} · every action touches the whole batch. Removed students are left alone.</p>
    ${row(I('D-044'), 'Move every student to', 'bmove', [['', 'Choose a batch'], ...batchOpts().slice(1).filter(([id]) => id !== b.id)], 'move', 'Move')}
    ${row(I('D-045'), 'Assign every student to', 'bfac', [['', 'Choose'], ['none', 'Nobody · release them'], ...facOpts().slice(1)], 'assign', 'Assign')}
    <div class="grid-2"${I('D-046')}>${row('', 'Set stage', 'bstage', [['', 'Choose a stage'], ...STAGES.map((x) => [x, x])], 'stage', 'Set')}${row('', 'Set semester', 'bsem', [['', 'Choose'], ...[1, 2, 3, 4].map((x) => [x, `Semester ${x}`])], 'sem', 'Set')}</div>
    <div${I('D-047')} data-slot="rm">${empty ? `<button class="btn danger" type="button" data-act="rm">${ic('trash', 'sm')}Remove this empty batch…</button>` : `<p class="xs muted">Move its ${live.length} students out to remove this batch.</p>`}</div></div>`;
  const done = (msg) => { Sheet.close(); flash(st, msg); audit('cohort.bulk', 'cohort', b.id, blabel(b)); App.rerender(); };
  const en = (key) => (a, ev, el) => { el.querySelector(`[data-act="${key}"]`).disabled = !a.value || empty; };
  Sheet.open({ title: `Batch actions · ${blabel(b)}`, body, foot: `<button class="btn primary" type="button" data-sheet-close${I('D-048')}>Done</button>`,
    onAct: {
      'change:bmove': en('move'), 'change:bfac': en('assign'), 'change:bstage': en('stage'), 'change:bsem': en('sem'),
      move(a, ev, el) { const d = bat(el.querySelector('#bmove').value); if (bCollege(d) !== bCollege(b)) return toast(`${blabel(d)} belongs to another college.`, 'risk'); live.forEach((s) => { s.batch = d.id; s.dept = bDept(d); if (s.spec2 === d.spec) s.spec2 = null; }); done(`${live.length} moved to ${blabel(d)}.`); },
      assign(a, ev, el) { const v = el.querySelector('#bfac').value; if (v !== 'none' && dep(fac(v).dept).college !== bCollege(b)) return toast(`${fac(v).name} teaches at another college.`, 'risk'); live.forEach((s) => { s.fac = v === 'none' ? null : v; }); done(v === 'none' ? `${live.length} released.` : `${live.length} assigned to ${fac(v).name}.`); },
      stage(a, ev, el) { const v = el.querySelector('#bstage').value; live.forEach((s) => { s.stage = v; }); done(`Stage set to ${v} for ${live.length}.`); },
      sem(a, ev, el) { const v = +el.querySelector('#bsem').value; live.forEach((s) => { s.sem = v; }); done(`Semester set to ${v} for ${live.length}.`); },
      rm(a, ev, el) { el.querySelector('[data-slot="rm"]').innerHTML = `<div class="hrow"><button class="btn danger solid" type="button" data-act="rmyes">Yes, remove the batch</button><button class="btn" type="button" data-act="rmno">Keep it</button></div>`; },
      rmno(a, ev, el) { el.querySelector('[data-slot="rm"]').innerHTML = `<button class="btn danger" type="button" data-act="rm">${ic('trash', 'sm')}Remove this empty batch…</button>`; },
      rmyes() { BATCH.splice(BATCH.indexOf(b), 1); st.batch = ''; Sheet.close(); flash(st, `${blabel(b)} was removed.`); audit('cohort.delete', 'cohort', b.id, blabel(b)); App.rerender(); },
    } });
}
function openPromote(b, st) {
  const c = crs(b.course); const live = liveIn(b); const held = new Set(); const to = b.sem + 1; const last = b.sem >= c.sems;
  const blocked = (s) => (last ? `Semester ${b.sem} is the last — graduate the batch` : s.backlogs && !held.has(s.id) ? `${s.backlogs} live backlogs in semester ${b.sem - 1}` : '');
  const anyBlocked = () => live.some((s) => blocked(s));
  const body = () => `<div class="stack"${I('D-049')}>
    <div class="list">${U.row({ title: 'Results for every promoted student', sub: anyBlocked() ? `${live.filter(blocked).length} blocked` : 'Nobody blocked', trail: anyBlocked() ? chip('Blocked', 'risk') : chip('Clear', 'good'), chev: false })}${U.row({ title: `Semester ${b.sem} results`, sub: 'Not imported yet', trail: chip('Cannot be checked', 'neutral'), chev: false })}</div>
    <div class="form-grid"${I('D-050')}>${U.field({ id: 'eff', label: 'Effective date', type: 'date', value: TODAY })}${U.field({ id: 'why', label: 'Reason', ph: 'Written on every history row' })}</div>
    <div class="card tight"${I('D-051')}><table class="rtable"><thead><tr><th>Hold back</th><th>Student</th><th>Semester</th><th>Stage</th></tr></thead><tbody>${live.map((s) => { const bl = blocked(s); return `<tr><td data-l="Hold back"><input type="checkbox" class="tick" data-act-change="x" data-f="hold" value="${s.id}"${held.has(s.id) ? ' checked' : ''} aria-label="Hold back ${esc(s.name)}"${last ? ' disabled' : ''}></td><td data-l="Student" class="lead-cell">${esc(s.name)}<div class="xs muted">${s.usn}</div></td><td data-l="Semester">${bl ? `${chip('Blocked', 'risk')}<div class="xs">${esc(bl)}</div>` : held.has(s.id) ? `Stays on ${s.sem}` : `${s.sem} → ${to}`}</td><td data-l="Stage">${chip(stageAt(c.id, to) || s.stage, 'info')}</td></tr>`; }).join('')}</tbody></table></div></div>`;
  const foot = () => `<span class="hrow"${I('D-052')}><button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="go"${anyBlocked() || !live.length ? ' disabled title="Hold them back, or graduate the batch"' : ''}>Promote ${live.filter((s) => !held.has(s.id)).length} students</button></span>`;
  Sheet.open({ title: `Promote ${blabel(b)} to semester ${to}`, wide: true, body: body(), foot: foot(),
    onAct: {
      'change:hold'(a, ev, el) { a.checked ? held.add(a.value) : held.delete(a.value); el.querySelector('.sh-b').innerHTML = body(); el.querySelector('.sh-f').innerHTML = foot(); },
      go(a, ev, el) {
        const v = formVals(el); let moved = 0;
        live.forEach((s) => { if (held.has(s.id)) { MOVES.unshift({ batch: b.id, kind: 'Held back', sid: s.id, move: `Stays on ${s.sem}`, eff: v.eff, by: ME, reason: v.why }); return; } MOVES.unshift({ batch: b.id, kind: 'Promoted', sid: s.id, move: `Semester ${s.sem} → ${to}`, eff: v.eff, by: ME, reason: v.why }); s.sem = to; s.stage = stageAt(c.id, to) || s.stage; moved++; });
        b.sem = to; Sheet.close(); audit('cohort.promote', 'cohort', b.id, blabel(b), { semester: to - 1 }, { semester: to });
        flash(st, `${blabel(b)} promoted · ${moved} moved up · ${held.size} held back · 0 skipped. Results, ledger, interviews and badges were not touched.`, 'good', I('D-053')); App.rerender();
      },
    } });
}
function openGraduate(b, st) {
  const c = crs(b.course);
  const g = b.graduated; const days = g ? Math.round((new Date(TODAY) - new Date(g.at)) / 864e5) : 99;
  if (g && days <= 30) {
    const alumni = ROSTER.filter((s) => s.batch === b.id && s.alumni);
    return Sheet.open({ title: `Reverse the graduation of ${blabel(b)}`, center: true,
      body: `<div class="stack">${kv([['Graduated', fmtDate(g.at)], ['Accounts', `${alumni.length} alumni`], ['Window', `${30 - days} days left to reverse`]])}<p class="small">Kept alumni profiles become unreachable until they graduate again.</p></div>`,
      foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn danger solid" type="button" data-act="rev"${I('D-058')}>Put ${alumni.length} accounts back to student</button>`,
      onAct: { rev() { alumni.forEach((s) => { s.alumni = false; MOVES.unshift({ batch: b.id, kind: 'Graduation reversed', sid: s.id, move: 'Alumni → Semester 4', eff: TODAY, by: ME, reason: '' }); }); b.graduated = null; b.ended = false; Sheet.close(); audit('cohort.ungraduate', 'cohort', b.id, blabel(b)); flash(st, `Graduation reversed · ${alumni.length} accounts are students again · ${alumni.length} alumni profiles kept but unreachable until they graduate again.`, 'warn', I('D-059')); App.rerender(); } } });
  }
  const live = liveIn(b); const notFinal = b.sem < c.sems;
  const body = `<div class="stack"${I('D-054')}><div class="list">${U.row({ title: 'Final semester reached', sub: notFinal ? `Semester ${b.sem} of ${c.sems}` : `Semester ${b.sem} of ${c.sems}`, trail: notFinal ? chip('Blocked', 'risk') : chip('Clear', 'good'), chev: false })}</div>
    <p class="small"><b>No alumni profile is created.</b> Each graduate meets the alumni first-login form. Graduates are signed out of every device.</p>
    <div class="form-grid"${I('D-055')}>${U.field({ id: 'gdate', label: 'Graduation date', type: 'date', value: TODAY })}${U.field({ id: 'why', label: 'Reason', ph: 'Optional' })}</div>
    <div class="card tight"${I('D-056')}><table class="rtable"><thead><tr><th>Student</th><th>Semester</th><th>Account</th></tr></thead><tbody>${live.map((s) => `<tr><td class="lead-cell" data-l="Student">${esc(s.name)}<div class="xs muted">${s.usn}</div></td><td data-l="Semester">${s.sem} of ${c.sems}</td><td data-l="Account">${notFinal ? `${chip('Blocked', 'risk')} <span class="xs">Not the final semester</span>` : 'STUDENT → ALUMNI'}</td></tr>`).join('') || `<tr><td class="lead-cell" data-l="Student">Nobody in this batch</td><td data-l="Semester">—</td><td data-l="Account">—</td></tr>`}</tbody></table></div></div>`;
  Sheet.open({ title: `Graduate ${blabel(b)}`, wide: true, body,
    foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="go"${I('D-057')}${notFinal || !live.length ? ' disabled' : ''}>Graduate ${live.length} students</button>`,
    onAct: { go(a, ev, el) { const v = formVals(el); live.forEach((s) => { s.alumni = true; MOVES.unshift({ batch: b.id, kind: 'Graduated', sid: s.id, move: `Semester ${s.sem} → Alumni`, eff: v.gdate, by: ME, reason: v.why }); }); b.graduated = { at: TODAY, count: live.length }; b.ended = true; Sheet.close(); audit('cohort.graduate', 'cohort', b.id, blabel(b), { role: 'STUDENT' }, { role: 'ALUMNI', count: live.length }); flash(st, `${live.length} graduated · their accounts are ALUMNI and every device was signed out. Reversible for 30 days.`, 'good', I('D-059')); App.rerender(); } } });
}

function rosterPage(st) {
  st.hide ||= { batch: true }; st.sel ||= {};
  const rows = rosterRows(st); const bv = batchesInView(st); const one = bv.length === 1 ? bv[0] : null;
  const pi = paged(st, rows); const H = st.hide; const nSel = Object.keys(st.sel).filter((k) => st.sel[k]).length;
  const years = [...new Set(BATCH.map((b) => b.year))].sort().reverse();
  const yearOpts = [['', 'Every student'], ['none', 'No batch yet'], ...years.map((y) => [y, BATCH.filter((b) => b.year === y).every((b) => b.ended) ? `${y} (ended)` : y])];
  const deptOpts = [['', 'All departments'], ...DEPT.filter((d) => !d.archived).map((d) => [d.id, d.name])];
  const courseOpts = [['', 'All courses'], ...COURSE.filter((c) => !st.dept || c.dept === st.dept).map((c) => [c.id, c.name])];
  const specOpts = [['', 'All specializations'], ...SPEC.filter((p) => (!st.course || p.course === st.course) && (!st.dept || crs(p.course).dept === st.dept)).map((p) => [p.id, p.name])];
  const why = bv.length > 1 ? 'This year spans several batches — pick a course and specialization too.' : 'Pick one batch first.';
  const nextSem = one ? one.sem + 1 : null;
  const acts = `<button class="btn" type="button" data-act="batchActs"${I('D-002')}${one ? '' : ` disabled title="${why}"`}>${ic('layers', 'sm')}Batch actions</button>
    <button class="btn" type="button" data-act="promote"${I('D-004')}${one ? '' : ` disabled title="${why}"`}>${ic('chart', 'sm')}${one ? `Promote to semester ${nextSem}` : 'Promote batch'}</button>
    <button class="btn" type="button" data-act="graduate"${I('D-003')}${one ? '' : ` disabled title="${why}"`}>${ic('trophy', 'sm')}${one && one.graduated ? 'Graduation' : 'Graduate batch'}</button>`;
  const th = (k, t) => (H[k] ? '' : `<th>${t}</th>`);
  const td = (k, l, v, cls = '') => (H[k] ? '' : `<td data-l="${l}"${cls ? ` class="${cls}"` : ''}>${v}</td>`);
  const table = rows.length ? `<div class="card tight scroll-x only-wide"${I('D-018')}><table class="rtable${st.compact ? ' compact' : ''}"><thead><tr><th><input type="checkbox" class="tick" data-act="selAll" aria-label="Select every row on this page"${pi.rows.length && pi.rows.every((s) => st.sel[s.id]) ? ' checked' : ''}></th><th>USN</th>${th('student', 'Student')}${th('spec', 'Spec.')}${th('sem', 'Sem')}${th('stage', 'Stage')}${th('fac', 'Faculty')}${th('batch', 'Batch')}${th('status', 'Status')}<th class="r">Actions</th></tr></thead><tbody>
    ${pi.rows.map((s) => `<tr><td data-l="Select">${cbx('tick', s.id, st.sel[s.id], `Select ${s.name}`)}</td><td data-l="USN" class="lead-cell num nw">${s.usn}</td>
      ${td('student', 'Student', `<a class="hrow plain-link" style="flex-wrap:nowrap" href="#/admin/students/${s.id}"${I('D-019')}><span class="avatar" style="width:28px;height:28px;font-size:11px">${initials(s.name)}</span><span><b>${esc(s.name)}</b><br><span class="xs muted">${esc(s.email)}</span></span></a>`)}
      ${td('spec', 'Spec.', esc(specLabel(s)))}${td('sem', 'Sem', s.sem)}${td('stage', 'Stage', s.stage)}${td('fac', 'Faculty', s.fac ? `<span class="nw">${esc(facName(s.fac))}</span>` : '<span class="muted nw">Not assigned</span>')}${td('batch', 'Batch', s.batch ? esc(blabel(bat(s.batch))) : '<span class="muted">No batch</span>')}
      ${td('status', 'Status', chip(sStatus(s), tone[sStatus(s)], I('D-022')))}
      <td data-l="Actions" class="r"><span class="hrow" style="justify-content:flex-end;flex-wrap:nowrap"><a class="icon-btn" href="#/admin/students/${s.id}" aria-label="View ${esc(s.name)}"${I('D-020')}>${ic('eye')}</a><button class="icon-btn" type="button" data-act="edit" data-id="${s.id}" aria-label="Edit ${esc(s.name)}"${I('D-021')}>${ic('pen')}</button></span></td></tr>`).join('')}
    </tbody></table></div>
    <div class="list only-phone"${I('D-018')}>${pi.rows.map((s) => `<div class="row"><label class="tickwrap">${cbx('tick', s.id, st.sel[s.id], `Select ${s.name}`)}</label><a class="body" href="#/admin/students/${s.id}"><div class="ttl">${esc(s.name)}</div><div class="sub">${s.usn} · ${esc(specLabel(s))} · Sem ${s.sem} · ${s.fac ? esc(facName(s.fac)) : 'No faculty member'}</div></a><div class="trail">${chip(sStatus(s), tone[sStatus(s)])}<button class="icon-btn" type="button" data-act="edit" data-id="${s.id}" aria-label="Edit ${esc(s.name)}">${ic('pen')}</button></div></div>`).join('')}</div>`
    : `<div class="card"${I('D-023')}>${U.empty('users', st.status === 'Removed' ? 'Nobody has been removed' : st.q ? `No student matches “${esc(st.q)}”` : 'No student in this view', st.status === 'Removed' ? 'Removed students appear here, ready to restore.' : 'Clear a filter to see more.')}</div>`;
  const pager = pagerBar(st, rows.length, pi, `<span>Rows <b class="num">${rows.length}</b></span><span>Selected <b class="num">${nSel}</b></span>`, I('D-024'));
  const facts = one ? `<div class="card facts"${I('D-025')}><div class="card-h"><h2>Batch · ${one.year}</h2>${chip(one.ended ? 'Ended' : 'Running', one.ended ? 'neutral' : 'good')}</div>${kv([['Course', esc(crs(one.course).name)], ['Specialization', one.spec ? esc(spc(one.spec).name) : '—'], ['Department', esc(dep(bDept(one)).name)], ['Current semester', `Semester ${one.sem} of ${crs(one.course).sems}`], ['Students', liveIn(one).length], ['No faculty member', liveIn(one).filter((s) => !s.fac).length], ['In view', rows.length], ['Term', bTerm(one)]])}</div>`
    : `<div class="card facts"${I('D-026')}><div class="card-h"><h2>Roster</h2></div>${kv([['Students in view', rows.length], ['With a faculty member', rows.filter((s) => s.fac).length], ['No faculty member', rows.filter((s) => !s.fac).length], ['Batches', new Set(rows.map((s) => s.batch).filter(Boolean)).size]])}<p class="xs muted" style="margin-top:10px">Pick one batch above to act on it, promote it or graduate it.</p></div>`;
  const hist = one ? MOVES.filter((m) => m.batch === one.id) : [];
  const history = `<div class="card"${I('D-027')}><div class="card-h"><h2>Promotion history</h2>${one ? chip(`${hist.length} moves`, 'info') : ''}</div>
    <div${I('D-028')}>${!one ? '<p class="small muted">Pick one batch above.</p>' : !hist.length ? '<p class="small muted">Nothing has been promoted or graduated in this batch yet.</p>'
      : `<div class="list">${hist.slice(0, 8).map((m) => { const s = stu(m.sid); return U.row({ title: `${esc(s ? s.name : 'Account since removed')} <span class="xs muted">${s ? s.usn : ''}</span>`, sub: `${esc(m.move)} · ${fmtDate(m.eff)} · ${esc(m.by)} · ${m.reason ? esc(m.reason) : 'No reason was recorded.'}`, trail: chip(m.kind, /Promoted|Graduated/.test(m.kind) && m.kind !== 'Graduation reversed' ? 'good' : 'warn'), chev: false }); }).join('')}</div>`}</div>
    <p class="xs muted" style="margin-top:10px"${I('D-029')}>${ic('lock', 'sm')} Promotion keeps every record: results, ledger, interviews and badges stay with the student, and sign-ins are unchanged.</p></div>`;
  return U.page({ title: 'Students & batches',
    lede: `<span${I('D-001')}>${rows.length} in view · ${ROSTER.filter((s) => !s.removed && !s.alumni).length} on the roster · ${BATCH.filter((b) => !b.ended).length} running batches</span>`,
    acts,
    body: `${flashBox(st, I('D-005'))}
      <div class="filters">${U.select('dept', deptOpts, st.dept || '', I('D-007'), 'Department')}${U.select('course', courseOpts, st.course || '', I('D-008'), 'Course')}${U.select('spec', specOpts, st.spec || '', I('D-009'), 'Specialization')}${U.select('batch', yearOpts, st.batch || '', I('D-010'), 'Batch')}${U.select('status', [['', 'All statuses'], ['Active', 'Active · has signed in'], ['Invited', 'Invited · not signed in yet'], ['Removed', 'Removed · off the roster, record kept']], st.status || '', I('D-011'), 'Status')}</div>
      <div class="stack">${facts}
        <div class="hrow">${U.search('q', st.q || '', 'Quick filter: name, email or USN', I('D-013'))}</div>
        <div class="hrow"><button class="btn sm" type="button" data-act="assignSel"${I('D-014')}${nSel ? '' : ' disabled'}>${ic('swap', 'sm')}Assign faculty to ${nSel} selected</button><button class="btn sm" type="button" data-act="moveSel"${I('D-015')}${nSel ? '' : ' disabled'}>${ic('layers', 'sm')}Move ${nSel} selected</button><span class="grow"></span>${toolBtns(st, 'roster', I('D-016', 'D-017'))}</div>
        ${table}${rows.length ? pager : ''}
        <a class="small" href="#/admin/registrations"${I('D-012')}>${ic('inbox', 'sm')} Students arrive from Registrations</a>
        ${history}</div>`,
  });
}

/* ---------------------------------------------------------------- Student 360 */
function rec(s) {
  const n = +s.id.slice(1); const inv = s.status === 'Invited'; const b = s.batch && bat(s.batch);
  const results = s.id === 's1' ? D.semesters.map((x) => ({ sem: x.n, sgpa: x.sgpa, cgpa: x.cgpa, cls: x.cls, subj: x.subjects.length, back: 0, cleared: false, pub: x.n === 1 ? '2026-02-10' : '2026-07-08' }))
    : inv ? [] : Array.from({ length: s.sem - 1 }, (_, i) => { const g = +(6.8 + ((n * 7 + i * 3) % 25) / 10).toFixed(1); return { sem: i + 1, sgpa: g, cgpa: g, cls: g >= 8 ? 'First class with distinction' : g >= 7 ? 'First class' : 'Second class', subj: 6, back: s.backlogs && i === s.sem - 2 ? s.backlogs : 0, cleared: n % 5 === 0 && i === 0, pub: i % 2 ? '2026-07-08' : '2026-02-10' }; });
  const weeks = Array.from({ length: 6 }, (_, i) => { const p = inv ? null : 70 + ((n * 11 + i * 7) % 28); return { wk: `w/c ${fmtShort(addDays(TODAY, -7 * (6 - i)))}`, pct: i === 2 && n % 2 ? null : p, hrs: p ? 18 + (i % 4) * 2 : 0 }; });
  const days = Array.from({ length: 7 }, (_, i) => { const d = addDays(TODAY, -(i + 1)); const L = s.id === 's1' ? D.ledger[d] : inv ? null : i === 3 ? null : { status: i === 0 ? 'DRAFT' : 'SUBMITTED' }; const short = s.id === 's1' && i === 0; return { d, status: L ? L.status : 'EMPTY', logged: L ? (short ? 23.5 : 24) : 0 }; });
  const docs = s.id === 's1' ? D.uploads.map((u) => ({ ...u })) : inv ? [{ id: 91, title: 'CV (from the application)', kind: 'Resume / CV', name: 'cv.pdf', size: '240 kB', date: s.enrolled, status: 'Pending review', note: '' }, { id: 92, title: 'Photo (from the application)', kind: 'Profile photo', name: 'photo.jpg', size: '820 kB', date: s.enrolled, status: 'Pending review', note: '' }]
    : [{ id: 93, title: 'Resume', kind: 'Resume / CV', name: 'resume.pdf', size: '210 kB', date: '2026-09-02', status: n % 2 ? 'Verified' : 'Pending review', note: '' }, ...(n % 3 === 0 ? [{ id: 94, title: 'Internship letter', kind: 'Document', name: 'letter.pdf', size: '160 kB', date: '2026-09-18', status: 'Needs changes', note: 'The signature page is missing.' }] : [])];
  const ivs = s.id === 's1' ? D.interviews : !inv && n % 3 === 0 ? [{ id: 70 + n, date: '2026-09-29', track: b && b.spec === 'p2' ? 'Digital Marketing' : 'Financial Analytics', status: 'Completed', answers: 8, phase: 'Wrap-up', audio: false, scores: { overall: 58 + n } }] : !inv && n % 4 === 0 ? [{ id: 80 + n, date: '2026-09-27', track: 'General', status: 'Ended early', answers: 2, phase: 'Opening', audio: false, scores: null }] : [];
  const signins = s.id === 's1' ? D.signIns.map((x, i) => ({ ...x, ip: i === 2 ? null : `49.207.${40 + i}.${11 * (i + 1)}` })) : inv ? [] : [{ when: s.last, door: 'Google', ip: `106.51.${n}.20` }, { when: '2026-10-01 08:10', door: 'Email and password', ip: null }];
  const profile = s.id === 's1' ? { phone: D.me.student.phone, email: 'aarav.k@gmail.com', linkedin: D.me.student.linkedin, github: '', portfolio: '', city: D.me.student.city, summary: D.me.student.summary, skills: ['Credit analysis', 'Excel', 'Financial modelling'] } : inv ? null : { phone: `+91 9${n}845 1${n}2${n}0`.slice(0, 16), email: '', linkedin: `https://linkedin.com/in/${s.name.split(' ')[0].toLowerCase()}`, github: '', portfolio: '', city: 'Bengaluru', summary: '', skills: ['Excel'] };
  const readiness = s.id === 's1' ? D.readiness : inv ? { score: null, band: 'Not measured', factors: D.readiness.factors.map((f) => ({ name: f.name, state: 'Not measured' })) } : { score: 48 + ((n * 9) % 40), band: n % 2 ? 'On track' : 'Needs attention', factors: D.readiness.factors.map((f, i) => ({ name: f.name, state: (n + i) % 3 === 0 ? 'Not met' : (n + i) % 5 === 0 ? 'Not measured' : 'Met' })) };
  const open = [];
  const pend = docs.filter((d) => /Pending|Needs/.test(d.status)).length; if (pend) open.push([`${pend} document${pend > 1 ? 's' : ''} waiting`, 'warn']);
  if (s.id === 's1') open.push(['1 badge claim with the mentor', 'warn']);
  const drafts = days.filter((d) => d.status === 'DRAFT').length; if (drafts) open.push([`${drafts} ledger day not submitted`, 'neutral']);
  if (!profile) open.push(['Profile not saved yet', 'neutral']); else if (!profile.github) open.push(['GitHub and portfolio not filled in', 'neutral']);
  return { results, weeks, days, docs, ivs, signins, profile, readiness, open };
}
const docTone = (st) => (st === 'Verified' ? 'good' : st === 'Rejected' ? 'risk' : 'warn');
function student360(s, st) {
  if (st.lastId !== s.id) { st.lastId = s.id; st.tab360 = 'Overview'; st.edit360 = null; st.so = false; }
  const r = rec(s); const b = s.batch && bat(s.batch); const c = b ? crs(b.course) : COURSE[0]; const tab = st.tab360 || 'Overview';
  const stat = s.removed ? 'Removed' : s.status;
  const head = `<div class="card"${I('D-070')}><div class="hrow" style="gap:14px;flex-wrap:nowrap"><span class="avatar" style="width:52px;height:52px;font-size:18px">${initials(s.name)}</span><div class="grow" style="min-width:0"><h2 style="font-size:20px">${esc(s.name)}</h2>
    <p class="small muted">${s.usn} · ${esc(blabel(b))} · ${esc(dep(s.dept).name)} · Semester ${s.sem} · ${s.fac ? `mentor ${esc(facName(s.fac))}` : 'no faculty member assigned'}</p>
    <div class="hrow" style="margin-top:6px"${I('D-071')}>${chip(stat, tone[stat])}${chip(s.stage, 'info')}</div></div></div>
    <div class="hrow" style="margin-top:12px"><a class="btn sm" href="#/admin/audit?q=${encodeURIComponent(s.name)}"${I('D-072')}>${ic('restore', 'sm')}What changed</a><button class="btn sm" type="button" data-act="ed360" data-mode="batch"${I('D-073')}>${ic('layers', 'sm')}Move batch</button><button class="btn sm" type="button" data-act="ed360" data-mode="profile"${I('D-074')}>${ic('pen', 'sm')}Edit profile</button>${s.removed ? `<button class="btn sm" type="button" data-act="restore360">${ic('restore', 'sm')}Restore to the roster</button>` : `<button class="btn sm danger" type="button" data-act="del360">${ic('trash', 'sm')}Remove or delete…</button>`}</div></div>`;
  const editor = st.edit360 ? `<div class="card" style="margin-top:12px"><div class="card-h"><h2>${st.edit360 === 'batch' ? 'Move batch' : 'Edit profile'}</h2></div><p class="small muted" style="margin-bottom:10px">${st.edit360 === 'batch' ? 'Pick the new batch below.' : 'Nothing here sets a password.'}</p>
    <div class="form-grid" data-form="e360"><div${I('D-075')} class="stack">${U.field({ id: 'e_name', label: 'Full name', value: s.name, req: true })}${U.field({ id: 'e_email', label: 'College email', type: 'email', value: s.email, req: true, hint: 'Only a college domain is accepted.' })}${U.field({ id: 'e_usn', label: 'USN', value: s.usn })}</div>
    <div class="stack">${fld('e_batch', 'Batch', sel('e_batch', batchOpts(['', 'No batch (unseated)']), s.batch || ''), { inv: I('D-076') })}
    <div class="form-grid"${I('D-077')}>${fld('e_stage', 'Stage', sel('e_stage', STAGES.map((x) => [x, x]), s.stage))}${fld('e_sem', 'Semester', sel('e_sem', Array.from({ length: c.sems }, (_, i) => [i + 1, `Semester ${i + 1}`]), s.sem), { hint: `${esc(c.name)} runs ${c.sems} semesters.` })}</div></div></div>
    <div class="hrow" style="margin-top:12px;justify-content:flex-end"${I('D-078')}><button class="btn" type="button" data-act="cancel360">Cancel</button><button class="btn primary" type="button" data-act="save360">Save changes</button></div></div>` : '';
  const tabs = U.tabs('tab360', ['Overview', 'Results', 'Attendance', 'Time sheet', 'Documents', 'Interviews', 'Audit'], tab, I('D-080'));
  let pane = '';
  const refused = s.unreadable ? `<div class="banner warn" role="status"${I('D-081')}>${ic('lock', 'sm')}<div>The time sheet is not readable with this account's access.</div></div>` : '';
  if (tab === 'Overview') {
    const tl = `<div class="card"${I('D-082')}><div class="card-h"><h2>Semester timeline · nothing is rewritten on promotion</h2></div><ol class="tl">${Array.from({ length: c.sems }, (_, i) => { const n = i + 1; const res = r.results.find((x) => x.sem === n); const y0 = b ? +b.year.slice(0, 4) + Math.floor(i / 2) : 2025; const state = n < s.sem ? 'done' : n === s.sem ? 'on' : ''; return `<li class="${state}"><b>Semester ${n}</b> <span class="xs muted">${i % 2 ? `Jan–Jun ${y0 + 1}` : `Jul–Dec ${y0}`}</span><div class="hrow xs">${res ? `SGPA ${res.sgpa} · CGPA ${res.cgpa} ${res.back ? chip(`${res.back} live backlogs`, 'risk') : ''}` : n < s.sem ? '<span class="muted">no results imported</span>' : n === s.sem ? chip('Current', 'info') : '<span class="muted">Ahead</span>'}</div></li>`; }).join('')}<li><b>Alumni</b> <span class="xs muted">after graduation</span></li></ol>
      <p class="xs muted"${I('D-083')}>${esc(c.name)} · ${c.years} years · ${c.sems} semesters</p></div>`;
    const moves = MOVES.filter((m) => m.sid === s.id);
    const movesT = `<div${I('D-084')}>${U.section('Academic moves', moves.length ? U.table([{ h: 'Move', k: 'k' }, { h: 'Semester', k: 'm' }, { h: 'Effective', k: 'e' }, { h: 'By', k: 'b' }, { h: 'Reason', k: 'r' }], moves.map((m) => ({ k: chip(m.kind, m.kind === 'Promoted' || m.kind === 'Graduated' ? 'good' : 'warn'), m: esc(m.move), e: fmtDate(m.eff), b: esc(m.by || 'Account since removed'), r: m.reason ? esc(m.reason) : '<span class="muted">No reason recorded</span>' }))) : '<div class="card"><p class="small muted">No promotion or graduation recorded for this student.</p></div>')}</div>`;
    const ident = `<div class="card"${I('D-085')}><div class="card-h"><h2>Identity & login</h2></div>${kv([['College email', esc(s.email)], ['How they sign in', s.status === 'Invited' ? 'Not yet — setup link sent' : 'Google, and their own password'], ['Last sign-in', s.last ? esc(s.last) : '—'], ['Enrolled', fmtDate(s.enrolled)], ['Interview cap today', s.capReset ? `0 of 8 used · reset ${esc(s.capReset)}` : `${r.ivs.length ? 1 : 0} of 8 used`]])}
      ${s.removed ? `<p class="small" style="color:var(--risk);margin-top:8px">Removed ${fmtDate(s.removed.at)} by ${esc(s.removed.by)} — ${esc(s.removed.reason)}</p>` : ''}<p class="xs muted" style="margin-top:8px">An admin never sets a password.</p>
      <h3 style="margin:12px 0 6px">Recent sign-ins</h3><div class="list"${I('D-086')}>${r.signins.length ? r.signins.map((x) => U.row({ title: esc(x.door), sub: `${x.ip || 'address not recorded'} · ${esc(x.when)}`, lead: U.lead('key'), chev: false })).join('') : U.row({ title: 'No sign-in yet', chev: false })}</div>
      <div class="hrow" style="margin-top:12px"><span${I('D-087')} class="hrow">${st.so ? `<button class="btn sm danger solid" type="button" data-act="soYes">Yes, sign them out</button><button class="btn sm" type="button" data-act="soNo">Cancel</button>` : `<button class="btn sm" type="button" data-act="so">${ic('logout', 'sm')}Sign out everywhere</button>`}</span>
      <button class="btn sm" type="button" data-act="capReset"${I('D-088')}>${ic('restore', 'sm')}Reset daily cap</button></div></div>`;
    const activity = `<div class="card"${I('D-089')}><div class="card-h"><h2>Recent activity</h2><button class="btn sm" type="button" data-act="seg" data-seg="tab360" data-v="Audit">Audit</button></div>${r.ivs.length ? `<div class="list">${r.ivs.map((x) => U.row({ title: `Mock interview · ${esc(x.track)}`, sub: `${fmtDate(x.date)} · ${x.status}`, lead: U.lead('mic'), chev: false })).join('')}</div>` : '<p class="small muted">No mock interviews on record for this student.</p>'}</div>`;
    const p = r.profile;
    const contact = `<div class="card"${I('D-090')}><div class="card-h"><h2>Contact & profile</h2><span class="xs muted">As the student filled it in.</span></div>${p ? `${kv([['Phone', `<a href="tel:${p.phone.replace(/\s/g, '')}">${esc(p.phone)}</a>`], ['Contact email', p.email ? esc(p.email) : '—'], ['LinkedIn', p.linkedin ? `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener">${esc(p.linkedin.replace('https://', ''))}</a>` : '—'], ['GitHub', p.github || '—'], ['Portfolio', p.portfolio || '—'], ['City', esc(p.city)]])}${p.summary ? `<p class="small" style="margin-top:10px">${esc(p.summary)}</p>` : ''}<div class="hrow" style="margin-top:8px">${p.skills.map((k) => chip(k, 'info')).join('')}</div>` : '<p class="small muted">No profile yet — the student has not saved one.</p>'}</div>`;
    const spells = SPELLS.filter((x) => x.sid === s.id);
    const mentor = `<div class="card"><div class="card-h"><h2>Mentor</h2><a class="btn sm" href="#/admin/mentors"${I('D-091')}>${s.fac ? 'Reassign' : 'Assign a faculty member'}</a></div><p class="small">${s.fac ? `${esc(facName(s.fac))} · their mentee log reaches this student.` : 'Nobody — this student reaches nobody\'s mentee log yet.'}</p>
      <h3 style="margin:12px 0 6px">Assignment history</h3><div${I('D-092')}>${spells.length ? `<div class="list">${spells.slice().reverse().map((x) => U.row({ title: esc(x.fid ? facName(x.fid) : 'Released'), sub: `${x.from ? fmtDate(x.from) : 'Since before this was recorded'} → ${x.to ? fmtDate(x.to) : 'now'} · ${esc(x.kind)} by ${esc(x.by)}${x.endKind ? ` · closed: ${esc(x.endKind)}${x.endReason ? ` — ${esc(x.endReason)}` : ''}` : ''}`, trail: x.to ? '' : chip('Current', 'good'), chev: false })).join('')}</div>` : `<p class="small muted">${s.fac ? 'This pairing predates the history; nothing earlier is recorded.' : 'Never assigned — waiting to be seated with a faculty member.'}</p>`}</div></div>`;
    const openC = `<div class="card"${I('D-093')}><div class="card-h"><h2>Open items</h2>${chip(`${r.open.length} open`, r.open.length ? 'warn' : 'good')}</div>${r.open.length ? `<div class="list">${r.open.map(([t, tn]) => U.row({ title: esc(t), trail: chip(tn === 'warn' ? 'Waiting' : 'To do', tn), chev: false })).join('')}</div>` : '<p class="small muted">Nothing open.</p>'}</div>`;
    const rd = r.readiness; const att = r.weeks.filter((w) => w.pct != null); const attAvg = att.length ? Math.round(att.reduce((a, w) => a + w.pct, 0) / att.length) : null;
    const best = r.ivs.filter((x) => x.scores).map((x) => x.scores.overall); const subm = r.days.filter((d) => d.status === 'SUBMITTED').length;
    const meter = (l, v, pct, tn) => `<div style="margin-bottom:10px"><div class="spread small"><span>${l}</span><b class="num">${v}</b></div>${pct == null ? '' : U.meter(pct, tn)}</div>`;
    const ready = `<div class="card"><div class="card-h"><h2>Placement readiness</h2></div><div class="hrow"${I('D-094')}><span class="kpi-v num">${rd.score == null ? '—' : rd.score}</span><span class="small muted">/ 100</span>${chip(rd.band, rd.score == null ? 'neutral' : rd.score >= 60 ? 'good' : 'warn')}</div>
      <div class="hrow" style="margin:10px 0"${I('D-095')}>${rd.factors.map((f) => chip(`${f.name}: ${f.state}`, f.state === 'Met' ? 'good' : f.state === 'Not met' ? 'risk' : 'neutral')).join('')}</div>
      <div${I('D-096')}>${meter('Attendance', attAvg == null ? 'No sessions yet' : `${attAvg}%`, attAvg, attAvg >= 75 ? 'good' : 'warn')}${meter('Badges earned', s.id === 's1' ? '2 of 48' : s.status === 'Invited' ? '0 of 48' : '1 of 48', s.id === 's1' ? 4 : 2, '')}${meter('Time sheet days submitted', s.unreadable ? '—' : `${subm} of 7`, s.unreadable ? null : Math.round((subm / 7) * 100), '')}${meter('Best interview', best.length ? `${Math.max(...best)} / 100` : 'Not scored yet', best.length ? Math.max(...best) : null, '')}</div>
      ${kv([['English baseline', s.id === 's1' ? 'B2 · provisional' : '—'], ['Verified skills', s.id === 's1' ? 2 : s.status === 'Invited' ? 0 : 1], ['Badge points', s.id === 's1' ? 35 : '—']], I('D-097'))}</div>`;
    pane = `${refused}<div class="grid-2">${tl}${ready}</div>${movesT}<div class="grid-2">${ident}${contact}</div><div class="grid-2">${mentor}<div class="stack">${openC}${activity}</div></div>`;
  } else if (tab === 'Results') {
    pane = `<div${I('D-098')}>${U.section('Results, semester by semester', r.results.length ? U.table([{ h: 'Semester', k: 's' }, { h: 'SGPA', k: 'g', r: 1 }, { h: 'CGPA', k: 'c', r: 1 }, { h: 'Class', k: 'cl' }, { h: 'Subjects', k: 'n', r: 1 }, { h: 'Backlogs', k: 'b' }, { h: 'Published', k: 'p' }], r.results.map((x) => ({ s: `Semester ${x.sem}${x.sem === s.sem - 1 ? ' ' + chip('Latest', 'info') : ''}`, g: x.sgpa, c: x.cgpa, cl: esc(x.cls), n: x.subj, b: x.back ? chip(`${x.back} live`, 'risk') : x.cleared ? chip('Cleared', 'neutral') : chip('None live', 'good'), p: fmtDate(x.pub) }))) : '<div class="card"><p class="small muted">No results imported for this student yet.</p></div>')}</div>`;
  } else if (tab === 'Attendance') {
    pane = `<div${I('D-099')}>${U.section('Attendance · the last six weeks', U.table([{ h: 'Week', k: 'w' }, { h: 'Attendance', k: 'a' }, { h: 'Logged hours', k: 'h', r: 1 }], r.weeks.map((w) => ({ w: w.wk, a: w.pct == null ? chip('No sessions', 'neutral') : chip(`${w.pct}%`, w.pct >= 75 ? 'good' : 'warn'), h: w.hrs ? `${w.hrs} h` : '—' }))))}</div>`;
  } else if (tab === 'Time sheet') {
    const sub = r.days.filter((d) => d.status === 'SUBMITTED'); const started = r.days.filter((d) => d.status !== 'EMPTY');
    pane = `<div${I('D-100')}>${s.unreadable ? `<div class="card">${U.empty('lock', 'Not readable with this account\'s access', 'This student\'s ledger is outside the reach of this account.')}</div>` : `<div class="grid-3" style="margin-bottom:12px">${U.kpi(sub.length, 'Days submitted')}${U.kpi(started.length, 'Days started')}${U.kpi(started.length ? (started.reduce((a, d) => a + d.logged, 0) / started.length).toFixed(1) + ' h' : '—', 'Mean logged hours')}</div>
      ${U.section('Time allocation ledger', U.table([{ h: 'Day', k: 'd' }, { h: 'Status', k: 's' }, { h: 'Logged', k: 'l', r: 1 }, { h: 'Reconciled', k: 'r' }], r.days.map((d) => ({ d: fmtDate(d.d), s: chip(d.status === 'SUBMITTED' ? 'Submitted' : d.status === 'DRAFT' ? 'Draft' : 'Not logged', d.status === 'SUBMITTED' ? 'good' : d.status === 'DRAFT' ? 'warn' : 'neutral'), l: d.logged ? `${d.logged} h` : '—', r: d.status === 'EMPTY' ? '—' : d.logged === 24 ? chip('24 h exactly', 'good') : chip('Short of 24 h', 'warn') }))))}`}</div>`;
  } else if (tab === 'Documents') {
    const pend = r.docs.filter((d) => d.status === 'Pending review').length;
    pane = `<div${I('D-101')}>${U.section('Documents', r.docs.length ? U.table([{ h: 'Document', k: 't' }, { h: 'Kind', k: 'k' }, { h: 'Uploaded', k: 'u' }, { h: 'Status', k: 's' }, { h: "Reviewer's note", k: 'n' }, { h: '', k: 'o', r: 1 }], r.docs.map((d) => ({ t: `<b>${esc(d.title)}</b><div class="xs muted">${esc(d.name)} · ${d.size}</div>`, k: esc(d.kind), u: fmtDate(d.date), s: chip(d.status, docTone(d.status)), n: d.note ? esc(d.note) : '—', o: `<button class="btn sm" type="button" data-act="openDoc" data-n="${esc(d.name)}"${I('D-102')}>${ic('eye', 'sm')}Open</button>` }))) : '<div class="card"><p class="small muted">No documents uploaded.</p></div>', pend ? chip(`${pend} pending review`, 'warn') : '')}</div>`;
  } else if (tab === 'Interviews') {
    pane = `<div${I('D-103')}>${U.section('Mock interviews', r.ivs.length ? U.table([{ h: 'Started', k: 'd' }, { h: 'Track', k: 't' }, { h: 'Status', k: 's' }, { h: 'Reached', k: 'p' }, { h: 'Answers', k: 'a', r: 1 }, { h: 'Score', k: 'sc' }, { h: 'Audio', k: 'au' }], r.ivs.map((x) => ({ d: fmtDate(x.date), t: esc(x.track || 'General'), s: chip(x.status, x.status === 'Completed' ? 'good' : 'neutral'), p: esc(x.phase), a: x.answers, sc: x.scores ? `<b class="num">${x.scores.overall}</b>` : chip('Not scored', 'neutral'), au: x.audio ? chip('Recorded', 'warn') : 'Not recorded' }))) : '<div class="card"><p class="small muted">No mock interviews on record for this student.</p></div>')}</div>`;
  } else {
    const ev = AUD.filter((e) => e.tid === s.id).slice(0, 10);
    pane = `<div${I('D-104')}>${U.section('What staff have done to this record', ev.length ? U.table([{ h: 'When', k: 'w' }, { h: 'Action', k: 'a' }, { h: 'On', k: 'o' }, { h: 'By', k: 'b' }, { h: 'Route', k: 'r' }], ev.map((e) => ({ w: esc(e.at), a: `<code>${esc(e.action)}</code>`, o: esc(e.tl), b: esc(e.actor), r: `<span class="xs">${esc(e.route || '—')}</span>` }))) : '<div class="card"><p class="small muted">No staff action recorded on this student.</p></div>', `<a class="small" href="#/admin/audit">What changed</a>`)}</div>`;
  }
  return U.page({ title: s.name, back: true,
    lede: `<span class="crumbs"${I('D-069')}>People / <a href="#/admin/students">Students & batches</a> / ${s.usn}</span>`,
    body: `${flashBox(st, I('D-079'))}${head}${editor}<div style="margin-top:16px">${tabs}${pane}</div>` });
}

R.screen('admin/students', { title: 'Students & batches', states: 'D-005 D-006 D-028 D-079',
  render({ id, st }) {
    if (id) { const s = stu(id); if (!s) return U.page({ title: 'Student', back: true, body: `<div class="card">${U.empty('users', 'This student is not on record', 'They may have been deleted for good.', '<a class="btn" href="#/admin/students">Students & batches</a>')}</div>` }); return student360(s, st); }
    return rosterPage(st);
  },
  acts: withCommon({
    'change:dept'(el, ev, st) { st.course = ''; st.spec = ''; st.pg = 0; App.rerender(); },
    'change:course'(el, ev, st) { st.spec = ''; st.pg = 0; App.rerender(); },
    'change:status'(el, ev, st) { st.sel = {}; st.pg = 0; App.rerender(); },
    'change:batch'(el, ev, st) { st.pg = 0; App.rerender(); },
    tick(el, ev, st) { st.sel[el.dataset.id] = !st.sel[el.dataset.id]; App.rerender(); },
    selAll(el, ev, st) { const pi = paged(st, rosterRows(st)); const all = pi.rows.every((s) => st.sel[s.id]); pi.rows.forEach((s) => { st.sel[s.id] = !all; }); App.rerender(); },
    assignSel(el, ev, st) { openSelection('assign', Object.keys(st.sel).filter((k) => st.sel[k]), st); },
    moveSel(el, ev, st) { openSelection('move', Object.keys(st.sel).filter((k) => st.sel[k]), st); },
    edit(el, ev, st) { openEditStudent(stu(el.dataset.id), st); },
    batchActs(el, ev, st) { openBatchActions(batchesInView(st)[0], st); },
    promote(el, ev, st) { openPromote(batchesInView(st)[0], st); },
    graduate(el, ev, st) { openGraduate(batchesInView(st)[0], st); },
    ed360(el, ev, st) { st.edit360 = el.dataset.mode; App.rerender(); setTimeout(() => { const f = document.getElementById(el.dataset.mode === 'batch' ? 'e_batch' : 'e_name'); if (f) f.focus(); }, 50); },
    cancel360(el, ev, st) { st.edit360 = null; App.rerender(); },
    save360(el, ev, st) {
      const s = stu(App.cur.id); const box = document.querySelector('[data-form="e360"]'); const v = formVals(box); const e = {};
      const nb = v.e_batch ? bat(v.e_batch) : null; const cid = nb ? bCollege(nb) : sCollege(s);
      if (!v.e_name) e.e_name = 'A name is required.';
      if (!v.e_email) e.e_email = 'A college email is required.'; else if (!domainsOf(cid).some((d) => v.e_email.toLowerCase().endsWith('@' + d))) e.e_email = `Only ${domainsOf(cid).join(', ')} is accepted.`;
      if (!errs(box, e)) return;
      const before = { name: s.name, batch: s.batch, sem: s.sem };
      Object.assign(s, { name: v.e_name, email: v.e_email.toLowerCase(), usn: (v.e_usn || s.usn).toUpperCase(), batch: v.e_batch || null, dept: nb ? bDept(nb) : s.dept, stage: v.e_stage, sem: +v.e_sem });
      if (nb && s.spec2 === nb.spec) s.spec2 = null;
      audit('student.update', 'student', s.id, s.name, before, { name: s.name, batch: s.batch, sem: s.sem }); st.edit360 = null; flash(st, 'Saved.'); App.rerender();
    },
    so(el, ev, st) { st.so = true; App.rerender(); },
    soNo(el, ev, st) { st.so = false; App.rerender(); },
    soYes(el, ev, st) { const s = stu(App.cur.id); st.so = false; audit('user.sign_out_everywhere', 'user', s.id, s.name); flash(st, `${s.name} is signed out on every device. Nothing else changed.`); App.rerender(); },
    capReset(el, ev, st) { const s = stu(App.cur.id); Sheet.reason({ title: 'Why are you giving these attempts back?', ok: 'Give the attempts back', onOk(why) { s.capReset = stamp(); audit('interview_cap.reset', 'student', s.id, s.name, null, null, { reason: why }); flash(st, 'The daily window restarts from now. Attempts already counted are kept.'); App.rerender(); } }); },
    openDoc(el) { toast(`Opening ${el.dataset.n} in a new tab`); },
    del360(el, ev, st) { removeStudent(stu(App.cur.id), st, true); },
    restore360(el, ev, st) { const s = stu(App.cur.id); s.removed = null; audit('user.restore', 'student', s.id, s.name); flash(st, `${s.name} is back on the roster. Nothing was lost.`); App.rerender(); },
  }),
});

/* ================================================================ Faculty */
COLSETS.faculty = [['faculty', 'Faculty', true], ['dept', 'Department'], ['desig', 'Designation'], ['mg', 'Mentor group'], ['status', 'Status']];
const fDept = (f) => dep(f.dept); const fCollege = (f) => col(fDept(f).college);
function facRows(st) {
  const q = (st.q || '').toLowerCase(); const removed = st.status === 'Removed';
  return FAC.filter((f) => (removed ? !!f.removed : !f.removed)).filter((f) => {
    if (st.college && fDept(f).college !== st.college) return false;
    if (st.dept && f.dept !== st.dept) return false;
    if (st.mg === 'mentor' && !menteesOf(f.id).length) return false;
    if (st.mg === 'none' && menteesOf(f.id).length) return false;
    if ((st.status === 'Active' || st.status === 'Disabled') && f.status !== st.status) return false;
    return !q || `${f.name} ${f.email} ${fDept(f).name} ${f.desig}`.toLowerCase().includes(q);
  }).sort(by('name'));
}
function facDetail(f, st) {
  const tab = st.ftab || 'Profile'; const n = menteesOf(f.id).length; const stt = fStatus(f); const mint = (st.minted ||= {})[f.id];
  const myGrants = typeof GRANTS !== 'undefined' ? GRANTS.filter((g) => g.subj.id === f.id) : [];
  let pane;
  if (tab === 'Profile') {
    pane = `<div class="stack" data-form="fprof"><div${I('D-142')} class="stack">${U.field({ id: 'p_name', label: 'Name', value: f.name, req: true })}${U.field({ id: 'p_email', label: 'Official email', type: 'email', value: f.email, req: true, attrs: ` data-act-input="x" data-f="p_email" data-orig="${esc(f.email)}"`, hint: 'Changing the address signs every device out.' })}</div>
      <div data-slot="off" hidden${I('D-143')} class="stack"><label class="check"><input type="checkbox" name="p_off"><span>This address is outside the college's domains</span></label>${U.field({ id: 'p_offwhy', label: 'Why this address', type: 'textarea' })}</div>
      <div class="form-grid"${I('D-144')}>${fld('p_college', 'College', `<input class="input" id="p_college" value="${esc(fCollege(f).name)}" readonly>`, { hint: 'Follows the department.' })}${fld('p_dept', 'Department', sel('p_dept', [['', 'Not filed'], ...DEPT.map((d) => [d.id, `${d.name} · ${col(d.college).code}`])], f.dept))}</div>
      <div${I('D-145')} class="stack">${U.field({ id: 'p_desig', label: 'Designation', value: f.desig, hint: 'Printed on the college\'s leave form.' })}<div class="hrow" style="justify-content:flex-end"><button class="btn primary" type="button" data-act="fsave"${f.removed ? ' disabled' : ''}>Save changes</button></div></div></div>`;
  } else if (tab === 'Access') {
    pane = `<div class="stack"${I('D-146')}><div class="card flat"><div class="card-h"><h3>Mentor</h3>${chip(n ? 'Mentor' : 'No mentor group', n ? 'good' : 'neutral')}</div><p class="small">${n ? `Mentors ${n} student${n > 1 ? 's' : ''}: ${menteesOf(f.id).map((s) => esc(s.name)).join(', ')}.` : 'Mentors nobody yet. Mentor functions arrive with the first student.'}</p><div class="hrow" style="margin-top:8px"><a class="btn sm" href="#/admin/mentors">Assign students</a><a class="btn sm" href="#/admin/governance">Who can do what</a></div></div>
      <div class="list">${myGrants.length ? myGrants.map((g) => U.row({ title: esc(capLabel(g.cap)), sub: esc(reachLabel(g)), trail: chip(gStatus(g), gTone(gStatus(g))), href: '#/admin/governance', chev: true })).join('') : U.row({ title: 'No granted screens', sub: 'Faculty · baseline only', chev: false })}</div></div>`;
  } else {
    pane = `<div class="stack"><div class="card flat stack"${I('D-147')}><b>Sign-in link</b><p class="small muted">A new link replaces every older one.</p><button class="btn" type="button" data-act="mint"${f.disabled || f.removed ? ' disabled title="The account is disabled"' : ''}>${ic('link', 'sm')}Make a sign-in link</button>
      ${mint ? `<div${I('D-148')} class="stack"><label class="small" for="mintv"><b>Hand this over</b></label><div class="hrow" style="flex-wrap:nowrap"><input class="input" id="mintv" readonly value="${esc(mint)}"><button class="btn" type="button" data-act="copyMint">${ic('copy', 'sm')}Copy</button></div><div class="hrow">${chip('Expires in 168 h', 'info')}${chip('Mail is off — read it out', 'warn')}</div></div>` : ''}</div>
      <div class="card flat"${I('D-149')}><b>Every device</b><p class="small muted">Signs out everywhere; nothing else changes. An admin never sets a password.</p><button class="btn" type="button" data-act="fso" style="margin-top:8px">${ic('logout', 'sm')}Sign out everywhere</button></div></div>`;
  }
  return `<div class="card"${I('D-140')}><div class="hrow" style="flex-wrap:nowrap;gap:12px"><span class="avatar">${initials(f.name)}</span><div class="grow" style="min-width:0"><h2>${esc(f.name)}</h2><p class="small muted">${esc(f.desig)} · ${esc(fDept(f).name)} · ${esc(fCollege(f).code)} · ${esc(f.email)}</p></div>${chip(stt, tone[stt])}${wide() ? `<a class="icon-btn" href="#/admin/faculty" aria-label="Close">${ic('x')}</a>` : ''}</div>
    ${f.disabled ? `<p class="small" style="color:var(--risk);margin-top:8px">Disabled ${fmtDate(f.disabled.at)} — ${esc(f.disabled.reason)}</p>` : ''}${f.removed ? `<p class="small" style="color:var(--risk);margin-top:8px">Removed ${fmtDate(f.removed.at)} — ${esc(f.removed.reason)}</p>` : ''}
    <div style="margin-top:12px">${U.tabs('ftab', ['Profile', 'Access', 'Sessions'], tab, I('D-141'))}${pane}</div>
    <div class="hrow" style="margin-top:16px;border-top:1px solid var(--hairline-26);padding-top:12px">${f.removed ? `<button class="btn" type="button" data-act="frestore"${I('D-151')}>${ic('restore', 'sm')}Restore to the roster</button>` : `<span class="hrow"${I('D-150')}><button class="btn sm" type="button" data-act="fso">Sign out everywhere</button>${f.disabled ? `<button class="btn sm" type="button" data-act="fenable">Enable account</button>` : `<button class="btn sm" type="button" data-act="fdisable" data-id="${f.id}">Disable account</button>`}<button class="btn sm danger" type="button" data-act="fdel">${ic('trash', 'sm')}Remove or delete…</button></span>`}</div></div>`;
}
function openDisable(f, st) {
  const ok = (v) => words(v).length >= 3;
  const foot = (v) => `<span class="hrow"${I('D-154')}><button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn danger solid" type="button" data-act="go"${ok(v) ? '' : ' disabled title="Give a reason first."'}>Disable account</button></span>`;
  Sheet.open({ title: `Disable ${f.name}`, body: `<div class="stack"><ul class="plan"${I('D-152')}>${['Sign-in stops — password and Google both.', 'Every device is signed out; outstanding links are spent.', `Their ${menteesOf(f.id).length} mentees are released.`, 'Granted functions are NOT revoked.', 'Notes, signature and leave stay.'].map((t) => `<li>${ic('info', 'sm')}<span>${t}</span></li>`).join('')}</ul>
      <div${I('D-153')} class="stack">${U.field({ id: 'why', label: 'Reason', type: 'textarea', req: true, attrs: ' data-act-input="x" data-f="why"' })}${U.field({ id: 'eff', label: 'Effective', value: 'Today, immediately', attrs: ' readonly' })}</div><p class="xs muted">The Main Admin can enable it again within 90 days; functions are then granted again explicitly.</p></div>`,
    foot: foot(''),
    onAct: { 'input:why'(a, ev, el) { el.querySelector('.sh-f').innerHTML = foot(a.value); },
      go(a, ev, el) { const v = el.querySelector('#why').value; if (!ok(v)) return errs(el, { why: 'Reason is required (at least 3 characters).' }); const rel = menteesOf(f.id); rel.forEach((s) => { s.fac = null; SPELLS.push({ sid: s.id, fid: null, from: TODAY, to: null, kind: 'Released', by: ME, endKind: 'faculty_disabled' }); }); f.status = 'Disabled'; f.disabled = { at: TODAY, reason: words(v) }; audit('user.disable', 'faculty', f.id, f.name, { disabled_at: null }, { disabled_at: TODAY }, { reason: words(v) }); Sheet.close(); flash(st, `${f.name} is disabled · ${rel.length} mentees released.`); App.rerender(); } } });
}
function facultyPage(st, id) {
  st.hide ||= {}; st.sel ||= {};
  const rows = facRows(st); const pi = paged(st, rows); const H = st.hide;
  const ticked = Object.keys(st.sel).filter((k) => st.sel[k]); const one = ticked.length === 1 ? fac(ticked[0]) : null;
  const pick = id ? fac(id) : null;
  const list = rows.length ? `<div class="list${st.compact ? ' compact' : ''}"${I('D-138')}>${pi.rows.map((f) => { const n = menteesOf(f.id).length; const stt = fStatus(f); const facts = [!H.dept && esc(fDept(f).name), !H.desig && esc(f.desig), !H.mg && (n ? `Mentor · ${n}` : 'No mentor group')].filter(Boolean).join(' · ');
      return `<div class="row${pick === f ? ' sel' : ''}"><label class="tickwrap">${cbx('ftick', f.id, st.sel[f.id], `Select ${f.name}`)}</label><a class="body" href="#/admin/faculty/${f.id}"><div class="ttl">${esc(f.name)}</div><div class="sub">${facts}</div></a><div class="trail">${H.status ? '' : chip(stt, tone[stt])}<a class="icon-btn" href="#/admin/faculty/${f.id}" aria-label="Edit ${esc(f.name)}">${ic('pen')}</a></div></div>`; }).join('')}</div>`
    : `<div class="card">${U.empty('user', st.status === 'Removed' ? 'Nobody has been removed' : 'No faculty member matches', 'Clear a filter to see more.')}</div>`;
  const pager = pagerBar(st, rows.length, pi, `<span>Rows <b class="num">${rows.length}</b></span><span>Selected <b class="num">${ticked.length}</b></span>`, I('D-139'));
  const listCol = `<div class="stack"><div class="hrow">${U.search('q', st.q || '', 'Quick filter: name, email, department, designation', I('D-135'))}</div>
    <div class="hrow"><button class="btn sm" type="button" data-act="fdisable" data-id="${one ? one.id : ''}"${I('D-136')}${one && !one.disabled && !one.removed ? '' : ' disabled title="Tick exactly one faculty member to disable."'}>${ic('lock', 'sm')}Disable</button><a class="btn sm" href="#/admin/mentors"${I('D-134')}>${ic('swap', 'sm')}Assign students</a><span class="grow"></span>${toolBtns(st, 'faculty', I('D-137'))}</div>${list}${rows.length ? pager : ''}</div>`;
  const colleges = COLL.filter((c) => !c.archived);
  return U.page({ title: 'Faculty',
    lede: `<span${I('D-127')}>${FAC.filter((f) => !f.removed).length} faculty accounts · ${FAC.filter((f) => menteesOf(f.id).length).length} mentoring · ${FAC.filter((f) => f.disabled).length} disabled</span>`,
    acts: `<a class="btn" href="#/admin/governance?tab=review"${I('D-128')}>${ic('clock', 'sm')}Review expiring access</a><a class="btn primary" href="#/admin/faculty-new"${I('D-129')}>${ic('plus', 'sm')}Add faculty</a>`,
    body: `${flashBox(st)}<div class="filters">${U.select('college', [['', 'All colleges'], ...colleges.map((c) => [c.id, c.code + ' · ' + c.name])], st.college || '', I('D-130'), 'College')}${U.select('dept', [['', 'All departments'], ...DEPT.filter((d) => !st.college || d.college === st.college).map((d) => [d.id, d.name])], st.dept || '', I('D-131'), 'Department')}${U.select('mg', [['', 'Mentor group: all'], ['mentor', 'Mentor'], ['none', 'No mentor group']], st.mg || '', I('D-132'), 'Mentor group')}${U.select('status', [['', 'All statuses'], ['Active', 'Active'], ['Disabled', 'Disabled'], ['Removed', 'Removed · off the roster, record kept']], st.status || '', I('D-133'), 'Status')}</div>
      <div class="split">${listCol}<div class="detail-pane">${pick ? facDetail(pick, st) : `<div class="card">${U.empty('user', 'Pick a faculty member.')}</div>`}</div></div>` });
}
R.screen('admin/faculty', { title: 'Faculty', states: '',
  render({ id, st }) {
    if (st.lastF !== id) { st.lastF = id; st.ftab = 'Profile'; }
    if (id && !wide()) { const f = fac(id); return U.page({ title: f ? f.name : 'Faculty', back: true, body: `${flashBox(st)}${f ? facDetail(f, st) : U.empty('user', 'Not on record')}` }); }
    return facultyPage(st, id);
  },
  acts: withCommon({
    'change:college'(el, ev, st) { st.dept = ''; App.rerender(); },
    'change:status'(el, ev, st) { st.sel = {}; App.rerender(); },
    ftick(el, ev, st) { st.sel[el.dataset.id] = !st.sel[el.dataset.id]; App.rerender(); },
    'input:p_email'(el) { const box = document.querySelector('[data-slot="off"]'); if (box) box.hidden = el.value.trim().toLowerCase() === el.dataset.orig; },
    fsave(el, ev, st) {
      const f = fac(App.cur.id); const box = document.querySelector('[data-form="fprof"]'); const v = formVals(box); const e = {};
      if (!v.p_name) e.p_name = 'A name is required.';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.p_email)) e.p_email = 'A full address is needed.';
      const changedEmail = v.p_email.toLowerCase() !== f.email;
      const doms = domainsOf(dep(v.p_dept || f.dept).college);
      if (changedEmail && !doms.some((d) => v.p_email.toLowerCase().endsWith('@' + d)) && !v.p_off) e.p_email = `Not on ${doms.join(', ')}. Tick the box below to allow it.`;
      if (changedEmail && v.p_off && !v.p_offwhy) e.p_offwhy = 'Say why, with the tick.';
      if (!errs(box, e)) return;
      const before = { name: f.name, email: f.email, dept: f.dept, desig: f.desig };
      Object.assign(f, { name: v.p_name, email: v.p_email.toLowerCase(), dept: v.p_dept || f.dept, desig: v.p_desig });
      audit('faculty.update', 'faculty', f.id, f.name, before, { name: f.name, email: f.email, dept: f.dept, desig: f.desig });
      flash(st, changedEmail ? 'Saved. The new address signed every device out.' : 'Saved.'); App.rerender();
    },
    mint(el, ev, st) { const f = fac(App.cur.id); (st.minted ||= {})[f.id] = `https://reep.nhsm.edu.in/activate?token=${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`; audit('user.activation_link', 'faculty', f.id, f.name); App.rerender(); },
    copyMint(el, ev, st) { copy(st.minted[App.cur.id], 'Link copied'); },
    fso(el, ev, st) { const f = fac(App.cur.id); Sheet.confirm({ title: 'Sign out everywhere?', text: `${esc(f.name)} is signed out on every device. Nothing else changes.`, ok: 'Sign them out', onOk() { audit('user.sign_out_everywhere', 'faculty', f.id, f.name); flash(st, `${f.name} is signed out everywhere.`); App.rerender(); } }); },
    fdisable(el, ev, st) { const f = fac(el.dataset.id || App.cur.id); if (f) openDisable(f, st); },
    fenable(el, ev, st) { const f = fac(App.cur.id); f.status = 'Active'; f.disabled = null; audit('user.enable', 'faculty', f.id, f.name); flash(st, `${f.name} can sign in again. Grant functions again explicitly if they need them.`); App.rerender(); },
    fdel(el, ev, st) { const f = fac(App.cur.id); PersonDelete.open({ kind: 'faculty', name: f.name,
      onRemoved(why) { menteesOf(f.id).forEach((s) => { s.fac = null; }); f.removed = { at: TODAY, by: ME, reason: why }; audit('user.remove', 'faculty', f.id, f.name, null, null, { reason: why }); flash(st, `${f.name} was removed; their mentees were released.`); App.rerender(); },
      onDeleted(why) { menteesOf(f.id).forEach((s) => { s.fac = null; }); FAC.splice(FAC.indexOf(f), 1); audit('user.delete_permanent', 'faculty', f.id, f.name, null, null, { reason: why }); flash(st, `${f.name} was deleted for good.`); R.go('#/admin/faculty'); } }); },
    frestore(el, ev, st) { const f = fac(App.cur.id); f.removed = null; audit('user.restore', 'faculty', f.id, f.name); flash(st, `${f.name} is back, exactly as before.`); App.rerender(); },
  }),
});

/* ---------------------------------------------------------------- Add faculty member */
R.screen('admin/faculty-new', { title: 'Add faculty member', states: 'D-107',
  render({ st }) {
    const step = st.step || 1; const c = st.w_college ? col(st.w_college) : null; const d = st.w_dept ? dep(st.w_dept) : null;
    const doms = c && c.domains.length ? c.domains : ['nhsm.edu.in', 'kic.edu.in'];
    const email = (st.w_email || '').trim().toLowerCase(); const offDomain = email.includes('@') && !doms.some((x) => email.endsWith('@' + x));
    const rail = `<ol class="wsteps"${I('D-106')}>${['Institution', 'Identity', 'Invite'].map((t, i) => `<li${i + 1 === step ? ' aria-current="step"' : ''} class="${i + 1 < step || st.created ? 'done' : ''}"><span>${i + 1 < step || st.created ? ic('check', 'sm') : i + 1}</span>${t}</li>`).join('')}</ol>`;
    let body = '';
    if (st.created) {
      const cr = st.created;
      body = `<div class="banner good" role="status"${I('D-123')}>${ic('check', 'sm')}<div><b>${esc(cr.name)} has a faculty account.</b> No mail was sent — this deployment has no mail transport. Hand the link over; it is shown once.</div></div>
        <div class="card" style="margin-top:12px"><div class="card-h"><h2>The invitation</h2>${chip('Expires in 168 h', 'info')}</div><div class="hrow" style="flex-wrap:nowrap"${I('D-124')}><input class="input" readonly value="${esc(cr.link)}" aria-label="Activation link"><button class="btn" type="button" data-act="wcopy">${ic('copy', 'sm')}Copy link</button></div></div>
        <div class="card" style="margin-top:12px"${I('D-125')}><div class="card-h"><h2>What this account can do today</h2></div><p class="small">Nothing yet: no mentees, no console screens, no functions.</p><div class="hrow" style="margin-top:8px"><a class="btn sm" href="#/admin/mentors">Assign faculty</a><a class="btn sm" href="#/admin/governance">Who can do what</a></div></div>
        <div class="sticky-act"${I('D-126')}><button class="btn" type="button" data-act="wagain">Add another</button><a class="btn primary" href="#/admin/faculty">Done</a></div>`;
    } else if (step === 1) {
      const live = COLL; const depts = c ? DEPT.filter((x) => x.college === c.id) : [];
      body = `<div class="card stack" data-form="w">
        ${fld('w_college', 'College', sel('w_college', [['', 'Choose a college'], ...live.map((x) => [x.id, `${x.code} · ${x.name}${x.archived ? ' (archived)' : ''}`])], st.w_college || '', ' data-act-change="filter" data-f="w_college"'), { req: true, inv: I('D-109') })}
        ${fld('w_dept', 'Department', sel('w_dept', [['', c ? 'Choose a department' : 'Choose a college first'], ...depts.map((x) => [x.id, `${x.name}${x.archived ? ' (archived)' : ''}`])], st.w_dept || '', ` data-act-change="filter" data-f="w_dept"${c ? '' : ' disabled'}`), { req: true, inv: I('D-110') })}
        ${c && (c.archived || (d && d.archived) || !depts.length) ? `<div class="banner warn" role="status"${I('D-111', 'D-108')}>${ic('alert', 'sm')}<div>${!depts.length ? `${esc(c.name)} has no departments — nowhere to file this person yet.` : `${c.archived ? 'This college is archived.' : 'This department is archived.'} It is still accepted.`} <a href="#/admin/colleges">Open College structure</a></div></div>` : ''}
        ${U.field({ id: 'w_desig', label: 'Designation', value: st.w_desig || '', ph: 'e.g. Assistant Professor', inv: I('D-112'), attrs: ' data-act-input="x" data-f="w_desig"', hint: 'Printed on the college\'s leave form beside their signature.' })}</div>
        <div class="card" style="margin-top:12px"${I('D-113')}><div class="card-h"><h2>What happens next</h2></div><ol class="small" style="padding-left:18px;display:grid;gap:4px"><li>Identity — name and college email.</li><li>Invite — the account is created with no functions.</li><li>Mentor functions arrive with their first student; anything else is a grant in Who can do what.</li></ol></div>`;
    } else if (step === 2) {
      body = `<div class="card stack" data-form="w">
        ${U.field({ id: 'w_name', label: 'Full name', req: true, value: st.w_name || '', inv: I('D-114'), attrs: ' data-act-input="x" data-f="w_name"' })}
        ${U.field({ id: 'w_email', label: 'College email', type: 'email', req: true, value: st.w_email || '', ph: `name@${doms[0]}`, inv: I('D-115'), hint: `On ${doms.join(', ')}.`, attrs: ' data-act-input="x" data-f="w_email" autocomplete="off"' })}
        <div class="banner warn" role="status" data-slot="offdom" data-doms="${esc(doms.join(','))}"${offDomain ? '' : ' hidden'}${I('D-116')}>${ic('alert', 'sm')}<div>This address is not on one of ${esc(c ? c.name : 'the college')}'s domains (${esc(doms.join(', '))}).</div></div>
        <label class="check"${I('D-117')}><input type="checkbox" data-act-change="x" data-f="w_off"${st.w_off ? ' checked' : ''}><span>Allow an address outside the college domain</span></label>
        ${st.w_off ? U.field({ id: 'w_offwhy', label: 'Why this address is outside the college domain', type: 'textarea', req: true, value: st.w_offwhy || '', inv: I('D-118'), attrs: ' data-act-input="x" data-f="w_offwhy"' }) : ''}
        <div class="card flat"${I('D-119')}><b class="small">Filed under</b>${kv([['College', c ? esc(c.name) : '—'], ['Department', d ? esc(d.name) : '—']])}</div></div>`;
    } else {
      body = `<div class="card"${I('D-120')}><div class="card-h"><h2>Review</h2></div>${kv([['Name', esc(st.w_name)], ['College email', esc(email)], ['College', esc(c.name)], ['Department', esc(d.name)], ['Designation', st.w_desig ? esc(st.w_desig) : '—'], ['Outside the college domain', offDomain ? 'Allowed deliberately' : 'No'], ['Role', 'Faculty · no functions']])}<p class="xs muted" style="margin-top:10px">The sign-in link is emailed when mail is set up; otherwise it is shown once on the next screen.</p></div>`;
    }
    const foot = st.created ? '' : `<div class="sticky-act"${I('D-121')}><a class="btn" href="#/admin/faculty">Cancel</a>${step > 1 ? `<button class="btn" type="button" data-act="wback">Back</button>` : ''}${step < 3 ? `<button class="btn primary" type="button" data-act="wnext">Continue</button>` : `<button class="btn primary" type="button" data-act="wcreate"${I('D-122')}>Create account & invite</button>`}</div>`;
    return U.page({ title: 'Add faculty member', back: true,
      lede: `<span class="crumbs"${I('D-105')}>People / <a href="#/admin/faculty">Faculty</a> / Add faculty member · <a href="#/admin/faculty">Back to faculty</a></span>`,
      body: `${rail}${body}${foot}` });
  },
  acts: {
    'input:w_desig'(el, ev, st) { st.w_desig = el.value; }, 'input:w_name'(el, ev, st) { st.w_name = el.value; }, 'input:w_offwhy'(el, ev, st) { st.w_offwhy = el.value; },
    'input:w_email'(el, ev, st) { st.w_email = el.value; const box = document.querySelector('[data-slot="offdom"]'); const em = el.value.trim().toLowerCase(); if (box) box.hidden = !(em.includes('@') && !box.dataset.doms.split(',').some((x) => em.endsWith('@' + x))); },
    'change:w_off'(el, ev, st) { st.w_off = el.checked; App.rerender(); },
    'change:w_college'(el, ev, st) { st.w_dept = ''; App.rerender(); },
    wback(el, ev, st) { st.step = (st.step || 1) - 1; App.rerender(); },
    wnext(el, ev, st) {
      const box = document.querySelector('[data-form="w"]'); const e = {};
      if ((st.step || 1) === 1) { if (!st.w_college) e.w_college = 'Choose the college this person teaches in.'; else if (!st.w_dept) e.w_dept = 'A faculty account must belong to a department.'; }
      else {
        const c = col(st.w_college); const doms = c.domains.length ? c.domains : ['nhsm.edu.in', 'kic.edu.in']; const em = (st.w_email || '').trim().toLowerCase();
        if (!words(st.w_name)) e.w_name = 'A name is required.';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) e.w_email = 'Type the full address, e.g. name@' + doms[0] + '.';
        else if ([...FAC, ...ROSTER].some((p) => p.email === em)) e.w_email = 'This address already belongs to another account.';
        else if (!doms.some((x) => em.endsWith('@' + x)) && !st.w_off) e.w_email = `Not on ${doms.join(', ')}. Tick the box below to allow it.`;
        if (st.w_off && !words(st.w_offwhy)) e.w_offwhy = 'Say why this address is outside the college domain.';
      }
      if (!errs(box, e)) return;
      st.step = (st.step || 1) + 1; App.rerender();
    },
    wcreate(el, ev, st) {
      const f = { id: uid('f'), name: words(st.w_name), email: st.w_email.trim().toLowerCase(), dept: st.w_dept, desig: st.w_desig || 'Faculty', status: 'Active', removed: null, disabled: null, created: TODAY };
      FAC.push(f); audit('faculty.create', 'faculty', f.id, f.name, null, { email: f.email, role: 'MENTOR' });
      st.created = { name: f.name, link: `https://reep.nhsm.edu.in/activate?token=${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 10)}` }; App.rerender();
    },
    wcopy(el, ev, st) { copy(st.created.link, 'Link copied'); },
    wagain(el, ev, st) { Object.keys(st).forEach((k) => delete st[k]); App.rerender(); },
  },
});

/* ================================================================ Upload spreadsheets */
const RUNS = [
  { id: 'r3', kind: 'Semester marks', batch: 'b1', sem: 2, status: 'Imported', rows: 18, checks: '17 ok · 1 flagged · 0 refused', by: ME, when: '2026-07-08 11:40', errors: [] },
  { id: 'r2', kind: 'Attendance', batch: 'b2', sem: null, status: 'Previewed', rows: 12, checks: '10 ok · 0 flagged · 2 refused', by: ME, when: '2026-09-30 16:05', errors: [[7, 'USN 1NH25MBA099 is not in this batch']] },
  { id: 'r1', kind: 'Semester marks', batch: 'b4', sem: 3, status: 'Could not read', rows: 0, checks: '—', by: 'Ms. Nisha Pai', when: '2026-09-02 10:12', errors: [] },
];
const CRIT = [
  { id: 'cr2', rung: 'k1', name: 'MBA placement rules 2026', cgpa: 6.5, back: 0, att: 75, cert: 50, gap: 24, eff: '2026-07-01', written: '2026-06-28', by: ME, live: true },
  { id: 'cr1', rung: '', name: 'Programme default', cgpa: 6.0, back: 1, att: 75, cert: 0, gap: 36, eff: '2025-07-01', written: '2025-06-20', by: ME, live: true },
  { id: 'cr0', rung: 'k1', name: 'MBA placement rules 2025', cgpa: 6.0, back: 1, att: 70, cert: 0, gap: 24, eff: '2025-07-01', written: '2025-06-21', by: ME, live: false },
];
const rungName = (r) => (r ? crs(r).name : 'Programme');
function previewRun(st) {
  const b = bat(st.ibatch); const live = liveIn(b); const marks = st.ikind !== 'attendance';
  const subs = marks ? [['22MBA31', 'Investment Analysis'], ['22MBA32', 'Financial Derivatives'], ['22MBA33', 'Strategic Management']] : [['22MBA31', 'Investment Analysis'], ['22MBA32', 'Financial Derivatives'], ['22MBA33', 'Strategic Management']];
  const lines = []; let ln = 2;
  live.forEach((s, i) => subs.forEach(([code, name], j) => {
    const warn = i === 0 && j === 0; const it = 30 + ((i * 7 + j * 3) % 20); const ex = 35 + ((i * 5 + j * 11) % 25);
    lines.push({ line: ln++, check: warn ? 'Warning' : 'OK', usn: s.usn, name: s.name, what: warn ? 'Overwrites marks already imported' : 'Adds a result', code, sub: name, cr: 4, int: it, ext: ex, tot: it + ex, sgpa: '', cgpa: '', back: 0, held: 20, att: 14 + ((i + j) % 6) });
  }));
  lines.push({ line: ln++, check: 'Error', usn: '1NH25MBA099', name: '—', what: 'Skipped: this USN is not in the batch', code: '22MBA31', sub: 'Investment Analysis', cr: 4, int: 40, ext: 41, tot: 81, held: 20, att: 18 });
  return { id: uid('r'), kind: marks ? 'Semester marks' : 'Attendance', batch: b.id, sem: marks ? +st.isem : null, status: 'Previewed', lines, shown: Math.min(lines.length, 15), rows: lines.length, by: ME, when: stamp() };
}
R.screen('admin/imports', { title: 'Upload spreadsheets', states: 'D-172',
  render({ st }) {
    const marks = st.ikind !== 'attendance'; const batches = BATCH.filter((b) => !st.icourse || b.course === st.icourse);
    if (st.run && (st.run.kind === 'Attendance') === marks) st.run = null;
    const run = st.run; const f = st.ifile;
    const block = !st.ibatch ? 'Choose a batch first.' : marks && !st.isem ? 'A marks file needs a semester.' : !f ? 'Choose a spreadsheet first.' : f.err || '';
    const stepper = `<ol class="wsteps"${I('D-162')}>${[['Dataset', marks ? 'Semester marks' : 'Attendance'], ['Batch', st.ibatch ? blabel(bat(st.ibatch)) : 'Not chosen'], ['Semester', marks ? (st.isem ? `Semester ${st.isem}` : 'Not chosen') : 'Not needed'], ['File', f ? f.name : 'Not chosen']].map(([k, v]) => `<li class="${/Not chosen/.test(v) ? '' : 'done'}"><span>${/Not chosen/.test(v) ? '·' : ic('check', 'sm')}</span><div><b>${k}</b><div class="xs muted ellip">${esc(v)}</div></div></li>`).join('')}</ol>`;
    const pickers = `<div class="form-grid">
      <div class="field"${I('D-158')}><span class="lbl">File contains</span>${U.seg('ikind', [['marks', 'Semester marks'], ['attendance', 'Attendance']], st.ikind || 'marks')}<div class="hint">${marks ? 'Columns: usn, subject_code, internal, external — optional subject_name, credits, sgpa, cgpa, live_backlogs.' : 'Columns: usn, subject_code, sessions_held, sessions_attended.'}</div></div>
      ${fld('icourse', 'Course', sel('icourse', [['', 'All courses'], ...COURSE.map((c) => [c.id, c.name])], st.icourse || '', ' data-act-change="filter" data-f="icourse"'), { inv: I('D-159') })}
      ${fld('ibatch', 'Batch', sel('ibatch', [['', 'Choose a batch'], ...batches.map((b) => [b.id, blabel(b) + (b.ended ? ' (ended)' : '')])], st.ibatch || '', ' data-act-change="filter" data-f="ibatch"'), { req: true, inv: I('D-160'), hint: batches.length ? '' : chip('No batches under this course yet', 'warn') })}
      ${fld('isem', 'Semester', sel('isem', [['', marks ? 'Choose a semester' : 'Not needed for attendance'], ...[1, 2, 3, 4].map((x) => [x, `Semester ${x}`])], st.isem || '', ` data-act-change="filter" data-f="isem"${marks ? '' : ' disabled'}`), { req: marks, inv: I('D-161') })}</div>`;
    const fileBox = `<div class="stack"${I('D-163')}>${f ? `<div class="hrow"><span class="chip info">${ic('file', 'sm')}${esc(f.name)} · ${f.kb} kB</span><button class="btn sm" type="button" data-act="ifileRm">Remove</button></div>${f.err ? `<p class="small" style="color:var(--risk)" role="alert">${esc(f.err)}</p>` : ''}` : ''}${U.drop('ifile', f ? 'Choose a different file' : 'Choose file', '.csv or .xlsx · up to 10 MB')}</div>`;
    const check = `<div class="hrow"><button class="btn primary" type="button" data-act="icheck"${I('D-164')}${block || st.reading ? ' disabled' : ''}>${st.reading ? 'Reading on the server…' : 'Check file'}</button>${block ? `<span class="small muted">${esc(block)}</span>` : ''}</div>`;
    let prev = '';
    if (run) {
      const ok = run.lines.filter((l) => l.check === 'OK').length; const fl = run.lines.filter((l) => l.check === 'Warning').length; const rf = run.lines.filter((l) => l.check === 'Error').length;
      const shown = run.lines.slice(0, run.shown); const pi = paged(st, shown);
      const cols = marks ? [['Subject', 'sub'], ['Credits', 'cr'], ['Internal', 'int'], ['External', 'ext'], ['Total', 'tot'], ['SGPA', 'sgpa'], ['CGPA', 'cgpa'], ['Backlogs', 'back']] : [['Subject', 'sub'], ['Sessions held', 'held'], ['Attended', 'att'], ['Attendance %', 'pct']];
      prev = run.unreadable ? `<div class="banner risk" role="alert"${I('D-166')}>${ic('alert', 'sm')}<div>The file could not be read: it is empty or not a spreadsheet. Nothing was written.</div></div>`
        : `<div class="hrow"${I('D-167')}>${chip(`${run.lines.length} lines read`, 'info')}${chip(`${ok} ok`, 'good')}${chip(`${fl} flagged`, 'warn')}${chip(`${rf} refused`, 'risk')}${chip(`${ok + fl} ${run.status === 'Imported' ? 'written' : 'would be written'}`, run.status === 'Imported' ? 'good' : 'neutral')}</div>
        ${run.lines.length > run.shown ? `<p class="xs muted"${I('D-166')}>Checked all ${run.lines.length} lines; showing the first ${run.shown}.</p>` : ''}
        <div class="card tight scroll-x"${I('D-165')}><table class="rtable"><thead><tr><th>Line</th><th>Check</th><th>USN</th><th>Student</th><th>What will happen</th>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${pi.rows.map((l) => `<tr><td class="lead-cell num" data-l="Line">${l.line}</td><td data-l="Check">${chip(l.check, l.check === 'OK' ? 'good' : l.check === 'Warning' ? 'warn' : 'risk')}</td><td data-l="USN" class="num">${l.usn}</td><td data-l="Student">${esc(l.name)}</td><td data-l="What will happen">${esc(l.what)}</td>${cols.map(([h, k]) => `<td data-l="${h}">${k === 'pct' ? Math.round((l.att / l.held) * 100) + '%' : l[k] === '' ? '—' : esc(l[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        ${pagerBar(st, shown.length, pi, '', I('D-170'))}`;
      prev = U.section('Preview', `${prev}<div class="hrow" style="margin-top:12px"><button class="btn" type="button" data-act="ierr"${I('D-168')}${rf ? '' : ' disabled'}>${ic('download', 'sm')}Error report</button><button class="btn primary" type="button" data-act="iapply"${I('D-169')}${run.unreadable || run.status === 'Imported' || ok + fl === 0 ? ' disabled' : ''}>${run.status === 'Imported' ? 'Imported' : 'Import rows'}</button></div>`);
    }
    const recent = U.section('Recent imports', U.table([{ h: 'Dataset', k: 'd' }, { h: 'Batch', k: 'b' }, { h: 'Status', k: 's' }, { h: 'Rows', k: 'r', r: 1 }, { h: 'Checks', k: 'c' }, { h: 'By', k: 'by' }, { h: 'When', k: 'w' }], RUNS.map((r) => ({ d: `${r.kind}${r.sem ? ` · Sem ${r.sem}` : ''}`, b: esc(blabel(bat(r.batch))), s: chip(r.status, r.status === 'Imported' ? 'good' : r.status === 'Previewed' ? 'neutral' : 'risk'), r: r.rows, c: esc(r.checks), by: esc(r.by), w: esc(r.when) })), I('D-171')));
    const live = CRIT.find((c) => c.live && c.rung === (st.icourse || '')) || null; const base = live || CRIT.find((c) => c.live && !c.rung);
    const crit = `<div class="card"${I('D-172')}><div class="card-h"><h2>Placement criteria</h2>${chip(rungName(st.icourse || ''), 'info')}</div>
      ${live ? `<p class="small muted" style="margin-bottom:10px">${esc(live.name)} · live since ${fmtDate(live.eff)}</p>` : `<p class="small muted" style="margin-bottom:10px">No placement criteria set for ${esc(rungName(st.icourse || ''))} yet; built-in defaults apply.</p>`}
      <div class="form-grid" data-form="crit"${I('D-173')}>${U.field({ id: 'cname', label: 'Name this set', ph: live ? live.name : 'e.g. MBA placement rules 2027' })}${U.field({ id: 'ccgpa', label: 'Min CGPA', type: 'number', ph: base.cgpa })}${U.field({ id: 'cback', label: 'Max live backlogs', type: 'number', ph: base.back })}${U.field({ id: 'catt', label: 'Min attendance %', type: 'number', ph: base.att })}${U.field({ id: 'ccert', label: 'Cert completion %', type: 'number', ph: base.cert })}${U.field({ id: 'cgap', label: 'Max education gap months', type: 'number', ph: base.gap })}${U.field({ id: 'ceff', label: 'Effective from', type: 'date', value: TODAY })}</div>
      <div class="hrow" style="margin-top:12px;justify-content:flex-end"><button class="btn" type="button" data-act="chist"${I('D-175')}>History</button><button class="btn primary" type="button" data-act="csave"${I('D-174')}>Save</button></div></div>`;
    return U.page({ title: 'Upload spreadsheets', lede: `<span${I('D-155')}>Marks and attendance, from a spreadsheet.</span>`,
      acts: `<button class="btn" type="button" data-act="itpl"${I('D-156')}>${ic('download', 'sm')}Download template</button><button class="btn" type="button" data-act="inew"${I('D-157')}${st.ibatch || st.ifile || st.run ? '' : ' disabled'}>${ic('plus', 'sm')}New import</button>`,
      body: `${flashBox(st)}<div class="adm2-cols"><div class="stack"><div class="card stack"><div class="card-h"><h2>New import</h2></div>${stepper}${pickers}${fileBox}${check}</div>${prev}${recent}</div><div class="stack">${crit}</div></div>` });
  },
  acts: withCommon({
    'change:icourse'(el, ev, st) { if (st.ibatch && bat(st.ibatch).course !== st.icourse && st.icourse) st.ibatch = ''; App.rerender(); },
    'change:ifile'(el, ev, st) { const fl = el.files[0]; if (!fl) return; const ext = fl.name.split('.').pop().toLowerCase(); st.ifile = { name: fl.name, kb: Math.max(0, Math.round(fl.size / 1024)), size: fl.size, err: !['csv', 'xlsx'].includes(ext) ? 'Only .csv or .xlsx files are read.' : fl.size > 10 * 1048576 ? 'This file is over 10 MB.' : '' }; st.run = null; App.rerender(); },
    ifileRm(el, ev, st) { st.ifile = null; st.run = null; App.rerender(); },
    seg(el, ev, st) { st[el.dataset.seg] = el.dataset.v; st.run = null; App.rerender(); },
    icheck(el, ev, st) { st.reading = true; App.rerender(); setTimeout(() => { st.reading = false; const run = previewRun(st); if (!st.ifile.size) { run.unreadable = true; run.status = 'Could not read'; run.lines = []; } st.run = run; st.pg = 0; RUNS.unshift({ id: run.id, kind: run.kind, batch: run.batch, sem: run.sem, status: run.status, rows: run.lines.length, checks: run.unreadable ? '—' : `${run.lines.filter((l) => l.check === 'OK').length} ok · ${run.lines.filter((l) => l.check === 'Warning').length} flagged · ${run.lines.filter((l) => l.check === 'Error').length} refused`, by: ME, when: run.when, errors: [] }); App.rerender(); }, 500); },
    iapply(el, ev, st) { const run = st.run; run.status = 'Imported'; const r = RUNS.find((x) => x.id === run.id); if (r) r.status = 'Imported'; audit('import.apply', 'import', run.id, `${run.kind} · ${blabel(bat(run.batch))}`, null, { rows: run.lines.filter((l) => l.check !== 'Error').length }); flash(st, `${run.lines.filter((l) => l.check !== 'Error').length} rows written; 1 refused line skipped.`); App.rerender(); },
    ierr(el, ev, st) { dl('errors.csv', 'line,usn,problem\n' + st.run.lines.filter((l) => l.check === 'Error').map((l) => `${l.line},${l.usn},${l.what}`).join('\n')); toast('errors.csv requested — your browser is saving the file.'); },
    itpl(el, ev, st) { const m = st.ikind !== 'attendance'; dl(m ? 'marks.xlsx' : 'attendance.xlsx', m ? 'usn,subject_code,internal,external,subject_name,credits,sgpa,cgpa,live_backlogs\n' : 'usn,subject_code,sessions_held,sessions_attended\n'); toast(`${m ? 'marks' : 'attendance'}.xlsx requested — your browser is saving the file.`); },
    inew(el, ev, st) { ['ibatch', 'isem', 'ifile', 'run'].forEach((k) => { st[k] = null; }); App.rerender(); },
    csave(el, ev, st) {
      const v = formVals(document.querySelector('[data-form="crit"]')); const rung = st.icourse || '';
      const cur = CRIT.find((c) => c.live && c.rung === rung) || CRIT.find((c) => c.live && !c.rung);
      const num = (x, d) => (x === '' ? d : +x);
      if (CRIT.find((c) => c.live && c.rung === rung)) CRIT.find((c) => c.live && c.rung === rung).live = false;
      CRIT.unshift({ id: uid('cr'), rung, name: v.cname || `${rungName(rung)} criteria ${TODAY.slice(0, 4)}`, cgpa: num(v.ccgpa, cur.cgpa), back: num(v.cback, cur.back), att: num(v.catt, cur.att), cert: num(v.ccert, cur.cert), gap: num(v.cgap, cur.gap), eff: v.ceff || TODAY, written: TODAY, by: ME, live: true });
      audit('criteria.create', 'criteria', CRIT[0].id, CRIT[0].name); flash(st, 'A new set was written; the previous one is superseded.'); App.rerender();
    },
    chist() { Sheet.open({ title: 'Placement criteria · history', wide: true, body: `<div${I('D-176')}>${U.table([{ h: 'Written', k: 'w' }, { h: 'Rung / name', k: 'n' }, { h: 'State', k: 's' }, { h: 'Effective from', k: 'e' }, { h: 'Min CGPA', k: 'c', r: 1 }, { h: 'Max backlogs', k: 'b', r: 1 }, { h: 'Min attendance', k: 'a', r: 1 }, { h: 'Cert completion', k: 'ce', r: 1 }, { h: 'Max gap', k: 'g', r: 1 }, { h: 'By', k: 'by' }], CRIT.map((c) => ({ w: fmtDate(c.written), n: `${esc(rungName(c.rung))}<div class="xs muted">${esc(c.name)}</div>`, s: chip(c.live ? 'Live' : 'Superseded', c.live ? 'good' : 'neutral'), e: fmtDate(c.eff), c: c.cgpa, b: c.back, a: c.att + '%', ce: c.cert + '%', g: c.gap + ' mo', by: esc(c.by) })))}</div>`, foot: '<button class="btn" type="button" data-sheet-close>Close</button>' }); },
  }),
});

/* ================================================================ SWOC notes */
const QUADS = ['Strengths', 'Weaknesses', 'Opportunities', 'Challenges'];
const SRC = { PLACEMENT: 'Placement cell', MENTOR: 'Mentor', PM: 'Programme' };
const SWN = [
  { id: 'w1', sid: 's1', q: 'Strengths', text: 'Clear, structured written analysis in case submissions.', weight: 4, src: 'MENTOR', by: 'Dr. Meera Iyer', sem: 3, when: '2026-09-21', edited: null, ack: '2026-09-22' },
  { id: 'w2', sid: 's1', q: 'Weaknesses', text: 'Hesitant in group discussions; speaks late.', weight: 3, src: 'MENTOR', by: 'Dr. Meera Iyer', sem: 3, when: '2026-09-21', edited: '2026-10-05', ack: null },
  { id: 'w3', sid: 's1', q: 'Opportunities', text: 'Credit analyst roles at two visiting banks fit the profile.', weight: 5, src: 'PLACEMENT', by: ME, sem: 3, when: '2026-09-30', edited: null, ack: null },
  { id: 'w4', sid: 's2', q: 'Strengths', text: 'Leads the finance club; confident presenter.', weight: 5, src: 'PLACEMENT', by: null, sem: null, when: '2026-06-02', edited: null, ack: '2026-06-03' },
  { id: 'w5', sid: 's5', q: 'Challenges', text: 'Commutes three hours a day; misses early sessions.', weight: 2, src: 'MENTOR', by: 'Prof. Sameer Nadig', sem: 2, when: '2026-03-14', edited: null, ack: null },
  { id: 'w6', sid: 's10', q: 'Opportunities', text: 'Audit firms visiting in November want M.Com graduates.', weight: 4, src: 'PM', by: 'Ms. Nisha Pai', sem: 4, when: '2026-09-25', edited: null, ack: null },
];
const REVS = [{ nid: 'w2', by: 'Dr. Meera Iyer', when: '2026-10-05 11:20', ch: [['Text', 'Speaks late in GDs.', 'Hesitant in group discussions; speaks late.'], ['Weight', '2', '3']] }, { nid: 'w4', by: null, when: '2026-06-04 09:00', ch: [['Quadrant', 'Opportunities', 'Strengths']] }];
A.swocNotes ||= SWN;
function swocEditor(s, st) {
  const notes = SWN.filter((n) => n.sid === s.id && (!st.sem || String(n.sem) === st.sem));
  const all = SWN.filter((n) => n.sid === s.id);
  const hist = REVS.filter((r) => all.some((n) => n.id === r.nid));
  const bySem = {}; all.forEach((n) => { (bySem[n.sem || 'none'] ||= []).push(n); });
  const quad = (q) => { const l = notes.filter((n) => n.q === q).sort((a, b) => b.weight - a.weight);
    return `<div class="card flat"${I('D-187')}><div class="card-h"><h3>${q}</h3><button class="btn sm" type="button" data-act="swAdd" data-q="${q}">${ic('plus', 'sm')}Add</button></div>
      ${st.compose === q ? `<div class="stack" style="margin-bottom:10px"${I('D-193')}><label class="small" for="swnew"><b>New ${q.slice(0, -1).toLowerCase()} note</b></label><textarea class="input" id="swnew" maxlength="400" data-act-input="x" data-f="swnew" placeholder="One observation, in a sentence. Ctrl+Enter saves."></textarea><div class="spread"><span class="xs muted" data-slot="cnt">0/400</span><span class="hrow"><button class="btn sm" type="button" data-act="swCancel">Cancel</button><button class="btn sm primary" type="button" data-act="swSave" disabled>Save</button></span></div></div>` : ''}
      ${l.length ? l.map((n) => `<div class="note">
        <textarea class="input" rows="2" maxlength="400" aria-label="${q} note" data-act-change="note" data-f="swtext" data-id="${n.id}"${I('D-188')}>${esc(n.text)}</textarea>
        <div class="hrow" style="margin-top:6px"${I('D-189')}>${chip(SRC[n.src], 'info')}${n.ack ? chip(`Acknowledged ${fmtShort(n.ack)}`, 'good') : chip('Not acknowledged', 'neutral')}</div>
        <div class="spread" style="margin-top:4px"><span class="xs muted"${I('D-190')}>${n.by ? esc(n.by) : 'Author not recorded'} · ${n.sem ? `Semester ${n.sem}` : 'Semester not recorded'} · ${fmtShort(n.when)}${n.edited ? ` · edited ${fmtShort(n.edited)}` : ''}</span>
        <span class="hrow" style="flex-wrap:nowrap"><select class="input wsel" aria-label="Weight" data-act-change="note" data-f="swweight" data-id="${n.id}"${I('D-191')}>${[5, 4, 3, 2, 1].map((w) => opt(w, `Weight ${w}`, n.weight)).join('')}</select><button class="icon-btn" type="button" data-act="swDel" data-id="${n.id}" aria-label="Remove this entry"${I('D-192')}>${ic('trash')}</button></span></div></div>`).join('') : '<p class="small muted">Nothing yet</p>'}</div>`; };
  return `<div class="card"${I('D-184')}><div class="card-h"><span class="avatar">${initials(s.name)}</span><div class="grow"><h2>${esc(s.name)}</h2><p class="xs muted">${s.usn} · ${esc(blabel(bat(s.batch)))} · ${all.length ? `${all.length} notes · ${all.filter((n) => n.ack).length} read` : 'nothing written yet'}</p></div>${wide() ? `<a class="icon-btn" href="#/admin/swoc" aria-label="Close">${ic('x')}</a>` : ''}</div>
    <div class="hrow"><button class="btn sm" type="button" data-act="swHist" aria-pressed="${!!st.showHist}"${I('D-185')}>${ic('restore', 'sm')}Edit history</button><button class="btn sm" type="button" data-act="swSem" aria-pressed="${!!st.showSem}"${I('D-186')}>${ic('cal', 'sm')}By semester</button></div>
    ${st.showHist ? `<div class="card flat" style="margin-top:10px">${hist.length ? hist.map((r) => `<div style="margin-bottom:8px"><p class="small"><b>${esc((SWN.find((n) => n.id === r.nid) || {}).text || 'A removed line')}</b></p><p class="xs muted">${r.by ? esc(r.by) : 'Editor not recorded'} · ${esc(r.when)}</p><div class="hrow">${r.ch.map(([f, a, b]) => chip(`${f}: ${a} → ${b}`, 'neutral')).join('')}</div></div>`).join('') : '<p class="small muted">No edit recorded.</p>'}</div>` : ''}
    ${st.showSem ? `<div class="card flat" style="margin-top:10px">${Object.entries(bySem).map(([k, l]) => `<div class="spread" style="margin-bottom:6px"><span class="small"><b>${k === 'none' ? 'Semester not recorded' : `Semester ${k}`}</b> · ${l.length} notes</span>${k === 'none' ? '' : `<button class="btn sm" type="button" data-act="swOnly" data-sem="${k}">Show only this semester</button>`}</div>`).join('') || '<p class="small muted">No notes yet.</p>'}</div>` : ''}
    <div class="grid-2" style="margin-top:12px">${QUADS.map(quad).join('')}</div></div>`;
}
R.screen('admin/swoc', { title: 'SWOC notes', states: 'D-181',
  render({ id, st }) {
    const pick = id ? stu(id) : null;
    if (pick && !wide()) return U.page({ title: 'SWOC notes', back: true, body: `${flashBox(st, I('D-181'))}${swocEditor(pick, st)}` });
    const live = ROSTER.filter((s) => !s.removed && !s.alumni);
    const anySem = SWN.some((n) => n.sem);
    const q = (st.sq || '').toLowerCase();
    const rows = live.filter((s) => (!st.batch || s.batch === st.batch) && (!st.sem || SWN.some((n) => n.sid === s.id && String(n.sem) === st.sem)) && (!q || `${s.name} ${s.usn} ${blabel(bat(s.batch))}`.toLowerCase().includes(q)));
    const list = `<div class="card tight"${I('D-182')}><div class="card-h" style="padding:12px 12px 0"><h2>Students</h2>${chip(rows.length === live.length ? `${live.length}` : `${rows.length} of ${live.length}`, 'info')}</div><div style="padding:0 12px 10px">${U.search('sq', st.sq || '', 'Name, USN or batch')}</div>
      <div class="list" style="border:0;border-radius:0"${I('D-183')}>${rows.map((s) => { const n = SWN.filter((x) => x.sid === s.id); return `<a class="row${pick === s ? ' sel' : ''}" href="#/admin/swoc/${s.id}" aria-pressed="${pick === s}">${U.av(s.name)}<div class="body"><div class="ttl">${esc(s.name)}</div><div class="sub">${s.usn} · ${esc(s.batch ? bat(s.batch).year : 'No batch')}</div></div><div class="trail xs">${n.length ? `${n.length} notes · ${n.filter((x) => x.ack).length} read` : '—'}</div></a>`; }).join('') || `<div style="padding:16px" class="small muted">No student matches.</div>`}</div></div>`;
    return U.page({ title: 'SWOC notes', lede: `<span${I('D-177')}>${live.length} students · ${new Set(SWN.map((n) => n.sid)).size} with notes</span>`, acts: chip('Reach · every department', 'info', I('D-178')),
      body: `${flashBox(st, I('D-181'))}<div class="filters">${U.select('batch', [['', 'All batches'], ...BATCH.filter((b) => !b.ended).map((b) => [b.id, blabel(b)])], st.batch || '', I('D-179'), 'Batch')}${anySem ? U.select('sem', [['', 'All semesters'], ...[1, 2, 3, 4].map((x) => [String(x), `Semester ${x}`])], st.sem || '', I('D-180'), 'Semester') : ''}</div>
        <div class="split">${list}<div class="detail-pane">${pick ? swocEditor(pick, st) : `<div class="card">${U.empty('grid', 'No student picked.')}</div>`}</div></div>` });
  },
  mount(main, { st }) { const t = main.querySelector('#swnew'); if (t) { t.focus(); t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); main.querySelector('[data-act="swSave"]').click(); } }); } },
  acts: {
    swAdd(el, ev, st) { st.compose = el.dataset.q; App.rerender(); },
    swCancel(el, ev, st) { st.compose = null; App.rerender(); },
    'input:swnew'(el) { const m = document.getElementById('main'); m.querySelector('[data-slot="cnt"]').textContent = `${el.value.length}/400`; m.querySelector('[data-act="swSave"]').disabled = !el.value.trim(); },
    swSave(el, ev, st) { const t = document.getElementById('swnew').value.trim(); if (!t) return; const s = stu(App.cur.id); SWN.push({ id: uid('w'), sid: s.id, q: st.compose, text: t.slice(0, 400), weight: 3, src: 'PLACEMENT', by: ME, sem: s.sem, when: TODAY, edited: null, ack: null }); audit('swoc_entry.create', 'swoc_entry', s.id, `${st.compose} · ${s.name}`); st.compose = null; flash(st, 'Saved.'); App.rerender(); },
    'change:swtext'(el, ev, st) { const n = SWN.find((x) => x.id === el.dataset.id); const v = el.value.trim(); if (!v) { toast('A note cannot be blank — remove it instead.', 'risk'); return App.rerender(); } REVS.unshift({ nid: n.id, by: ME, when: stamp(), ch: [['Text', n.text, v]] }); n.text = v.slice(0, 400); n.edited = TODAY; audit('swoc_entry.update', 'swoc_entry', n.id, n.q); flash(st, 'Saved.'); App.rerender(); },
    'change:swweight'(el, ev, st) { const n = SWN.find((x) => x.id === el.dataset.id); REVS.unshift({ nid: n.id, by: ME, when: stamp(), ch: [['Weight', String(n.weight), el.value]] }); n.weight = +el.value; n.edited = TODAY; App.rerender(); },
    swDel(el, ev, st) { const i = SWN.findIndex((x) => x.id === el.dataset.id); if (i >= 0) { audit('swoc_entry.delete', 'swoc_entry', SWN[i].id, SWN[i].q, { text: SWN[i].text }, null); SWN.splice(i, 1); } flash(st, 'Removed.'); App.rerender(); },
    swHist(el, ev, st) { st.showHist = !st.showHist; App.rerender(); },
    swSem(el, ev, st) { st.showSem = !st.showSem; App.rerender(); },
    swOnly(el, ev, st) { st.sem = el.dataset.sem; App.rerender(); },
  },
});

/* ================================================================ Who can do what (+ Student feature switches) */
const CAPS = [
  ['admin.students', 'Students', 'Programme', true, true], ['admin.student_records', 'View student records', 'Programme', true, true], ['admin.mentors', 'Mentors & students', 'Programme', true, true],
  ['admin.registrations', 'Registrations', 'Programme', true, true], ['admin.imports', 'Data imports', 'Programme', true, true], ['admin.swoc', 'SWOC notes', 'Programme', true, true],
  ['admin.exports', 'Exports', 'Programme', true, true], ['admin.interviews', 'Interviews', 'Programme', true, true], ['admin.interview_audio', 'Interview audio', 'Programme', true, true],
  ['admin.interview_questions', 'Interview questions', 'Programme', false, true], ['admin.leave_approvals', 'Approve leave', 'Programme', true, true], ['admin.catalogue', 'Approved certifications', 'Programme', false, true],
  ['admin.analytics', 'Analytics', 'Programme', false, true], ['admin.governance', 'Governance', 'Programme', false, true],
  ['mentor.mentees', 'Mentee log', 'Scoped', true, true], ['mentor.notebook', 'Mentor notebook', 'Scoped', true, true], ['mentor.verifications', 'Verify skills & evidence', 'Scoped', true, true], ['mentor.upskilling', 'Own upskilling shelf', 'Scoped', false, true], ['mentor.agent', 'REEP Agent', 'Scoped', false, 'report'],
];
const cap = (k) => CAPS.find((c) => c[0] === k) || [k, k, 'Programme', false, true];
const capLabel = (k) => cap(k)[1];
const GRANTS = [
  { id: 'g1', subj: { kind: 'Faculty', id: 'f1', name: 'Dr. Meera Iyer' }, cap: 'admin.leave_approvals', scope: null, by: ME, expires: '2026-12-31', review: '2026-12-01', pending: false, reason: 'Covers leave approvals while the office is short-staffed this term.' },
  { id: 'g2', subj: { kind: 'Faculty', id: 'f2', name: 'Prof. Sameer Nadig' }, cap: 'admin.swoc', scope: ['Department', 'd1'], by: ME, expires: '2026-10-25', review: '2026-10-20', pending: false, reason: 'Writes the placement-cell SWOC lines for Management Studies.' },
  { id: 'g3', subj: { kind: 'Faculty', id: 'f3', name: 'Dr. Kavitha Rao' }, cap: 'admin.student_records', scope: ['Course', 'k1'], by: 'Prof. Sameer Nadig (deputy)', expires: '2027-03-31', review: '2027-01-15', pending: true, reason: 'Programme coordinator for the MBA needs the full record for audits.' },
  { id: 'g4', subj: { kind: 'Group', id: 'gr1', name: 'Placement cell' }, cap: 'admin.exports', scope: ['College', 'c1'], by: ME, expires: null, review: '2026-10-01', pending: false, reason: 'The placement cell sends weekly placement summaries to the director.' },
  { id: 'g5', subj: { kind: 'Faculty', id: 'f5', name: 'Ms. Nisha Pai' }, cap: 'admin.imports', scope: ['College', 'c2'], by: ME, expires: null, review: '2027-04-01', pending: false, reason: 'Uploads KIC marks and attendance each semester.' },
  { id: 'g6', subj: { kind: 'Main Admin', id: 'admin', name: ME }, cap: 'mentor.verifications', scope: ['Student', 's3'], by: ME, expires: '2026-11-30', review: '2026-11-15', pending: false, reason: "Rohan Gowda's evidence is stuck while his mentor is on leave." },
];
const GROUPS = [{ id: 'gr1', name: 'Placement cell', desc: 'Faculty who run drives with the office.', members: ['f2', 'f3'] }, { id: 'gr2', name: 'Exam coordinators', desc: '', members: ['f5'] }];
A.grants ||= GRANTS;
const daysTo = (d) => (d ? Math.round((new Date(d) - new Date(TODAY)) / 864e5) : Infinity);
const gStatus = (g) => (g.pending ? 'Awaiting approval — holds nothing' : daysTo(g.expires) <= 30 ? 'Expiring soon' : daysTo(g.review) <= 0 ? 'Due for review' : 'Live');
const gTone = (s) => (s === 'Live' ? 'good' : s === 'Due for review' ? 'info' : 'warn');
const LEVELS = ['College', 'Department', 'Course', 'Specialization', 'Batch', 'Student'];
const nodeLabel = (lvl, id) => (lvl === 'College' ? `${col(id).code} · ${col(id).name}` : lvl === 'Department' ? dep(id).name : lvl === 'Course' ? crs(id).name : lvl === 'Specialization' ? `${crs(spc(id).course).name} - ${spc(id).name}` : lvl === 'Batch' ? blabel(bat(id)) : (stu(id) || { name: 'A removed student' }).name);
const reachLabel = (g) => (g.scope ? `${g.scope[0]} · ${nodeLabel(...g.scope)}` : 'Programme-wide');
const reachChip = (g) => chip(reachLabel(g), !g.scope || g.scope[0] === 'College' ? 'risk' : 'neutral');
const reachCount = (lvl, id) => ROSTER.filter((s) => !s.removed && !s.alumni && (lvl === 'College' ? sCollege(s) === id : lvl === 'Department' ? s.dept === id : lvl === 'Course' ? s.batch && bat(s.batch).course === id : lvl === 'Specialization' ? s.batch && (bat(s.batch).spec === id || s.spec2 === id) : lvl === 'Batch' ? s.batch === id : s.id === id)).length;
const gCollege = (g) => { if (!g.scope) return null; const [l, id] = g.scope; return l === 'College' ? id : l === 'Department' ? dep(id).college : l === 'Course' ? dep(crs(id).dept).college : l === 'Specialization' ? dep(crs(spc(id).course).dept).college : l === 'Batch' ? bCollege(bat(id)) : sCollege(stu(id)); };
const reviewCount = () => GRANTS.filter((g) => gStatus(g) !== 'Live').length;
const G = () => App.s('admin/governance');
const scopeOpts = () => [['', 'Everything the function reaches'], ...COLL.filter((c) => !c.archived).map((c) => [`College:${c.id}`, `College · ${c.code}`]), ...DEPT.filter((d) => !d.archived).map((d) => [`Department:${d.id}`, `Department · ${d.name}`]), ...COURSE.map((c) => [`Course:${c.id}`, `Course · ${c.name}`]), ...SPEC.map((p) => [`Specialization:${p.id}`, `Specialization · ${nodeLabel('Specialization', p.id)}`]), ...BATCH.filter((b) => !b.ended).map((b) => [`Batch:${b.id}`, `Batch · ${blabel(b)}`])];

function openAction(kind, ids) {
  const gs = ids.map((i) => GRANTS.find((g) => g.id === i)).filter(Boolean); if (!gs.length) return;
  const verb = { approve: 'Approve', extend: 'Extend', revoke: 'Remove access' }[kind];
  const valid = (el) => { const r = words(el.querySelector('#areason').value).length >= 20; if (kind !== 'extend') return r; return r && (el.querySelector('#aexp').value || el.querySelector('#arev').value); };
  const foot = (ok) => `<span class="hrow"${I('D-201')}><button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn ${kind === 'revoke' ? 'danger solid' : 'primary'}" type="button" data-act="go"${ok ? '' : ' disabled title="A reason of at least 20 characters is needed."'}>${verb}</button></span>`;
  const sync = (a, ev, el) => { el.querySelector('[data-slot="cnt"]').textContent = `${words(el.querySelector('#areason').value).length}/20 minimum`; el.querySelector('.sh-f').innerHTML = foot(valid(el)); };
  Sheet.open({ title: `${verb} · ${gs.length} grant${gs.length > 1 ? 's' : ''}`,
    body: `<div class="stack"><div class="list"${I('D-198')}>${gs.map((g) => U.row({ title: `${esc(capLabel(g.cap))} ${kind === 'revoke' ? 'from' : 'for'} ${esc(g.subj.name)}`, sub: esc(reachLabel(g)), trail: chip(gStatus(g), gTone(gStatus(g))), chev: false })).join('')}</div>
      ${kind === 'extend' ? `<div class="form-grid"${I('D-199')}>${U.field({ id: 'aexp', label: 'New expiry', type: 'date', attrs: ' data-act-change="x" data-f="sync"' })}${U.field({ id: 'arev', label: 'New review date', type: 'date', attrs: ' data-act-change="x" data-f="sync"' })}</div>` : ''}
      ${U.field({ id: 'areason', label: 'Reason', type: 'textarea', req: true, inv: I('D-200'), attrs: ' maxlength="400" data-act-input="x" data-f="sync"' })}<span class="xs muted" data-slot="cnt">0/20 minimum</span></div>`,
    foot: foot(false),
    onAct: { 'input:sync': sync, 'change:sync': sync,
      go(a, ev, el) {
        if (!valid(el)) return; const why = words(el.querySelector('#areason').value);
        gs.forEach((g) => {
          if (kind === 'approve') { if (!g.pending) return; g.pending = false; audit('capability_grant.approve', 'capability_grant', g.id, `${capLabel(g.cap)} · ${g.subj.name}`, { pending: true }, { pending: false }, { reason: why }); }
          if (kind === 'extend') { const b = { expires: g.expires, review: g.review }; g.expires = el.querySelector('#aexp').value || g.expires; g.review = el.querySelector('#arev').value || g.review; audit('capability_grant.extend', 'capability_grant', g.id, `${capLabel(g.cap)} · ${g.subj.name}`, b, { expires: g.expires, review: g.review }, { reason: why }); }
          if (kind === 'revoke') { GRANTS.splice(GRANTS.indexOf(g), 1); audit('capability_grant.revoke', 'capability_grant', g.id, `${capLabel(g.cap)} · ${g.subj.name}`, { live: true }, null, { reason: why }); }
        });
        Sheet.close(); G().gsel = {}; flash(G(), `${verb}: ${gs.length} grant${gs.length > 1 ? 's' : ''}. Written on the audit trail.`); App.rerender();
      } } });
}
function openGrant() {
  const g = { mode: 'ind', people: [], groups: [], cap: '', scope: '', exp: '', reason: '' };
  const staff = FAC.filter((f) => !f.removed && !f.disabled);
  const body = () => { const c = g.cap ? cap(g.cap) : null; const lvl = g.scope ? g.scope.split(':') : null;
    return `<div class="stack">${U.seg('gmode', [['ind', 'Individuals'], ['grp', 'Access group']], g.mode, I('D-213'))}
    ${g.mode === 'ind' ? `<div${I('D-214')}><div class="field"><label for="gp">Person</label><div class="hrow" style="flex-wrap:nowrap">${sel('gp', [['', 'Choose a faculty member'], ...staff.filter((f) => !g.people.includes(f.id)).map((f) => [f.id, `${f.name} — ${f.email}`])], '')}<button class="btn" type="button" data-act="addP">Add</button></div><div class="err" role="alert" data-err="gp"></div></div><div class="hrow">${g.people.length ? g.people.map((id) => `<span class="chip info">${esc(fac(id).name)} <button class="x-btn" type="button" data-act="rmP" data-id="${id}" aria-label="Remove ${esc(fac(id).name)}">${ic('x', 'sm')}</button></span>`).join('') : '<span class="small muted">Nobody added yet.</span>'}</div></div>`
      : `<div${I('D-215')}><div class="field"><label for="gg">Access group</label><div class="hrow" style="flex-wrap:nowrap">${sel('gg', [['', 'Choose an access group'], ...GROUPS.filter((x) => !g.groups.includes(x.id)).map((x) => [x.id, `${x.name} (${x.members.length} faculty)`])], '')}<button class="btn" type="button" data-act="addG">Add</button></div><div class="err" role="alert" data-err="gp"></div></div><div class="hrow">${g.groups.length ? g.groups.map((id) => `<span class="chip info">${esc(GROUPS.find((x) => x.id === id).name)} <button class="x-btn" type="button" data-act="rmG" data-id="${id}" aria-label="Remove group">${ic('x', 'sm')}</button></span>`).join('') : '<span class="small muted">No group added yet.</span>'}</div></div>`}
    ${fld('gcap', 'Access', `<select class="input" id="gcap" name="gcap" data-act-change="x" data-f="gcap"><option value="">Choose the access</option><optgroup label="Scoped — narrowed to the holder's mentor group">${CAPS.filter((x) => x[2] === 'Scoped').map((x) => opt(x[0], x[1], g.cap)).join('')}</optgroup><optgroup label="Programme-wide — cannot be narrowed">${CAPS.filter((x) => x[2] === 'Programme').map((x) => opt(x[0], x[1], g.cap)).join('')}</optgroup></select>`, { req: true, inv: I('D-216'), hint: c ? `${c[2] === 'Scoped' ? 'Narrowed to their mentor group' : 'Programme-wide'} · ${c[3] ? "shows a student's own record" : 'no personal record'}` : '' })}
    ${fld('gscope', 'Scope target', sel('gscope', scopeOpts(), g.scope, ' data-act-change="x" data-f="gscope"'), { inv: I('D-217'), hint: !g.scope ? '<span style="color:var(--risk)">Reaches every student in the programme.</span>' : lvl[0] === 'College' ? `<span style="color:var(--risk)">Reaches the whole college · ${reachCount(...lvl)} students.</span>` : `Reaches ${reachCount(...lvl)} students.` })}
    ${U.field({ id: 'gexp', label: 'Expires', type: 'date', value: g.exp, inv: I('D-218'), hint: 'Leave empty to keep it until revoked; a review date is set for you.' })}
    ${U.field({ id: 'greason', label: 'Reason', type: 'textarea', req: true, value: g.reason, inv: I('D-219'), attrs: ' maxlength="400"', hint: 'At least 20 characters. Shown in the audit log.' })}
    ${c && c[3] ? `<div class="banner info" role="status"${I('D-220')}>${ic('shield', 'sm')}<div>${chip('Personal record', 'warn')} Live at once — you are the Main Admin. A deputy's grant of this waits for a second signature.</div></div>` : ''}</div>`; };
  const n = () => (g.mode === 'ind' ? g.people.length : g.groups.length);
  const foot = () => `<span class="hrow"${I('D-221')}><button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="go">${n() > 1 ? `Give access to ${n()}` : 'Give access'}</button></span>`;
  const sync = (el) => { g.cap = el.querySelector('#gcap').value; g.scope = el.querySelector('#gscope').value; g.exp = el.querySelector('#gexp').value; g.reason = el.querySelector('#greason').value; };
  const paint = (el) => { el.querySelector('.sh-b').innerHTML = body(); el.querySelector('.sh-f').innerHTML = foot(); };
  Sheet.open({ title: 'Grant a function', body: body(), foot: foot(),
    onAct: {
      'seg:gmode'(a) { const el = a.closest('.sheet'); sync(el); g.mode = a.dataset.v; paint(el); },
      addP(a, ev, el) { const v = el.querySelector('#gp').value; sync(el); if (!v) return errs(el, { gp: 'Choose a faculty member.' }); g.people.push(v); paint(el); },
      rmP(a, ev, el) { sync(el); g.people = g.people.filter((x) => x !== a.dataset.id); paint(el); },
      addG(a, ev, el) { const v = el.querySelector('#gg').value; sync(el); if (!v) return errs(el, { gp: 'Choose an access group.' }); g.groups.push(v); paint(el); },
      rmG(a, ev, el) { sync(el); g.groups = g.groups.filter((x) => x !== a.dataset.id); paint(el); },
      'change:gcap'(a, ev, el) { sync(el); paint(el); }, 'change:gscope'(a, ev, el) { sync(el); paint(el); },
      go(a, ev, el) {
        sync(el); const e = {};
        if (!n()) e.gp = g.mode === 'ind' ? 'Add at least one person.' : 'Add at least one access group.';
        if (!g.cap) e.gcap = 'Choose the access.';
        if (words(g.reason).length < 20) e.greason = `At least 20 characters (${words(g.reason).length} so far).`;
        if (!errs(el, e)) return;
        const scope = g.scope ? g.scope.split(':') : null; let made = 0;
        const subs = g.mode === 'ind' ? g.people.map((id) => ({ kind: 'Faculty', id, name: fac(id).name })) : g.groups.map((id) => ({ kind: 'Group', id, name: GROUPS.find((x) => x.id === id).name }));
        subs.forEach((sb) => {
          if (GRANTS.some((x) => x.subj.id === sb.id && x.cap === g.cap && String(x.scope) === String(scope))) return;
          const ng = { id: uid('g'), subj: sb, cap: g.cap, scope, by: ME, expires: g.exp || null, review: addDays(TODAY, 90), pending: false, reason: words(g.reason) };
          GRANTS.unshift(ng); made++; audit('capability_grant.create', 'capability_grant', ng.id, `${capLabel(ng.cap)} · ${sb.name}`, null, { capability: ng.cap, scope: reachLabel(ng) }, { reason: ng.reason });
        });
        if (!made) return toast('Already held at that reach — nothing to change.', 'risk');
        Sheet.close(); flash(G(), `Access given to ${made}. It is live now.`); App.rerender();
      },
    } });
}

/* ---------- feature switches */
const FEATS = [['student.agent', 'REEP Agent', true], ['student.assistant', 'Mock interviews', true], ['student.english', 'English baseline', false], ['student.jobs', 'Jobs', true], ['student.leaderboards', 'Leaderboards', true], ['student.mentor_log', 'Mentor & TPO log', false], ['student.resume', 'Resume builder', true], ['student.skilling', 'Skilling', true], ['student.time_log', 'Time log', true], ['student.uploads', 'Documents', true]];
const OVR = [
  { id: 'o1', feat: 'student.jobs', scope: 'Batch', target: 'b3', value: 'Off', until: null, set: '2026-10-02', reason: 'First-semester students see jobs after orientation week ends.', msg: 'Job postings open after orientation.' },
  { id: 'o2', feat: 'student.assistant', scope: 'College', target: 'c2', value: 'Off', until: '2026-09-30', set: '2026-08-01', reason: 'KIC mock interviews start after the internal assessment cycle.', msg: '' },
  { id: 'o3', feat: 'student.assistant', scope: 'Student', target: 's3', value: 'On', until: null, set: '2026-09-15', reason: 'Needs extra mock practice before the bank drive next month.', msg: '' },
];
const lapsed = (o) => o.until && o.until < TODAY;
const featValue = (k) => { const live = OVR.filter((o) => o.feat === k && !lapsed(o)); return live.length ? ['Varies by scope', 'warn'] : ['On', 'good']; };
function overridePanel(k) {
  const st = G(); const f = FEATS.find((x) => x[0] === k); const rules = OVR.filter((o) => o.feat === k); const of = (st.of ||= { scope: 'Batch' });
  if (!f) return `<div class="card">${U.empty('settings', 'Pick a feature.')}</div>`;
  const targets = of.scope === 'College' ? COLL.filter((c) => !c.archived) : of.scope === 'Department' ? DEPT.filter((d) => !d.archived) : of.scope === 'Course' ? COURSE : of.scope === 'Specialization' ? SPEC : of.scope === 'Batch' ? BATCH.filter((b) => !b.ended) : [];
  const dis = f[2] ? '' : ' disabled';
  const inp = (k2) => ` data-act-input="x" data-act-change="x" data-f="of" data-k="${k2}"${dis}`;
  return `<div class="card stack"><div class="card-h"><h2>Override · ${esc(f[1])}</h2>${wide() ? '' : ''}</div>
    <div class="banner ${f[2] ? 'good' : 'warn'}" role="status"${I('D-239')}>${ic(f[2] ? 'shield' : 'alert', 'sm')}<div>${f[2] ? 'The API checks this switch on every request.' : 'Not wired yet — nothing checks it, so it cannot be set. Existing rules can still be removed.'}</div></div>
    <h3>Rules in force</h3><div class="list"${I('D-240')}>${rules.length ? rules.map((o) => `<div class="row" style="align-items:flex-start"><div class="body"><div class="ttl">${o.scope} · ${esc(nodeLabel(o.scope, o.target))}</div><div class="sub" style="white-space:normal">${reachCount(o.scope, o.target)} students · ${o.until ? `until ${fmtDate(o.until)}` : 'until removed'} · set ${fmtDate(o.set)}</div><div class="xs muted" style="margin-top:4px">${esc(o.reason)}</div><div class="xs" style="margin-top:2px">${lapsed(o) ? 'Lapsed — decides nothing now.' : o.value === 'Off' ? (o.msg ? `Students are told: “${esc(o.msg)}”` : 'Students are told nothing — the feature is simply absent.') : 'Switches a broader “off” back on.'}</div>
      <div class="hrow" style="margin-top:6px"><button class="btn sm" type="button" data-act="oedit" data-id="${o.id}"${I('D-241')}${dis}>Edit</button><button class="btn sm danger" type="button" data-act="orm" data-id="${o.id}"${I('D-242')}>Remove override</button></div></div><div class="trail">${lapsed(o) ? chip('Lapsed', 'neutral') : chip(o.value, o.value === 'On' ? 'good' : 'neutral')}</div></div>`).join('') : `<div class="row"><div class="body"><div class="sub">No rule — on for every student.</div></div></div>`}</div>
    <h3>${of.editing ? 'Edit rule' : 'New rule'}</h3>
    <div class="form-grid" data-form="of">
      ${fld('o_scope', 'Scope', sel('o_scope', LEVELS.map((l) => [l, l]), of.scope, inp('scope')), { inv: I('D-243') })}
      ${of.scope === 'Student' ? `<div class="field"${I('D-244')}><label for="o_sq">Student</label><div class="hrow" style="flex-wrap:nowrap"><input class="input" id="o_sq" placeholder="Name, email or USN" value="${esc(of.sq || '')}"${inp('sq')}><button class="btn" type="button" data-act="ofind"${dis}>Find</button></div>${of.found ? `<div class="list" style="margin-top:6px">${of.found.length ? of.found.map((s) => U.row({ title: esc(s.name), sub: `${s.usn} · ${s.batch ? esc(blabel(bat(s.batch))) : 'No batch'}`, act: 'opickS', data: ` data-id="${s.id}"`, sel: of.target === s.id, chev: false })).join('') : '<div class="row"><div class="sub">Nobody found.</div></div>'}</div>` : ''}</div>`
        : fld('o_target', 'Applies to', sel('o_target', [['', targets.length ? 'Pick a scope target' : 'Nothing exists at that level yet.'], ...targets.map((t) => [t.id, `${nodeLabel(of.scope, t.id)} — ${reachCount(of.scope, t.id)} students`])], of.target || '', inp('target')), { inv: I('D-245'), hint: of.target ? `Reaches ${reachCount(of.scope, of.target)} students.` : 'Pick a scope target to see how many students this reaches.' })}
      ${fld('o_value', 'Value', sel('o_value', [['Off', 'Off'], ['On', 'On']], of.value || 'Off', inp('value')), { inv: I('D-246') })}
      ${fld('o_until', 'Until', `<input class="input" type="date" id="o_until" value="${esc(of.until || '')}"${inp('until')}>`, { inv: I('D-247'), hint: 'Blank: until it is removed.' })}</div>
    ${fld('o_reason', 'Reason', `<textarea class="input" id="o_reason" maxlength="400"${inp('reason')}>${esc(of.reason || '')}</textarea>`, { req: true, inv: I('D-248'), hint: 'At least 20 characters.' })}
    ${fld('o_msg', 'Student-facing message', `<textarea class="input" id="o_msg" maxlength="500" placeholder="e.g. Mock interviews open in November"${inp('msg')}>${esc(of.msg || '')}</textarea>`, { inv: I('D-249'), hint: 'Blank hides the feature silently. Never shown when the rule switches on.' })}
    <div class="hrow" style="justify-content:flex-end"${I('D-250')}>${of.editing ? '<button class="btn" type="button" data-act="ocancel">Cancel</button>' : ''}<button class="btn primary" type="button" data-act="osave">Save</button></div></div>`;
}
function featuresTab(st) {
  const rows = FEATS.filter((f) => (!st.fen || (st.fen === 'yes') === f[2]) && (!st.fapp || OVR.some((o) => o.feat === f[0] && o.scope === st.fapp)));
  const pi = paged(st, rows); const ruled = OVR.filter((o) => !lapsed(o)).length;
  const list = `<div class="list"${I('D-236')}>${pi.rows.map((f) => { const [v, t] = featValue(f[0]); const os = OVR.filter((o) => o.feat === f[0]); const last = os.map((o) => o.set).sort().pop();
    return `<button class="row${st.feat === f[0] ? ' sel' : ''}" type="button" data-act="fpick" data-k="${f[0]}"${I('D-237')}><div class="body"><div class="ttl">${esc(f[1])} <span class="xs muted">${f[0]}</span></div><div class="sub">Default On · ${os.length ? [...new Set(os.map((o) => o.scope))].join(', ') : 'Applies to everyone'}${last ? ` · changed ${fmtShort(last)}` : ''}</div></div><div class="trail">${chip(v, t)}${chip(f[2] ? 'Server-enforced' : 'Not wired yet', f[2] ? 'good' : 'warn')}</div></button>`; }).join('')}</div>`;
  return `<div class="spread" style="margin-bottom:10px"><h2${I('D-229')}>Student feature switches</h2><button class="btn" type="button" data-act="oadd"${I('D-230')}>${ic('plus', 'sm')}Add a rule</button></div>
    <div class="filters">${U.select('fapp', [['', 'Applies to: all'], ...LEVELS.map((l) => [l, l])], st.fapp || '', I('D-233'), 'Applies to')}${U.select('fen', [['', 'Enforcement: all'], ['yes', 'Server-enforced'], ['no', 'Not wired yet']], st.fen || '', I('D-234'), 'Enforcement')}</div>
    <div class="banner info" role="status" style="margin-bottom:12px"${I('D-235')}>${ic('shield', 'sm')}<div>${FEATS.filter((f) => f[2]).length} switches are server-enforced; ${FEATS.filter((f) => !f[2]).length} are not wired yet and cannot be set. Order: student → batch → specialization → course → department → college → on by default.</div></div>
    <div class="split"><div class="stack">${list}${pagerBar(st, rows.length, pi, `<span>Rows <b class="num">${rows.length}</b></span><span>Selected <b class="num">${st.feat ? 1 : 0}</b></span><span>Rules in force <b class="num">${ruled}</b></span>`, I('D-238'))}</div><div class="detail-pane">${st.feat ? overridePanel(st.feat) : `<div class="card">${U.empty('settings', 'Pick a feature.')}</div>`}</div></div>`;
}

function grantsTab(st) {
  st.gsel ||= {};
  const q = (st.gq || '').toLowerCase();
  const rows = GRANTS.filter((g) => (!st.gcol || !g.scope || gCollege(g) === st.gcol) && (!st.gdept || (g.scope && ((g.scope[0] === 'Department' && g.scope[1] === st.gdept) || (g.scope[0] === 'Course' && crs(g.scope[1]).dept === st.gdept)))) && (!st.gcap || g.cap === st.gcap)
    && (!st.gst || (st.gst === 'live' ? gStatus(g) === 'Live' : st.gst === 'review' ? /Expiring|Due/.test(gStatus(g)) : g.pending))
    && (!q || `${g.subj.name} ${capLabel(g.cap)} ${reachLabel(g)} ${g.reason}`.toLowerCase().includes(q)));
  const pi = paged(st, rows); const tick = Object.keys(st.gsel).filter((k) => st.gsel[k] && GRANTS.some((g) => g.id === k));
  const filters = `<div class="filters"${I('D-204')}>${U.select('gcol', [['', 'All colleges'], ...COLL.filter((c) => !c.archived).map((c) => [c.id, c.code])], st.gcol || '', '', 'College')}${U.select('gdept', [['', 'All departments'], ...DEPT.filter((d) => !d.archived).map((d) => [d.id, `${d.name} (${reachCount('Department', d.id)} students)`])], st.gdept || '', '', 'Department')}${U.select('gcap', [['', 'All functions'], ...CAPS.map((c) => [c[0], c[1]])], st.gcap || '', '', 'Access')}${U.select('gst', [['', 'All statuses'], ['live', 'Live'], ['review', 'Needs review'], ['pending', 'Awaiting approval']], st.gst || '', '', 'Status')}</div>`;
  const table = rows.length ? `<div class="card tight scroll-x"${I('D-208')}><table class="rtable${st.compact ? ' compact' : ''}"><thead><tr><th><input type="checkbox" class="tick" data-act="gall" aria-label="Select every grant on this page"${pi.rows.length && pi.rows.every((g) => st.gsel[g.id]) ? ' checked' : ''}></th><th>Person / group</th><th>Access</th><th>Reach</th><th>Granted by · expires</th><th>Status</th><th class="r"></th></tr></thead><tbody>
    ${pi.rows.map((g) => `<tr><td data-l="Select">${cbx('gtick', g.id, st.gsel[g.id], `Select ${g.subj.name}`)}</td><td class="lead-cell" data-l="Person / group"><b>${esc(g.subj.name)}</b><div class="xs muted">${g.subj.kind === 'Group' ? 'Access group' : g.subj.kind}</div></td><td data-l="Access">${esc(capLabel(g.cap))}<div class="xs muted">${cap(g.cap)[2] === 'Scoped' ? 'Scoped' : 'Programme-wide'}</div></td><td data-l="Reach">${reachChip(g)}</td><td data-l="Granted by · expires">${esc(g.by)}<div class="xs muted">${g.expires ? `Expires ${fmtDate(g.expires)}` : 'Until revoked'}</div></td><td data-l="Status">${chip(gStatus(g), gTone(gStatus(g)), I('D-209'))}</td>
      <td class="r" data-l="Actions"><span class="hrow" style="justify-content:flex-end;flex-direction:column;align-items:stretch;gap:4px"${I('D-210')}>${g.pending ? `<button class="btn sm" type="button" data-act="gact" data-k="approve" data-id="${g.id}">Approve</button>` : ''}<button class="btn sm" type="button" data-act="gact" data-k="extend" data-id="${g.id}">Extend</button><button class="btn sm danger" type="button" data-act="gact" data-k="revoke" data-id="${g.id}">Remove access</button></span></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="card"${I('D-211')}>${U.empty('key', GRANTS.length ? 'No grant matches these filters.' : 'No grants yet — every role holds its baseline.')}</div>`;
  return `${filters}<div class="hrow" style="margin-bottom:10px">${U.search('gq', st.gq || '', 'Quick filter: person, group, function, reach, reason', I('D-205'))}</div>
    <div class="hrow" style="margin-bottom:10px"><span class="hrow"${I('D-206')}><button class="btn sm danger" type="button" data-act="gbulk" data-k="revoke"${tick.length ? '' : ' disabled'}>Remove access</button><button class="btn sm" type="button" data-act="gbulk" data-k="extend"${tick.length ? '' : ' disabled'}>Extend</button></span><span class="grow"></span><button class="btn sm" type="button" data-act="compact" aria-pressed="${!!st.compact}"${I('D-207')}>${ic('list', 'sm')}Compact</button></div>
    ${table}${pagerBar(st, rows.length, pi, `<span>Rows <b class="num">${rows.length}</b></span><span>Selected <b class="num">${tick.length}</b></span><span>Awaiting approval <b class="num">${GRANTS.filter((g) => g.pending).length}</b></span><span>Expiring soon <b class="num">${GRANTS.filter((g) => gStatus(g) === 'Expiring soon').length}</b></span>`, I('D-212'))}
    <div class="card" style="margin-top:16px"${I('D-222')}><div class="card-h"><h2>Student feature switches</h2><button class="btn sm" type="button" data-act="seg" data-seg="gtab" data-v="features">Open student feature switches</button></div><p class="small">Functions are denied until granted; features are on until switched off. ${OVR.filter((o) => !lapsed(o)).length} rules in force across ${new Set(OVR.map((o) => o.feat)).size} features.</p></div>`;
}
function reviewTab() {
  const pend = GRANTS.filter((g) => g.pending); const soon = GRANTS.filter((g) => !g.pending && (daysTo(g.expires) <= 30 || daysTo(g.review) <= 30));
  const btns = (g, a) => `<span class="hrow">${a.map(([k, t]) => `<button class="btn sm${k === 'revoke' ? ' danger' : ''}" type="button" data-act="gact" data-k="${k}" data-id="${g.id}">${t}</button>`).join('')}</span>`;
  return `<div${I('D-223')}>${U.section('Awaiting approval', pend.length ? U.table([{ h: 'Person / group', k: 'p' }, { h: 'Access', k: 'a' }, { h: 'Reach', k: 'r' }, { h: 'Granted by', k: 'b' }, { h: 'Reason', k: 'w' }, { h: '', k: 'x', r: 1 }], pend.map((g) => ({ p: `<b>${esc(g.subj.name)}</b>`, a: `${esc(capLabel(g.cap))} ${cap(g.cap)[3] ? chip('Personal record', 'warn') : ''}`, r: reachChip(g), b: esc(g.by), w: `<span class="small">${esc(g.reason)}</span>`, x: btns(g, [['approve', 'Approve'], ['revoke', 'Remove access']]) }))) : '<div class="card"><p class="small muted">Nothing is waiting for approval.</p></div>')}</div>
    <div${I('D-224')}>${U.section('Running out within 30 days', soon.length ? U.table([{ h: 'Person / group', k: 'p' }, { h: 'Access', k: 'a' }, { h: 'Reach', k: 'r' }, { h: 'Expires', k: 'e' }, { h: 'Review', k: 'v' }, { h: 'Status', k: 's' }, { h: '', k: 'x', r: 1 }], soon.map((g) => ({ p: `<b>${esc(g.subj.name)}</b>`, a: esc(capLabel(g.cap)), r: reachChip(g), e: g.expires ? fmtDate(g.expires) : 'Until revoked', v: fmtDate(g.review), s: chip(gStatus(g), gTone(gStatus(g))), x: btns(g, [['extend', 'Extend'], ['revoke', 'Remove access']]) }))) : '<div class="card"><p class="small muted">Nothing is running out in the next 30 days.</p></div>')}</div>`;
}
function typesTab() {
  return `<div${I('D-225')}>${U.table([{ h: 'Access', k: 'a' }, { h: 'Key', k: 'k' }, { h: 'Scope', k: 's' }, { h: 'Personal data', k: 'p' }, { h: 'Server-enforced', k: 'e' }, { h: 'Live grants', k: 'n', r: 1 }], CAPS.map((c) => ({ a: `<b>${esc(c[1])}</b>`, k: `<code class="xs">${c[0]}</code>`, s: c[2] === 'Scoped' ? 'Scoped' : 'Programme-wide', p: c[3] ? chip('Personal record', 'warn') : '—', e: c[4] === 'report' ? chip('Not reported here', 'neutral') : c[4] ? chip('Checked on every request', 'good') : chip('Not wired yet', 'warn'), n: GRANTS.filter((g) => g.cap === c[0] && !g.pending).length })))}<p class="xs muted" style="margin-top:8px">The catalogue is code; a new kind of access arrives with a release.</p></div>`;
}
function groupsTab() {
  const gGrants = (id) => GRANTS.filter((g) => g.subj.id === id);
  return `<div class="grid-2"${I('D-226')}>${GROUPS.map((gr) => `<div class="card"><div class="card-h"><h2>${esc(gr.name)}</h2>${chip(`${gr.members.length} faculty`, 'info')}</div>${gr.desc ? `<p class="small muted">${esc(gr.desc)}</p>` : ''}
      <p class="xs muted" style="margin-top:8px">Functions it carries</p><div class="hrow">${gGrants(gr.id).map((g) => chip(capLabel(g.cap), 'info')).join('') || '<span class="small muted">None yet</span>'}</div>
      <div class="list" style="margin-top:10px">${gr.members.map((m) => U.row({ title: esc(facName(m)), trail: `<button class="icon-btn" type="button" data-act="grm" data-g="${gr.id}" data-m="${m}" aria-label="Remove ${esc(facName(m))} from ${esc(gr.name)}">${ic('x')}</button>`, chev: false })).join('') || U.row({ title: 'Nobody yet', chev: false })}</div></div>`).join('')}</div>
    <div class="grid-2" style="margin-top:16px"><div class="card" data-form="ng"${I('D-227')}><div class="card-h"><h2>New access group</h2></div>${U.field({ id: 'ng_name', label: 'Name', ph: 'Placement cell' })}<div class="hrow" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" type="button" data-act="gnew">Create group</button></div></div>
    <div class="card" data-form="am"${I('D-228')}><div class="card-h"><h2>Add someone to a group</h2></div><div class="stack">${fld('am_g', 'Group', sel('am_g', [['', 'Choose an access group'], ...GROUPS.map((g) => [g.id, g.name])], ''))}${fld('am_p', 'Person', sel('am_p', [['', 'Choose a faculty member'], ...FAC.filter((f) => !f.removed && !f.disabled).map((f) => [f.id, f.name])], ''))}${U.field({ id: 'am_why', label: 'Reason', type: 'textarea', hint: 'At least 20 characters.' })}</div><div class="hrow" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" type="button" data-act="gadd">Add to group</button></div></div></div>
    <p class="xs muted" style="margin-top:8px">A group issues the same functions to everyone in it.</p>`;
}
function governancePage(st, query) {
  if (query.tab && st._q !== query.tab) { st._q = query.tab; st.gtab = query.tab === 'review' ? 'review' : query.tab; }
  const tab = st.gtab || 'grants';
  const tabs = `<div class="spread" style="flex-wrap:wrap">${U.tabs('gtab', [['grants', `Grants · ${GRANTS.length}`], ['review', `Review · ${reviewCount()}`], ['types', `Access types · ${CAPS.length}`], ['groups', `Groups · ${GROUPS.length}`], ['features', 'Student feature switches']], tab, I('D-202', 'D-203', 'D-232'))}<a class="small" href="#/admin/audit"${I('D-203', 'D-232')}>${ic('restore', 'sm')} What changed</a></div>`;
  const pane = tab === 'review' ? reviewTab() : tab === 'types' ? typesTab() : tab === 'groups' ? groupsTab() : tab === 'features' ? featuresTab(st) : grantsTab(st);
  return U.page({ title: 'Who can do what', lede: `<span${I('D-194')}>Who may open which screen, and until when.</span>`,
    acts: `<button class="btn" type="button" data-act="seg" data-seg="gtab" data-v="review"${I('D-195')}>${ic('clock', 'sm')}Review queue · ${reviewCount()}</button><button class="btn primary" type="button" data-act="ggive"${I('D-196')}>${ic('key', 'sm')}Give access</button>`,
    body: `${flashBox(st, I('D-197', 'D-231'))}${tabs}${pane}` });
}
const govActs = withCommon({
  gtick(el) { const s = G(); s.gsel[el.dataset.id] = !s.gsel[el.dataset.id]; App.rerender(); },
  gall() { const s = G(); const ids = [...document.querySelectorAll('[data-act="gtick"]')].map((x) => x.dataset.id); const all = ids.every((i) => s.gsel[i]); ids.forEach((i) => { s.gsel[i] = !all; }); App.rerender(); },
  gact(el) { openAction(el.dataset.k, [el.dataset.id]); },
  gbulk(el) { const s = G(); openAction(el.dataset.k, Object.keys(s.gsel).filter((k) => s.gsel[k])); },
  ggive() { openGrant(); },
  grm(el) { const gr = GROUPS.find((g) => g.id === el.dataset.g); gr.members = gr.members.filter((m) => m !== el.dataset.m); audit('access_group.member_remove', 'access_group', gr.id, gr.name); flash(G(), `Removed ${facName(el.dataset.m)} from “${gr.name}”.`); App.rerender(); },
  gnew() { const box = document.querySelector('[data-form="ng"]'); const v = formVals(box); if (words(v.ng_name).length < 2) return errs(box, { ng_name: 'A name of at least 2 characters.' }); if (GROUPS.some((g) => g.name.toLowerCase() === v.ng_name.toLowerCase())) return errs(box, { ng_name: 'A group with this name exists.' }); GROUPS.push({ id: uid('gr'), name: words(v.ng_name), desc: '', members: [] }); audit('access_group.create', 'access_group', GROUPS.at(-1).id, v.ng_name); flash(G(), `Group “${v.ng_name}” created.`); App.rerender(); },
  gadd() { const box = document.querySelector('[data-form="am"]'); const v = formVals(box); const e = {}; if (!v.am_g) e.am_g = 'Choose an access group.'; if (!v.am_p) e.am_p = 'Choose a faculty member.'; if (words(v.am_why).length < 20) e.am_why = 'At least 20 characters.'; if (!errs(box, e)) return; const gr = GROUPS.find((g) => g.id === v.am_g); if (gr.members.includes(v.am_p)) return toast(`${facName(v.am_p)} is already in ${gr.name}.`, 'risk'); gr.members.push(v.am_p); audit('access_group.member_add', 'access_group', gr.id, gr.name, null, null, { reason: v.am_why }); flash(G(), `${facName(v.am_p)} added to “${gr.name}”.`); App.rerender(); },
  // feature switches
  fpick(el) { const s = G(); s.feat = el.dataset.k; s.of = { scope: 'Batch' }; if (wide()) App.rerender(); else R.go(`#/admin/governance-features/${el.dataset.k}`); },
  oadd() { const s = G(); s.feat ||= FEATS.find((f) => f[2])[0]; s.of = { scope: 'Batch' }; if (wide()) { App.rerender(); setTimeout(() => { const x = document.getElementById('o_scope'); if (x) x.focus(); }, 30); } else R.go(`#/admin/governance-features/${s.feat}`); },
  'input:of'(el) { const of = (G().of ||= {}); of[el.dataset.k] = el.value; },
  'change:of'(el) { const of = (G().of ||= {}); of[el.dataset.k] = el.value; if (el.dataset.k === 'scope') { of.target = ''; of.found = null; App.rerender(); } else if (el.dataset.k === 'target') App.rerender(); },
  ofind() { const of = G().of; const q = (of.sq || '').toLowerCase(); of.found = q ? ROSTER.filter((s) => !s.removed && !s.alumni && `${s.name} ${s.email} ${s.usn}`.toLowerCase().includes(q)).slice(0, 6) : []; App.rerender(); },
  opickS(el) { G().of.target = el.dataset.id; App.rerender(); },
  oedit(el) { const o = OVR.find((x) => x.id === el.dataset.id); G().of = { scope: o.scope, target: o.target, value: o.value, until: o.until || '', reason: o.reason, msg: o.msg, editing: o.id, sq: o.scope === 'Student' ? stu(o.target).name : '' }; App.rerender(); },
  ocancel() { G().of = { scope: 'Batch' }; App.rerender(); },
  orm(el) { const o = OVR.find((x) => x.id === el.dataset.id); Sheet.open({ title: 'Remove override', center: true, body: `<p>${o.scope} · ${esc(nodeLabel(o.scope, o.target))}: the next rung up decides again for ${reachCount(o.scope, o.target)} students.</p>`, foot: `<button class="btn" type="button" data-sheet-close>Keep it</button><button class="btn danger solid" type="button" data-act="ok">Remove override</button>`, onAct: { ok() { OVR.splice(OVR.indexOf(o), 1); audit('feature_override.remove', 'feature_override', o.id, `${o.feat} · ${nodeLabel(o.scope, o.target)}`, { value: o.value }, null); Sheet.close(); flash(G(), 'Override removed. Written on the audit trail.'); App.rerender(); } } }); },
  osave() {
    const s = G(); const of = s.of || {}; const f = FEATS.find((x) => x[0] === s.feat);
    if (!f) return toast('Pick a feature.', 'risk');
    if (!f[2]) return toast('This switch is not wired yet — it cannot be set.', 'risk');
    const box = document.querySelector('[data-form="of"]').parentElement; const e = {};
    if (!of.target) e[of.scope === 'Student' ? 'o_sq' : 'o_target'] = 'Pick who it applies to.';
    if (words(of.reason).length < 20) e.o_reason = `At least 20 characters (${words(of.reason).length} so far).`;
    if (!errs(box, e)) return;
    const rule = { feat: f[0], scope: of.scope, target: of.target, value: of.value || 'Off', until: of.until || null, set: TODAY, reason: words(of.reason), msg: (of.value || 'Off') === 'Off' ? words(of.msg) : '' };
    if (of.editing) Object.assign(OVR.find((o) => o.id === of.editing), rule); else OVR.push({ id: uid('o'), ...rule });
    audit('feature_override.set', 'feature_override', of.editing || OVR.at(-1).id, `${f[1]} · ${nodeLabel(rule.scope, rule.target)}`, null, { value: rule.value }, { students_affected: reachCount(rule.scope, rule.target) });
    s.of = { scope: 'Batch' }; flash(s, `Saved · reaches ${reachCount(rule.scope, rule.target)} students.`); App.rerender();
  },
});
App.st['admin/governance-features'] = G(); // one view state for the merged screen
R.screen('admin/governance', { title: 'Who can do what', states: 'D-197 D-231', render({ st, query }) { st._enter = 'g'; return governancePage(st, query); }, acts: govActs });
R.screen('admin/governance-features', { title: 'Student feature switches', states: 'D-231',
  render({ id }) {
    const s = G(); if (s._enter !== 'f') { s._enter = 'f'; s.gtab = 'features'; }
    if (!id) return governancePage(s, {});
    s.feat = id; const f = FEATS.find((x) => x[0] === id);
    return U.page({ title: f ? f[1] : 'Feature', back: true, lede: `<span class="crumbs"><a href="#/admin/governance">Who can do what</a> / <a href="#/admin/governance-features">Student feature switches</a></span>`, body: `${flashBox(s)}${overridePanel(id)}` });
  }, acts: govActs });

/* ================================================================ What changed */
COLSETS.audit = [['when', 'When', true], ['actor', 'Actor'], ['action', 'Action'], ['target', 'Target'], ['route', 'Route']];
const SCREEN_OF = { capability_grant: ['Who can do what', () => '#/admin/governance'], access_group: ['Who can do what', () => '#/admin/governance?tab=groups'], feature_override: ['Student feature switches', () => '#/admin/governance-features'], student: ['Student 360', (id) => `#/admin/students/${id}`], user: ['the account', (id) => (stu(id) ? `#/admin/students/${id}` : `#/admin/faculty/${id}`)], faculty: ['Faculty', (id) => `#/admin/faculty/${id}`], roster: ['Students & batches', () => '#/admin/students'], cohort: ['Students & batches', () => '#/admin/students'], swoc_entry: ['SWOC notes', () => '#/admin/swoc'], export: ['Download reports', () => '#/admin/exports'], audit_export: ['Download reports', () => '#/admin/exports'], registration: ['New applications', () => '#/admin/registrations'], interview_question: ['Interview questions', () => '#/admin/interview-questions'] };
const ageDays = (at) => Math.round((new Date(TODAY) - new Date(at.slice(0, 10))) / 864e5);
function auditRows(st) {
  const q = (st.q || '').toLowerCase(); const rng = st.range || '30';
  return AUD.filter((e) => (!st.who || e.actor === st.who) && (!st.what || e.action === st.what) && (!st.on || e.type === st.on) && (rng === 'all' || ageDays(e.at) < +rng));
}
const json = (o) => (o == null ? '<span class="muted">null</span>' : `<pre class="json">${esc(JSON.stringify(o, null, 2))}</pre>`);
function eventPanel(e) {
  if (!e) return `<div class="card">${U.empty('restore', 'Choose a row in the trail to read the event.')}</div>`;
  const scr = SCREEN_OF[e.type];
  return `<div class="card stack"><div class="card-h"><h2>${esc(e.action)}</h2>${wide() ? `<a class="icon-btn" href="#/admin/audit" aria-label="Close">${ic('x')}</a>` : ''}</div>
    ${kv([['Who', esc(e.actor)], ['Occurred', esc(e.at)], ['Via', `<span class="xs">${esc(e.route || 'Console')}</span>`], ['What', esc(e.action)], ['On what', `${esc(e.type)} · ${esc(e.tid)} — ${esc(e.tl)}`]], I('D-262'))}
    <div${I('D-263')}><h3 style="margin-bottom:6px">Change</h3><div class="grid-2"><div><p class="xs muted">Before${e.before == null ? ' — nothing existed' : ''}</p>${json(e.before)}</div><div><p class="xs muted">After${e.after == null ? ' — nothing remains' : ''}</p>${json(e.after)}</div></div></div>
    <div${I('D-264')}><h3 style="margin-bottom:6px">Metadata</h3>${Object.keys(e.meta || {}).length ? json(e.meta) : '<p class="small muted">Nothing recorded</p>'}${kv([['Event', e.id], ['Request', `req_${e.id}7f2c`], ['Correlation', `cor_${e.id}19ab`]])}</div>
    <div class="hrow"><button class="btn" type="button" data-act="ecopy" data-id="${e.id}"${I('D-265')}>${ic('copy', 'sm')}Copy event JSON</button>${scr ? `<a class="btn" href="${scr[1](e.tid)}"${I('D-266')}>Open ${esc(scr[0])}</a>` : `<button class="btn" type="button" disabled${I('D-266')}>No screen administers this</button>`}</div></div>`;
}
R.screen('admin/audit', { title: 'What changed', states: 'D-261',
  render({ id, st, query }) {
    if (query.q && st._q !== query.q) { st._q = query.q; st.q = query.q; st.range = 'all'; }
    const e = id ? AUD.find((x) => x.id === id) : null;
    if (id && !wide()) return U.page({ title: 'Event', back: true, body: eventPanel(e) });
    st.hide ||= {};
    const H = st.hide; const all = auditRows(st); const q = (st.q || '').toLowerCase();
    const rows = all.filter((x) => !q || `${x.actor} ${x.action} ${x.tl} ${x.type} ${x.route}`.toLowerCase().includes(q)); const pi = paged(st, rows);
    const filtered = st.who || st.what || st.on || (st.range && st.range !== '30') || st.q;
    const uniq = (k) => [...new Set(AUD.map((x) => x[k]))].sort();
    const th = (k, t) => (H[k] ? '' : `<th>${t}</th>`); const td = (k, l, v) => (H[k] ? '' : `<td data-l="${l}">${v}</td>`);
    const grid = rows.length ? `<div class="card tight scroll-x"${I('D-260')}><table class="rtable${st.compact ? ' compact' : ''}"><thead><tr><th>When</th>${th('actor', 'Actor')}${th('action', 'Action')}${th('target', 'Target')}${th('route', 'Route')}</tr></thead><tbody>${pi.rows.map((x) => `<tr class="click${e === x ? ' sel' : ''}" data-act="eopen" data-id="${x.id}"><td class="lead-cell" data-l="When"><a href="#/admin/audit/${x.id}">${esc(x.at)}</a></td>${td('actor', 'Actor', x.actor === 'Account deleted' ? '<span class="muted">Account deleted</span>' : esc(x.actor))}${td('action', 'Action', `<code class="xs">${esc(x.action)}</code>`)}${td('target', 'Target', `${esc(x.tl)}<div class="xs muted">${esc(x.type)}</div>`)}${td('route', 'Route', `<span class="xs">${esc(x.route || '—')}</span>`)}</tr>`).join('')}</tbody></table></div>`
      : `<div class="card" ${I('D-260')}>${U.empty('restore', 'No events', 'Nothing matches this range and these filters.')}</div>`;
    const rangeName = { 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', all: 'All time' }[st.range || '30'];
    return U.page({ title: 'What changed', lede: `<span${I('D-251')}>Every change made in this console, newest first.</span>`,
      acts: `<button class="btn" type="button" data-act="aexport"${I('D-252')}${all.length ? '' : ' disabled title="There are no events in this range to export."'}>${ic('download', 'sm')}Export range</button>`,
      body: `<div class="filters">${U.select('who', [['', 'Who: anyone'], ...uniq('actor').map((a) => [a, a])], st.who || '', I('D-253'), 'Who')}${U.select('what', [['', 'All actions'], ...uniq('action').map((a) => [a, a])], st.what || '', I('D-254'), 'What')}${U.select('on', [['', 'All types'], ...uniq('type').map((a) => [a, a])], st.on || '', I('D-255'), 'On what')}${U.select('range', [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']], st.range || '30', I('D-256'), 'When')}</div>
        ${filtered ? `<div class="hrow" style="margin-bottom:10px"${I('D-257')}><button class="btn sm" type="button" data-act="aclear">${ic('x', 'sm')}Clear filters</button><span class="xs muted">Reads are never recorded; not every write is.</span></div>` : ''}
        <div class="split"><div class="stack"><div class="hrow">${U.search('q', st.q || '', 'Filter the events on this page…', I('D-258'))}</div><div class="hrow"><span class="grow"></span>${toolBtns(st, 'audit', I('D-259'))}</div>${grid}${pagerBar(st, rows.length, pi, `<span>${rangeName}</span>`, I('D-261'))}</div><div class="detail-pane">${eventPanel(e)}</div></div>` });
  },
  acts: withCommon({
    eopen(el) { R.go(`#/admin/audit/${el.dataset.id}`); },
    aclear(el, ev, st) { ['who', 'what', 'on', 'q'].forEach((k) => { st[k] = ''; }); st.range = '30'; App.rerender(); },
    aexport(el, ev, st) { const rows = auditRows(st); dl('audit-log.csv', 'when,actor,action,type,target,route\n' + rows.map((x) => [x.at, x.actor, x.action, x.type, x.tl, x.route].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')); audit('audit.export', 'audit_export', 'audit-log.csv', `audit-log.csv · ${rows.length} events`, null, null, { rows: rows.length }); toast('audit-log.csv requested — the download itself is now on the trail.'); App.rerender(); },
    ecopy(el) { copy(JSON.stringify(AUD.find((x) => x.id === el.dataset.id), null, 2), 'Event JSON copied'); },
  }),
});

/* ================================================================ Email delivery */
const MAIL = [
  { at: '2026-10-07 09:02', kind: 'onboarding-code', to: '1nh26mba003@nhsm.edu.in', status: 'SENT', detail: 'Accepted by the provider' },
  { at: '2026-10-07 08:41', kind: 'onboarding-code', to: '1nh25mba033@nhsm.edu.in', status: 'SUPPRESSED', detail: 'On the suppression list since 12 Aug 2026 (BOUNCE)' },
  { at: '2026-10-06 18:12', kind: 'badge-decision', to: '1nh25mba014@nhsm.edu.in', status: 'SENT', detail: 'Accepted by the provider' },
  { at: '2026-10-06 07:00', kind: 'leave-today', to: 'sameer.nadig@nhsm.edu.in', status: 'SENT', detail: 'Accepted by the provider' },
  { at: '2026-10-05 15:30', kind: 'badge-claim', to: 'meera.iyer@nhsm.edu.in', status: 'SENT', detail: 'Accepted by the provider' },
  { at: '2026-10-04 11:15', kind: 'password-reset', to: 'nisha.pai@kic.edu.in', status: 'FAILED', detail: 'Throttling: maximum sending rate exceeded' },
  { at: '2026-10-02 10:03', kind: 'registration-approved', to: '1nh26mba020@nhsm.edu.in', status: 'SENT', detail: 'Accepted by the provider' },
];
const SUPP = { '1nh25mba033@nhsm.edu.in': { since: '2026-08-12', reason: 'BOUNCE' } };
const mTone = { SENT: ['Accepted', 'good'], FAILED: ['Failed', 'risk'], SUPPRESSED: ['Not sent', 'neutral'] };
function probe(addr) { const a = addr.trim().toLowerCase(); if (a.endsWith('@kic.edu.in')) return { checked: false }; return { checked: true, supp: SUPP[a] || null }; }
R.screen('admin/mail', { title: 'Email delivery', states: '',
  render({ st }) {
    const p = st.probe; const f = st.mf || {};
    const rows = MAIL.filter((m) => (!f.to || m.to.startsWith(f.to.toLowerCase())) && (!f.kind || m.kind.includes(f.kind)) && (!f.failed || m.status !== 'SENT'));
    const res = !p ? '' : !p.r.checked ? `<div class="banner warn" role="status"${I('D-269')}>${ic('alert', 'sm')}<div>${chip('Not checked', 'warn')} Could not ask the provider about ${esc(p.addr)}. That is not the same as fine.</div></div>`
      : p.r.supp ? `<div class="banner risk" role="status"${I('D-269')}>${ic('alert', 'sm')}<div>${chip(`Suppressed since ${fmtDate(p.r.supp.since)} (${p.r.supp.reason})`, 'risk')} The provider accepts mail for ${esc(p.addr)} and delivers none of it.<div style="margin-top:8px"><button class="btn sm danger solid" type="button" data-act="lift"${I('D-270')}>Remove from the suppression list</button></div></div></div>`
      : `<div class="banner good" role="status"${I('D-269')}>${ic('check', 'sm')}<div>${chip('Deliverable', 'good')} ${esc(p.addr)} is not on the suppression list.</div></div>`;
    return U.page({ title: 'Email delivery', lede: `<span${I('D-267')}>Sent means the provider accepted a message — not that it arrived.</span>`,
      body: `${flashBox(st)}<div class="adm2-cols"><div class="stack">
        <div class="card" data-form="mf"${I('D-271')}><div class="card-h"><h2>Recent messages</h2>${chip(`${rows.length} shown, ${rows.filter((m) => m.status === 'FAILED').length} failed`, 'info')}</div><div class="form-grid">${U.field({ id: 'mf_to', label: 'Recipient starts with…', value: f.to || '' })}${U.field({ id: 'mf_kind', label: 'Kind, e.g. onboarding-code', value: f.kind || '' })}</div><div class="spread" style="margin-top:6px"><label class="check"><input type="checkbox" name="mf_failed"${f.failed ? ' checked' : ''}><span>Failed only</span></label><button class="btn" type="button" data-act="mshow">Show</button></div></div>
        <div${I('D-272')}>${rows.length ? U.table([{ h: 'When', k: 'w' }, { h: 'Kind', k: 'k' }, { h: 'To', k: 't' }, { h: 'Status', k: 's' }, { h: 'Detail', k: 'd' }, { h: '', k: 'c', r: 1 }], rows.map((m) => ({ w: esc(m.at), k: `<code class="xs">${esc(m.kind)}</code>`, t: esc(m.to), s: chip(...mTone[m.status]), d: `<span class="small">${esc(m.detail)}</span>`, c: `<button class="btn sm" type="button" data-act="mcheck" data-a="${esc(m.to)}"${I('D-273')}>Check</button>` }))) : `<div class="card">${U.empty('mail', f.to || f.kind || f.failed ? 'No message matches' : 'REEP has sent nothing yet')}</div>`}</div></div>
        <div class="stack"><div class="card" data-form="probe"${I('D-268')}><div class="card-h"><h2>Can this address receive mail?</h2></div>${U.field({ id: 'paddr', label: 'Email address', type: 'email', value: p ? p.addr : D.me.admin.email })}<div class="hrow" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" type="button" data-act="mprobe">Check</button></div><div style="margin-top:12px">${res}</div></div></div></div>` });
  },
  acts: {
    mshow(el, ev, st) { const v = formVals(document.querySelector('[data-form="mf"]')); st.mf = { to: v.mf_to, kind: v.mf_kind, failed: v.mf_failed }; App.rerender(); },
    mprobe(el, ev, st) { const box = document.querySelector('[data-form="probe"]'); const a = formVals(box).paddr; if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return errs(box, { paddr: 'Type a full email address.' }); st.probe = { addr: a.toLowerCase(), r: probe(a) }; App.rerender(); },
    mcheck(el, ev, st) { st.probe = { addr: el.dataset.a, r: probe(el.dataset.a) }; App.rerender(); },
    lift(el, ev, st) { const a = st.probe.addr; Sheet.confirm({ title: 'Remove from the suppression list?', text: `Mail to ${esc(a)} will be attempted again. If the mailbox is dead, the provider may suppress it again.`, ok: 'Remove from the list', onOk() { delete SUPP[a]; audit('mail.suppression_lift', 'user', a, a); st.probe = { addr: a, r: probe(a) }; flash(st, `${a} is off the suppression list. Written on the audit trail.`); App.rerender(); } }); },
  },
});

/* ================================================================ Catalogue */
const SUBJ = [
  { code: 'RB102', name: 'Business Communication', model: 'Workshop', weeks: 6, dim: 'Communication', stage: 'Reboot', sem: 1, hrs: 24, enrolled: 48, certs: 1, course: null },
  { code: 'RB110', name: 'Professional Etiquette', model: 'Workshop', weeks: 4, dim: 'Behavioural', stage: 'Reboot', sem: 1, hrs: 12, enrolled: 48, certs: 0, course: null },
  { code: 'RX110', name: 'Excel for Analysts', model: 'Blended', weeks: 8, dim: 'Platform', stage: 'Excel', sem: 2, hrs: 32, enrolled: 41, certs: 2, course: null },
  { code: 'RF201', name: 'Financial Modelling', model: 'Lab', weeks: 10, dim: 'Sectoral · Finance', stage: 'Excel', sem: 3, hrs: 40, enrolled: 22, certs: 1, course: 'k1' },
  { code: 'RM205', name: 'Digital Marketing Lab', model: 'Lab', weeks: 10, dim: 'Sectoral · Marketing', stage: 'Excel', sem: 3, hrs: 40, enrolled: 18, certs: 0, course: 'k1' },
  { code: 'RA301', name: 'Power BI Dashboards', model: 'Blended', weeks: 6, dim: 'Platform', stage: 'Excel-Adv', sem: 3, hrs: 24, enrolled: 30, certs: 1, course: null },
  { code: 'RE401', name: 'Interview Readiness Sprint', model: 'Bootcamp', weeks: 3, dim: 'Readiness', stage: 'Elevate', sem: 4, hrs: 18, enrolled: 12, certs: 0, course: null },
  { code: 'RC220', name: 'GST & Tax Practice', model: 'Lab', weeks: 8, dim: 'Sectoral · Commerce', stage: 'Excel', sem: 3, hrs: 32, enrolled: 14, certs: 1, course: 'k2' },
];
const BADGE_CAT = [
  ['NEG', 'Negotiation', 'Managerial', 'Excel', 20], ['PRES', 'Presentation', 'Managerial', 'Reboot', 15], ['LEAD', 'Team Leadership', 'Managerial', 'Excel', 20],
  ['FMOD', 'Financial Modelling', 'Sectoral', 'Excel', 30], ['NISM', 'NISM Series VIII', 'Sectoral', 'Excel-Adv', 30], ['SEO', 'SEO Foundations', 'Sectoral', 'Excel', 25],
  ['XL', 'Advanced Excel', 'Platform', 'Reboot', 15], ['PBI', 'Power BI', 'Platform', 'Excel', 20], ['SQL', 'SQL Basics', 'Platform', 'Excel', 20],
  ['CRIT', 'Critical Thinking', 'Thinking', 'Reboot', 15], ['DESN', 'Design Thinking', 'Thinking', 'Excel', 15], ['READY', 'Interview Ready', 'Readiness', 'Elevate', 40],
];
const CERTS = [
  { id: 'ce1', name: 'Microsoft PL-300', provider: 'Microsoft', badge: 'PBI', course: null, link: 'https://learn.microsoft.com/credentials', claims: 6, active: true },
  { id: 'ce2', name: 'NISM Series VIII — Equity Derivatives', provider: 'NISM', badge: 'NISM', course: 'k1', link: 'https://www.nism.ac.in', claims: 3, active: true },
  { id: 'ce3', name: 'Excel Associate (MO-200)', provider: 'Microsoft', badge: 'XL', course: null, link: '', claims: 9, active: true },
  { id: 'ce4', name: 'Google Digital Garage', provider: 'Google', badge: 'SEO', course: null, link: 'https://learndigital.withgoogle.com', claims: 1, active: false },
  { id: 'ce5', name: 'CFI Financial Modelling', provider: 'CFI', badge: 'FMOD', course: 'k1', link: '', claims: 2, active: true },
];
const STAGE_RULES = [{ course: 'k1', sem: 1, stage: 'Reboot' }, { course: 'k1', sem: 2, stage: 'Excel' }, { course: 'k1', sem: 3, stage: 'Excel' }, { course: 'k1', sem: 4, stage: 'Elevate' }, { course: 'k2', sem: 4, stage: 'Excel-Adv' }];
function stageAt(courseId, sem) { const r = STAGE_RULES.find((x) => x.course === courseId && x.sem === sem); return r ? r.stage : null; }
const TRACKS = [['Human Resources', 'hr', 4, 24, 9], ['Digital Marketing', 'dm', 4, 21, 6], ['Business Analytics', 'ba', 4, 26, 4], ['Financial Analytics', 'fa', 4, 28, 11], ['General interview', 'general', 3, 12, 2]];
const certsFor = (code) => CERTS.filter((c) => c.badge === code);
function openBadge(code, st) {
  const b = BADGE_CAT.find((x) => x[0] === code); const cs = certsFor(code);
  Sheet.open({ title: `Badge · ${b[1]}`, body: `<div class="stack">${kv([['Code', b[0]], ['Skill area', b[2]], ['Stage', b[3]], ['Points', b[4]]], I('D-296'))}
    <div${I('D-297')}><h3 style="margin-bottom:6px">Accepted certifications</h3>${b[2] === 'Readiness' ? '<p class="small muted">Staff award · no evidence accepted.</p>' : cs.length ? `<div class="list">${cs.map((c) => U.row({ title: `${c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}`, sub: `${esc(c.provider)} · ${c.claims} claims`, trail: `${chip(c.course ? crs(c.course).name : 'Programme-wide', 'neutral')}${c.active ? '' : chip('Removed', 'risk')}<button class="btn sm" type="button" data-act="ctog" data-id="${c.id}">${c.active ? 'Remove' : 'Restore'}</button>`, chev: false })).join('')}</div>` : '<p class="small muted">None — no student can claim it with a certificate.</p>'}</div>
    <div class="card flat"${I('D-298')}>${kv([['Evidence rule', b[2] === 'Readiness' ? 'Staff award · no evidence accepted' : 'A certificate from the list, verified by the mentor'], ['Scope', 'Programme-wide']])}<div class="hrow" style="margin-top:10px">${b[2] === 'Readiness' ? '' : `<button class="btn sm" type="button" data-act="addFor">${ic('plus', 'sm')}Add certification</button>`}<button class="btn sm" type="button" data-act="toRules">Stage rules</button></div></div></div>`,
    onAct: {
      ctog(a) { const c = CERTS.find((x) => x.id === a.dataset.id); c.active = !c.active; audit(c.active ? 'certification.restore' : 'certification.remove', 'certification', c.id, c.name); Sheet.close(); setTimeout(() => openBadge(code, st), 330); App.rerender(); },
      addFor() { st.addc = true; st.cbadge = code; st.ctab = 'badges'; Sheet.close(); App.rerender(); },
      toRules() { st.ctab = 'rules'; Sheet.close(); App.rerender(); },
    } });
}
R.screen('admin/catalogue', { title: 'Catalogue', states: 'D-277',
  render({ st }) {
    const tab = st.ctab || 'subjects';
    const inScope = (c) => !c || !st.ccourse || c === st.ccourse;
    let pane = '';
    if (tab === 'subjects') {
      const q = (st.sq || '').toLowerCase(); const rows = SUBJ.filter((s) => inScope(s.course) && (!st.ccol || !s.course || dep(crs(s.course).dept).college === st.ccol) && (!q || `${s.code} ${s.name} ${s.dim}`.toLowerCase().includes(q)));
      pane = `<div class="hrow" style="margin-bottom:10px">${U.search('sq', st.sq || '', 'Search subjects…', I('D-284'))}</div>
        ${rows.length ? U.table([{ h: 'Subject', k: 's' }, { h: 'Dimension', k: 'd' }, { h: 'Stage', k: 'st' }, { h: 'Semester', k: 'se', r: 1 }, { h: 'Hours', k: 'h', r: 1 }, { h: 'Enrolled', k: 'e', r: 1 }, { h: 'Evidence path', k: 'ev' }], rows.map((s) => ({ s: `<b>${s.code} · ${esc(s.name)}</b><div class="xs muted">${s.model} · ${s.weeks} weeks${s.course ? ` · ${esc(crs(s.course).name)}` : ''}</div>`, d: esc(s.dim), st: chip(s.stage, 'info'), se: s.sem, h: s.hrs, e: s.enrolled, ev: s.certs ? chip(`${s.certs} certification${s.certs > 1 ? 's' : ''}`, 'good') : chip('None mapped', 'warn') })), I('D-285')) : `<div class="card"${I('D-285')}>${U.empty('book', 'No subject matches')}</div>`}
        <p class="xs muted" style="margin-top:8px"${I('D-286')}>Subjects: ${rows.length} · Of ${SUBJ.length} in the programme · edited only through the CSV import</p>`;
    } else if (tab === 'badges') {
      const q = (st.bq || '').toLowerCase();
      const rows = BADGE_CAT.filter((b) => (!st.barea || b[2] === st.barea) && (!st.bmap || (st.bmap === 'mapped') === certsFor(b[0]).some((c) => c.active && inScope(c.course))) && (!q || `${b[0]} ${b[1]}`.toLowerCase().includes(q)));
      const copyPanel = st.copy ? `<div class="card stack" data-form="cp"${I('D-291')}><div class="card-h"><h2>Copy a catalogue between programmes</h2></div><div class="form-grid">${fld('cp_from', 'Copy from', sel('cp_from', [['', 'Choose a programme'], ...COURSE.map((c) => [c.id, c.name])], st.cpFrom || ''))}${fld('cp_to', 'Copy into', sel('cp_to', [['', 'Choose a programme'], ...COURSE.map((c) => [c.id, c.name])], st.cpTo || ''))}</div>
          <div class="hrow"${I('D-292')}>${[['certifications', 'Approved certifications'], ['badges', 'Badge map'], ['stage_rules', 'Stage rules']].map(([k, t]) => `<label class="check"><input type="checkbox" name="cp_${k}"${(st.cpParts || ['certifications', 'badges', 'stage_rules']).includes(k) ? ' checked' : ''}><span>${t}</span></label>`).join('')}</div>
          ${st.cpRes ? `<div class="banner ${st.cpRes.dry ? 'info' : 'good'}" role="status">${ic('check', 'sm')}<div><b>${st.cpRes.dry ? 'Dry run' : 'Copied'}</b> · ${st.cpRes.lines.join(' · ')}</div></div>` : ''}
          <div class="hrow" style="justify-content:flex-end"${I('D-293')}><button class="btn" type="button" data-act="cpCancel">Cancel</button><button class="btn" type="button" data-act="cpRun" data-dry="1">Check first</button><button class="btn primary" type="button" data-act="cpRun" data-dry="0"${st.cpRes && st.cpRes.dry ? '' : ' disabled'}>Copy</button></div></div>` : '';
      pane = `<div class="banner info" role="status" style="margin-bottom:12px"${I('D-287')}>${ic('lock', 'sm')}<div>Badges cannot be added or edited here. Map approved certifications to them.</div></div>
        <div class="filters"${I('D-280')}>${U.select('barea', [['', 'All skill areas'], ...['Managerial', 'Sectoral', 'Platform', 'Thinking', 'Readiness'].map((a) => [a, a])], st.barea || '', '', 'Skill area')}${U.select('bmap', [['', 'Certifications: all'], ['mapped', 'Mapped'], ['none', 'None mapped']], st.bmap || '', '', 'Certifications')}</div>
        <div class="hrow" style="margin-bottom:10px"${I('D-290')}>${U.search('bq', st.bq || '', 'Search badges…')}<button class="btn sm" type="button" data-act="cpToggle">${st.copy ? 'Close copy' : 'Copy to course…'}</button></div>${copyPanel}
        <div class="card tight scroll-x"${I('D-294')}><table class="rtable"><thead><tr><th>Badge</th><th>Skill area</th><th>Certifications</th><th>Verifier</th><th class="r">Claims</th><th>Status</th></tr></thead><tbody>${rows.map((b) => { const cs = certsFor(b[0]).filter((c) => c.active && inScope(c.course)); return `<tr class="click" data-act="bopen" data-code="${b[0]}"><td class="lead-cell" data-l="Badge"><b>${esc(b[1])}</b><div class="xs muted">${b[0]}</div></td><td data-l="Skill area">${b[2]}</td><td data-l="Certifications">${cs.length ? `${chip(cs[0].name, 'info')}${cs.length > 1 ? ` <span class="xs">+${cs.length - 1}</span>` : ''}` : b[2] === 'Readiness' ? '—' : chip('None mapped', 'warn')}</td><td data-l="Verifier">${b[2] === 'Readiness' ? 'Award' : 'Mentor'}</td><td class="r" data-l="Claims">${certsFor(b[0]).reduce((a, c) => a + c.claims, 0)}</td><td data-l="Status">${chip('Active', 'good')}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="xs muted" style="margin-top:8px"${I('D-295')}>Badges ${rows.length} of 48 · Certifications mapped ${CERTS.filter((c) => c.active).length} · Removed ${CERTS.filter((c) => !c.active).length} · Selected 0</p>`;
    } else if (tab === 'rules') {
      const rows = STAGE_RULES.filter((r) => inScope(r.course));
      pane = `<div class="card" data-form="sr"${I('D-299')}><div class="card-h"><h2>Set a stage rule</h2></div><div class="form-grid">${fld('sr_c', 'Programme', sel('sr_c', [['', 'Choose a programme'], ...COURSE.map((c) => [c.id, c.name])], st.ccourse || ''))}${U.field({ id: 'sr_s', label: 'Semester', type: 'number', attrs: ' min="1" max="20"' })}${fld('sr_t', 'Stage', sel('sr_t', STAGES.map((x) => [x, x]), 'Excel'))}</div><div class="hrow" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" type="button" data-act="srSet">Set rule</button></div></div>
        <div style="margin-top:12px"${I('D-300')}>${rows.length ? U.table([{ h: 'Programme', k: 'p' }, { h: 'Semester', k: 's', r: 1 }, { h: 'Stage', k: 't' }, { h: '', k: 'x', r: 1 }], rows.sort((a, b) => a.course.localeCompare(b.course) || a.sem - b.sem).map((r) => ({ p: esc(crs(r.course).name), s: r.sem, t: chip(r.stage, 'info'), x: `<button class="btn sm danger" type="button" data-act="srDel" data-c="${r.course}" data-s="${r.sem}">Remove</button>` }))) : '<div class="card"><p class="small muted">No stage rules: promotion leaves every student\'s stage alone.</p></div>'}</div>`;
    } else {
      pane = `<div${I('D-301')}>${U.table([{ h: 'Track', k: 't' }, { h: 'Key', k: 'k' }, { h: 'Phases', k: 'p', r: 1 }, { h: 'Questions', k: 'q', r: 1 }, { h: 'In use', k: 'u', r: 1 }], TRACKS.map(([t, k, p, q, u]) => ({ t: `<b>${t}</b>`, k: `<code>${k}</code>`, p, q, u })))}<p class="small" style="margin-top:8px"><a href="#/admin/interview-questions">Edit tracks on Interview questions</a></p></div>`;
    }
    const imp = st.imp ? `<div class="card stack" style="margin-bottom:12px"><div class="card-h"><h2>Import subjects</h2></div><div${I('D-281')}>${U.drop('subcsv', 'Choose a CSV', 'Columns: code, name, stage, dimension, semester, model_type')}</div>
      ${st.impRes ? `<div${I('D-283')}><p class="small"><b>${st.impRes.dry ? 'Dry run' : 'Imported'}</b> · 2 to add, 1 to update, 1 in error</p>${U.table([{ h: 'Line', k: 'l', r: 1 }, { h: 'Code', k: 'c' }, { h: 'Outcome', k: 'o' }, { h: 'Detail', k: 'd' }], [[2, 'RB115', 'create', 'New subject'], [3, 'RA305', 'create', 'New subject'], [4, 'RX110', 'update', 'Hours 32 → 36'], [5, 'RZ999', 'error', 'Stage "Expert" is not one of Reboot, Excel, Excel-Adv, Elevate']].map(([l, c, o, d]) => ({ l, c, o: chip(o, o === 'create' ? 'good' : o === 'update' ? 'warn' : 'risk'), d: esc(d) })))}</div>` : ''}
      <div class="hrow" style="justify-content:flex-end"${I('D-282')}><button class="btn" type="button" data-act="impToggle">Cancel</button><button class="btn" type="button" data-act="impRun" data-dry="1"${st.subcsv ? '' : ' disabled'}>Check first</button><button class="btn primary" type="button" data-act="impRun" data-dry="0"${st.impRes && st.impRes.dry ? '' : ' disabled'}>Import</button></div></div>` : '';
    const addc = st.addc ? `<div class="card stack" data-form="nc" style="margin-bottom:12px"${I('D-288')}><div class="card-h"><h2>New certification</h2></div><div class="form-grid">${U.field({ id: 'nc_name', label: 'Certification', req: true, ph: 'e.g. Microsoft PL-300' })}${U.field({ id: 'nc_prov', label: 'Provider' })}${fld('nc_badge', 'Badge it counts towards', sel('nc_badge', [['', 'Choose a badge'], ...BADGE_CAT.filter((b) => b[2] !== 'Readiness').map((b) => [b[0], `${b[1]} · ${b[4]} pts`])], st.cbadge || ''), { req: true })}${fld('nc_scope', 'Applies to', sel('nc_scope', [['', 'Every college and course'], ...COURSE.map((c) => [c.id, c.name])], ''))}${U.field({ id: 'nc_link', label: 'Link (optional)', type: 'url', ph: 'https://' })}</div><div class="hrow" style="justify-content:flex-end"><button class="btn primary" type="button" data-act="ncAdd"${I('D-289')}>Add to catalogue</button></div></div>` : '';
    return U.page({ title: 'Catalogue', lede: `<span${I('D-274')}>Subjects, certificates, badges and stage rules.</span>`,
      acts: `<button class="btn" type="button" data-act="impToggle"${I('D-275')}>${ic('upload', 'sm')}${st.imp ? 'Close import' : 'Import subjects'}</button><button class="btn primary" type="button" data-act="ncToggle"${I('D-276')}>${st.addc ? 'Cancel' : `${ic('plus', 'sm')}Add certification`}</button>`,
      body: `${flashBox(st, I('D-277'))}${imp}${addc}${U.tabs('ctab', [['subjects', `Subjects · ${SUBJ.length}`], ['badges', `Certifications ↔ badges · ${CERTS.length}`], ['rules', 'Stage rules'], ['tracks', `Interview tracks · ${TRACKS.length}`]], tab, I('D-278'))}
        <div class="filters"${I('D-279')}>${U.select('ccol', [['', 'All colleges'], ...COLL.filter((c) => !c.archived).map((c) => [c.id, c.code])], st.ccol || '', '', 'College')}${U.select('ccourse', [['', 'All courses'], ...COURSE.filter((c) => !st.ccol || dep(c.dept).college === st.ccol).map((c) => [c.id, c.name])], st.ccourse || '', '', 'Course')}</div>${pane}` });
  },
  acts: {
    impToggle(el, ev, st) { st.imp = !st.imp; st.impRes = null; st.subcsv = null; App.rerender(); },
    'change:subcsv'(el, ev, st) { const f = el.files[0]; if (!f) return; if (!/\.csv$/i.test(f.name)) { st.subcsv = null; return toast('Only a .csv file is read here.', 'risk'); } st.subcsv = f.name; st.impRes = null; App.rerender(); },
    impRun(el, ev, st) { const dry = el.dataset.dry === '1'; st.impRes = { dry }; if (!dry) { SUBJ.push({ code: 'RB115', name: 'Email Writing', model: 'Workshop', weeks: 2, dim: 'Communication', stage: 'Reboot', sem: 1, hrs: 6, enrolled: 0, certs: 0, course: null }, { code: 'RA305', name: 'SQL for Managers', model: 'Lab', weeks: 6, dim: 'Platform', stage: 'Excel', sem: 3, hrs: 24, enrolled: 0, certs: 0, course: null }); audit('catalogue.subjects_import', 'catalogue', 'subjects', '3 subjects'); flash(st, '2 subjects added, 1 updated; 1 line in error was skipped.'); } App.rerender(); },
    ncToggle(el, ev, st) { st.addc = !st.addc; st.cbadge = ''; App.rerender(); },
    ncAdd(el, ev, st) { const box = document.querySelector('[data-form="nc"]'); const v = formVals(box); const e = {}; if (!v.nc_name) e.nc_name = 'Name the certification.'; if (!v.nc_badge) e.nc_badge = 'Choose the badge it counts towards.'; if (v.nc_link && !/^https?:\/\//.test(v.nc_link)) e.nc_link = 'A link must start with http:// or https://.'; if (!errs(box, e)) return; CERTS.push({ id: uid('ce'), name: v.nc_name, provider: v.nc_prov || '—', badge: v.nc_badge, course: v.nc_scope || null, link: v.nc_link, claims: 0, active: true }); audit('certification.create', 'certification', CERTS.at(-1).id, v.nc_name); st.addc = false; flash(st, `${v.nc_name} now counts towards ${BADGE_CAT.find((b) => b[0] === v.nc_badge)[1]}.`); App.rerender(); },
    cpToggle(el, ev, st) { st.copy = !st.copy; st.cpRes = null; App.rerender(); },
    cpCancel(el, ev, st) { st.copy = false; st.cpRes = null; App.rerender(); },
    cpRun(el, ev, st) {
      const box = document.querySelector('[data-form="cp"]'); const v = formVals(box); const parts = ['certifications', 'badges', 'stage_rules'].filter((k) => v['cp_' + k]); const e = {};
      if (!v.cp_from) e.cp_from = 'Choose where to copy from.'; if (!v.cp_to) e.cp_to = 'Choose where to copy into.'; else if (v.cp_from === v.cp_to) e.cp_to = 'Copy into a different programme.';
      st.cpFrom = v.cp_from; st.cpTo = v.cp_to; st.cpParts = parts;
      if (!errs(box, e)) return; if (!parts.length) return toast('Tick at least one part to copy.', 'risk');
      const dry = el.dataset.dry === '1'; const from = v.cp_from; const to = v.cp_to;
      const lines = parts.map((p) => { if (p === 'stage_rules') { const src = STAGE_RULES.filter((r) => r.course === from); const n = src.filter((r) => !STAGE_RULES.some((x) => x.course === to && x.sem === r.sem)); if (!dry) n.forEach((r) => STAGE_RULES.push({ ...r, course: to })); return `Stage rules: ${n.length} copied, ${src.length - n.length} already there`; } const src = CERTS.filter((c) => c.course === from); const n = src.filter((c) => !CERTS.some((x) => x.course === to && x.name === c.name)); if (!dry && p === 'certifications') n.forEach((c) => CERTS.push({ ...c, id: uid('ce'), course: to, claims: 0 })); return `${p === 'badges' ? 'Badge map' : 'Approved certifications'}: ${n.length} copied, ${src.length - n.length} already there`; });
      st.cpRes = { dry, lines }; if (!dry) { audit('catalogue.copy', 'catalogue', to, `${crs(from).name} → ${crs(to).name}`); } App.rerender();
    },
    bopen(el, ev, st) { openBadge(el.dataset.code, st); },
    srSet(el, ev, st) { const box = document.querySelector('[data-form="sr"]'); const v = formVals(box); const e = {}; if (!v.sr_c) e.sr_c = 'Choose a programme.'; if (!(+v.sr_s >= 1 && +v.sr_s <= 20)) e.sr_s = 'A semester from 1 to 20.'; if (!errs(box, e)) return; const ex = STAGE_RULES.find((r) => r.course === v.sr_c && r.sem === +v.sr_s); if (ex) ex.stage = v.sr_t; else STAGE_RULES.push({ course: v.sr_c, sem: +v.sr_s, stage: v.sr_t }); audit('stage_rule.set', 'stage_rule', v.sr_c, `${crs(v.sr_c).name} · semester ${v.sr_s}`); flash(st, `Promotion into semester ${v.sr_s} of ${crs(v.sr_c).name} now sets ${v.sr_t}.`); App.rerender(); },
    srDel(el, ev, st) { const i = STAGE_RULES.findIndex((r) => r.course === el.dataset.c && r.sem === +el.dataset.s); if (i >= 0) STAGE_RULES.splice(i, 1); flash(st, 'Rule removed. Promotion into that semester leaves the stage alone.'); App.rerender(); },
  },
});

/* ================================================================ Download reports */
const EXH = [
  { file: 'reep-students-mentor-map.csv', scope: 'Whole programme', rows: 14, by: ME, when: '2026-10-01 10:20' },
  { file: 'reep-placement-summary.csv', scope: 'Narrowed to your grant', rows: 9, by: 'Prof. Sameer Nadig', when: '2026-09-26 16:45' },
];
const EXPORTS = [
  ['students', 'Students', 'reep-students-mentor-map.csv', 'usn, name, email, batch, faculty, stage, semester', I('D-304')],
  ['placement', 'Placement', 'reep-placement-summary.csv', 'usn, batch, offers, best_ctc, status', I('D-305')],
  ['ledger', 'Ledger', 'reep-ledger-compliance.csv', 'usn, days_submitted, days_started, mean_hours', I('D-306')],
  ['interviews', 'Interviews', 'reep-interview-scores.csv', 'usn, interviews, best_score, last_track', I('D-307')],
  ['skills', 'Skills & badges', 'reep-cohort-skill-report.csv', 'usn, badges_earned, points, verified_skills', I('D-308')],
];
R.screen('admin/exports', { title: 'Download reports', states: '',
  render({ st }) {
    const pii = st.pii !== false; const last = (st.last ||= {});
    const card = ([k, t, file, cols, inv]) => `<div class="card stack"${inv}><div class="card-h"><h2>${t}</h2>${k === 'students' ? chip(pii ? 'Carries name & USN' : 'Name & USN omitted', pii ? 'risk' : 'neutral') : k === 'interviews' ? chip('Score summaries only', 'info') : k === 'skills' ? chip('Main Admin only', 'info') : chip('Narrowed to your reach', 'neutral')}</div>
      <p class="xs muted"><code>${file}</code></p><p class="small">Header row: <span class="muted">${esc(k === 'students' && !pii ? cols.replace('usn, name, ', '') : cols)}</span></p>
      ${k === 'students' ? `<label class="check"><input type="checkbox" data-act-change="x" data-f="pii"${pii ? ' checked' : ''}><span>Include name and USN</span></label>` : ''}
      <div class="spread" style="margin-top:auto"><span class="xs muted"${I('D-309')}>${last[file] ? `Last downloaded ${esc(last[file])}` : 'Not downloaded in this session'}</span><button class="btn primary" type="button" data-act="xdl" data-k="${k}">${ic('download', 'sm')}Download CSV</button></div></div>`;
    return U.page({ title: 'Download reports', lede: `<span${I('D-302')}>CSV files, each covering only the students you can see.</span>`,
      body: `<div class="banner warn" role="status" style="margin-bottom:12px"${I('D-303')}>${ic('alert', 'sm')}<div><b>These files carry student data.</b> A downloaded file cannot be recalled.</div></div>
        ${st.req ? `<div class="banner good" role="status" style="margin-bottom:12px"${I('D-309')}>${ic('check', 'sm')}<div>${esc(st.req)} requested — your browser is saving the file.</div></div>` : ''}
        <div class="grid-3">${EXPORTS.map(card).join('')}</div>
        ${U.section('Download history', `<div${I('D-312')}>${EXH.length ? U.table([{ h: 'File', k: 'f' }, { h: 'Scope used', k: 's' }, { h: 'Rows', k: 'r', r: 1 }, { h: 'By', k: 'b' }, { h: 'When', k: 'w' }, { h: 'Audit', k: 'a' }], EXH.map((x) => ({ f: `<code class="xs">${x.file}</code>`, s: chip(x.scope, x.scope === 'Whole programme' ? 'risk' : 'neutral'), r: x.rows, b: esc(x.by), w: esc(x.when), a: '<a class="small" href="#/admin/audit">On the trail</a>' }))) : '<div class="card"><p class="small muted">Nothing has been downloaded yet.</p></div>'}</div>`,
          `<span class="hrow">${chip('Whole programme', 'info', I('D-310'))}<button class="btn sm" type="button" data-act="xref"${I('D-311')}>${ic('restore', 'sm')}Refresh</button><a class="small" href="#/admin/audit">What changed</a></span>`)}` });
  },
  acts: {
    'change:pii'(el, ev, st) { st.pii = el.checked; App.rerender(); },
    xdl(el, ev, st) { const x = EXPORTS.find((e) => e[0] === el.dataset.k); const file = x[2]; const live = ROSTER.filter((s) => !s.removed && !s.alumni); dl(file, `${x[0] === 'students' && st.pii === false ? x[3].replace('usn, name, ', '') : x[3]}\n`); EXH.unshift({ file, scope: 'Whole programme', rows: live.length, by: ME, when: stamp() }); st.last[file] = stamp(); st.req = file; audit('export.download', 'export', file, file, null, null, { rows: live.length }); App.rerender(); },
    xref() { toast('History is up to date'); App.rerender(); },
  },
});
})();
