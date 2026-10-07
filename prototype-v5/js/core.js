/* REEP v5 prototype — core: icons, tiny templating, router, sheets, toasts.
   No dependencies. Screens register with `R.screen(route, {title, render, tab})`;
   `render(params)` returns an HTML string and may return `{html, mount}`.
   Event handling is delegated: any element with data-act="name" calls the
   current screen's or the global action `name(el, ev)`. */
'use strict';

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  briefcase: 'M3 8h18v12H3zM8 8V5h8v3M3 13h18',
  star: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.2 9.5l6.1-.9z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  chat: 'M4 5h16v11H9l-5 4z',
  book: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M9 17h6',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3',
  check: 'M4 12l5 5L20 6',
  checks: 'M2 12l5 5L18 6M12 17l1 1L22 9',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  chev: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  down: 'M6 9l6 6 6-6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  cal: 'M4 6h16v15H4zM4 10h16M9 3v4M15 3v4',
  leaf: 'M5 21c0-9 6-15 15-16-1 9-7 15-15 16zM5 21l7-7',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  key: 'M14 10a4 4 0 1 0-1.2 2.8L21 21M17 17l2-2',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  pen: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  sign: 'M3 17c3-4 5-9 7-9s-1 9 1 9 3-4 5-4 2 3 5 3M3 21h18',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  building: 'M4 21V5l8-2v18M12 8h8v13M8 8h.01M8 12h.01M8 16h.01M16 12h.01M16 16h.01M2 21h20',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 18l10 5 10-5',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3',
  restore: 'M4 12a8 8 0 1 0 3-6.2M4 4v5h5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  send: 'M4 12 20 4l-6 16-3-7z',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7h.01',
  google: 'M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5a4.3 4.3 0 0 1-1.9 2.8v2.3h3A9 9 0 0 0 21 12.2zM12 21c2.4 0 4.5-.8 6-2.2l-3-2.3c-.8.6-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.4A9 9 0 0 0 12 21zM7 13.7a5.4 5.4 0 0 1 0-3.4V7.9H4a9 9 0 0 0 0 8.2zM12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 4 7.9l3 2.4c.7-2.1 2.7-3.7 5-3.7z',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n] || ICONS.info}"/></svg>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Inventory tag. Every element that carries a FUNCTION-INVENTORY row says so. */
