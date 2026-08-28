/**
 * Programme sign-up — the pre-login registration frame (the mockup's `.reg-frame`
 * block, not a shell `.panel`). Public: the applicant is not a user yet, so this
 * renders on its own route (`/register`) with no auth guard and no app shell.
 *
 * The form POSTs to the FastAPI `POST /register`
 * (apps/api-py/app/api/account/registration.py). That endpoint runs the
 * data-driven rule engine and answers
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
  created_at: string;
}

@Component({
  selector: 'app-registration',
  standalone: true,
  imports: [FormsModule, RouterLink],
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
      this.result.set((await res.json()) as RegistrationResult);
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
    this.error.set(null);
  }
}
