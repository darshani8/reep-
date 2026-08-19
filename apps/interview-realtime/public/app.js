/**
 * REEP — AI Mock Interviewer: the browser client.
 *
 * One ES module, no dependencies, no build step. It is served by the same
 * FastAPI process that runs the relay, so the WebSocket is same-origin and the
 * OpenAI key never exists in this file's world — the browser talks to the relay,
 * the relay talks to OpenAI. Nothing here should ever be given a credential.
 *
 * Responsibilities, in the order they run:
 *   1. Start/End state machine over the DOM contract documented in index.html.
 *   2. getUserMedia + an AudioWorklet (created from a Blob URL so this file
 *      stays self-contained) that emits Int16 LE mono PCM at 24 kHz.
 *   3. Uplink framing to the relay, and a gapless playback scheduler for the
 *      interviewer's voice that can be flushed instantly on barge-in.
 *   4. Live status, transcript, mic meter, session clock, and a human message
 *      for every close code the relay can produce.
 */

/* ============================================================================
   Tunables. Every number here has a reason; none of them are inline literals.
   ========================================================================== */

/** The whole pipeline is 24 kHz mono PCM16 — mic, wire, and playback alike.
 *  Changing it means changing the relay's session.update too, so it is one
 *  constant rather than a value repeated at four call sites. */
const SAMPLE_RATE = 24000;

/** 40 ms = 960 frames = 1920 bytes per uplink message = 25 messages/s.
 *  20 ms doubles the message rate for latency the ear cannot hear; 100 ms adds
 *  a perceptible delay to server-VAD barge-in detection, because the server
 *  cannot see speech in audio we have not sent yet. */
const CHUNK_MS = 40;

/** Jitter buffer. The first buffer of a response is scheduled this far in the
 *  future so a chunk arriving 60 ms late still lands ahead of the play cursor.
 *  Below ~50 ms ordinary Wi-Fi underruns; above ~200 ms the interviewer feels
 *  laggy in a conversation that is supposed to be a real interview. */
const PLAYBACK_LEAD_S = 0.08;

/** De-click fade applied to everything still scheduled when the student barges
 *  in. Stopping a buffer mid-waveform is a step discontinuity, i.e. an audible
 *  click; 12 ms is inaudible as a fade and inaudible as a delay. */
const FLUSH_RAMP_S = 0.012;

/** Uplink backpressure ceiling. If the socket's send buffer exceeds this the
 *  network cannot keep up, and queueing more microphone audio only makes the
 *  interview more stale — it never makes it arrive. ~0.5 s of PCM16 at 24 kHz.
 *  Dropping here is the only place in this file that discards audio, and it is
 *  bounded and counted rather than silent. */
const MAX_UPLINK_BUFFERED_BYTES = 24000;

/** Mic meter refresh cap. Chunks arrive 25x/s; repainting a progressbar and
 *  rewriting aria-valuenow that often is pure main-thread cost for a bar the
 *  eye cannot resolve past ~15 Hz. */
const METER_MIN_INTERVAL_MS = 66;

/** Peak-hold decay for the meter, per second. A raw RMS reading flickers to
 *  zero between syllables and reads as a broken microphone; decaying the peak
 *  gives the bar the ballistics of a real VU meter. */
const METER_DECAY_PER_S = 2.2;

/** RMS of speech sits around 0.05-0.2, so a linear 0..1 bar barely moves.
 *  This maps RMS onto the meter with a compressive curve tuned so normal
 *  speaking voice lands in the middle of the bar. */
const METER_GAIN = 3.2;
const METER_CURVE = 0.65;

/** Session clock. Fallback only: the real cap is whatever the relay reports in
 *  `reep.ready.limits.session_max_seconds`, and the warning turns on two minutes
 *  early so the interview ending is expected rather than a mystery disconnect.
 *  This default is used solely until that event arrives (or if a relay omits
 *  it) — it is NOT authoritative, and reading the wrong field here is what made
 *  the clock display "/ 15:00" on a relay configured for ten minutes. */
const DEFAULT_SESSION_MAX_S = 900;
const SESSION_WARN_LEAD_S = 120;

/** Relay endpoint. Overridable so the page can be opened from the Angular dev
 *  server against a relay on another port without editing this file. */
const DEFAULT_WS_PATH = '/ws/interview';

/** Uplink framing.
 *
 *  'binary' — each 40 ms chunk is sent as a raw PCM binary frame and the relay
 *  base64-encodes it for OpenAI. This is the default because it removes one
 *  base64 encode per frame per session on the browser side and one decode on
 *  the relay side, and because the relay's own brief specifies binary uplink.
 *
 *  'base64' — the chunk is sent as a JSON text frame shaped exactly like the
 *  upstream event: {"type":"input_audio_buffer.append","audio":"<base64>"}.
 *
 *  The relay may pin either one by including `audio_uplink` in its ready event;
 *  that always wins over the default, so the two halves cannot disagree in
 *  production even if this default is wrong for a given deployment. */
const DEFAULT_UPLINK = 'binary';

/** Downstream audio is accepted in BOTH shapes regardless of the uplink choice:
 *  a binary frame is raw PCM, and these JSON event types carry base64 in
 *  `delta`. Both API generations are listed because a model change upstream
 *  must never silently mute the interviewer — beta emits response.audio.delta,
 *  GA emits response.output_audio.delta, and the payload is byte-identical. */
const AUDIO_DELTA_TYPES = new Set([
  'response.audio.delta',
  'response.output_audio.delta',
  'reep.audio.delta',
]);
const AUDIO_DONE_TYPES = new Set([
  'response.audio.done',
  'response.output_audio.done',
]);
const ASSISTANT_TRANSCRIPT_TYPES = new Set([
  'response.audio_transcript.delta',
  'response.output_audio_transcript.delta',
]);
const ASSISTANT_TRANSCRIPT_DONE_TYPES = new Set([
  'response.audio_transcript.done',
  'response.output_audio_transcript.done',
]);

