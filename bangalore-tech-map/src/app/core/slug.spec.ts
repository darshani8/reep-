import { describe, expect, it } from 'vitest';
import { searchKey, slugify } from './slug';

describe('slugify', () => {
  it('lower-cases, folds accents and punctuation, and keeps ampersands readable', () => {
    expect(slugify('Embassy TechVillage')).toBe('embassy-techvillage');
    expect(slugify('L&T Technology Services')).toBe('l-and-t-technology-services');
    expect(slugify('  Société Générale  ')).toBe('societe-generale');
    expect(slugify('J.P. Morgan Chase & Co.')).toBe('j-p-morgan-chase-and-co');
  });
});

describe('searchKey', () => {
  it('drops everything but letters and digits so punctuation never breaks a match', () => {
    expect(searchKey('J.P. Morgan')).toBe('jpmorgan');
    expect(searchKey('ITPL / ITPB')).toBe('itplitpb');
    expect(searchKey('Café Coffee Day')).toBe('cafecoffeeday');
  });
});
