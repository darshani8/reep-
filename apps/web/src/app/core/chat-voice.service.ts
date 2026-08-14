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
 * Unified text + voice assistant client.
 *
 * One service drives both the text chat (POST /api/agent/chat) and the
 * real-time voice session (LiveKit + Gemini Live). They share a session_id, so
 * the backend keeps a single conversation memory across both. State is exposed
 * as native Angular signals for reactive templates.
 */

export type ChatRole = 'user' | 'assistant';
export interface ChatTurn {
  role: ChatRole;
  content: string;
}
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

interface ChatResponse {
  reply: string;
  session_id: string;
  model: string;
}
interface VoiceToken {
  token: string;
  url: string;
  room: string;
  identity: string;
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

  /** Load the shared conversation (text + voice) for a session into chatHistory. */
  async loadHistory(sessionId: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<{ turns: ChatTurn[] }>(
        `/api/agent/history?session_id=${encodeURIComponent(sessionId)}`,
      ),
    );
    this.chatHistory.set(res.turns);
  }

  /** Send one text turn and append the reply. Optimistically shows the user turn. */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    this.chatHistory.update((h) => [...h, { role: 'user', content: message }]);
    const res = await firstValueFrom(
      this.http.post<ChatResponse>('/api/agent/chat', { session_id: sessionId, message }),
    );
    this.chatHistory.update((h) => [...h, { role: 'assistant', content: res.reply }]);
  }

  /** Open a WebRTC voice session over LiveKit and publish the microphone. */
  async startVoiceSession(sessionId: string): Promise<void> {
    if (this.connectionStatus() === 'connected' || this.connectionStatus() === 'connecting') return;
    this.connectionStatus.set('connecting');
    try {
      const auth = await firstValueFrom(
        this.http.post<VoiceToken>('/api/voice/token', { session_id: sessionId }),
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
