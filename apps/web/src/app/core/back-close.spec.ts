import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackStack, HistoryPort, bindBackToClose } from './back-close';

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
  back(): void {
    if (this.cursor === 0) return;
    this.cursor--;
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
    this.back();
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

  it('pops its own entry when the overlay is closed by its own button', () => {
    const close = vi.fn();
    const entry = stack.open(close);

    entry.closedByUser();

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

  it('leaves history alone when the owner goes away (a navigation from inside)', () => {
    const close = vi.fn();
    const entry = stack.open(close);

    entry.drop();

    expect(history.cursor).toBe(1); // no back() — it would undo the navigation
    expect(stack.depth).toBe(0);
    history.pressBack();
    expect(close).not.toHaveBeenCalled();
  });

  it('ignores a Back press when nothing is open, so ordinary navigation is untouched', () => {
    const close = vi.fn();
    stack.open(close).closedByUser();
    history.push('someone-else');
    history.pressBack();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not pop another overlay’s entry when one is closed out of order', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const a = stack.open(closeA);
    stack.open(closeB);

    a.closedByUser();
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

  beforeEach(() => {
    history = new FakeHistory();
    stack = new BackStack(history);
    matches = true;
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

  it('closing by its own button pops the entry it pushed', () => {
    const fixture = mount();
    fixture.componentInstance.open.set(true);
    TestBed.tick();
    fixture.componentInstance.open.set(false);
    TestBed.tick();

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
});
