/**
 * The floating REEP Agent orb, and the full-screen voice overlay it opens.
 *
 * Lives in the SHELL, not in a route, because the design puts it on every
 * screen — a route-owned copy would vanish on the login screen's sibling routes
 * and would reset its dragged position on every navigation.
 *
 * DRAG VS TAP IS ONE GESTURE, resolved by distance. `pointerdown` starts a
 * drag; a `pointerup` that has travelled under DRAG_THRESHOLD px is treated as a
 * tap and opens voice mode. Without that threshold the orb is either draggable
 * or clickable but never both: every real tap moves a pointer by a pixel or two,
 * so "moved at all ⇒ drag" makes the button impossible to press on a trackpad,
 * and "pointerup ⇒ tap" makes it impossible to drag without opening the overlay.
 *
 * LISTENERS GO ON `document`, NOT ON THE ORB. A pointer that leaves the orb's
 * 58px box mid-drag — which is most of a drag — stops delivering events to it,
 * and the orb sticks to the cursor until the next click. They are removed on
 * pointerup and again in ngOnDestroy, so a component torn down mid-drag (a
 * sign-out, say) does not leave two handlers bound to a dead component.
 *
 * VOICE MODE IS THE REAL THING, OR IT SAYS IT IS NOT. Opening the overlay
 * starts a session on ChatVoiceService (LiveKit; the voice worker described in
 * AGENTS.md step 4). The overlay renders the service's state: connecting, the
 * microphone prompt, listening / thinking / speaking, and — when the server
 * reports voice unavailable, which is every deployment without LIVEKIT_* and a
 * running worker — the server's own reason, with the two things that DO work
 * from here: the typed REEP Agent, and for a student the mock interviewer.
 * The previous overlay animated a waveform over nothing, which read as "voice
 * is broken" rather than "voice is not set up".
 *
 * THE SERVICE IS LOADED LAZILY, ON THE FIRST OPEN. ChatVoiceService imports
 * `livekit-client` (~580 kB), and the orb sits in the eagerly-loaded shell;
 * a static import here put the whole SDK into the initial bundle and failed the
 * production budget (708 kB against 250). `import()` on open keeps it in its own
 * chunk, fetched only by whoever actually presses the orb.
 */

