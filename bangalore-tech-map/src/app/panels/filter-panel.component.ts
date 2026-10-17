import { Component, inject } from '@angular/core';
import { DatasetService } from '../core/dataset.service';
import { MapStateService } from '../core/map-state.service';
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_LABEL, type Confidence } from '../data/types';

@Component({
  selector: 'app-filter-panel',
  template: `
    <div class="search">
      <label class="visually-hidden" for="q">Search companies, sectors, localities and tech parks</label>
      <input
        id="q"
        type="search"
        placeholder="Search a company, sector, area or tech park"
        autocomplete="off"
        [value]="state.filters().query"
        (input)="state.setQuery($any($event.target).value)"
      />
    </div>

    <fieldset class="group">
      <legend>Category</legend>
      <div class="chips">
        @for (c of categories; track c) {
          <button
            type="button"
            class="btn btn-small toggle"
            [attr.aria-pressed]="state.filters().categories.includes(c)"
            (click)="state.toggleCategory(c)"
          >
            <span class="chip-dot" [style.background]="color[c]"></span>
            {{ label[c] }}
            <span class="count">{{ state.categoryCounts()[c] ?? 0 }}</span>
          </button>
        }
      </div>
    </fieldset>

    <fieldset class="group">
      <legend>Parent headquartered</legend>
      <div class="chips">
        <button type="button" class="btn btn-small toggle" [attr.aria-pressed]="state.filters().origins.includes('Indian')" (click)="state.toggleOrigin('Indian')">
          In India <span class="count">{{ state.originCounts()['Indian'] ?? 0 }}</span>
        </button>
        <button type="button" class="btn btn-small toggle" [attr.aria-pressed]="state.filters().origins.includes('Foreign')" (click)="state.toggleOrigin('Foreign')">
          Abroad <span class="count">{{ state.originCounts()['Foreign'] ?? 0 }}</span>
        </button>
      </div>
    </fieldset>

    <div class="group">
      <label for="park">Tech park</label>
      <select id="park" [value]="state.filters().techParkId ?? ''" (change)="state.setParkFilter($any($event.target).value || null)">
        <option value="">Anywhere in Bengaluru</option>
        @for (row of ds.parksByTenantCount(); track row.park.id) {
          <option [value]="row.park.id">{{ row.park.name }} ({{ row.tenants }})</option>
        }
      </select>
    </div>

    <details class="group" [open]="state.filters().sectors.length > 0">
      <summary>
        Sector
        @if (state.filters().sectors.length; as n) {
          <span class="count">{{ n }} picked</span>
        }
      </summary>
      <ul class="sectors">
        @for (s of ds.sectors(); track s.sector) {
          <li>
            <label>
              <input type="checkbox" [checked]="state.filters().sectors.includes(s.sector)" (change)="state.toggleSector(s.sector)" />
              {{ s.sector }} <span class="count">{{ s.count }}</span>
            </label>
          </li>
        }
      </ul>
    </details>

    <details class="group">
      <summary>More</summary>
      <label class="row">
        <input type="checkbox" [checked]="state.filters().includeClosed" (change)="state.setIncludeClosed($any($event.target).checked)" />
        Show offices that have closed or are closing
      </label>
      <label class="row" for="conf">Hide offices evidenced less than</label>
      <select id="conf" [value]="state.filters().minConfidence" (change)="state.setMinConfidence($any($event.target).value)">
        <option value="low">Show everything (incl. unconfirmed)</option>
        <option value="medium">At least one source</option>
        <option value="high">Well evidenced only</option>
      </select>
    </details>

    <div class="actions">
      <button type="button" class="btn btn-small" (click)="state.requestFit()">Fit map to results</button>
      <button type="button" class="btn btn-small" [disabled]="state.isDefaultFilter()" (click)="state.resetFilters()">Reset filters</button>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: 10px;
    }
    .search input {
      width: 100%;
      padding: 9px 11px;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      background: var(--surface);
    }
    .group {
      border: 0;
      padding: 0;
      margin: 0;
      min-width: 0;
    }
    legend,
    .group > label,
    summary {
      font-size: 12px;
      font-weight: 600;
      color: var(--ink-2);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0;
      margin-bottom: 5px;
      display: block;
    }
    summary {
      cursor: pointer;
      list-style: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    summary::before {
      content: '▸';
      display: inline-block;
      width: 1em;
    }
    details[open] > summary::before {
      content: '▾';
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .toggle {
      gap: 6px;
    }
    .toggle[aria-pressed='true'] .count {
      background: rgb(255 255 255 / 0.25);
      color: inherit;
    }
    .count {
      font-size: 11px;
      font-weight: 600;
      background: var(--surface-2);
      color: var(--ink-3);
      border-radius: 999px;
      padding: 0 6px;
      margin-left: 2px;
    }
    select {
      width: 100%;
      padding: 7px 9px;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      background: var(--surface);
    }
    .sectors {
      list-style: none;
      margin: 4px 0 0;
      padding: 0;
      max-height: 220px;
      overflow: auto;
      display: grid;
      gap: 2px;
    }
    .sectors label,
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 2px;
      text-transform: none;
      letter-spacing: 0;
      font-weight: 400;
      font-size: 13px;
      color: var(--ink);
    }
    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
  `,
})
export class FilterPanelComponent {
  readonly state = inject(MapStateService);
  readonly ds = inject(DatasetService);
  readonly categories = CATEGORIES;
  readonly color = CATEGORY_COLOR;
  readonly label = CATEGORY_LABEL;

  setMinConfidence(value: string): void {
    this.state.setMinConfidence(value as Confidence);
  }
}
