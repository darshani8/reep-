/**
 * Director → Placement. The offer-approval queue, on top of the placement
 * headline the analytics screen also draws.
 *
 * GET /mentor/offers/pending is director-gated despite its `/mentor` prefix
 * (routers/mentor.py mounts `require_director` on it) — approving an offer is a
 * programme decision, and the placement percentage every report quotes is
 * computed from APPROVED offers, so this queue is the number's source.
 *
 * The criteria card is GET /director/criteria: the eligibility bar the jobs
 * board applies to every student. It sits here because "why was this student
 * not eligible" is the question this screen generates.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface PendingOffer {
  id: string;
  student_id: string;
  student_name: string;
  job_title: string;
  organisation: string;
  role_type: string;
  ctc_inr: number;
  status: string;
}

interface Overview {
  total_students: number;
  pending_offers: number;
  approved_offers: number;
  placed_students: number;
  placement_percent: number;
}

interface Criteria {
  name: string;
  active: boolean;
  min_cgpa: number;
  max_live_backlogs: number;
  max_gap_months: number;
  min_attendance_pct: number;
  min_reep_completion_pct: number;
  min_cert_completion_pct: number;
  require_core_certs: boolean;
}

@Component({
  selector: 'app-director-placement',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './placement.component.html',
})
export class DirectorPlacementComponent {
  private readonly apiBase = environment.apiBase;

  readonly offers = signal<PendingOffer[] | null>(null);
  readonly overview = signal<Overview | null>(null);
  readonly criteria = signal<Criteria | null>(null);
  readonly error = signal<string | null>(null);

  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(
    () => this.offers()?.find((o) => o.id === this.selectedId()) ?? null,
  );

  note = '';
  readonly deciding = signal(false);
  readonly decideError = signal<string | null>(null);
  readonly decidedFlash = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [o, ov, cr] = await Promise.all([
        fetch(`${this.apiBase}/mentor/offers/pending`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/overview`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/criteria`, { credentials: 'include' }),
      ]);
      if (!o.ok) {
        this.error.set(
          o.status === 403
            ? 'Offer approval is for directors and admins.'
            : 'Could not load the offer queue.',
        );
        return;
      }
      const list = (await o.json()) as PendingOffer[];
      this.offers.set(list);
      if (!list.some((x) => x.id === this.selectedId())) {
        this.selectedId.set(list.length ? list[0].id : null);
      }
      if (ov.ok) this.overview.set((await ov.json()) as Overview);
      // A programme with no criteria row configured is a real state, not an
      // error: the card says so rather than showing zeros that read as a bar
      // every student clears.
      if (cr.ok) this.criteria.set((await cr.json()) as Criteria);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.decideError.set(null);
    this.note = '';
  }

  async decide(decision: 'APPROVE' | 'REJECT'): Promise<void> {
    const offer = this.selected();
    if (!offer) return;
    this.deciding.set(true);
    this.decideError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/offers/${offer.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: this.note.trim() || null }),
      });
      if (res.status === 409) {
        this.decideError.set('Someone else has already decided this offer.');
        await this.load();
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.decideError.set(detail?.detail ?? 'Could not record the decision.');
        return;
      }
      this.decidedFlash.set(
        `${offer.student_name}'s offer from ${offer.organisation} ${
          decision === 'APPROVE' ? 'approved' : 'rejected'
        }.`,
      );
      setTimeout(() => this.decidedFlash.set(null), 3500);
      this.note = '';
      await this.load();
    } catch {
      this.decideError.set('Could not reach the server.');
    } finally {
      this.deciding.set(false);
    }
  }

  /** ₹ in lakhs, the unit every placement conversation on this campus uses. A
   *  raw 1200000 in a table column is read wrong at a glance. */
  ctcLakhs(v: number): string {
    return `₹${(v / 100000).toFixed(2)} L`;
  }
}
