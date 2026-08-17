import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  Participant,
  RemoteAudioTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TranscriptionSegment,
} from 'livekit-client';

/**
 * Unified text + voice assistant client (Assistant V2 — server-owned
 * conversations).
 *
 * One service drives both the text chat (POST /api/agent/chat) and the
 * real-time voice session (LiveKit + a server-side Groq speech cascade; the
 * browser only publishes a mic track and plays what comes back). The backend owns the
 * conversation: it resolves the caller from the session cookie and keeps a
 * single conversation memory across both text and voice. The client never
 * mints or sends a session_id. State is exposed as native Angular signals for
 * reactive templates.
 */

export type ChatRole = 'user' | 'assistant';

/** A routed next-step the agent suggests, rendered as an action card. */
export interface AgentAction {
  label: string;
  route: string;
  reason: string;
}
/** Where an answer came from — tints the source chip in the UI. */
export interface AgentSource {
  label: string;
  type: 'student-record' | 'policy' | 'general';
}
/** How the student rated a fresh /ask answer (Phase D feedback controls). */
export type FeedbackRating = 'helpful' | 'not_helpful' | 'report';

/** The structured payload attached to a fresh /ask assistant turn. */
export interface StructuredAnswer {
  answer: string;
  actions: AgentAction[];
  sources: AgentSource[];
  limitations: string[];
  model: string | null;
  /** Identifies the agent run this answer came from — needed to send feedback. */
  run_id?: string;
}

export interface ChatTurn {
  role: ChatRole;
  content: string;
  /** Present only on fresh /ask assistant turns; historical turns are plain text. */
  structured?: StructuredAnswer;
  /** Set on a user turn whose /ask request failed ('failed') or was stopped ('stopped'). */
  status?: 'failed' | 'stopped';
}

/**
 * Explicit lifecycle of a real-time voice session (Phase C). Driven from the
 * actual LiveKit flow — not inferred from mere track subscription:
 *   idle             no session
 *   permission-check requesting the microphone (browser permission prompt)
 *   connecting       joining the LiveKit room
 *   listening        connected, mic published, agent silent (or hearing the user)
 *   thinking         user finished speaking, agent has not started replying
 *   speaking         the agent's audio is actively producing sound
 *   reconnecting     transport dropped, LiveKit is re-establishing
 *   ended            the session closed cleanly
 *   error            the session failed to start or dropped unrecoverably
 */
export type VoiceState =
  | 'idle'
  | 'permission-check'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'ended'
  | 'error';

const LIVE_STATES: ReadonlySet<VoiceState> = new Set<VoiceState>([
  'listening',
  'thinking',
  'speaking',
]);

/**
 * How long the UI may sit in connecting/permission-check before giving up.
 * Generous, because it spans the browser's own microphone prompt — which the
 * student may take a while to answer — and must not cut a slow-but-working
 * connection short.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Disconnect reasons that are NOT a fault the student should see.
 *
 * CLIENT_INITIATED is the student pressing End. MIGRATION is LiveKit moving the
 * session between servers — the transport is expected back. ROOM_CLOSED and
 * UNKNOWN_REASON are how a normal end-of-call reports itself.
 *
 * Everything else — the agent worker dying, the room being deleted, a signal
 * socket closing, a join that never completed — is a real failure and must land
 * in 'error' so Retry is offered instead of a silent "call ended".
 */
const CLEAN_DISCONNECTS: ReadonlySet<DisconnectReason> = new Set<DisconnectReason>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.MIGRATION,
  DisconnectReason.ROOM_CLOSED,
  DisconnectReason.UNKNOWN_REASON,
]);

interface HistoryResponse {
  conversation_id: string;
  turns: ChatTurn[];
}
interface ChatResponse {
  reply: string;
  model: string;
}
interface AskResponse {
  answer: string;
  actions: AgentAction[];
  sources: AgentSource[];
  limitations: string[];
  conversation_id: string;
  model: string | null;
  run_id: string;
}
interface FeedbackResponse {
  ok: boolean;
}
interface VoiceToken {
  token: string;
  url: string;
  room: string;
  identity: string;
  conversation_id: string;
}
interface VoiceStatus {
  available: boolean;
  reason?: string;
}
interface ConsentResponse {
  consent_state: string;
}

