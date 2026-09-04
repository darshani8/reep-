/**
 * Jobs Sheet — every posting on the board, and whether it is working.
 *
 * The student's Jobs screen answers "what can I apply to". This one answers
 * "which of these are doing anything", which is why the applicant count is a
 * first-class column rather than a detail: a posting nobody applied to looks
 * identical to a healthy one without it, and that is the row a placement office
 * needs to find.
 *
 * The eligibility gates (min CGPA, live-backlog cap) are shown per posting
 * because they are the usual reason a posting has no applicants — a cut-off set
 * a notch too high is invisible from the outside.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

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
  readonly onlyQuiet = signal(false);

  readonly visible = computed(() => {
    const rows = this.rows() ?? [];
    return this.onlyQuiet() ? rows.filter((r) => r.applicants === 0) : rows;
  });

  readonly totals = computed(() => {
    const rows = this.rows() ?? [];
    return {
      postings: rows.length,
      applications: rows.reduce((n, r) => n + r.applicants, 0),
      quiet: rows.filter((r) => r.applicants === 0).length,
    };
  });

  constructor() {
    void this.load();
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

  gates(row: JobRow): string {
    const parts: string[] = [];
    if (row.min_cgpa !== null) parts.push(`CGPA ≥ ${row.min_cgpa}`);
    if (row.max_live_backlogs !== null) parts.push(`≤ ${row.max_live_backlogs} live backlogs`);
    return parts.length ? parts.join(' · ') : 'No gates';
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
