/**
 * Student Jobs — eligibility + application-guidance rework.
 *
 * Three subtabs over the enriched GET /student/jobs feed:
 *   - Opportunities — rich cards (not table rows): title + company, location,
 *     deadline (from closes_on, coloured as it nears / closed), a match-% bar,
 *     the eligibility verdict WITH its reasons, an application-status chip and a
 *     single primary CTA (Apply -> opens apply_url + POST /jobs/{id}/apply, or
 *     "Applied ✓"). A compact client-side filter row (eligibility / location /
 *     deadline) narrows the fetched list. A "Build your CV" callout links to the
 *     Resume Builder. A UG/PG degree toggle sits above the cards.
 *   - Applications — the rows the student has applied to.
 *   - Offers       — GET /student/offers, plus a "+ Create Offer" form that
 *     POSTs a self-reported off-platform offer (OfferIn shape from student.py).
 *
 * The right column's three count cards are computed client-side from the two
 * feeds. Markup reuses the global reep-v2 classes (.card / .chip / .tabs-row /
 * .match-bar / .dt-btn); the scss only adds card layout + deadline/match tints.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

type Level = 'UG' | 'PG';
type Subtab = 'opportunities' | 'applications' | 'offers';
type RoleType = 'FULL_TIME' | 'FULL_TIME_PLUS_INTERNSHIP' | 'INTERNSHIP';
type Tone = 'good' | 'warn' | 'risk' | 'neutral';

type EligFilter = 'all' | 'eligible' | 'ineligible';
type DeadlineFilter = 'all' | 'soon' | 'open';

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
  closes_on: string | null;
  posted_on: string | null;
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
  cls: Tone;
  icon: string;
  label: string;
}

/** Resolved deadline view for a card. */
interface DeadlineInfo {
  tone: Tone;
  icon: string;
  label: string;
  closed: boolean;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-student-jobs',
  standalone: true,
  imports: [FormsModule, RouterLink],
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

  // --- opportunity filters (client-side over the fetched list) ---
  readonly filterElig = signal<EligFilter>('all');
  readonly filterLocation = signal<string>('all');
  readonly filterDeadline = signal<DeadlineFilter>('all');

  // Create-offer form state.
  readonly formOpen = signal(false);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  form = this.blankForm();

  // --- opportunities for the active degree level (pre-filter) ---
  readonly levelRows = computed(() => this.jobs().filter((j) => j.degree_level === this.level()));

  /** Distinct, sorted locations within the current degree level. */
  readonly locations = computed(() => {
    const set = new Set<string>();
    for (const j of this.levelRows()) if (j.location) set.add(j.location);
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  /** The visible cards after the three filters are applied. */
  readonly opportunityRows = computed(() => {
    const elig = this.filterElig();
    const loc = this.filterLocation();
    const dl = this.filterDeadline();
    return this.levelRows().filter((j) => {
      if (elig === 'eligible' && !j.eligible) return false;
      if (elig === 'ineligible' && j.eligible) return false;
      if (loc !== 'all' && j.location !== loc) return false;
      if (dl === 'soon') {
        const days = this.daysLeft(j.closes_on);
        if (days === null || days < 0 || days > 7) return false;
      }
      if (dl === 'open' && this.deadline(j).closed) return false;
      return true;
    });
  });

  readonly anyFilter = computed(
    () =>
      this.filterElig() !== 'all' ||
      this.filterLocation() !== 'all' ||
      this.filterDeadline() !== 'all',
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
    // A location valid for UG may not exist for PG — reset to keep the filter honest.
    if (this.filterLocation() !== 'all' && !this.locations().includes(this.filterLocation()))
      this.filterLocation.set('all');
  }

  clearFilters(): void {
    this.filterElig.set('all');
    this.filterLocation.set('all');
    this.filterDeadline.set('all');
  }

  offerStatus(status: string): StatusChip {
    return OFFER_STATUS[status] ?? { cls: 'warn', icon: 'help', label: status };
  }

  // --- deadline helpers -----------------------------------------------------

  /** Whole days from now until the deadline; null when there is no deadline. */
  daysLeft(closesOn: string | null): number | null {
    if (!closesOn) return null;
    const t = new Date(closesOn).getTime();
    if (Number.isNaN(t)) return null;
    return Math.ceil((t - Date.now()) / MS_PER_DAY);
  }

  private fmtDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** The deadline chip's tone, icon and label for a row. */
  deadline(row: JobRow): DeadlineInfo {
    const days = this.daysLeft(row.closes_on);
    if (days === null)
      return { tone: 'neutral', icon: 'event_available', label: 'No deadline', closed: false };
    if (days < 0) return { tone: 'risk', icon: 'event_busy', label: 'Closed', closed: true };
    if (days === 0) return { tone: 'risk', icon: 'schedule', label: 'Closes today', closed: false };
    if (days <= 3)
      return {
        tone: 'risk',
        icon: 'schedule',
        label: `Closes in ${days} day${days === 1 ? '' : 's'}`,
        closed: false,
      };
    if (days <= 7)
      return { tone: 'warn', icon: 'schedule', label: `Closes in ${days} days`, closed: false };
    return {
      tone: 'neutral',
      icon: 'event',
      label: `Closes ${this.fmtDate(row.closes_on!)}`,
      closed: false,
    };
  }

  /** Tint the match bar so a weak match reads at a glance. */
  matchTone(pct: number): Tone {
    if (pct >= 70) return 'good';
    if (pct >= 40) return 'warn';
    return 'risk';
  }

  // --- apply ----------------------------------------------------------------

  /** Open the external posting (if any) and record the application; the chip
   *  flips optimistically and reverts on failure. */
  async apply(row: JobRow): Promise<void> {
    if (row.applied || !row.eligible) return;
    if (row.apply_url) window.open(row.apply_url, '_blank', 'noopener');
    this.jobs.update((rows) => rows.map((r) => (r.id === row.id ? { ...r, applied: true } : r)));
    try {
      const res = await fetch(`${environment.apiBase}/student/jobs/${row.id}/apply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: null }),
      });
      if (!res.ok) throw new Error();
    } catch {
      this.jobs.update((rows) => rows.map((r) => (r.id === row.id ? { ...r, applied: false } : r)));
    }
  }

  // --- create offer ---------------------------------------------------------
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