@Injectable({ providedIn: 'root' })
export class ChatVoiceService {
  private readonly http = inject(HttpClient);

  /** Reactive text state. */
  readonly chatHistory = signal<ChatTurn[]>([]);

  /**
   * Per-run feedback the student has cast, keyed by run_id (Phase D). Lets the
   * UI reflect which answer was rated what, and acknowledge the choice.
   */
  readonly feedbackState = signal<Record<string, FeedbackRating>>({});

  /** Reactive voice state (Phase C). */
  readonly voiceState = signal<VoiceState>('idle');
  /** True while the agent's remote audio is actively producing sound. */
  readonly isAudioPlaying = signal<boolean>(false);
  /** True when microphone permission was denied by the browser. */
  readonly micDenied = signal<boolean>(false);
  /** True while the local microphone track is muted. */
  readonly micMuted = signal<boolean>(false);
  /** Elapsed call duration, in whole seconds. */
  readonly callSeconds = signal<number>(0);
  /** Human-readable reason attached to an error/ended state. */
  readonly voiceError = signal<string | null>(null);
  /** The shared conversation transcript (text + persisted voice turns). */
  readonly voiceTranscript = signal<ChatTurn[]>([]);

  private room: Room | null = null;
  private micTrack: LocalAudioTrack | null = null;
  /** Live transcription segments by LiveKit segment id, so a revised segment
   *  replaces its earlier text instead of appending a near-duplicate turn. */
  private readonly liveSegments = new Map<string, ChatTurn>();
  private readonly audioElements: HTMLAudioElement[] = [];

  /** Timers owned by an active session — all cleared on end/error. */
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against an in-flight history fetch landing after a newer one. */
  private transcriptSeq = 0;
  /** Session-scoped: releases the mic if the tab closes mid-call. */
  private pageHideHandler: (() => void) | null = null;
  /**
   * Identifies the current start attempt. Bumped by teardown() and by each new
   * startVoiceSession, so an in-flight start can tell it has been superseded.
   */
  private sessionGen = 0;
  /** Bounds how long the UI may sit in connecting/permission-check. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private callStartedAt = 0;
  /** Tracks whether the user was the last active speaker (→ agent is thinking). */
  private userWasSpeaking = false;

  /** Aborts the in-flight /ask request when the user hits Stop. */
  private askController: AbortController | null = null;

  // ------------------------------------------------------------------ //
  // Text chat (unchanged Phase A/B surface)                            //
  // ------------------------------------------------------------------ //

