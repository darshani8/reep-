import { Component, computed, inject } from '@angular/core';
import { MapStateService } from '../core/map-state.service';
import { CategoryChipComponent } from './category-chip.component';

@Component({
  selector: 'app-park-detail',
  imports: [CategoryChipComponent],
  template: `
    @if (state.selectedPark(); as p) {
      <header class="head">
        <div>
          <h2>{{ p.name }}</h2>
          <div class="muted">
            Tech park · {{ p.locality }}
            @if (p.developer) {
              · {{ p.developer }}
            }
            @if (p.areaSqFtMillions) {
              · ≈ {{ p.areaSqFtMillions }} million sq ft
            }
          </div>
        </div>
        <button type="button" class="btn btn-small" aria-label="Close details" (click)="state.clearSelection()">✕</button>
      </header>

      @if (!p.verified) {
        <p class="desc muted">This park was named as a tenant location by the research but has not been described or verified in its own right yet.</p>
      } @else if (p.description) {
        <p class="desc">{{ p.description }}</p>
      }
      @if (p.aliases.length) {
        <p class="muted small">Also called {{ p.aliases.join(', ') }}</p>
      }

      <div class="actions">
        <button type="button" class="btn btn-small" [attr.aria-pressed]="state.filters().techParkId === p.id" (click)="toggleFilter(p.id)">
          {{ state.filters().techParkId === p.id ? 'Showing only this park' : 'Show only this park' }}
        </button>
      </div>

      <h3>{{ state.selectedParkCompanies().length }} mapped {{ state.selectedParkCompanies().length === 1 ? 'company' : 'companies' }} here</h3>
      <ul class="tenants">
        @for (c of state.selectedParkCompanies(); track c.id) {
          <li>
            <button type="button" class="tenant" (click)="state.selectCompany(c.id, officeIn(c, p.id))">
              <span class="name">{{ c.name }}</span>
              <app-category-chip [category]="c.category" />
            </button>
          </li>
        }
      </ul>

      @if (otherTenants().length) {
        <h3>Also named as tenants</h3>
        <p class="muted small">Named by the research but not mapped to an exact office yet.</p>
        <p class="names">{{ otherTenants().join(' · ') }}</p>
      }

      @if (p.sources.length) {
        <details class="sources">
          <summary>Sources ({{ p.sources.length }})</summary>
          <ul>
            @for (s of p.sources; track s) {
              <li><a [href]="s" target="_blank" rel="noopener noreferrer">{{ s }}</a></li>
            }
          </ul>
        </details>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: flex-start;
    }
    h2 {
      margin: 0 0 4px;
      font-size: 18px;
      line-height: 1.25;
    }
    h3 {
      margin: 14px 0 6px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ink-2);
    }
    .desc {
      margin: 10px 0 0;
    }
    .small {
      font-size: 12px;
    }
    .actions {
      margin-top: 10px;
    }
    .tenants {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    .tenant {
      width: 100%;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      text-align: left;
      padding: 7px 10px;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      background: var(--surface);
      cursor: pointer;
    }
    .tenant:hover {
      background: var(--surface-2);
    }
    .name {
      font-weight: 600;
    }
    .names {
      margin: 4px 0 0;
      font-size: 13px;
    }
    .sources {
      margin-top: 12px;
      font-size: 12.5px;
    }
    .sources ul {
      margin: 6px 0 0;
      padding-left: 16px;
      display: grid;
      gap: 4px;
      overflow-wrap: anywhere;
    }
  `,
})
export class ParkDetailComponent {
  readonly state = inject(MapStateService);

  readonly otherTenants = computed(() => {
    const park = this.state.selectedPark();
    if (!park) return [];
    const mapped = new Set(this.state.selectedParkCompanies().map((c) => c.name.toLowerCase()));
    return park.notableTenants.filter((t) => !mapped.has(t.toLowerCase()));
  });

  officeIn(company: { offices: { id: string; techParkId: string | null }[] }, parkId: string): string | null {
    return company.offices.find((o) => o.techParkId === parkId)?.id ?? null;
  }

  toggleFilter(parkId: string): void {
    this.state.setParkFilter(this.state.filters().techParkId === parkId ? null : parkId);
  }
}
