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
}

@Component({
  selector: 'rb-basic',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './basic.component.html',
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
      }
    });
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
    };
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
