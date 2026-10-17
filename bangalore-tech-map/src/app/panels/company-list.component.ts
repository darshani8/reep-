import { Component, computed, inject } from '@angular/core';
import { DatasetService } from '../core/dataset.service';
import { matchingOffices } from '../core/filters';
import { MapStateService } from '../core/map-state.service';
import { CategoryChipComponent } from './category-chip.component';

@Component({
  selector: 'app-company-list',
  imports: [CategoryChipComponent],
  template: `
    <p class="summary" role="status">
      <strong>{{ rows().length }}</strong> {{ rows().length === 1 ? 'company' : 'companies' }} ·
      <strong>{{ state.visibleOfficeCount() }}</strong> {{ state.visibleOfficeCount() === 1 ? 'office' : 'offices' }}
      @if (!state.isDefaultFilter()) {
        <span class="muted">(filtered)</span>
      }
    </p>
    @if (!rows().length) {
      <p class="empty muted">Nothing matches. Clear a filter or try another spelling.</p>
    }
    <ul class="list">
      @for (row of rows(); track row.company.id) {
        <li>
          <button
            type="button"
            class="row"
            [attr.aria-current]="state.selectedCompanyId() === row.company.id ? 'true' : null"
            (click)="state.selectCompany(row.company.id)"
          >
            <span class="name">{{ row.company.name }}</span>
            <span class="meta">
              <app-category-chip [category]="row.company.category" />
              <span class="muted">{{ row.company.sector }}</span>
            </span>
            <span class="where muted">
              {{ row.visible }} {{ row.visible === 1 ? 'office' : 'offices' }}
              @if (row.places) {
                · {{ row.places }}
              }
            </span>
          </button>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    .summary {
      margin: 0 0 6px;
      font-size: 13px;
    }
    .empty {
      margin: 12px 0;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    .row {
      width: 100%;
      text-align: left;
      display: grid;
      gap: 3px;
      padding: 8px 10px;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      background: var(--surface);
      cursor: pointer;
    }
    .row:hover {
      background: var(--surface-2);
    }
    .row[aria-current='true'] {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .name {
      font-weight: 600;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      font-size: 12.5px;
    }
    .where {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class CompanyListComponent {
  readonly state = inject(MapStateService);
  private readonly ds = inject(DatasetService);

  readonly rows = computed(() => {
    const f = this.state.filters();
    const parks = this.ds.parksById();
    return this.state.filteredCompanies().map((company) => {
      const offices = matchingOffices(company, parks, f);
      const names: string[] = [];
      for (const o of offices) {
        const label = o.techParkId ? (parks.get(o.techParkId)?.name ?? o.locality) : o.locality;
        if (label && !names.includes(label)) names.push(label);
      }
      const places = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
      return { company, visible: offices.length, places };
    });
  });
}
