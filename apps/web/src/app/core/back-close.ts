/**
 * The phone's Back — Android's hardware button, the edge-swipe gesture, the
 * browser's own arrow — closes the overlay on top instead of leaving the
 * screen.
 *
 * WHY. On a phone a pushed detail, a bottom sheet, the filters sheet and the
 * shell's "More" drawer all LOOK like a screen of their own, and a native app
 * closes them on Back. A web page does not: Back leaves the route, so the
 * office reading one application pressed Back to return to the queue and
 * landed on Home with the queue's filters gone. The fix is the standard one —
 * push a history entry when a phone-only overlay opens, close the overlay when
 * that entry is popped, and pop the entry ourselves when the overlay is closed
 * by its own button so the history is left exactly as it was.
 *
 * PHONE ONLY, AND THAT IS THE DESKTOP GUARANTEE. Every overlay names the media
 * query under which it is an overlay (the pushed detail and the sheets below
 * 600px, the shell's drawer below 900px). Outside it nothing is pushed, so a
 * desktop session's history and its Back button behave exactly as before.
 *
 * THE SAME URL, AND THE ROUTER'S OWN STATE. The entry is pushed with the
 * current URL and the router's current `history.state` spread into it, so the
 * Angular router — which also listens to popstate — sees a navigation to the
 * URL it is already on and ignores it (`onSameUrlNavigation: 'ignore'` is the
 * default and this app does not change it).
 *
 * WHAT IT DELIBERATELY DOES NOT DO. When an overlay goes away because of a
 * navigation — a link inside the drawer, a row that routes elsewhere, its
 * component destroyed by the route change — the entry is dropped from the
 * stack but NOT popped from history: `history.back()` at that moment would
 * undo the navigation the person just made. A link in the shell's drawer
 * closes the drawer AND navigates in the same tap, which is exactly that
 * race, so a close that lands while a router navigation is in flight (or
 * after one started while the overlay was open) is treated as a drop. The
 * cost is one Back press that changes nothing, later — far cheaper than the
 * alternative.
 *
 * `BackStack` is the logic over an abstract history so the spec can drive it
 * without a browser; `bindBackToClose` is what a component calls.
 */

import { DestroyRef, effect, inject, untracked } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';

import { PHONE_QUERY } from './mobile';

/** The slice of `window.history` / `window` the stack needs. */
export interface HistoryPort {
  /** Push an entry for the CURRENT url, carrying `marker` in its state. */
  push(marker: string): void;
  /** `history.go(delta)` — one traversal, one popstate, however far. */
  go(delta: number): void;
  /** The marker on the current history entry's state, if any. */
  currentMarker(): string | null;
  /** Subscribe to popstate; returns the unsubscribe. */
  onPop(listener: () => void): () => void;
}

const MARKER_KEY = 'reepOverlay';

export function browserHistoryPort(win: Window = window): HistoryPort {
  return {
    push(marker) {
      const state = win.history.state;
      const base = state && typeof state === 'object' ? state : {};
      win.history.pushState({ ...base, [MARKER_KEY]: marker }, '', win.location.href);
    },
    go(delta) {
      win.history.go(delta);
    },
    currentMarker() {
      const state = win.history.state;
      const marker = state && typeof state === 'object' ? state[MARKER_KEY] : null;
      return typeof marker === 'string' ? marker : null;
    },
    onPop(listener) {
      win.addEventListener('popstate', listener);
      return () => win.removeEventListener('popstate', listener);
    },
  };
}

export interface BackEntry {
  /** The overlay closed by its own button: pop the entry it pushed. */
  closedByUser(): void;
  /** The overlay's owner is going away: forget it, leave history alone. */
  drop(): void;
}

interface StackItem {
  readonly marker: string;
  readonly close: () => void;
}

/**
 * Two lists, because history and the screen disagree for a moment. `open`
 * is what is on screen; `pushed` mirrors the entries this stack put on top of
 * history, in order. Closing by a button only takes an overlay off `open`;
 * the entries are rewound at the end of the turn, in ONE `history.go(-n)`
 * covering every closed entry on top — so a dialog closed together with the
 * one under it (delete over edit, finished) leaves nothing behind, where two
 * `back()` calls in one turn race each other.
 */
