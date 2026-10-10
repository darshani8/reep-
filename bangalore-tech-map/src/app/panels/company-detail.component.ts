import { Component, computed, inject } from '@angular/core';
import { DatasetService } from '../core/dataset.service';
import { MapStateService } from '../core/map-state.service';
import { CONFIDENCE_LABEL, STATUS_LABEL, type Company } from '../data/types';
import { CategoryChipComponent } from './category-chip.component';
import { EvidenceLineComponent } from './evidence-line.component';

@Component({
  selector: 'app-company-detail',
  imports: [CategoryChipComponent, EvidenceLineComponent],
  template: `
    @if (company(); as c) {
      <header class="head">
        <div>
          <h2>{{ c.name }}</h2>
          <div class="chips">
            <app-category-chip [category]="c.category" />
            <span class="chip chip-neutral">{{ c.origin === 'Indian' ? 'Indian company' : 'Foreign parent' }}</span>
            @if (c.isUnicorn) {
              <span class="chip chip-neutral">Unicorn</span>
            }
          </div>
        </div>
        <button type="button" class="btn btn-small" aria-label="Close details" (click)="state.clearSelection()">✕</button>
      </header>

      @if (c.description) {
        <p class="desc">{{ c.description }}</p>
      }

      <dl class="facts">
        <dt>Sector</dt>
        <dd>{{ c.sector }}</dd>
        @if (c.hqCity || c.hqCountry) {
          <dt>Global HQ</dt>
          <dd>{{ hqOf(c) }}</dd>
        }
        @if (c.founded) {
          <dt>Founded</dt>
          <dd>{{ c.founded }}</dd>
        }
        @if (c.bengaluruEmployeesApprox) {
          <dt>Bengaluru headcount</dt>
          <dd>≈ {{ c.bengaluruEmployeesApprox.toLocaleString('en-IN') }}</dd>
        }
        @if (c.website) {
          <dt>Website</dt>
          <dd><a [href]="c.website" target="_blank" rel="noopener noreferrer">{{ hostOf(c.website) }}</a></dd>
        }
        @if (c.aliases.length) {
          <dt>Also known as</dt>
          <dd>{{ c.aliases.join(', ') }}</dd>
        }
      </dl>

      <h3>{{ c.offices.length }} {{ c.offices.length === 1 ? 'office' : 'offices' }} in Bengaluru</h3>
      <ol class="offices">
        @for (o of c.offices; track o.id) {
          <li>
            <button type="button" class="office" [attr.aria-current]="state.selectedOfficeId() === o.id ? 'true' : null" (click)="state.selectOffice(o.id)">
              <span class="office-label">
                {{ o.label }}
                @if (o.isHq) {
                  <span class="chip chip-neutral">HQ</span>
                }
              </span>
              <span class="muted">
                @if (o.building) {
                  {{ o.building }} ·
                }
                {{ o.locality }}
              </span>
              @if (o.address) {
                <span class="muted small">{{ o.address }}</span>
              }
              <span class="small">
                <span class="chip chip-neutral" [class.warn]="o.status !== 'active'">{{ statusLabel[o.status] }}</span>
                <span class="chip chip-neutral" [class.warn]="o.confidence === 'low'">{{ confidenceLabel[o.confidence] }}</span>
              </span>
            </button>
            @if (parkOf(o.techParkId); as park) {
              <button type="button" class="link" (click)="state.selectPark(park.id)">In {{ park.name }} →</button>
            }
            @if (o.evidence) {
              <p class="evidence small muted"><app-evidence-line [text]="o.evidence" /></p>
            }
          </li>
        }
      </ol>

      @if (c.sources.length) {
        <details class="sources">
          <summary>Sources ({{ c.sources.length }})</summary>
          <ul>
            @for (s of c.sources; track s) {
              <li><a [href]="s" target="_blank" rel="noopener noreferrer">{{ hostOf(s) }}</a> <span class="muted small">{{ s }}</span></li>
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
      margin: 0 0 6px;
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
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .desc {
      margin: 10px 0 0;
    }
    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 3px 10px;
      margin: 10px 0 0;
      font-size: 13px;
    }
    dt {
      color: var(--ink-3);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .offices {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .office {
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
    .office:hover {
      background: var(--surface-2);
    }
    .office[aria-current='true'] {
      border-color: var(--focus);
      box-shadow: inset 3px 0 0 var(--focus);
    }
    .office-label {
      font-weight: 600;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .small {
      font-size: 12px;
    }
    .warn {
      background: #fff7ed;
      border-color: #fed7aa;
      color: #9a3412;
    }
    .link {
      border: 0;
      background: none;
      color: var(--accent);
      padding: 2px 0;
      cursor: pointer;
      font-size: 12.5px;
    }
    .evidence {
      margin: 2px 0 0;
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
    }
    .sources li .small {
      display: block;
      overflow-wrap: anywhere;
    }
  `,
})
export class CompanyDetailComponent {
  readonly state = inject(MapStateService);
  private readonly ds = inject(DatasetService);
  readonly company = computed<Company | null>(() => this.state.selectedCompany());
  readonly statusLabel = STATUS_LABEL;
  readonly confidenceLabel = CONFIDENCE_LABEL;

  parkOf(id: string | null) {
    return id ? (this.ds.parksById().get(id) ?? null) : null;
  }

  hqOf(c: Company): string {
    return [c.hqCity, c.hqCountry].filter((x): x is string => !!x).join(', ');
  }

  hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }
}
