/* REEP v5 prototype — signed-out screens: the start page, sign in (with the
   forgot-password sheet), the three-step setup walk, the activation/reset
   password page and the student application form. */
'use strict';

R.screen('start', { title: 'REEP v5 prototype', bare: true, render() {
  const card = (role, t, sub, icn) => `<button class="card role-card" type="button" data-act="role" data-v="${role}"><span class="lead" style="width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--tint-1);color:var(--brand-purple)">${ic(icn, 'lg')}</span><span class="grow"><b style="font-family:var(--font-display);font-size:17px">${t}</b><br><span class="small muted">${sub}</span></span>${ic('chev')}</button>`;
  return { title: 'REEP v5 prototype', html: `<div class="landing"><div class="hrow" style="margin-bottom:20px"><span class="brand-mark">R</span><span class="brand-name">REEP</span></div>
    <h1>Pick who you are</h1><p class="lede muted" style="margin:6px 0 20px">A clickable prototype with invented data. Switch roles any time from the bar at the top.</p>
    <div class="stack">${card('student', 'Student', 'Aarav Kulkarni · MBA Finance · 2025-27', 'user')}${card('faculty', 'Faculty', 'Dr. Meera Iyer · four students in her group', 'users')}${card('admin', 'Main Admin', 'Placement Office · whole programme', 'shield')}${card('public', 'Signed out', 'Sign in, apply, set up an account', 'key')}</div>
    <p class="xs muted" style="margin-top:20px"><a href="components.html">Design system sheet</a></p></div>` };
} });

