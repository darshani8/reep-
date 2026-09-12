/**
 * A control the board draws but the backend cannot yet answer.
 *
 * The admin boards show the whole console, including buttons whose endpoint is
 * a Phase 3 or Phase 4 task in 04-backend-changes.md — Promote batch, Grant
 * function with a scope target, Disable faculty, Sign out everywhere, the
 * import wizard's "Import 52 rows". Phase 2 builds those screens on the
 * endpoints that exist today, which leaves each of those controls with three
 * possible renderings and only one of them honest:
 *
 *   - Leave it out. The screen then stops matching the board it is reviewed
 *     against, and the reviewer cannot tell a missing control from a missed
 *     one.
 *   - Draw it live. It looks like every other button and does nothing, or
 *     worse, posts to an endpoint that answers 404. That is the "dead control
 *     that looks live" 06-phase-prompts.md forbids.
 *   - Draw it disabled, saying when it arrives. The board is recognisable, the
 *     control cannot be pressed, and the answer to "why is this grey" is on
 *     the control itself.
 *
 * This directive is the third. `[reepPending]="3"` disables the host and gives
 * it the sentence the sidebar already uses for a screen that has not been
 * built: "Available with Phase 3".
 *
 *     <button class="btn secondary" [reepPending]="3">Promote to semester 4</button>
 *
 * NEVER WITH FAKE DATA BESIDE IT. A disabled button is honest; a disabled
 * button over a table of invented rows is not. Where the board's data itself
 * comes from an unmerged task, the screen renders the empty state and a
 * `.notice.accent` saying what will fill it — not a plausible-looking sample.
 *
 * ACCESSIBILITY. On a `<button>` or `<input>` the native `disabled` property is
 * set, which is what takes it out of the tab order and stops the click. On any
 * other host — a link, a row, a whole panel — `disabled` does not exist, so the
 * directive uses `aria-disabled`, removes it from the tab order and blocks
 * pointer events, and `.btn[aria-disabled='true']` in reep-v2.scss already
 * carries the same 0.55 opacity as `:disabled`. `title` alone would leave the
 * reason invisible to a screen reader, so the phase is appended to the host's
 * accessible name too.
 */

import { Directive, ElementRef, Renderer2, effect, inject, input } from '@angular/core';

/** The sentence on the control and in its accessible name. */
export function pendingLabel(phase: number | string): string {
  return `Available with Phase ${phase}`;
}

@Directive({
  selector: '[reepPending]',
  standalone: true,
})
export class PendingControlDirective {
  /** The phase that makes this control work — 3 or 4 in this release. */
  readonly reepPending = input.required<number | string>();

  private readonly host = (inject(ElementRef) as ElementRef<HTMLElement>).nativeElement;
  private readonly renderer = inject(Renderer2);

  /** The name the control had before the phase note was appended to it. */
  private readonly ownName = this.host.getAttribute('aria-label') ?? this.host.textContent?.trim() ?? '';

  constructor() {
    effect(() => {
      const note = pendingLabel(this.reepPending());
      const native = this.host as HTMLButtonElement;
      const takesDisabled =
        this.host.tagName === 'BUTTON' ||
        this.host.tagName === 'INPUT' ||
        this.host.tagName === 'SELECT' ||
        this.host.tagName === 'TEXTAREA';

      if (takesDisabled) {
        this.renderer.setProperty(native, 'disabled', true);
      } else {
        this.renderer.setAttribute(this.host, 'aria-disabled', 'true');
        this.renderer.setAttribute(this.host, 'tabindex', '-1');
        this.renderer.setStyle(this.host, 'pointer-events', 'none');
      }

      this.renderer.setAttribute(this.host, 'title', note);
      this.renderer.setAttribute(
        this.host,
        'aria-label',
        this.ownName ? `${this.ownName} — ${note}` : note,
      );
    });
  }
}
