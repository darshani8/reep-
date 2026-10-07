/* REEP v5 prototype — what every role shares: the assistant dock (Ask REEP +
   Mock interview), the full-page agent, the interview room, and Account. */
'use strict';

/* ================================================================ Ask REEP chat */
/* @screen {role}/agent REEP Agent (and the dock's Ask REEP tab) */
const Chat = {
  log: [], pending: false, feedback: {},
  starters: ['What should I complete this week?', 'Am I placement-ready?', 'Show jobs I qualify for'],
  answer(q) {
    const r = App.role;
    if (/job/i.test(q)) return { text: 'Two open roles match your profile: Credit Analyst at Kaveri Finance (82% match, closes in 3 days) and Management Trainee — Sales (applied).', actions: [['Open Jobs', '#/student/jobs', 'shows eligibility and match']], src: 'Jobs board', lim: 'Eligibility is computed from your verified record only.' };
    if (/ready/i.test(q)) return { text: 'Your readiness is 68 / 100, On track. The weakest factor is certification completion.', actions: [['Open Documents', '#/student/uploads', 'upload the certificate']], src: 'Readiness', lim: '' };
    if (/leave|pending|queue/i.test(q) && r !== 'student') return { text: 'Three leave requests and four applications are waiting.', actions: [['Leave requests', '#/admin/leave-approvals', 'the queue']], src: 'Console counts', lim: '' };
    return { text: 'This week: finish the Speaking section of your English baseline and log the last two days of your time ledger before they lock.', actions: [['Time log', '#/student/time-log', 'two days open']], src: 'Placement policy', lim: 'The agent does not see your marks or attendance.' };
  },
  html(full) {
    const r = App.role;
    const rail = r === 'admin' && full ? `<aside class="card flat small"${I('A-118')}><h3>What the agent can see</h3><dl class="kv" style="margin-top:8px"><dt>Signed in as</dt><dd>Main Admin</dd><dt>Functions</dt><dd>${['admin.analytics', 'admin.registrations', 'admin.students'].map((k) => chip(k, 'info')).join(' ')}</dd><dt>Records</dt><dd>Programme counts</dd><dt>Never</dt><dd>Marks, USN, transcripts</dd><dt>This screen sends</dt><dd>Your question only</dd><dt>Rule 1</dt><dd>${chip('Not reported yet', 'neutral')}</dd></dl></aside>` : '';
    const msgs = this.log.length ? this.log.map((m, i) => m.me
      ? `<div class="bubble me">${esc(m.text)}${m.state ? `<div class="xs" style="opacity:.8">${chip(m.state, 'risk')}</div>` : ''}</div>`
      : `<div class="bubble ai"><p>${esc(m.text)}</p>${m.actions.map(([t, to, why]) => `<a class="small" href="${to}" style="display:block;margin-top:6px"${I('A-121')}>→ ${esc(t)} · <span class="muted">${esc(why)}</span></a>`).join('')}
          <div class="hrow" style="margin-top:8px">${chip('Source: ' + m.src, m.src === 'Placement policy' ? 'info' : 'neutral', I('A-122'))}</div>${m.lim ? `<p class="xs muted" style="margin-top:6px"${I('A-123')}>${esc(m.lim)}</p>` : ''}
          <div class="hrow" style="margin-top:6px"><button class="btn sm ghost" type="button" data-act="chat-copy" data-i="${i}"${I('A-124')}>${m.copied ? 'Copied' : 'Copy'}</button>${this.feedback[i] ? `<span class="xs muted"${I('A-125')}>Thanks for the feedback</span>` : ['Helpful', 'Not helpful', 'Report'].map((f) => `<button class="btn sm ghost" type="button" data-act="chat-fb" data-i="${i}" data-v="${f}"${I('A-125')}>${f}</button>`).join('')}</div></div>`).join('')
      : `<div${I('A-127')}>${U.empty('sparkle', 'How can I help today?', '', `<div class="hrow" style="justify-content:center">${this.starters.map((s) => `<button class="btn sm" type="button" data-act="chat-send" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`)}</div>`;
    return `<div class="${rail ? 'split' : ''}" style="${rail ? 'grid-template-columns:1fr 300px' : ''}"><div class="stack">
      <div class="banner info small"${I('A-117')}>${r === 'student' ? 'The agent does not see your marks or attendance. For those, ask your mentor.' : 'The agent answers from policy and programme counts, never from a student’s private record.'}</div>
      <div class="chat" role="log" aria-live="polite"${I('A-119', 'A-120')}>${msgs}${this.pending ? `<div class="bubble ai"${I('A-126')}><span class="skel" style="display:inline-block;width:60px;height:10px"></span></div>` : ''}</div>
      ${this.err ? `<div class="banner risk small" role="alert"${I('A-131')}>${esc(this.err)}</div>` : ''}
      <div class="filters"${I('A-128')}>${this.starters.map((s) => `<button class="btn sm" type="button" data-act="chat-send" data-q="${esc(s)}"${this.pending ? ' disabled' : ''}>${esc(s)}</button>`).join('')}</div>
      <form class="hrow" data-chat style="flex-wrap:nowrap" onsubmit="event.preventDefault();Chat.send(this.q.value)"><textarea class="input" name="q" rows="1" placeholder="Message the REEP Agent…" aria-label="Message"${I('A-129')} onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Chat.send(this.value)}" oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,160)+'px'" style="min-height:44px"></textarea>
        ${this.pending ? `<button class="btn" type="button" data-act="chat-stop"${I('A-130')}>Stop</button>` : `<button class="btn primary" type="submit"${I('A-130')}>${ic('send', 'sm')}<span class="sr">Send</span></button>`}</form>
      <div class="spread xs muted"${I('A-132')}><span>${r === 'student' ? 'Your marks live in <a href="#/student/records">your records</a>.' : ''}</span><button class="btn sm ghost" type="button" data-act="chat-clear"${this.log.length ? '' : ' disabled'}${I('A-116')}>Clear conversation</button></div>
    </div>${rail}</div>`;
  },
  send(q) {
    q = (q || '').trim(); if (!q || this.pending) return;
    if (this.log.filter((m) => m.me).length >= 12) { this.err = 'You have asked a lot in the last minute. Try again shortly.'; return this.refresh(); }
    this.err = ''; this.log.push({ me: true, text: q }); this.pending = true; this.refresh();
    this.timer = setTimeout(() => { this.pending = false; this.log.push({ ...this.answer(q) }); this.refresh(); }, 700);
  },
  refresh() { if (Dock.el && Dock.tab === 'ask') Dock.paint(); if (App.cur && /\/agent$/.test(App.cur.key)) App.rerender(); },
  acts: {
    'chat-send': (a) => Chat.send(a.dataset.q),
    'chat-stop': () => { clearTimeout(Chat.timer); Chat.pending = false; const last = Chat.log.at(-1); if (last && last.me) last.state = 'Stopped'; Chat.refresh(); },
    'chat-clear': () => { Chat.log = []; Chat.feedback = {}; Chat.refresh(); },
    'chat-copy': (a) => { const m = Chat.log[+a.dataset.i]; navigator.clipboard?.writeText(m.text).catch(() => {}); m.copied = true; Chat.refresh(); },
    'chat-fb': (a) => { Chat.feedback[a.dataset.i] = a.dataset.v; Chat.refresh(); },
  },
};

/* ================================================================ Interview room */
/* @screen student/assistant Mock interview (and the dock's Mock interview tab) */
const TRACKS = [['general', 'General'], ['hr', 'HR'], ['dm', 'Marketing'], ['ba', 'Analytics'], ['fa', 'Finance']];
const PHASES = ['Opening', 'Probing', 'Deep dive', 'Wrap-up'];
const Room = {
  s: { track: 'fa', route: 'Speaker', state: 'Not connected', phase: -1, secs: 0, lines: [], report: null, consent: null, notice: '' },
  policy: { transcript: true, audio: false, retention: 180, daily: 8, attempts: 20, serverRec: true },
  live() { return ['Connecting…', 'Listening', 'Thinking…', 'Interviewer speaking'].includes(this.s.state); },
  html() {
    const r = App.role;
    if (r === 'faculty') return `<div class="banner info"${I('A-137')}>Mock interviews are a student feature.</div>`;
    const s = this.s; const p = this.policy;
    const rec = p.audio && p.serverRec ? 'recording on' : 'recording off';
    const tone = { 'Not connected': 'neutral', 'Connecting…': 'info', Listening: 'good', 'Thinking…': 'warn', 'Interviewer speaking': 'info', 'Interview ended': 'neutral', Problem: 'risk' }[s.state];
    const mm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    return `<div class="stack">
      ${r === 'admin' ? `<div class="banner warn small"${I('A-138')}><b>Rehearsal.</b>&nbsp;The interview runs as a student's would, and nothing is stored.</div>` : ''}
      ${location.protocol === 'http:' && !/localhost|127\.0/.test(location.hostname) ? `<div class="banner risk small" role="alert"${I('A-139')}>The microphone needs a secure (https) page.</div>` : `<span hidden${I('A-139')}></span>`}
      ${s.notice ? `<div class="banner risk small" role="alert"${I('A-143')}><span class="grow">${esc(s.notice)}</span><button class="btn sm ghost" type="button" data-act="room-dismiss">Dismiss</button></div>` : ''}
      <div class="stage-dark">
        <div class="spread small"><span${I('A-144')}><b>Ms. Kavya Raman</b> · ${TRACKS.find((t) => t[0] === s.track)[1]} round · Tier-1 MNC campus bar</span><span class="num"${I('A-146')}>${mm(s.secs)} / 08:00</span></div>
        <div class="hrow" style="justify-content:center;margin-top:12px"${I('A-145')}>${PHASES.map((ph, i) => `<span class="chip ${i < s.phase ? 'good' : i === s.phase ? 'info' : 'neutral'}" style="background:rgba(255,255,255,${i === s.phase ? '.9' : '.15'});color:${i === s.phase ? 'var(--brand-purple)' : '#fff'}">${ph}</span>`).join('')}</div>
        <div class="orb${this.live() ? ' live' : ''}"></div>
        <span class="chip ${tone}" style="background:#fff"${I('A-147')}>${s.state}</span>
        <p style="margin-top:12px;min-height:44px"${I('A-148')}>${esc(s.lines.filter((l) => l.who === 'Interviewer').at(-1)?.text || (s.state === 'Not connected' ? 'Pick a round, then press Start when you are ready.' : ''))}</p>
        ${s.state === 'Thinking…' ? `<div style="max-width:220px;margin:6px auto"${I('A-149')}>${U.meter(60)}<span class="xs">Writing your scorecard · 4 s</span></div>` : ''}
        ${this.live() ? `<div style="max-width:220px;margin:10px auto"${I('A-155')}>${U.meter(35 + (s.secs * 17) % 50, 'good')}</div><div class="xs"${I('A-156')}>${TRACKS.find((t) => t[0] === s.track)[1]} round</div>` : ''}
      </div>
      ${this.live() ? `<button class="btn danger solid block" type="button" data-act="room-end"${I('A-157')}>End interview</button>` : `
      <div class="field"><span class="lbl">Round</span><div${I('A-150')}>${U.seg('room-track', TRACKS, s.track)}</div><p class="xs muted"${I('A-151')}>${s.track === 'general' ? 'General has no wrap-up, so it is never scored.' : 'Preselected from your batch. Ends with a verdict and a scorecard.'}</p></div>
      <div class="field"><span class="lbl">Audio</span><div${I('A-152')}>${U.seg('room-route', ['Speaker', 'Earphones'], s.route)}</div></div>
      <button class="btn primary block" type="button" data-act="room-start"${I('A-153')}>${ic('mic', 'sm')} Start interview</button>
      ${s.consent ? `<div class="spread xs muted"${I('A-154')}><span>Terms accepted ${fmtShort(s.consent)} · ${rec}</span><button class="btn sm ghost" type="button" data-act="room-consent">Read again</button></div>` : ''}`}
      ${s.report ? `<div class="card"${I('A-158')}><div class="card-h"><h2>Practice report</h2>${chip(r === 'admin' ? 'Not saved anywhere' : 'Saved to your past interviews', r === 'admin' ? 'neutral' : 'good')}</div><div class="grid-3">${Object.entries(s.report).map(([k, v]) => U.kpi(v ?? '—', k)).join('')}</div></div>` : ''}
      <div class="card"${I('A-159')}><h3 style="margin-bottom:8px">Transcript</h3>${s.lines.length ? `<div class="chat" role="log">${s.lines.map((l) => `<div class="bubble ${l.who === 'You' ? 'me' : 'ai'}"><b class="xs">${l.who}</b><br>${esc(l.text)}</div>`).join('')}</div>` : '<p class="small muted">The conversation appears here as you speak.</p>'}</div>
    </div>`;
  },
  consentSheet(after) {
    const p = this.policy;
    Sheet.open({ title: 'Before you start', body: `<div class="stack small"${I('A-140')}>
      <p><b>1 · It hears you live.</b> Your voice goes to the interview model while you speak.</p>
      <p><b>2 · What your college keeps.</b> ${p.transcript ? `The transcript and the report, for ${p.retention} days. Your mentor and the office can read them.` : 'The report only; no transcript.'}</p>
      <p><b>3 · Recording.</b> ${p.audio ? 'A voice recording is kept; staff can listen.' : 'No voice recording is kept.'}</p>
      ${p.serverRec ? '' : `<p class="banner warn"${I('A-142')}>Recording is switched off on this server.</p>`}
      <p><b>4 · How many.</b> Up to ${p.daily} completed interviews a day, ${p.attempts} attempts.</p></div>${p.serverRec ? `<span hidden${I('A-142')}></span>` : ''}`,
      foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn primary" type="button" data-act="agree"${I('A-141')}>I agree — start the interview</button>`,
      onAct: { agree: () => { this.s.consent = TODAY; this.s.consentScope = p.audio; Sheet.close(); after && after(); } } });
  },
  start() {
    const s = this.s;
    if (App.role === 'student' && (!s.consent || s.consentScope !== this.policy.audio)) return this.consentSheet(() => this.start());
    Object.assign(s, { state: 'Connecting…', phase: 0, secs: 0, lines: [], report: null, notice: '' });
    Dock.liveSince = Date.now();
    const script = [
      ['Interviewer', 'Good morning. Tell me about yourself and why finance.'], ['You', 'I am an MBA finance student; my internship was in credit analysis at a regional NBFC.'],
      ['Interviewer', 'Walk me through how you would assess a mid-size borrower.'], ['You', 'Start with cash flows, then leverage and the collateral cover…'],
      ['Interviewer', 'If rates rise 200 basis points, what happens to that borrower?'], ['You', 'Interest cover falls; I would stress test the DSCR.'],
      ['Interviewer', 'Any questions for us?'], ['You', 'What does the first year look like for an analyst?'],
    ];
    let i = 0;
    this.t = setInterval(() => {
      s.secs += 3;
      if (s.state === 'Connecting…') s.state = 'Interviewer speaking';
      else if (i < script.length) { const [who, text] = script[i++]; s.lines.push({ who, text }); s.state = who === 'You' ? 'Interviewer speaking' : 'Listening'; s.phase = Math.min(3, Math.floor(i / 2)); }
      else { this.finish(); return; }
      this.refresh();
    }, 1100);
    this.refresh();
  },
  finish() { clearInterval(this.t); const s = this.s; s.state = 'Thinking…'; this.refresh(); setTimeout(() => { s.state = 'Interview ended'; s.phase = 4; s.report = s.track === 'general' ? null : { Overall: 68, Communication: 72, Domain: 66, Structure: null }; Dock.liveSince = null; this.refresh(); }, 1200); },
  refresh() { if (Dock.el && Dock.tab === 'room') Dock.paint(); if (App.cur && App.cur.key === 'student/assistant') App.rerender(); Dock.paintOrb(); },
  acts: {
    'room-start': () => Room.start(),
    'room-end': () => { clearInterval(Room.t); Room.s.state = 'Interview ended'; Room.s.notice = ''; Dock.liveSince = null; Room.finish(); },
    'room-consent': () => Room.consentSheet(),
    'room-dismiss': () => { Room.s.notice = ''; Room.refresh(); },
  },
};

