/* REEP v5 prototype — Faculty screens: My students, Notebook, Verify, Upskilling, Leave. */
'use strict';

/* ---------------------------------------------------------------- data this file adds */
D.coverAsks.push({ id: 52, who: 'Dr. Kavya Hegde', kind: 'OOD', dates: '18 Sep', row: 'MBA 3A · 14:00 · HR Analytics', state: 'Closed' });
D.leaves.splice(1, 0, { id: 37, kind: 'RH', from: '2026-10-24', to: '2026-10-24', purpose: 'Restricted holiday — Ayudha Puja', applied: '2026-09-28', status: 'Signed once · awaiting the Main Admin', alt: [], papers: [], note: '' });
D.leaves.forEach((l) => { l.credit ??= ''; l.altName ??= ''; l.papers = l.papers.map((p) => (Array.isArray(p) ? { name: p[0], size: p[1], by: 'Placement Office', at: l.decidedAt ? l.decidedAt.slice(0, 10) : l.applied, mine: false } : p)); });
D.leaveDraft = D.leaveDraft || null;

/* ---------------------------------------------------------------- helpers */
const F_AWAIT = ['Awaiting the Main Admin', 'Signed once · awaiting the Main Admin'];
const F_TONE = { Approved: 'good', Rejected: 'risk', Cancelled: 'neutral' };
const fStatus = (s, inv = '') => chip(s, F_TONE[s] || 'warn', inv);
const F_SANCTION = (s) => (s === 'Approved' ? ['Sanctioned', 'good'] : s === 'Rejected' ? ['Not sanctioned', 'risk'] : s === 'Cancelled' ? ['Cancelled', 'neutral'] : ['Pending', 'warn']);
const F_KINDS = [['Casual Leave', 'Casual Leave'], ['Permission', 'Permission'], ['OOD', 'On official duty (OOD)'], ['RH', 'Restricted holiday (RH)'], ['LOP', 'Loss of pay (LOP)']];
const fKind = (k) => (F_KINDS.find((x) => x[0] === k) || [k, k])[1];
const fSpan = (l) => (l.from && l.to ? (l.from === l.to ? fmtDate(l.from) : `${fmtShort(l.from)} – ${fmtDate(l.to)}`) : 'Dates not filled in yet');
const REMARK_TONE = { 'On track': 'good', Watch: 'warn', Done: 'neutral', Escalate: 'risk' };
const ACTION_TONE = { 'Flagged for follow-up': 'risk', 'Nudge sent': 'info', '1:1 scheduled': 'good' };
const nowStamp = () => `${TODAY} ${new Date().toTimeString().slice(0, 5)}`;
const fmtWhen = (w) => `${fmtDate(w.slice(0, 10))}${w.length > 10 ? ' · ' + w.slice(11) : ''}`;
const nextId = (arr) => arr.reduce((m, x) => Math.max(m, x.id), 0) + 1;
const fileOk = (f, maxMb) => {
  if (!f) return 'Choose a PDF, PNG or JPEG first.';
  if (!/\.(pdf|png|jpe?g)$/i.test(f.name)) return 'That file is not a PDF, PNG or JPEG.';
  if (f.size > maxMb * 1024 * 1024) return `That file is over ${maxMb} MB.`;
  return '';
};
const openFile = (name) => toast(`Opened ${name} in a new tab`);
const alertBox = (key) => `<div class="banner risk" role="alert" data-alert="${key}" style="display:none"></div>`;
const showAlert = (root, key, msg) => { const b = root.querySelector(`[data-alert="${key}"]`); if (b) { b.style.display = msg ? '' : 'none'; b.innerHTML = msg ? `${ic('alert', 'sm')}<span>${esc(msg)}</span>` : ''; } };

