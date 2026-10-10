import { Component, computed, input } from '@angular/core';

interface Segment {
  text: string;
  url: string | null;
}

const URL_RE = /(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/g;

/** Renders a sentence with its URLs as links, built from segments rather than innerHTML. */
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

  readonly segments = computed<Segment[]>(() => {
    const out: Segment[] = [];
    const source = this.text();
    let last = 0;
    for (const m of source.matchAll(URL_RE)) {
      const start = m.index ?? 0;
      if (start > last) out.push({ text: source.slice(last, start), url: null });
      const url = m[0];
      let host = url;
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        /* keep the raw url as the label */
      }
      out.push({ text: host, url });
      last = start + url.length;
    }
    if (last < source.length) out.push({ text: source.slice(last), url: null });
    return out;
  });
}
