/**
 * One icon element, rendering a Material Symbols Outlined glyph.
 *
 * The React app used MUI's `*Outlined` icons, which are the Material "outlined"
 * theme — the same glyphs Material Symbols Outlined draws. Rendering them from
 * the icon font (loaded in index.html) gives the identical outlined shape
 * without hand-transcribing two dozen SVG paths, and inherits colour and size
 * from its context exactly as the MUI SvgIcon did.
 */

import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `<span class="material-symbols-outlined" [style.font-size.px]="size">{{ name }}</span>`,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .material-symbols-outlined {
        font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
        line-height: 1;
        user-select: none;
      }
    `,
  ],
})
export class IconComponent {
  /// The Material Symbols ligature name, e.g. "home", "work_outline".
  @Input() name = '';
  @Input() size = 20;
}
