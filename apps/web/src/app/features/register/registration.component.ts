/**
 * Programme sign-up — the pre-login registration frame (the mockup's `.reg-frame`
 * block, not a shell `.panel`). Public: the applicant is not a user yet, so this
 * renders on its own route (`/register`) with no auth guard and no app shell.
 *
 * The form POSTs to the FastAPI `POST /register` (apps/api-py/app/routers/
 * registration.py). That endpoint runs the data-driven rule engine and answers
 * with a `status`: AUTO_APPROVED (a rule waved it through) or PENDING_REVIEW
 * (routed to a director, or no rule matched). We surface that verdict through the
 * global `.reg-approval` ok / flag banner and, on success, offer a link to
 * `/login`.
 *
 * Only the fields the endpoint accepts are sent (name, email, usn, phone,
 * degree_level). Personal email, LinkedIn and the CV / photo dropzones are on the
 * form for completeness but are placeholders the backend does not yet take.
 */

import { Component, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';

type DegreeLevel = 'UG' | 'PG';

/** Snake_case exactly as `RegistrationOut` returns it. */
interface RegistrationResult {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  degree_level: string;
  status: string; // AUTO_APPROVED | PENDING_REVIEW | APPROVED | REJECTED
  cohort_id: string | null;
  matched_rule_id: string | null;
  decision_reason: string | null;
  reviewed_by_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  approved_student_id: string | null;
  /// Kinds attached so far: "CV", "PHOTO". Filled by the uploads after the 201.
  documents: string[];
  created_at: string;
}

@Component({
  selector: 'app-registration',
  standalone: true,
  imports: [FormsModule, RouterLink, DecimalPipe],
  templateUrl: './registration.component.html',
  styleUrl: './registration.component.scss',
})
export class RegistrationComponent {
  // --- form model (two-way bound; only some of these reach the API) ---
  fullName = '';
  usn = '';
  collegeEmail = '';
  personalEmail = '';
  phone = '';
  linkedin = '';
  degreeLevel: DegreeLevel = 'PG';

  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<RegistrationResult | null>(null);

  /// Files staged on the form. Uploaded AFTER the application is created — the
  /// upload endpoint is keyed on the application id, which does not exist until
  /// the 201 — so a picked file is held here until then.
  readonly cvFile = signal<File | null>(null);
  readonly photoFile = signal<File | null>(null);
  /// What happened to each attachment, shown on the result card. The
  /// application itself is already in; a failed attachment is a warning, not a
  /// reason to make the applicant start over.
  readonly docNotes = signal<string[]>([]);

  onCv(ev: Event): void {
    this.cvFile.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  onPhoto(ev: Event): void {
    this.photoFile.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  /// Auto-approved is the only "account is active immediately" branch; every
  /// other terminal state on submission is a human-review hold.
  readonly approved = computed(() => this.result()?.status === 'AUTO_APPROVED');

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;

    this.error.set(null);
    if (!this.fullName.trim() || !this.collegeEmail.trim()) {
      this.error.set('Your full name and college email are both required.');
      return;
    }

    this.pending.set(true);
    try {
      const res = await fetch(`${environment.apiBase}/register`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: this.fullName.trim(),
          email: this.collegeEmail.trim(),
          usn: this.usn.trim() || null,
          phone: this.phone.trim() || null,
          degree_level: this.degreeLevel,
        }),
      });
      if (!res.ok) {
        this.error.set(await this.detailOf(res));
        return;
      }
      const created = (await res.json()) as RegistrationResult;
      // Attach what was picked, one request per file, each reporting for
      // itself. The application is already created whatever happens here.
      const notes: string[] = [];
      for (const [kind, file, label] of [
        ['cv', this.cvFile(), 'CV'],
        ['photo', this.photoFile(), 'photo'],
      ] as const) {
        if (!file) continue;
        const fd = new FormData();
        fd.append('file', file, file.name);
        const up = await fetch(`${environment.apiBase}/register/${created.id}/documents/${kind}`, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });
        if (up.ok) {
          const updated = (await up.json()) as RegistrationResult;
          created.documents = updated.documents;
          notes.push(`${label} attached.`);
        } else {
          notes.push(`${label} could not be attached: ${await this.detailOf(up)}`);
        }
      }
      this.docNotes.set(notes);
      this.result.set(created);
    } catch {
      this.error.set('Could not reach the registration service. Is the API running on :3300?');
    } finally {
      this.pending.set(false);
    }
  }

  /// FastAPI puts the human-readable message on `detail`; fall back per status.
  private async detailOf(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') return body.detail;
    } catch {
      /* no JSON body — fall through to the status-based message */
    }
    if (res.status === 409) return 'An application with this email already exists.';
    if (res.status === 422) return 'Please check the form — some details are not valid.';
    return 'Something went wrong submitting your registration. Please try again.';
  }

  /// Start over after a hold so a mistyped email can be corrected in place.
  reset(): void {
    this.result.set(null);
    this.cvFile.set(null);
    this.photoFile.set(null);
    this.docNotes.set([]);
    this.error.set(null);
  }
}
