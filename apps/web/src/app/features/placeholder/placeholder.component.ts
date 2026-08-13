/**
 * A holding screen for a role area whose pages have not been migrated to Angular
 * yet. It is honest rather than blank: the shell, nav and auth all work, and
 * this says plainly that the content is still being ported — so a mentor or
 * director signing in lands somewhere coherent instead of a broken route.
 */

import { Component } from '@angular/core';

@Component({
  selector: 'app-placeholder',
  standalone: true,
  template: `
    <h1 class="reep-h1 title">Being migrated</h1>
    <p class="body reep-body2">
      This area is being ported to Angular, screen by screen. The sign-in, the
      shell and the navigation you are using are already the new stack; these
      pages land next.
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
export class PlaceholderComponent {}
