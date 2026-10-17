import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { DatasetService } from '../core/dataset.service';

@Component({
  selector: 'app-about-dialog',
  template: `
    <dialog #dlg aria-labelledby="about-title">
      <header>
        <h2 id="about-title">About this map</h2>
        <button type="button" class="btn btn-small" aria-label="Close" (click)="close()">✕</button>
      </header>
      <p>
        An interactive map of the companies in Bengaluru: multinationals (foreign and Indian), established mid-size companies,
        venture-funded startups and public-sector employers, each with every Bengaluru office that could be substantiated, and the
        tech parks they sit in.
      </p>
      @if (ds.dataset(); as d) {
        <p>
          <strong>{{ d.companies.length }}</strong> companies · <strong>{{ ds.officeCount() }}</strong> offices ·
          <strong>{{ d.techParks.length }}</strong> tech parks. Dataset generated {{ d.generatedAt.slice(0, 10) }} from
          {{ d.provenance.lenses }} research slices.
        </p>
      }
      <h3>How to read it</h3>
      <ul>
        <li>Every office carries an <em>evidence</em> line naming the source that places it there, and a confidence word: well evidenced, one source, or unconfirmed.</li>
        <li>Offices move. A pin is where the evidence put it on the day the data was gathered, not a promise about today.</li>
        <li>The map is pinned to Bengaluru on purpose; Hosur, Mysuru and the rest of Karnataka are out of scope.</li>
      </ul>
      <h3>Credits</h3>
      <p class="small">
        Base map: <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> (OpenMapTiles), rendered with
        <a href="https://maplibre.org" target="_blank" rel="noopener noreferrer">MapLibre GL JS</a>. Map data and office coordinates
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> (ODbL).
        Built with Angular.
      </p>
    </dialog>
  `,
  styles: `
    dialog {
      max-width: 560px;
      width: calc(100vw - 32px);
      border: 1px solid var(--hairline);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: var(--shadow);
    }
    dialog::backdrop {
      background: rgb(15 23 42 / 0.4);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
    }
    h2 {
      margin: 0;
      font-size: 18px;
    }
    h3 {
      margin: 14px 0 4px;
      font-size: 14px;
    }
    ul {
      padding-left: 18px;
      margin: 6px 0;
      display: grid;
      gap: 4px;
    }
    .small {
      font-size: 12.5px;
      color: var(--ink-3);
    }
  `,
})
export class AboutDialogComponent {
  readonly ds = inject(DatasetService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  open(): void {
    this.dialog().nativeElement.showModal();
  }

  close(): void {
    this.dialog().nativeElement.close();
  }
}
