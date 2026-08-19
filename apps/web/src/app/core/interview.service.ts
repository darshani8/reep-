/**
 * InterviewService — the browser half of REEP's realtime AI mock interviewer.
 *
 * It owns ONE live interview: a WebSocket to `/api/interview`, an AudioWorklet that
 * captures 24 kHz mono PCM16 from the microphone, a gapless playback scheduler for the
 * interviewer's voice, and the barge-in flush that silences that scheduler the instant
 * the student talks over it. State comes out as Angular signals; nothing in here touches
 * the DOM beyond the AudioContext graph, so the component owns every pixel.
 *
 * This is a port of apps/interview-realtime/public/app.js into REEP's house style. The
 * audio code below is PHYSICS, not convention — the clamp-before-Int16 rule, the
 * anti-alias biquad, the odd-byte carry, the never-schedule-in-the-past guard and the
 * GainNode-swap flush were each derived from a real audible failure. Every one of those
 * reasons is written beside its constant. Adapting them means re-deriving them.
 *
 * THREE THINGS THAT ARE NOT OBVIOUS AND ARE LOAD-BEARING:
 *
 * 1. AUTH IS REEP'S, AND IT IS THE COOKIE. A browser WebSocket cannot set headers, so
 *    there is no Authorization to send — but it DOES send cookies on a same-origin
 *    connection. apps/web/proxy.conf.json maps `/api` to the FastAPI process with
 *    `"ws": true`, so this socket is same-origin to the page and the httpOnly,
 *    SameSite=Lax `reep_session` cookie rides the handshake. That is verified fact, not
 *    an assumption: a path outside `/api` would lose both the proxy and the cookie, and
 *    is why the URL below is built from `environment.apiBase` rather than hard-coded.
 *
 * 2. NO STUDENT RECORD REACHES THE MODEL. The Realtime session is a REMOTE provider.
 *    This client sends microphone audio and nothing else — never a mark, an attendance
 *    figure, a CGPA, a USN or any resume text. The interviewer persona is authored
 *    server-side and states that it cannot see the dashboard. If a future change wants
 *    to personalise the interview with a student fact, it does NOT go on this socket:
 *    it goes through complete_chat(..., carries_student_data=True) in
 *    apps/api-py/app/ai/llm.py, which is the egress gate (AGENTS.md rule 1).
 *
 * 3. A FAILED WEBSOCKET HANDSHAKE CARRIES NO CODE AND NO REASON. The browser reports it
 *    as a bare 1006, so "not signed in", "not a student" and "not configured" are
 *    indistinguishable from the socket alone. `GET /api/interview/status` is therefore
 *    consulted BEFORE connecting and is the discriminator — exactly the pattern
 *    `/api/voice/status` already sets in ChatVoiceService.startVoiceSession.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';

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

/** Mic-meter repaint cap. Chunks arrive 25x/s; the METER bar is a rendered DOM
 *  element, and repainting it that often is main-thread cost for motion the eye
 *  cannot resolve past ~15 Hz. The ORB is deliberately NOT throttled by this —
 *  `userRms` is published on every chunk, because it only moves a damper target
 *  inside the visualizer and the damper is what smooths it. */
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

/** Interviewer-amplitude sampling period, ms (20 Hz), and the analyser window.
 *
 *  Measured off an AnalyserNode on the PLAYBACK bus, not off arriving frames.
 *  The relay sends audio faster than realtime, so most of a response is
 *  scheduled-but-unplayed: an amplitude taken from the arriving bytes would
 *  swell the orb seconds before the student heard anything. 20 Hz is the rate
 *  VoiceVisualizer's own real-audio note specifies, and fftSize 512 at 24 kHz is
 *  a 21 ms window — long enough for a stable RMS, short enough to track a
 *  syllable. */
const AI_LEVEL_INTERVAL_MS = 50;
const AI_ANALYSER_FFT = 512;

/** Session clock fallback ONLY. The real cap is whatever the relay reports in
 *  `reep.ready.limits.session_max_seconds`; the warning turns on two minutes
 *  early so the interview ending is expected rather than a mystery disconnect.
 *  Reading the wrong field here is what made the clock display "/ 15:00" on a
 *  relay configured for ten minutes, so `limits` is read as a nested object. */
const DEFAULT_SESSION_MAX_S = 900;
const SESSION_WARN_LEAD_S = 120;

/** How long the UI may sit in `connecting` before giving up. Generous, because
 *  it spans the browser's own microphone prompt — which the student may take a
 *  while to answer — and must not cut a slow-but-working connection short.
 *  Matches ChatVoiceService's CONNECT_TIMEOUT_MS for the same reason. */
const CONNECT_TIMEOUT_MS = 30_000;