/* ================================================================ My students */
function menteeDetail(m, st) {
  const notes = D.notes[m.id] || [];
  const full = D.me.faculty.granted.includes('admin.student_records')
    ? `<a class="btn sm" href="#/admin/students/${m.id}"${I('B-180')}>${ic('eye', 'sm')} Full record</a>` : '';
  const form = `<div class="card" data-form="note"${I('B-181')}><div class="card-h"><h3>Log a meeting</h3>${st.flash === m.id ? chip('Saved', 'good') : ''}</div>
    <div class="stack">${U.field({ id: 'heading', label: 'Heading (optional)', ph: 'e.g. Semester 3 plan', attrs: ' maxlength="200"' })}
    ${U.field({ id: 'action', label: 'Linked action', opts: ['None', 'Flagged for follow-up', 'Nudge sent', '1:1 scheduled'] })}
    ${U.field({ id: 'text', label: 'Meeting note', type: 'textarea', req: true, attrs: ' maxlength="4000" rows="4"' })}
    ${alertBox('note')}
    <div><button class="btn primary" type="button" data-act="saveNote" data-sid="${m.id}"${I('B-182')}>Save note</button></div></div></div>`;
  const list = notes.length
    ? `<div class="list"${I('B-183')}>${notes.map((n) => `<div class="row"><div class="body"><div class="ttl">${esc(n.title || 'Meeting note')}</div><div class="sub">${fmtWhen(n.when)}</div><p class="small" style="margin-top:6px;color:var(--ink)">${esc(n.text)}</p>${n.action && n.action !== 'None' ? `<div style="margin-top:6px">${chip(n.action, ACTION_TONE[n.action] || 'info')}</div>` : ''}</div><div class="trail"><button class="icon-btn" type="button" data-act="delNote" data-sid="${m.id}" data-id="${n.id}" aria-label="Delete note"${I('B-184')}>${ic('trash')}</button></div></div>`).join('')}</div>`
    : `<div class="card"${I('B-183')}>${U.empty('chat', `No meeting notes for ${m.name} yet`)}</div>`;
  return `<div class="card flat" style="margin-bottom:12px"><div class="spread"><div class="hrow"><span class="avatar">${initials(m.name)}</span><div><h2 style="font-size:18px">${esc(m.name)}</h2><div class="small muted">${esc(m.usn || 'No USN')} · Sem ${m.sem} · ${esc(m.stage)}</div></div></div>${full}</div></div>
    ${form}${U.section('Meeting notes', list)}`;
}
function menteeList(st, selId) {
  if (!D.mentees.length) return `<div class="card"${I('B-179')}>${U.empty('users', 'No mentees are assigned to you yet.', 'The Main Admin assigns students to you on Assign faculty.')}</div>`;
  const q = (st.q || '').toLowerCase();
  const rows = D.mentees.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.usn || '').toLowerCase().includes(q));
  return `<div class="filters" style="margin-bottom:10px">${U.search('q', st.q || '', 'Search name or USN', I('B-178'))}</div>
    ${rows.length ? `<div class="list"${I('B-179')}>${rows.map((m) => U.row({ title: esc(m.name), sub: `${esc(m.usn || 'No USN')} · Sem ${m.sem}`, lead: U.av(m.name), trail: chip(m.stage, 'info'), href: `#/faculty/mentees/${m.id}`, sel: m.id === selId })).join('')}</div>`
      : `<div class="card">${U.empty('search', 'No student matches that search.')}</div>`}`;
}
R.screen('faculty/mentees', { title: 'My students', states: 'B-179', render({ id, st }) {
  const m = id && D.mentees.find((x) => x.id === id);
  if (id && !m) return U.page({ title: 'Student', back: true, body: U.empty('alert', 'That student is not in your group') });
  const sel = m || D.mentees[0];
  const body = `<div class="split${m ? ' fac-pushed' : ''}"><div>${menteeList(st, sel && sel.id)}</div><div class="detail-pane">${sel ? menteeDetail(sel, st) : ''}</div></div>`;
  return U.page({ title: m ? m.name : 'My students', lede: m ? '' : `${D.mentees.length} in your group`, back: !!m, body });
},
acts: {
  saveNote(el, ev, st) {
    const root = el.closest('[data-form]'); const v = formVals(root);
    if (!errs(root, v.text ? {} : { text: 'Write the note first.' })) return;
    if (v.text.length > 4000) return errs(root, { text: 'Keep the note under 4000 characters.' });
    const sid = el.dataset.sid; const arr = (D.notes[sid] ||= []);
    arr.unshift({ id: Date.now(), title: v.heading.slice(0, 200), when: nowStamp(), text: v.text, action: v.action });
    st.flash = sid; toast('Note saved'); App.rerender();
  },
  delNote(el) {
    Sheet.confirm({ title: 'Delete this note?', text: 'The student may already have read it. It will be removed from their Mentor Meeting Log.', ok: 'Delete note', danger: true,
      onOk: () => { const arr = D.notes[el.dataset.sid]; arr.splice(arr.findIndex((n) => String(n.id) === el.dataset.id), 1); toast('Note deleted'); App.rerender(); } });
  },
} });

