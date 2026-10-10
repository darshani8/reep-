import { Component } from '@angular/core';
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_DESCRIPTION, CATEGORY_LABEL, TECH_PARK_COLOR } from '../data/types';

@Component({
  selector: 'app-legend',
  template: `
    <details class="legend">
      <summary>Legend</summary>
      <ul>
        @for (c of categories; track c) {
          <li>
            <span class="swatch" [style.background]="color[c]"></span>
            <span><strong>{{ label[c] }}</strong> <span class="muted">— {{ description[c] }}</span></span>
          </li>
        }
        <li>
          <span class="swatch park" [style.border-color]="parkColor"></span>
          <span><strong>Tech park</strong> <span class="muted">— click for its tenants; the dashed outline is its OpenStreetMap footprint</span></span>
        </li>
        <li>
          <span class="swatch hq"></span>
          <span><strong>Larger dot</strong> <span class="muted">— the company's Bengaluru headquarters</span></span>
        </li>
        <li>
          <span class="swatch cluster">12</span>
          <span><strong>Cluster</strong> <span class="muted">— several offices; coloured by the category most of them belong to. Click to open.</span></span>
        </li>
      </ul>
    </details>
  `,
  styles: `
    .legend {
      font-size: 12.5px;
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 6px 10px;
      max-width: 340px;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
    }
    ul {
      list-style: none;
      margin: 8px 0 2px;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    li {
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    .swatch {
      flex: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      margin-top: 2px;
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px rgb(0 0 0 / 0.15);
    }
    .swatch.park {
      background: #fff;
      border-width: 2.5px;
      box-shadow: none;
    }
    .swatch.hq {
      width: 18px;
      height: 18px;
      margin-top: 0;
      background: #475569;
    }
    .swatch.cluster {
      width: 22px;
      height: 22px;
      margin-top: -2px;
      background: #475569;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  `,
})
export class LegendComponent {
  readonly categories = CATEGORIES;
  readonly color = CATEGORY_COLOR;
  readonly label = CATEGORY_LABEL;
  readonly description = CATEGORY_DESCRIPTION;
  readonly parkColor = TECH_PARK_COLOR;
}
