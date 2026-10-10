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

/** The query names the company itself: its name, an alias or its sector. */
function companyMatches(company: Company, key: string): boolean {
  return (
    searchKey(company.name).includes(key) ||
    company.aliases.some((a) => searchKey(a).includes(key)) ||
    searchKey(company.sector).includes(key)
  );
}

/** The query names a place this office is in: its locality, building, address or tech park. */
function officeMatches(office: Office, parks: ReadonlyMap<string, TechPark>, key: string): boolean {
  if (searchKey(office.locality).includes(key)) return true;
  if (office.building && searchKey(office.building).includes(key)) return true;
  if (office.address && searchKey(office.address).includes(key)) return true;
  const park = office.techParkId ? parks.get(office.techParkId) : undefined;
  return !!park && (searchKey(park.name).includes(key) || park.aliases.some((a) => searchKey(a).includes(key)));
}

/**
 * The offices of one company that the current filters show.
 *
 * A query that names the COMPANY ("infosys", "fintech") shows every office of it; a query that names
 * a PLACE ("whitefield", "manyata") shows only the offices in that place. Without the second half, a
 * search for Whitefield listed the right companies and then drew each one's offices all over the
 * city, and "Fit map to results" zoomed out to Bengaluru.
 */
export function matchingOffices(company: Company, parks: ReadonlyMap<string, TechPark>, f: FilterState): Office[] {
  const key = searchKey(f.query);
  const whole = !key || companyMatches(company, key);
  return company.offices.filter((o) => officePasses(o, f) && (whole || officeMatches(o, parks, key)));
}

/**
 * A company is listed when it passes the company-level filters AND keeps at least one office after
 * the office-level ones and the query, so a park filter or a place search never lists a company with
 * nothing to show there.
 */
export function applyFilters(
  companies: readonly Company[],
  parks: ReadonlyMap<string, TechPark>,
  f: FilterState,
): Company[] {
  return companies.filter((c) => {
    if (!f.categories.includes(c.category)) return false;
    if (!f.origins.includes(c.origin)) return false;
    if (f.sectors.length && !f.sectors.includes(c.sector)) return false;
    return matchingOffices(c, parks, f).length > 0;
  });
}

export function visibleOffices(
  companies: readonly Company[],
  parks: ReadonlyMap<string, TechPark>,
  f: FilterState,
): { company: Company; office: Office }[] {
  const out: { company: Company; office: Office }[] = [];
  for (const company of companies) {
    for (const office of matchingOffices(company, parks, f)) out.push({ company, office });
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
