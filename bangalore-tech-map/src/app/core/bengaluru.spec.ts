import { describe, expect, it } from 'vitest';
import { BENGALURU_BOUNDS, MAX_BOUNDS, insideBengaluru } from './bengaluru';

describe('insideBengaluru', () => {
  it('accepts the city and its edges, refuses the neighbours', () => {
    expect(insideBengaluru(12.9716, 77.5946)).toBe(true); // MG Road
    expect(insideBengaluru(12.8452, 77.6602)).toBe(true); // Electronics City
    expect(insideBengaluru(13.1986, 77.7066)).toBe(true); // Devanahalli airport
    expect(insideBengaluru(12.7409, 77.8253)).toBe(false); // Hosur, Tamil Nadu
    expect(insideBengaluru(12.2958, 76.6394)).toBe(false); // Mysuru
    expect(insideBengaluru(17.385, 78.4867)).toBe(false); // Hyderabad
  });

  it('the pan limit contains the data box with slack on every side', () => {
    const [[west, south], [east, north]] = MAX_BOUNDS;
    expect(west).toBeLessThan(BENGALURU_BOUNDS.west);
    expect(south).toBeLessThan(BENGALURU_BOUNDS.south);
    expect(east).toBeGreaterThan(BENGALURU_BOUNDS.east);
    expect(north).toBeGreaterThan(BENGALURU_BOUNDS.north);
  });
});
