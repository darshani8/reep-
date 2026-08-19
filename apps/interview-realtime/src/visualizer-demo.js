/**
 * =============================================================================
 * visualizer-demo.js — the driver for visualizer.html
 * =============================================================================
 *
 * Loads ./VoiceVisualizer.js — the *compiled* output of the VoiceVisualizer.ts
 * sitting next to it — and wires it to the harness controls: four state toggles,
 * two amplitude sliders, one scripted conversation.
 *
 * There is no build step checked in (no package.json, no tsconfig.json: this
 * app's backend is FastAPI only). See the header of visualizer.html in this
 * directory for the one-line tsc invocation that produces the file this import
 * needs. Until it is run, the banner below is what you get — which is why this
 * harness no longer lives under public/, where the relay would serve it.
 *
 * ---------------------------------------------------------------------------
 * EXPECTED MODULE CONTRACT
 * ---------------------------------------------------------------------------
 *   export enum VisualizerState { Connecting, Listening, Speaking, Idle }
 *   export class MockAudioStreamController {
 *     injectUserAudioAmplitude(value: number): void;   // 0..1, fast attack
 *     injectAiAudioAmplitude(value: number): void;     // 0..1, slow attack
 *   }
 *   export class VoiceVisualizer {
 *     constructor(canvas: HTMLCanvasElement, audio: MockAudioStreamController);
 *     setState(state: VisualizerState, errorTint?: boolean): void;
 *     show(): void;      // PREFERRED ENTRY POINT: reveals the overlay and starts the
 *                        // render loop. start() is a private helper — TypeScript's
 *                        // `private` is erased at emit, so duck-typing finds it and
 *                        // calling it "works", except the overlay stays at opacity 0
 *                        // and every frame is rendered into a transparent element.
 *     hide(): void;      // sweeps it out and parks the loop
 *     destroy(): void;
 *   }
 *
 * The controller argument is NOT optional: the render loop calls audio.update(dt)
 * every frame, so a visualizer built without one throws once per frame forever.
 *
 * This driver is deliberately tolerant about the exact shape, because the
 * module is authored separately: it resolves exports by name first, then by
 * duck-typing (a class whose prototype carries `setState`, a class whose
 * prototype carries `injectUserAudioAmplitude`), and it tries a short ordered
 * list of constructor signatures. If nothing matches it shows the red banner
 * naming what the module *did* export rather than guessing further — no
 * silent no-op orb.
 *
 * Amplitude routing, in priority order:
 *   1. a controller instance the visualizer exposes (`.controller` / `.audio` /
 *      `.audioController`) — that is provably the one it reads;
 *   2. the controller instance this driver constructed and handed over;
 *   3. the visualizer itself, if it carries the two inject* methods.
 *
 * Amplitudes are pumped every frame (that is what a real audio stream does),
 * from either the sliders or the script. The pump allocates nothing per frame:
 * every callback is bound once at boot, and DOM writes are throttled.
 *
 * For console poking, the wiring is exposed as `window.__orbHarness`.
 */

/* --------------------------------------------------------------- helpers -- */

/** @type {(id: string) => any} */
const el = (id) => document.getElementById(id);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smooth 0..1 ramp between edges. */
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Smooth 0..1 bump centred on `centre`, zero outside +/- `half`. */
function bump(x, centre, half) {
  const d = Math.abs(x - centre);
  if (d >= half) return 0;
  return 0.5 + 0.5 * Math.cos((d / half) * Math.PI);
}

const isCtor = (v) => typeof v === 'function' && v.prototype != null;
const hasMethod = (v, name) => isCtor(v) && typeof v.prototype[name] === 'function';

/** Resolve an export by preferred names, then by duck-type predicate. */
function findExport(mod, names, test) {
  for (const n of names) {
    const v = mod[n];
    if (v != null && (!test || test(v))) return v;
  }
  if (test) for (const v of Object.values(mod)) if (test(v)) return v;
  return undefined;
}

/* ----------------------------------------------------------------- DOM ---- */

