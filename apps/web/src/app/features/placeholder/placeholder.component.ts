/**
 * A holding screen for a nav destination whose page has not been migrated to
 * Angular yet. It is honest rather than blank: the shell, nav, routing and auth
 * all work, each link navigates here and highlights correctly, and this names
 * the screen (from the route's `title` data) so navigation is visibly working
 * while the real content is still being ported.
 */

import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-placeholder',
  standalone: true,
  template: `
    <h1 class="reep-h1 title">{{ title || 'Being migrated' }}</h1>
    <p class="body reep-body2">
      This screen is being ported to Angular. The sign-in, the shell and the
      navigation you are using are already the new stack; this page lands next.
    </p>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .title {
        margin: 0 0 12px;
        color: var(--reep-text-primary);
      }
      .body {
        max-width: 520px;
        color: var(--reep-text-secondary);
      }
    `,
  ],
})
export class PlaceholderComponent {
  /// Bound from the route's `data.title` via withComponentInputBinding().
  @Input() title = '';
}