/* ================================================================ Notebook */
function entrySheet(sid) {
  const m = D.mentees.find((x) => x.id === sid);
  Sheet.open({ title: `New entry · ${m.name}`,
    body: `<div class="stack"${I('B-173')}>${alertBox('nb')}${U.field({ id: 'date', label: 'Date', type: 'date', value: TODAY })}
      ${U.field({ id: 'key', label: 'Key discussions', type: 'textarea', req: true, attrs: ' maxlength="20000" rows="5"' })}
      ${U.field({ id: 'follow', label: 'Follow up', attrs: ' maxlength="500"' })}
      ${U.field({ id: 'remark', label: 'Remarks', opts: [['', '—'], 'On track', 'Watch', 'Done', 'Escalate'] })}</div>`,
    foot: `<button class="btn" type="button" data-sheet-close>Close</button><button class="btn primary" type="button" data-act="save"${I('B-174')}>Save entry</button>`,
    onAct: { save(a, ev, el) {
      const v = formVals(el);
      if (!errs(el, v.key ? {} : { key: 'Write the key discussions first.' })) return;
      if (v.follow.length > 500) return errs(el, { follow: 'Keep the follow up under 500 characters.' });
      if (!v.date) return showAlert(el, 'nb', 'The entry needs a date.');
      a.textContent = 'Saving…'; a.disabled = true;
      D.notebook.unshift({ id: nextId(D.notebook), sid, date: v.date, key: v.key, follow: v.follow, remark: v.remark, published: false });
      Sheet.close(); toast('Entry saved — private until you publish it'); App.rerender();
    } } });
}
R.screen('faculty/notebook', { title: 'Notebook', states: 'B-170', render({ st }) {
  const sid = st.sid || '';
  const opts = D.mentees.length ? [['', 'Choose a student'], ...D.mentees.map((m) => [m.id, `${m.name} · ${m.usn || 'No USN'}`])] : [['', 'No assigned students']];
  const filters = `<div class="filters" style="margin-bottom:12px">${U.select('sid', opts, sid, I('B-171'), 'Student')}</div>`;
  let log;
  if (!D.mentees.length) log = `<div class="card">${U.empty('users', 'No assigned students', 'A faculty member with no group sees nobody.')}</div>`;
  else if (!sid) log = `<div class="card">${U.empty('book', 'Pick a student to see their log')}</div>`;
  else {
    const rows = D.notebook.filter((e) => e.sid === sid).map((e) => ({
      date: `${fmtDate(e.date)}${e.published ? `<div style="margin-top:4px">${chip('Published', 'info')}</div>` : ''}`,
      key: esc(e.key), follow: esc(e.follow || '—'), remark: e.remark ? chip(e.remark, REMARK_TONE[e.remark]) : '—',
      acts: `<span class="hrow" style="justify-content:flex-end">${e.published ? '' : `<button class="btn sm" type="button" data-act="publish" data-id="${e.id}"${I('B-176')}>${ic('send', 'sm')} Publish</button>`}<button class="btn sm danger" type="button" data-act="delEntry" data-id="${e.id}"${I('B-177')}>${ic('trash', 'sm')} Delete</button></span>`,
    }));
    log = rows.length ? U.table([{ h: 'Date', k: 'date' }, { h: 'Key discussions', k: 'key' }, { h: 'Follow up', k: 'follow' }, { h: 'Remarks', k: 'remark' }, { h: '', k: 'acts', r: true }], rows, I('B-175'))
      : `<div class="card"${I('B-175')}>${U.empty('book', 'No entries for this student yet')}</div>`;
  }
  return U.page({ title: 'Notebook', lede: 'Your own meeting log. Entries stay with you until you publish one to the student.',
    acts: `${chip('Private by default', 'neutral', I('B-170'))}<button class="btn primary" type="button" data-act="addEntry"${sid ? '' : ' disabled'}${I('B-172')}>${ic('plus', 'sm')} Add entry</button>`,
    body: filters + log });
},
acts: {
  addEntry(el, ev, st) { if (st.sid) entrySheet(st.sid); },
  publish(el) { const e = D.notebook.find((x) => String(x.id) === el.dataset.id); e.published = true; toast('Published to the student\'s Mentor Meeting Log'); App.rerender(); },
  delEntry(el) {
    const e = D.notebook.find((x) => String(x.id) === el.dataset.id);
    Sheet.confirm({ title: 'Delete this entry?', text: e.published ? 'This entry is published. It will disappear from the student\'s Mentor Meeting Log.' : 'The entry will be removed from your notebook.', ok: 'Delete entry', danger: true,
      onOk: () => { D.notebook.splice(D.notebook.indexOf(e), 1); toast('Entry deleted'); App.rerender(); } });
  },
} });

