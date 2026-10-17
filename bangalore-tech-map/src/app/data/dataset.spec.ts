import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BENGALURU_BOUNDS, insideBengaluru } from '../core/bengaluru';
import { CATEGORIES, type Dataset } from './types';

/**
 * Integrity of the SHIPPED dataset, so a bad merge cannot reach the map: every coordinate inside
 * Bengaluru, every id unique, every park reference resolvable, every enum value known.
 * `public/data/dataset.json` is what the app fetches at runtime, so that exact file is read.
 */
const dataset: Dataset = JSON.parse(readFileSync(resolve(process.cwd(), 'public/data/dataset.json'), 'utf8'));

describe('public/data/dataset.json', () => {
  it('declares the Bengaluru box the app assumes', () => {
    expect(dataset.bounds).toEqual(BENGALURU_BOUNDS);
  });

  it('has unique company, office and tech-park ids', () => {
    const companyIds = dataset.companies.map((c) => c.id);
    expect(new Set(companyIds).size).toBe(companyIds.length);
    const officeIds = dataset.companies.flatMap((c) => c.offices.map((o) => o.id));
    expect(new Set(officeIds).size).toBe(officeIds.length);
    const parkIds = dataset.techParks.map((p) => p.id);
    expect(new Set(parkIds).size).toBe(parkIds.length);
  });

  it('keeps every office and every park inside Bengaluru', () => {
    const outside = dataset.companies.flatMap((c) =>
      c.offices.filter((o) => !insideBengaluru(o.lat, o.lng)).map((o) => `${c.name}: ${o.label} (${o.lat}, ${o.lng})`),
    );
    expect(outside).toEqual([]);
    const parksOutside = dataset.techParks.filter((p) => !insideBengaluru(p.lat, p.lng)).map((p) => p.name);
    expect(parksOutside).toEqual([]);
  });

  it('every office points at a park that exists, or at none', () => {
    const parkIds = new Set(dataset.techParks.map((p) => p.id));
    const dangling = dataset.companies.flatMap((c) => c.offices.filter((o) => o.techParkId && !parkIds.has(o.techParkId)).map((o) => `${c.name}: ${o.techParkId}`));
    expect(dangling).toEqual([]);
  });

  it('uses only the known categories, origins, statuses and confidence words', () => {
    for (const c of dataset.companies) {
      expect(CATEGORIES, c.name).toContain(c.category);
      expect(['Indian', 'Foreign'], c.name).toContain(c.origin);
      expect(c.offices.length, `${c.name} has no office`).toBeGreaterThan(0);
      for (const o of c.offices) {
        expect(['active', 'closing', 'closed', 'planned'], `${c.name} ${o.label}`).toContain(o.status);
        expect(['high', 'medium', 'low'], `${c.name} ${o.label}`).toContain(o.confidence);
      }
    }
  });

  it('every company has at most one Bengaluru HQ office', () => {
    const many = dataset.companies.filter((c) => c.offices.filter((o) => o.isHq).length > 1).map((c) => c.name);
    expect(many).toEqual([]);
  });
});
