/**
 * The floating REEP Agent orb, and the full-screen voice overlay it opens.
 *
 * Lives in the SHELL, not in a route, because the handoff puts it on every
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
 */

import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../core/auth.service';
import type { Role } from '../core/session';

/** Pointer travel under this many px is a tap, not a drag. */
const DRAG_THRESHOLD = 4;

/** Keeps the orb on screen: it may not be dragged further than this from its
 *  anchored corner, leaving ~110px of it always reachable. */
const EDGE_MARGIN = 110;

/** Bar heights and animation durations, straight from the handoff. Fixed rather
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

          <!-- Muted replaces the waveform with a single rule AT THE SAME HEIGHT,
               so the layout does not jump when the mic is toggled. -->
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
            <p class="vo-state">Listening…</p>
          }

          <p class="vo-quote">“How many hours do I still need to log this week?”</p>
        </div>

        <div class="voice-controls">
          <button
            type="button"
            [attr.aria-pressed]="muted()"
            [attr.aria-label]="muted() ? 'Unmute the microphone' : 'Mute the microphone'"
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

        <p class="voice-disclaimer">
          REEP Agent answers on programme rules and deadlines. It does not see your marks,
          attendance or USN.
        </p>
      </div>
    }
  `,
})
export class AgentOrbComponent implements OnDestroy {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly orb = viewChild.required<ElementRef<HTMLButtonElement>>('orb');

  readonly voice = signal(false);
  readonly muted = signal(false);

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

  open(): void {
    this.voice.set(true);
  }

  close(): void {
    this.voice.set(false);
    this.muted.set(false);
    // Focus goes back to the control that opened the overlay, so a keyboard
    // user is not returned to the top of the document.
    this.orb().nativeElement.focus();
  }

  toggleMute(): void {
    this.muted.update((m) => !m);
  }

  /** The REEP Agent chat screen for whoever is signed in — the design's
   *  "goAgentChat" from the voice overlay. The interviewer lives elsewhere
   *  (/student/assistant, reached from the landing's Mock Interview module). */
  typeInstead(): void {
    this.voice.set(false);
    void this.router.navigate([agentRouteFor(this.auth.session()?.role)]);
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
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
