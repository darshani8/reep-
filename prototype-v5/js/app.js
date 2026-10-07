/* REEP v5 prototype — the shell: role switcher, navigation as data, rail/tab bar,
   delegated events, back gesture. Screens live in screens-*.js. */
'use strict';

/* Navigation is DATA: one list per role, groups for the desktop rail, `tab` for
   the phone's bottom bar (four + More). Every row a role holds is in its list. */
const NAV = {
  student: { home: 'student/home', groups: [
    { items: [['student/home', 'Home', 'home', 'A-095', true], ['student/jobs', 'Jobs', 'briefcase', 'A-095', true], ['student/skilling', 'Skills', 'star', 'A-095', true], ['student/time-log', 'Time log', 'clock', 'A-095', true]] },
    { g: 'Practice', items: [['student/interviews', 'Interviews', 'mic'], ['student/english', 'English baseline', 'book'], ['student/leaderboards', 'Leaderboards', 'trophy', 'A-095']] },
    { g: 'My record', items: [['student/records', 'Results & courses', 'chart'], ['student/uploads', 'Documents', 'file'], ['student/resume', 'Resume', 'pen', 'A-095'], ['student/mentor-log', 'Mentor & TPO log', 'users', 'A-095']] },
    { g: 'Me', items: [['student/profile', 'Profile', 'user', 'A-094'], ['student/account', 'Account & security', 'shield']] },
  ] },
  faculty: { home: 'faculty/mentees', groups: [
    { items: [['faculty/mentees', 'My students', 'users', 'A-096', true], ['faculty/notebook', 'Notebook', 'book', 'A-096', true], ['faculty/verifications', 'Verify', 'checks', 'A-096', true, 'verify'], ['faculty/leave', 'Leave', 'cal', 'A-096', true]] },
    { g: 'My record', items: [['faculty/upskilling', 'Upskilling', 'leaf', 'A-096'], ['faculty/account', 'Account & signature', 'shield', 'A-093']] },
    { g: 'Granted access', grant: true, items: [['admin/leave-approvals', 'Approve leave', 'cal', 'A-097']] },
  ] },
  admin: { home: 'admin/home', groups: [
    { items: [['admin/home', 'Home', 'home', 'A-098', true], ['admin/analytics', 'Charts & numbers', 'chart', 'A-098']] },
    { g: 'People', items: [['admin/registrations', 'New applications', 'inbox', 'A-099', true, 'apps'], ['admin/students', 'Students & batches', 'users', 'A-099', true], ['admin/faculty', 'Faculty', 'user', 'A-099'], ['admin/mentors', 'Assign faculty', 'swap', 'A-099']] },
    { g: 'Every day', items: [['admin/leave-approvals', 'Leave requests', 'cal', 'A-100', true, 'leave'], ['admin/imports', 'Upload spreadsheets', 'upload', 'A-100'], ['admin/jobs', 'Job postings', 'briefcase', 'A-100'], ['admin/placement', 'Placement & offers', 'trophy', 'A-100'], ['admin/exports', 'Download reports', 'download', 'A-100']] },
    { g: 'Interviews', items: [['admin/interview-questions', 'Interview questions', 'list', 'A-101'], ['admin/interviews', 'Interview records', 'mic', 'A-101'], ['admin/swoc', 'SWOC notes', 'grid', 'A-101']] },
    { g: 'College setup', items: [['admin/colleges', 'Colleges', 'building', 'A-102'], ['admin/catalogue', 'Catalogue', 'layers', 'A-102']] },
    { g: 'Settings', items: [['admin/governance', 'Who can do what', 'key', 'A-103'], ['admin/audit', 'What changed', 'restore', 'A-103'], ['admin/mail', 'Email delivery', 'mail', 'A-103'], ['admin/account', 'Account & signature', 'shield', 'A-093']] },
  ] },
};

/* a tab label must fit one line at 360px */
const TAB_SHORT = { 'admin/registrations': 'Applications', 'admin/students': 'Students', 'admin/leave-approvals': 'Leave' };