/** Close codes the relay defines, mapped to wording a student can act on. The
 *  relay's own reason string is short by RFC 6455 (123 bytes) and written for
 *  an operator; these are written for the person in the chair. */
const CLOSE_MESSAGES = {
  1000: { tone: 'info', text: 'Interview ended.' },
  1006: {
    tone: 'error',
    text: 'The connection dropped. Check your network and start a new interview.',
  },
  1011: {
    tone: 'error',
    text: 'The interview service hit an internal error. Please start a new interview.',
  },
  // uvicorn fails every live WebSocket with 1012 when the process is asked to
  // stop and its own teardown outruns the relay's graceful drain. Without this
  // entry a routine deploy fell through to the generic branch and was reported
  // to the student, mid-question, as "closed unexpectedly" in an error state.
  1012: {
    tone: 'warn',
    text: 'The interview server is restarting. Start a new interview in a moment — nothing you said was lost.',
  },
  1013: {
    tone: 'warn',
    text: 'Too many interviews are running right now. Please try again in a few minutes.',
  },
  4001: {
    tone: 'error',
    text: 'The interview service is not configured on the server (no model credential). Ask your administrator to set it up.',
  },
  4002: {
    tone: 'error',
    text: 'The interview service is temporarily unavailable. Please try again shortly.',
  },
  // Reachable whenever this page is opened from an address the relay does not
  // recognise as its own or as a WEB_ORIGIN entry. It was missing entirely, so
  // the one close code with a precise, actionable cause read as "unexpectedly".
  4003: {
    tone: 'error',
    text: 'This page is not allowed to open an interview. Ask your administrator to add this address to WEB_ORIGIN on the relay.',
  },
  // No figure is hard-coded in either of these. Both caps are configurable on
  // the relay (IDLE_MAX_SECONDS, SESSION_MAX_SECONDS) and the relay already puts
  // the CONFIGURED figure into the close reason, which `detail: true` appends.
  // A ten-minute deployment used to tell students they had hit a fifteen-minute
  // limit after cutting them off at ten.
  4008: {
    tone: 'warn',
    text: 'No speech was heard for a while, so the session ended. Start a new interview when you are ready.',
    detail: true,
  },
  4009: {
    tone: 'info',
    text: 'You reached the session time limit. Start a new interview to continue practising.',
    detail: true,
  },
};

/* ============================================================================
   The AudioWorklet processor, as source.

   Inlined and loaded from a Blob URL so this client is a single file with no
   second asset to deploy, cache-bust, or 404. The cost is that the page's CSP
   must allow `blob:` in script-src/worker-src; the relay serves this page
   itself and sets no restrictive CSP, so that holds here.

   It runs on the audio rendering thread, where `sampleRate` is a global and
   nothing the main thread does can starve it. A ScriptProcessorNode would run
   this loop on the main thread behind layout and GC, and every jank would be
   *dropped* microphone samples — a clipped word the model then mishears.
   ========================================================================== */

const WORKLET_SRC = `
const DEFAULT_TARGET_RATE = 24000;
const DEFAULT_CHUNK_FRAMES = 960;

/** RBJ-cookbook 2nd-order Butterworth low-pass, transposed direct form II.
 *  Only used when downsampling: decimating without it folds everything above
 *  the new Nyquist back into the speech band as aliasing, which a model's
 *  transcriber hears as consonant mush. */
class Biquad {
  constructor(fc, fs) {
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = 0;
    this.z2 = 0;
  }
  processInPlace(buf) {
    let z1 = this.z1, z2 = this.z2;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
  }
}

class PcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || DEFAULT_TARGET_RATE;
    this.chunkFrames = o.chunkFrames || DEFAULT_CHUNK_FRAMES;

    // \`sampleRate\` is the AudioContext's ACTUAL rate. The constructor option is
    // a request, not a contract, so the resampling path must exist even though
    // it is dead code whenever the browser honoured 24 kHz.
    this.ratio = sampleRate / this.targetRate;
    this.needsResample = Math.abs(this.ratio - 1) > 1e-9;

    this.filters = [];
    if (this.ratio > 1) {
      const fc = 0.45 * this.targetRate;
      for (let i = 0; i < 3; i++) this.filters.push(new Biquad(fc, sampleRate));
    }

    this.pos = 1;   // fractional read cursor into [prev, ...input]
    this.prev = 0;  // last input sample of the previous render quantum
    this.scratch = null;

    this.acc = new Int16Array(this.chunkFrames);
    this.accLen = 0;
    this.running = true;

    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.emit();          // flush the partial chunk rather than lose it
        this.running = false; // process() returns false -> node is collectable
      }
    };
  }

  push(sample) {
    let s = sample;
    if (!(s === s)) s = 0;                 // NaN guard: one NaN would poison a chunk
    if (s > 1) s = 1; else if (s < -1) s = -1;
    // Clamp first, ALWAYS. Int16Array assignment wraps modulo 2^16, so an
    // unclamped 1.02 becomes -32114: a full-scale polarity inversion heard as a
    // loud click on every AGC transient. The 32768/32767 split is exact at both
    // rails (-1 -> -32768, +1 -> 32767) instead of overflowing the positive one.
    this.acc[this.accLen++] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    if (this.accLen === this.chunkFrames) this.emit();
  }

  emit() {
    if (this.accLen === 0) return;
    const out = new Int16Array(this.accLen);
    out.set(this.acc.subarray(0, this.accLen));
    this.accLen = 0;
    // Transferred, not copied. The buffer is freshly allocated each time, so
    // nothing on this side can observe the detached buffer.
    this.port.postMessage(out.buffer, [out.buffer]);
  }

  process(inputs) {
    if (!this.running) return false;

    const ch = inputs[0] && inputs[0][0];
    // No input connected yet, or a muted track: stay alive, emit nothing.
    if (!ch || ch.length === 0) return true;

    const n = ch.length;

    if (!this.needsResample) {
      for (let i = 0; i < n; i++) this.push(ch[i]);
      return true;
    }

    let src = ch;
    if (this.filters.length) {
      if (!this.scratch || this.scratch.length !== n) this.scratch = new Float32Array(n);
      this.scratch.set(ch);
      for (let f = 0; f < this.filters.length; f++) this.filters[f].processInPlace(this.scratch);
      src = this.scratch;
    }

    // Linear interpolation over a virtual buffer E where E[0] is the previous
    // quantum's last sample and E[k] = src[k-1]. Carrying \`pos\` across quanta
    // is what keeps the stream drift-free at non-integer ratios (44100/24000).
    let p = this.pos;
    const r = this.ratio;
    while (p < n) {
      const i = p | 0;
      const t = p - i;
      const a = i === 0 ? this.prev : src[i - 1];
      const b = src[i];
      this.push(a + (b - a) * t);
      p += r;
    }
    this.pos = p - n;
    this.prev = src[n - 1];
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
`;

