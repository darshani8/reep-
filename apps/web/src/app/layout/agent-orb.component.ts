/**
 * The floating REEP Agent orb.
 *
 * Lives in the SHELL, not in a route, because the design puts it on every
 * screen — a route-owned copy would vanish on the login screen's sibling routes
 * and would reset its dragged position on every navigation.
 *
 * DRAG VS TAP IS ONE GESTURE, resolved by distance. `pointerdown` starts a
 * drag; a `pointerup` that has travelled under DRAG_THRESHOLD px is treated as a
 * tap and opens the REEP Agent chat. Without that threshold the orb is either
 * draggable or clickable but never both: every real tap moves a pointer by a
 * pixel or two, so "moved at all ⇒ drag" makes the button impossible to press on
 * a trackpad, and "pointerup ⇒ tap" makes it impossible to drag without
 * navigating away.
 *
 * LISTENERS GO ON `document`, NOT ON THE ORB. A pointer that leaves the orb's
 * 58px box mid-drag — which is most of a drag — stops delivering events to it,
 * and the orb sticks to the cursor until the next click. They are removed on
 * pointerup and again in ngOnDestroy, so a component torn down mid-drag (a
 * sign-out, say) does not leave two handlers bound to a dead component.
 *
 * THERE IS NO VOICE OVERLAY. The orb used to open a full-screen LiveKit voice
 * session; that stack was removed from the repo. The two voice experiences that
 * remain are unaffected and neither belongs to the orb: the mock interviewer at
 * /student/assistant (Amazon Nova 2 Sonic, speech-to-speech, in-process) and
 * nothing else. A tap therefore does the one thing the overlay's "Type instead"
 * always did — it opens the typed agent for whoever is signed in.
 */

import {
  Component,
  computed,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../core/auth.service';
import type { Role } from '../core/session';

const DRAG_THRESHOLD = 4;

/** Keeps the orb on screen: it may not be dragged further than this from its
 *  anchored corner, leaving ~110px of it always reachable. */
const EDGE_MARGIN = 110;

/** Where a tap goes: each role's own REEP Agent route. */
function agentRouteFor(role: Role | undefined): string {
  if (role === 'ADMIN') return '/admin/agent';
  if (role === 'MENTOR') return '/mentor/agent';
  return '/student/agent';
}

@Component({
  selector: 'app-agent-orb',
  standalone: true,
  template: `
    <button
      type="button"
      class="agent-orb"
      [style.transform]="translate()"
      aria-label="Open the REEP Agent"
      (pointerdown)="onPointerDown($event)"
    >
      <span class="icon" aria-hidden="true">smart_toy</span>
    </button>
  `,
})
export class AgentOrbComponent implements OnDestroy {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  /** Drag offset from the anchored corner, in px. Both are <= 0. */
  private readonly bx = signal(0);
  private readonly by = signal(0);
  readonly translate = computed(() => `translate(${this.bx()}px, ${this.by()}px)`);

  private startX = 0;
  private startY = 0;
  private originX = 0;
  private originY = 0;
  private travelled = 0;
  private dragging = false;

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

  /** The REEP Agent chat screen for whoever is signed in. */
  open(): void {
    void this.router.navigate([agentRouteFor(this.auth.session()?.role)]);
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