import {
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  Injector,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../core/auth.service';
// `import type` is erased at compile time, so the SDK stays out of this chunk.
import type { ChatVoiceService } from '../core/chat-voice.service';
import type { Role } from '../core/session';

const DRAG_THRESHOLD = 4;

/** Keeps the orb on screen: it may not be dragged further than this from its
 *  anchored corner, leaving ~110px of it always reachable. */
const EDGE_MARGIN = 110;

/** Bar heights and animation durations, straight from the design. Fixed rather
 *  than random so the waveform is identical on every open — a bar pattern that
 *  reshuffles per session reads as a rendering bug. */
const WAVE_BARS = [26, 48, 74, 92, 78, 56, 88, 40, 66, 34, 82, 50, 70, 30, 60];
const WAVE_DURATIONS = [1.05, 1.23, 1.41, 1.59, 1.77];

/** Where "Type instead" goes: each role's own REEP Agent route. */
function agentRouteFor(role: Role | undefined): string {
  if (role === 'DIRECTOR' || role === 'ADMIN') return '/director/agent';
  if (role === 'MENTOR') return '/mentor/agent';
  return '/student/agent';
}

@Component({
  selector: 'app-agent-orb',
  standalone: true,
  template: `
    <button
      #orb
      type="button"
      class="agent-orb"
      [style.transform]="translate()"
      [attr.aria-label]="'Open the REEP Agent voice mode'"
      (pointerdown)="onPointerDown($event)"
    >
      <span class="icon" aria-hidden="true">smart_toy</span>
    </button>

    @if (voice()) {
      <div class="voice-overlay" role="dialog" aria-modal="true" aria-label="REEP Agent voice mode">
        <div class="vo-top">
          <span class="inline">
            <span class="icon" aria-hidden="true">smart_toy</span>
            REEP Agent · Voice
          </span>
          <button type="button" class="vo-close" (click)="close()">
            Close
            <span class="icon" aria-hidden="true">close</span>
          </button>
        </div>

        <div class="vo-centre">
          <div class="vo-orb" aria-hidden="true"></div>

          @switch (phase()) {
            @case ('unavailable') {
              <div class="waveform muted-rule" aria-hidden="true">
                <span class="muted-bar"></span>
              </div>
              <p class="vo-state">
                <span class="icon" aria-hidden="true">info</span>
                Voice is not available on this server
              </p>
              <p class="vo-quote">{{ errorText() }}</p>
              <div class="vo-actions">
                <button type="button" class="btn" (click)="typeInstead()">
                  <span class="icon" aria-hidden="true">keyboard</span>
                  Type to the REEP Agent
                </button>
                @if (isStudent()) {
                  <button type="button" class="btn primary" (click)="startInterview()">
                    <span class="icon" aria-hidden="true">mic</span>
                    Start a mock interview
                  </button>
                }
              </div>
            }
            @case ('error') {
              <div class="waveform muted-rule" aria-hidden="true">
                <span class="muted-bar"></span>
              </div>
              <p class="vo-state">
                <span class="icon" aria-hidden="true">error</span>
                {{ errorText() }}
              </p>
              <div class="vo-actions">
                <button type="button" class="btn primary" (click)="retry()">Retry</button>
                <button type="button" class="btn" (click)="typeInstead()">Type instead</button>
              </div>
            }
            @case ('connecting') {
              <div class="waveform muted-rule" aria-hidden="true">
                <span class="muted-bar"></span>
              </div>
              <p class="vo-state">{{ stateLabel() }}</p>
            }
            @default {
              <!-- Muted replaces the waveform with a single rule AT THE SAME
                   HEIGHT, so the layout does not jump when the mic is toggled. -->
              @if (muted()) {
                <div class="waveform muted-rule">
                  <span class="muted-bar"></span>
                </div>
                <p class="vo-state">Mic muted</p>
              } @else {
                <div class="waveform" aria-hidden="true">
                  @for (bar of bars; track $index) {
                    <i
                      [style.height.px]="bar"
                      [style.animation-duration.s]="duration($index)"
                      [style.animation-delay.s]="delay($index)"
                    ></i>
                  }
                </div>
                <p class="vo-state">{{ stateLabel() }}</p>
              }
              @if (lastLine(); as line) {
                <p class="vo-quote">“{{ line }}”</p>
              }
            }
          }
        </div>

        @if (phase() === 'live' || phase() === 'connecting') {
          <div class="voice-controls">
            <button
              type="button"
              [attr.aria-pressed]="muted()"
              [attr.aria-label]="muted() ? 'Unmute the microphone' : 'Mute the microphone'"
              [disabled]="phase() !== 'live'"
              (click)="toggleMute()"
            >
              <span class="icon" aria-hidden="true">{{ muted() ? 'mic' : 'mic_off' }}</span>
            </button>
            <button type="button" aria-label="Type instead" (click)="typeInstead()">
              <span class="icon" aria-hidden="true">keyboard</span>
            </button>
            <button type="button" class="end" aria-label="End session" (click)="close()">
              <span class="icon" aria-hidden="true">call_end</span>
            </button>
          </div>
        }

        <p class="voice-disclaimer">
          REEP Agent answers on programme rules and deadlines. It does not see your marks,
          attendance or USN.
        </p>
      </div>
    }
  `,
  styles: [
    `
      .vo-actions {
        display: flex;
        gap: 10px;
        justify-content: center;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      .vo-state .icon {
        vertical-align: -3px;
        margin-right: 6px;
      }
    `,
  ],
})
export class AgentOrbComponent implements OnDestroy {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly orb = viewChild.required<ElementRef<HTMLButtonElement>>('orb');

  /** The lazily-loaded voice service; null until the first open has fetched
   *  its chunk. Every computed below reads through this signal, so the overlay
   *  re-derives itself the moment the service arrives. */
  private readonly svc = signal<ChatVoiceService | null>(null);
  private loading: Promise<ChatVoiceService> | null = null;

  /** Whether the overlay is open. The SESSION state lives on the service. */
  readonly voice = signal(false);
  readonly muted = computed(() => this.svc()?.micMuted() ?? false);

  readonly isStudent = computed(() => this.auth.session()?.role === 'STUDENT');

  /**
   * The overlay's four looks, derived from the service's state:
   *  - unavailable: the server said voice is not configured (the common case)
   *  - error: the mic was blocked, the connection dropped, or it timed out
   *  - connecting: readiness probe, mic prompt, room join, reconnect
   *  - live: listening / thinking / speaking
   */
  readonly phase = computed<'unavailable' | 'error' | 'connecting' | 'live'>(() => {
    const svc = this.svc();
    if (!svc) return this.loadFailed() ? 'error' : 'connecting';
    const state = svc.voiceState();
    if (state === 'error') {
      const reason = (svc.voiceError() ?? '').toLowerCase();
      return reason.includes('not configured') ||
        reason.includes('not available') ||
        reason.includes('unavailable')
        ? 'unavailable'
        : 'error';
    }
    if (state === 'listening' || state === 'thinking' || state === 'speaking') return 'live';
    return 'connecting';
  });

  /** The voice chunk itself failed to download (offline, a stale deploy). */
  private readonly loadFailed = signal(false);

  readonly errorText = computed(() => {
    if (!this.svc() && this.loadFailed()) {
      return 'Voice mode could not be loaded. Check your connection and retry.';
    }
    return this.svc()?.voiceError() ?? 'Voice is not available right now.';
  });

  readonly stateLabel = computed(() => {
    switch (this.svc()?.voiceState()) {
      case 'permission-check':
        return 'Allow the microphone to continue…';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Reconnecting…';
      case 'listening':
        return 'Listening…';
      case 'thinking':
        return 'Thinking…';
      case 'speaking':
        return 'Speaking…';
      default:
        return 'Starting…';
    }
  });

  /** The most recent line of the live transcript, so the overlay shows what
   *  was actually heard rather than a canned sample question. */
  readonly lastLine = computed(() => {
    const turns = this.svc()?.voiceTranscript() ?? [];
    const last = turns[turns.length - 1];
    return last?.content?.trim() || null;
  });

  /** Drag offset from the anchored corner, in px. Both are <= 0. */
  private readonly bx = signal(0);
  private readonly by = signal(0);
  readonly translate = computed(() => `translate(${this.bx()}px, ${this.by()}px)`);

  readonly bars = WAVE_BARS;

  private startX = 0;
  private startY = 0;
  private originX = 0;
  private originY = 0;
  private travelled = 0;
  private dragging = false;

  duration(index: number): number {
    return WAVE_DURATIONS[index % WAVE_DURATIONS.length];
  }

  /** Staggered so the bars never pulse in unison, which reads as a progress bar
   *  rather than a voice. */
  delay(index: number): number {
    return -((index * 0.13) % 1.05);
  }

  onPointerDown(event: PointerEvent): void {
    this.dragging = true;
    this.travelled = 0;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.originX = this.bx();
    this.originY = this.by();
    document.addEventListener('pointermove', this.onMove);
    document.addEventListener('pointerup', this.onUp);
    document.addEventListener('pointercancel', this.onUp);
  }

  private readonly onMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    this.travelled = Math.max(this.travelled, Math.hypot(dx, dy));
    // Clamped so the orb can never be dragged off screen and stranded.
    this.bx.set(clamp(this.originX + dx, -(window.innerWidth - EDGE_MARGIN), 0));
    this.by.set(clamp(this.originY + dy, -(window.innerHeight - EDGE_MARGIN), 0));
  };

  private readonly onUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.detach();
    if (this.travelled < DRAG_THRESHOLD) this.open();
  };

  private detach(): void {
    document.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('pointercancel', this.onUp);
  }

  /** Fetch the voice chunk (once) and resolve the root-provided service from
   *  the injector, so it is the SAME instance the assistant screen uses. */
  private loadService(): Promise<ChatVoiceService> {
    const ready = this.svc();
    if (ready) return Promise.resolve(ready);
    this.loading ??= import('../core/chat-voice.service')
      .then((m) => {
        const svc = this.injector.get(m.ChatVoiceService);
        this.svc.set(svc);
        this.loadFailed.set(false);
        return svc;
      })
      .catch((err) => {
        this.loading = null;
        this.loadFailed.set(true);
        throw err;
      });
    return this.loading;
  }

  /** Open the overlay AND start the session: the service probes
   *  /api/voice/status first and reports the server's reason if voice is off. */
  open(): void {
    this.voice.set(true);
    void this.loadService()
      .then((svc) => svc.startVoiceSession())
      .catch(() => undefined);
  }

  retry(): void {
    void this.loadService()
      .then((svc) => svc.startVoiceSession())
      .catch(() => undefined);
  }

  close(): void {
    this.voice.set(false);
    void this.svc()?.stopVoiceSession().catch(() => undefined);
    // Focus goes back to the control that opened the overlay, so a keyboard
    // user is not returned to the top of the document.
    this.orb().nativeElement.focus();
  }

  toggleMute(): void {
    void this.svc()?.setMicMuted(!this.muted()).catch(() => undefined);
  }

  /** The REEP Agent chat screen for whoever is signed in — the design's
   *  "goAgentChat" from the voice overlay. */
  typeInstead(): void {
    this.close();
    void this.router.navigate([agentRouteFor(this.auth.session()?.role)]);
  }

  /** The mock interviewer — the voice experience that IS deployed (Nova 2 Sonic
   *  on Bedrock, in-process). Students only; the socket refuses other roles. */
  startInterview(): void {
    this.close();
    void this.router.navigate(['/student/assistant']);
  }

  /** The agent screen's "Start voice" button dispatches this on `window`
   *  (features/agent/agent.component.ts) — the orb owns the overlay, the screen
   *  does not, so a DOM event is the whole coupling. */
  @HostListener('window:reep:open-voice')
  onOpenVoiceRequested(): void {
    this.open();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.voice()) this.close();
  }

  ngOnDestroy(): void {
    // A component torn down mid-drag (sign-out, route swap) must not leave two
    // document-level handlers bound to a dead instance.
    this.detach();
    if (this.voice()) void this.svc()?.stopVoiceSession().catch(() => undefined);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