/* ============================================================================
   Base64 <-> bytes.
   ========================================================================== */

/**
 * @param {Uint8Array} bytes
 * @returns {string} standard base64, padded, no line breaks
 */
function bytesToBase64(bytes) {
  let bin = '';
  // Chunked because String.fromCharCode.apply throws RangeError somewhere past
  // ~64k arguments. A 40 ms frame never reaches it; a coalesced buffer would.
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/**
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * RMS of a PCM16 LE buffer, 0..1. DataView rather than Int16Array because the
 * incoming buffer may be unaligned, and because LE is then explicit rather than
 * inherited from the platform.
 * @param {ArrayBuffer} buf
 * @returns {number}
 */
function rmsOfPcm16(buf) {
  const dv = new DataView(buf);
  const n = buf.byteLength >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = dv.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/* ============================================================================
   Microphone capture.
   ========================================================================== */

class MicCapture {
  /**
   * @param {AudioContext} ctx  shared with playback: one hardware clock, one
   *   resume, one close. The context is NOT owned here.
   * @param {{ onChunk: (pcm: ArrayBuffer) => void,
   *           onLevel?: (rms: number) => void,
   *           onError: (err: Error) => void }} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.opts = opts;
    /** @type {MediaStream | null} */ this.stream = null;
    /** @type {MediaStreamAudioSourceNode | null} */ this.source = null;
    /** @type {AudioWorkletNode | null} */ this.node = null;
    /** @type {GainNode | null} */ this.sink = null;
    this.stopped = true;
    /** @type {Promise<void> | null} */ this.starting = null;
  }

  /** Must be reached from a user gesture: getUserMedia and ctx.resume() both
   *  depend on one. Idempotent, and safe to interleave with stop(). */
  async start() {
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this._doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _doStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // This is not a code bug and must not be reported as one: mediaDevices is
      // undefined on any http:// origin other than localhost, which is exactly
      // what happens when someone opens the dev server from a phone by IP.
      throw new Error(
        'Microphone unavailable: open this page over HTTPS, or from localhost.',
      );
    }
    if (!this.ctx.audioWorklet) {
      throw new Error('This browser does not support AudioWorklet, which the interview needs.');
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Bare values, never `exact`: {sampleRate:{exact:24000}} throws
          // OverconstrainedError on most hardware and yields NO microphone at
          // all. As hints they are honoured where possible and ignored
          // otherwise, and the graph resamples either way.
          echoCancellation: true, // mandatory when the student is on speakers
          noiseSuppression: true, // hostel fan, keyboard, corridor noise
          autoGainControl: true,  // server VAD is far more level-sensitive than AGC-artefact-sensitive
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
        },
        video: false,
      });
      if (this.stopped) throw new DOMException('cancelled', 'AbortError');

      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_SRC], { type: 'application/javascript' }),
      );
      try {
        await this.ctx.audioWorklet.addModule(blobUrl);
      } finally {
        // Revoke as soon as the module is parsed, whether or not it parsed —
        // an un-revoked object URL lives as long as the document.
        URL.revokeObjectURL(blobUrl);
      }
      if (this.stopped) throw new DOMException('cancelled', 'AbortError');

      if (this.ctx.state !== 'running') await this.ctx.resume();
      if (this.stopped) throw new DOMException('cancelled', 'AbortError');

      const chunkFrames = Math.max(128, Math.round((CHUNK_MS * SAMPLE_RATE) / 1000));
      const node = new AudioWorkletNode(this.ctx, 'pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        // `channelCount: 1` on getUserMedia is only a hint and a stereo capture
        // device may ignore it. 'explicit' here is what actually guarantees the
        // processor sees one channel instead of silently sending half a mic.
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { targetRate: SAMPLE_RATE, chunkFrames },
      });

      node.port.onmessage = (e) => {
        if (this.stopped) return;
        /** @type {ArrayBuffer} */
        const buf = e.data;
        if (this.opts.onLevel) this.opts.onLevel(rmsOfPcm16(buf));
        this.opts.onChunk(buf);
      };
      node.onprocessorerror = () => {
        this.opts.onError(new Error('The audio processor stopped unexpectedly.'));
      };

      const source = this.ctx.createMediaStreamSource(stream);
      // A silent sink: some engines only pull a worklet that reaches the
      // destination. Gain 0 means the student never hears their own mic.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(this.ctx.destination);

      for (const track of stream.getAudioTracks()) {
        // Fires when the mic is unplugged or claimed exclusively by another
        // app. Without this the audio simply goes silent and looks like a bug
        // in the relay.
        track.onended = () => this.opts.onError(new Error('The microphone was disconnected.'));
      }

      this.stream = stream;
      this.source = source;
      this.node = node;
      this.sink = sink;
    } catch (err) {
      // Every failure path releases the microphone. Leaving it open would keep
      // the browser's recording indicator lit after a failed start, which users
      // reasonably read as spyware.
      if (stream) for (const t of stream.getTracks()) t.stop();
      throw err;
    }
  }

  /** Idempotent, and safe to call while start() is still in flight — the
   *  `stopped` checks after every await unwind that case. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;

    const { node, source, sink, stream } = this;
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;

    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      try {
        node.port.postMessage('stop');
        node.port.close();
      } catch {
        // The port is already closed (context torn down first). Nothing to do,
        // and nothing to report: the node is being discarded either way.
      }
      node.disconnect();
    }
    if (source) source.disconnect();
    if (sink) sink.disconnect();
    if (stream) {
      for (const t of stream.getTracks()) {
        t.onended = null;
        t.stop();
      }
    }
  }
}

/* ============================================================================
   Playback: a gapless scheduler on the AudioContext clock.
   ========================================================================== */

