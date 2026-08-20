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
 *    interview: the disclosure below is shown in place, before the first Start
 *    under the terms the server is currently asking for.
 *
 * CONSENT IS A ROW ON THE SERVER, NOT A FLAG IN THIS BROWSER. It used to be a
 * localStorage key. That was a cache and not consent: nothing on the server read
 * it, the student could clear it, and on a shared lab PC it belonged to the
 * machine rather than to the person. It now POSTs to /api/interview/consent and
 * the grant comes back from the server, so "was this student consented, to what,
 * when" is answerable after the fact — which is the only form of the question
 * that matters. Three scopes, not one, because they are three different
 * disclosures and a student may reasonably accept two and refuse the third; one
 * boolean makes "they consented" unfalsifiable.
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

import { environment } from '../../../environments/environment';
import { ChatVoiceService, ChatTurn } from '../../core/chat-voice.service';
import { InterviewService, InterviewState } from '../../core/interview.service';
import { AuthService } from '../../core/auth.service';
import { PageIntroComponent } from '../../shared/kit/kit.components';
// Shared with the interview-history screen rather than duplicated. The two
// screens render the SAME scorecard from two sources, and the calibration copy
// on it is the thing §5.4 traded the score's visibility for — maintaining that
// sentence in two templates is how one of them ends up without it.
import {
  InterviewReportCardComponent,
  ReportCardView,
} from '../student/interviews/interview-report-card.component';
import {
  MockAudioStreamController,
  VisualizerState,
  VoiceVisualizer,
} from '../../shared/voice-visualizer';

/** One consent grant, verbatim from ConsentOut in
 *  apps/api-py/app/routers/interview_records.py. */
interface ConsentGrant {
  id: string;
  version: string;
  scope_live_ai: boolean;
  scope_store_transcript: boolean;
  scope_store_audio: boolean;
  granted_at: string;
}

/**
 * GET /api/interview/consent, verbatim from ConsentStateOut.
 *
 * `version` is not decoration and must be read from here rather than baked into
 * this bundle: POST refuses a version string it does not know, precisely so a
 * stale cached SPA cannot grant against copy the student never saw. `consent` is
 * already scoped to that version server-side — a live grant carrying last term's
 * string comes back as null, and the panel opens again with the new copy.
 */
interface ConsentState {
  version: string;
  consent: ConsentGrant | null;
}

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
  // Reworded for the v3 turn protocol. The next question is now created only
  // AFTER your answer has been transcribed, so this wait is real and it grows
  // with the length of the answer. Saying what is happening is what stops the
  // silence reading as a hung page; the progress affordance below adds a clock.
  thinking: 'You have stopped speaking. The interviewer replies once it has your whole answer.',
  speaking: 'Listen to the question. You can interrupt at any time.',
  ended: 'The session has ended. Start another whenever you like.',
  error: 'Something went wrong. See the message above.',
};

/** Past this many seconds in `thinking`, the affordance stops naming what it is
 *  doing and starts explaining WHY it is taking this long. A long answer takes
 *  longer to transcribe, and the student should hear that from the app rather
 *  than infer "it broke" from the silence. */
const THINKING_LONG_AFTER_S = 6;

/**
 * The Specialization Matrix, as offered on the picker. `key: null` is the
 * generic interview that predates the matrix; the four keyed rows mirror
 * SPECIALIZATIONS in apps/api-py/app/interview_matrix.py, which is the source
 * of truth — the server refuses a key it does not know (close 4010), so a row
 * added here without the backend row fails loudly rather than silently.
 */
interface SpecializationOption {
  key: string | null;
  label: string;
  blurb: string;
}

const SPECIALIZATION_OPTIONS: readonly SpecializationOption[] = [
  {
    key: null,
    label: 'General interview',
    blurb: 'Placement readiness across the board — no single track.',
  },
  {
    key: 'hr',
    label: 'Human Resources (HR)',
    blurb: 'STAR method, labor laws, conflict resolution, talent acquisition.',
  },
  {
    key: 'dm',
    label: 'Digital Marketing (DM)',
    blurb: 'CAC/LTV, ROAS, SEO/SEM, A/B testing, funnels, brand positioning.',
  },
  {
    key: 'ba',
    label: 'Business Analytics (BA)',
    blurb: 'SQL/Python, data modeling, predictive analytics, visualization.',
  },
  {
    key: 'fa',
    label: 'Financial Analytics (FA)',
    blurb: 'DCF modeling, financial ratios, risk, valuation, M&A.',
  },
];