/* ================================================================ Dock */
/* @screen dock Assistant dock */
const Dock = {
  el: null, tab: 'ask', liveSince: null,
  open() {
    if (this.el) return;
    const canRoom = App.role === 'student' || App.role === 'admin';
    this.el = Sheet.open({ title: 'REEP assistant', wide: true, body: '<div data-dock></div>',
      foot: `<a class="btn" data-dock-page href="#"${I('A-111')}>Open as a page</a>`,
      onAct: { ...Chat.acts, ...Room.acts, 'seg:dock-tab': (a) => { this.tab = a.dataset.v; this.paint(); }, 'seg:room-track': (a) => { Room.s.track = a.dataset.v; this.paint(); }, 'seg:room-route': (a) => { Room.s.route = a.dataset.v; this.paint(); } },
      onClose: () => { this.el = null; } });
    this.el.setAttribute('aria-label', 'REEP assistant');
    this.el.querySelector('.sh-h').insertAdjacentHTML('afterend', canRoom ? `<div style="padding:0 16px 8px"${I('A-110')}>${U.seg('dock-tab', [['ask', 'Ask REEP'], ['room', Room.live() ? 'Mock interview · Live' : 'Mock interview']], this.tab)}</div>` : '');
    const close = this.el.querySelector('[data-sheet-close]'); close.setAttribute('data-inv', 'A-112');
    close.removeAttribute('data-sheet-close'); close.addEventListener('click', () => this.requestClose());
    if (!canRoom) this.tab = 'ask';
    this.paint();
  },
  requestClose() {
    if (!Room.live()) return Sheet.close();
    Sheet.open({ title: 'An interview is running. Closing ends it.', center: true, body: `<p${I('A-113')}>The answers so far are kept; the report is written from them.</p>`,
      foot: `<button class="btn" type="button" data-sheet-close>Keep going</button><button class="btn danger solid" type="button" data-act="end">End and close</button>`,
      onAct: { end: () => { Sheet.close(); Room.acts['room-end'](); Sheet.close(); } } });
  },
  paint() {
    if (!this.el) return;
    const box = this.el.querySelector('[data-dock]');
    box.innerHTML = App.sim === 'error' ? `<div${I('A-114')}>${U.empty('alert', 'The assistant did not load', 'A new version was deployed.', '<button class="btn primary" type="button" onclick="location.reload()">Reload REEP</button>')}</div>` : this.tab === 'room' ? Room.html() : Chat.html(false);
    this.el.querySelector('[data-dock-page]').href = this.tab === 'room' ? '#/student/assistant' : `#/${App.role}/agent`;
    const t = box.querySelector('textarea'); if (t && this.tab === 'ask') t.focus({ preventScroll: true });
  },
  paintOrb() {
    const fab = document.querySelector('.fab'); if (!fab) return;
    let b = fab.querySelector('.live'); if (!b && this.liveSince) { fab.insertAdjacentHTML('beforeend', `<span class="live chip risk" style="position:absolute;top:-8px;right:-10px;background:#fff"${I('A-108')}>Live</span>`); }
    if (b && !this.liveSince) b.remove();
  },
};
document.addEventListener('click', (e) => { if (e.target.closest('[data-dock-page]')) Sheet.closeAll(); });