const overlay = el('overlay');
const canvas = el('orb');
const hud = el('hud');
const hudState = el('hudState');
const hudFps = el('hudFps');
const statusEl = el('status');
const userAmpEl = el('userAmp');
const aiAmpEl = el('aiAmp');
const userAmpOut = el('userAmpOut');
const aiAmpOut = el('aiAmpOut');
const simBtn = el('simulate');
const simLabel = el('simLabel');
const replayBtn = el('replay');
const toggleOverlayBtn = el('toggleOverlay');
const stateBtns = /** @type {HTMLButtonElement[]} */ (
  Array.from(document.querySelectorAll('.seg[data-state]'))
);
const loadError = el('loadError');
const loadErrorTitle = el('loadErrorTitle');
const loadErrorDetail = el('loadErrorDetail');

function setStatus(text) {
  statusEl.textContent = text;
}

function fail(title, detail) {
  loadErrorTitle.textContent = title;
  loadErrorDetail.textContent = detail || '';
  loadError.hidden = false;
  setStatus('Not wired — see the banner.');
  for (const b of stateBtns) b.disabled = true;
  simBtn.disabled = true;
  userAmpEl.disabled = true;
  aiAmpEl.disabled = true;
}

/* ------------------------------------------------------- load the module -- */

let mod;
try {
  mod = await import('./VoiceVisualizer.js');
} catch (err) {
  fail(
    'Could not load ./VoiceVisualizer.js',
    'Import failed: ' + (err && err.message ? err.message : String(err)),
  );
  throw err;
}

const exportNames = Object.keys(mod);
const exportsSummary = exportNames.length ? exportNames.join(', ') : '(nothing)';

const StateEnum = findExport(mod, ['VisualizerState', 'State'], (v) => typeof v === 'object' && v !== null);
const ControllerCtor = findExport(
  mod,
  ['MockAudioStreamController', 'AudioStreamController', 'AudioController'],
  (v) => hasMethod(v, 'injectUserAudioAmplitude'),
);
const VisualizerCtor = findExport(
  mod,
  ['VoiceVisualizer', 'Visualizer', 'default'],
  (v) => hasMethod(v, 'setState'),
);

if (!VisualizerCtor) {
  fail(
    'VoiceVisualizer.js loaded, but no visualizer class was found',
    'Expected an exported class with a setState() method (e.g. `export class VoiceVisualizer`).\n' +
      'Module exported: ' + exportsSummary,
  );
  throw new Error('no visualizer export');
}

/** Map a harness state name onto whatever the enum uses (string or numeric). */
function stateToken(name) {
  if (!StateEnum) return name;
  if (name in StateEnum) return StateEnum[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(StateEnum)) {
    if (key.toLowerCase() === lower) return StateEnum[key];
  }
  return name;
}

/* ------------------------------------------------------------ construct --- */

let controller = null;
if (ControllerCtor) {
  try {
    controller = new ControllerCtor();
  } catch {
    controller = null; // may need the visualizer as an argument; retried below
  }
}

let visualizer = null;
let ctorUsed = '';
const attempts = [];
if (controller) {
  attempts.push(['new VoiceVisualizer(canvas, controller)', () => new VisualizerCtor(canvas, controller)]);
  attempts.push([
    'new VoiceVisualizer({ canvas, controller })',
    () => new VisualizerCtor({ canvas, controller, audio: controller, audioController: controller }),
  ]);
}
attempts.push(['new VoiceVisualizer(canvas)', () => new VisualizerCtor(canvas)]);
attempts.push(['new VoiceVisualizer({ canvas })', () => new VisualizerCtor({ canvas })]);

const ctorErrors = [];
for (const [label, make] of attempts) {
  try {
    const instance = make();
    if (instance && typeof instance.setState === 'function') {
      visualizer = instance;
      ctorUsed = label;
      break;
    }
    if (instance && typeof instance.destroy === 'function') instance.destroy();
    ctorErrors.push(label + ' -> instance has no setState()');
  } catch (err) {
    ctorErrors.push(label + ' -> ' + (err && err.message ? err.message : String(err)));
  }
}

if (!visualizer) {
  fail(
    'VoiceVisualizer could not be constructed',
    'Tried, in order:\n  ' + ctorErrors.join('\n  ') + '\nModule exported: ' + exportsSummary,
  );
  throw new Error('construction failed');
}