class PcmPlayer {
  /** @param {AudioContext} ctx  shared with capture; not owned here. */
  constructor(ctx) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    /** @type {Map<AudioBufferSourceNode, number>} node -> its scheduled start */
    this.live = new Map();
    this.cursor = 0;        // ctx-clock time the next buffer starts at
    this.scheduledSec = 0;  // audio scheduled since the last reset
    /** @type {Uint8Array | null} */ this.remainder = null;
    this.underruns = 0;
    this.closed = false;
  }

  /**
   * @param {ArrayBuffer | Uint8Array} pcm  raw PCM16 LE mono @ 24 kHz
   */
  enqueue(pcm) {
    if (this.closed) return;
    const buffer = this._toAudioBuffer(pcm);
    if (!buffer) return;

    const now = this.ctx.currentTime;
    if (this.cursor < now + 0.005) {
      // First buffer of a response, or we fell behind. Never schedule in the
      // past: start(t) with t < currentTime plays immediately AND truncates the
      // head of the buffer, so the student loses the first syllable and hears a
      // click. Re-arm the lead and count it instead.
      if (this.scheduledSec > 0) this.underruns++;
      this.cursor = now + PLAYBACK_LEAD_S;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    const startAt = this.cursor;
    src.onended = () => {
      this.live.delete(src);
      src.onended = null;
      src.disconnect();
    };
    src.start(startAt);
    this.live.set(src, startAt);

    this.cursor += buffer.duration;
    this.scheduledSec += buffer.duration;
  }

  /**
   * Barge-in. The relay sends audio faster than realtime, so at the moment the
   * student starts speaking most of the response is SCHEDULED but not played;
   * setting gain to zero would leave those nodes to talk over the student when
   * gain came back. They have to be stopped explicitly.
   */
  flush() {
    if (this.live.size === 0) {
      this._resetCursor();
      return;
    }
    const t = this.ctx.currentTime;
    const stopAt = t + FLUSH_RAMP_S;

    // Fade the CURRENT gain node out on the audio clock, then swap in a fresh
    // one, so the next response starts at unity even if it begins during the
    // fade. Ramping the shared node and reusing it would mute the next turn.
    const dying = this.gain;
    dying.gain.cancelScheduledValues(t);
    dying.gain.setValueAtTime(dying.gain.value, t);
    dying.gain.linearRampToValueAtTime(0, stopAt);

    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);

    const nodes = Array.from(this.live.entries());
    this.live.clear();
    let pending = nodes.length;
    const retire = () => {
      if (--pending <= 0) dying.disconnect();
    };

    for (const [node, startAt] of nodes) {
      node.onended = () => {
        node.onended = null;
        node.disconnect();
        retire();
      };
      try {
        // stopTime must be >= startTime. For a node whose start is still in the
        // future the two collapse to startAt, and per spec it then never
        // sounds — precisely the barge-in outcome we want.
        node.stop(Math.max(stopAt, startAt));
      } catch {
        // Already stopped or never started on this engine; retire it by hand so
        // the dying gain node is still released.
        node.onended = null;
        node.disconnect();
        retire();
      }
    }
    // Belt and braces: an engine that skips `ended` for a node that never
    // sounded would otherwise leak one GainNode per barge-in.
    setTimeout(() => {
      if (pending > 0) {
        pending = 0;
        dying.disconnect();
      }
    }, 1000);

    this._resetCursor();
  }

  /** The model finished an utterance normally: let the tail play out, but drop
   *  the cursor so the next response re-arms its own jitter buffer. */
  endResponse() {
    this._resetCursor();
  }

  /** True while any scheduled audio has not yet finished playing. */
  get isPlaying() {
    return this.live.size > 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.gain.disconnect();
    this.remainder = null;
  }

  _resetCursor() {
    this.cursor = 0;
    this.scheduledSec = 0;
    this.remainder = null;
  }

  /**
   * @param {ArrayBuffer | Uint8Array} pcm
   * @returns {AudioBuffer | null}
   */
  _toAudioBuffer(pcm) {
    let bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    if (this.remainder && this.remainder.length) {
      const joined = new Uint8Array(this.remainder.length + bytes.length);
      joined.set(this.remainder, 0);
      joined.set(bytes, this.remainder.length);
      bytes = joined;
      this.remainder = null;
    }
    const frames = bytes.length >> 1;
    // Nothing guarantees the relay frames on a sample boundary. An odd trailing
    // byte carried into the next chunk is one sample delayed; the same byte
    // dropped is a click and a permanent half-sample phase error.
    if (bytes.length & 1) this.remainder = bytes.slice(frames * 2);
    if (frames === 0) return null; // createBuffer(1, 0, rate) throws

    // 24 kHz is correct even if ctx.sampleRate is not: an AudioBufferSourceNode
    // resamples, and buffer.duration stays frames/24000, so all the scheduling
    // arithmetic above is independent of the hardware rate.
    const buffer = this.ctx.createBuffer(1, frames, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, frames * 2);
    for (let i = 0; i < frames; i++) {
      // Divide by 32768 for BOTH signs: -32768 maps to exactly -1.0 and 32767
      // to 0.99997, so decoding can never clip in the mixer.
      channel[i] = dv.getInt16(i * 2, true) / 32768;
    }
    return buffer;
  }
}

