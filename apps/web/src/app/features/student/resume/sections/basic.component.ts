/**
 * Resume Builder — "Basic Details" section (stepper key `basic`).
 *
 * Editable demographics live in the shared profile map under `data.basic`
 * ({ middle_name, gender, dob, blood_group, marital_status, languages[],
 * dream_company, medical_history }). Identity fields the university owns — USN,
 * first/last name, course, specialization — are rendered LOCKED: the name comes
 * from the signed-in session (AuthService) and the USN is read best-effort from
 * GET /student/dashboard, mirroring student/profile.component.ts. Course and
 * specialization have no client-visible source yet, so they show as locked and
 * empty rather than inventing a value.
 *
 * The component owns a local model `m`, seeded from svc.section('basic', …) and
 * re-hydrated once svc.load() resolves; every edit writes the whole slice back
 * with svc.patch('basic', …). It never fetches or PUTs resume-profile itself.
 */

import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '../../../../core/auth.service';
import { environment } from '../../../../../environments/environment';
import { ResumeBuilderService } from '../resume-builder.service';

interface BasicData {
  middle_name: string;
  gender: string;
  dob: string;
  blood_group: string;
  marital_status: string;
  languages: string[];
  dream_company: string;
  medical_history: string;
  photo_upload_id: string;
}

@Component({
  selector: 'rb-basic',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './basic.component.html',
  styles: [
    `
      .dropzone--action {
        display: block;
        width: 100%;
        cursor: pointer;
        font-family: var(--font);
      }
      .dropzone--action:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .photo-preview {
        display: block;
        width: 120px;
        height: 120px;
        object-fit: cover;
        border-radius: 10px;
        border: 1px solid var(--line);
        margin-bottom: 8px;
      }
      .photo-err {
        display: block;
        color: var(--risk);
        margin-top: 6px;
      }
    `,
  ],
})
export class RbBasicComponent {
  private readonly svc = inject(ResumeBuilderService);
  private readonly auth = inject(AuthService);

  /** Locked identity, synced from the student record (best-effort). */
  readonly usn = signal<string>('');
  readonly firstName = computed(() => this.splitName().first);
  readonly lastName = computed(() => this.splitName().last);

  /** Draft text in the languages tag input (not persisted until Enter). */
  langDraft = '';

  /** Local, editable copy of the `basic` slice. */
  m: BasicData = this.normalize(this.svc.section('basic', {}));

  private hydrated = false;

  constructor() {
    // Re-seed from the server once the shell's load() has populated the map.
    effect(() => {
      if (this.svc.loaded() && !this.hydrated) {
        this.hydrated = true;
        this.m = untracked(() => this.normalize(this.svc.section('basic', {})));
        this.photoId.set(this.m.photo_upload_id);
      }
    });
    this.photoId.set(this.m.photo_upload_id);
    void this.loadIdentity();
  }

  /** Coerce an opaque stored slice into a fully-populated model. */
  private normalize(raw: Partial<BasicData>): BasicData {
    return {
      middle_name: raw.middle_name ?? '',
      gender: raw.gender ?? '',
      dob: raw.dob ?? '',
      blood_group: raw.blood_group ?? '',
      marital_status: raw.marital_status ?? '',
      languages: Array.isArray(raw.languages) ? [...raw.languages] : [],
      dream_company: raw.dream_company ?? '',
      medical_history: raw.medical_history ?? '',
      photo_upload_id: raw.photo_upload_id ?? '',
    };
  }

  // --- profile photo upload ---
  readonly uploadingPhoto = signal(false);
  readonly photoError = signal<string | null>(null);

  /** URL to preview the stored photo, or null when none is set. */
  readonly photoUrl = computed(() =>
    this.photoId()
      ? `${environment.apiBase}/student/uploads/${this.photoId()}/file`
      : null,
  );
  /** Signal mirror of m.photo_upload_id so photoUrl recomputes after upload. */
  private readonly photoId = signal<string>('');

  async onPhotoFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploadingPhoto.set(true);
    this.photoError.set(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', 'PROFILE_PHOTO');
      form.append('title', 'Profile photo');
      const res = await fetch(`${environment.apiBase}/student/uploads`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.photoError.set(d?.detail ?? 'Photo upload failed — use a PNG or JPEG under 10 MB.');
        return;
      }
      const id = (await res.json()).id as string;
      this.m.photo_upload_id = id;
      this.photoId.set(id);
      this.push(); // persist the pointer in the resume profile
    } catch {
      this.photoError.set('Could not reach the server.');
    } finally {
      this.uploadingPhoto.set(false);
      input.value = '';
    }
  }

  /** Flush the whole slice back to the shared map (deep-cloned, plain data). */
  push(): void {
    this.svc.patch('basic', JSON.parse(JSON.stringify(this.m)));
  }

  // --- languages tag input ---
  addLanguage(ev: Event): void {
    ev.preventDefault();
    const v = this.langDraft.trim();
    this.langDraft = '';
    if (!v || this.m.languages.includes(v)) return;
    this.m.languages = [...this.m.languages, v];
    this.push();
  }

  removeLanguage(i: number): void {
    this.m.languages = this.m.languages.filter((_, idx) => idx !== i);
    this.push();
  }

  // --- locked identity ---
  private splitName(): { first: string; last: string } {
    const name = (this.auth.session()?.name ?? '').trim();
    if (!name) return { first: '', last: '' };
    const parts = name.split(/\s+/);
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  private async loadIdentity(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/dashboard`, {
        credentials: 'include',
      });
      if (res.ok) {
        const d = (await res.json()) as { usn?: string | null };
        this.usn.set(d.usn ?? '');
      }
    } catch {
      // Best-effort: the locked field simply stays blank.
    }
  }
}
