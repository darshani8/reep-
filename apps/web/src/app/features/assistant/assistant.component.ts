/**
 * The REEP Assistant — an AI mock interviewer, front and centre.
 *
 * This screen used to be a text chat over POST /api/agent/ask with a LiveKit
 * voice button bolted on. It is now the realtime interview itself: press Start,
 * the microphone opens, a WebSocket to /api/interview carries 24 kHz PCM both
 * ways, and a strict-but-constructive interviewer asks one question at a time
 * and critiques the answer. Everything audio lives in InterviewService; this
 * component owns the orb, the controls and the transcript.
 *
 * WHAT SURVIVED THE REWRITE, AND WHY
 *
 *  - The conversation history. Interview turns are persisted server-side through
 *    app/conversations.py into the SAME `conversations` / `messages` tables the
 *    text agent used, so GET /api/agent/history still returns them and the
 *    AGENTS.md runbook query still works. It is re-read after every session, and
 *    "Clear conversation" still deletes it. That is why ChatVoiceService is
 *    still injected: for loadHistory() and clearConversation(), nothing else.
 *
 *  - Status as TEXT AND COLOUR, never colour alone (AGENTS.md, frontend
 *    conventions). The orb is decoration; the pill beside it carries the words.
 *
 * WHAT WENT, DELIBERATELY
 *
 *  - The composer, quick prompts and per-answer feedback controls. Feedback was
 *    gated on `turn.structured?.run_id`, which only ever exists on a fresh /ask
 *    reply — with no composer there are no such turns, so those controls could
 *    never render. Removing them is consistent, not a loss. The /ask, /feedback
 *    and /history endpoints are untouched on the server (build before delete).
 *
 *  - The LiveKit consent panel. Consent copy for the interview belongs to the
 *    interview: the disclosure below is shown before the first Start, in place.
 *
 * RULE 1. Nothing on this screen sends a student record anywhere. The interview
 * socket carries microphone audio and no fields; the interviewer persona is
 * authored server-side and states it cannot see the dashboard. A future change
 * that wants to personalise the interview with a mark, a CGPA or a resume does
 * NOT add it here — it goes through complete_chat(..., carries_student_data=True)
 * in apps/api-py/app/ai/llm.py.
 */

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { ChatVoiceService, ChatTurn } from '../../core/chat-voice.service';
import { InterviewService, InterviewState } from '../../core/interview.service';
import { AuthService } from '../../core/auth.service';
import { PageIntroComponent } from '../../shared/kit/kit.components';
import {
  MockAudioStreamController,
  VisualizerState,
  VoiceVisualizer,
} from '../../shared/voice-visualizer';

/**
 * localStorage key prefix remembering that the interview disclosure was read.
 *
 * PER USER, not global. This was a single shared key, and REEP runs on shared
 * lab PCs: once any one student accepted, every student who signed in on that
 * machine afterwards had the disclosure silently suppressed and went straight
 * into a live microphone session having never been shown what it does with
 * their audio. Keying by user id means the disclosure follows the person.
 *
 * Only a CACHE. A cleared browser shows the notice again, which is the safe
 * direction to fail.
 */
const CONSENT_KEY_PREFIX = 'reep-interview-consent:';

/** The pill's wording. The pill carries colour; this carries meaning, and both
 *  are always set together — colour alone is never a status in this repo. */
const STATE_LABELS: Record<InterviewState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  ready: 'Connected',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Interviewer speaking',
  ended: 'Session ended',
  error: 'Problem',
};

const STATE_CAPTIONS: Record<InterviewState, string> = {
  idle: 'Press Start interview when you are ready.',
  connecting: 'Setting up your microphone and connecting…',
  ready: 'Connected. The interviewer will ask the first question shortly.',
  listening: 'Go ahead — the interviewer is listening.',
  thinking: 'Thinking about your answer…',
  speaking: 'Listen to the question. You can interrupt at any time.',
  ended: 'The session has ended. Start another whenever you like.',
  error: 'Something went wrong. See the message above.',
};

/**
 * InterviewState -> the orb's four visual states.
 *
 * `thinking` maps to Connecting rather than Listening on purpose: Connecting is
 * the dim, slightly deflated, 6.3-second-breath row, which reads as considering
 * — and it is visibly distinct from Listening, so the student can tell at a
 * glance whether it is their turn. `error` keeps the Idle geometry and asks for
 * the error tint instead of a fifth state; the pill still says "Problem".
 */
const ORB_STATE: Record<InterviewState, VisualizerState> = {
  idle: VisualizerState.Idle,
  connecting: VisualizerState.Connecting,
  ready: VisualizerState.Listening,
  listening: VisualizerState.Listening,
  thinking: VisualizerState.Connecting,
  speaking: VisualizerState.Speaking,
  ended: VisualizerState.Idle,
  error: VisualizerState.Idle,
};

