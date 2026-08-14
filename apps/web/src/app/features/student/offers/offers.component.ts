/**
 * My Offers — the student side of the candidacy loop (roadmap Phase A).
 *
 * Lists the student's placement offers and captures a new one with the fields a
 * placement report needs — role, organisation, compensation, documents. A draft
 * is editable; Submit routes it to a director and locks it (the backend refuses
 * edits after, so a report never reads a figure changed post-approval). Ported
 * field-for-field from the pod.ai offer form decoded in docs/pod-ai-decode.md.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';
import { PageIntroComponent, SectionComponent, EmptyComponent } from '../../../shared/kit/kit.components';

type RoleType = 'FULL_TIME' | 'FULL_TIME_PLUS_INTERNSHIP' | 'INTERNSHIP';
type WorkMode = 'REMOTE' | 'ONSITE' | 'HYBRID';
type Channel = 'ON_CAMPUS' | 'OFF_CAMPUS' | 'POOL' | 'REFERRAL';
type Status = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

interface Bonus { label: string; amountInr: number }
interface Offer {
  id: string;
  roleType: RoleType;
  jobTitle: string;
  organisation: string;
  channel: Channel;
  joiningDate: string | null;
  workMode: WorkMode;
  location: string | null;
  ctcInr: number;
  fixedGrossInr: number;
  bonuses: Bonus[];
  jobDescription: string | null;
  bondDetails: string | null;
  otherBenefits: string | null;
  status: Status;
  decisionNote: string | null;
  createdAt: string;
}

const ROLE_LABEL: Record<RoleType, string> = {
  FULL_TIME: 'Full-time job',
  FULL_TIME_PLUS_INTERNSHIP: 'Job + internship',
  INTERNSHIP: 'Internship',
};
const STATUS_LABEL: Record<Status, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

@Component({
  selector: 'app-student-offers',
  standalone: true,
  imports: [FormsModule, PageIntroComponent, SectionComponent, EmptyComponent],
  templateUrl: './offers.component.html',
  styleUrl: './offers.component.scss',
})
export class OffersComponent {
  readonly roleLabel = ROLE_LABEL;
  readonly statusLabel = STATUS_LABEL;
  readonly roles: RoleType[] = ['FULL_TIME', 'FULL_TIME_PLUS_INTERNSHIP', 'INTERNSHIP'];
  readonly workModes: WorkMode[] = ['ONSITE', 'REMOTE', 'HYBRID'];
  readonly channels: Channel[] = ['ON_CAMPUS', 'OFF_CAMPUS', 'POOL', 'REFERRAL'];

  readonly offers = signal<Offer[]>([]);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly formOpen = signal(false);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  // form model (create a new draft)
  form = this.blankForm();

  readonly totalOffers = computed(() => this.offers().length);

  constructor() {
    void this.load();
  }

  private blankForm() {
    return {
      roleType: 'FULL_TIME' as RoleType,
      jobTitle: '',
      organisation: '',
      channel: 'ON_CAMPUS' as Channel,
      workMode: 'ONSITE' as WorkMode,
      location: '',
      joiningDate: '',
      ctcInr: 0,
      fixedGrossInr: 0,
      bonuses: [] as Bonus[],
      jobDescription: '',
      bondDetails: '',
      otherBenefits: '',
    };
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/offers`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your offers.');
        return;
      }
      this.offers.set((await res.json()) as Offer[]);
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  openForm(): void {
    this.form = this.blankForm();
    this.formError.set(null);
    this.formOpen.set(true);
  }
  closeForm(): void {
    this.formOpen.set(false);
  }

  addBonus(): void {
    this.form.bonuses = [...this.form.bonuses, { label: '', amountInr: 0 }];
  }
  removeBonus(i: number): void {
    this.form.bonuses = this.form.bonuses.filter((_, idx) => idx !== i);
  }

  lpa(inr: number): string {
    return inr > 0 ? `₹${(inr / 100000).toFixed(2)} LPA` : '—';
  }

  async saveDraft(submit: boolean): Promise<void> {
    this.formError.set(null);
    if (!this.form.jobTitle.trim() || !this.form.organisation.trim()) {
      this.formError.set('A job title and organisation are required.');
      return;
    }
    this.saving.set(true);
    try {
      const res = await fetch(`${environment.apiBase}/student/offers`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...this.form,
          location: this.form.location || null,
          joiningDate: this.form.joiningDate || null,
          bonuses: this.form.bonuses.filter((b) => b.label.trim()),
        }),
      });
      if (!res.ok) {
        this.formError.set(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Could not save.');
        return;
      }
      const created = (await res.json()) as Offer;
      if (submit) {
        await fetch(`${environment.apiBase}/student/offers/${created.id}/submit`, {
          method: 'POST',
          credentials: 'include',
        });
      }
      this.formOpen.set(false);
      await this.load();
    } finally {
      this.saving.set(false);
    }
  }

  async submitOffer(id: string): Promise<void> {
    await fetch(`${environment.apiBase}/student/offers/${id}/submit`, {
      method: 'POST',
      credentials: 'include',
    });
    await this.load();
  }
}
