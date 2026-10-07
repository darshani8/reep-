import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackStack, HistoryPort, bindBackToClose } from './back-close';

/** Closing by a button rewinds history at the end of the turn. */
const endOfTurn = () => Promise.resolve();

/** A browser history in miniature: entries carry a marker or null, `back()`
 *  moves the cursor and fires popstate the way a real Back press does. */
class FakeHistory implements HistoryPort {
  entries: (string | null)[] = [null];
  cursor = 0;
  private listeners: (() => void)[] = [];

  push(marker: string): void {
    this.entries = this.entries.slice(0, this.cursor + 1);
    this.entries.push(marker);
    this.cursor++;
  }
  goes = 0;
  go(delta: number): void {
    const to = Math.max(0, this.cursor + delta);
    if (to === this.cursor) return;
    this.goes++;
    this.cursor = to;
    this.listeners.forEach((l) => l());
  }
  currentMarker(): string | null {
    return this.entries[this.cursor];
  }
  onPop(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }
  /** The person pressing the hardware Back button. */
  pressBack(): void {
    this.go(-1);
  }
}

describe('BackStack', () => {
  let history: FakeHistory;
  let stack: BackStack;

  beforeEach(() => {
    history = new FakeHistory();
    stack = new BackStack(history);
  });

  it('closes the open overlay on Back instead of leaving the screen', () => {
    const close = vi.fn();
    stack.open(close);
    expect(history.entries.length).toBe(2);

    history.pressBack();

    expect(close).toHaveBeenCalledTimes(1);
    expect(history.cursor).toBe(0);
    expect(stack.depth).toBe(0);
  });

  it('pops its own entry when the overlay is closed by its own button', async () => {
    const close = vi.fn();
    const entry = stack.open(close);

    entry.closedByUser();
    await endOfTurn();

    expect(history.cursor).toBe(0);
    // Its own pop is not mistaken for the person pressing Back.
    expect(close).not.toHaveBeenCalled();
    expect(stack.depth).toBe(0);
  });

  it('closes nested overlays one Back press at a time, top first', () => {
    const closeDetail = vi.fn();
    const closeSheet = vi.fn();
    stack.open(closeDetail);
    stack.open(closeSheet);

    history.pressBack();
    expect(closeSheet).toHaveBeenCalledTimes(1);
    expect(closeDetail).not.toHaveBeenCalled();

    history.pressBack();
    expect(closeDetail).toHaveBeenCalledTimes(1);
    expect(history.cursor).toBe(0);
  });

  it('rewinds both entries in one go when a stacked pair closes together', async () => {
    const closeEdit = vi.fn();
    const closeDelete = vi.fn();
    const edit = stack.open(closeEdit);
    const del = stack.open(closeDelete);

    // "Delete for good" finished: the delete dialog and the edit dialog
    // under it both close in the same turn.
    del.closedByUser();
    edit.closedByUser();
    await endOfTurn();

    expect(history.cursor).toBe(0);
    expect(history.goes).toBe(1);
    expect(closeEdit).not.toHaveBeenCalled();
    expect(closeDelete).not.toHaveBeenCalled();
  });

  it('rewinds the closed top later, once the overlay under it closes too', async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a = stack.open(closeA);
    const b = stack.open(closeB);

    a.closedByUser(); // out of order: B is still open on top
    await endOfTurn();
    expect(history.cursor).toBe(2);

    b.closedByUser();
    await endOfTurn();
    expect(history.cursor).toBe(0); // both of ours rewound, nothing left behind
  });

  it('leaves history alone when the owner goes away (a navigation from inside)', () => {
    const close = vi.fn();
    const entry = stack.open(close);

    entry.drop();

    expect(history.cursor).toBe(1); // no back() — it would undo the navigation
    expect(stack.depth).toBe(0);
    history.pressBack();
    expect(close).not.toHaveBeenCalled();
  });

  it('ignores a Back press when nothing is open, so ordinary navigation is untouched', async () => {
    const close = vi.fn();
    stack.open(close).closedByUser();
    await endOfTurn();
    history.push('someone-else');
    history.pressBack();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not pop another overlay’s entry when one is closed out of order', async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a = stack.open(closeA);
    stack.open(closeB);

    a.closedByUser();
    await endOfTurn();
    expect(history.cursor).toBe(2); // B's entry is still the current one

    history.pressBack();
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });
});

describe('bindBackToClose', () => {
  let history: FakeHistory;
  let stack: BackStack;
  let matches: boolean;

  @Component({ selector: 'test-host', template: '' })
  class Host {
    readonly open = signal(false);
    constructor() {
      bindBackToClose(
        () => this.open(),
        () => this.open.set(false),
        '(max-width: 599.98px)',
        () => stack,
      );
    }
  }

  let routerEvents: Subject<unknown>;
  let inFlight: unknown;

  beforeEach(() => {
    history = new FakeHistory();
    stack = new BackStack(history);
    matches = true;
    routerEvents = new Subject();
    inFlight = null;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Router,
          useValue: { events: routerEvents, currentNavigation: () => inFlight },
        },
      ],
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  function mount() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }

  it('Back closes an overlay opened on a phone', () => {
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();
    expect(history.entries.length).toBe(2);

    history.pressBack();
    TestBed.tick();

    expect(fixture.componentInstance.open()).toBe(false);
    expect(history.cursor).toBe(0);
  });

  it('closing by its own button pops the entry it pushed', async () => {
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();
    fixture.componentInstance.open.set(false);
    TestBed.tick();
    await endOfTurn();

    expect(history.cursor).toBe(0);
    expect(stack.depth).toBe(0);
  });

  it('pushes nothing on a desktop, so desktop Back is unchanged', () => {
    matches = false;
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();

    expect(history.entries.length).toBe(1);
    expect(stack.depth).toBe(0);
  });

  it('drops its entry without popping history when the component is destroyed', () => {
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();

    fixture.destroy();

    expect(stack.depth).toBe(0);
    expect(history.cursor).toBe(1);
  });

  it('a close that lands with a navigation in flight leaves history alone', async () => {
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();

    inFlight = { id: 1 }; // a drawer link: closes the drawer and navigates
    fixture.componentInstance.open.set(false);
    TestBed.tick();
    await endOfTurn();

    expect(history.cursor).toBe(1); // no back() — it would undo the navigation
    expect(stack.depth).toBe(0);
  });

  it('a navigation started while open drops the entry, but our own Back does not', () => {
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();

    routerEvents.next(new NavigationStart(1, '/elsewhere', 'popstate'));
    expect(stack.depth).toBe(1);
    routerEvents.next(new NavigationStart(2, '/elsewhere', 'imperative'));
    expect(stack.depth).toBe(0);
    expect(history.cursor).toBe(1);
  });
});