const I = (...ids) => ` data-inv="${ids.join(' ')}"`;
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const chip = (text, tone = 'neutral', inv = '') => `<span class="chip ${tone}"${inv}>${esc(text)}</span>`;
const fmtDate = (d) => new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/* ---------------------------------------------------------------- UI helpers */
const U = {
  page({ title, lede = '', acts = '', body, back = null }) {
    return { title, back, html: `<header class="page-head"><div class="grow"><h1>${esc(title)}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}</div><div class="acts">${acts}</div></header>${body}` };
  },
  section(title, body, extra = '') {
    return `<section class="section"><div class="sh"><h2>${esc(title)}</h2>${extra}</div>${body}</section>`;
  },
  row({ title, sub = '', lead = '', trail = '', href = '', act = '', data = '', inv = '', chev = true, sel = false }) {
    const tag = href ? 'a' : act ? 'button' : 'div';
    const attrs = href ? ` href="${href}"` : act ? ` type="button" data-act="${act}"` : '';
    return `<${tag} class="row${sel ? ' sel' : ''}"${attrs}${data}${inv}>${lead}<div class="body"><div class="ttl">${title}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="trail">${trail}${(href || act) && chev ? ic('chev', 'sm') : ''}</div></${tag}>`;
  },
  lead(icon) { return `<span class="lead">${ic(icon)}</span>`; },
  av(name) { return `<span class="lead av">${initials(name)}</span>`; },
  kpi(v, l, { act = '', data = '', inv = '' } = {}) {
    return act ? `<button class="kpi" type="button" data-act="${act}"${data}${inv}><div class="v">${v}</div><div class="l">${l}</div></button>`
      : `<div class="kpi"${inv}><div class="v">${v}</div><div class="l">${l}</div></div>`;
  },
  meter(pct, tone = '') { return `<div class="meter ${tone}" role="meter" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`; },
  field({ id, label, type = 'text', value = '', req = false, ph = '', opts = null, hint = '', inv = '', attrs = '' }) {
    let ctl;
    if (opts) ctl = `<select class="input" id="${id}" name="${id}"${attrs}>${opts.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
    else if (type === 'textarea') ctl = `<textarea class="input" id="${id}" name="${id}" placeholder="${esc(ph)}"${attrs}>${esc(value)}</textarea>`;
    else ctl = `<input class="input" id="${id}" name="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}"${attrs}>`;
    return `<div class="field"${inv}><label for="${id}">${esc(label)}${req ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>${ctl}${hint ? `<div class="hint">${hint}</div>` : ''}<div class="err" role="alert" data-err="${id}"></div></div>`;
  },
  seg(name, options, value, inv = '') {
    return `<div class="seg" role="group"${inv}>${options.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<button type="button" data-act="seg" data-seg="${name}" data-v="${esc(v)}" aria-pressed="${String(v) === String(value)}">${esc(t)}</button>`; }).join('')}</div>`;
  },
  tabs(name, options, value, inv = '') {
    return `<div class="tabs" role="tablist"${inv}>${options.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<button type="button" role="tab" data-act="seg" data-seg="${name}" data-v="${esc(v)}" aria-selected="${String(v) === String(value)}">${esc(t)}</button>`; }).join('')}</div>`;
  },
  select(id, opts, value, inv = '', label = '') {
    return `<select class="input" data-act-change="filter" data-f="${id}" aria-label="${esc(label || id)}"${inv}>${opts.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`;
  },
  search(id, value, ph, inv = '') {
    return `<label class="search grow"${inv}>${ic('search', 'sm')}<span class="sr">${esc(ph)}</span><input class="input" type="search" data-act-input="search" data-f="${id}" value="${esc(value)}" placeholder="${esc(ph)}"></label>`;
  },
  empty(icon, title, text = '', action = '') {
    return `<div class="empty"><div class="ic">${ic(icon, 'lg')}</div><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`;
  },
  table(cols, rows, inv = '') {
    return `<div class="card tight"${inv}><table class="rtable"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr${r._attrs || ''}>${cols.map((c, i) => `<td data-l="${esc(c.h)}" class="${i === 0 ? 'lead-cell' : ''}${c.r ? ' r' : ''}">${r[c.k] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  },
  drop(id, label, accept, inv = '') {
    return `<label class="drop"${inv}>${ic('upload', 'lg')}<div style="margin-top:6px;font-weight:600;color:var(--ink)">${esc(label)}</div><div class="xs">${esc(accept)}</div><input type="file" data-act-change="file" data-f="${id}"><div class="xs" data-file="${id}" style="margin-top:6px;color:var(--brand-purple)"></div></label>`;
  },
};

/* ---------------------------------------------------------------- form reading + errors */
function formVals(root) {
  const o = {};
  root.querySelectorAll('input[name],select[name],textarea[name]').forEach((el) => {
    if (el.type === 'checkbox') { if (el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type === 'file') o[el.name] = el.files[0] || null;
    else o[el.name] = el.value.trim();
  });
  return o;
}
function errs(root, map) {
  root.querySelectorAll('[data-err]').forEach((e) => { e.textContent = ''; });
  root.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  let first = null;
  for (const [k, msg] of Object.entries(map)) {
    const box = root.querySelector(`[data-err="${k}"]`);
    if (box) box.textContent = msg;
    const ctl = root.querySelector(`#${CSS.escape(k)}`);
    if (ctl) { ctl.setAttribute('aria-invalid', 'true'); first ||= ctl; }
  }
  if (first) first.focus();
  return Object.keys(map).length === 0;
}

/* ---------------------------------------------------------------- toast */
let toastTimer;
function toast(msg, tone = '') {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = `toast ${tone}`; t.innerHTML = `${ic(tone === 'risk' ? 'alert' : 'check', 'sm')}<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => t.classList.add('on'));
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ---------------------------------------------------------------- sheets */
const Sheet = {
  stack: [],
  open({ title, body, foot = '', center = false, onAct = {}, onClose = null, wide = false }) {
    const scrim = document.createElement('div'); scrim.className = 'scrim';
    const el = document.createElement('div');
    el.className = `sheet${center ? ' center' : ''}`; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', title);
    if (wide) el.style.width = 'min(720px, 100%)';
    el.innerHTML = `<div class="grab" aria-hidden="true"></div><div class="sh-h"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-sheet-close aria-label="Close">${ic('x')}</button></div><div class="sh-b">${body}</div>${foot ? `<div class="sh-f">${foot}</div>` : ''}`;
    document.body.append(scrim, el);
    const entry = { el, scrim, onAct, onClose, prevFocus: document.activeElement };
    this.stack.push(entry);
    requestAnimationFrame(() => { scrim.classList.add('on'); el.classList.add('on'); (el.querySelector('input,select,textarea') || el.querySelector('[data-sheet-close]')).focus({ preventScroll: true }); });
    scrim.addEventListener('click', () => this.close());
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-sheet-close]')) return this.close();
      const a = ev.target.closest('[data-act]');
      if (a && onAct[a.dataset.act]) { ev.stopPropagation(); onAct[a.dataset.act](a, ev, el); }
      else if (a && a.dataset.act === 'seg') { App.handleSeg(a, el); }
    });
    el.addEventListener('change', (ev) => { const a = ev.target.closest('[data-act-change]'); if (a && onAct['change:' + a.dataset.f]) onAct['change:' + a.dataset.f](a, ev, el); if (a && a.dataset.actChange === 'file') App.showFile(a); });
    el.addEventListener('input', (ev) => { const a = ev.target.closest('[data-act-input]'); if (a && onAct['input:' + a.dataset.f]) onAct['input:' + a.dataset.f](a, ev, el); });
    // drag the grab handle down to dismiss (mobile)
    let y0 = null;
    el.querySelector('.grab').parentElement.addEventListener('touchstart', (e) => { if (el.querySelector('.sh-b').scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchmove', (e) => { if (y0 === null) return; const d = e.touches[0].clientY - y0; if (d > 0) el.style.transform = `translateY(${d}px)`; }, { passive: true });
    el.addEventListener('touchend', (e) => { if (y0 === null) return; const d = e.changedTouches[0].clientY - y0; y0 = null; el.style.transform = ''; if (d > 110) this.close(); });
    return el;
  },
  close() {
    const e = this.stack.pop(); if (!e) return;
    e.scrim.classList.remove('on'); e.el.classList.remove('on');
    setTimeout(() => { e.scrim.remove(); e.el.remove(); }, 320);
    if (e.onClose) e.onClose();
    if (e.prevFocus && e.prevFocus.focus) e.prevFocus.focus({ preventScroll: true });
  },
  closeAll() { while (this.stack.length) this.close(); },
  confirm({ title, text, ok = 'Confirm', danger = false, onOk }) {
    this.open({ title, center: true, body: `<p>${text}</p>`,
      foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" type="button" data-act="ok">${esc(ok)}</button>`,
      onAct: { ok: () => { this.close(); onOk(); } } });
  },
  /** A decision that must carry words: refused when blank, exactly as the API refuses it. */
  reason({ title, label = 'Reason', ok = 'Confirm', danger = false, required = true, inv = '', pre = '', onOk }) {
    this.open({ title, center: true, body: `${pre}<div class="stack">${U.field({ id: 'why', label, type: 'textarea', req: required, inv })}</div>`,
      foot: `<button class="btn" type="button" data-sheet-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" type="button" data-act="ok">${esc(ok)}</button>`,
      onAct: { ok: (a, ev, el) => { const v = el.querySelector('#why').value.trim(); if (required && !v) return errs(el, { why: `${label} is required.` }); this.close(); onOk(v); } } });
  },
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && Sheet.stack.length) Sheet.close(); });

/* ---------------------------------------------------------------- router */
const R = {
  screens: {},
  screen(route, def) { this.screens[route] = def; },
  parse() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, q = ''] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    return { parts, query: Object.fromEntries(new URLSearchParams(q)) };
  },
  go(hash) { location.hash = hash; },
};