export class BackStack {
  private readonly open_: StackItem[] = [];
  private pushed: string[] = [];
  /** Traversals we caused ourselves, which the popstate listener must not
   *  treat as the person pressing Back. */
  private ownPops = 0;
  private flushQueued = false;
  private unlisten: (() => void) | null = null;
  private seq = 0;

  constructor(private readonly history: HistoryPort) {}

  get depth(): number {
    return this.open_.length;
  }

  open(close: () => void): BackEntry {
    const item: StackItem = { marker: `o${++this.seq}`, close };
    this.open_.push(item);
    this.pushed.push(item.marker);
    this.history.push(item.marker);
    this.listen();
    return {
      closedByUser: () => {
        if (this.remove(item)) this.queueFlush();
      },
      drop: () => {
        if (!this.remove(item)) return;
        // A navigation owns history from here: nothing we pushed is known to
        // be on top any more, so nothing of ours is ever rewound again.
        this.pushed = [];
      },
    };
  }

  private isOpen(marker: string): boolean {
    return this.open_.some((i) => i.marker === marker);
  }

  private remove(item: StackItem): boolean {
    const i = this.open_.indexOf(item);
    if (i < 0) return false;
    this.open_.splice(i, 1);
    return true;
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Rewind every closed entry on top of history, in one traversal. An entry
   *  under a still-open overlay stays (closed out of order) — rewinding it
   *  would rewind the open one too. */
  private flush(): void {
    const top = this.pushed[this.pushed.length - 1];
    if (top === undefined || this.history.currentMarker() !== top) return;
    let n = 0;
    while (this.pushed.length && !this.isOpen(this.pushed[this.pushed.length - 1])) {
      this.pushed.pop();
      n++;
    }
    if (n > 0) {
      this.ownPops++;
      this.history.go(-n);
    }
  }

  private listen(): void {
    if (this.unlisten) return;
    this.unlisten = this.history.onPop(() => this.onPop());
  }

  private onPop(): void {
    if (this.ownPops > 0) {
      this.ownPops--;
      return;
    }
    // The person went back. Every entry of ours above the one now current is
    // gone; close whatever overlay was standing on it.
    const current = this.history.currentMarker();
    while (this.pushed.length && this.pushed[this.pushed.length - 1] !== current) {
      const marker = this.pushed.pop()!;
      const item = this.open_.find((i) => i.marker === marker);
      if (item) {
        this.remove(item);
        item.close();
      }
    }
  }
}

let shared: BackStack | null = null;

/** The one stack for the page — overlays nest across components. */
export function backStack(): BackStack {
  shared ??= new BackStack(browserHistoryPort());
  return shared;
}

/**
 * Wire one overlay to Back. Call in an injection context (a field
 * initialiser): while `isOpen()` is true AND `query` matches, a Back press
 * calls `close()`; closing it any other way pops the entry it pushed.
 *
 *   readonly filtersOpen = signal(false);
 *   private readonly _filtersBack = bindBackToClose(
 *     () => this.filtersOpen(), () => this.filtersOpen.set(false));
 */
export function bindBackToClose(
  isOpen: () => boolean,
  close: () => void,
  query: string = PHONE_QUERY,
  stack: BackStack | (() => BackStack) = backStack,
): void {
  const mql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  let entry: BackEntry | null = null;
  const resolve = () => (typeof stack === 'function' ? stack() : stack);
  const router = inject(Router, { optional: true });

  // A navigation that starts while the overlay is open (other than the
  // popstate our own Back produces) owns history from here: forget the entry.
  const sub = router?.events.subscribe((e) => {
    if (e instanceof NavigationStart && e.navigationTrigger !== 'popstate' && entry) {
      entry.drop();
      entry = null;
    }
  });

  effect(() => {
    const open = isOpen();
    untracked(() => {
      if (open && !entry && mql?.matches) {
        entry = resolve().open(() => {
          // Back was pressed: the entry is already gone from history.
          entry = null;
          close();
        });
      } else if (!open && entry) {
        const e = entry;
        entry = null;
        if (router?.currentNavigation()) e.drop();
        else e.closedByUser();
      }
    });
  });

  inject(DestroyRef).onDestroy(() => {
    sub?.unsubscribe();
    entry?.drop();
    entry = null;
  });
}