const App = {
  role: 'student',
  st: {}, // per-route view state (filters, tabs, selections)
  sim: 'live', // prototype-only: show any screen in its loading or error state
  badges: { verify: () => D.claimQueue.length + D.docQueue.length, apps: () => (window.ADM ? ADM.regs.filter((r) => r.status === 'Pending review').length : 0), leave: () => (window.ADM ? ADM.leave.filter((l) => l.status === 'Awaiting').length : 0) },
  s(route) { return (this.st[route] ||= {}); },

  roleOf(parts) { const r = parts[0]; return r === 'public' ? 'public' : ['student', 'faculty', 'admin'].includes(r) ? r : null; },

  start() {
    window.addEventListener('hashchange', () => this.render(true));
    document.body.addEventListener('click', (ev) => this.onClick(ev));
    document.body.addEventListener('change', (ev) => this.onChange(ev));
    document.body.addEventListener('input', (ev) => this.onInput(ev));
    let lastY = 0;
    window.addEventListener('scroll', () => {
      const tb = document.querySelector('.topbar'); if (tb) tb.classList.toggle('scrolled', scrollY > 24);
      // on a phone the assistant button steps aside while you scroll down, and comes back on the way up or at the end
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 8;
      if (Math.abs(scrollY - lastY) > 6) document.body.classList.toggle('fab-away', scrollY > lastY && scrollY > 80 && !atEnd);
      lastY = scrollY;
    }, { passive: true });
    this.backGesture();
    if (!location.hash) location.hash = '#/start';
    this.render(false);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  },

  routeKey(parts) {
    if (!parts.length || parts[0] === 'start') return 'start';
    const [a, b] = parts;
    if (a === 'public') return `public/${b || 'login'}`;
    if (!b) return NAV[a] ? NAV[a].home : 'start';
    return `${a}/${b}`;
  },

  render(push) {
    Sheet.closeAll();
    const { parts, query } = R.parse();
    const key = this.routeKey(parts);
    const role = this.roleOf(parts);
    this.prevRole = this.role;
    if (role && role !== 'public') this.role = role;
    // a faculty member opening a granted console screen keeps the faculty shell
    // a faculty member opening a console screen they were granted keeps the faculty shell
    const granted = NAV.faculty.groups.some((g) => g.grant && g.items.some((i) => i[0] === key));
    if (parts[0] === 'admin' && granted && (this.asFaculty || this.prevRole === 'faculty')) { this.role = 'faculty'; this.asFaculty = true; }
    else if (parts[0] === 'admin') this.asFaculty = false;
    this.prevRole = this.role;
    const def = R.screens[key];
    const root = document.getElementById('app');
    if (!def) { root.innerHTML = this.frame(U.page({ title: 'Not found', body: U.empty('alert', 'That screen does not exist', '', `<a class="btn" href="#/start">Start again</a>`) }), key, false); return; }
    let out;
    if (this.sim !== 'live' && !def.bare && !key.endsWith('/more')) out = this.simPage(def, this.sim);
    else out = def.render({ id: parts[2], parts, query, st: this.s(key) });
    const page = typeof out === 'string' ? { html: out, title: def.title } : out;
    if (def.bare) root.innerHTML = `${this.protoBar()}<main id="main" class="screen-enter">${page.html}</main>`;
    else root.innerHTML = this.frame(page, key, !!parts[2] || page.back);
    const main = document.getElementById('main');
    if (main) main.classList.add(parts[2] && push ? 'screen-push' : 'screen-enter');
    document.title = `${page.title || def.title} · REEP`;
    const sticky = main && main.querySelector('.sticky-act');
    document.body.classList.toggle('has-sticky', !!sticky);
    if (sticky) requestAnimationFrame(() => document.body.style.setProperty('--sticky-h', `${sticky.offsetHeight}px`));
    document.body.classList.remove('fab-away');
    this.overflowActs(main);
    if (def.mount) def.mount(main, { id: parts[2], query, st: this.s(key) });
    if (push && !this.keepScroll) window.scrollTo(0, 0);
    this.keepScroll = false;
    this.cur = { key, def, id: parts[2] };
  },
  /* Phone headers: keep the primary action and one other in view; the rest go in a ⋯ sheet
     whose rows press the original controls, so every action keeps its own handler. */
  overflowActs(main) {
    if (!main || innerWidth > 760) return;
    const acts = main.querySelector('.page-head .acts'); if (!acts) return;
    const ctl = [...acts.children].filter((c) => c.matches('button, a.btn, label.btn'));
    if (ctl.length <= 2) return;
    const keep = [ctl.find((c) => c.classList.contains('primary')) || ctl[ctl.length - 1]];
    keep.unshift(ctl.find((c) => !keep.includes(c)));
    const extra = ctl.filter((c) => !keep.includes(c));
    extra.forEach((c) => c.setAttribute('data-overflowed', ''));
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'btn more-btn'; more.setAttribute('aria-label', 'More actions'); more.innerHTML = ic('more');
    more.addEventListener('click', () => {
      const el = Sheet.open({ title: 'More actions', body: `<div class="list">${extra.map((c, i) => `<button class="row" type="button" data-i="${i}"${c.disabled ? ' disabled style="opacity:.45"' : ''}><div class="body"><div class="ttl">${esc(c.textContent.trim() || c.getAttribute('aria-label') || '')}</div></div></button>`).join('')}</div>` });
      el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { const c = extra[+b.dataset.i]; Sheet.close(); setTimeout(() => (c.tagName === 'LABEL' ? c.querySelector('input')?.click() : c.click()), 330); }));
    });
    acts.insertBefore(more, keep[0]);
  },

  rerender() { this.keepScroll = true; const y = scrollY; const f = document.activeElement; const sel = f && f.dataset && f.dataset.f ? `[data-f="${f.dataset.f}"]` : null; this.render(false); window.scrollTo(0, y); if (sel) { const n = document.querySelector(sel); if (n) { n.focus(); if (n.setSelectionRange && /^(text|search|email|tel|url|password|textarea)$/.test(n.type)) n.setSelectionRange(n.value.length, n.value.length); } } },

  /* Every screen's loading and error states, in one shape: skeleton rows, then a
     sentence saying what failed and a Retry. `def.states` names the inventory rows. */
  simPage(def, mode) {
    const inv = def.states ? I(...def.states.split(' ')) : '';
    if (mode === 'loading') return { title: def.title, html: `<header class="page-head"><h1>${esc(def.title)}</h1></header><div class="stack" role="status" aria-label="Loading"${inv}>${'<div class="card"><div class="skel" style="height:14px;width:40%;margin-bottom:10px"></div><div class="skel" style="height:12px;width:90%;margin-bottom:6px"></div><div class="skel" style="height:12px;width:70%"></div></div>'.repeat(3)}</div>` };
    return { title: def.title, html: `<header class="page-head"><h1>${esc(def.title)}</h1></header><div class="card"${inv}>${U.empty('alert', 'Could not load this screen', 'The server did not answer. Nothing you entered was lost.', `<button class="btn primary" type="button" data-act="retry">Retry</button>`)}</div>` };
  },

  protoBar() {
    const r = this.role; const pub = (R.parse().parts[0] || '') === 'public';
    return `<div class="proto" role="region" aria-label="Prototype controls"><b>REEP v5</b><span class="faint" style="color:#cfc7dd">prototype · fake data</span>
      <label class="hrow" style="margin-left:auto;gap:4px;color:#cfc7dd"><span class="stl">State</span> <select data-act-change="sim" aria-label="Screen state" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;font-size:12px;padding:2px 4px">${['live', 'loading', 'error'].map((v) => `<option style="color:#000"${this.sim === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="seg" role="group" aria-label="View as" style="margin-left:8px">${[['public', 'Signed out'], ['student', 'Student'], ['faculty', 'Faculty'], ['admin', 'Main Admin']].map(([k, t]) => `<button type="button" data-act="role" data-v="${k}" aria-pressed="${pub ? k === 'public' : k === r}">${t}</button>`).join('')}</div></div>`;
  },

  frame(page, key, isDetail) {
    const role = this.role;
    const nav = NAV[role];
    const me = D.me[role];
    const groups = nav.groups.filter((g) => !g.grant || (role === 'faculty' && D.me.faculty.granted.length));
    const pip = (b) => { const n = b && this.badges[b] ? this.badges[b]() : 0; return n ? `<span class="pip">${n}</span>` : ''; };
    const rail = `<nav class="rail" aria-label="Main"><a class="brand" href="#/${nav.home}"${I('A-087')} style="background:none;box-shadow:none"><span class="brand-mark">R</span><span><span class="brand-name">REEP</span><br><span class="xs muted">${role === 'student' ? 'Student' : role === 'faculty' ? 'Faculty console' : 'Admin console'}</span></span></a>
      ${groups.map((g) => `${g.g ? `<div class="grp">${g.g}</div>` : ''}${g.items.map(([k, t, icn, inv, , b]) => k === null ? `<span class="soon"${I('A-105')}>${ic(icn)}<span>${t}</span><span class="chip neutral plain xs">Soon</span></span>` : `<a href="#/${k}"${k === key || key.startsWith(k + '/') ? ' aria-current="page"' : ''}${inv ? I(inv) : ''}>${ic(icn)}<span>${t}</span>${pip(b)}</a>`).join('')}`).join('')}
      <div class="me"><a href="#/${role}/account"${I(role === 'student' ? 'A-092' : 'A-093')}><span class="avatar" style="width:30px;height:30px;font-size:11px">${initials(me.name)}</span><span class="ellip">${esc(me.name)}<br><span class="xs muted">${role === 'student' ? D.me.student.usn : role === 'admin' ? 'Main Admin · Whole programme' : 'Faculty'}</span></span></a></div></nav>`;
    const tabs = groups.flatMap((g) => g.items).filter((i) => i[4]).slice(0, 4);
    const tabbar = `<nav class="tabbar" aria-label="Tabs"${I('A-106')}>${tabs.map(([k, t, icn, , , b]) => `<a href="#/${k}"${k === key ? ' aria-current="page"' : ''}>${ic(icn, 'lg')}<span>${TAB_SHORT[k] || t}</span>${pip(b)}</a>`).join('')}<a href="#/${role}/more"${key === role + '/more' ? ' aria-current="page"' : ''}${I('A-088')}>${ic('menu', 'lg')}<span>More</span></a></nav>`;
    const back = isDetail ? `<button class="icon-btn" type="button" data-act="back" aria-label="Back">${ic('back', 'lg')}</button>` : '';
    const topbar = `<div class="topbar${isDetail ? ' always' : ''}"><div class="slot">${back}</div><div class="t">${esc(page.title || '')}</div><div class="slot end">${role === 'admin' ? `<span class="chip info plain xs"${I('A-089')}>${D.env}</span><span class="chip neutral plain xs"${I('A-090')} style="margin-left:4px">Whole programme</span><a class="icon-btn" href="https://github.com/darshani8/reep-/blob/main/AGENTS.md" target="_blank" rel="noopener" aria-label="Help"${I('A-091')}>${ic('info')}</a>` : ''}<a class="icon-btn" href="#/${role}/account" aria-label="Account"${I(role === 'student' ? 'A-092' : 'A-093')}>${ic('user')}</a></div></div>`;
    const fab = `<button class="fab" type="button" data-act="dock" aria-label="Open the REEP assistant"${I('A-107', 'A-109')}>${ic('sparkle', 'lg')}</button>`;
    return `${this.protoBar()}<div class="app">${rail}<div class="main">${topbar}<main id="main" class="content">${page.html}</main></div></div>${tabbar}${fab}`;
  },

  /* ------------------------------------------------ delegated events */
  onClick(ev) {
    const a = ev.target.closest('[data-act]');
    if (!a || a.closest('.sheet')) return;
    const act = a.dataset.act;
    if (act === 'role') { const v = a.dataset.v; this.asFaculty = false; return R.go(v === 'public' ? '#/public/login' : `#/${NAV[v].home}`); }
    if (act === 'back') return history.length > 1 ? history.back() : R.go(`#/${NAV[this.role].home}`);
    if (act === 'seg') return this.handleSeg(a);
    if (act === 'dock') return Dock.open();
    if (act === 'retry') { this.sim = 'live'; return this.render(false); }
    if (act === 'go') return R.go(a.dataset.to);
    const h = this.cur && this.cur.def.acts && this.cur.def.acts[act];
    if (h) { ev.preventDefault(); h(a, ev, this.s(this.cur.key)); }
    else if (Actions[act]) { ev.preventDefault(); Actions[act](a, ev); }
  },
  handleSeg(a, scope) {
    if (scope) { scope.querySelectorAll(`[data-seg="${a.dataset.seg}"]`).forEach((b) => { b.setAttribute(b.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-pressed', String(b === a)); }); const fn = Sheet.stack.at(-1)?.onAct['seg:' + a.dataset.seg]; if (fn) fn(a); return; }
    this.s(this.cur.key)[a.dataset.seg] = a.dataset.v; this.rerender();
  },
  onChange(ev) {
    const a = ev.target.closest('[data-act-change]');
    if (!a || a.closest('.sheet')) return;
    if (a.dataset.actChange === 'sim') { this.sim = a.value; return this.render(false); }
    if (a.dataset.actChange === 'filter') { this.s(this.cur.key)[a.dataset.f] = a.value; this.rerender(); }
    else if (a.dataset.actChange === 'file') this.showFile(a);
    const h = this.cur.def.acts && this.cur.def.acts['change:' + a.dataset.f];
    if (h) h(a, ev, this.s(this.cur.key));
  },
  onInput(ev) {
    const a = ev.target.closest('[data-act-input]');
    if (!a || a.closest('.sheet')) return;
    const h = this.cur.def.acts && this.cur.def.acts['input:' + a.dataset.f];
    if (h) return h(a, ev, this.s(this.cur.key));
    if (a.dataset.actInput === 'search') { this.s(this.cur.key)[a.dataset.f] = a.value; clearTimeout(this.t); this.t = setTimeout(() => this.rerender(), 120); }
  },
  showFile(input) { const f = input.files && input.files[0]; const box = input.parentElement.querySelector(`[data-file="${input.dataset.f}"]`); if (box) box.textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(0)} kB` : ''; },

  /* swipe from the left edge goes back, like a native pushed screen */
  backGesture() {
    let x0 = null, y0 = 0;
    window.addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX < 24 && !Sheet.stack.length ? t.clientX : null; y0 = t.clientY; }, { passive: true });
    window.addEventListener('touchend', (e) => { if (x0 === null) return; const t = e.changedTouches[0]; if (t.clientX - x0 > 80 && Math.abs(t.clientY - y0) < 60 && this.cur && this.cur.id) history.back(); x0 = null; }, { passive: true });
  },
};

/* Global actions any screen can fire. */
const Actions = {
  signout() { Sheet.closeAll(); R.go('#/public/login'); toast('Signed out'); },
};

/* The "More" screen for each role is the drawer on a phone: every row the rail has. */
['student', 'faculty', 'admin'].forEach((role) => {
  R.screen(`${role}/more`, { title: 'More', render() {
    const groups = NAV[role].groups.filter((g) => !g.grant || (role === 'faculty' && D.me.faculty.granted.length));
    const me = D.me[role];
    const head = `<div class="list" style="margin-bottom:8px">${U.row({ title: esc(me.name), sub: role === 'student' ? `${D.me.student.usn} · ${D.me.student.course} ${D.me.student.spec}` : role === 'admin' ? 'Main Admin · Whole programme' : 'Faculty', lead: `<span class="avatar">${initials(me.name)}</span>`, href: role === 'student' ? '#/student/profile' : `#/${role}/account`, inv: I('A-094') })}</div>`;
    return U.page({ title: 'More', body: head + groups.map((g) => U.section(g.g || 'Main', `<div class="list">${g.items.map(([k, t, icn, inv]) => U.row({ title: t, lead: U.lead(icn), href: `#/${k}`, inv: inv ? I(inv) : '' })).join('')}</div>`)).join('') +
      U.section('Session', `<div class="list">${U.row({ title: 'Sign out', lead: U.lead('logout'), act: 'signout', chev: false, inv: I('A-059', 'A-092') })}</div>`) });
  } });
});
