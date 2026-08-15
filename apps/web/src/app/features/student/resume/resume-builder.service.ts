/**
 * Resume Builder — shared state for the whole 15-section builder.
 *
 * One root singleton holds the entire resume profile as an opaque section map
 * (`data`: section-key -> object | array). The shell (resume-builder.component)
 * calls `load()` once; each standalone section component reads its own slice via
 * `section(key, fallback)` and writes it back via `patch(key, value)` — sections
 * never fetch or PUT resume-profile themselves, they only mutate this signal and
 * let the shell's "Save section" button flush the whole map with `save()`.
 *
 * Read-only sections that mirror another domain (education / attachments /
 * certifications) ignore this map and fetch their own endpoint instead.
 *
 * Endpoint: GET/PUT `${apiBase}/student/resume-profile`, cookie-authenticated.
 *   GET  -> { data: Record<string, unknown>, completeness: number }
 *   PUT  { data } -> { completeness: number }
 */

import { Injectable, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ResumeBuilderService {
  /** section-key -> value (object or array). The full resume profile. */
  readonly data = signal<Record<string, any>>({});
  /** Server-computed profile completeness, 0..100. */
  readonly completeness = signal<number>(0);
  /** True once the first load() has populated `data`. */
  readonly loaded = signal(false);
  /** True while a save() PUT is in flight. */
  readonly saving = signal(false);
  /** ISO timestamp of the last successful save, or null. */
  readonly savedAt = signal<string | null>(null);
  /** Last load/save error message, or null. */
  readonly error = signal<string | null>(null);

  /** Fetch the whole profile and completeness; sets `loaded` on success. */
  async load(): Promise<void> {
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/resume-profile`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load your resume profile.');
        return;
      }
      const body = (await res.json()) as { data?: Record<string, any>; completeness?: number };
      this.data.set(body.data ?? {});
      this.completeness.set(body.completeness ?? 0);
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  /** Read one section's slice, or `fallback` when it has never been set. */
  section(key: string, fallback: any): any {
    return this.data()[key] ?? fallback;
  }

  /** Replace one section's slice, leaving every other section untouched. */
  patch(key: string, value: any): void {
    this.data.update((d) => ({ ...d, [key]: value }));
  }

  /** Flush the whole profile map; updates `completeness` and `savedAt`. */
  async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/resume-profile`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: this.data() }),
      });
      if (!res.ok) {
        this.error.set('Could not save your changes. Please try again.');
        return;
      }
      const body = (await res.json()) as { completeness?: number };
      this.completeness.set(body.completeness ?? this.completeness());
      this.savedAt.set(new Date().toISOString());
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }
}
