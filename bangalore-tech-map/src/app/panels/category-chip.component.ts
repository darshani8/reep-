import { Component, computed, input } from '@angular/core';
import { CATEGORY_COLOR, CATEGORY_LABEL, type Category } from '../data/types';

/** Category as colour AND text, every time. */
@Component({
  selector: 'app-category-chip',
  template: `<span class="chip chip-neutral"><span class="chip-dot" [style.background]="color()"></span>{{ label() }}</span>`,
})
export class CategoryChipComponent {
  readonly category = input.required<Category>();
  readonly color = computed(() => CATEGORY_COLOR[this.category()]);
  readonly label = computed(() => CATEGORY_LABEL[this.category()]);
}
