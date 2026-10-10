import { Component, computed, input } from '@angular/core';

import { EvidenceSegment, evidenceSegments } from '../core/evidence';

/** Renders a sentence with its URLs and OpenStreetMap references as links, built from segments rather than innerHTML. */
@Component({
  selector: 'app-evidence-line',
  template: `
    @for (seg of segments(); track $index) {
      @if (seg.url) {
        <a [href]="seg.url" target="_blank" rel="noopener noreferrer">{{ seg.text }}</a>
      } @else {
        {{ seg.text }}
      }
    }
  `,
  styles: `
    :host {
      display: inline;
      overflow-wrap: anywhere;
    }
  `,
})
export class EvidenceLineComponent {
  readonly text = input.required<string>();

  readonly segments = computed<EvidenceSegment[]>(() => evidenceSegments(this.text()));
}
