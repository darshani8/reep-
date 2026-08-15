import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  createLocalAudioTrack,
  LocalAudioTrack,
  Participant,
  RemoteAudioTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';

/**
 * Unified text + voice assistant client (Assistant V2 — server-owned
 * conversations).
 *
 * One service drives both the text chat (POST /api/agent/chat) and the
 * real-time voice session (LiveKit + Gemini Live). The backend now owns the
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
  private readonly audioElements: HTMLAudioElement[] = [];

  /** Timers owned by an active session — all cleared on end/error. */
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptTimer: ReturnType<typeof setInterval> | null = null;
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
    this.chatHistory.update((h) => [...h, { role: 'user', content: message }]);
    const userIndex = this.chatHistory().length - 1;

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
      this.setStatus(userIndex, controller.signal.aborted ? 'stopped' : 'failed');
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
  private setStatus(index: number, status: 'failed' | 'stopped'): void {
    this.chatHistory.update((h) =>
      h.map((t, i) => (i === index ? { ...t, status } : t)),
    );
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

    // Fresh session — clear any residue from a prior attempt.
    this.teardown();
    this.voiceError.set(null);
    this.micDenied.set(false);
    this.micMuted.set(false);
    this.callSeconds.set(0);

    try {
      // 1) Readiness — surface WHY voice is unavailable before touching the mic.
      this.voiceState.set('connecting');
      const status = await firstValueFrom(
        this.http.get<VoiceStatus>('/api/voice/status', { withCredentials: true }),
      );
      if (!status.available) {
        const reason = status.reason ?? 'Voice is not available right now.';
        this.fail(reason);
        throw new Error(reason);
      }

      // 2) Microphone — request it first so a denial fails fast (before minting
      //    a token or joining a room). This triggers the browser prompt.
      this.voiceState.set('permission-check');
      try {
        this.micTrack = await createLocalAudioTrack();
      } catch (err) {
        if (this.isPermissionError(err)) {
          this.micDenied.set(true);
          this.fail('Microphone access was blocked. Allow the mic to use voice.');
        } else {
          this.fail('Could not access the microphone.');
        }
        throw err;
      }

      // 3) Token + room join.
      this.voiceState.set('connecting');
      const auth = await firstValueFrom(
        this.http.post<VoiceToken>('/api/voice/token', {}, { withCredentials: true }),
      );

      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;
      this.wireRoomEvents(room);

      await room.connect(auth.url, auth.token);
      await room.localParticipant.publishTrack(this.micTrack);

      // 4) Connected: mic is live, agent silent → listening. Start the clock and
      //    begin polling the shared transcript.
      this.voiceState.set('listening');
      this.startTimers();
      void this.refreshTranscript();
    } catch (err) {
      if (LIVE_STATES.has(this.voiceState()) || this.voiceState() === 'connecting') {
        this.fail('Voice session failed to start.');
      }
      throw err;
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
    const room = this.room;
    this.teardown();
    // Mark ended only if we actually had a session running.
    this.voiceState.set('ended');
    await room?.disconnect();
  }

  /** Refresh the shared transcript from the server-owned conversation. */
  async refreshTranscript(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<HistoryResponse>('/api/agent/history', { withCredentials: true }),
      );
      this.voiceTranscript.set(res.turns);
      this.chatHistory.set(res.turns);
    } catch {
      /* transient — keep the last good transcript */
    }
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

    room.on(RoomEvent.Reconnecting, () => this.voiceState.set('reconnecting'));
    room.on(RoomEvent.Reconnected, () => {
      if (this.voiceState() === 'reconnecting') this.voiceState.set('listening');
    });
    room.on(RoomEvent.Disconnected, () => this.onDisconnected());
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

  private onDisconnected(): void {
    // Only surface as an error if we were mid-call; a clean stop already set
    // 'ended' and torn down.
    const wasLive = this.room !== null && LIVE_STATES.has(this.voiceState());
    this.teardown();
    if (wasLive) {
      this.voiceState.set('ended');
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
    // Poll the shared transcript so persisted voice turns appear as they land.
    this.transcriptTimer = setInterval(() => void this.refreshTranscript(), 3000);
  }

  private fail(reason: string): void {
    this.voiceError.set(reason);
    this.teardown();
    this.voiceState.set('error');
  }

  /**
   * Robust cleanup: stop the mic, detach agent audio, clear all timers and drop
   * the room reference. Safe to call repeatedly; does NOT change voiceState (the
   * caller sets the terminal state).
   */
  private teardown(): void {
    this.clearThinkingTimer();
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
    this.room = null;
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
