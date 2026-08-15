/**
 * Student Jobs — v2 port of the `data-p="jobs"` panel in docs/design-v2/student-app.html.
 *
 * Three subtabs over one flat feed:
 *   - Opportunities — the weekly sheet with a UG/PG toggle (filter by
 *     degree_level), a match bar + %, an Apply button and an Applied chip.
 *   - Applications  — the rows the student has applied to.
 *   - Offers        — GET /student/offers, plus a "+ Create Offer" form that
 *     POSTs a self-reported off-platform offer (OfferIn shape from student.py).
 *
 * The right column's three count cards are computed client-side from the two
 * feeds. All markup reuses the global reep-v2 classes; nothing here redefines
 * .card / .dt-table / .chip / .tabs-row / .match-bar.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

type Level = 'UG' | 'PG';
type Subtab = 'opportunities' | 'applications' | 'offers';
type RoleType = 'FULL_TIME' | 'FULL_TIME_PLUS_INTERNSHIP' | 'INTERNSHIP';

/** Row shape of GET /student/jobs (snake_case, verbatim from JobRowOut). */
interface JobRow {
  id: string;
  title: string;
  company: string;
  degree_level: Level;
  location: string | null;
  apply_url: string | null;
  required_skills: string[];
  match_percent: number;
  eligible: boolean;
  reasons: string[];
  applied: boolean;
}

/** Row shape of GET /student/offers (snake_case, verbatim from OfferOut). */
interface Offer {
  id: string;
  role_type: RoleType;
  job_title: string;
  organisation: string;
  channel: string;
  work_mode: string;
  location: string | null;
  ctc_inr: number;
  fixed_gross_inr: number;
  status: string;
}

interface StatusChip {
  cls: 'good' | 'warn' | 'risk';
  icon: string;
  label: string;
}

const ROLE_LABEL: Record<RoleType, string> = {
  FULL_TIME: 'Job',
  FULL_TIME_PLUS_INTERNSHIP: 'Job+Internship',
  INTERNSHIP: 'Internship',
};

const OFFER_STATUS: Record<string, StatusChip> = {
  DRAFT: { cls: 'warn', icon: 'edit', label: 'Draft' },
  PENDING_APPROVAL: { cls: 'warn', icon: 'hourglass_top', label: 'Awaiting approval' },
  APPROVED: { cls: 'good', icon: 'check_circle', label: 'Approved' },
  REJECTED: { cls: 'risk', icon: 'error', label: 'Rejected' },
};

@Component({
  selector: 'app-student-jobs',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './jobs.component.html',
  styleUrl: './jobs.component.scss',
})
export class JobsComponent {
  readonly roleLabel = ROLE_LABEL;

  readonly jobs = signal<JobRow[]>([]);
  readonly offers = signal<Offer[]>([]);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly offersError = signal<string | null>(null);

  readonly subtab = signal<Subtab>('opportunities');
  readonly level = signal<Level>('UG');

  // Create-offer form state.
  readonly formOpen = signal(false);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  form = this.blankForm();

  // --- opportunities (toggle-filtered) ---
  readonly opportunityRows = computed(() =>
    this.jobs().filter((j) => j.degree_level === this.level()),
  );

  // --- applications (all applied rows) ---
  readonly appliedRows = computed(() => this.jobs().filter((j) => j.applied));

  // --- right-column counts, computed client-side ---
  readonly oppCount = computed(() => this.jobs().length);
  readonly eligibleCount = computed(() => this.jobs().filter((j) => j.eligible).length);
  readonly appliedCount = computed(() => this.appliedRows().length);
  readonly offerCount = computed(() => this.offers().length);

  readonly offerBreakdown = computed(() => {
    const o = this.offers();
    const n = (r: RoleType) => o.filter((x) => x.role_type === r).length;
    return `Received: ${n('FULL_TIME')} Job · ${n('FULL_TIME_PLUS_INTERNSHIP')} Job+Internship · ${n('INTERNSHIP')} Internship`;
  });

  readonly appliedBreakdown = computed(() => {
    const rows = this.appliedRows();
    const ug = rows.filter((r) => r.degree_level === 'UG').length;
    const pg = rows.filter((r) => r.degree_level === 'PG').length;
    return `Applied to: ${ug} undergraduate · ${pg} postgraduate`;
  });

  constructor() {
    void this.loadJobs();
    void this.loadOffers();
  }

  private async loadJobs(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/jobs`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load the jobs board.');
        return;
      }
      this.jobs.set((await res.json()) as JobRow[]);
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadOffers(): Promise<void> {
    this.offersError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/offers`, { credentials: 'include' });
      if (!res.ok) {
        this.offersError.set('Could not load your offers.');
        return;
      }
      this.offers.set((await res.json()) as Offer[]);
    } catch {
      this.offersError.set('Could not reach the server.');
    }
  }

  setSubtab(s: Subtab): void {
    this.subtab.set(s);
  }

  setLevel(l: Level): void {
    this.level.set(l);
  }

  offerStatus(status: string): StatusChip {
    return OFFER_STATUS[status] ?? { cls: 'warn', icon: 'help', label: status };
  }

  /** Record the application; optimistically flip the row's Applied chip. */
  async apply(row: JobRow): Promise<void> {
    if (row.applied) return;
    this.jobs.update((rows) => rows.map((r) => (r.id === row.id ? { ...r, applied: true } : r)));
    try {
      const res = await fetch(`${environment.apiBase}/student/jobs/${row.id}/apply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applied: true }),
      });
      if (!res.ok) throw new Error();
    } catch {
      // revert on failure
      this.jobs.update((rows) => rows.map((r) => (r.id === row.id ? { ...r, applied: false } : r)));
    }
  }

  // --- create offer ---
  private blankForm() {
    return {
      role_type: 'FULL_TIME' as RoleType,
      job_title: '',
      organisation: '',
      channel: 'ON_CAMPUS',
      work_mode: 'ONSITE',
      location: '',
      ctc_inr: 0,
      fixed_gross_inr: 0,
    };
  }

  openOfferForm(): void {
    this.form = this.blankForm();
    this.formError.set(null);
    this.formOpen.set(true);
    this.subtab.set('offers');
  }

  closeOfferForm(): void {
    this.formOpen.set(false);
  }

  async createOffer(): Promise<void> {
    this.formError.set(null);
    if (!this.form.job_title.trim() || !this.form.organisation.trim()) {
      this.formError.set('A role and company are required.');
      return;
    }
    this.saving.set(true);
    try {
      const res = await fetch(`${environment.apiBase}/student/offers`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role_type: this.form.role_type,
          job_title: this.form.job_title.trim(),
          organisation: this.form.organisation.trim(),
          channel: this.form.channel,
          work_mode: this.form.work_mode,
          location: this.form.location.trim() || null,
          ctc_inr: Number(this.form.ctc_inr) || 0,
          fixed_gross_inr: Number(this.form.fixed_gross_inr) || 0,
        }),
      });
      if (!res.ok) {
        const detail = ((await res.json().catch(() => ({}))) as { detail?: string }).detail;
        this.formError.set(detail ?? 'Could not save the offer.');
        return;
      }
      this.formOpen.set(false);
      await this.loadOffers();
    } catch {
      this.formError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }
}
