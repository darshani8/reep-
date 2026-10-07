import { describe, expect, it } from 'vitest';

import { fitWithin, shrinkPhoto } from './shrink-photo';

describe('fitWithin', () => {
  it('leaves an image already inside the bound alone', () => {
    expect(fitWithin(800, 300)).toEqual({ w: 800, h: 300 });
  });

  it('scales the long edge down to the bound and keeps the ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 1600, h: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ w: 1200, h: 1600 });
  });
});

describe('shrinkPhoto', () => {
  it('returns a file under the limit untouched', async () => {
    const small = new File([new Uint8Array(10)], 'sig.png', { type: 'image/png' });
    expect(await shrinkPhoto(small)).toBe(small);
  });

  it('returns a file that is not a PNG or JPEG untouched, whatever its size', async () => {
    const pdf = new File([new Uint8Array(64)], 'sig.pdf', { type: 'application/pdf' });
    expect(await shrinkPhoto(pdf, 8)).toBe(pdf);
  });

  it('falls back to the original when the image cannot be decoded', async () => {
    const junk = new File([new Uint8Array(64)], 'sig.jpg', { type: 'image/jpeg' });
    expect(await shrinkPhoto(junk, 8)).toBe(junk);
  });
});