/* ============================================================================
   DOM handles. Resolved once; index.html declares this exact contract.
   ========================================================================== */

const el = {
  btnStart: document.getElementById('btn-start'),
  btnEnd: document.getElementById('btn-end'),
  pill: document.getElementById('status-pill'),
  statusText: document.getElementById('status-text'),
  clock: document.getElementById('session-clock'),
  timer: document.getElementById('session-timer'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
  bannerDismiss: document.getElementById('banner-dismiss'),
  caption: document.getElementById('stage-caption'),
  meter: document.getElementById('mic-meter'),
  meterValue: document.getElementById('mic-meter-value'),
  transcript: document.getElementById('transcript'),
  audioDiag: document.getElementById('audio-diag'),
};

/** Human wording for each state. The pill carries colour; this carries meaning.
 *  Both are always set together — colour alone is never a status in this repo. */
const STATE_LABELS = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  ready: 'Connected',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Interviewer speaking',
  ended: 'Session ended',
  error: 'Problem',
};

const STATE_CAPTIONS = {
  idle: 'Press Start Interview when you are ready.',
  connecting: 'Setting up your microphone and connecting…',
  ready: 'Connected. The interviewer will ask the first question shortly.',
  listening: 'Go ahead — the interviewer is listening.',
  thinking: 'Thinking about your answer…',
  speaking: 'Listen to the question. You can interrupt at any time.',
  ended: 'The session has ended. Start another whenever you like.',
  error: 'Something went wrong. See the message above.',
};

/* ============================================================================
   Small UI helpers.
   ========================================================================== */

/** @param {keyof typeof STATE_LABELS} state @param {string} [detail] */
function setState(state, detail) {
  el.pill.dataset.state = state;
  el.statusText.textContent = detail || STATE_LABELS[state] || state;
  el.caption.textContent = STATE_CAPTIONS[state] || '';
}

/** @param {'info'|'warn'|'error'} tone @param {string} text */
function showBanner(tone, text) {
  el.banner.dataset.tone = tone;
  el.bannerText.textContent = text;
  el.banner.hidden = false;
}

function hideBanner() {
  el.banner.hidden = true;
  el.bannerText.textContent = '';
}

/** @param {number} seconds */
function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Append or update one transcript line. Elements only, never bare text nodes:
 * the empty-state in index.html is `#transcript:empty`, which a stray
 * whitespace node would defeat.
 *
 * @param {string} key      stable id for a streaming turn ('' = always append)
 * @param {'interviewer'|'you'|'system'} role
 * @param {string} text
 * @param {boolean} partial still streaming (renders the caret)
 */
const transcriptRows = new Map();

function writeTranscript(key, role, text, partial) {
  // Measured BEFORE any mutation: only autoscroll when the student is already
  // at the bottom. Yanking the view while they re-read an earlier question is
  // worse than a new line they have to scroll to.
  const atBottom =
    el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 64;

  let row = key ? transcriptRows.get(key) : null;
  if (!row) {
    row = document.createElement('div');
    row.dataset.role = role;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent =
      role === 'interviewer' ? 'Interviewer' : role === 'you' ? 'You' : 'Session';
    const body = document.createElement('span');
    body.className = 'text';
    row.append(who, body);
    el.transcript.appendChild(row);
    if (key) transcriptRows.set(key, row);
  }
  row.dataset.partial = partial ? 'true' : 'false';
  const body = row.querySelector('.text');
  if (body) body.textContent = text;
  if (atBottom) el.transcript.scrollTop = el.transcript.scrollHeight;
}

/* ============================================================================
   Endpoint and framing configuration.
   ========================================================================== */

