/**
 * Student uploads — the Angular port of the `data-p="uploads"` mockup panel.
 *
 * The mockup shows a dropzone and nothing else. Binary upload is not built on
 * the server yet (there is no POST /student/uploads — only the read), so the
 * dropzone stays a labelled placeholder and the real content is the table of
 * documents already on the student's record, wired to GET /student/uploads.
 *
 * Data shaping (status -> chip tone, byte size -> human label, enum -> words)
 * is done here so the template renders ready cells. Fields are the snake_case
 * ones the FastAPI UploadRowOut returns verbatim.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { environment } from '../../../../environments/environment';

interface UploadRow {
  id: string;
  kind: string;
  cert_code: string | null;
  title: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
  uploaded_at: string;
}

const KIND_LABEL: Record<string, string> = {
  CERTIFICATE_PROOF: 'Certificate proof',
  RESUME: 'Resume',
  PROFILE_PHOTO: 'Profile photo',
};

interface StatusMeta {
  label: string;
  tone: 'good' | 'warn' | 'risk';
  icon: string;
}

const STATUS: Record<string, StatusMeta> = {
  PENDING_REVIEW: { label: 'Pending review', tone: 'warn', icon: 'hourglass_top' },
  VERIFIED: { label: 'Verified', tone: 'good', icon: 'verified' },
  REJECTED: { label: 'Rejected', tone: 'risk', icon: 'error' },
};

@Component({
  selector: 'app-student-uploads',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './uploads.component.html',
  styleUrl: './uploads.component.scss',
})
export class UploadsComponent {
  /** null while loading; an array (possibly empty) once the fetch resolves. */
  readonly rows = signal<UploadRow[] | null>(null);
  readonly error = signal<string | null>(null);

  /** The kind the next picked file is uploaded as, and the upload's state. */
  readonly kind = signal<string>('DOCUMENT');
  readonly uploading = signal(false);
  readonly uploadError = signal<string | null>(null);

  readonly verifiedCount = computed(
    () => this.rows()?.filter((u) => u.status === 'VERIFIED').length ?? 0,
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/uploads`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your uploads.');
        return;
      }
      this.rows.set((await res.json()) as UploadRow[]);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  setKind(kind: string): void {
    this.kind.set(kind);
  }

  /// POST the picked file as multipart; the server sniffs the type and stores it.
  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading.set(true);
    this.uploadError.set(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', this.kind());
      form.append('title', file.name);
      const res = await fetch(`${environment.apiBase}/student/uploads`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.uploadError.set(detail?.detail ?? 'Upload failed. Only PDF, PNG or JPEG up to 10 MB.');
        return;
      }
      await this.load(); // reflect the new PENDING_REVIEW row
    } catch {
      this.uploadError.set('Could not reach the server.');
    } finally {
      this.uploading.set(false);
      input.value = ''; // allow re-picking the same file
    }
  }

  kindLabel(kind: string): string {
    return KIND_LABEL[kind] ?? this.humanize(kind);
  }

  statusLabel(status: string): string {
    return STATUS[status]?.label ?? this.humanize(status);
  }

  statusTone(status: string): string {
    return STATUS[status]?.tone ?? '';
  }

  statusIcon(status: string): string {
    return STATUS[status]?.icon ?? 'help';
  }

  /// Bytes -> "820 B" / "12.4 KB" / "1.4 MB", one decimal only under 10.
  formatSize(bytes: number): string {
    const b = bytes || 0;
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  private humanize(value: string): string {
    if (!value) return value;
    return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
  }
}
