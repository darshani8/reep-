/**
 * The dataset the app renders. It is produced by `tools/data/merge.py` from the research
 * slices in `data/raw/` and written to `public/data/dataset.json`; nothing in the app edits it.
 *
 * Every coordinate is a point INSIDE the Bengaluru metro box (see `core/bengaluru.ts`); the
 * merge script refuses anything outside it, and `dataset.spec.ts` re-checks the shipped file.
 */

/** How the company is classed on the map. MNC covers Indian multinationals too (Infosys, Wipro...). */
export type Category = 'MNC' | 'MID_SIZE' | 'STARTUP' | 'PSU';

/** Where the PARENT company is headquartered, so "Indian MNC" and "foreign MNC" can be told apart. */
export type Origin = 'Indian' | 'Foreign';

export type OfficeStatus = 'active' | 'closing' | 'closed' | 'planned';

/** How well-evidenced an office location is. Rendered as text, never as colour alone. */
export type Confidence = 'high' | 'medium' | 'low';

export interface Office {
  /** `${companyId}~${hash}` where the hash is of the rounded coordinates, so it survives a re-merge. */
  id: string;
  /** "Bengaluru HQ", "Manyata campus", "Embassy TechVillage – Tower 3B"... */
  label: string;
  /** `TechPark.id` when the office sits inside a park in the dataset, else null. */
  techParkId: string | null;
  building: string | null;
  locality: string;
  address: string;
  lat: number;
  lng: number;
  isHq: boolean;
  status: OfficeStatus;
  confidence: Confidence;
  /** One sentence naming the source that places the office here, with its URL. */
  evidence: string;
}

export interface Company {
  id: string;
  name: string;
  aliases: string[];
  category: Category;
  origin: Origin;
  hqCountry: string | null;
  hqCity: string | null;
  sector: string;
  description: string;
  website: string | null;
  founded: number | null;
  bengaluruEmployeesApprox: number | null;
  isUnicorn: boolean;
  offices: Office[];
  sources: string[];
}

export interface TechPark {
  id: string;
  name: string;
  aliases: string[];
  locality: string;
  developer: string | null;
  lat: number;
  lng: number;
  /** [south, north, west, east] when the geocoder or OSM gave a footprint, else null. */
  bbox: [number, number, number, number] | null;
  areaSqFtMillions: number | null;
  description: string;
  /** Company names the research named as tenants, whether or not each made it into `companies`. */
  notableTenants: string[];
  sources: string[];
  /** OpenStreetMap footprint ring as [lng, lat] pairs when the park's polygon was matched, else null. */
  footprint: [number, number][] | null;
  /** false for a park only ever named by a tenant's office record, which the merge stubs in. */
  verified: boolean;
}

export interface Dataset {
  version: number;
  generatedAt: string;
  bounds: { south: number; north: number; west: number; east: number };
  companies: Company[];
  techParks: TechPark[];
  provenance: {
    lenses: number;
    rawSlices: string[];
    note: string;
  };
}

export const CATEGORIES: readonly Category[] = ['MNC', 'MID_SIZE', 'STARTUP', 'PSU'];
export const CATEGORY_LABEL: Record<Category, string> = {
  MNC: 'MNC',
  MID_SIZE: 'Mid-size',
  STARTUP: 'Startup',
  PSU: 'PSU / Govt',
};
export const CATEGORY_DESCRIPTION: Record<Category, string> = {
  MNC: 'Multinationals — foreign-headquartered, or Indian and listed with more than 10,000 employees',
  MID_SIZE: 'Established companies of roughly 300 to 10,000 employees that are not startup-shaped',
  STARTUP: 'Venture-funded companies founded since 2005, however large they have grown',
  PSU: 'Government-owned undertakings and public research employers',
};

/**
 * Okabe–Ito colour-blind-safe palette. Status and category are ALWAYS drawn as text beside the
 * colour; the colour alone never carries meaning.
 */
export const CATEGORY_COLOR: Record<Category, string> = {
  MNC: '#0072B2',
  MID_SIZE: '#E69F00',
  STARTUP: '#CC79A7',
  PSU: '#009E73',
};
export const TECH_PARK_COLOR = '#334155';

export const STATUS_LABEL: Record<OfficeStatus, string> = {
  active: 'Active',
  closing: 'Closing',
  closed: 'Closed',
  planned: 'Planned',
};
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'Well evidenced',
  medium: 'One source',
  low: 'Unconfirmed',
};
