/**
 * Light / dark, ported from the MUI `useColorScheme` toggle in app-shell.tsx.
 *
 * The React app switched schemes by flipping a `data-theme` attribute on the
 * root, which the ported reep-theme.scss reads exactly the same way. So this
 * service does the one thing that matters: set `data-theme` on <html> and
 * remember the choice.
 */

import { Injectable, effect, signal } from '@angular/core';

type Mode = 'light' | 'dark';
const STORAGE_KEY = 'reep-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<Mode>(this.initial());

  constructor() {
    // Apply on construction and on every change.
    effect(() => this.apply(this.mode()));
  }

  toggle(): void {
    this.mode.update((m) => (m === 'dark' ? 'light' : 'dark'));
  }

  private initial(): Mode {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  }

  private apply(mode: Mode): void {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }
}
