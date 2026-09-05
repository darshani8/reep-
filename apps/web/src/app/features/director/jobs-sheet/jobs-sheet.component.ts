/**
 * Jobs Sheet — the openings the placement office publishes.
 *
 * Students and alumni read the same `jobs` table, so "Publish to sheet" is one
 * POST and the posting is on both boards at once. The form asks what the design
 * asks — role, company, level, location, closing date — and nothing more: the
 * eligibility gates (min CGPA, live backlogs) default to the programme's
 * placement criteria, because a per-posting override on a quick form is how a
 * cut-off ends up a notch too high by accident.
 *
 * The applicant count is a first-class column rather than a detail: a posting
 * nobody applied to looks identical to a healthy one without it, and that is
 * the row a placement office needs to find.
 *
 * REMOVE IS REFUSED ONCE ANYONE HAS APPLIED. Applications cascade with the
 * posting and are part of a student's record; the server answers 409 and the
 * sheet shows why. A posting that has done its job stays as history.
 */

import { DatePipe } from '@angular/common';
import { Component, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface JobRow {
  id: string;
  title: string;
  company: string;
  degree_level: string;
  location: string | null;
  apply_url: string | null;
  required_skills: string[];
  posted_on: string;
  closes_on: string | null;
  min_cgpa: number | null;
  max_live_backlogs: number | null;
  applicants: number;
}

@Component({
  selector: 'app-director-jobs-sheet',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './jobs-sheet.component.html',
  styleUrl: './jobs-sheet.component.scss',
})
export class DirectorJobsSheetComponent {
  readonly rows = signal<JobRow[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly formOpen = signal(false);
  readonly fRole = signal('');
  readonly fCompany = signal('');
  readonly fLevel = signal<'PG' | 'UG'>('PG');
  readonly fLocation = signal('');
  readonly fCloses = signal('');
  readonly fUrl = signal('');
  readonly formErr = signal<string | null>(null);
  readonly published = signal(false);
  readonly saving = signal(false);
  readonly removing = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  toggleForm(): void {
    this.formOpen.update((v) => !v);
    this.formErr.set(null);
  }

  /** Closed, closing soon, or open — the same reading the student's board uses. */
  closes(row: JobRow): { tone: string; label: string } {
    if (!row.closes_on) return { tone: 'neutral', label: 'No deadline' };
    const days = Math.ceil((new Date(row.closes_on).getTime() - Date.now()) / 86_400_000);
    if (Number.isNaN(days)) return { tone: 'neutral', label: 'No deadline' };
    if (days < 0) return { tone: 'risk', label: 'Closed' };
    if (days <= 7) return { tone: 'warn', label: `Closes in ${days}d` };
    return { tone: 'neutral', label: 'Open' };
  }

  async publish(): Promise<void> {
    const title = this.fRole().trim();
    const company = this.fCompany().trim();
    if (!title || !company) {
      this.formErr.set('Role and company are required');
      return;
    }
    const url = this.fUrl().trim();
    if (url && !/^https?:\/\//i.test(url)) {
      this.formErr.set('The apply link must start with http:// or https://');
      return;
    }
    this.saving.set(true);
    this.formErr.set(null);
    this.published.set(false);
    try {
      const res = await fetch(`${environment.apiBase}/director/jobs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          company,
          degree_level: this.fLevel(),
          location: this.fLocation().trim() || null,
          closes_on: this.fCloses() || null,
          apply_url: url || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.formErr.set(d?.detail ?? 'Could not publish that opening.');
        return;
      }
      const row = (await res.json()) as JobRow;
      this.rows.update((list) => [row, ...(list ?? [])]);
      this.fRole.set('');
      this.fCompany.set('');
      this.fLocation.set('');
      this.fUrl.set('');
      this.published.set(true);
      setTimeout(() => this.published.set(false), 3000);
    } catch {
      this.formErr.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  async remove(row: JobRow): Promise<void> {
    this.removing.set(row.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/director/jobs/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.error.set(d?.detail ?? 'Could not remove that posting.');
        return;
      }
      this.rows.update((list) => (list ?? []).filter((r) => r.id !== row.id));
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.removing.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/director/jobs`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load the jobs sheet.');
        this.rows.set([]);
        return;
      }
      this.rows.set((await res.json()) as JobRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
    }
  }
}
