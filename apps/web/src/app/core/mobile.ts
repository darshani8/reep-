/**
 * "Is this a phone?" as a signal, for the admin screens that render a
 * DIFFERENT shape at phone width rather than the same shape restyled — an
 * ag-grid that becomes a list of cards, a master/detail board that becomes a
 * list with a pushed detail.
 *
 * CSS answers every other question (see src/styles/_mobile.scss). This exists because
 * ag-grid cannot be restyled into a list: rendering both and hiding one would
 * keep a second grid initialised and listening on every phone, so the template
 * picks one with `@if (phone())`. The query is the same literal as the mixins'
 * `$phone-max`; a media query cannot share a variable with TypeScript.
 *
 * Must be called in an injection context (a field initialiser).
 */

import { DestroyRef, Signal, inject, signal } from '@angular/core';

export const PHONE_QUERY = '(max-width: 599.98px)';

export function phoneSignal(query: string = PHONE_QUERY): Signal<boolean> {
  const mql =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;
  const s = signal(mql?.matches ?? false);
  if (mql) {
    const onChange = (e: MediaQueryListEvent) => s.set(e.matches);
    mql.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => mql.removeEventListener('change', onChange));
  }
  return s.asReadonly();
}