// Controller that needs the visualizer handed to it.
if (!controller && ControllerCtor) {
  try {
    controller = new ControllerCtor(visualizer);
  } catch {
    controller = null;
  }
}

// Late attachment, if the visualizer offers a setter and did not take one.
if (controller && typeof visualizer.setAudioController === 'function') {
  try { visualizer.setAudioController(controller); } catch { /* non-fatal */ }
}

/* show() is the ONLY thing that adds .is-open to the module's overlay — whose base
   rule is opacity:0 / pointer-events:none — AND the only thing that sets its `visible`
   flag. Calling the (erased-)private start() merely kicks the RAF loop, so the module
   renders at full cost into a fully transparent element: every diagnostic on this page
   reads "wired", the fps counter is live, and the screen is empty. */
if (typeof visualizer.show === 'function') {
  try {
    visualizer.show();
  } catch (err) {
    setStatus('show() threw: ' + (err && err.message ? err.message : String(err)));
  }
} else if (typeof visualizer.start === 'function') {
  try {
    visualizer.start();
  } catch (err) {
    setStatus('start() threw: ' + (err && err.message ? err.message : String(err)));
  }
} else {
  fail(
    'VoiceVisualizer exposes neither show() nor hide()',
    'The spec requires show()/hide(); nothing on this instance opens the overlay or ' +
      'starts the render loop.\nModule exported: ' + exportsSummary,
  );
  throw new Error('no show()');
}

/* ------------------------------------------------- resolve the amp sinks -- */

const ownController = [visualizer.controller, visualizer.audio, visualizer.audioController].find(
  (c) => c && typeof c.injectUserAudioAmplitude === 'function',
);

let sinkOwner = null;
let sinkLabel = '';
if (ownController) {
  sinkOwner = ownController;
  sinkLabel = ownController === controller ? 'MockAudioStreamController' : 'visualizer-owned controller';
} else if (controller && typeof controller.injectUserAudioAmplitude === 'function') {
  sinkOwner = controller;
  sinkLabel = 'MockAudioStreamController';
} else if (typeof visualizer.injectUserAudioAmplitude === 'function') {
  sinkOwner = visualizer;
  sinkLabel = 'visualizer inject* methods';
}

if (!sinkOwner || typeof sinkOwner.injectAiAudioAmplitude !== 'function') {
  fail(
    'No amplitude sink found',
    'Nothing exposes both injectUserAudioAmplitude() and injectAiAudioAmplitude().\n' +
      'Expected `export class MockAudioStreamController` with both methods.\n' +
      'Module exported: ' + exportsSummary,
  );
  throw new Error('no amplitude sink');
}

// Bound once — the pump loop must not allocate.
const injectUser = sinkOwner.injectUserAudioAmplitude.bind(sinkOwner);
const injectAi = sinkOwner.injectAiAudioAmplitude.bind(sinkOwner);

/* ------------------------------------------------------------- controls -- */

const STATES = ['Connecting', 'Listening', 'Speaking', 'Idle'];
let currentState = '';

function setState(name) {
  if (name === currentState) return;
  currentState = name;
  try {
    visualizer.setState(stateToken(name));
  } catch (err) {
    setStatus('setState threw: ' + (err && err.message ? err.message : String(err)));
    return;
  }
  for (const b of stateBtns) b.setAttribute('aria-pressed', String(b.dataset.state === name));
  hud.dataset.state = name;
  hudState.textContent = name;
}

function onStateClick(ev) {
  const btn = ev.target instanceof Element ? ev.target.closest('.seg[data-state]') : null;
  if (!btn) return;
  stopSimulation('Simulation cancelled — manual state change.');
  setState(btn.dataset.state);
}

/* Sliders. The pump re-sends the held value every frame, so a parked slider
   keeps the orb energised exactly as a live stream would. */
let userTarget = 0;
let aiTarget = 0;

function onUserInput() {
  stopSimulation('Simulation cancelled — manual amplitude.');
  userTarget = clamp01(parseFloat(userAmpEl.value) || 0);
  userAmpOut.textContent = userTarget.toFixed(2);
}
function onAiInput() {
  stopSimulation('Simulation cancelled — manual amplitude.');
  aiTarget = clamp01(parseFloat(aiAmpEl.value) || 0);
  aiAmpOut.textContent = aiTarget.toFixed(2);
}