/** The state machine's phases, in words for the pill next to the clock. Every
 *  InterviewPhase member in apps/api-py/app/interview_matrix.py is here —
 *  `ended` included, or a wrap-up close renders the raw key in the pill. */
const PHASE_LABELS: Record<string, string> = {
  opening: 'Opening question',
  probing: 'Framework probing',
  deep_dive: 'Deep dive',
  wrap_up: 'Wrap-up',
  ended: 'Finished',
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
  imports: [PageIntroComponent, RouterLink, InterviewReportCardComponent],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent implements AfterViewInit, OnDestroy {
  private readonly interview = inject(InterviewService);
  /** Only for the persisted conversation: loadHistory + clearConversation. */
  private readonly chat = inject(ChatVoiceService);
  /** Only to know whether this is a student. Consent is no longer keyed here —
   *  it is a row on the server, fetched below. */
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
  /** The matrix row and phase of the LIVE interview, as the relay reports them. */
  readonly liveSpecialization = this.interview.specialization;
  readonly livePhase = this.interview.phase;
  /** The v3 wait affordance. See THINKING_AFFORDANCE_AFTER_MS in the service. */
  readonly thinkingSlow = this.interview.thinkingSlow;
  readonly thinkingSeconds = this.interview.thinkingSeconds;
  /** The verdict has been spoken and the scorecard is being written. */
  readonly composingReport = this.interview.composingReport;

  /** The picker's selection, applied to the next Start. null = General. */
  readonly selectedSpecialization = signal<string | null>(null);
  readonly specializationOptions = SPECIALIZATION_OPTIONS;

  // -- the persisted conversation (text + every past interview turn) ------ //
  readonly history = this.chat.chatHistory;
  readonly historyError = signal<string | null>(null);
  readonly historyOpen = signal(false);

  // -- consent, which is a server row (see the file header) --------------- //

  /** The disclosure panel is showing. */
  readonly showConsent = signal(false);
  /** The version string the SERVER is asking for, learned from GET /consent.
   *  Null until that call answers — and Start cannot grant without it, because
   *  POST refuses a version it does not know. */
  readonly consentVersion = signal<string | null>(null);
  /** The caller's live grant for that version, or null. */
  readonly consent = signal<ConsentGrant | null>(null);
  /** The audio checkbox, OFF by default. A pre-ticked box is not consent — it
   *  is a default the student did not choose, on the one scope that keeps a
   *  recording of their voice for staff to listen to. */
  readonly consentAudio = signal(false);
  readonly consentBusy = signal(false);
  readonly consentError = signal<string | null>(null);

  /** Mock interviews are a student feature; the backend refuses anyone else and
   *  the three /assistant routes all land here, so say so rather than letting a
   *  mentor press Start and collect an opaque connection failure. */
  readonly isStudent = computed(() => this.auth.session()?.role === 'STUDENT');

  /** The pill's words: the service's own detail when it has one, else the
   *  state's label. */
  readonly statusLabel = computed(
    () => this.interview.detail() ?? STATE_LABELS[this.state()],
  );
  /**
   * The caption under the pill. Overridden for the scorecard wait, because the
   * `thinking` caption ("the interviewer replies once it has your whole answer")
   * describes the wrong wait entirely — nothing is being asked and nothing more
   * will be, and a student told to expect a reply will speak into a response
   * that is deliberately deaf to them.
   */
  readonly statusCaption = computed(() =>
    this.composingReport() && this.state() === 'thinking'
      ? 'Your answers are all in. The interviewer is writing your practice report — you do not need to say anything.'
      : STATE_CAPTIONS[this.state()],
  );

  /** The affordance is shown for the whole scorecard wait, not after a delay:
   *  unlike a transcription this one is KNOWN to take seconds, so waiting 1.2 s
   *  to admit it buys nothing. */
  readonly showWait = computed(
    () => this.state() === 'thinking' && (this.thinkingSlow() || this.composingReport()),
  );

  /** The live phase, in words — null when the relay has not named one. */
  readonly phaseLabel = computed(() => {
    const phase = this.livePhase();
    return phase ? (PHASE_LABELS[phase] ?? phase) : null;
  });

  /** Start is offered from every terminal state, and only from a terminal one. */
  readonly canStart = computed(
    () => !this.active() && this.isStudent() && this.secureContext,
  );

  /** Mic level as a 0..100 integer, for the meter's aria-valuenow and width. */
  readonly micPercent = computed(() => Math.round(this.micLevel() * 100));

  /** What the wait affordance says. It names the mechanism on purpose: a
   *  student who knows the app is transcribing waits; a student watching a
   *  static orb reloads the page and loses the interview. */
  readonly thinkingHint = computed(() => {
    if (this.composingReport()) return 'Writing your practice report — this takes a few seconds.';
    return this.thinkingSeconds() >= THINKING_LONG_AFTER_S
      ? 'Still transcribing — a long answer takes longer. You have not been missed.'
      : 'Transcribing your answer…';
  });

  /**
   * This session's scorecard in the shared card's shape, or null before one
   * arrives.
   *
   * `available: false` maps onto the card's status vocabulary rather than being
   * flattened into "no report": the interview COMPLETED and only the scorecard
   * did not, the relay closes 1000 for exactly that reason, and the card has a
   * distinct sentence for each cause. Collapsing them here would throw away the
   * one piece of information the student can act on.
   */
  readonly reportView = computed<ReportCardView | null>(() => {
    const result = this.interview.report();
    if (result === null) return null;
    const r = result.report;
    return {
      status: result.available ? 'ok' : (result.reason ?? 'unavailable'),
      overall: r?.overall ?? null,
      communication: r?.communication ?? null,
      domain: r?.domain ?? null,
      structure: r?.structure ?? null,
      strengths: r?.strengths ?? [],
      improvements: r?.improvements ?? [],
      drill: r?.drill ?? '',
      summary: r?.summary ?? '',
      // Null: this one was generated seconds ago and a timestamp on it would be
      // noise. The history screen, where it matters, passes the real one.
      generatedAt: null,
    };
  });

  /** "12 Aug 2026" for the live grant, or null. */
  readonly consentGrantedLabel = computed(() => {
    const row = this.consent();
    if (!row) return null;
    const d = new Date(row.granted_at);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  });

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
    void this.loadConsent();

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
    if (this.consent()) {
      void this.interview.start(this.selectedSpecialization());
      return;
    }
    // No live grant for the current terms — show the disclosure before touching
    // the microphone. This also covers "the terms changed since last time": the
    // server scopes the grant to its current version, so `consent()` is null and
    // the student reads the new copy rather than being carried by an old yes.
    this.openConsent();
  }

  /** The specialization picker. Selecting never starts anything on its own. */
  pick(key: string | null): void {
    if (this.active()) return;
    this.selectedSpecialization.set(key);
  }

  dismissNotice(): void {
    this.interview.dismissNotice();
  }

  /** Open the disclosure — before the first interview, or from "Change". */
  openConsent(): void {
    // Pre-tick the audio box only if the student's own live grant already says
    // yes. Reopening the panel must show them what they chose last time, and
    // must never invent a yes they did not give.
    this.consentAudio.set(this.consent()?.scope_store_audio ?? false);
    this.consentError.set(null);
    this.consentReturnFocus = document.activeElement as HTMLElement | null;
    this.showConsent.set(true);
  }

  /** The audio checkbox. */
  setConsentAudio(on: boolean): void {
    this.consentAudio.set(on);
  }

  /**
   * Consent panel — "I agree". Records the grant, THEN starts the interview.
   *
   * FAILS CLOSED, and that is the whole point of moving consent off
   * localStorage: if the grant cannot be recorded, the thing the grant
   * authorises does not run. Starting anyway "so the student is not blocked"
   * would put us straight back where we were — an interview conducted against a
   * consent nobody can produce afterwards. The student sees why, and can retry.
   *
   * This puts an `await` between the click and getUserMedia/AudioContext.
   * resume(), both of which want a user gesture behind them. It is not a new
   * hazard: InterviewService.start() already awaits GET /interview/status before
   * it touches the microphone, and a transient activation lasts seconds while
   * these are same-origin calls to the proxy. It is worth knowing about before
   * anyone adds a THIRD round trip here.
   */
  async acceptConsent(): Promise<void> {
    const version = this.consentVersion();
    if (!version) {
      // We never learned which terms the server is asking for, so there is no
      // honest version to grant against. Re-read and let them press again.
      this.consentError.set('Could not read the interview terms. Please try again.');
      void this.loadConsent();
      return;
    }
    this.consentBusy.set(true);
    this.consentError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/interview/consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version,
          // The two the "I agree" button grants — the interview cannot run
          // without either, and the panel says so above the button.
          scope_live_ai: true,
          scope_store_transcript: true,
          // The one that is genuinely optional, and is why there are three
          // booleans rather than one.
          scope_store_audio: this.consentAudio(),
        }),
      });
      if (res.status === 422) {
        // The terms moved under a cached bundle. A reload is the fix, and it is
        // the only one — granting against copy the student never saw is exactly
        // what the version check exists to prevent.
        this.consentError.set(
          'The interview terms have changed since this page loaded. Reload the page to read the new ones.',
        );
        return;
      }
      if (res.status === 403) {
        this.consentError.set('Mock interviews are a student feature.');
        return;
      }
      if (!res.ok) {
        this.consentError.set('Could not record your consent. Please try again.');
        return;
      }
      this.consent.set((await res.json()) as ConsentGrant);
      this.showConsent.set(false);
      // Focus goes back where it came from — the Start button, which is about to
      // become End. Dropping it on <body> because the dialog vanished would
      // strand a keyboard user at the top of the document with a live microphone
      // and no reachable control to stop it.
      this.consentReturnFocus?.focus();
      this.consentReturnFocus = null;
      void this.interview.start(this.selectedSpecialization());
    } catch {
      this.consentError.set('Could not reach the server. Please try again.');
    } finally {
      this.consentBusy.set(false);
    }
  }

  /** Consent panel — "Cancel". */
  cancelConsent(): void {
    this.showConsent.set(false);
    this.consentError.set(null);
    // Send focus back where it came from. Dropping it on <body> would strand a
    // keyboard user at the top of the document.
    this.consentReturnFocus?.focus();
    this.consentReturnFocus = null;
  }

  /**
   * Withdraw consent. Expressible at all only because a grant is a row.
   *
   * It stamps `revoked_at` and leaves the historical row: the interviews already
   * conducted under it still point at the grant that was live when they ran, so
   * "was this student consented at the time" stays answerable. It does NOT
   * delete those interviews, and the copy beside this button says so rather than
   * letting "withdraw" imply an erase it does not perform.
   */
  async withdrawConsent(): Promise<void> {
    if (this.active() || this.consentBusy()) return;
    this.consentBusy.set(true);
    this.consentError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/interview/consent`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        this.consentError.set('Could not withdraw your consent. Please try again.');
        return;
      }
      const state = (await res.json()) as ConsentState;
      this.consentVersion.set(state.version);
      this.consent.set(state.consent);
    } catch {
      this.consentError.set('Could not reach the server. Please try again.');
    } finally {
      this.consentBusy.set(false);
    }
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
    // `input` is in this list because the panel now carries the optional audio
    // checkbox. Leaving it out did not make the checkbox unreachable — the
    // browser still tabs to it — it made the WRAP wrong: the computed "first"
    // would have been the Cancel button below it, so Shift+Tab from the checkbox
    // walked straight out of a dialog that claims aria-modal="true".
    const focusable = [...card.querySelectorAll<HTMLElement>('button, a[href], input')].filter(
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
  // Consent state                                                      //
  // ------------------------------------------------------------------ //

  /**
   * Read the caller's own grant, and the version the server is asking for.
   *
   * A failure here leaves `consentVersion` null, which makes acceptConsent()
   * refuse rather than guess — the safe direction. It deliberately does NOT
   * surface a banner on load: an unreachable endpoint is not something to
   * interrupt a student with before they have pressed anything, and the panel
   * will say so at the moment it actually matters.
   */
  private async loadConsent(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/interview/consent`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const state = (await res.json()) as ConsentState;
      this.consentVersion.set(state.version);
      this.consent.set(state.consent);
    } catch {
      /* offline or not signed in — the panel handles it on Start */
    }
  }
}
