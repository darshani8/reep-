import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  createLocalAudioTrack,
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
/** The structured payload attached to a fresh /ask assistant turn. */
export interface StructuredAnswer {
  answer: string;
  actions: AgentAction[];
  sources: AgentSource[];
  limitations: string[];
  model: string | null;
}

export interface ChatTurn {
  role: ChatRole;
  content: string;
  /** Present only on fresh /ask assistant turns; historical turns are plain text. */
  structured?: StructuredAnswer;
  /** Set on a user turn whose /ask request failed ('failed') or was stopped ('stopped'). */
  status?: 'failed' | 'stopped';
}
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

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
}
interface VoiceToken {
  token: string;
  url: string;
  room: string;
  identity: string;
}
interface VoiceStatus {
  available: boolean;
  reason?: string;
}

@Injectable({ providedIn: 'root' })
export class ChatVoiceService {
  private readonly http = inject(HttpClient);

  /** Reactive state. */
  readonly chatHistory = signal<ChatTurn[]>([]);
  readonly connectionStatus = signal<ConnectionStatus>('idle');
  readonly isAudioPlaying = signal<boolean>(false);

  private room: Room | null = null;
  private readonly audioElements: HTMLAudioElement[] = [];

  /** Aborts the in-flight /ask request when the user hits Stop. */
  private askController: AbortController | null = null;

  /** Load the server-owned conversation (text + voice) into chatHistory. */
  async loadHistory(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<HistoryResponse>('/api/agent/history', { withCredentials: true }),
    );
    this.chatHistory.set(res.turns);
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

  /** Discard the server-owned conversation and clear the local transcript. */
  async clearConversation(): Promise<void> {
    await firstValueFrom(
      this.http.delete('/api/agent/conversation', { withCredentials: true }),
    );
    this.chatHistory.set([]);
  }

  /** Open a WebRTC voice session over LiveKit and publish the microphone. */
  async startVoiceSession(): Promise<void> {
    if (this.connectionStatus() === 'connected' || this.connectionStatus() === 'connecting') return;
    this.connectionStatus.set('connecting');
    try {
      // Voice needs LiveKit + Gemini creds on the backend; ask first so we can
      // surface why it's unavailable instead of failing mid-connect.
      const status = await firstValueFrom(
        this.http.get<VoiceStatus>('/api/voice/status', { withCredentials: true }),
      );
      if (!status.available) {
        this.connectionStatus.set('error');
        throw new Error(status.reason ?? 'Voice is not available right now.');
      }

      const auth = await firstValueFrom(
        this.http.post<VoiceToken>('/api/voice/token', {}, { withCredentials: true }),
      );

      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;

      // Play the agent's audio track and reflect whether it is speaking.
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = (track as RemoteAudioTrack).attach();
          el.autoplay = true;
          this.audioElements.push(el);
          document.body.appendChild(el);
          this.isAudioPlaying.set(true);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, () => this.isAudioPlaying.set(false));
      room.on(RoomEvent.Disconnected, () => this.resetVoiceState());

      // Secure Room connection (WebRTC over UDP) to the LiveKit media server.
      await room.connect(auth.url, auth.token);

      // Bind the raw microphone track so the worker's STT/LLM can hear the user.
      const mic = await createLocalAudioTrack();
      await room.localParticipant.publishTrack(mic);

      this.connectionStatus.set('connected');
    } catch (err) {
      this.connectionStatus.set('error');
      throw err;
    }
  }

  /** Tear down the voice session and detach audio. */
  async stopVoiceSession(): Promise<void> {
    await this.room?.disconnect();
    this.resetVoiceState();
  }

  private resetVoiceState(): void {
    for (const el of this.audioElements.splice(0)) el.remove();
    this.room = null;
    this.isAudioPlaying.set(false);
    this.connectionStatus.set('idle');
  }
}
