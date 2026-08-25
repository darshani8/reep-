/**
 * Faculty Upskilling — a staff member's own completed-course certificates.
 *
 * Mirrors the student uploads screen at a smaller size: pick a file (PDF/PNG/
 * JPEG, sniffed server-side, 10 MB), optionally name the course, provider and
 * completion date, and it lands on your shelf — no review workflow, because a
 * staff member's certificate is their own record, not evidence awaiting a
 * verdict. Rows offer View (GET /staff/upskilling/{id}/file) and Remove.
 */

import { Component, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface CertRow {
  id: string;
  title: string;
  provider: string | null;
  completed_on: string | null;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
}

const MAX_BYTES = 10 * 1024 * 1024; // matches the server cap

@Component({
  selector: 'app-mentor-upskilling',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './upskilling.component.html',
})
export class UpskillingComponent {
  readonly apiBase = environment.apiBase;

  readonly rows = signal<CertRow[] | null>(null);
  readonly error = signal<string | null>(null);

  // Form fields describing the next uploaded certificate.
  title = '';
  provider = '';
  completedOn = '';

  readonly uploading = signal(false);
  readonly uploadError = signal<string | null>(null);
  readonly justUploaded = signal<CertRow | null>(null);

  readonly removingId = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/staff/upskilling`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your certificates.');
        return;
      }
      this.rows.set((await res.json()) as CertRow[]);
      this.error.set(null);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.upload(file);
    input.value = '';
  }

  private async upload(file: File): Promise<void> {
    this.uploadError.set(null);
    this.actionError.set(null);
    this.justUploaded.set(null);
    if (file.size > MAX_BYTES) {
      this.uploadError.set('That file is over 10 MB. Please upload a smaller PDF, PNG or JPEG.');
      return;
    }
    this.uploading.set(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('title', this.title.trim() || file.name);
      form.append('provider', this.provider.trim());
      // Omitted entirely when blank — FastAPI parses `completed_on` as a date
      // and an empty string would 422 instead of meaning "not given".
      if (this.completedOn) form.append('completed_on', this.completedOn);
      const res = await fetch(`${this.apiBase}/staff/upskilling`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.uploadError.set(
          detail?.detail ?? 'Upload failed. Only PDF, PNG or JPEG up to 10 MB are accepted.',
        );
        return;
      }
      this.justUploaded.set((await res.json()) as CertRow);
      this.title = '';
      this.provider = '';
      this.completedOn = '';
      await this.load();
    } catch {
      this.uploadError.set('Could not reach the server.');
    } finally {
      this.uploading.set(false);
    }
  }

  async remove(row: CertRow): Promise<void> {
    const ok = window.confirm(`Remove "${row.title}"? This permanently deletes the certificate.`);
    if (!ok) return;
    this.actionError.set(null);
    this.removingId.set(row.id);
    try {
      const res = await fetch(`${this.apiBase}/staff/upskilling/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 404) {
        this.actionError.set('Could not remove that certificate. Please try again.');
        return;
      }
      if (this.justUploaded()?.id === row.id) this.justUploaded.set(null);
      await this.load();
    } catch {
      this.actionError.set('Could not reach the server.');
    } finally {
      this.removingId.set(null);
    }
  }

  fileUrl(id: string): string {
    return `${this.apiBase}/staff/upskilling/${id}/file`;
  }

  formatSize(bytes: number): string {
    const b = bytes || 0;
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
}