/* ================================================================ Agent pages + room page */
['student', 'faculty', 'admin'].forEach((role) => R.screen(`${role}/agent`, { title: 'REEP Agent', render() {
  return U.page({ title: 'REEP Agent', back: true, acts: '', body: `<div${I('A-115')}>${Chat.html(true)}</div>` });
}, acts: Chat.acts }));

R.screen('student/assistant', { title: 'Mock interview', render() {
  const saved = App.s('student/assistant').saved;
  return U.page({ title: 'Mock interview', back: true, lede: `<span${I('A-133')}>A Tier-1 multinational's campus round, out loud.</span>`,
    acts: `<button class="btn sm" type="button" data-act="clear-saved"${Room.s.lines.length ? '' : ' disabled'}${I('A-134')}>Clear conversation</button>`,
    body: `<div class="split" style="grid-template-columns:minmax(0,1fr) 340px"><div>${Room.html()}</div><div class="stack">
      <div class="card flat small"${I('A-135')}>The interviewer never sees your marks, attendance or USN. Your <a href="#/student/records">records</a> and <a href="#/student/interviews">past interviews</a> are separate.</div>
      <div class="card flat"${I('A-136')}><button class="btn sm ghost" type="button" data-act="toggle-saved">${saved ? 'Hide' : 'Show'} saved conversation (${Room.s.lines.length})</button>${saved ? (Room.s.lines.length ? Room.s.lines.map((l) => `<p class="small"><b>${l.who}:</b> ${esc(l.text)}</p>`).join('') : '<p class="small muted">Nothing saved yet. Finish an interview and it appears here.</p>') : ''}</div></div></div>` });
}, acts: { ...Room.acts, 'clear-saved': () => { Room.s.lines = []; App.rerender(); }, 'toggle-saved': (a, e, st) => { st.saved = !st.saved; App.rerender(); } },
mount() { /* the round and audio segs write view state; mirror them into the room */
  const st = App.s('student/assistant'); if (st['room-track']) Room.s.track = st['room-track']; if (st['room-route']) Room.s.route = st['room-route'];
} });

