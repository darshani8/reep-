import { httpResource } from '@angular/common/http';
import { Service, computed } from '@angular/core';
import type { Company, Dataset, TechPark } from '../data/types';

export interface SectorCount {
  sector: string;
  count: number;
}

/**
 * Loads `public/data/dataset.json` once and exposes it as signals plus the indexes every
 * panel needs. The dataset is static; nothing here writes.
 */
@Service()
export class DatasetService {
  private readonly res = httpResource<Dataset>(() => 'data/dataset.json');

  readonly loading = computed(() => this.res.isLoading());
  readonly error = computed(() => this.res.error());
  readonly dataset = computed<Dataset | null>(() => (this.res.hasValue() ? this.res.value() : null));

  readonly companies = computed<readonly Company[]>(() => this.dataset()?.companies ?? []);
  readonly techParks = computed<readonly TechPark[]>(() => this.dataset()?.techParks ?? []);

  readonly companiesById = computed(() => new Map(this.companies().map((c) => [c.id, c] as const)));
  readonly parksById = computed(() => new Map(this.techParks().map((p) => [p.id, p] as const)));

  readonly officesById = computed(() => {
    const out = new Map<string, { company: Company; office: Company['offices'][number] }>();
    for (const company of this.companies()) {
      for (const office of company.offices) out.set(office.id, { company, office });
    }
    return out;
  });

  readonly officeCount = computed(() => this.companies().reduce((n, c) => n + c.offices.length, 0));

  readonly sectors = computed<SectorCount[]>(() => {
    const counts = new Map<string, number>();
    for (const c of this.companies()) counts.set(c.sector, (counts.get(c.sector) ?? 0) + 1);
    return [...counts.entries()]
      .map(([sector, count]) => ({ sector, count }))
      .sort((a, b) => b.count - a.count || a.sector.localeCompare(b.sector));
  });

  /** Companies with at least one office in each park, keyed by park id. */
  readonly companiesByPark = computed(() => {
    const out = new Map<string, Company[]>();
    for (const c of this.companies()) {
      const seen = new Set<string>();
      for (const o of c.offices) {
        if (o.techParkId && !seen.has(o.techParkId)) {
          seen.add(o.techParkId);
          const list = out.get(o.techParkId) ?? [];
          list.push(c);
          out.set(o.techParkId, list);
        }
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  });

  /** Parks sorted by how many dataset companies sit in them, for the filter select. */
  readonly parksByTenantCount = computed(() => {
    const byPark = this.companiesByPark();
    return [...this.techParks()]
      .map((p) => ({ park: p, tenants: byPark.get(p.id)?.length ?? 0 }))
      .sort((a, b) => b.tenants - a.tenants || a.park.name.localeCompare(b.park.name));
  });
}