function onReplay() {
  overlay.classList.add('sweeping');
  overlay.classList.remove('go');
  void overlay.offsetWidth; // force reflow so the animation restarts
  overlay.classList.add('go');
}

/* show()/hide() are part of the module contract, so the harness has to exercise them
   — not merely call show() once at boot and never look at the other half again. */
let overlayShown = true;

function onToggleOverlay() {
  const want = !overlayShown;
  const method = want ? 'show' : 'hide';
  if (typeof visualizer[method] !== 'function') {
    setStatus('Visualizer has no ' + method + '().');
    return;
  }
  try {
    visualizer[method]();
  } catch (err) {
    setStatus(method + '() threw: ' + (err && err.message ? err.message : String(err)));
    return;
  }
  overlayShown = want;
  toggleOverlayBtn.textContent = overlayShown ? 'Hide overlay' : 'Show overlay';
  toggleOverlayBtn.setAttribute('aria-pressed', String(overlayShown));
  setStatus(overlayShown ? 'Overlay shown — loop running.' : 'Overlay hidden — loop parked.');
}

function onKeyDown(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key >= '1' && ev.key <= '4' && ev.key.length === 1) {
    ev.preventDefault();
    stopSimulation('Simulation cancelled — manual state change.');
    setState(STATES[Number(ev.key) - 1]);
    return;
  }
  if (ev.key === 's' || ev.key === 'S') {
    ev.preventDefault();
    toggleSimulation();
  }
}

/* ------------------------------------------------------ scripted script --- */
/*
   Connecting 0.0-1.5s  · silence
   Listening  1.5-5.5s  · user amplitude: syllabic bursts under a rise/fall arc,
                          with one breath gap, so fast-attack damping is visible
   Speaking   5.5-10.5s · AI amplitude: slow rolling swell, two-tone, one
                          sentence gap, so slow-release damping is visible
   Idle       10.5s     · collapse
*/
const P_CONNECT_END = 1500;
const P_LISTEN_END = 5500;
const P_SPEAK_END = 10500;

let simStart = -1; // -1 == not running
let simPhase = -1;
let domThrottle = 0;

function userScript(t) {
  const arc = Math.sin(Math.PI * clamp01(t / 4));
  const syllables = 0.55 + 0.45 * Math.pow(Math.sin(Math.PI * t * 2.7), 2);
  const flutter = 0.92 + 0.08 * Math.sin(t * 31.0);
  const breath = 1 - 0.9 * bump(t, 2.05, 0.26);
  return clamp01(arc * syllables * flutter * breath);
}

function aiScript(t) {
  const attack = smoothstep(0, 0.55, t);
  const release = 1 - smoothstep(4.35, 5.0, t);
  const roll = 0.58 + 0.27 * Math.sin(2 * Math.PI * 0.29 * t) + 0.15 * Math.sin(2 * Math.PI * 0.61 * t + 1.1);
  const sentenceGap = 1 - 0.75 * bump(t, 2.6, 0.34);
  return clamp01(attack * release * roll * sentenceGap);
}

function advanceScript(elapsed, now) {
  let phase;
  if (elapsed < P_CONNECT_END) phase = 0;
  else if (elapsed < P_LISTEN_END) phase = 1;
  else if (elapsed < P_SPEAK_END) phase = 2;
  else phase = 3;

  if (phase !== simPhase) {
    simPhase = phase;
    setState(STATES[phase]);
    if (phase === 3) {
      stopSimulation('Scripted conversation complete.');
      return;
    }
    setStatus('Simulating — ' + STATES[phase] + '…');
  }

  if (phase === 1) {
    userTarget = userScript((elapsed - P_CONNECT_END) / 1000);
    aiTarget = 0;
  } else if (phase === 2) {
    userTarget = 0;
    aiTarget = aiScript((elapsed - P_LISTEN_END) / 1000);
  } else {
    userTarget = 0;
    aiTarget = 0;
  }

  // Mirror the script onto the sliders, throttled: string writes are the only
  // allocating operation in this loop.
  if (now - domThrottle >= 60) {
    domThrottle = now;
    userAmpEl.value = String(userTarget);
    aiAmpEl.value = String(aiTarget);
    userAmpOut.textContent = userTarget.toFixed(2);
    aiAmpOut.textContent = aiTarget.toFixed(2);
  }
}

