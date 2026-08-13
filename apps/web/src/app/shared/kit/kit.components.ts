/**
 * The shared kit, ported from src/components/kit.tsx.
 *
 * Boxless compositions — a section is a heading with room around it, a statistic
 * is a number with a word under it. Every screen is built from these, which is
 * what keeps the product reading as one thing. Props mirror the React kit so a
 * screen ports almost line-for-line.
 *
 * Several small standalone components share this file because they are one
 * conceptual unit and always imported together.
 */

import { Component, Input } from '@angular/core';

import { TONE_INK, type Tone } from './tone';

/// Title + optional subtitle, with a projected action on the right.
@Component({
  selector: 'kit-page-intro',
  standalone: true,
  template: `
    <div class="intro">
      <div class="intro__text">
        <h1 class="reep-h1 intro__title">{{ title }}</h1>
        @if (subtitle) {
          <p class="reep-body2 intro__subtitle">{{ subtitle }}</p>
        }
      </div>
      <div class="intro__action no-print"><ng-content select="[action]"></ng-content></div>
    </div>
  `,
  styles: [
    `
      .intro {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        justify-content: space-between;
        align-items: flex-end;
        margin-bottom: 40px;
      }
      .intro__text {
        min-width: 0;
      }
      .intro__title {
        margin: 0;
        color: var(--reep-text-primary);
      }
      .intro__subtitle {
        margin: 6px 0 0;
        max-width: 68ch;
        color: var(--reep-text-secondary);
      }
    `,
  ],
})
export class PageIntroComponent {
  @Input() title = '';
  @Input() subtitle?: string;
}

/// A titled block separated by a hairline, not a card.
@Component({
  selector: 'kit-section',
  standalone: true,
  template: `
    <section class="section">
      @if (title) {
        <div class="section__head">
          <div class="section__headings">
            <h2 class="reep-h3 section__title">{{ title }}</h2>
            @if (subtitle) {
              <p class="reep-caption section__subtitle">{{ subtitle }}</p>
            }
          </div>
          <div class="section__action no-print"><ng-content select="[action]"></ng-content></div>
        </div>
      }
      <ng-content></ng-content>
    </section>
  `,
  styles: [
    `
      .section {
        margin-bottom: 40px;
      }
      .section__head {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: baseline;
        padding-bottom: 10px;
        margin-bottom: 20px;
        border-bottom: 1px solid var(--reep-divider);
      }
      .section__headings {
        min-width: 0;
      }
      .section__title {
        margin: 0;
        color: var(--reep-text-primary);
      }
      .section__subtitle {
        margin: 2px 0 0;
        color: var(--reep-text-secondary);
      }
      .section__action {
        flex-shrink: 0;
      }
    `,
  ],
})
export class SectionComponent {
  @Input() title?: string;
  @Input() subtitle?: string;
}

/// One number, one word.
@Component({
  selector: 'kit-stat',
  standalone: true,
  template: `
    <div class="stat">
      <div class="stat__value tabular" [style.color]="ink">{{ value }}</div>
      <div class="reep-body2 stat__label">{{ label }}</div>
      @if (hint) {
        <div class="reep-caption stat__hint">{{ hint }}</div>
      }
    </div>
  `,
  styles: [
    `
      .stat {
        padding: 4px 0;
      }
      .stat__value {
        font-size: 2rem;
        font-weight: 600;
        line-height: 1.05;
        letter-spacing: -0.028em;
      }
      .stat__label {
        margin-top: 6px;
        color: var(--reep-text-secondary);
      }
      .stat__hint {
        margin-top: 4px;
        color: var(--reep-text-disabled);
      }
    `,
  ],
})
export class StatComponent {
  @Input() label = '';
  @Input() value: string | number = '';
  @Input() hint?: string;
  @Input() tone: Tone = 'neutral';

  get ink(): string {
    return TONE_INK[this.tone];
  }
}

/// Centred empty message with an optional projected action.
@Component({
  selector: 'kit-empty',
  standalone: true,
  template: `
    <div class="empty">
      <div class="reep-subtitle1 empty__title">{{ title }}</div>
      @if (hint) {
        <div class="reep-body2 empty__hint">{{ hint }}</div>
      }
      <div class="empty__action"><ng-content select="[action]"></ng-content></div>
    </div>
  `,
  styles: [
    `
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 56px 24px;
        text-align: center;
      }
      .empty__title {
        color: var(--reep-text-secondary);
      }
      .empty__hint {
        max-width: 48ch;
        color: var(--reep-text-disabled);
      }
    `,
  ],
})
export class EmptyComponent {
  @Input() title = '';
  @Input() hint?: string;
}

/// An outlined callout with a title, body and optional action.
@Component({
  selector: 'kit-banner',
  standalone: true,
  template: `
    <div class="banner" [attr.data-tone]="tone">
      <div class="banner__body">
        @if (title) {
          <div class="banner__title">{{ title }}</div>
        }
        <div class="reep-body2 banner__text"><ng-content></ng-content></div>
      </div>
      <div class="banner__action no-print"><ng-content select="[action]"></ng-content></div>
    </div>
  `,
  styles: [
    `
      .banner {
        display: flex;
        gap: 16px;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        margin-bottom: 32px;
        border: 1px solid var(--reep-divider);
        border-radius: 8px;
        background: var(--reep-action-hover);
      }
      .banner__title {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--reep-text-primary);
        margin-bottom: 2px;
      }
      .banner__text {
        color: var(--reep-text-secondary);
      }
      .banner[data-tone='warning'] .banner__title {
        color: var(--reep-warning-main);
      }
      .banner[data-tone='critical'] .banner__title {
        color: var(--reep-error-main);
      }
    `,
  ],
})
export class BannerComponent {
  @Input() tone: 'info' | 'warning' | 'critical' | 'good' = 'info';
  @Input() title?: string;
}
