/**
 * Alumni Profile — the first screen an alumnus lands on after sign-in.
 *
 * GET /alumni/profile answers `created: false` until they have saved a profile,
 * and that flag (never a falsy company string) is what switches this screen
 * between the FIRST-LOGIN SETUP FORM — current company + current resume, both
 * required to create — and the profile view with an Edit toggle. Saving POSTs
 * one multipart form; on update the resume is optional and omitting it keeps
 * the one on file.
 */

import { Component, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface ResumeMeta {
  original_name: string;
  mime_type: string;
  size_bytes: number;
}

interface AlumniProfileOut {
  created: boolean;
  name: string;
  email: string;
  company: string | null;
  designation: string | null;
  joined_on: string | null;
  graduation_year: number | null;
  resume: ResumeMeta | null;
  updated_at: string | null;
}

const MAX_BYTES = 10 * 1024 * 1024; // matches the server cap

@Component({
  selector: 'app-alumni-profile',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './alumni-profile.component.html',
})
export class AlumniProfileComponent {
  readonly apiBase = environment.apiBase;

  /** null while the first GET is in flight. */
  readonly profile = signal<AlumniProfileOut | null>(null);
  readonly error = signal<string | null>(null);

  /** true when the setup/edit form is showing (always true before creation). */
  readonly editing = signal(false);

  // Form fields.
  company = '';
  designation = '';
  /** ISO yyyy-MM-dd, which is what <input type="date"> reads and writes. */
  joinedOn = '';
  graduationYear = '';
  pickedFile: File | null = null;

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly savedFlash = signal(false);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/alumni/profile`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your profile.');
        return;
      }
      const prof = (await res.json()) as AlumniProfileOut;
      this.profile.set(prof);
      this.error.set(null);
      if (!prof.created) {
        this.editing.set(true);
      } else {
        this.company = prof.company ?? '';
        this.designation = prof.designation ?? '';
        this.joinedOn = prof.joined_on ?? '';
        this.graduationYear = prof.graduation_year ? String(prof.graduation_year) : '';
      }
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  startEdit(): void {
    this.saveError.set(null);
    this.pickedFile = null;
    this.editing.set(true);
  }

  cancelEdit(): void {
    const prof = this.profile();
    if (!prof?.created) return; // nothing to fall back to before creation
    this.company = prof.company ?? '';
    this.designation = prof.designation ?? '';
    this.joinedOn = prof.joined_on ?? '';
    this.graduationYear = prof.graduation_year ? String(prof.graduation_year) : '';
    this.pickedFile = null;
    this.saveError.set(null);
    this.editing.set(false);
  }

  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (file && file.size > MAX_BYTES) {
      this.saveError.set('That file is over 10 MB. Please upload a smaller PDF.');
      input.value = '';
      return;
    }
    this.saveError.set(null);
    this.pickedFile = file;
  }

  async save(): Promise<void> {
    this.saveError.set(null);
    const company = this.company.trim();
    if (!company) {
      this.saveError.set('Tell us the company you currently work in.');
      return;
    }
    const isFirstSave = !this.profile()?.created;
    if (isFirstSave && !this.pickedFile) {
      this.saveError.set('Upload your current resume to create your profile.');
      return;
    }
    const year = this.graduationYear.trim();
    if (year && !/^\d{4}$/.test(year)) {
      this.saveError.set('Graduation year should be a four-digit year.');
      return;
    }

    this.saving.set(true);
    try {
      const form = new FormData();
      form.append('company', company);
      form.append('designation', this.designation.trim());
      form.append('joined_on', this.joinedOn);
      // Omitted when blank — the server parses it as an int and an empty
      // string would 422 instead of meaning "not given".
      if (year) form.append('graduation_year', year);
      if (this.pickedFile) form.append('resume', this.pickedFile);
      const res = await fetch(`${this.apiBase}/alumni/profile`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.saveError.set(detail?.detail ?? 'Could not save your profile.');
        return;
      }
      this.profile.set((await res.json()) as AlumniProfileOut);
      this.pickedFile = null;
      this.editing.set(false);
      this.savedFlash.set(true);
      setTimeout(() => this.savedFlash.set(false), 2500);
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  resumeUrl(): string {
    return `${this.apiBase}/alumni/profile/resume`;
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
