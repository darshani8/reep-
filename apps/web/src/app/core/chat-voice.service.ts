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
export interface ChatTurn {
  role: ChatRole;
  content: string;
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
