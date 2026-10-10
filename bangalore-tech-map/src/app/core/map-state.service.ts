import { DOCUMENT } from '@angular/core';
import { Service, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import { CATEGORY_COLOR, type Category, type Company, type Confidence, type Office, type Origin, type TechPark } from '../data/types';
import { DatasetService } from './dataset.service';
import { DEFAULT_FILTERS, type FilterState, applyFilters, countBy, visibleOffices } from './filters';

/** Properties carried on each office point the map draws. Flat, because MapLibre expressions read them. */
export interface OfficeProps {
  officeId: string;
  companyId: string;
  name: string;
  category: Category;
  color: string;
  label: string;
  locality: string;
  techParkId: string;
  isHq: boolean;
  status: string;
  confidence: string;
  [key: string]: unknown;
}

export interface ParkProps {
  parkId: string;
  name: string;
  tenants: number;
  verified: boolean;
  [key: string]: unknown;
}

/**
 * The one place the UI's state lives: the filters, what is selected, and the GeoJSON the map
 * draws, all derived with `computed`. Panels write through the methods; the map and the lists
 * only read. A few fields mirror into the URL so a view can be shared.
 */
@Service()
export class MapStateService {
  private readonly ds = inject(DatasetService);
  private readonly document = inject(DOCUMENT);

  readonly filters = signal<FilterState>(DEFAULT_FILTERS);
  readonly selectedCompanyId = signal<string | null>(null);
  readonly selectedOfficeId = signal<string | null>(null);
  readonly selectedParkId = signal<string | null>(null);
  /** Where the latest selection came from, so the map only flies when the list drove it. */
  readonly selectionSource = signal<'map' | 'panel' | 'url'>('url');
  readonly sidebarOpen = signal(!this.isNarrowScreen());
  /** Bumped by "Fit map to results"; the map reacts to the change, not the value. */
  readonly fitRequest = signal(0);

  readonly filteredCompanies = computed(() => applyFilters(this.ds.companies(), this.ds.parksById(), this.filters()));
  readonly visibleRows = computed(() => visibleOffices(this.filteredCompanies(), this.ds.parksById(), this.filters()));
  readonly visibleOfficeCount = computed(() => this.visibleRows().length);

  readonly categoryCounts = computed(() => countBy(this.ds.companies(), (c) => c.category));
  readonly originCounts = computed(() => countBy(this.ds.companies(), (c) => c.origin));
  readonly isDefaultFilter = computed(() => {
    const f = this.filters();
    return (
      !f.query &&
      f.categories.length === DEFAULT_FILTERS.categories.length &&
      f.origins.length === DEFAULT_FILTERS.origins.length &&
      f.sectors.length === 0 &&
      f.techParkId === null &&
      f.includeClosed === DEFAULT_FILTERS.includeClosed &&
      f.minConfidence === DEFAULT_FILTERS.minConfidence
    );
  });

  readonly selectedCompany = computed<Company | null>(() => {
    const id = this.selectedCompanyId();
    return id ? (this.ds.companiesById().get(id) ?? null) : null;
  });
  readonly selectedOffice = computed<Office | null>(() => {
    const id = this.selectedOfficeId();
    const company = this.selectedCompany();
    if (!id || !company) return null;
    return company.offices.find((o) => o.id === id) ?? null;
  });
  readonly selectedPark = computed<TechPark | null>(() => {
    const id = this.selectedParkId();
    return id ? (this.ds.parksById().get(id) ?? null) : null;
  });
  readonly selectedParkCompanies = computed<Company[]>(() => {
    const park = this.selectedPark();
    return park ? (this.ds.companiesByPark().get(park.id) ?? []) : [];
  });

  readonly officeCollection = computed<FeatureCollection<Point, OfficeProps>>(() => ({
    type: 'FeatureCollection',
    features: this.visibleRows().map(({ company, office }, i) => ({
      type: 'Feature',
      id: i + 1,
      geometry: { type: 'Point', coordinates: [office.lng, office.lat] },
      properties: {
        officeId: office.id,
        companyId: company.id,
        name: company.name,
        category: company.category,
        color: CATEGORY_COLOR[company.category],
        label: office.label,
        locality: office.locality,
        techParkId: office.techParkId ?? '',
        isHq: office.isHq,
        status: office.status,
        confidence: office.confidence,
      },
    })),
  }));

  readonly parkCollection = computed<FeatureCollection<Point, ParkProps>>(() => {
    const byPark = this.ds.companiesByPark();
    return {
      type: 'FeatureCollection',
      features: this.ds.techParks().map((p, i) => ({
        type: 'Feature',
        id: i + 1,
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { parkId: p.id, name: p.name, tenants: byPark.get(p.id)?.length ?? 0, verified: p.verified },
      })),
    };
  });

  readonly parkFootprints = computed<FeatureCollection<Polygon, ParkProps>>(() => {
    const byPark = this.ds.companiesByPark();
    const features: Feature<Polygon, ParkProps>[] = [];
    for (const p of this.ds.techParks()) {
      const ring = p.footprint;
      if (!ring || ring.length < 4) continue;
      const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [closed] },
        properties: { parkId: p.id, name: p.name, tenants: byPark.get(p.id)?.length ?? 0, verified: p.verified },
      });
    }
    return { type: 'FeatureCollection', features };
  });

  readonly selectedCollection = computed<FeatureCollection<Point>>(() => {
    const office = this.selectedOffice();
    return {
      type: 'FeatureCollection',
      features: office ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [office.lng, office.lat] }, properties: {} }] : [],
    };
  });

  constructor() {
    this.readUrl();
    effect(() => this.writeUrl());
  }

  // ---- filters -------------------------------------------------------------------------

  patchFilters(patch: Partial<FilterState>): void {
    this.filters.update((f) => ({ ...f, ...patch }));
  }

  resetFilters(): void {
    this.filters.set(DEFAULT_FILTERS);
  }

  setQuery(query: string): void {
    this.patchFilters({ query });
  }

  toggleCategory(category: Category): void {
    this.filters.update((f) => {
      const on = f.categories.includes(category);
      // never leave the map empty by unticking the last one: that re-ticks everything
      const next = on ? f.categories.filter((c) => c !== category) : [...f.categories, category];
      return { ...f, categories: next.length ? next : [...DEFAULT_FILTERS.categories] };
    });
  }

  toggleOrigin(origin: Origin): void {
    this.filters.update((f) => {
      const on = f.origins.includes(origin);
      const next = on ? f.origins.filter((o) => o !== origin) : [...f.origins, origin];
      return { ...f, origins: next.length ? next : [...DEFAULT_FILTERS.origins] };
    });
  }

  toggleSector(sector: string): void {
    this.filters.update((f) => ({
      ...f,
      sectors: f.sectors.includes(sector) ? f.sectors.filter((s) => s !== sector) : [...f.sectors, sector],
    }));
  }

  setParkFilter(techParkId: string | null): void {
    this.patchFilters({ techParkId });
  }

  setIncludeClosed(includeClosed: boolean): void {
    this.patchFilters({ includeClosed });
  }

  setMinConfidence(minConfidence: Confidence): void {
    this.patchFilters({ minConfidence });
  }

  requestFit(): void {
    this.fitRequest.update((n) => n + 1);
  }

  // ---- selection -----------------------------------------------------------------------

  selectCompany(companyId: string, officeId: string | null = null, source: 'map' | 'panel' = 'panel'): void {
    const company = this.ds.companiesById().get(companyId);
    if (!company) return;
    const office = officeId && company.offices.some((o) => o.id === officeId) ? officeId : (company.offices.find((o) => o.isHq) ?? company.offices[0])?.id ?? null;
    this.selectionSource.set(source);
    this.selectedParkId.set(null);
    this.selectedCompanyId.set(companyId);
    this.selectedOfficeId.set(office);
  }

  selectOffice(officeId: string, source: 'map' | 'panel' = 'panel'): void {
    const hit = this.ds.officesById().get(officeId);
    if (!hit) return;
    this.selectCompany(hit.company.id, officeId, source);
  }

  selectPark(parkId: string, source: 'map' | 'panel' = 'panel'): void {
    if (!this.ds.parksById().has(parkId)) return;
    this.selectionSource.set(source);
    this.selectedCompanyId.set(null);
    this.selectedOfficeId.set(null);
    this.selectedParkId.set(parkId);
  }

  clearSelection(): void {
    this.selectedCompanyId.set(null);
    this.selectedOfficeId.set(null);
    this.selectedParkId.set(null);
  }

  private isNarrowScreen(): boolean {
    return this.document.defaultView?.matchMedia('(max-width: 900px)').matches ?? false;
  }

  // ---- URL mirror ----------------------------------------------------------------------

  private readUrl(): void {
    const win = this.document.defaultView;
    if (!win) return;
    const params = new URLSearchParams(win.location.search);
    const q = params.get('q');
    const park = params.get('park');
    const closed = params.get('closed');
    if (q || park || closed) {
      this.patchFilters({
        query: q ?? '',
        techParkId: park || null,
        includeClosed: closed === '1',
      });
    }
    // Selection ids are applied once the dataset has loaded, by the effect below.
    const company = params.get('company');
    const office = params.get('office');
    const selectedPark = params.get('selectedPark');
    if (company || selectedPark) {
      const stop = effect(() => {
        if (!this.ds.dataset()) return;
        untracked(() => {
          if (company) this.selectCompany(company, office);
          else if (selectedPark) this.selectPark(selectedPark);
          this.selectionSource.set('url');
        });
        stop.destroy();
      });
    }
  }

  private writeUrl(): void {
    const win = this.document.defaultView;
    if (!win || !this.ds.dataset()) return;
    const f = this.filters();
    const params = new URLSearchParams();
    if (f.query) params.set('q', f.query);
    if (f.techParkId) params.set('park', f.techParkId);
    if (f.includeClosed) params.set('closed', '1');
    const company = this.selectedCompanyId();
    const office = this.selectedOfficeId();
    const park = this.selectedParkId();
    if (company) params.set('company', company);
    if (office) params.set('office', office);
    if (park) params.set('selectedPark', park);
    const search = params.toString();
    const next = `${win.location.pathname}${search ? '?' + search : ''}`;
    if (next !== `${win.location.pathname}${win.location.search}`) {
      win.history.replaceState(null, '', next);
    }
  }
}
