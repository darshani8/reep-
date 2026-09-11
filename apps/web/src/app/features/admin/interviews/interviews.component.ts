/**
 * Interview Records — the admin's grid of every interview, with the student
 * named, the time it was taken, and a download for each recording.
 *
 * DISTINCT FROM the student's own /student/interviews (their history, no
 * identity repeated back) and from the per-student staff endpoints (one student
 * at a time). This is the cross-programme records view: it names WHOSE each
 * interview is, which is the whole point of a records screen.
 *
 * SCOPE IS THE SERVER'S. GET /api/mentor/interviews applies rule 2 in SQL — a
 * the Main Admin sees all, a mentor only their own group, a group-less mentor nobody.
 * This screen renders whatever it is handed and never widens it.
 *
 * DOWNLOAD, NOT DELETE. Per the owner's decision, a recording can be downloaded
 * to the local machine but there is no delete here — recordings still expire on
 * the 180-day retention clock, which is the only thing that removes them.
 * Individual rows download the mixed track as an attachment; the "Download
 * selected" button posts the chosen ids and streams back one zip.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface RecordRow {
  session_id: string;
  student_id: string;
  student_name: string;
  usn: string | null;
  specialization: string | null;
  status: string;
  audio_recorded: boolean;
  started_at: string;
  ended_at: string | null;
}

type ScreenState = 'loading' | 'ready' | 'error';

const TRACK_LABEL: Record<string, string> = {
  hr: 'HR',
  dm: 'Digital Marketing',
  ba: 'Business Analytics',
  fa: 'Financial Analytics',
};

@Component({
  selector: 'app-interview-records',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './interviews.component.html',
  styleUrl: './interviews.component.scss',
})
export class InterviewRecordsComponent {
  readonly state = signal<ScreenState>('loading');
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly rows = signal<RecordRow[]>([]);
  readonly recordedOnly = signal(false);
  /** session_ids the operator has ticked. */
  readonly selected = signal<Set<string>>(new Set());
  readonly downloading = signal(false);

  readonly visibleRows = computed(() =>
    this.recordedOnly() ? this.rows().filter((r) => r.audio_recorded) : this.rows(),
  );
  /** Only recorded rows can be selected — a failed interview has nothing to
   *  download, so its checkbox is never offered. */
  readonly selectableRows = computed(() => this.rows().filter((r) => r.audio_recorded));
  readonly selectedCount = computed(() => this.selected().size);
  readonly allSelected = computed(() => {
    const sel = this.selected();
    const selectable = this.selectableRows();
    return selectable.length > 0 && selectable.every((r) => sel.has(r.session_id));
  });
  readonly recordedTotal = computed(() => this.selectableRows().length);

  constructor() {
    void this.load();
  }

  // -- selection ------------------------------------------------------------
  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  toggleAll(): void {
    const selectable = this.selectableRows();
    this.selected.update((s) => {
      if (selectable.every((r) => s.has(r.session_id))) return new Set();
      return new Set(selectable.map((r) => r.session_id));
    });
  }

  onRecordedOnlyChange(v: boolean): void {
    this.recordedOnly.set(v);
  }

  // -- labels ---------------------------------------------------------------
  trackLabel(key: string | null): string {
    if (!key) return 'Generic';
    return TRACK_LABEL[key] ?? key.toUpperCase();
  }

  when(iso: string): string {
    // Local, human. Kept simple rather than pulling a date library into the bundle.
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  statusKind(status: string): 'good' | 'warn' | 'risk' | 'neutral' {
    if (status === 'completed') return 'good';
    if (status === 'failed') return 'risk';
    if (status === 'abandoned') return 'warn';
    return 'neutral';
  }

  // -- downloads ------------------------------------------------------------
  /** One recording, as an attachment saved to the local machine. A plain GET
   *  the browser downloads; `download=1` flips the server's inline default to
   *  attachment. */
  downloadOne(r: RecordRow): void {
    const url =
      `${environment.apiBase}/mentor/students/${r.student_id}` +
      `/interviews/${r.session_id}/audio?track=mixed&download=1`;
    // A hidden anchor rather than window.open: keeps the current tab, and the
    // attachment disposition means the browser saves rather than navigates.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** The selected recordings, bundled into one zip by the server and saved. */
  async downloadSelected(): Promise<void> {
    const ids = [...this.selected()];
    if (ids.length === 0 || this.downloading()) return;
    this.downloading.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/mentor/interviews/audio.zip`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_ids: ids, track: 'mixed' }),
      });
      if (!res.ok) {
        this.error.set(await this.detailOf(res));
        return;
      }
      // Stream the zip to a blob, then hand it to the browser as a save.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'reep-interview-recordings.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.flash.set(`Downloaded ${ids.length} recording${ids.length === 1 ? '' : 's'} as a zip.`);
    } catch {
      this.error.set('The download could not be completed. Nothing was saved.');
    } finally {
      this.downloading.set(false);
    }
  }

  // -- loading --------------------------------------------------------------
  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      const res = await fetch(`${environment.apiBase}/mentor/interviews`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      this.rows.set((await res.json()) as RecordRow[]);
      this.state.set('ready');
    } catch {
      this.error.set('Could not load interview records. Reload the page to try again.');
      this.state.set('error');
    }
  }

  private async detailOf(res: Response): Promise<string> {
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') return body.detail;
    } catch {
      /* fall through */
    }
    return `The request was refused (${res.status}).`;
  }
}
