import type { Category, Company, Confidence, Office, OfficeStatus, Origin, TechPark } from '../data/types';
import { searchKey } from './slug';

export interface FilterState {
  /** Free text matched against company name, aliases, sector, locality and tech-park name. */
  query: string;
  categories: readonly Category[];
  origins: readonly Origin[];
  sectors: readonly string[];
  /** Restrict to offices inside this park; null = any. */
  techParkId: string | null;
  includeClosed: boolean;
  /** Hide offices less certain than this. */
  minConfidence: Confidence;
}

export const DEFAULT_FILTERS: FilterState = {
  query: '',
  categories: ['MNC', 'MID_SIZE', 'STARTUP', 'PSU'],
  origins: ['Indian', 'Foreign'],
  sectors: [],
  techParkId: null,
  includeClosed: false,
  minConfidence: 'low',
};

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const OPEN_STATUSES: readonly OfficeStatus[] = ['active', 'closing', 'planned'];

export function officePasses(office: Office, f: FilterState): boolean {
  if (CONFIDENCE_RANK[office.confidence] < CONFIDENCE_RANK[f.minConfidence]) return false;
  if (!f.includeClosed && !OPEN_STATUSES.includes(office.status)) return false;
  if (f.techParkId && office.techParkId !== f.techParkId) return false;
  return true;
}

function matchesQuery(company: Company, parks: ReadonlyMap<string, TechPark>, key: string): boolean {
  if (!key) return true;
  if (searchKey(company.name).includes(key)) return true;
  if (company.aliases.some((a) => searchKey(a).includes(key))) return true;
  if (searchKey(company.sector).includes(key)) return true;
  return company.offices.some((o) => {
    if (searchKey(o.locality).includes(key)) return true;
    if (o.building && searchKey(o.building).includes(key)) return true;
    const park = o.techParkId ? parks.get(o.techParkId) : undefined;
    return !!park && (searchKey(park.name).includes(key) || park.aliases.some((a) => searchKey(a).includes(key)));
  });
}

/**
 * A company is listed when it passes the company-level filters AND keeps at least one office
 * after the office-level ones, so a park filter never lists a company with nothing to show there.
 */
export function applyFilters(
  companies: readonly Company[],
  parks: ReadonlyMap<string, TechPark>,
  f: FilterState,
): Company[] {
  const key = searchKey(f.query);
  return companies.filter((c) => {
    if (!f.categories.includes(c.category)) return false;
    if (!f.origins.includes(c.origin)) return false;
    if (f.sectors.length && !f.sectors.includes(c.sector)) return false;
    if (!matchesQuery(c, parks, key)) return false;
    return c.offices.some((o) => officePasses(o, f));
  });
}

export function visibleOffices(companies: readonly Company[], f: FilterState): { company: Company; office: Office }[] {
  const out: { company: Company; office: Office }[] = [];
  for (const company of companies) {
    for (const office of company.offices) {
      if (officePasses(office, f)) out.push({ company, office });
    }
  }
  return out;
}

export function countBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