/** @returns {string} absolute ws:// or wss:// URL of the relay endpoint. */
function relayUrl() {
  const override = window.REEP_CONFIG && window.REEP_CONFIG.wsUrl;
  if (override) return new URL(override, location.href).href.replace(/^http/, 'ws');
  const params = new URLSearchParams(location.search);
  const path =
    params.get('ws') ||
    (window.REEP_CONFIG && window.REEP_CONFIG.wsPath) ||
    DEFAULT_WS_PATH;
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** @returns {'binary'|'base64'} */
function initialUplink() {
  const params = new URLSearchParams(location.search);
  const requested =
    params.get('uplink') || (window.REEP_CONFIG && window.REEP_CONFIG.uplink) || DEFAULT_UPLINK;
  return requested === 'base64' ? 'base64' : 'binary';
}

/* ============================================================================
   The session: one live interview. Everything mutable lives on an instance, so
   ending a session and starting another cannot inherit stale state.
   ========================================================================== */

class InterviewSession {
  constructor() {
    /** @type {WebSocket | null} */ this.ws = null;
    /** @type {AudioContext | null} */ this.ctx = null;
    /** @type {MicCapture | null} */ this.mic = null;
    /** @type {PcmPlayer | null} */ this.player = null;
    /** @type {number | null} */ this.clockTimer = null;
    /** @type {((this: AudioContext, ev: Event) => void) | null} */ this.onCtxState = null;

    this.uplink = initialUplink();
    this.startedAt = 0;
    this.sessionMaxS = DEFAULT_SESSION_MAX_S;
    /** Audio is dropped until the relay says it has configured the model —
     *  queueing it instead would be an unbounded buffer full of a student's
     *  voice, and the relay drops pre-ready frames anyway. */
    this.ready = false;
    this.ending = false;
    this.droppedChunks = 0;

    /** Streaming transcripts, keyed by the model's item id. Two maps, not one
     *  namespaced map: response.done finalises every assistant line, and a
     *  shared map would render the student's own half-transcribed answer as an
     *  interviewer turn. */
    this.assistantText = new Map();
    this.userText = new Map();
  }

  /* ---- lifecycle ------------------------------------------------------- */

  async start() {
    hideBanner();
    setState('connecting');
    this.startedAt = Date.now();
    this._startClock();

    // One AudioContext for capture and playback: one hardware clock (so the
    // playback scheduler and the mic agree on time), one resume from the click,
    // one close on teardown. Browsers also cap concurrent contexts, and a leak
    // shows up as "Failed to construct 'AudioContext'" around the seventh call.
    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      // Some engines throw NotSupportedError for a non-native rate; others
      // silently hand back the hardware rate. Only ctx.sampleRate is the truth,
      // and the worklet resamples from whatever it turns out to be.
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.onCtxState = () => {
      const ctx = this.ctx;
      if (!ctx || this.ending) return;
      if (ctx.state !== 'running') {
        // 'interrupted' is iOS (a phone call, Siri); 'suspended' also arrives
        // when the tab is backgrounded. Either way the scheduled cursor is now
        // meaningless, so drop the queued audio rather than play it late.
        if (this.player) this.player.flush();
        showBanner('warn', 'Audio was interrupted by the device. Return to this tab to continue.');
      }
    };
    this.ctx.onstatechange = this.onCtxState;

    this.player = new PcmPlayer(this.ctx);
    this.mic = new MicCapture(this.ctx, {
      onChunk: (pcm) => this._sendAudio(pcm),
      onLevel: (rms) => meter.push(rms),
      onError: (err) => this.fail(err.message),
    });

    try {
      await this.mic.start();
    } catch (err) {
      if (err && err.name === 'AbortError') return; // ended before start finished
      const message =
        err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
          ? 'Microphone access was blocked. Allow the microphone for this site, then start again.'
          : err && err.name === 'NotFoundError'
            ? 'No microphone was found. Connect one and start again.'
            : (err && err.message) || 'The microphone could not be started.';
      this.fail(message);
      return;
    }
    if (this.ending) return;

    if (el.audioDiag && this.ctx) {
      // The one diagnostic worth surfacing: a context that is not at 24 kHz
      // means the worklet is resampling, which is the first thing to check when
      // a student says the interviewer sounds wrong.
      const rate = Math.round(this.ctx.sampleRate);
      el.audioDiag.textContent = `${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)} kHz · ${CHUNK_MS} ms`;
    }

    this._openSocket();
  }

  _openSocket() {
    let ws;
    try {
      ws = new WebSocket(relayUrl());
    } catch {
      // Only a malformed URL reaches here (a bad ?ws= override); a refused
      // connection arrives later as a close event, not as a throw.
      this.fail('The interview address is invalid. Reload the page and try again.');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // Still 'connecting' for the student: the socket is open but the model is
      // not configured until the relay sends reep.ready, and speaking before
      // then would be audio nobody hears.
      setState('connecting', 'Preparing the interviewer…');
    };
    ws.onmessage = (event) => this._onMessage(event);
    ws.onerror = () => {
      // The Error event carries no detail by design (it would leak cross-origin
      // information). The close event that follows carries the code, so the
      // message is written there rather than duplicated here.
    };
    ws.onclose = (event) => this._onClose(event);
  }

  /** Student pressed End, or the page is going away. Always closes cleanly. */
  end(reason) {
    if (this.ending) return;
    this.ending = true;
    this.ready = false;
    this._teardown();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          // 1000 with a short reason: the relay logs it, and OpenAI's socket is
          // closed by the relay in the same teardown.
          ws.close(1000, reason || 'Ended by student');
        } catch {
          // Closing a socket still in CONNECTING throws on some engines; the
          // handles are already detached, so it is collected either way.
        }
      }
    }
  }

  /** An unrecoverable local problem (mic, worklet, address). */
  fail(message) {
    showBanner('error', message);
    setState('error', 'Problem');
    this.end('Client error');
    controller.onSessionOver();
  }

  /** Release audio resources. Idempotent; called from end() and from close. */
  _teardown() {
    this._stopClock();
    if (this.mic) {
      this.mic.stop();
      this.mic = null;
    }
    if (this.player) {
      this.player.close();
      this.player = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      ctx.onstatechange = null;
      // Fire-and-forget: close() is async but nothing after this depends on it,
      // and an engine that rejects a double close must not surface as an error
      // in the student's face.
      ctx.close().catch(() => undefined);
    }
    meter.reset();
    this.assistantText.clear();
    this.userText.clear();
    // Item ids are unique per session, but a map that is never cleared is an
    // unbounded one; the rows themselves stay on screen as history.
    transcriptRows.clear();
  }

  /* ---- uplink ---------------------------------------------------------- */

  /** @param {ArrayBuffer} pcm one 40 ms chunk, PCM16 LE mono @ 24 kHz */
  _sendAudio(pcm) {
    const ws = this.ws;
    if (!ws || !this.ready || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_UPLINK_BUFFERED_BYTES) {
      // The uplink cannot keep up. Buffering more only makes the interview more
      // stale; it never makes this audio arrive on time. Bounded and counted.
      this.droppedChunks++;
      if (this.droppedChunks === 1) {
        showBanner('warn', 'Your connection is struggling, so some audio is being skipped.');
      }
      return;
    }
    if (this.uplink === 'binary') {
      ws.send(pcm);
      return;
    }
    // Base64 uplink: the frame is assembled by concatenation rather than
    // JSON.stringify because base64's alphabet contains no character JSON would
    // escape, and at 25 frames/s the scan is pure waste.
    ws.send(
      '{"type":"input_audio_buffer.append","audio":"' +
        bytesToBase64(new Uint8Array(pcm)) +
        '"}',
    );
  }

  /* ---- downlink -------------------------------------------------------- */

  _onMessage(event) {
    // Binary frame = raw PCM from the relay, already decoded on the server so
    // the browser does not base64-decode 48 kB/s.
    if (event.data instanceof ArrayBuffer) {
      if (this.player) {
        this.player.enqueue(event.data);
        if (el.pill.dataset.state !== 'speaking') setState('speaking');
      }
      return;
    }
    if (typeof event.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      // A non-JSON text frame is a relay bug, not something the student can
      // act on. Ignoring it keeps the interview running.
      return;
    }
    const type = msg && msg.type;
    if (typeof type !== 'string') return;

    if (AUDIO_DELTA_TYPES.has(type)) {
      const b64 = msg.delta || msg.audio;
      if (typeof b64 === 'string' && b64 && this.player) {
        this.player.enqueue(base64ToBytes(b64));
        if (el.pill.dataset.state !== 'speaking') setState('speaking');
      }
      return;
    }

    if (AUDIO_DONE_TYPES.has(type)) {
      // Let the tail play out — endResponse only drops the scheduling cursor.
      if (this.player) this.player.endResponse();
      return;
    }

    if (ASSISTANT_TRANSCRIPT_TYPES.has(type)) {
      this._appendAssistantText(msg.item_id || msg.response_id || 'current', msg.delta || '', true);
      return;
    }

    if (ASSISTANT_TRANSCRIPT_DONE_TYPES.has(type)) {
      const key = msg.item_id || msg.response_id || 'current';
      const text = typeof msg.transcript === 'string' ? msg.transcript : this.assistantText.get(key);
      if (text) {
        this.assistantText.set(key, text);
        writeTranscript(`a:${key}`, 'interviewer', text, false);
      }
      return;
    }

    switch (type) {
      case 'reep.ready':
      case 'session.ready': {
        this.ready = true;
        if (msg.audio_uplink === 'base64' || msg.audio_uplink === 'binary') {
          // The relay is authoritative about its own framing; obeying it means
          // the two halves cannot disagree even if this file's default is wrong
          // for a deployment.
          this.uplink = msg.audio_uplink;
        }
        // The relay NESTS these under `limits`; reading them flat silently left
        // the clock on its built-in 900 s default, so a relay configured for ten
        // minutes counted past a cap it never displayed and cut the student off
        // with no two-minute warning. The flat form is kept as a fallback so an
        // older relay still drives the clock rather than reverting to a guess.
        const limits = msg.limits && typeof msg.limits === 'object' ? msg.limits : msg;
        if (Number.isFinite(limits.session_max_seconds) && limits.session_max_seconds > 0) {
          this.sessionMaxS = limits.session_max_seconds;
          this._renderCap();
        }
        setState('ready');
        writeTranscript('', 'system', 'Interview started. Speak naturally — you may interrupt.', false);
        break;
      }

      case 'input_audio_buffer.speech_started':
      case 'reep.audio.flush': {
        // Barge-in. Flush FIRST: the student is already talking over the
        // interviewer and every millisecond of unflushed queue is audible.
        if (this.player) this.player.flush();
        if (type === 'input_audio_buffer.speech_started') setState('listening');
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        setState('thinking');
        break;

      case 'response.created':
        setState('thinking');
        break;

      case 'response.done': {
        // Finalise any partial line so a completed answer never keeps a caret.
        for (const [key, text] of this.assistantText) {
          writeTranscript(`a:${key}`, 'interviewer', text, false);
        }
        this.assistantText.clear();
        if (!this.ending) setState('listening', 'Your turn');
        break;
      }

      case 'conversation.item.input_audio_transcription.delta': {
        const key = msg.item_id || 'you';
        const next = (this.userText.get(key) || '') + (msg.delta || '');
        this.userText.set(key, next);
        writeTranscript(`u:${key}`, 'you', next, true);
        break;
      }

      // Both names. The relay forwards the upstream event verbatim; the alias is
      // kept so a relay still emitting `reep.transcript.student` cannot silently
      // blank the "You" side of the transcript the way it used to.
      case 'reep.transcript.student':
      case 'conversation.item.input_audio_transcription.completed': {
        const key = msg.item_id || 'you';
        const text =
          typeof msg.transcript === 'string' ? msg.transcript : this.userText.get(key);
        this.userText.delete(key);
        if (text) writeTranscript(`u:${key}`, 'you', text, false);
        break;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        // The audio was still heard by the model; only the side transcript
        // failed. Say so on that line rather than leaving a caret blinking
        // forever on a turn that will never complete.
        const key = msg.item_id || 'you';
        this.userText.delete(key);
        writeTranscript(`u:${key}`, 'you', '(your answer could not be transcribed)', false);
        break;
      }

      case 'reep.warning':
        // The relay's idle watchdog is about to fire. A student who has gone
        // quiet while thinking deserves the chance to say something first.
        showBanner('warn', typeof msg.message === 'string' ? msg.message : 'No speech heard recently — the session will end soon if it stays quiet.');
        break;

      case 'reep.error':
      case 'error': {
        // Deliberately NOT msg.error.message: an upstream error string can echo
        // request content back at the page. The relay sends a coded, safe
        // message; anything else falls back to generic wording.
        const text =
          typeof msg.message === 'string'
            ? msg.message
            : 'The interviewer hit a problem with that turn. Keep going — it usually recovers.';
        showBanner('warn', text);
        break;
      }

      default:
        // Everything else in the Realtime vocabulary (item lifecycle, rate
        // limits, content parts) is tolerated, not handled. Silence is correct.
        break;
    }
  }

  _appendAssistantText(key, delta, partial) {
    if (!delta) return;
    const prev = this.assistantText.get(key) || '';
    const next = prev + delta;
    this.assistantText.set(key, next);
    writeTranscript(`a:${key}`, 'interviewer', next, partial);
  }

  _onClose(event) {
    this.ready = false;
    this.ws = null;
    this._teardown();

    const known = CLOSE_MESSAGES[event.code];
    if (this.ending) {
      // The student pressed End. Do not shout a banner at them for a close they
      // asked for; the transcript line is enough.
      setState('ended');
      writeTranscript('', 'system', 'Interview ended.', false);
    } else if (known) {
      // The relay fills the close reason with the CONFIGURED figure (e.g. "No
      // audio received for 2 minutes"). Appending it beats hard-coding a number
      // here that every deployment is free to change.
      const detail =
        known.detail && typeof event.reason === 'string' && event.reason.trim()
          ? ` (${event.reason.trim()})`
          : '';
      showBanner(known.tone, known.text + detail);
      setState(known.tone === 'error' ? 'error' : 'ended');
    } else {
      const reason = typeof event.reason === 'string' && event.reason ? ` (${event.reason})` : '';
      showBanner('error', `The interview connection closed unexpectedly${reason}. Start a new interview to continue.`);
      setState('error');
    }
    this.ending = true;
    controller.onSessionOver();
  }

  /* ---- session clock --------------------------------------------------- */

  _startClock() {
    this._renderCap();
    const tick = () => {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      el.timer.textContent = formatClock(elapsed);
      el.timer.setAttribute('datetime', `PT${Math.floor(elapsed)}S`);
      el.clock.dataset.warn = elapsed >= this.sessionMaxS - SESSION_WARN_LEAD_S ? 'true' : 'false';
    };
    tick();
    this.clockTimer = window.setInterval(tick, 1000);
  }

  _renderCap() {
    const cap = el.clock.querySelector('.cap');
    if (cap) cap.textContent = ` / ${formatClock(this.sessionMaxS)}`;
  }

  _stopClock() {
    if (this.clockTimer !== null) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }
}

