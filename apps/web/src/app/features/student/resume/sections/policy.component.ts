/**
 * Resume Builder — "Placement Policy" section (data-p="policy").
 *
 * Editable slice `data.policy`:
 *   { eligible:true, interested_jobs:'', interested_internships:'' }
 *
 * A Yes/No eligibility radio plus two interest selects and the info notice.
 * Reads via section('policy', …) and writes the whole object back with
 * patch('policy', …) on every change. Markup reuses the global reep-v2 classes
 * (.card / .field / .radio-row / .notice); nothing is redefined here.
 */

import { Component, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ResumeBuilderService } from '../resume-builder.service';

interface PolicyModel {
  eligible: boolean;
  interested_jobs: string;
  interested_internships: string;
}

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
    `,
  ],
  template: `
    <div class="card">
      <h3>Placement policy</h3>
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

  model: PolicyModel = { eligible: true, interested_jobs: '', interested_internships: '' };

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

  private seed(): void {
    const s = (this.svc.section('policy', {}) ?? {}) as Partial<PolicyModel>;
    this.model = {
      eligible: s.eligible ?? true,
      interested_jobs: s.interested_jobs ?? '',
      interested_internships: s.interested_internships ?? '',
    };
  }

  push(): void {
    this.svc.patch('policy', this.model);
  }
}
