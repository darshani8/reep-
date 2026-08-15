/**
 * The REEP Agent — one chat surface shared by student, mentor and director
 * (all three nav trees point their `/assistant` route here).
 *
 * Text goes through ChatVoiceService.sendMessage (POST /api/agent/chat); the
 * same service opens a LiveKit voice session sharing the session_id, so the
 * backend keeps one conversation memory across text and voice. Voice needs
 * LiveKit + Gemini creds to actually connect — the button is present and wired,
 * and fails gracefully with a note until those are set.
 *
 * The assistant is the general helper: it does NOT read a student's private
 * records (that path is gated by the backend egress rule). It says so when asked
 * for specific marks/attendance.
 */

import { Component, computed, inject, signal, effect, ElementRef, viewChild } from '@angular/core';

import { AuthService } from '../../core/auth.service';
import { ChatVoiceService } from '../../core/chat-voice.service';
import { PageIntroComponent } from '../../shared/kit/kit.components';

@Component({
  selector: 'app-assistant',
  standalone: true,
  imports: [PageIntroComponent],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent {
  private readonly chat = inject(ChatVoiceService);
  private readonly auth = inject(AuthService);

  readonly history = this.chat.chatHistory;
  readonly connection = this.chat.connectionStatus;
  readonly audioPlaying = this.chat.isAudioPlaying;

  readonly draft = signal('');
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);

  /// Per-user stable id, so the thread (text + voice) persists across reloads.
  readonly sessionId = computed(() => `assistant-${this.auth.session()?.userId ?? 'anon'}`);

  readonly voiceLabel = computed(() => {
    switch (this.connection()) {
      case 'connecting':
        return 'Connecting…';
      case 'connected':
        return 'Stop voice';
      default:
        return 'Start voice';
    }
  });

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    void this.init();
    // Keep the transcript pinned to the latest turn as it grows.
    effect(() => {
      this.history();
      const el = this.scroller()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  private async init(): Promise<void> {
    try {
      await this.chat.loadHistory(this.sessionId());
    } catch {
      /* fresh session — nothing to restore */
    }
  }

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  onKeydown(event: KeyboardEvent): void {
    // Enter sends; Shift+Enter is a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  async send(): Promise<void> {
    const message = this.draft().trim();
    if (!message || this.sending()) return;
    this.draft.set('');
    this.sending.set(true);
    this.error.set(null);
    try {
      await this.chat.sendMessage(this.sessionId(), message);
    } catch {
      this.error.set(
        'The assistant is unavailable right now. It needs an LLM provider key set in the backend (apps/api-py/.env).',
      );
    } finally {
      this.sending.set(false);
    }
  }

  async toggleVoice(): Promise<void> {
    const state = this.connection();
    if (state === 'connected' || state === 'connecting') {
      await this.chat.stopVoiceSession();
      return;
    }
    this.error.set(null);
    try {
      await this.chat.startVoiceSession(this.sessionId());
    } catch {
      this.error.set('Voice is not available yet — it needs LiveKit + Gemini credentials in the backend.');
    }
  }
}
