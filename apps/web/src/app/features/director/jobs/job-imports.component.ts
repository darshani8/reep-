/**
 * Director → Jobs sheet. The audit trail behind the board students see: what
 * was imported, and what the alert mailer did about it.
 *
 * GET /director/job-imports (one row per bulk import, with per-run error
 * counts) and GET /director/mail?kind=job-alert (what the mailer was asked to
 * send, most recent first).
 *
 * The two belong on one screen because they are two halves of one question. An
 * import that created forty vacancies and a mail log with no sends is the
 * failure mode this page exists to make visible — the board looks healthy from
 * the student side either way, because the rows are there; what is missing is
 * that anyone was told.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { environment } from '../../../../environments/environment';

interface ImportRun {
  id: string;
  file_name: string | null;
  uploaded_by_id: string | null;
  started_at: string;
  finished_at: string | null;
  rows_seen: number;
  rows_created: number;
  rows_updated: number;
  error_count: number;
}

interface MailRow {
  id: string;
  kind: string;
  recipient: string;
  subject: string | null;
  status: string;
  error: string | null;
  sent_at: string;
}

@Component({
  selector: 'app-job-imports',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './job-imports.component.html',
})
export class JobImportsComponent {
  private readonly apiBase = environment.apiBase;

  readonly runs = signal<ImportRun[] | null>(null);
  readonly mail = signal<MailRow[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly totals = computed(() => {
    const list = this.runs() ?? [];
    return {
      runs: list.length,
      created: list.reduce((n, r) => n + r.rows_created, 0),
      updated: list.reduce((n, r) => n + r.rows_updated, 0),
      errors: list.reduce((n, r) => n + r.error_count, 0),
    };
  });

  readonly mailFailures = computed(
    () => (this.mail() ?? []).filter((m) => m.status !== 'SENT').length,
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [r, m] = await Promise.all([
        fetch(`${this.apiBase}/director/job-imports`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/mail?kind=job-alert`, { credentials: 'include' }),
      ]);
      if (!r.ok) {
        this.error.set(
          r.status === 403
            ? 'The import audit is for directors and admins.'
            : 'Could not load the import history.',
        );
        return;
      }
      this.runs.set((await r.json()) as ImportRun[]);
      this.mail.set(m.ok ? ((await m.json()) as MailRow[]) : []);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  /** A run with no `finished_at` is still going, or the process that was
   *  running it died. Either way it is not a completed run, and the row says so
   *  rather than rendering an empty cell. */
  runState(r: ImportRun): { tone: 'good' | 'warn' | 'risk'; label: string; icon: string } {
    if (r.finished_at === null) return { tone: 'warn', label: 'Unfinished', icon: 'hourglass_top' };
    if (r.error_count > 0)
      return { tone: 'risk', label: `${r.error_count} row error(s)`, icon: 'error' };
    return { tone: 'good', label: 'Clean', icon: 'check_circle' };
  }
}
