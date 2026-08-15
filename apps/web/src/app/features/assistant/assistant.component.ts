/**
 * The REEP Agent — one chat surface shared by student, mentor and director
 * (all three nav trees point their `/assistant` route here).
 *
 * Text goes through ChatVoiceService.ask (POST /api/agent/ask); the same
 * service opens a LiveKit voice session. The conversation is server-owned
 * (resolved from the session cookie), so the backend keeps one conversation
 * memory across text and voice without the client holding a session id. Voice
 * needs LiveKit + Gemini creds to actually connect — the button is present and
 * wired, gated by a one-time consent disclosure, and fails gracefully with a
 * note until those are set.
 *
 * The assistant is the general helper: it does NOT read a student's private
 * records (that path is gated by the backend egress rule). It says so when asked
 * for specific marks/attendance.
 */

import { Component, computed, inject, signal, effect, ElementRef, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  ChatVoiceService,
  ChatTurn,
  FeedbackRating,
  VoiceState,
} from '../../core/chat-voice.service';
import { PageIntroComponent } from '../../shared/kit/kit.components';

/** localStorage key remembering that the consent disclosure was accepted. */
const CONSENT_KEY = 'reep-voice-consent';

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

  // Voice state (Phase C).
  readonly voice = this.chat.voiceState;
  readonly audioPlaying = this.chat.isAudioPlaying;
  readonly micDenied = this.chat.micDenied;
  readonly micMuted = this.chat.micMuted;
  readonly callSeconds = this.chat.callSeconds;
  readonly voiceError = this.chat.voiceError;
  readonly voiceTranscript = this.chat.voiceTranscript;

  /** The one-time consent disclosure panel is showing. */
  readonly showConsent = signal(false);

  readonly draft = signal('');
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  /// Index of the assistant turn last copied — drives the transient "Copied" label.
  readonly copiedIndex = signal<number | null>(null);

  /// Per-run feedback the student has cast (helpful / not_helpful / report).
  readonly feedbackState = this.chat.feedbackState;
  /// Turn index whose inline "Report" note field is open (only one at a time).
  readonly reportOpenIndex = signal<number | null>(null);
  /// Draft text in the open report note field.
  readonly reportNote = signal('');

  /// One-tap starters. Clicking a chip fills the draft and sends it.
  readonly quickPrompts = [
    'What should I complete this week?',
    'Am I placement-ready?',
    'Show jobs I qualify for',
    'How do I verify a skill?',
  ];

  /// True while a voice session is active or coming up (not idle/ended/error).
  readonly voiceActive = computed(() => {
    const s = this.voice();
    return s !== 'idle' && s !== 'ended' && s !== 'error';
  });

  /// True while the voice panel should be shown (active, or a terminal state
  /// the user hasn't dismissed by restarting).
  readonly voicePanelOpen = computed(() => this.voiceActive() || this.voice() === 'error');

  /// Label for the primary voice button.
  readonly voiceLabel = computed(() => {
    switch (this.voice()) {
      case 'permission-check':
        return 'Allow mic…';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Reconnecting…';
      case 'listening':
      case 'thinking':
      case 'speaking':
        return 'Stop voice';
      default:
        return 'Start voice';
    }
  });

  /// Short human phrase for the live indicator + aria-live announcements.
  readonly voiceStatusLabel = computed(() => this.describe(this.voice()));

  /// mm:ss call duration.
  readonly durationLabel = computed(() => {
    const total = this.callSeconds();
    const m = Math.floor(total / 60)
      .toString()
      .padStart(2, '0');
    const s = (total % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  });

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

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

  private describe(s: VoiceState): string {
    switch (s) {
      case 'permission-check':
        return 'Waiting for microphone permission';
      case 'connecting':
        return 'Connecting to voice';
      case 'listening':
        return 'Listening';
      case 'thinking':
        return 'Thinking';
      case 'speaking':
        return 'Assistant speaking';
      case 'reconnecting':
        return 'Reconnecting';
      case 'ended':
        return 'Voice ended';
      case 'error':
        return this.voiceError() ?? 'Voice error';
      default:
        return 'Idle';
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

  // ------------------------------------------------------------------ //
  // Feedback controls (Phase D)                                        //
  // ------------------------------------------------------------------ //

  /// The rating the student cast for a given run, if any.
  feedbackFor(runId: string): FeedbackRating | undefined {
    return this.feedbackState()[runId];
  }

  /// Cast a thumbs-up / thumbs-down rating for a fresh answer.
  async vote(runId: string, rating: 'helpful' | 'not_helpful'): Promise<void> {
    try {
      await this.chat.sendFeedback(runId, rating);
    } catch {
      /* transient — silently drop; the student can try again */
    }
  }

  /// Toggle the inline report-note field for a turn (closes any other open one).
  toggleReport(index: number): void {
    if (this.reportOpenIndex() === index) {
      this.reportOpenIndex.set(null);
    } else {
      this.reportOpenIndex.set(index);
    }
    this.reportNote.set('');
  }

  /// Keep the report-note draft in sync with the textarea.
  onReportInput(event: Event): void {
    this.reportNote.set((event.target as HTMLTextAreaElement).value);
  }

  /// Submit a report for a run, with the optional note, then close the field.
  async submitReport(runId: string): Promise<void> {
    const note = this.reportNote().trim();
    try {
      await this.chat.sendFeedback(runId, 'report', note || undefined);
    } catch {
      /* transient — leave the field open so the student can retry */
      return;
    }
    this.reportOpenIndex.set(null);
    this.reportNote.set('');
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

  // ------------------------------------------------------------------ //
  // Voice controls (Phase C)                                           //
  // ------------------------------------------------------------------ //

  /// The primary voice button: stop if active, else start (through consent).
  async toggleVoice(): Promise<void> {
    if (this.voiceActive()) {
      await this.chat.stopVoiceSession();
      return;
    }
    this.error.set(null);
    if (this.hasConsent()) {
      await this.beginVoice();
    } else {
      // First use — show the disclosure before touching the mic.
      this.showConsent.set(true);
    }
  }

  private hasConsent(): boolean {
    try {
      return localStorage.getItem(CONSENT_KEY) === 'true';
    } catch {
      return false;
    }
  }

  /// Consent panel — "I understand — start voice".
  async acceptConsent(): Promise<void> {
    this.showConsent.set(false);
    try {
      await this.chat.recordConsent(true);
      try {
        localStorage.setItem(CONSENT_KEY, 'true');
      } catch {
        /* storage blocked — consent still recorded server-side for this session */
      }
    } catch {
      /* backend consent write failed — proceed; general voice needs no consent */
    }
    await this.beginVoice();
  }

  /// Consent panel — "Cancel".
  cancelConsent(): void {
    this.showConsent.set(false);
  }

  /// Actually open the LiveKit session, surfacing any start failure.
  private async beginVoice(): Promise<void> {
    try {
      await this.chat.startVoiceSession();
    } catch (err) {
      // The service already set state=error + voiceError; only fill a generic
      // top-of-page note if nothing more specific is available.
      if (!this.voiceError()) {
        this.error.set(
          err instanceof Error && err.message
            ? err.message
            : 'Voice is not available yet — it needs LiveKit + Gemini credentials in the backend.',
        );
      }
    }
  }

  /// Retry after a failed/dropped session (reconnect).
  async retryVoice(): Promise<void> {
    await this.chat.stopVoiceSession().catch(() => undefined);
    await this.beginVoice();
  }

  /// Mute / unmute the local microphone.
  async toggleMute(): Promise<void> {
    await this.chat.setMicMuted(!this.micMuted());
  }

  /// "Continue in text": end voice and move focus to the composer.
  async continueInText(): Promise<void> {
    await this.chat.stopVoiceSession().catch(() => undefined);
    queueMicrotask(() => this.composer()?.nativeElement.focus());
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