  /** Load the server-owned conversation (text + voice) into chatHistory. */
  async loadHistory(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<HistoryResponse>('/api/agent/history', { withCredentials: true }),
    );
    this.chatHistory.set(res.turns);
    this.voiceTranscript.set(res.turns);
  }

  /** Send one text turn and append the reply. Optimistically shows the user turn. */
  async sendMessage(message: string): Promise<void> {
    this.chatHistory.update((h) => [...h, { role: 'user', content: message }]);
    const res = await firstValueFrom(
      this.http.post<ChatResponse>('/api/agent/chat', { message }, { withCredentials: true }),
    );
    this.chatHistory.update((h) => [...h, { role: 'assistant', content: res.reply }]);
  }

  /**
   * PRIMARY send path: POST /api/agent/ask (grounded — real data + approved
   * policy, honest refusals) and append a STRUCTURED assistant turn. The user
   * turn shows optimistically; on failure/stop it is marked so the UI can offer
   * a Retry affordance instead of leaving an orphan. Cancellable via stop().
   *
   * Uses fetch (not HttpClient) so an AbortController can cancel the request.
   */
  async ask(message: string): Promise<void> {
    // Hold the OBJECT, not its index. refreshTranscript() rebuilds this array
    // (a voice call ending mid-request is enough), and an index captured before
    // that rebuild then pointed at whatever turn happened to land in the slot —
    // so a failure marked some unrelated earlier message as failed while the
    // real one looked fine. Identity survives a reorder; if the array is
    // replaced outright this degrades to a harmless no-op.
    const userTurn: ChatTurn = { role: 'user', content: message };
    this.chatHistory.update((h) => [...h, userTurn]);

    const controller = new AbortController();
    this.askController = controller;
    try {
      const res = await fetch('/api/agent/ask', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ask failed: ${res.status}`);
      const data = (await res.json()) as AskResponse;
      this.chatHistory.update((h) => [
        ...h,
        {
          role: 'assistant',
          content: data.answer,
          structured: {
            answer: data.answer,
            actions: data.actions ?? [],
            sources: data.sources ?? [],
            limitations: data.limitations ?? [],
            model: data.model ?? null,
            run_id: data.run_id,
          },
        },
      ]);
    } catch (err) {
      // A deliberate Stop aborts the signal; anything else is a real failure.
      this.setStatus(userTurn, controller.signal.aborted ? 'stopped' : 'failed');
      throw err;
    } finally {
      if (this.askController === controller) this.askController = null;
    }
  }

  /** Abort the in-flight /ask request, if any. */
  stop(): void {
    this.askController?.abort();
    this.askController = null;
  }

  /** Re-ask a question: drop a trailing failed/stopped user turn, then ask again. */
  async retry(message: string): Promise<void> {
    this.chatHistory.update((h) => {
      const copy = [...h];
      while (copy.length && copy[copy.length - 1].status) copy.pop();
      return copy;
    });
    await this.ask(message);
  }

  /** Flag a user turn so the UI can render a Retry affordance. */
  private setStatus(turn: ChatTurn, status: 'failed' | 'stopped'): void {
    this.chatHistory.update((h) => h.map((t) => (t === turn ? { ...t, status } : t)));
  }

  /**
   * Record the student's rating of one grounded answer (Phase D). Posts to
   * /api/agent/feedback and remembers the choice locally so the UI reflects it.
   * An optional note accompanies a 'report'.
   */
  async sendFeedback(runId: string, rating: FeedbackRating, note?: string): Promise<void> {
    // The API's FeedbackRating enum is upper-case (HELPFUL / NOT_HELPFUL /
    // REPORT); the UI carries the lower-case form. Map at the wire boundary so
    // the local state + template comparisons stay lower-case.
    const body: { run_id: string; rating: string; note?: string } = {
      run_id: runId,
      rating: rating.toUpperCase(),
    };
    const trimmed = note?.trim();
    if (trimmed) body.note = trimmed;
    await firstValueFrom(
      this.http.post<FeedbackResponse>('/api/agent/feedback', body, { withCredentials: true }),
    );
    this.feedbackState.update((m) => ({ ...m, [runId]: rating }));
  }

  /** Discard the server-owned conversation and clear the local transcript. */
  async clearConversation(): Promise<void> {
    await firstValueFrom(
      this.http.delete('/api/agent/conversation', { withCredentials: true }),
    );
    this.chatHistory.set([]);
    this.voiceTranscript.set([]);
    this.feedbackState.set({});
  }

  // ------------------------------------------------------------------ //
  // Voice consent (Phase C)                                            //
  // ------------------------------------------------------------------ //

  /**
   * Record the student's voice consent on their server-owned conversation.
   * Called once, before the first voice session, from the consent panel.
   */
  async recordConsent(consent: boolean): Promise<string> {
    const res = await firstValueFrom(
      this.http.post<ConsentResponse>(
        '/api/voice/consent',
        { consent },
        { withCredentials: true },
      ),
    );
    return res.consent_state;
  }

  // ------------------------------------------------------------------ //
  // Voice session (Phase C — explicit state machine)                   //
  // ------------------------------------------------------------------ //

  /**
   * Open a WebRTC voice session over LiveKit and publish the microphone,
   * driving the explicit VoiceState machine from the real connection flow.
   */
  async startVoiceSession(): Promise<void> {
    const state = this.voiceState();
    if (state !== 'idle' && state !== 'ended' && state !== 'error') return;

    // Fresh session — clear any residue from a prior attempt. teardown() bumps
    // sessionGen, so this MUST come before the generation is captured.
    this.teardown();

    // Identifies THIS attempt. Every await below is a point where the student
    // may have pressed "End voice" — and without this the in-flight start
    // carried on regardless: it would join the room anyway (leaving a connected
    // room nothing holds a handle to) or drive itself back into 'listening'
    // with a live microphone the student believes is off.
    const gen = ++this.sessionGen;
    const cancelled = () => gen !== this.sessionGen;

    // Release the microphone if the tab is closed or the browser navigates away.
    // Nothing else covers that path: ngOnDestroy does not run on tab close, and
    // without this the mic stays published to a live room until the session
    // times out server-side. Registered per session and removed in teardown().
    //
    // pagehide, NOT visibilitychange: tabbing away from a call is normal and
    // must not end it.
    this.pageHideHandler = () => {
      void this.stopVoiceSession().catch(() => undefined);
    };
    window.addEventListener('pagehide', this.pageHideHandler);

    this.voiceError.set(null);
    this.micDenied.set(false);
    this.micMuted.set(false);
    this.callSeconds.set(0);

    // Nothing below is allowed to hang forever. A wedged uvicorn — a documented
    // failure mode on this platform — used to park the UI on "Connecting…"
    // indefinitely, with the header button disabled in that state, so the
    // student had no way out but a page reload.
    this.connectTimer = setTimeout(() => {
      if (cancelled()) return;
      if (this.voiceState() === 'connecting' || this.voiceState() === 'permission-check') {
        this.fail('Voice took too long to connect. Press Retry to try again.');
      }
    }, CONNECT_TIMEOUT_MS);

    try {
      // 1) Readiness — surface WHY voice is unavailable before touching the mic.
      this.voiceState.set('connecting');
      const status = await firstValueFrom(
        this.http.get<VoiceStatus>('/api/voice/status', { withCredentials: true }),
      );
      if (cancelled()) throw new Error('cancelled');
      if (!status.available) {
        const reason = status.reason ?? 'Voice is not available right now.';
        this.fail(reason);
        throw new Error(reason);
      }

      // 2) Microphone — request it first so a denial fails fast (before minting
      //    a token or joining a room). This triggers the browser prompt.
      this.voiceState.set('permission-check');
      try {
        // Echo cancellation is REQUIRED, not a nicety: on speakers the agent's
        // own reply is picked up by the mic, transcribed, and fed back as a
        // student turn — the assistant ends up answering itself and the shared
        // transcript fills with turns the student never said. Noise suppression
        // and auto gain help the same STT on laptop mics in a noisy lab.
        this.micTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      } catch (err) {
        if (this.isPermissionError(err)) {
          this.micDenied.set(true);
          this.fail('Microphone access was blocked. Allow the mic to use voice.');
        } else {
          this.fail('Could not access the microphone.');
        }
        throw err;
      }
      // The prompt can sit open for a long time; the student may have given up
      // and pressed End before granting it. Stop the mic we just opened.
      if (cancelled()) {
        this.micTrack?.stop();
        this.micTrack = null;
        throw new Error('cancelled');
      }

      // 3) Token + room join.
      this.voiceState.set('connecting');
      const auth = await firstValueFrom(
        this.http.post<VoiceToken>('/api/voice/token', {}, { withCredentials: true }),
      );
      if (cancelled()) throw new Error('cancelled');

      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      this.wireRoomEvents(room);

      await room.connect(auth.url, auth.token);
      // The room is CONNECTED now. Cancelling from here on must disconnect it
      // explicitly — teardown() already ran and dropped its reference, so
      // nothing else will ever release it.
      if (cancelled()) {
        room.removeAllListeners();
        void room.disconnect().catch(() => undefined);
        this.micTrack?.stop();
        this.micTrack = null;
        throw new Error('cancelled');
      }
      await room.localParticipant.publishTrack(this.micTrack);
      if (cancelled()) {
        room.removeAllListeners();
        void room.disconnect().catch(() => undefined);
        throw new Error('cancelled');
      }

      // 4) Connected: mic is live, agent silent → listening. Start the clock and
      //    begin polling the shared transcript.
      this.clearConnectTimer();
      this.voiceState.set('listening');
      this.startTimers();
      void this.refreshTranscript();
    } catch (err) {
      this.clearConnectTimer();
      // ALWAYS land in a terminal state. The old condition listed the states it
      // knew about, so anything it had not anticipated — a cancel, a throw from
      // 'permission-check' — left the machine stuck in a non-terminal state with
      // no button the student could press.
      if (cancelled()) {
        // A newer attempt (or an explicit stop) owns the state now; do not
        // stomp on it with this one's failure.
        throw err;
      }
      if (this.voiceState() !== 'error') {
        this.fail('Voice session failed to start.');
      }
      throw err;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Toggle the local microphone (mute / unmute). */
  async setMicMuted(muted: boolean): Promise<void> {
    if (!this.micTrack) return;
    if (muted) await this.micTrack.mute();
    else await this.micTrack.unmute();
    this.micMuted.set(muted);
  }

  /** Tear down the voice session and return to idle. */
  async stopVoiceSession(): Promise<void> {
    // teardown() now disconnects the room itself, so a second disconnect here
    // would be redundant — and awaiting a handle teardown has already dropped
    // was how the "clean stop" path differed from every error path.
    this.teardown();
    this.voiceState.set('ended');
  }

  /**
   * Refresh the shared transcript from the server-owned conversation.
   *
   * MERGES rather than replaces. `/api/agent/history` returns plain
   * `{role, content}` — the server does not persist the structured payload — so
   * assigning its result straight into `chatHistory` silently stripped the
   * action cards, sources and feedback controls off every answer already on
   * screen. A student who asked a question in text and then made a voice call
   * watched their answer lose its "why" the moment the call ended.
   *
   * `voiceTranscript` IS a faithful mirror of the server, so it is still
   * replaced wholesale.
   */
  async refreshTranscript(): Promise<void> {
    const seq = ++this.transcriptSeq;
    try {
      const res = await firstValueFrom(
        this.http.get<HistoryResponse>('/api/agent/history', { withCredentials: true }),
      );
      // A slow fetch that lands after a newer one — or after the user has since
      // asked something — must not resurrect a stale view of the conversation.
      if (seq !== this.transcriptSeq) return;

      this.voiceTranscript.set(res.turns);
      this.chatHistory.update((local) => this.mergeHistory(local, res.turns));
    } catch {
      /* transient — keep the last good transcript */
    }
  }

  /**
   * Server turns are the source of truth for WHAT was said; local turns are the
   * only place the structured payload exists. Keep the local object whenever it
   * says the same thing, so re-fetching costs no fidelity.
   */
  private mergeHistory(local: ChatTurn[], server: ChatTurn[]): ChatTurn[] {
    // Keep the local object for EVERY content match, not only the ones carrying
    // a structured payload. Matching on role+content already means the two say
    // the same thing, so preferring local costs nothing — and it preserves
    // object IDENTITY, which ask() relies on to mark the right turn failed after
    // a refresh has rebuilt the array underneath it.
    const enriched = new Map<string, ChatTurn>();
    for (const turn of local) {
      enriched.set(`${turn.role}\u0000${turn.content}`, turn);
    }
    const merged = server.map(
      (turn) => enriched.get(`${turn.role}\u0000${turn.content}`) ?? turn,
    );

    // A turn the server has not caught up with yet (an /ask reply that is still
    // being persisted, or a failed one it never will) would otherwise vanish and
    // reappear. Keep any trailing local turns the server does not know about.
    const serverKeys = new Set(server.map((t) => `${t.role}\u0000${t.content}`));
    for (const turn of local) {
      if (!serverKeys.has(`${turn.role}\u0000${turn.content}`)) merged.push(turn);
    }
    return merged;
  }

  // ------------------------------------------------------------------ //
  // Internals                                                          //
  // ------------------------------------------------------------------ //

  private wireRoomEvents(room: Room): void {
    // Attach the agent's audio so it is audible. Subscription alone is NOT
    // "speaking" — a subscribed-but-silent track stays 'listening'. Speaking is
    // driven from audio activity (ActiveSpeakersChanged), below.
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        const el = (track as RemoteAudioTrack).attach();
        el.autoplay = true;
        this.audioElements.push(el);
        document.body.appendChild(el);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        (track as RemoteAudioTrack).detach().forEach((el) => el.remove());
      }
    });

    // Audio-activity → speaking/listening/thinking. This is the real signal:
    // the agent is "speaking" only while its audio is actually producing sound.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
      this.onActiveSpeakers(room, speakers),
    );

    // Live transcript, PUSHED by LiveKit rather than polled from our API.
    // The agent already forwards both sides' transcriptions into the room, so
    // the words arrive here as they are recognised — no 3-second delay and no
    // repeated full-history fetch per active call. Interim segments update in
    // place; the authoritative persisted copy is reconciled once when the call
    // ends, which also repairs anything a dropped message missed.
    room.on(
      RoomEvent.TranscriptionReceived,
      (segments: TranscriptionSegment[], participant?: Participant) => {
        const isAgent = !!participant && !participant.isLocal;
        for (const seg of segments) {
          if (!seg.text?.trim()) continue;
          this.applyTranscriptSegment(seg, isAgent ? 'assistant' : 'user');
        }
      },
    );

    room.on(RoomEvent.Reconnecting, () => {
      this.voiceState.set('reconnecting');
      // Without this the red "speaking" pulse runs for the whole outage:
      // onActiveSpeakers early-returns outside LIVE_STATES, so nothing else can
      // ever clear it, and the UI shows the agent talking through a dead
      // transport.
      this.isAudioPlaying.set(false);
      this.userWasSpeaking = false;
      this.clearThinkingTimer();
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this.voiceState() === 'reconnecting') this.voiceState.set('listening');
      // A reconnect can straddle turns that were spoken while we were away, and
      // those arrive as no further push. Reconcile once against the server.
      void this.refreshTranscript();
    });
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => this.onDisconnected(reason));
  }

  /**
   * Merge one pushed transcription segment into the live transcript.
   *
   * Segments are keyed by LiveKit's segment id and revised in place as
   * recognition firms up, so a naive append would show the same sentence
   * several times, growing word by word.
   */
  private applyTranscriptSegment(seg: TranscriptionSegment, role: ChatRole): void {
    const existing = this.liveSegments.get(seg.id);
    this.liveSegments.set(seg.id, { role, content: seg.text });
    this.voiceTranscript.update((turns) => {
      if (existing) {
        // Replace the previous revision of this same segment.
        const idx = turns.findIndex(
          (t) => t.role === existing.role && t.content === existing.content,
        );
        if (idx >= 0) {
          const copy = [...turns];
          copy[idx] = { role, content: seg.text };
          return copy;
        }
      }
      return [...turns, { role, content: seg.text }];
    });
  }

  private onActiveSpeakers(room: Room, speakers: Participant[]): void {
    // Ignore activity outside a live session (connecting / reconnecting / ended).
    if (!LIVE_STATES.has(this.voiceState())) return;

    const localId = room.localParticipant.identity;
    const remoteSpeaking = speakers.some((p) => p.identity !== localId && !p.isLocal);
    const localSpeaking = speakers.some((p) => p.identity === localId || p.isLocal);

    this.isAudioPlaying.set(remoteSpeaking);

    if (remoteSpeaking) {
      // Agent is producing sound.
      this.clearThinkingTimer();
      this.userWasSpeaking = false;
      this.voiceState.set('speaking');
      return;
    }

    if (localSpeaking) {
      // We are hearing the user — that is "listening".
      this.clearThinkingTimer();
      this.userWasSpeaking = true;
      this.voiceState.set('listening');
      return;
    }

    // Silence. If the user just finished, the agent is presumably thinking.
    if (this.userWasSpeaking) {
      this.userWasSpeaking = false;
      this.voiceState.set('thinking');
      // Don't get stuck in 'thinking' if the agent never replies.
      this.clearThinkingTimer();
      this.thinkingTimer = setTimeout(() => {
        if (this.voiceState() === 'thinking') this.voiceState.set('listening');
      }, 8000);
    } else if (this.voiceState() === 'speaking') {
      this.voiceState.set('listening');
    }
  }

  private onDisconnected(reason?: DisconnectReason): void {
    // Both branches used to set 'ended', which made the "we were mid-call"
    // branch dead code: voiceError stayed null, the panel vanished, and Retry —
    // rendered only for voice() === 'error' — never appeared. A student whose
    // connection dropped mid-answer saw a call that had apparently just ended
    // normally, with no way to tell the difference and nothing to press.
    //
    // LiveKit tells us WHY, so use it rather than inferring from local state.
    const wasLive = this.room !== null && LIVE_STATES.has(this.voiceState());
    this.teardown();

    if (wasLive && reason !== undefined && !CLEAN_DISCONNECTS.has(reason)) {
      this.fail('The voice connection dropped. Press Retry to reconnect.');
    } else if (this.voiceState() !== 'error') {
      this.voiceState.set('ended');
    }
    void this.refreshTranscript();
  }

  private startTimers(): void {
    this.callStartedAt = Date.now();
    this.callSeconds.set(0);
    this.durationTimer = setInterval(() => {
      this.callSeconds.set(Math.floor((Date.now() - this.callStartedAt) / 1000));
    }, 1000);

    // Transcript updates arrive PUSHED over LiveKit (see wireRoomEvents ->
    // TranscriptionReceived), not polled. The old 3-second timer re-fetched the
    // ENTIRE conversation — up to 40 turns — every three seconds for the whole
    // duration of every concurrent call, purely to notice turns the agent had
    // just spoken into this very room. That is avoidable API and Postgres load
    // that scales with concurrency, and it still showed the transcript a beat
    // late. A single reconciling fetch runs when the call ends (onDisconnected),
    // which is also what repairs anything a dropped data message missed.
    this.transcriptTimer = null;
  }

  private fail(reason: string): void {
    this.voiceError.set(reason);
    this.teardown();
    this.voiceState.set('error');
  }

  /**
   * Robust cleanup: stop the mic, detach agent audio, clear all timers, and
   * DISCONNECT the room before dropping it. Safe to call repeatedly; does NOT
   * change voiceState (the caller sets the terminal state).
   *
   * Disconnecting matters on the partial-failure path: startVoiceSession can
   * connect to the room and then fail while publishing the mic track, and the
   * old cleanup only dropped the reference. The student was left silently
   * joined to a live LiveKit room — still billed, still holding the agent's
   * session open, and unreachable because nothing held the handle any more.
   * disconnect() is fire-and-forget here because teardown is called from
   * synchronous error paths; the room is dropped either way.
   */
  private teardown(): void {
    // Invalidate any start attempt still in flight, so it cannot resurrect the
    // session after this teardown has run.
    this.sessionGen++;
    const room = this.room;
    // Drop the reference FIRST, so anything the disconnect below triggers sees a
    // null room and cannot recurse back into teardown.
    this.room = null;
    if (room) {
      // Unbind before disconnecting. Without this the orphaned room keeps its
      // handlers, and its own Disconnected event — fired by the very call
      // below — lands in a service that has already started the NEXT session,
      // tearing that one down instead. Retry was the reliable way to hit it.
      room.removeAllListeners();
      void room.disconnect().catch(() => {
        /* already gone / transport dead — nothing left to release */
      });
    }
    if (this.pageHideHandler) {
      window.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
    this.clearThinkingTimer();
    this.clearConnectTimer();
    if (this.durationTimer !== null) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.transcriptTimer !== null) {
      clearInterval(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    if (this.micTrack) {
      this.micTrack.stop();
      this.micTrack = null;
    }
    for (const el of this.audioElements.splice(0)) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.liveSegments.clear();
    this.isAudioPlaying.set(false);
    this.micMuted.set(false);
    this.userWasSpeaking = false;
  }

  private clearThinkingTimer(): void {
    if (this.thinkingTimer !== null) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  private isPermissionError(err: unknown): boolean {
    if (err instanceof DOMException) {
      return err.name === 'NotAllowedError' || err.name === 'SecurityError';
    }
    // livekit-client wraps getUserMedia failures; sniff the message as a fallback.
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    return msg.includes('permission') || msg.includes('denied') || msg.includes('notallowed');
  }
}