/* ============================================================================
   Mic level meter. Owned outside the session so a level left over from a
   previous interview cannot bleed into the next one's first frame.
   ========================================================================== */

const meter = {
  level: 0,
  lastUpdate: 0,
  lastPaint: 0,
  /** @param {number} rms 0..1 */
  push(rms) {
    const shaped = Math.min(1, Math.pow(Math.min(1, rms * METER_GAIN), METER_CURVE));
    const now = performance.now();
    // dt is measured from the last UPDATE, not the last paint: paints are
    // throttled, and decaying by "time since last paint" on every chunk would
    // apply the same interval two or three times and collapse the bar.
    const dt = this.lastUpdate ? (now - this.lastUpdate) / 1000 : 0;
    this.lastUpdate = now;
    // Fast attack, slow release — the ballistics of a real VU meter. A raw RMS
    // reading drops to zero between syllables and reads as a dead microphone.
    this.level =
      shaped > this.level ? shaped : Math.max(shaped, this.level - METER_DECAY_PER_S * dt);
    if (now - this.lastPaint < METER_MIN_INTERVAL_MS) return;
    this.lastPaint = now;
    this._paint();
  },
  reset() {
    this.level = 0;
    this.lastUpdate = 0;
    this.lastPaint = 0;
    this._paint();
  },
  _paint() {
    const pct = Math.round(this.level * 100);
    el.meter.style.setProperty('--mic-level', String(this.level.toFixed(3)));
    el.meter.setAttribute('aria-valuenow', String(pct));
    if (el.meterValue) el.meterValue.textContent = `${pct}%`;
  },
};