/* ================================================================ Account (all roles) */
/* @screen {role}/account Account & security */
const Acct = { codeSent: false, unlinkAsk: false, everyAsk: false, sigAsk: false };
function accountScreen(role) {
  const me = D.me[role];
  const roleWord = { student: 'Student', faculty: 'Faculty', admin: 'Main Admin' }[role];
  const sig = D.signature[role];
  const hasPw = role !== 'student' || D.me.student.hasPassword !== false;
  const google = `<div class="list">${U.row({ title: 'Google', sub: me.googleLinked ? 'You can sign in with Google.' : 'Not linked to this account.', lead: U.lead('google'), chev: false, trail: chip(me.googleLinked ? 'Linked' : 'Not linked', me.googleLinked ? 'good' : 'neutral', I('A-061')) + (me.googleLinked ? `<button class="btn sm danger" type="button" data-act="unlink"${I('A-062')}>Unlink</button>` : '') })}</div>`;
  const pw = `<div class="list"${I('A-063')}>${hasPw ? U.row({ title: 'Password', sub: '12 characters or more · REEP does not record when it last changed', lead: U.lead('key'), act: 'pw', inv: I('A-069', 'A-082') }) : U.row({ title: 'No password yet', sub: 'Sign in with Google, or set a password through the emailed setup walk.', lead: U.lead('key'), trail: `<span class="btn sm"${I('A-085')}>Email me a setup link</span>`, act: 'setup-link', chev: false, inv: I('A-064') })}</div>`;
  const sess = `<div class="list"${I('A-070')}>${U.row({ title: `Signed in as ${esc(me.name)} · ${roleWord}`, sub: 'One device at a time: signing in elsewhere signs this one out.', lead: U.lead('globe'), chev: false, trail: chip('This device', 'info') })}${U.row({ title: 'Sign out everywhere', sub: 'Ends every session, this one included.', lead: U.lead('logout'), act: 'everywhere', inv: I('A-071') })}${U.row({ title: 'Sign out', lead: U.lead('logout'), act: 'signout', chev: false, inv: I('A-059') })}</div>`;
  const sigCard = role === 'student' ? '' : U.section('Signature', `<div class="card"${I('A-072', 'B-202')}>${sig.on ? `<div class="spread"><div class="card flat" style="padding:10px 16px;font-family:cursive;font-size:24px;color:var(--ink)"${I('A-073')}>${esc(me.name.replace(/^Dr\. /, ''))}</div><div class="hrow"><label class="btn sm"${I('A-074', 'B-204')}>Replace<input type="file" accept="image/png,image/jpeg" class="sr" data-act-change="sig" data-f="sig"></label><button class="btn sm danger" type="button" data-act="sig-remove"${I('A-075', 'B-205')}>Remove…</button></div></div><p class="xs muted" style="margin-top:8px">On file since ${fmtDate(sig.since)} · ${sig.size} · ${sig.kind} · printed on every leave paper you apply on or sanction.</p>`
    : `<div${I('A-076', 'B-203')}>${U.empty('sign', 'No signature on file', 'Leave papers show your name and the time instead.', `<label class="btn primary"${I('A-074')}>Upload signature<input type="file" accept="image/png,image/jpeg" class="sr" data-act-change="sig" data-f="sig"></label>`)}</div>`}<div class="xs" role="status" data-sigmsg${I('B-206')}></div></div>`);
  const prefs = U.section('Email notifications', `<div class="list"${I('A-077')}>${D.notifPrefs.map((p) => U.row({ title: p.label, chev: false, trail: `${chip(p.enforced ? (p.on ? 'On' : 'Off') : 'Not wired yet', p.enforced ? (p.on ? 'good' : 'neutral') : 'neutral')}<input class="switch" type="checkbox" aria-label="${esc(p.label)}" data-act="pref" data-k="${p.key}"${p.on ? ' checked' : ''}${p.enforced ? '' : ' disabled'}>` })).join('')}</div><p class="xs muted" style="margin:6px 4px"${I('A-078')}>REEP sends no digests.</p>`);
  const signIns = U.section('Recent sign-ins', D.signIns.length ? U.table([{ h: 'When', k: 'when' }, { h: 'Door', k: 'door' }, { h: 'Device', k: 'device' }, { h: 'Seen from', k: 'from' }], D.signIns, I('A-079')) : `<div${I('A-081')}>${U.empty('globe', 'No sign-ins recorded yet')}</div>`, `<button class="btn sm ghost" type="button" data-act="refresh"${I('A-080')}>Refresh</button>`);
  return U.page({ title: 'Account & security', lede: `<span${I('A-058')}>${roleWord} · ${esc(me.email)}</span>`,
    body: `${U.section('Sign-in', google + '<div style="height:10px"></div>' + pw).replace('class="section"', 'class="section" style="margin-top:0"')}${sigCard}${U.section('Sessions', sess)}${prefs}${signIns}` });
}
/* @screen {role}/account Account & security › Change password sheet */
function pwSheet() {
  let sent = false;
  const body = () => `<div class="steps"${I('A-065')}><i class="on"></i><i class="${sent ? 'on' : ''}"></i></div>
    ${sent ? `<div class="stack"${I('A-067', 'A-083', 'A-086')}>${U.field({ id: 'code', label: 'Code from the email', req: true, attrs: ' inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })}${U.field({ id: 'pw1', label: 'New password', type: 'password', req: true, hint: '12 characters or more' })}${U.field({ id: 'pw2', label: 'Type it again', type: 'password', req: true })}</div>`
    : `<p>We email a six-digit code to the address on this account, never to one you type.</p>`}`;
  const el = Sheet.open({ title: 'Change password', center: true, body: body(),
    foot: `<button class="btn" type="button" data-sheet-close${I('A-068')}>Cancel</button><button class="btn" type="button" data-act="resend"${I('A-084')}>Send a new code</button><button class="btn primary" type="button" data-act="go"${I('A-066')}>Email me a code</button>`,
    onAct: {
      resend: () => { sent = true; toast('A new code is on its way. The old one no longer works.'); },
      go: (a, e, sh) => {
        if (!sent) { sent = true; sh.querySelector('.sh-b').innerHTML = body(); a.textContent = 'Change password'; return toast('Code sent'); }
        const v = formVals(sh); const er = {};
        if (!/^\d{6}$/.test(v.code)) er.code = 'The code is six digits.';
        if (v.pw1.length < 12) er.pw1 = 'Use 12 characters or more.';
        else if (v.pw1 !== v.pw2) er.pw2 = 'The two do not match.';
        if (!errs(sh, er)) return;
        Sheet.close(); toast('Password changed. Other devices are signed out.');
      } } });
  return el;
}
['student', 'faculty', 'admin'].forEach((role) => {
  R.screen(`${role}/account`, { title: 'Account & security', states: 'A-060', render: () => accountScreen(role), acts: {
    unlink() { Sheet.confirm({ title: 'Unlink Google?', text: 'You will sign in with your password or an emailed code instead.', ok: 'Yes, unlink', danger: true, onOk: () => { D.me[role].googleLinked = false; App.rerender(); toast('Google unlinked'); } }); },
    pw() { pwSheet(); },
    'setup-link'() { toast('Setup link sent to your college address'); },
    everywhere() { Sheet.confirm({ title: 'Sign out everywhere?', text: 'Every session ends, including this one.', ok: 'Yes, sign out everywhere', danger: true, onOk: () => Actions.signout() }); },
    signout() { Actions.signout(); },
    refresh() { toast('Up to date'); },
    pref(a) { const p = D.notifPrefs.find((x) => x.key === a.dataset.k); p.on = a.checked; App.rerender(); toast(`${p.label}: ${p.on ? 'On' : 'Off'}`); },
    'sig-remove'() { Sheet.confirm({ title: 'Remove your signature?', text: 'Leave papers will show your name and the time only.', ok: 'Yes, remove it', danger: true, onOk: () => { D.signature[role] = { on: false }; App.rerender(); } }); },
    'change:sig'(input) { const f = input.files[0]; const box = document.querySelector('[data-sigmsg]'); if (!f) return; if (!/image\/(png|jpeg)/.test(f.type) || f.size > 2 * 1024 * 1024) { box.className = 'xs err'; box.textContent = 'Use a PNG or JPEG under 2 MB.'; return; } D.signature[role] = { on: true, since: TODAY, size: `${Math.ceil(f.size / 1024)} kB`, kind: f.type === 'image/png' ? 'PNG' : 'JPEG' }; App.rerender(); toast('Signature saved'); },
  } });
});
// The old /account/password and /mentor/signature doors are the same screen now.
R.screen('student/password', { title: 'Password', render: () => { setTimeout(() => R.go('#/student/account'), 0); return ''; } });
R.screen('faculty/signature', { title: 'Signature', render: () => { setTimeout(() => R.go('#/faculty/account'), 0); return ''; } });