/* ================================================================ Verify */
const RUBRIC = ['The certificate names the student', 'The issuer is on the approved catalogue', 'The course matches the badge', 'The date is within this programme'];
function claimSheet(c) {
  const file = c.file ? `<button class="btn sm" type="button" data-act="open"${I('B-188')}>${ic('file', 'sm')} ${esc(c.file)}</button>` : chip('No file attached', 'neutral', I('B-188'));
  Sheet.open({ title: `Review · ${c.badge}`, wide: true,
    body: `<div class="stack"${I('B-187')}><dl class="kv"><dt>Badge</dt><dd>${esc(c.badge)}</dd><dt>Category</dt><dd>${esc(c.cat)}</dd><dt>Evidence</dt><dd>${esc(c.kind)}</dd><dt>Issued by</dt><dd>${esc(c.issuer || '—')}</dd><dt>Student</dt><dd>${esc(c.student)} · ${esc(c.usn)}</dd><dt>Submitted</dt><dd>${fmtDate(c.at)}</dd><dt>File</dt><dd>${file}</dd></dl>
      <div class="card flat"><div class="xs muted" style="font-weight:700">Student's note</div><p class="small">${c.note ? `“${esc(c.note)}”` : 'No note'}</p></div>
      <div class="card flat"><div class="xs muted" style="font-weight:700;margin-bottom:4px">Check</div><ul class="small" style="margin:0;padding-left:18px">${RUBRIC.map((r) => `<li>${r}</li>`).join('')}</ul></div>
      ${U.field({ id: 'note', label: 'Note to the student', type: 'textarea', hint: 'Required to request changes or reject. The student is emailed this note.', inv: I('B-189') })}</div>`,
    foot: `<button class="btn danger" type="button" data-act="d" data-v="Rejected"${I('B-192')}>Reject</button><button class="btn" type="button" data-act="d" data-v="Needs changes"${I('B-191')}>Request changes</button><button class="btn primary" type="button" data-act="d" data-v="Verified"${I('B-190')}>Verify</button>`,
    onAct: {
      open: () => openFile(c.file),
      d(a, ev, el) {
        const note = el.querySelector('#note').value.trim(); const out = a.dataset.v;
        if (out !== 'Verified' && !note) return errs(el, { note: out === 'Rejected' ? 'Write the reason for rejecting — the student is told.' : 'Say what needs to change — the student is told.' });
        D.claimQueue.splice(D.claimQueue.indexOf(c), 1);
        D.reviewed.unshift({ outcome: out, badge: c.badge, student: c.student, date: TODAY, note });
        Sheet.close(); toast(out === 'Verified' ? `${c.badge} verified — badge lit and certificate verified` : out === 'Rejected' ? 'Claim and its certificate rejected' : 'Sent back for changes'); App.rerender();
      },
    } });
}
function docSheet(d) {
  Sheet.open({ title: `Review · ${d.title}`, center: true,
    body: `<div class="stack"><p class="small">${esc(d.student)} · ${esc(d.kind)} · ${fmtWhen(d.at)}</p>${U.field({ id: 'note', label: 'Reviewer note', type: 'textarea', hint: 'Required to reject.', inv: I('B-195') })}</div>`,
    foot: `<button class="btn danger" type="button" data-act="d" data-v="Rejected">Reject</button><button class="btn primary" type="button" data-act="d" data-v="Verified">Verify</button>`,
    onAct: { d(a, ev, el) {
      const note = el.querySelector('#note').value.trim(); const out = a.dataset.v;
      if (out === 'Rejected' && !note) return errs(el, { note: 'Write the reason for rejecting.' });
      D.docQueue.splice(D.docQueue.indexOf(d), 1);
      D.reviewed.unshift({ outcome: out, badge: d.title, student: d.student, date: TODAY, note });
      Sheet.close(); toast(out === 'Verified' ? 'Document verified' : 'Document rejected'); App.rerender();
    } } });
}
R.screen('faculty/verifications', { title: 'Verify', states: 'B-186 B-193', render({ st }) {
  const tab = st.q || 'claims';
  const counts = `<div class="hrow" style="margin-bottom:12px"${I('B-185')}>${chip(`Skill claims ${D.claimQueue.length}`, D.claimQueue.length ? 'warn' : 'neutral')}${chip(`Documents ${D.docQueue.length}`, D.docQueue.length ? 'warn' : 'neutral')}</div>`;
  const claims = D.claimQueue.length ? `<div class="list"${I('B-186')}>${D.claimQueue.map((c, i) => `<div class="row">${U.lead('star')}<div class="body"><div class="ttl">${esc(c.badge)}</div><div class="sub">${esc(c.cat)} · ${esc(c.kind)}</div><div class="sub">${esc(c.student)} · submitted ${fmtShort(c.at)}</div><div class="hrow" style="margin-top:8px">${chip(i === 0 ? 'Under review' : 'Submitted', i === 0 ? 'info' : 'warn')}<button class="btn sm" type="button" data-act="review" data-id="${c.id}"${I('B-187')}>Review evidence</button></div></div></div>`).join('')}</div>`
    : `<div class="card"${I('B-186')}>${U.empty('checks', 'Nothing waiting for your review.')}</div>`;
  const docs = D.docQueue.length ? `<div class="list"${I('B-193')}>${D.docQueue.map((d) => `<div class="row">${U.lead('file')}<div class="body"><div class="ttl">${esc(d.title)}</div><div class="sub">${esc(d.kind)} · ${esc(d.student)} · ${fmtWhen(d.at)}</div><div class="hrow" style="margin-top:8px">${chip('Pending review', 'warn')}<button class="btn sm ghost" type="button" data-act="open" data-file="${esc(d.file)}"${I('B-194')}>${ic('download', 'sm')} Open ${esc(d.file)}</button></div></div><div class="trail"><button class="btn sm" type="button" data-act="reviewDoc" data-id="${d.id}">Review</button></div></div>`).join('')}</div>`
    : `<div class="card"${I('B-193')}>${U.empty('file', 'No documents waiting', 'Files a skill claim explains are reviewed with the claim.')}</div>`;
  const OT = { Verified: 'good', 'Needs changes': 'warn', Rejected: 'risk' };
  const hist = D.reviewed.length ? `<div class="list"${I('B-196')}>${D.reviewed.map((r) => U.row({ title: `${esc(r.badge)} · ${esc(r.student)}`, sub: `${fmtDate(r.date)}${r.note ? ` · “${esc(r.note)}”` : ''}`, trail: chip(r.outcome, OT[r.outcome]), chev: false })).join('')}</div>`
    : `<div class="card"${I('B-196')}>${U.empty('restore', 'Nothing reviewed yet')}</div>`;
  return U.page({ title: 'Verify', body: counts + U.tabs('q', [['claims', `Skill claims (${D.claimQueue.length})`], ['docs', `Documents (${D.docQueue.length})`]], tab)
    + `<div style="margin-top:12px">${tab === 'docs' ? docs : claims}</div>` + U.section('Recently reviewed', hist) });
},
acts: {
  review(el) { claimSheet(D.claimQueue.find((c) => String(c.id) === el.dataset.id)); },
  reviewDoc(el) { docSheet(D.docQueue.find((d) => String(d.id) === el.dataset.id)); },
  open(el) { openFile(el.dataset.file); },
} });

