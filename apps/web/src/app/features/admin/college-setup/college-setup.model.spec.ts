import {
  batchCode,
  batchDates,
  batchLabel,
  batchName,
  parseDomains,
  trackFor,
} from './college-setup.model';

/**
 * The rules "Set up a college" derives a batch from, pinned to the seeder's:
 * app/seed_catalogue.py's `batch_code`, `batch_name` and `batch_dates` produce
 * the same strings for the same inputs, so a batch made on screen and one
 * made from code read identically on the Batches screen.
 */
describe('a batch derived from the codes the office typed', () => {
  it('labels a two-year programme starting in 2026 as 2026-28', () => {
    expect(batchLabel(2026, 2)).toBe('2026-28');
    expect(batchLabel(2099, 2)).toBe('2099-01');
  });

  it('runs from 1 July of the first year to 30 June of the last', () => {
    expect(batchDates('2026-28')).toEqual({ entry: '2026-07-01', completion: '2028-06-30' });
    expect(batchDates('2025-2027')).toEqual({ entry: '2025-07-01', completion: '2027-06-30' });
  });

  it('refuses a label it cannot read rather than guessing the dates', () => {
    expect(batchDates('2026')).toBeNull();
    expect(batchDates('26-28')).toBeNull();
    expect(batchDates('2028-26')).toBeNull();
    expect(batchDates('2026-40')).toBeNull();
    expect(batchDates('')).toBeNull();
  });

  it('codes the whole path, upper-cased, skipping a missing specialization', () => {
    expect(batchCode(['1mp', 'mba', 'mba', 'fa', '2026-28'])).toBe('1MP-MBA-MBA-FA-2026-28');
    expect(batchCode(['1mp', 'mba', 'dm', null, '2026-28'])).toBe('1MP-MBA-DM-2026-28');
    expect(batchCode([' 1mp ', '', 'mba', undefined, '2026-28'])).toBe('1MP-MBA-2026-28');
  });

  it('names the batch for a person, without the department', () => {
    expect(batchName('General MBA', 'Finance', '2026-28')).toBe('General MBA - Finance 2026-28');
    expect(batchName('Digital Marketing', null, '2026-28')).toBe('Digital Marketing 2026-28');
  });
});

describe('the rest of the form', () => {
  it('reads domains off a comma list, lower-cased, without duplicates', () => {
    expect(parseDomains('BGSCET.ac.in, sjbit.ac.in ;@bgscet.ac.in')).toEqual([
      'bgscet.ac.in',
      'sjbit.ac.in',
    ]);
    expect(parseDomains('')).toEqual([]);
  });

  it('matches a leaf code to an enabled track exactly and case-folded', () => {
    const tracks = [
      { code: 'fa', label: 'Financial Analytics', enabled: true },
      { code: 'dm', label: 'Digital Marketing', enabled: false },
    ];
    expect(trackFor('FA', tracks)).toBe('Financial Analytics');
    expect(trackFor('fa ', tracks)).toBe('Financial Analytics');
    expect(trackFor('dm', tracks)).toBeNull();
    expect(trackFor('FIN', tracks)).toBeNull();
    expect(trackFor('', tracks)).toBeNull();
  });
});