/* ============================================================================
   Wire vocabulary.

   The relay decodes the model's audio server-side and sends it DOWNSTREAM AS
   BINARY, so there is no base64 audio frame to handle here. The JSON names are
   listed in both API generations anyway: a model change upstream must never
   silently mute the interviewer — beta emits response.audio.*, GA emits
   response.output_audio.*, and the payloads are identical.
   ========================================================================== */

const AUDIO_DONE_TYPES: ReadonlySet<string> = new Set([
  'response.audio.done',
  'response.output_audio.done',
]);
const ASSISTANT_TRANSCRIPT_DELTA_TYPES: ReadonlySet<string> = new Set([
  'response.audio_transcript.delta',
  'response.output_audio_transcript.delta',
]);

export type NoticeTone = 'info' | 'warn' | 'error';

/**
 * Close codes the relay defines, mapped to wording a student can act on. The
 * relay's own reason string is clipped to 123 bytes by RFC 6455 and written for
 * an operator; these are written for the person in the chair.
 *
 * `detail: true` appends the relay's reason, because both cap figures are
 * configurable server-side (SESSION_MAX_SECONDS / IDLE_MAX_SECONDS) and the
 * relay puts the CONFIGURED figure in the reason. Hard-coding "15 minutes" here
 * told students they had hit a limit they had not.
 */
interface CloseMessage {
  readonly tone: NoticeTone;
  readonly text: string;
  readonly detail?: boolean;
}

const CLOSE_MESSAGES: ReadonlyMap<number, CloseMessage> = new Map<number, CloseMessage>([
  [1000, { tone: 'info', text: 'Interview ended.' }],
  [
    1006,
    {
      tone: 'error',
      text: 'The connection dropped. Check your network and start a new interview.',
    },
  ],
  // 1008 is the code FastAPI's own WebSocket handlers use for a policy refusal,
  // and the interview router reuses it for "no session" and "not a student".
  // Reachable only when the socket was ACCEPTED and then closed; a rejected
  // handshake reaches the browser as 1006 with no reason at all, which is
  // exactly why GET /api/interview/status is consulted first.
  [
    1008,
    {
      tone: 'error',
      text: 'Mock interviews are a student feature, and this session is not signed in as a student. Sign in again and retry.',
    },
  ],
  [
    1011,
    {
      tone: 'error',
      text: 'The interview service hit an internal error. Please start a new interview.',
    },
  ],
  // 1001 is what the relay sends when it is asked to stop and gets to close its
  // own sockets (_CLOSE_GOING_AWAY in app/interview_relay.py); 1012 is what
  // uvicorn sends when its teardown outruns that drain and it fails every live
  // WebSocket itself. BOTH mean the same thing to a student — a routine deploy —
  // and under uvicorn 1012 is in fact the usual one. Without these entries a
  // deploy was reported, mid-question, as "closed unexpectedly" in an error
  // state.
  [
    1001,
    {
      tone: 'warn',
      text: 'The interview server is restarting. Start a new interview in a moment — nothing you said was lost.',
    },
  ],
  [
    1012,
    {
      tone: 'warn',
      text: 'The interview server is restarting. Start a new interview in a moment — nothing you said was lost.',
    },
  ],
  [
    1013,
    {
      tone: 'warn',
      text: 'Too many interviews are running right now. Please try again in a few minutes.',
    },
  ],
  [
    4001,
    {
      tone: 'error',
      text: 'The interview service is not configured on the server (no model credential). Ask your administrator to set it up.',
    },
  ],
  [
    4002,
    {
      tone: 'error',
      text: 'The interview service is temporarily unavailable. Please try again shortly.',
    },
  ],
  // 4003: the interview router refused this page's Origin (it did not match the
  // server's WEB_ORIGIN). Always a deployment mistake and never something the
  // student can act on, so it must not read as a network blip they should retry.
  [
    4003,
    {
      tone: 'error',
      text: 'This page is not allowed to start an interview from its current address. Ask your administrator to check the server configuration.',
    },
  ],
  [
    4008,
    {
      tone: 'warn',
      text: 'No speech was heard for a while, so the session ended. Start a new interview when you are ready.',
      detail: true,
    },
  ],
  [
    4009,
    {
      tone: 'info',
      text: 'You reached the session time limit. Start a new interview to continue practising.',
      detail: true,
    },
  ],
]);

/* ============================================================================
   The AudioWorklet processor, as source.

   Inlined and loaded from a Blob URL so there is no second asset for the
   Angular build to copy, hash, cache-bust or 404. It runs on the audio
   rendering thread, where `sampleRate` is a global and nothing the main thread
   does can starve it. A ScriptProcessorNode would run this loop on the main
   thread behind layout and change detection, and every jank would be *dropped*
   microphone samples — a clipped word the model then mishears.
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
   Public types.
   ========================================================================== */

/**
 * Explicit lifecycle of one interview. Driven by relay events, never inferred:
 *   idle        no session
 *   connecting  mic starting, socket opening, model not configured yet
 *   ready       the relay has configured the model; the first question is coming
 *   listening   the student's turn
 *   thinking    the student stopped; the model has not started replying
 *   speaking    the interviewer's audio is playing
 *   ended       the session closed
 *   error       the session failed to start or dropped unrecoverably
 */
