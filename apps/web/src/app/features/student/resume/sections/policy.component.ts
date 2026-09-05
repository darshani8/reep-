/**
 * Resume Builder — "Placement Policy" section (data-p="policy").
 *
 * Editable slice `data.policy`:
 *   { accepted_at: ISO | null, eligible:true, interested_jobs:'', interested_internships:'' }
 *
 * Two halves. The POLICY itself — the four terms every placement season runs
 * on — with the student's acceptance recorded as a timestamp, so "Accepted on
 * 14 Jul 2026" is a fact about a date rather than a checkbox that was once
 * ticked; a fresh acceptance is asked for at the start of every season. Then the
 * eligibility radio and the two interest selects, which govern the postings the
 * student appears against. Reads via section('policy', …) and writes the whole
 * object back with patch('policy', …) on every change. Markup reuses the global
 * reep-v2 classes (.card / .field / .radio-row / .notice); nothing is redefined.
 */

import { Component, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ResumeBuilderService } from '../resume-builder.service';

interface PolicyModel {
  accepted_at: string | null;
  eligible: boolean;
  interested_jobs: string;
  interested_internships: string;
}

/** The placement policy, as the placement cell states it. */
const POLICY_TERMS: string[] = [
  'One offer per student. Once an offer is accepted, you are withdrawn from all further processes.',
  'Interviews and tests are mandatory once shortlisted. Two unexplained absences pause your eligibility for the season.',
  'Your profile and marks are shared with recruiters exactly as recorded by the university.',
  'Any misrepresentation of marks, experience or certifications removes you from the placement process.',
];

@Component({
  selector: 'rb-policy',
  standalone: true,
  imports: [FormsModule],
  styles: [
    `
      /* small "why it matters" pill on placement-critical fields */
      .reqp {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: none;
        color: var(--brand-purple);
        background: rgba(138, 90, 30, 0.1);
        padding: 2px 6px;
        border-radius: 5px;
        margin-left: 6px;
        white-space: nowrap;
      }
      .accept-note {
        background: var(--good-bg);
        color: var(--good);
        margin-bottom: 14px;
      }
      .accept-row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 14px;
        background: var(--tint-2);
        border: 1px solid var(--hairline);
        font-size: 13.5px;
        color: var(--ink);
        cursor: pointer;
        margin-bottom: 14px;
      }
      .accept-row input {
        width: 17px;
        height: 17px;
        accent-color: var(--purple-mid);
        margin-top: 1px;
        flex: none;
      }
      .terms {
        display: flex;
        flex-direction: column;
        gap: 11px;
        font-size: 13.5px;
        line-height: 1.55;
        color: var(--ink);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .terms li {
        padding-left: 14px;
        position: relative;
      }
      .terms li::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0.62em;
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--purple-mid);
      }
    `,
  ],
  template: `
    <div class="card">
      <h3>Placement policy</h3>
      <div class="desc">
        The terms every placement season runs on. Accepting them is what puts you in front of
        recruiters.
      </div>

      @if (acceptedOn(); as on) {
        <div class="notice accept-note">
          <span class="icon">verified</span>
          <div>
            <b>Accepted on {{ on }}.</b> A fresh acceptance is required at the start of every
            placement season.
          </div>
        </div>
      } @else {
        <label class="accept-row">
          <input type="checkbox" [checked]="false" (change)="accept($any($event.target).checked)" />
          <span>
            <b>I have read and accept the placement policy for this season.</b>
            The date of your acceptance is recorded with your placement profile.
          </span>
        </label>
      }

      <ul class="terms">
        @for (t of terms; track t) {
          <li>{{ t }}</li>
        }
      </ul>
    </div>

    <div class="card">
      <h3>Placement preferences</h3>
      <div class="desc">This governs which opportunities you appear against on the Jobs page.</div>

      <div class="field">
        <label
          >Eligible for placements <span class="reqp">Required for placement profile</span></label
        >
        <div class="radio-row">
          <label>
            <input
              type="radio"
              name="elig"
              [value]="true"
              [ngModel]="model.eligible"
              (ngModelChange)="model.eligible = $event; push()"
            />
            Yes
          </label>
          <label>
            <input
              type="radio"
              name="elig"
              [value]="false"
              [ngModel]="model.eligible"
              (ngModelChange)="model.eligible = $event; push()"
            />
            No
          </label>
        </div>
      </div>

      <div class="grid2" style="margin-top:6px;">
        <div class="field">
          <label
            >Interested in jobs <span class="req">*</span
            ><span class="reqp">Required for placement profile</span></label
          >
          <select
            class="ctrl"
            [ngModel]="model.interested_jobs"
            (ngModelChange)="model.interested_jobs = $event; push()"
          >
            <option value="">Select</option>
            <option value="Yes — full-time roles">Yes — full-time roles</option>
            <option value="No">No</option>
          </select>
        </div>
        <div class="field">
          <label
            >Interested in internships <span class="req">*</span
            ><span class="reqp">Required for placement profile</span></label
          >
          <select
            class="ctrl"
            [ngModel]="model.interested_internships"
            (ngModelChange)="model.interested_internships = $event; push()"
          >
            <option value="">Select</option>
            <option value="Yes — internships">Yes — internships</option>
            <option value="No">No</option>
          </select>
        </div>
      </div>

      <div class="notice info" style="margin:6px 0 0;">
        <span class="icon">visibility</span>
        <div>
          Setting <b>Eligible for placements: No</b> removes you from all recruiter shortlists
          immediately. Your mentor is notified so it can be discussed rather than discovered later.
        </div>
      </div>
    </div>
  `,
})
export class RbPolicyComponent {
  private readonly svc = inject(ResumeBuilderService);

  readonly terms = POLICY_TERMS;

  model: PolicyModel = {
    accepted_at: null,
    eligible: true,
    interested_jobs: '',
    interested_internships: '',
  };

  private seeded = this.svc.loaded();

  constructor() {
    this.seed();
    effect(() => {
      if (this.svc.loaded() && !this.seeded) {
        this.seeded = true;
        this.seed();
      }
    });
  }

  /** "14 Jul 2026", or null when the policy has not been accepted. */
  acceptedOn(): string | null {
    const iso = this.model.accepted_at;
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  accept(checked: boolean): void {
    if (!checked) return;
    this.model.accepted_at = new Date().toISOString();
    this.push();
  }

  private seed(): void {
    const s = (this.svc.section('policy', {}) ?? {}) as Partial<PolicyModel>;
    this.model = {
      accepted_at: typeof s.accepted_at === 'string' ? s.accepted_at : null,
      eligible: s.eligible ?? true,
      interested_jobs: s.interested_jobs ?? '',
      interested_internships: s.interested_internships ?? '',
    };
  }

  push(): void {
    this.svc.patch('policy', this.model);
  }
}
