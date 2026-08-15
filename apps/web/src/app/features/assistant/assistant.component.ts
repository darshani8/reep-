/**
 * The REEP Agent — one chat surface shared by student, mentor and director
 * (all three nav trees point their `/assistant` route here).
 *
 * Text goes through ChatVoiceService.sendMessage (POST /api/agent/chat); the
 * same service opens a LiveKit voice session. The conversation is server-owned
 * (resolved from the session cookie), so the backend keeps one conversation
 * memory across text and voice without the client holding a session id. Voice needs
 * LiveKit + Gemini creds to actually connect — the button is present and wired,
 * and fails gracefully with a note until those are set.
 *
 * The assistant is the general helper: it does NOT read a student's private
 * records (that path is gated by the backend egress rule). It says so when asked
 * for specific marks/attendance.
 */

import { Component, computed, inject, signal, effect, ElementRef, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ChatVoiceService, ChatTurn } from '../../core/chat-voice.service';
import { PageIntroComponent } from '../../shared/kit/kit.components';

@Component({
  selector: 'app-assistant',
  standalone: true,
  imports: [PageIntroComponent, RouterLink],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent {
  private readonly chat = inject(ChatVoiceService);

  readonly history = this.chat.chatHistory;
  readonly connection = this.chat.connectionStatus;
  readonly audioPlaying = this.chat.isAudioPlaying;

  readonly draft = signal('');
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  /// Index of the assistant turn last copied — drives the transient "Copied" label.
  readonly copiedIndex = signal<number | null>(null);

  /// One-tap starters. Clicking a chip fills the draft and sends it.
  readonly quickPrompts = [
    'What should I complete this week?',
    'Am I placement-ready?',
    'Show jobs I qualify for',
    'How do I verify a skill?',
  ];

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
      await this.chat.loadHistory();
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

  /// A quick-prompt chip: drop the text into the composer and send it.
  sendPrompt(prompt: string): void {
    if (this.sending()) return;
    this.draft.set(prompt);
    void this.send();
  }

  async send(): Promise<void> {
    const message = this.draft().trim();
    if (!message || this.sending()) return;
    this.draft.set('');
    await this.run(() => this.chat.ask(message));
  }

  /// Abort the in-flight grounded request. The user turn is kept for Retry.
  stop(): void {
    this.chat.stop();
  }

  /// Re-ask a question whose request failed or was stopped.
  async retry(message: string): Promise<void> {
    if (this.sending()) return;
    await this.run(() => this.chat.retry(message));
  }

  /// Copy an assistant answer to the clipboard, with brief "Copied" feedback.
  async copy(turn: ChatTurn, index: number): Promise<void> {
    const text = turn.structured?.answer ?? turn.content;
    try {
      await navigator.clipboard.writeText(text);
      this.copiedIndex.set(index);
      setTimeout(() => {
        if (this.copiedIndex() === index) this.copiedIndex.set(null);
      }, 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  /// Shared send/retry runner: manages the sending flag and error surface.
  private async run(action: () => Promise<void>): Promise<void> {
    this.sending.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (err) {
      // A deliberate Stop is not an error; the failed-turn affordance covers it.
      if (!this.isAbort(err)) {
        this.error.set(
          "The assistant couldn't answer right now. It needs an LLM provider key set in the backend (apps/api-py/.env).",
        );
      }
    } finally {
      this.sending.set(false);
    }
  }

  private isAbort(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'AbortError';
  }

  async toggleVoice(): Promise<void> {
    const state = this.connection();
    if (state === 'connected' || state === 'connecting') {
      await this.chat.stopVoiceSession();
      return;
    }
    this.error.set(null);
    try {
      await this.chat.startVoiceSession();
    } catch (err) {
      this.error.set(
        err instanceof Error && err.message
          ? err.message
          : 'Voice is not available yet — it needs LiveKit + Gemini credentials in the backend.',
      );
    }
  }

  /// Discard the server-owned conversation and empty the transcript.
  async clearConversation(): Promise<void> {
    if (this.sending()) return;
    this.error.set(null);
    try {
      await this.chat.clearConversation();
    } catch {
      this.error.set('Could not clear the conversation. Please try again.');
    }
  }
}