/* ============================================================================
   Controller: owns the Start/End button state machine and exactly one session.
   ========================================================================== */

const controller = {
  /** @type {InterviewSession | null} */
  session: null,
  busy: false,

  async start() {
    if (this.session || this.busy) return;
    this.busy = true;
    this._buttons(false, true);
    const session = new InterviewSession();
    this.session = session;
    try {
      await session.start();
    } finally {
      this.busy = false;
      // start() may have already failed and cleared the session; only re-enable
      // End if this session is still the live one.
      if (this.session === session) this._buttons(false, true);
    }
  },

  end() {
    const session = this.session;
    if (!session) return;
    this._buttons(false, false); // no double-click while teardown runs
    session.end('Ended by student');
    setState('ended');
    this.onSessionOver();
  },

  /** Called from every path that finishes a session, including failures. */
  onSessionOver() {
    this.session = null;
    this.busy = false;
    this._buttons(true, false);
    meter.reset();
  },

  _buttons(startEnabled, endEnabled) {
    el.btnStart.disabled = !startEnabled;
    el.btnEnd.disabled = !endEnabled;
  },
};

/* ============================================================================
   Wiring.
   ========================================================================== */

el.btnStart.addEventListener('click', () => {
  // Not awaited: the click handler must return promptly so the gesture is not
  // held open across the getUserMedia prompt. Errors surface through fail().
  void controller.start();
});

el.btnEnd.addEventListener('click', () => controller.end());

el.bannerDismiss.addEventListener('click', () => hideBanner());

// pagehide covers tab close, navigation, and the mobile case where the page is
// frozen into the back/forward cache — beforeunload does not fire reliably on
// mobile. Without this the microphone indicator can stay lit after the tab is
// gone, and the relay holds a session slot until its own watchdog reclaims it.
window.addEventListener('pagehide', () => {
  if (controller.session) controller.session.end('Page closed');
});

document.addEventListener('visibilitychange', () => {
  // Backgrounding a tab suspends microphone capture on mobile, so the relay
  // would see no audio and eventually close on the idle cap. Say so rather than
  // letting it look like a crash.
  if (document.visibilityState === 'hidden' && controller.session) {
    showBanner('warn', 'Keep this tab open — microphone capture pauses when it is in the background.');
  }
});

if (!window.isSecureContext) {
  // Fail loudly and early: this is the single most common "the mic is broken"
  // report, and it is a deployment fact, not a runtime failure.
  el.btnStart.disabled = true;
  showBanner(
    'error',
    'This page must be served over HTTPS (or from localhost) before the microphone can be used.',
  );
  setState('error', 'Insecure connection');
} else {
  setState('idle');
}