@Component({
  selector: 'app-assistant',
  standalone: true,
  imports: [PageIntroComponent, RouterLink],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent implements AfterViewInit, OnDestroy {
  private readonly interview = inject(InterviewService);
  /** Only for the persisted conversation: loadHistory + clearConversation. */
  private readonly chat = inject(ChatVoiceService);
  /** Only to scope the consent cache and to know whether this is a student. */
  private readonly auth = inject(AuthService);

  // -- interview state, straight through from the service ---------------- //
  readonly state = this.interview.state;
  readonly notice = this.interview.notice;
  readonly lines = this.interview.lines;
  readonly micLevel = this.interview.micLevel;
  readonly clockLabel = this.interview.clockLabel;
  readonly capLabel = this.interview.capLabel;
  readonly clockWarning = this.interview.clockWarning;
  readonly active = this.interview.active;
  readonly secureContext = this.interview.secureContext;

  // -- the persisted conversation (text + every past interview turn) ------ //
  readonly history = this.chat.chatHistory;
  readonly historyError = signal<string | null>(null);
  readonly historyOpen = signal(false);

  /** The one-time disclosure panel is showing. */
  readonly showConsent = signal(false);

  /** Mock interviews are a student feature; the backend refuses anyone else and
   *  the three /assistant routes all land here, so say so rather than letting a
   *  mentor press Start and collect an opaque connection failure. */
  readonly isStudent = computed(() => this.auth.session()?.role === 'STUDENT');

  /** The pill's words: the service's own detail when it has one, else the
   *  state's label. */
  readonly statusLabel = computed(
    () => this.interview.detail() ?? STATE_LABELS[this.state()],
  );
  readonly statusCaption = computed(() => STATE_CAPTIONS[this.state()]);

  /** Start is offered from every terminal state, and only from a terminal one. */
  readonly canStart = computed(
    () => !this.active() && this.isStudent() && this.secureContext,
  );

  /** Mic level as a 0..100 integer, for the meter's aria-valuenow and width. */
  readonly micPercent = computed(() => Math.round(this.micLevel() * 100));

  private readonly orbCanvas = viewChild<ElementRef<HTMLCanvasElement>>('orbCanvas');
  private readonly transcript = viewChild<ElementRef<HTMLElement>>('transcript');
  private readonly consentCard = viewChild<ElementRef<HTMLElement>>('consentCard');
  /** What had focus before the consent dialog opened, so it can be restored. */
  private consentReturnFocus: HTMLElement | null = null;

  /**
   * The orb's amplitude source. DOM-free, so it is safe in a field initialiser
   * and exists before the first effect runs; the canvas-bound visualizer is
   * built later, in ngAfterViewInit.
   */
  private readonly orb = new MockAudioStreamController();
  private visualizer: VoiceVisualizer | null = null;

  constructor() {
    void this.loadHistory();

    // --- drive the orb ------------------------------------------------- //
    // Injection only moves a damper TARGET; the visualizer's own render loop
    // advances the damper. So publishing at the microphone's 25 Hz (user) and
    // the analyser's 20 Hz (interviewer) is exactly the rate the class asks for,
    // and nothing here can make the orb snap however jumpy the feed is.
    //
    // mapRmsToAmplitude is called on the CONTROLLER rather than reimplemented:
    // the dB floor/ceiling and the 0.65 perceptual exponent are documented there
    // and that is the only place they exist.
    effect(() => {
      this.orb.injectUserAudioAmplitude(
        this.orb.mapRmsToAmplitude(this.interview.userRms()),
      );
    });
    effect(() => {
      this.orb.injectAiAudioAmplitude(this.orb.mapRmsToAmplitude(this.interview.aiRms()));
    });
    effect(() => {
      const s = this.state();
      // setState only swaps a target row, so a state change morphs rather than
      // cuts. Safe to call before the visualizer exists — ngAfterViewInit
      // replays the current state onto it.
      this.visualizer?.setState(ORB_STATE[s], s === 'error');
    });

    // --- keep the live transcript pinned to the newest line ------------- //
    effect(() => {
      this.lines();
      const el = this.transcript()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });

    // --- re-read the persisted conversation when a session finishes ----- //
    // Interview turns are written server-side, in-process, as they arrive; the
    // client never posts a transcript. This is the reconciliation that makes
    // them appear in the history panel.
    effect(() => {
      if (this.interview.completedSessions() === 0) return;
      void this.loadHistory();
    });

    // --- move focus INTO the consent dialog when it opens --------------- //
    // It is marked aria-modal="true", which tells a screen reader the rest of
    // the page is inert — but that is a promise about focus, not a mechanism.
    // @angular/cdk is not a dependency here, so this is hand-rolled.
    effect(() => {
      const card = this.consentCard()?.nativeElement;
      if (this.showConsent() && card) queueMicrotask(() => card.focus());
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.orbCanvas()?.nativeElement;
    if (!canvas) return;
    // The canvas's parent already carries .rvz-overlay, so the constructor
    // ADOPTS it instead of wrapping the canvas in a new full-screen div — which
    // is what lets the component stylesheet lay the orb out inline.
    this.visualizer = new VoiceVisualizer(canvas, this.orb);
    const s = this.state();
    this.visualizer.setState(ORB_STATE[s], s === 'error');
    // show() is what starts the render loop; there is no other entry point.
    this.visualizer.show();
  }

  /**
   * Leaving the screen must release the microphone.
   *
   * InterviewService is root-provided, so it OUTLIVES this component. Without
   * this, navigating away left a live socket publishing the student's voice with
   * no visible indication and no control to stop it. AGENTS.md rule 1 is about
   * student data not leaving unbidden, and a hot mic is the most literal form of
   * it. (Tab close is covered separately, by the service's pagehide listener —
   * this hook does not run then.)
   */
  ngOnDestroy(): void {
    this.interview.end('Left the assistant');
    // destroy() FIRST, dispose() second. That order is documented on
    // MockAudioStreamController.dispose: zeroing the dampers while a frame can
    // still read them would snap the orb on its last painted frame.
    this.visualizer?.destroy();
    this.visualizer = null;
    this.orb.dispose();
  }

  // ------------------------------------------------------------------ //
  // Controls                                                           //
  // ------------------------------------------------------------------ //

  /** Start / End. Not awaited from the template: the click handler must return
   *  promptly so the gesture is not held open across the getUserMedia prompt. */
  toggle(): void {
    if (this.active()) {
      this.interview.end();
      return;
    }
    if (!this.canStart()) return;
    if (this.hasConsent()) {
      void this.interview.start();
      return;
    }
    // First use — show the disclosure before touching the microphone.
    this.consentReturnFocus = document.activeElement as HTMLElement | null;
    this.showConsent.set(true);
  }

  dismissNotice(): void {
    this.interview.dismissNotice();
  }

  /** Consent panel — "I understand — start the interview". */
  acceptConsent(): void {
    this.showConsent.set(false);
    const key = this.consentKey();
    if (key) {
      try {
        localStorage.setItem(key, 'true');
      } catch {
        /* storage blocked — the disclosure simply shows again next time */
      }
    }
    void this.interview.start();
  }

  /** Consent panel — "Cancel". */
  cancelConsent(): void {
    this.showConsent.set(false);
    // Send focus back where it came from. Dropping it on <body> would strand a
    // keyboard user at the top of the document.
    this.consentReturnFocus?.focus();
    this.consentReturnFocus = null;
  }

  /**
   * Keep Tab inside the dialog. Wrapping at each end is what makes the modality
   * real rather than advisory.
   *
   * Bound to BOTH `(keydown.tab)` and `(keydown.shift.tab)` in the template.
   * Angular matches modifiers exactly, so `keydown.tab` does not fire when Shift
   * is held — with only that binding, Shift+Tab from the first control walked
   * straight out of the "modal" dialog and back into the page behind it.
   */
  trapConsentTab(event: Event): void {
    const ev = event as KeyboardEvent;
    const card = this.consentCard()?.nativeElement;
    if (!card) return;
    const focusable = [...card.querySelectorAll<HTMLElement>('button, a[href]')].filter(
      (el) => !el.hasAttribute('disabled'),
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement as HTMLElement | null;

    if (ev.shiftKey && (activeEl === first || activeEl === card)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && activeEl === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  // ------------------------------------------------------------------ //
  // Conversation history                                               //
  // ------------------------------------------------------------------ //

  toggleHistory(): void {
    this.historyOpen.update((open) => !open);
  }

  /** The text of one persisted turn, whichever shape it arrived in. */
  turnText(turn: ChatTurn): string {
    return turn.structured?.answer ?? turn.content;
  }

  /** Discard the server-owned conversation — text turns and interview turns
   *  alike. This is the student's delete control over their own transcripts. */
  async clearConversation(): Promise<void> {
    if (this.active()) return;
    this.historyError.set(null);
    try {
      await this.chat.clearConversation();
    } catch {
      this.historyError.set('Could not clear the conversation. Please try again.');
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      await this.chat.loadHistory();
    } catch {
      /* fresh session, or the API is unreachable — nothing to restore */
    }
  }

  // ------------------------------------------------------------------ //
  // Consent cache                                                      //
  // ------------------------------------------------------------------ //

  /** The per-user cache key, or null when nobody is signed in. */
  private consentKey(): string | null {
    const userId = this.auth.session()?.userId;
    return userId ? `${CONSENT_KEY_PREFIX}${userId}` : null;
  }

  private hasConsent(): boolean {
    const key = this.consentKey();
    // No key means no identified user — show the disclosure rather than
    // assuming a previous student's acceptance covers this one.
    if (!key) return false;
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  }
}
