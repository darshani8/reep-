import { describe, expect, it } from 'vitest';

import { KB_OPEN_THRESHOLD_PX, keyboardInset } from './keyboard-inset';

describe('keyboardInset', () => {
  it('is the part of the layout viewport the visual viewport no longer covers', () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
  });

  it('subtracts how far the visual viewport has scrolled down', () => {
    expect(keyboardInset(844, 508, 40)).toBe(296);
  });

  it('reads a URL bar settling, not a keyboard, as zero', () => {
    expect(keyboardInset(844, 844 - (KB_OPEN_THRESHOLD_PX - 1), 0)).toBe(0);
  });

  it('is never negative', () => {
    expect(keyboardInset(800, 844, 0)).toBe(0);
  });
});