/* ================================================================ Upskilling */
R.screen('faculty/upskilling', { title: 'Upskilling', states: 'B-199', render() {
  const rows = D.upskilling.map((u) => ({ t: `<b>${esc(u.title)}</b>`, p: esc(u.provider || '—'), d: u.done ? fmtDate(u.done) : '—',
    f: `<span class="hrow" style="justify-content:flex-end"><button class="btn sm ghost" type="button" data-act="open" data-file="${esc(u.file)}"${I('B-200')}>${ic('eye', 'sm')} View</button><button class="btn sm danger" type="button" data-act="remove" data-id="${u.id}"${I('B-201')}>${ic('trash', 'sm')} Remove</button></span>` }));
  const table = rows.length ? U.table([{ h: 'Certificate', k: 't' }, { h: 'Provider', k: 'p' }, { h: 'Completed', k: 'd' }, { h: 'File', k: 'f', r: true }], rows, I('B-199'))
    : `<div class="card"${I('B-199')}>${U.empty('leaf', 'No certificates yet')}</div>`;
  return U.page({ title: 'Upskilling', lede: 'Courses you have completed. Kept on your record; nobody reviews them.',
    acts: `<button class="btn primary" type="button" data-act="add">${ic('upload', 'sm')} Add a certificate</button>`,
    body: U.section(`${D.upskilling.length} on file`, table) });
},
acts: {
  open(el) { openFile(el.dataset.file); },
  add() {
    Sheet.open({ title: 'Add a certificate',
      body: `<div class="stack"${I('B-197')}>${U.field({ id: 'name', label: 'Course / certificate name', req: true, attrs: ' maxlength="200"' })}${U.field({ id: 'provider', label: 'Provider (optional)', attrs: ' maxlength="200"' })}${U.field({ id: 'done', label: 'Completed on', type: 'date' })}
        <label class="drop">${ic('upload', 'lg')}<div style="margin-top:6px;font-weight:600;color:var(--ink)">Choose the certificate file</div><div class="xs">PDF, PNG or JPEG · up to 10 MB</div><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" data-act-change="file" data-f="file"><div class="xs" data-file="file" style="margin-top:6px;color:var(--brand-purple)"></div></label>${alertBox('up')}</div>`,
      foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="up"${I('B-198')}>${ic('upload', 'sm')} Upload</button>`,
      onAct: { up(a, ev, el) {
        const v = formVals(el);
        if (!errs(el, v.name ? {} : { name: 'Name the certificate first.' })) return;
        const bad = fileOk(v.file, 10); if (bad) return showAlert(el, 'up', `Upload failed. ${bad}`);
        D.upskilling.unshift({ id: nextId(D.upskilling), title: v.name, provider: v.provider, done: v.done, file: v.file.name });
        Sheet.close(); toast('Uploaded'); App.rerender();
      } } });
  },
  remove(el) {
    const u = D.upskilling.find((x) => String(x.id) === el.dataset.id);
    Sheet.confirm({ title: 'Remove this certificate?', text: `This permanently deletes “${esc(u.title)}” and its file.`, ok: 'Remove', danger: true,
      onOk: () => { D.upskilling.splice(D.upskilling.indexOf(u), 1); toast('Removed'); App.rerender(); } });
  },
} });

/* ================================================================ Leave */
function leaveList() {
  const d = D.leaveDraft;
  const draft = d ? `<a class="row" href="#/faculty/leave/new"${I('B-208')}>${U.lead('pen')}<div class="body"><div class="ttl">${esc(fKind(d.kind))} · Draft · saved on this device</div><div class="sub">${fSpan(d)}</div></div><div class="trail">${chip('Draft', 'neutral')}${ic('chev', 'sm')}</div></a>` : '';
  const rows = D.leaves.map((l) => U.row({ title: esc(fKind(l.kind)), sub: `Applied ${fmtShort(l.applied)} · ${fSpan(l)}`, lead: U.lead('cal'), trail: fStatus(l.status, I('B-210')), href: `#/faculty/leave/${l.id}` })).join('');
  return draft || rows ? `<div class="list"${I('B-209')}>${draft}${rows}</div>` : `<div class="card"${I('B-209')}>${U.empty('cal', 'No leave requests yet.')}</div>`;
}
function allowance() {
  const b = D.balances;
  const body = b.length ? `<div class="list">${b.map(([k, total, taken]) => { const left = total - taken; return U.row({ title: esc(k), sub: `${taken} of ${total} taken`, trail: chip(`${left} left`, left < 0 ? 'risk' : left === 0 ? 'warn' : 'good'), chev: false }); }).join('')}</div>`
    : `<div class="card">${U.empty('cal', 'No allowance recorded', 'The office has not entered an allowance for you this year.')}</div>`;
  return `<div${I('B-211')}>${U.section('Your leave allowance', body, '<span class="xs muted">Academic year 2026-27</span>')}</div>`;
}
function coverList() {
  const waiting = D.coverAsks.filter((c) => c.state === 'Waiting on you').length;
  const rows = D.coverAsks.map((c) => {
    const trail = c.state === 'Waiting on you' ? `<button class="btn sm primary" type="button" data-act="cover" data-id="${c.id}"${I('B-213')}>I will cover this</button>`
      : c.state === 'Agreed' ? chip('You agreed to cover', 'good') : chip('Nothing to do', 'neutral');
    return `<div class="row">${U.av(c.who)}<div class="body"><div class="ttl">${esc(c.who)}</div><div class="sub">${esc(fKind(c.kind))} · ${esc(c.dates)}</div><div class="xs muted" style="margin-top:2px">Your row: ${esc(c.row)}</div></div><div class="trail">${trail}</div></div>`;
  }).join('');
  return `<div${I('B-212')}>${U.section('Colleagues who named you', rows ? `<div class="list">${rows}</div>` : `<div class="card">${U.empty('users', 'Nobody has named you as cover')}</div>`, waiting ? chip(`${waiting} waiting on you`, 'warn') : '')}</div>`;
}

/* The college's form, filled in. Fields keep their values across the in-page toggles: nothing here rerenders. */
function leaveForm(v) {
  const me = D.me.faculty; const or = (x) => esc(x || 'Not on record');
  const sig = D.signature.faculty;
  const hint = sig && sig.on ? `<div class="banner info"${I('B-225')}>${ic('sign', 'sm')}<span>Your signature image is on file and prints above your name. <a href="#/faculty/account">Change it</a></span></div>`
    : `<div class="banner warn"${I('B-225')}>${ic('sign', 'sm')}<span>No signature image on file — the paper will show your name and time only. <a href="#/faculty/account">Add your signature image</a></span></div>`;
  const alt = (r = ['', '', '', '', ''], i) => `<tr class="alt-row">${['date', 'text', 'text', 'text', 'text'].map((t, j) => `<td data-l="${['Date', 'Staff name', 'Class', 'Time', 'Remarks'][j]}"><input class="input" type="${t}" aria-label="${['Date', 'Staff name', 'Class', 'Time', 'Remarks'][j]} row ${i + 1}" value="${esc(r[j])}"></td>`).join('')}</tr>`;
  const alts = (v.alt.length ? v.alt : [undefined]).map((r, i) => alt(r, i)).join('');
  const [sw, st] = F_SANCTION('');
  return `<div class="card fac-paper" data-form="leave">
    <div class="field"${I('B-215')}><span class="lbl">Leave kind</span><div class="seg fac-kinds" role="group">${F_KINDS.map(([k, t]) => `<button type="button" data-act="kind" data-v="${k}" aria-pressed="${k === v.kind}">${esc(t)}</button>`).join('')}</div><input type="hidden" name="kind" value="${esc(v.kind)}"></div>
    <dl class="kv" style="margin:14px 0"${I('B-216')}><dt>Name</dt><dd>${or(me.name)}</dd><dt>Designation</dt><dd>${or(me.designation)}</dd><dt>Department</dt><dd>${or(me.dept)}</dd></dl>
    <div class="form-grid"${I('B-217')}>${U.field({ id: 'from', label: 'From date', type: 'date', req: true, value: v.from })}${U.field({ id: 'to', label: 'To date', type: 'date', req: true, value: v.to })}</div>
    ${U.field({ id: 'purpose', label: 'Purpose', type: 'textarea', req: true, value: v.purpose, inv: I('B-218') })}
    <div class="form-grid">${U.field({ id: 'credit', label: 'Credit', value: v.credit, ph: 'e.g. 3 days', inv: I('B-219') })}<div class="field"${I('B-220')}><span class="lbl">Sanctioned</span><div style="padding-top:8px">${chip(sw, st)}</div></div></div>
    <div class="section"${I('B-221')}><div class="sh"><h2>Alternate arrangements</h2></div>
      ${U.field({ id: 'altName', label: 'Alternate arrangement name', value: v.altName })}
      <div class="card tight"><table class="rtable fac-alt"><thead><tr><th>Date</th><th>Staff name</th><th>Class</th><th>Time</th><th>Remarks</th></tr></thead><tbody>${alts}</tbody></table></div>
      <button class="btn sm" type="button" data-act="addAlt" style="margin-top:8px">${ic('plus', 'sm')} Add a row</button></div>
    ${hint}
    <div class="card flat" style="margin-top:12px"><div class="spread"><div><div class="xs muted" style="font-weight:700">SIGNATURE OF THE APPLICANT</div><div class="small">${esc(me.name)} · signed when you submit</div></div><button class="btn sm" type="button" data-act="submit" data-sign disabled${I('B-222')}>${ic('sign', 'sm')} Sign</button></div></div>
    ${alertBox('leave')}
  </div>`;
}
function readLeave(root) {
  const v = formVals(root);
  v.alt = [...root.querySelectorAll('.alt-row')].map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value.trim())).filter((r) => r.some(Boolean));
  return v;
}
function leaveDetail(l) {
  const me = D.me.faculty; const [sw, st] = F_SANCTION(l.status);
  const decided = l.status === 'Approved' || l.status === 'Rejected';
  const alts = l.alt.length ? U.table([{ h: 'Date', k: 0 }, { h: 'Staff name', k: 1 }, { h: 'Class', k: 2 }, { h: 'Time', k: 3 }, { h: 'Remarks', k: 4 }], l.alt.map((r) => r.map((x, i) => (i === 0 && x ? fmtShort(x) : esc(x || '—')))))
    : '<p class="small muted">No alternate arrangements recorded.</p>';
  const director = `<div class="card flat"${I('B-226')}><div class="xs muted" style="font-weight:700">PROGRAM DIRECTOR</div>${decided ? `<div class="small"><b>${esc(l.decidedBy || 'Placement Office')}</b> · ${esc(l.decidedAt || l.applied)}</div>` : `<div class="small">${chip('Awaiting', 'warn')}</div>`}</div>`;
  const remarks = l.note && l.status !== 'Cancelled' ? `<div class="banner ${l.status === 'Rejected' ? 'risk' : 'info'}" style="margin-top:12px"${I('B-228')}><span><b>Program Director's remarks:</b> ${l.status === 'Rejected' ? 'Rejected — ' : ''}${esc(l.note)}</span></div>` : '';
  const papers = l.papers.length ? `<div class="list"${I('B-230')}>${l.papers.map((p, i) => U.row({ title: esc(p.name), sub: `${esc(p.size)} · ${esc(p.by)} · ${fmtShort(p.at)}`, lead: U.lead('file'), chev: false,
      trail: `<button class="icon-btn" type="button" data-act="open" data-file="${esc(p.name)}" aria-label="Download ${esc(p.name)}">${ic('download')}</button>${p.mine ? `<button class="icon-btn" type="button" data-act="rmPaper" data-i="${i}" aria-label="Remove ${esc(p.name)}">${ic('trash')}</button>` : ''}` })).join('')}</div>`
    : `<p class="small muted"${I('B-230')}>No supporting papers attached.</p>`;
  const attach = l.status === 'Cancelled' ? '' : `<div class="card flat" style="margin-top:10px" data-form="paper"${I('B-229')}><label class="drop" style="padding:14px">${ic('upload')}<div style="font-weight:600;color:var(--ink)">Attach a document</div><div class="xs">PDF, PNG or JPEG</div><input type="file" name="paper" accept=".pdf,.png,.jpg,.jpeg" data-act-change="file" data-f="paper"><div class="xs" data-file="paper" style="margin-top:6px;color:var(--brand-purple)"></div></label>${alertBox('paper')}<button class="btn sm" type="button" data-act="attach" style="margin-top:8px">${ic('upload', 'sm')} Attach</button></div>`;
  const acts = [
    decided ? `<button class="btn" type="button" data-act="pdf"${I('B-227')}>${ic('download', 'sm')} Download PDF</button>` : '',
    l.status === 'Rejected' ? `<a class="btn primary" href="#/faculty/leave/new?from=${l.id}"${I('B-231')}>${ic('pen', 'sm')} Edit &amp; resubmit</a>` : '',
  ].join('');
  const withdraw = F_AWAIT.includes(l.status) ? `<div style="margin-top:16px"><button class="btn danger" type="button" data-act="withdraw"${I('B-232')}>Withdraw this request</button></div>` : '';
  return U.page({ title: fKind(l.kind), back: true, lede: `Applied ${fmtDate(l.applied)}`, acts: fStatus(l.status) + acts, body: `<div class="card fac-paper">
      <dl class="kv"><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Designation</dt><dd>${esc(me.designation || 'Not on record')}</dd><dt>Department</dt><dd>${esc(me.dept || 'Not on record')}</dd><dt>Leave</dt><dd>${esc(fKind(l.kind))}</dd><dt>Dates</dt><dd>${fSpan(l)}</dd><dt>Purpose</dt><dd>${esc(l.purpose)}</dd><dt>Credit</dt><dd>${esc(l.credit || '—')}</dd><dt>Sanctioned</dt><dd>${chip(sw, st)}</dd></dl>
      ${U.section('Alternate arrangements', (l.altName ? `<p class="small">${esc(l.altName)}</p>` : '') + alts)}
      <div class="grid-2" style="margin-top:14px"><div class="card flat"><div class="xs muted" style="font-weight:700">SIGNATURE OF THE APPLICANT</div><div class="small"><b>${esc(me.name)}</b> · ${esc(l.signedAt || l.applied)}</div></div>${director}</div>${remarks}</div>
    ${U.section('Supporting papers', papers + attach)}${withdraw}` });
}
R.screen('faculty/leave', { title: 'Leave', states: 'B-209 B-211', render({ id, query }) {
  if (id === 'new') {
    const src = query.from && D.leaves.find((l) => String(l.id) === query.from);
    const v = src ? { kind: src.kind, from: '', to: '', purpose: src.purpose, credit: src.credit, altName: src.altName, alt: src.alt.map((r) => r.slice()) }
      : D.leaveDraft ? { ...D.leaveDraft, alt: D.leaveDraft.alt.map((r) => r.slice()) } : { kind: 'Casual Leave', from: '', to: '', purpose: '', credit: '', altName: '', alt: [] };
    return U.page({ title: src ? 'Resubmit leave' : 'New leave request', back: true, lede: src ? `Starting from the rejected request of ${fmtDate(src.applied)}. That one stays on record.` : (D.leaveDraft ? 'Draft saved on this device.' : ''),
      acts: `<a class="btn ghost" href="#/faculty/leave"${I('B-214')}>${ic('back', 'sm')} Back to requests</a>`,
      body: leaveForm(v) + `<div class="sticky-act fac-sticky"><button class="btn" type="button" data-act="saveDraft"${I('B-223')}>Save draft</button>${D.leaveDraft ? `<button class="btn ghost" type="button" data-act="discard"${I('B-224')}>Discard draft</button>` : ''}<button class="btn primary" type="button" data-act="submit" disabled${I('B-222')}>${ic('sign', 'sm')} Sign &amp; submit to Program Director</button></div>` });
  }
  if (id) {
    const l = D.leaves.find((x) => String(x.id) === id);
    return l ? leaveDetail(l) : U.page({ title: 'Leave', back: true, body: U.empty('alert', 'That request does not exist') });
  }
  return U.page({ title: 'Leave', acts: `<a class="btn primary" href="#/faculty/leave/new"${I('B-207')}>${ic('plus', 'sm')} New leave request</a>`,
    body: `<div class="grid-2 fac-leave"><div>${U.section('Your requests', leaveList()).replace('class="section"', 'class="section" style="margin-top:0"')}</div><div>${allowance()}${coverList()}</div></div>` });
},
mount(main, { id }) {
  if (id !== 'new') return;
  const root = main.querySelector('[data-form="leave"]');
  const sync = () => { const v = formVals(root); main.querySelectorAll('[data-act="submit"]').forEach((b) => { b.disabled = !(v.from && v.to && v.purpose); }); };
  root.addEventListener('input', sync); root.addEventListener('change', sync); sync();
},
acts: {
  kind(el) { const g = el.parentElement; g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); g.nextElementSibling.value = el.dataset.v; },
  addAlt(el) { const tb = document.querySelector('.fac-alt tbody'); const tr = tb.querySelector('.alt-row').cloneNode(true); tr.querySelectorAll('input').forEach((i) => { i.value = ''; i.setAttribute('aria-label', i.getAttribute('aria-label').replace(/\d+$/, tb.children.length + 1)); }); tb.appendChild(tr); tr.querySelector('input').focus(); },
  saveDraft() { D.leaveDraft = readLeave(document.querySelector('[data-form="leave"]')); toast('Draft saved on this device.'); App.rerender(); },
  discard() { Sheet.confirm({ title: 'Discard the draft?', text: 'Discard the draft saved on this device?', ok: 'Discard draft', danger: true, onOk: () => { D.leaveDraft = null; toast('Draft discarded'); R.go('#/faculty/leave'); } }); },
  submit() {
    const root = document.querySelector('[data-form="leave"]'); const v = readLeave(root);
    const e = {}; if (!v.from) e.from = 'Choose the From date.'; if (!v.to) e.to = 'Choose the To date.'; if (!v.purpose) e.purpose = 'Write the purpose.';
    if (v.from && v.to && v.to < v.from) e.to = 'The To date is before the From date.';
    showAlert(root, 'leave', e.to && v.to < v.from ? 'Dates must run forwards: the leave cannot end before it starts.' : '');
    if (!errs(root, e)) return;
    const l = { id: nextId(D.leaves), kind: v.kind, from: v.from, to: v.to, purpose: v.purpose, credit: v.credit, altName: v.altName, alt: v.alt, applied: TODAY, signedAt: nowStamp(), status: 'Awaiting the Main Admin', papers: [], note: '' };
    D.leaves.unshift(l); D.leaveDraft = null;
    toast('Signed and sent to the Program Director'); R.go(`#/faculty/leave/${l.id}`);
  },
  cover(el) { const c = D.coverAsks.find((x) => String(x.id) === el.dataset.id); c.state = 'Agreed'; toast(`You agreed to cover for ${c.who}`); App.rerender(); },
  open(el) { openFile(el.dataset.file); },
  pdf() { toast('Downloading the leave form (PDF)'); },
  attach(el) {
    const root = el.closest('[data-form]'); const f = root.querySelector('input[type=file]').files[0];
    const bad = fileOk(f, 10); if (bad) return showAlert(root, 'paper', bad);
    const l = D.leaves.find((x) => String(x.id) === App.cur.id);
    l.papers.push({ name: f.name, size: `${Math.max(1, Math.round(f.size / 1024))} kB`, by: D.me.faculty.name, at: TODAY, mine: true }); toast('Attached'); App.rerender();
  },
  rmPaper(el) {
    const l = D.leaves.find((x) => String(x.id) === App.cur.id); const p = l.papers[+el.dataset.i];
    Sheet.confirm({ title: 'Remove this paper?', text: `“${esc(p.name)}” will be removed from the request.`, ok: 'Remove', danger: true, onOk: () => { l.papers.splice(+el.dataset.i, 1); toast('Removed'); App.rerender(); } });
  },
  withdraw() {
    const l = D.leaves.find((x) => String(x.id) === App.cur.id);
    Sheet.open({ title: 'Withdraw this request?', center: true, body: '<p>This cannot be undone. You would have to apply again.</p>',
      foot: `<button class="btn" type="button" data-sheet-close>Keep it</button><button class="btn danger solid" type="button" data-act="ok">Yes, withdraw it</button>`,
      onAct: { ok: () => { Sheet.close(); l.status = 'Cancelled'; toast('Request withdrawn'); App.rerender(); } } });
  },
} });