/* ================================================================ Sign in */
const SSO_ERR = {
  sso_not_enrolled: 'That Google account is not on the roster. Use your college address, or apply first.',
  sso_unverified_email: 'Google has not verified that address.', sso_denied: 'You cancelled the Google sign-in.',
  sso_state: 'The sign-in took too long. Try again.', sso_failed: 'Google sign-in failed. Try again.',
};
const PORTALS = { student: ['Student', 'USN or college email', '1NH25MBA014'], mentor: ['Faculty', 'Employee email', 'name@nhsm.edu.in'], admin: ['Main Admin', 'Institutional email', 'placements@nhsm.edu.in'] };
R.screen('public/login', { title: 'Sign in', bare: true, render({ query, st }) {
  const portal = st.portal || 'student';
  const [pw, idLabel, ph] = PORTALS[portal];
  const notes = [];
  if (query.error) notes.push(`<div class="banner risk small" role="alert"${I('A-004')}>${ic('alert', 'sm')}<span>${esc(SSO_ERR[query.error] || `Sign-in refused (“${query.error}”).`)}</span></div>`);
  if (query.signedOut === 'elsewhere') notes.push(`<div class="banner info small"${I('A-016')}>You signed in on another device. REEP keeps one device at a time; the newest sign-in wins.</div>`);
  if (query.verified) notes.push(`<div class="banner ${query.verified === '1' ? 'good' : 'warn'} small"${I('A-017')}>${query.verified === '1' ? 'Email confirmed.' : 'That link has expired.'}</div>`);
  if (st.probeFailed) notes.push(`<div class="banner warn small"${I('A-014')}><span class="grow">Could not reach the server to check how you can sign in.</span><button class="btn sm" type="button" data-act="probe">Try again</button></div>`);
  const pwForm = st.googleOnly ? `<p class="small muted"${I('A-015')}>This server signs in with Google only.</p>` : st.otp ? `
    <form class="stack" data-form="otp" novalidate${I('A-012')}>${U.field({ id: 'code', label: 'Sign-in code', req: true, hint: 'Sent to your email · expires in 10 minutes', attrs: ' inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="letter-spacing:.5em;text-align:center;font-size:22px"' })}
      <button class="btn primary block" type="button" data-act="verify">Verify</button><button class="btn ghost" type="button" data-act="other"${I('A-013')}>Use a different account</button></form>` : `
    <form class="stack" data-form="pw" novalidate>${U.field({ id: 'uid', label: idLabel, req: true, ph, inv: I('A-008'), value: st.remember || '' })}
      <div class="field"${I('A-009')}><label for="pass">Password <span class="req">*</span></label><div class="hrow" style="flex-wrap:nowrap"><input class="input" id="pass" name="pass" type="${st.show ? 'text' : 'password'}" autocomplete="current-password"><button class="icon-btn" type="button" data-act="eye" aria-label="${st.show ? 'Hide password' : 'Show password'}">${ic('eye')}</button></div><div class="err" data-err="pass"></div></div>
      <div class="spread"><label class="check"${I('A-010')}><input type="checkbox" name="remember"${st.remember ? ' checked' : ''}> Remember me</label><button class="btn ghost sm" type="button" data-act="forgot"${I('A-018')}>Forgot password?</button></div>
      <button class="btn primary block" type="button" data-act="signin"${I('A-011')}>Sign in</button></form>`;
  return { title: 'Sign in', html: `<div class="landing" style="max-width:1040px"><div class="grid-2" style="align-items:center;gap:40px">
    <div class="stack-4 login-hero"${I('A-001')}><div class="hrow"><span class="brand-mark">R</span><span class="brand-name">REEP</span></div><h1 style="font-size:34px">Career readiness, opportunities and progress — all in one place.</h1>
      <div class="list">${[['chart', 'Your readiness, from your own record'], ['briefcase', 'Jobs you are eligible for, and why'], ['mic', 'Mock interviews with a scored report']].map(([i, t]) => U.row({ title: t, lead: U.lead(i), chev: false })).join('')}</div></div>
    <div class="card stack-4" style="padding:24px">${notes.join('')}
      <div class="field"><span class="lbl">Choose your portal</span><div${I('A-002')}>${U.seg('portal', [['student', 'Student'], ['mentor', 'Faculty']], portal === 'admin' ? '' : portal)}</div></div>
      <button class="btn block" type="button" data-act="google"${st.googleOff ? ' disabled' : ''}${I('A-005')}>${ic('google')} ${st.connecting ? 'Connecting to Google…' : 'Continue with Google'}</button>
      <p class="xs muted" style="text-align:center;margin-top:-8px"${I('A-006')}>Continues to your ${pw} workspace</p>
      ${st.googleOff ? `<p class="xs" style="color:var(--warn)"${I('A-007')}>Google sign-in is switched off on this server.</p>` : `<span hidden${I('A-007')}></span>`}
      <div class="divider"></div>${pwForm}
      <div class="spread small"><a href="#/public/register"${I('A-019')}>New student? Register →</a><button class="btn ghost sm" type="button" data-act="approved"${I('A-020')}>Already approved? Sign in →</button></div>
      <button class="btn sm${portal === 'admin' ? ' primary' : ''}" type="button" data-act="admin-door" style="border-style:dashed"${I('A-003')}>${ic('shield', 'sm')} Main Admin — open the REEP Admin Console</button>
      <p class="xs muted" style="text-align:center"${I('A-021')}>Can't get in? <a href="#" data-act="forgot">Reset your password</a></p>
      <p class="xs faint" style="text-align:center">Prototype: try <code>?error=sso_not_enrolled</code>, <code>?signedOut=elsewhere</code>. Password <code>wrong</code> fails; anything else asks for a code (use any six digits).</p></div></div></div>` };
}, acts: {
  eye(a, e, st) { st.show = !st.show; App.rerender(); },
  'admin-door'(a, e, st) { st.portal = 'admin'; App.rerender(); document.getElementById('uid').focus(); },
  approved(a, e, st) { st.portal = 'student'; App.rerender(); document.querySelector('[data-act="google"]').focus(); },
  google(a, e, st) { st.connecting = true; App.rerender(); setTimeout(() => R.go('#/student/home'), 700); },
  probe(a, e, st) { st.probeFailed = false; App.rerender(); },
  other(a, e, st) { st.otp = false; App.rerender(); },
  signin(a, e, st) {
    const f = document.querySelector('[data-form="pw"]'); const v = formVals(f); const er = {};
    if (!v.uid) er.uid = 'Enter your ID.'; if (!v.pass) er.pass = 'Enter your password.';
    if (!errs(f, er)) return;
    st.remember = v.remember ? v.uid : '';
    if (v.pass === 'wrong') return errs(f, { pass: 'That ID and password do not match.' });
    st.otp = true; App.rerender();
  },
  verify(a, e, st) { const f = document.querySelector('[data-form="otp"]'); const v = formVals(f); if (!/^\d{6}$/.test(v.code)) return errs(f, { code: 'The code is exactly six digits.' }); st.otp = false; R.go(st.portal === 'admin' ? '#/admin/home' : st.portal === 'mentor' ? '#/faculty/mentees' : '#/student/home'); },
  forgot() {
    Sheet.open({ title: 'Forgot password?', center: true, body: `<div class="stack">${U.field({ id: 'em', label: 'Email address', type: 'email', req: true })}<p class="xs muted">The same answer comes back whether or not the address is on REEP.</p></div>`,
      foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="send">Send reset link</button>`,
      onAct: { send: (b, ev, sh) => { const v = formVals(sh); if (!/^\S+@\S+\.\S+$/.test(v.em)) return errs(sh, { em: 'Enter an email address.' }); sh.querySelector('.sh-b').innerHTML = `<div class="banner good">If that address is on REEP, a link is on its way. It works for one hour.</div>`; b.remove(); } } });
  },
} });

/* ================================================================ Set up your account: three steps on one URL */
R.screen('public/onboard', { title: 'Set up your account', bare: true, render({ query, st }) {
  const step = st.step || 1;
  const wrap = (inner) => ({ title: 'Set up your account', html: `<div class="landing" style="max-width:480px"><div class="hrow" style="margin-bottom:18px"><span class="brand-mark">R</span><span class="brand-name">REEP</span></div><div class="card stack-4" style="padding:24px">${inner}</div></div>` });
  if (query.token === 'expired') return wrap(`<div${I('A-023')}>${U.empty('link', 'This page needs the setup link from the email we sent you', 'The link is missing or has expired.', '<a class="btn" href="#/public/login">Go to sign in</a>')}</div>`);
  const strip = `<div class="steps" aria-hidden="true"${I('A-022')}>${[1, 2, 3].map((n) => `<i class="${n <= step ? 'on' : ''}"></i>`).join('')}</div><p class="xs muted">Step ${Math.min(step, 3)} of 3 · ${['Email', 'Code', 'Password'][Math.min(step, 3) - 1]}</p>`;
  if (step === 1) return wrap(`${strip}<h2>Confirm your college email</h2><form class="stack" novalidate data-f1>${U.field({ id: 'em', label: 'Your college email', type: 'email', req: true, inv: I('A-024'), hint: 'The address this link was sent to.' })}<button class="btn primary block" type="button" data-act="s1">Send me a code</button></form>`);
  if (step === 2) return wrap(`${strip}<h2>Enter the code</h2><form class="stack" novalidate data-f2>${U.field({ id: 'code', label: 'Six-digit code', req: true, inv: I('A-025'), attrs: ' inputmode="numeric" maxlength="6" style="letter-spacing:.5em;text-align:center;font-size:22px"' })}<button class="btn primary block" type="button" data-act="s2">Confirm my email</button><button class="btn ghost" type="button" data-act="resend"${I('A-026')}>Send a new code</button></form>`);
  if (step === 3) return wrap(`${strip}<h2>Choose a password</h2><form class="stack" novalidate data-f3${I('A-027')}>${U.field({ id: 'p1', label: 'Password', type: st.show ? 'text' : 'password', req: true, hint: '12 characters or more' })}${U.field({ id: 'p2', label: 'Type it again', type: st.show ? 'text' : 'password', req: true })}<label class="check"><input type="checkbox" data-act="show"${st.show ? ' checked' : ''}> Show passwords</label><button class="btn primary block" type="button" data-act="s3">Set my password</button></form>`);
  return wrap(`<div${I('A-028')}>${U.empty('check', 'Your password is set', 'Sign in with it at the front door.', '<a class="btn primary" href="#/public/login">Sign in</a>')}</div>`);
}, acts: {
  s1(a, e, st) { const f = document.querySelector('[data-f1]'); const v = formVals(f); if (!/^\S+@nhsm\.edu\.in$/i.test(v.em)) return errs(f, { em: 'Use the college address the link was sent to.' }); st.step = 2; App.rerender(); },
  s2(a, e, st) { const f = document.querySelector('[data-f2]'); const v = formVals(f); if (!/^\d{6}$/.test(v.code)) return errs(f, { code: 'That code is wrong or has expired.' }); st.step = 3; App.rerender(); },
  resend() { toast('A new code is on its way'); },
  show(a, e, st) { st.show = a.checked; App.rerender(); },
  s3(a, e, st) { const f = document.querySelector('[data-f3]'); const v = formVals(f); if (v.p1.length < 12) return errs(f, { p1: 'Use 12 characters or more.' }); if (v.p1 !== v.p2) return errs(f, { p2: 'The two do not match.' }); st.step = 4; App.rerender(); },
} });

/* ================================================================ Activation (staff) and reset: one screen, two modes */
['activate', 'reset'].forEach((mode) => R.screen(`public/${mode}`, { title: mode === 'activate' ? 'Set up your REEP password' : 'Choose a new password', bare: true, render({ query, st }) {
  const title = mode === 'activate' ? 'Set up your REEP password' : 'Choose a new password';
  const inner = query.token === 'expired'
    ? `<div${I(mode === 'activate' ? 'A-030' : 'A-032')}>${U.empty('link', 'This link no longer works', mode === 'activate' ? 'Ask the placement office to send a new one.' : 'Use “Forgot password?” on <a href="#/public/login">the sign-in page</a> again.')}</div>`
    : st.done ? `<div${I(mode === 'activate' ? 'A-030' : 'A-033')}>${U.empty('check', 'Password updated', mode === 'reset' ? 'Every device was signed out.' : '', '<a class="btn primary" href="#/public/login">Sign in</a>')}</div>`
      : `<form class="stack" novalidate data-pf${I(mode === 'activate' ? 'A-029' : 'A-031')}>${U.field({ id: 'p1', label: 'New password', type: 'password', req: true, hint: '12 characters or more' })}${U.field({ id: 'p2', label: 'Type it again', type: 'password', req: true })}<button class="btn primary block" type="button" data-act="set"${I(mode === 'activate' ? 'A-030' : 'A-031')}>${mode === 'activate' ? 'Set password and sign in' : 'Set new password'}</button></form>`;
  return { title, html: `<div class="landing" style="max-width:480px"><div class="hrow" style="margin-bottom:18px"><span class="brand-mark">R</span><span class="brand-name">REEP</span></div><div class="card stack-4" style="padding:24px"><h2>${title}</h2>${inner}</div></div>` };
}, acts: { set(a, e, st) { const f = document.querySelector('[data-pf]'); const v = formVals(f); if (v.p1.length < 12) return errs(f, { p1: 'Use 12 characters or more.' }); if (v.p1 !== v.p2) return errs(f, { p2: 'The two do not match.' }); st.done = true; App.rerender(); } } }));

/* ================================================================ Student application */
const HIER = {
  colleges: [['c1', 'Nandi Hills School of Management'], ['c2', 'Kaveri Institute of Business']],
  depts: { c1: [['d1', 'Management Studies']], c2: [['d2', 'Business Administration']] },
  courses: { d1: [['k1', 'MBA · General MBA'], ['k2', 'MBA-DM · Digital Marketing MBA']], d2: [] },
  specs: { k1: ['Finance', 'Marketing', 'Human Resources', 'Business Analytics'], k2: [] },
  batches: { d1: ['2025-27', '2026-28'], d2: ['2026-28'] },
};
const PUBLIC_MAIL = /@(gmail|yahoo|outlook|hotmail|rediffmail|icloud)\./i;
R.screen('public/register', { title: 'Student registration', bare: true, render({ st }) {
  const v = st.v || {};
  if (st.result) {
    const r = st.result;
    return { title: 'Application sent', html: `<div class="landing" style="max-width:620px"><div class="card stack-4" style="padding:24px">
      ${r.auto ? `<div${I('A-052')}>${U.empty('check', 'A seating rule approved your application.', `Your setup link is on its way to ${esc(r.email)}. You do not have a password yet.`)}</div>` : `<div${I('A-053')}>${U.empty('inbox', 'Held for review.', 'The placement office will decide. You will hear by email either way.')}</div>`}
      <dl class="kv"${I('A-054')}><dt>College</dt><dd>${esc(r.college)}</dd><dt>Department</dt><dd>${esc(r.dept)}</dd><dt>Course</dt><dd>${esc(r.course || '—')}</dd><dt>Specialization</dt><dd>${esc(r.specs.join(' and ') || '—')}</dd><dt>Batch</dt><dd>${esc(r.batch)}</dd></dl>
      <p class="small"${I('A-055')}>${chip('CV and photo received', 'good')} Your CV and photo came with the application.</p>
      <div class="hrow"><a class="btn primary" href="#/public/login"${I('A-056')}>Continue to sign in</a><button class="btn" type="button" data-act="again"${I('A-057')}>Submit another</button></div></div></div>` };
  }
  const depts = HIER.depts[v.college] || []; const courses = HIER.courses[v.dept] || []; const specs = HIER.specs[v.course] || []; const batches = HIER.batches[v.dept] || [];
  const picked = v.specs || [];
  return { title: 'Student registration', html: `<div class="landing" style="max-width:760px"><div class="hrow" style="margin-bottom:12px"><span class="brand-mark">R</span><span class="brand-name">REEP</span></div><h1>Apply to REEP</h1>
    <p class="lede muted" style="margin:6px 0 16px"${I('A-034')}>Every box marked <span class="req" style="color:var(--risk)">*</span> is required — everything except Specialization.</p>
    <form class="stack-4" novalidate data-reg>
      ${st.err ? `<div class="banner risk small" role="alert"${I('A-049')}>${esc(st.err)}</div>` : `<span hidden${I('A-049')}></span>`}
      <div class="card stack"><h2>You</h2><div class="form-grid">
        ${U.field({ id: 'name', label: 'Full name', req: true, value: v.name, inv: I('A-036') })}${U.field({ id: 'usn', label: 'USN', req: true, value: v.usn, ph: '1NH25MBA014', inv: I('A-037') })}
        ${U.field({ id: 'email', label: 'College email', type: 'email', req: true, value: v.email, ph: 'you@nhsm.edu.in', inv: I('A-038'), attrs: ' autocomplete="off"' })}${U.field({ id: 'pemail', label: 'Personal email', type: 'email', req: true, value: v.pemail, inv: I('A-039') })}
        ${U.field({ id: 'phone', label: 'Phone', type: 'tel', req: true, value: v.phone, inv: I('A-040') })}${U.field({ id: 'li', label: 'LinkedIn profile', type: 'url', req: true, value: v.li, ph: 'linkedin.com/in/…', inv: I('A-041') })}</div></div>
      <div class="card stack"><h2>Where you study</h2><div class="form-grid">
        ${U.field({ id: 'college', label: 'College', req: true, opts: [['', 'Choose a college'], ...HIER.colleges], value: v.college, inv: I('A-042') })}
        ${U.field({ id: 'dept', label: 'Department', req: true, opts: [['', v.college ? 'Choose a department' : 'Choose a college first'], ...depts], value: v.dept, inv: I('A-043'), attrs: v.college ? '' : ' disabled' })}
        ${U.field({ id: 'course', label: 'Course', req: courses.length > 0, opts: [['', courses.length ? 'Choose a course' : 'No courses listed'], ...courses], value: v.course, inv: I('A-044'), attrs: courses.length ? '' : ' disabled' })}
        ${U.field({ id: 'batch', label: 'Batch', req: batches.length > 0, opts: [['', 'Choose a year'], ...batches], value: v.batch, inv: I('A-046') })}
        ${U.field({ id: 'level', label: 'Degree level', req: true, opts: [['PG', 'Postgraduate'], ['UG', 'Undergraduate']], value: v.level || 'PG', inv: I('A-047') })}</div>
        <div class="field"${I('A-045')}><span class="lbl">Specialization <span class="muted">(one, or two for a dual)</span></span>${specs.length ? `<div class="hrow">${specs.map((s) => `<label class="check" style="padding-right:12px"><input type="checkbox" data-act="spec" value="${s}"${picked.includes(s) ? ' checked' : ''}${!picked.includes(s) && picked.length >= 2 ? ' disabled' : ''}> ${s}</label>`).join('')}</div>` : '<p class="small muted">None listed for this course.</p>'}</div></div>
      <div class="card stack"><h2>Files</h2><div class="grid-2">
        <div class="field"><span class="lbl">Attach your CV <span class="req">*</span></span>${U.drop('cv', st.cv ? 'Change file' : 'Choose file', 'PDF only · up to 10 MB', I('A-035'))}<div class="err" data-err="cv"></div></div>
        <div class="field"><span class="lbl">Professional photo <span class="req">*</span></span>${U.drop('photo', st.photo ? 'Change file' : 'Upload a headshot', 'PNG or JPG · up to 10 MB', I('A-048'))}<div class="err" data-err="photo"></div></div></div></div>
      <div class="sticky-act" style="bottom:12px"><a class="btn" href="#/public/login"${I('A-051')}>Already registered? Sign in</a><button class="btn primary" type="button" data-act="submit"${I('A-050')}>Submit registration</button></div>
    </form></div>` };
}, acts: {
  'change:cv'(a, e, st) { st.cv = a.files[0]; }, 'change:photo'(a, e, st) { st.photo = a.files[0]; },
  spec(a, e, st) { const f = document.querySelector('[data-reg]'); st.v = { ...st.v, ...formVals(f) }; const p = new Set(st.v.specs || []); a.checked ? p.add(a.value) : p.delete(a.value); st.v.specs = [...p]; App.rerender(); },
  again(a, e, st) { for (const k in st) delete st[k]; App.rerender(); },
  submit(a, e, st) {
    const f = document.querySelector('[data-reg]'); const v = { ...st.v, ...formVals(f) }; st.v = v; const er = {};
    ['name', 'usn', 'email', 'pemail', 'phone', 'li', 'college', 'dept'].forEach((k) => { if (!v[k]) er[k] = 'Required.'; });
    if (v.email && PUBLIC_MAIL.test(v.email)) er.email = 'Use your college address, not a personal mailbox.';
    if (v.email && v.email.toLowerCase() === (v.pemail || '').toLowerCase()) er.pemail = 'Must differ from your college email.';
    if (v.li && !/^(https?:\/\/)?((www|in|m)\.)?(linkedin\.com|lnkd\.in)\//i.test(v.li)) er.li = 'Paste your LinkedIn profile address.';
    if ((HIER.courses[v.dept] || []).length && !v.course) er.course = 'Required.';
    if ((HIER.batches[v.dept] || []).length && !v.batch) er.batch = 'Required.';
    const cv = st.cv, ph = st.photo;
    if (!cv) er.cv = 'Attach your CV.'; else if (cv.type !== 'application/pdf' || cv.size > 10485760) er.cv = `${cv.name} (${Math.ceil(cv.size / 1024)} kB) is not a PDF up to 10 MB.`;
    if (!ph) er.photo = 'Add a photo.'; else if (!/image\/(png|jpeg)/.test(ph.type) || ph.size > 10485760) er.photo = `${ph.name} is not a PNG or JPG up to 10 MB.`;
    if (Object.keys(er).length) { st.err = `Fix ${Object.keys(er).length} item${Object.keys(er).length > 1 ? 's' : ''}: ${Object.keys(er).map((k) => ({ li: 'LinkedIn', pemail: 'personal email', cv: 'CV', photo: 'photo' }[k] || k)).join(', ')}.`; App.rerender(); return errs(document.querySelector('[data-reg]'), er); }
    const nm = (list, id) => (list.find((x) => x[0] === id) || [, ''])[1];
    st.result = { auto: v.dept === 'd1', email: v.email, college: nm(HIER.colleges, v.college), dept: nm(HIER.depts[v.college], v.dept), course: nm(HIER.courses[v.dept] || [], v.course), specs: v.specs || [], batch: v.batch || '—' };
    App.rerender();
  },
} });