function startSimulation() {
  simStart = performance.now();
  simPhase = -1;
  domThrottle = 0;
  simBtn.dataset.running = 'true';
  simLabel.textContent = 'Stop simulation';
  setStatus('Simulating…');
}

function stopSimulation(message) {
  if (simStart < 0) return;
  simStart = -1;
  simPhase = -1;
  simBtn.dataset.running = 'false';
  simLabel.textContent = 'Simulate conversation';
  userTarget = 0;
  aiTarget = 0;
  userAmpEl.value = '0';
  aiAmpEl.value = '0';
  userAmpOut.textContent = '0.00';
  aiAmpOut.textContent = '0.00';
  if (message) setStatus(message);
}

function toggleSimulation() {
  if (simStart >= 0) {
    stopSimulation('Simulation stopped.');
    setState('Idle');
  } else {
    startSimulation();
  }
}

/* ----------------------------------------------------------- the pump ----- */
/* One rAF loop, feeding amplitudes and sampling fps. Zero allocation per frame
   apart from the throttled DOM text writes above and the 2 Hz fps readout. */

let rafId = 0;
let frames = 0;
let fpsMark = 0;
let pausedElapsed = -1;

function tick(now) {
  rafId = requestAnimationFrame(tick);

  frames++;
  if (now - fpsMark >= 500) {
    hudFps.textContent = ((frames * 1000) / (now - fpsMark)).toFixed(0);
    frames = 0;
    fpsMark = now;
  }

  if (simStart >= 0) advanceScript(now - simStart, now);

  injectUser(userTarget);
  injectAi(aiTarget);
}

function startPump() {
  if (rafId) return;
  fpsMark = performance.now();
  frames = 0;
  rafId = requestAnimationFrame(tick);
}

function stopPump() {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function onVisibility() {
  if (document.hidden) {
    if (simStart >= 0) pausedElapsed = performance.now() - simStart;
    stopPump();
    hudFps.textContent = '—';
  } else {
    if (pausedElapsed >= 0 && simStart >= 0) simStart = performance.now() - pausedElapsed;
    pausedElapsed = -1;
    startPump();
  }
}

/* ------------------------------------------------------------ teardown ---- */

let destroyed = false;
function destroy() {
  if (destroyed) return;
  destroyed = true;
  stopPump();
  simStart = -1;
  document.querySelector('.row.states').removeEventListener('click', onStateClick);
  userAmpEl.removeEventListener('input', onUserInput);
  aiAmpEl.removeEventListener('input', onAiInput);
  simBtn.removeEventListener('click', toggleSimulation);
  replayBtn.removeEventListener('click', onReplay);
  toggleOverlayBtn.removeEventListener('click', onToggleOverlay);
  window.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', destroy);
  try {
    if (typeof visualizer.destroy === 'function') visualizer.destroy();
  } catch { /* teardown must not throw */ }
  // The controller is OURS — we constructed it — and it owns two setInterval handles
  // that VoiceVisualizer.destroy() deliberately does not touch. Disposed second, so
  // zeroing its dampers cannot be read by a frame that has not been cancelled yet.
  try {
    if (controller && typeof controller.dispose === 'function') controller.dispose();
    else if (controller && typeof controller.stopMock === 'function') controller.stopMock();
  } catch { /* teardown must not throw */ }
}

/* ------------------------------------------------------------- wire up ---- */

document.querySelector('.row.states').addEventListener('click', onStateClick);
userAmpEl.addEventListener('input', onUserInput);
aiAmpEl.addEventListener('input', onAiInput);
simBtn.addEventListener('click', toggleSimulation);
replayBtn.addEventListener('click', onReplay);
toggleOverlayBtn.addEventListener('click', onToggleOverlay);
window.addEventListener('keydown', onKeyDown);
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', destroy);

window.__orbHarness = { visualizer, controller, StateEnum, destroy, setState, startSimulation, stopSimulation };

setState('Connecting');
startPump();
setStatus('Wired via ' + ctorUsed + ' · amplitudes → ' + sinkLabel + '.');