export type InterviewState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'ended'
  | 'error';

export interface InterviewNotice {
  tone: NoticeTone;
  text: string;
}

/** One rendered transcript line. `key` is stable so a streaming turn updates in
 *  place instead of appending a near-duplicate on every delta. */
export interface InterviewLine {
  key: string;
  role: 'interviewer' | 'you' | 'session';
  text: string;
  /** Still streaming — the template renders a caret. */
  partial: boolean;
}

interface InterviewStatus {
  available: boolean;
  reason?: string;
}

/* ============================================================================
   PCM helpers.
   ========================================================================== */

/**
 * RMS of a PCM16 LE buffer, 0..1. DataView rather than Int16Array because the
 * incoming buffer may be unaligned, and because LE is then explicit rather than
 * inherited from the platform.
 */
function rmsOfPcm16(buf: ArrayBuffer): number {
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

/** RMS of a float time-domain window, 0..1. */
function rmsOfFloat(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/* ============================================================================
   Microphone capture.
   ========================================================================== */

interface MicCaptureOptions {
  onChunk: (pcm: ArrayBuffer) => void;
  onLevel: (rms: number) => void;
  onError: (err: Error) => void;
}

class MicCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private stopped = true;
  private starting: Promise<void> | null = null;

  /**
   * @param ctx shared with playback: one hardware clock, one resume, one close.
   *            The context is NOT owned here.
   */
  constructor(
    private readonly ctx: AudioContext,
    private readonly opts: MicCaptureOptions,
  ) {}

  /** Must be reached from a user gesture: getUserMedia and ctx.resume() both
   *  depend on one. Idempotent, and safe to interleave with stop(). */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopped = false;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      // Not a code bug and must not be reported as one: mediaDevices is
      // undefined on any http:// origin other than localhost, which is exactly
      // what happens when someone opens `ng serve` from a phone by IP.
      throw new Error('Microphone unavailable: open REEP over HTTPS, or from localhost.');
    }
    if (!this.ctx.audioWorklet) {
      throw new Error('This browser does not support AudioWorklet, which the interview needs.');
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Bare values, never `exact`: {sampleRate:{exact:24000}} throws
          // OverconstrainedError on most hardware and yields NO microphone at
          // all. As hints they are honoured where possible and ignored
          // otherwise, and the graph resamples either way.
          echoCancellation: true, // mandatory when the student is on speakers
          noiseSuppression: true, // hostel fan, keyboard, corridor noise
          autoGainControl: true, // server VAD is far more level-sensitive than AGC-artefact-sensitive
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
        // Revoke as soon as the module is parsed, whether or not it parsed — an
        // un-revoked object URL lives as long as the document.
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

      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (this.stopped) return;
        this.opts.onLevel(rmsOfPcm16(e.data));
        this.opts.onChunk(e.data);
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
  stop(): void {
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
  /**
   * The PERSISTENT output bus.
   *
   * flush() swaps the per-response GainNode (see below), so nothing downstream
   * can hold a stable reference to `gain`. The analyser that drives the orb's
   * "interviewer speaking" swell needs exactly such a reference — and it must
   * tap what is actually AUDIBLE, not what has arrived — so every response gain
   * feeds this one node, and this one node feeds the destination.
   */
  readonly out: GainNode;

  private gain: GainNode;
  /** node -> its scheduled start time on the ctx clock. */
  private readonly live = new Map<AudioBufferSourceNode, number>();
  private cursor = 0;
  private scheduledSec = 0;
  private remainder: Uint8Array | null = null;
  private closed = false;
  /** Times the scheduler fell behind the play cursor mid-response. Diagnostics
   *  only — but counted rather than swallowed, because "the interviewer sounds
   *  choppy" has no other observable cause on this side of the wire. */
  private underruns = 0;

  /** @param ctx shared with capture; not owned here. */
  constructor(private readonly ctx: AudioContext) {
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.gain = ctx.createGain();
    this.gain.connect(this.out);
  }

  /** @param pcm raw PCM16 LE mono @ 24 kHz */
  enqueue(pcm: ArrayBuffer | Uint8Array): void {
    if (this.closed) return;
    const buffer = this.toAudioBuffer(pcm);
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
  flush(): void {
    if (this.live.size === 0) {
      this.resetCursor();
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
    this.gain.connect(this.out);

    const nodes = [...this.live.entries()];
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

    this.resetCursor();
  }

  /** The model finished an utterance normally: let the tail play out, but drop
   *  the cursor so the next response re-arms its own jitter buffer. */
  endResponse(): void {
    this.resetCursor();
  }

  /** True while any scheduled audio has not yet finished playing. */
  get isPlaying(): boolean {
    return this.live.size > 0;
  }

  /** How many times this player fell behind. See `underruns`. */
  get underrunCount(): number {
    return this.underruns;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.gain.disconnect();
    this.out.disconnect();
    this.remainder = null;
  }

  private resetCursor(): void {
    this.cursor = 0;
    this.scheduledSec = 0;
    this.remainder = null;
  }

  private toAudioBuffer(pcm: ArrayBuffer | Uint8Array): AudioBuffer | null {
    let bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    if (this.remainder?.length) {
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
   The service.
   ========================================================================== */

@Injectable({ providedIn: 'root' })
export class InterviewService {
  private readonly http = inject(HttpClient);

  // ------------------------------------------------------------------ //
  // Reactive surface                                                   //
  // ------------------------------------------------------------------ //

  private readonly _state = signal<InterviewState>('idle');
  /** Explicit lifecycle of the live interview. */
  readonly state = this._state.asReadonly();

  private readonly _detail = signal<string | null>(null);
  /** Overrides the state's default label when there is something more precise
   *  to say ("Preparing the interviewer…"). */
  readonly detail = this._detail.asReadonly();

  private readonly _notice = signal<InterviewNotice | null>(null);
  /** A dismissible banner: why the session ended, or what is degrading it. */
  readonly notice = this._notice.asReadonly();

  private readonly _lines = signal<InterviewLine[]>([]);
  /** The live transcript of THIS session. The durable copy is written by the
   *  server into the shared conversation and re-read from /api/agent/history. */
  readonly lines = this._lines.asReadonly();

  private readonly _userRms = signal(0);
  /**
   * Raw microphone RMS, 0..1, published every 40 ms chunk.
   *
   * Deliberately RAW, not an already-mapped 0..1 "amplitude": the perceptual dB
   * curve lives on MockAudioStreamController.mapRmsToAmplitude in
   * shared/voice-visualizer.ts, which documents it and is its single source of
   * truth. Duplicating the formula here would give the orb two definitions of
   * loud that could drift apart.
   */
  readonly userRms = this._userRms.asReadonly();

  private readonly _aiRms = signal(0);
  /** Interviewer RMS, 0..1, measured at 20 Hz on the PLAYBACK bus so it tracks
   *  what is audible rather than what has arrived. Same mapping note as above. */
  readonly aiRms = this._aiRms.asReadonly();

  private readonly _micLevel = signal(0);
  /** VU-ballistic 0..1 for the mic meter bar (throttled; see METER_MIN_INTERVAL_MS). */
  readonly micLevel = this._micLevel.asReadonly();

  private readonly _elapsedSeconds = signal(0);
  readonly elapsedSeconds = this._elapsedSeconds.asReadonly();

  private readonly _sessionMaxSeconds = signal(DEFAULT_SESSION_MAX_S);
  readonly sessionMaxSeconds = this._sessionMaxSeconds.asReadonly();

  private readonly _completedSessions = signal(0);
  /** Bumped once per finished session. The component watches it to re-read the
   *  persisted conversation, which is where interview turns actually live. */
  readonly completedSessions = this._completedSessions.asReadonly();

  /** True from the moment Start is pressed until the socket is fully closed. */
  readonly active = computed(() => {
    const s = this._state();
    return s !== 'idle' && s !== 'ended' && s !== 'error';
  });

  /** mm:ss elapsed. */
  readonly clockLabel = computed(() => formatClock(this._elapsedSeconds()));
  /** mm:ss cap, as reported by the relay. */
  readonly capLabel = computed(() => formatClock(this._sessionMaxSeconds()));
  /** Within two minutes of the cap — warn before it cuts the student off. */
  readonly clockWarning = computed(
    () => this._elapsedSeconds() >= this._sessionMaxSeconds() - SESSION_WARN_LEAD_S,
  );

  /**
   * getUserMedia and AudioWorklet both require a secure context. Read once: it
   * is a deployment fact, not a runtime condition, and the single most common
   * "the mic is broken" report is `ng serve` opened from a phone by IP.
   */
  readonly secureContext = window.isSecureContext;

  // ------------------------------------------------------------------ //
  // Session-scoped state                                               //
  // ------------------------------------------------------------------ //

  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MicCapture | null = null;
  private player: PcmPlayer | null = null;
  private aiAnalyser: AnalyserNode | null = null;
  private readonly aiWindow = new Float32Array(AI_ANALYSER_FFT);

  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private aiLevelTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pageHideHandler: (() => void) | null = null;

  /**
   * Identifies the current start attempt. Bumped by teardown() and by each new
   * start(), so an in-flight start can tell it has been superseded — the same
   * discipline ChatVoiceService.startVoiceSession uses, and for the same reason:
   * every `await` below is a point at which the student may have pressed End,
   * and without it the superseded attempt goes on to open a socket and a
   * microphone that nothing holds a handle to.
   */
  private sessionGen = 0;

  private startedAt = 0;
  /** Audio is dropped until the relay says the model is configured. Queueing it
   *  instead would be an unbounded buffer full of a student's voice, and the
   *  relay drops pre-ready frames anyway. */
  private ready = false;
  private ending = false;
  private droppedChunks = 0;

  /** Meter ballistics — owned here so a level left over from a previous
   *  interview cannot bleed into the next one's first frame. */
  private meterLevel = 0;
  private meterLastUpdate = 0;
  private meterLastPaint = 0;

  /** Streaming interviewer transcript, keyed by response id, plus a counter for
   *  system lines (which carry no upstream id but still need a stable key). */
  private readonly assistantText = new Map<string, string>();
  private systemLineSeq = 0;

  // ------------------------------------------------------------------ //
  // Lifecycle                                                          //
  // ------------------------------------------------------------------ //

  /**
   * Open one interview. MUST be called from a user gesture — getUserMedia and
   * AudioContext.resume() both require one.
   *
   * Resolves once the socket has been opened, or once the attempt has failed;
   * the interview itself then proceeds over the signals above. It never throws:
   * every failure lands in `state === 'error'` with a `notice` the student can
   * act on, which is the only terminal state Start is offered from again.
   */
  async start(): Promise<void> {
    if (this.active()) return;

    if (!this.secureContext) {
      this.fail(
        'REEP must be open over HTTPS (or from localhost) before the microphone can be used.',
      );
      return;
    }

    // Fresh session — clear residue from a prior attempt. teardown() bumps
    // sessionGen, so this MUST come before the generation is captured.
    this.teardown();
    const gen = ++this.sessionGen;
    const cancelled = () => gen !== this.sessionGen;

    this._notice.set(null);
    this._lines.set([]);
    this._state.set('connecting');
    this._detail.set(null);
    this._elapsedSeconds.set(0);
    this._sessionMaxSeconds.set(DEFAULT_SESSION_MAX_S);
    this.droppedChunks = 0;
    this.ready = false;
    this.ending = false;
    this.assistantText.clear();

    // Release the microphone if the tab closes or the browser navigates away.
    // Nothing else covers that path — ngOnDestroy does not run on tab close —
    // and without it the recording indicator stays lit on a page that is gone.
    // pagehide, NOT visibilitychange: tabbing away mid-interview is normal.
    this.pageHideHandler = () => this.end('Page closed');
    window.addEventListener('pagehide', this.pageHideHandler);

    // Nothing below may hang forever. A wedged uvicorn is a documented failure
    // mode on this platform (AGENTS.md), and it used to park the UI on
    // "Connecting…" with no way out but a page reload.
    this.connectTimer = setTimeout(() => {
      if (cancelled()) return;
      if (this._state() === 'connecting') {
        this.fail('The interview took too long to connect. Press Start to try again.');
      }
    }, CONNECT_TIMEOUT_MS);

    // 1) Readiness. A rejected WebSocket handshake reaches the browser as a bare
    //    1006 with no code and no reason, so this HTTP probe is the ONLY place
    //    the student can be told *why* — not configured, not signed in, not a
    //    student. An unreachable or unrecognised probe is treated as "unknown"
    //    and the socket is attempted anyway: refusing to start because a
    //    diagnostic endpoint 404'd would be a worse failure than the one it
    //    exists to report.
    try {
      const status = await firstValueFrom(
        this.http.get<InterviewStatus>(`${environment.apiBase}/interview/status`, {
          withCredentials: true,
        }),
      );
      if (cancelled()) return;
      if (status?.available === false) {
        this.fail(status.reason ?? 'Mock interviews are not available right now.');
        return;
      }
    } catch {
      /* probe unavailable — fall through and let the socket speak for itself */
    }
    if (cancelled()) return;

    // 2) Audio graph. ONE AudioContext for capture and playback: one hardware
    //    clock (so the playback scheduler and the mic agree on time), one resume
    //    from the click, one close on teardown. Browsers also cap concurrent
    //    contexts, and a leak shows up as a constructor failure around the
    //    seventh interview of a session.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      // Some engines throw NotSupportedError for a non-native rate; others
      // silently hand back the hardware rate. Only ctx.sampleRate is the truth,
      // and the worklet resamples from whatever it turns out to be.
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;
    ctx.onstatechange = () => {
      if (this.ctx !== ctx || this.ending) return;
      if (ctx.state !== 'running') {
        // 'interrupted' is iOS (a phone call, Siri); 'suspended' also arrives
        // when the tab is backgrounded. Either way the scheduled cursor is now
        // meaningless, so drop the queued audio rather than play it late.
        this.player?.flush();
        this._notice.set({
          tone: 'warn',
          text: 'Audio was interrupted by the device. Return to this tab to continue.',
        });
      }
    };

    const player = new PcmPlayer(ctx);
    this.player = player;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = AI_ANALYSER_FFT;
    player.out.connect(analyser);
    this.aiAnalyser = analyser;

    // Held in a LOCAL as well as on `this`. A concurrent teardown() nulls the
    // field, and the cancellation branch below would then dereference null on
    // the one path it exists to clean up. MicCapture.stop() is idempotent, so
    // stopping through the local is safe even when teardown already stopped it.
    const mic = new MicCapture(ctx, {
      onChunk: (pcm) => this.sendAudio(pcm),
      onLevel: (rms) => this.pushLevel(rms),
      onError: (err) => this.fail(err.message),
    });
    this.mic = mic;

    try {
      await mic.start();
    } catch (err) {
      mic.stop();
      if (cancelled()) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.fail(describeMicError(err));
      return;
    }
    if (cancelled()) {
      // The permission prompt can sit open a long time; the student may have
      // pressed End before granting it. teardown() has already run and dropped
      // its reference, so release what this superseded attempt just built.
      mic.stop();
      return;
    }

    // 3) Socket. The cookie rides it because /api is same-origin — through the
    //    dev proxy in development (proxy.conf.json, "ws": true) and by
    //    deployment in production.
    this.startClock();
    this.startAiLevelSampling();
    this.openSocket();
  }

  /** Student pressed End, or the page is going away. Always closes cleanly. */
  end(reason = 'Ended by student'): void {
    // Nothing live and nothing to close: return WITHOUT writing a terminal
    // state. Otherwise merely navigating away from an idle screen would stamp
    // "Interview ended.", bump completedSessions, and make the component re-read
    // a conversation that has not changed.
    if (!this.active() && this.ws === null) return;
    this.ending = true;
    this.ready = false;

    const ws = this.ws;
    this.ws = null;
    this.teardown();

    if (ws) {
      // Detach BEFORE closing: onClose must not run for a close we asked for,
      // or the student gets a banner for their own button press.
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          // 1000 with a short reason: the relay logs it, persists what it has,
          // and closes its own upstream socket in the same teardown.
          ws.close(1000, reason);
        } catch {
          // Closing a socket still in CONNECTING throws on some engines; the
          // handlers are already detached, so it is collected either way.
        }
      }
    }

    this._state.set('ended');
    this._detail.set(null);
    this.writeLine(this.nextSystemKey(), 'session', 'Interview ended.', false);
    this._completedSessions.update((n) => n + 1);
  }

  /** Dismiss the banner without touching the session. */
  dismissNotice(): void {
    this._notice.set(null);
  }

  // ------------------------------------------------------------------ //
  // Uplink                                                             //
  // ------------------------------------------------------------------ //

  /** @param pcm one 40 ms chunk, PCM16 LE mono @ 24 kHz */
  private sendAudio(pcm: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || !this.ready || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_UPLINK_BUFFERED_BYTES) {
      // The uplink cannot keep up. Buffering more only makes the interview more
      // stale; it never makes this audio arrive on time. Bounded and counted —
      // the only place in this file that discards audio.
      this.droppedChunks++;
      if (this.droppedChunks === 1) {
        this._notice.set({
          tone: 'warn',
          text: 'Your connection is struggling, so some audio is being skipped.',
        });
      }
      return;
    }
    // Binary only. The relay's base64 uplink exists to survive an intermediary
    // that mangles binary frames; REEP's proxy does not, and halving the
    // accepted-input surface halves the bounds-checking that has to be right.
    ws.send(pcm);
  }

  // ------------------------------------------------------------------ //
  // Socket                                                             //
  // ------------------------------------------------------------------ //

  private socketUrl(): string {
    // Built from environment.apiBase, never hard-coded: a path outside /api
    // loses both the dev proxy and — being cross-origin — the reep_session
    // cookie this handshake authenticates with.
    const url = new URL(`${environment.apiBase}/interview`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  private openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.socketUrl());
    } catch {
      // Only a malformed URL reaches here; a refused connection arrives later as
      // a close event, not as a throw.
      this.fail('The interview address is invalid. Reload the page and try again.');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // Still "connecting" for the student: the socket is open but the model is
      // not configured until the relay sends reep.ready, and speaking before
      // then would be audio nobody hears.
      this._detail.set('Preparing the interviewer…');
    };
    ws.onmessage = (event: MessageEvent) => this.onMessage(event);
    ws.onerror = () => {
      // The Error event carries no detail by design (it would leak cross-origin
      // information). The close event that follows carries the code, so the
      // message is written there rather than duplicated here.
    };
    ws.onclose = (event: CloseEvent) => this.onClose(event);
  }

  private onMessage(event: MessageEvent): void {
    // Binary frame = raw PCM from the relay, already decoded server-side so the
    // browser does not base64-decode 48 kB/s.
    if (event.data instanceof ArrayBuffer) {
      this.player?.enqueue(event.data);
      if (this._state() !== 'speaking') this.setState('speaking');
      return;
    }
    if (typeof event.data !== 'string') return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      // A non-JSON text frame is a relay bug, not something the student can act
      // on. Ignoring it keeps the interview running.
      return;
    }
    const type = str(msg['type']);
    if (!type) return;

    if (AUDIO_DONE_TYPES.has(type)) {
      // Let the tail play out — endResponse only drops the scheduling cursor.
      this.player?.endResponse();
      return;
    }

    if (ASSISTANT_TRANSCRIPT_DELTA_TYPES.has(type)) {
      const key = str(msg['response_id']) ?? str(msg['item_id']) ?? 'current';
      const delta = str(msg['delta']);
      if (!delta) return;
      const next = (this.assistantText.get(key) ?? '') + delta;
      this.assistantText.set(key, next);
      this.writeLine(`a:${key}`, 'interviewer', next, true);
      return;
    }

    switch (type) {
      case 'reep.ready': {
        this.ready = true;
        this.clearConnectTimer();
        // The relay NESTS these under `limits`. Reading them flat silently left
        // the clock on its built-in 900 s default, so a relay configured for ten
        // minutes counted past a cap it never displayed and cut the student off
        // with no two-minute warning.
        const cap = num(obj(msg['limits'])?.['session_max_seconds']);
        if (cap !== null && cap > 0) this._sessionMaxSeconds.set(cap);
        this.setState('ready');
        this.writeLine(
          this.nextSystemKey(),
          'session',
          'Interview started. Speak naturally — you may interrupt.',
          false,
        );
        break;
      }

      case 'input_audio_buffer.speech_started':
      case 'reep.audio.flush': {
        // Barge-in. Flush FIRST: the student is already talking over the
        // interviewer and every millisecond of unflushed queue is audible.
        this.player?.flush();
        if (type === 'input_audio_buffer.speech_started') this.setState('listening');
        break;
      }

      case 'input_audio_buffer.speech_stopped':
      case 'response.created':
        this.setState('thinking');
        break;

      case 'response.done': {
        // Finalise every partial line so a completed answer never keeps a caret.
        // The relay does not forward response.audio_transcript.done, so this
        // sweep is the ONLY thing that de-carets an interviewer turn.
        for (const [key, text] of this.assistantText) {
          this.writeLine(`a:${key}`, 'interviewer', text, false);
        }
        this.assistantText.clear();
        if (!this.ending) this.setState('listening');
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        // Final only — the relay's allowlist forwards neither the delta nor the
        // failed variant, so there is no partial student line to reconcile.
        const key = str(msg['item_id']) ?? 'you';
        const text = str(msg['transcript']);
        if (text) this.writeLine(`u:${key}`, 'you', text, false);
        break;
      }

      case 'reep.error': {
        // The relay sends {scope, code, param} and deliberately NO message, so
        // an upstream error string can never echo request content back into the
        // page. Report the code — an operator can look it up — and keep the
        // interview running, because most turn-level errors recover.
        const code = str(msg['code']);
        this._notice.set({
          tone: 'warn',
          text: code
            ? `The interviewer hit a problem with that turn (${code}). Keep going — it usually recovers.`
            : 'The interviewer hit a problem with that turn. Keep going — it usually recovers.',
        });
        break;
      }

      default:
        // Everything else in the Realtime vocabulary (item lifecycle, rate
        // limits, content parts) is tolerated, not handled. Silence is correct.
        break;
    }
  }

  private onClose(event: CloseEvent): void {
    // Captured BEFORE the reset: a session that never reached `reep.ready`
    // produced no turns, so there is nothing new for the component to re-read.
    // Bumping regardless meant every failed connect (a 1006 against a wedged
    // server, a refused origin) sent the assistant screen back to
    // GET /api/agent/history for a session that wrote nothing.
    const produced = this.ready;
    this.ready = false;
    this.ws = null;
    this.ending = true;
    this.teardown();

    const known = CLOSE_MESSAGES.get(event.code);
    if (known) {
      // The relay fills the close reason with the CONFIGURED figure (e.g. "No
      // audio received for 2 minutes"). Appending it beats hard-coding a number
      // here that every deployment is free to change.
      const detail = known.detail && event.reason.trim() ? ` (${event.reason.trim()})` : '';
      this._notice.set({ tone: known.tone, text: known.text + detail });
      this._state.set(known.tone === 'error' ? 'error' : 'ended');
    } else {
      const reason = event.reason ? ` (${event.reason})` : '';
      this._notice.set({
        tone: 'error',
        text: `The interview connection closed unexpectedly${reason}. Start a new interview to continue.`,
      });
      this._state.set('error');
    }
    this._detail.set(null);
    if (produced) this._completedSessions.update((n) => n + 1);
  }

  // ------------------------------------------------------------------ //
  // Internals                                                          //
  // ------------------------------------------------------------------ //

  private setState(next: InterviewState): void {
    this._state.set(next);
    this._detail.set(null);
  }

  /** An unrecoverable local problem (secure context, mic, worklet, readiness). */
  private fail(message: string): void {
    this.ending = true;
    const ws = this.ws;
    this.ws = null;
    this.teardown();
    if (ws) {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000, 'Client error');
      } catch {
        /* already closing — the handlers are detached either way */
      }
    }
    this._notice.set({ tone: 'error', text: message });
    this._state.set('error');
    this._detail.set(null);
  }

  /**
   * Release every audio resource and timer. Idempotent, safe from synchronous
   * error paths, and deliberately does NOT set a terminal state — the caller
   * owns that, exactly as ChatVoiceService.teardown does.
   */
  private teardown(): void {
    // Invalidate any start attempt still in flight, so it cannot resurrect the
    // session after this teardown has run.
    this.sessionGen++;

    if (this.pageHideHandler) {
      window.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
    this.clearConnectTimer();
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.aiLevelTimer !== null) {
      clearInterval(this.aiLevelTimer);
      this.aiLevelTimer = null;
    }
    if (this.mic) {
      this.mic.stop();
      this.mic = null;
    }
    if (this.player) {
      this.player.close();
      this.player = null;
    }
    if (this.aiAnalyser) {
      this.aiAnalyser.disconnect();
      this.aiAnalyser = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      ctx.onstatechange = null;
      // Fire-and-forget: close() is async but nothing after this depends on it,
      // and an engine that rejects a double close must not surface in the
      // student's face.
      void ctx.close().catch(() => undefined);
    }
    this.assistantText.clear();
    this.meterLevel = 0;
    this.meterLastUpdate = 0;
    this.meterLastPaint = 0;
    this._micLevel.set(0);
    // Zero both amplitudes so the orb settles to rest rather than freezing
    // mid-ripple on the last value it was given.
    this._userRms.set(0);
    this._aiRms.set(0);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startClock(): void {
    this.startedAt = Date.now();
    this._elapsedSeconds.set(0);
    this.clockTimer = setInterval(() => {
      this._elapsedSeconds.set(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 1000);
  }

  private startAiLevelSampling(): void {
    this.aiLevelTimer = setInterval(() => {
      const analyser = this.aiAnalyser;
      if (!analyser) return;
      analyser.getFloatTimeDomainData(this.aiWindow);
      this._aiRms.set(rmsOfFloat(this.aiWindow));
    }, AI_LEVEL_INTERVAL_MS);
  }

  /**
   * One microphone chunk's RMS: straight to the orb, VU-shaped and throttled to
   * the meter bar.
   */
  private pushLevel(rms: number): void {
    this._userRms.set(rms);

    const shaped = Math.min(1, Math.pow(Math.min(1, rms * METER_GAIN), METER_CURVE));
    const now = performance.now();
    // dt is measured from the last UPDATE, not the last paint: paints are
    // throttled, and decaying by "time since last paint" on every chunk would
    // apply the same interval two or three times and collapse the bar.
    const dt = this.meterLastUpdate ? (now - this.meterLastUpdate) / 1000 : 0;
    this.meterLastUpdate = now;
    // Fast attack, slow release — the ballistics of a real VU meter. A raw RMS
    // reading drops to zero between syllables and reads as a dead microphone.
    this.meterLevel =
      shaped > this.meterLevel
        ? shaped
        : Math.max(shaped, this.meterLevel - METER_DECAY_PER_S * dt);
    if (now - this.meterLastPaint < METER_MIN_INTERVAL_MS) return;
    this.meterLastPaint = now;
    this._micLevel.set(this.meterLevel);
  }

  private nextSystemKey(): string {
    return `s:${++this.systemLineSeq}`;
  }

  /** Append or update one transcript line, keyed so a streaming turn revises in
   *  place instead of appending a near-duplicate on every delta. */
  private writeLine(
    key: string,
    role: InterviewLine['role'],
    text: string,
    partial: boolean,
  ): void {
    this._lines.update((lines) => {
      const idx = lines.findIndex((l) => l.key === key);
      if (idx < 0) return [...lines, { key, role, text, partial }];
      const copy = [...lines];
      copy[idx] = { key, role, text, partial };
      return copy;
    });
  }
}

/* ============================================================================
   Small helpers.
   ========================================================================== */

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** A wire field read as a non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A wire field read as a finite number, or null. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A wire field read as a plain object, or null. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Microphone failures the student can actually act on. A raw DOMException name
 * in a banner is not one of them.
 */
function describeMicError(err: unknown): string {
  // Both branches: getUserMedia rejects with a DOMException, and although
  // DOMException inherits from Error in current engines, older ones do not make
  // that true — reading the name through only one of the two checks is how a
  // blocked microphone got reported as a generic failure.
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was blocked. Allow the microphone for this site, then press Start again.';
  }
  if (name === 'NotFoundError') {
    return 'No microphone was found. Connect one and press Start again.';
  }
  return err instanceof Error && err.message
    ? err.message
    : 'The microphone could not be started.';
}
