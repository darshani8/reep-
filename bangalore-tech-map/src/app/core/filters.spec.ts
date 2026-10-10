import { describe, expect, it } from 'vitest';
import type { Company, TechPark } from '../data/types';
import { DEFAULT_FILTERS, applyFilters, countBy, officePasses, visibleOffices } from './filters';

const park: TechPark = {
  id: 'manyata-tech-park',
  name: 'Manyata Tech Park',
  aliases: ['Embassy Manyata Business Park'],
  locality: 'Nagavara',
  developer: 'Embassy',
  lat: 13.048,
  lng: 77.621,
  bbox: null,
  areaSqFtMillions: 14,
  description: '',
  notableTenants: [],
  sources: [],
  footprint: null,
  verified: true,
};

function company(partial: Partial<Company> & Pick<Company, 'id' | 'name' | 'category'>): Company {
  return {
    aliases: [],
    origin: 'Foreign',
    hqCountry: null,
    hqCity: null,
    sector: 'Software & internet',
    description: '',
    website: null,
    founded: null,
    bengaluruEmployeesApprox: null,
    isUnicorn: false,
    sources: [],
    offices: [
      {
        id: `${partial.id}~1`,
        label: 'Bengaluru office',
        techParkId: null,
        building: null,
        locality: 'Bellandur',
        address: '',
        lat: 12.93,
        lng: 77.69,
        isHq: true,
        status: 'active',
        confidence: 'high',
        evidence: '',
      },
    ],
    ...partial,
  };
}

const ibm = company({
  id: 'ibm',
  name: 'IBM',
  category: 'MNC',
  aliases: ['International Business Machines'],
  offices: [
    { id: 'ibm~1', label: 'Manyata campus', techParkId: park.id, building: 'Block D', locality: 'Nagavara', address: '', lat: 13.048, lng: 77.621, isHq: true, status: 'active', confidence: 'high', evidence: '' },
    { id: 'ibm~2', label: 'Old office', techParkId: null, building: null, locality: 'Domlur', address: '', lat: 12.96, lng: 77.64, isHq: false, status: 'closed', confidence: 'low', evidence: '' },
  ],
});
const zerodha = company({ id: 'zerodha', name: 'Zerodha', category: 'STARTUP', origin: 'Indian', sector: 'Fintech' });
const hal = company({ id: 'hal', name: 'Hindustan Aeronautics', category: 'PSU', origin: 'Indian', sector: 'Aerospace & defence', aliases: ['HAL'] });
const all = [ibm, zerodha, hal];
const parks = new Map([[park.id, park]]);

describe('applyFilters', () => {
  it('lists everything with the default filters', () => {
    expect(applyFilters(all, parks, DEFAULT_FILTERS).map((c) => c.id)).toEqual(['ibm', 'zerodha', 'hal']);
  });

  it('narrows by category and origin', () => {
    expect(applyFilters(all, parks, { ...DEFAULT_FILTERS, categories: ['STARTUP'] }).map((c) => c.id)).toEqual(['zerodha']);
    expect(applyFilters(all, parks, { ...DEFAULT_FILTERS, origins: ['Indian'] }).map((c) => c.id)).toEqual(['zerodha', 'hal']);
  });

  it('matches the query against name, alias, sector, locality and tech park (case and punctuation folded)', () => {
    const q = (query: string) => applyFilters(all, parks, { ...DEFAULT_FILTERS, query }).map((c) => c.id);
    expect(q('i.b.m')).toEqual(['ibm']);
    expect(q('business machines')).toEqual(['ibm']);
    expect(q('FINTECH')).toEqual(['zerodha']);
    expect(q('nagavara')).toEqual(['ibm']);
    expect(q('embassy manyata')).toEqual(['ibm']);
    expect(q('h.a.l.')).toEqual(['hal']);
    expect(q('nothing-here')).toEqual([]);
  });

  it('a tech park filter lists only companies with an office in that park', () => {
    expect(applyFilters(all, parks, { ...DEFAULT_FILTERS, techParkId: park.id }).map((c) => c.id)).toEqual(['ibm']);
  });

  it('closed offices are hidden unless asked for, and a company with only closed offices disappears', () => {
    const closedOnly = company({ id: 'x', name: 'X', category: 'MNC', offices: [{ ...ibm.offices[1], id: 'x~1' }] });
    expect(applyFilters([closedOnly], parks, DEFAULT_FILTERS)).toEqual([]);
    expect(applyFilters([closedOnly], parks, { ...DEFAULT_FILTERS, includeClosed: true }).length).toBe(1);
  });

  it('the confidence floor hides weaker offices', () => {
    expect(officePasses(ibm.offices[1], { ...DEFAULT_FILTERS, includeClosed: true, minConfidence: 'medium' })).toBe(false);
    expect(officePasses(ibm.offices[0], { ...DEFAULT_FILTERS, minConfidence: 'high' })).toBe(true);
  });
});

describe('visibleOffices', () => {
  it('flattens to office rows that pass the office filters', () => {
    expect(visibleOffices(all, DEFAULT_FILTERS).map((r) => r.office.id)).toEqual(['ibm~1', 'zerodha~1', 'hal~1']);
    expect(visibleOffices(all, { ...DEFAULT_FILTERS, includeClosed: true }).map((r) => r.office.id)).toContain('ibm~2');
  });
});

describe('countBy', () => {
  it('counts by key', () => {
    expect(countBy(all, (c) => c.category)).toEqual({ MNC: 1, STARTUP: 1, PSU: 1 });
  });
});
