/**
 * Faculty Badge Centre — the staff half of the Skills & Badge framework.
 *
 *   Approvals    GET /mentor/badge-evidence/pending (already rule-2 scoped
 *                server-side). Approve mints the badge; Reject and "More info"
 *                write the verdict + note. The attached certificate opens via
 *                the scoped /badge-evidence/{id}/file stream.
 *   Assessments  pick a mentee, pick a checkpoint (T0–T4), enter the seven
 *                capability scores (1–10). Prefilled with what is already
 *                recorded; saving upserts, so a typo is corrected in place.
 *   Profile      the mentee's consolidated skill profile (§17) — badges by
 *                category, points, growth — built by the same composers the
 *                student's own screen uses. Directors also get a manual-award
 *                / revoke control per badge and the cohort CSV export.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
}

interface PendingEvidence {
  id: string;
  student_id: string;
  student_name: string;
  usn: string | null;
  badge_code: string;
  badge_name: string;
  category_label: string;
  evidence_type: string;
  status: string;
  title: string;
  provider: string | null;
  completed_on: string | null;
  student_note: string | null;
  from_catalogue: boolean;
  upload_id: string | null;
  created_at: string;
}

interface GrowthRow {
  capability: string;
  label: string;
  scores: Record<string, number | null>;
  current: number | null;
  growth: number | null;
}

interface Growth {
  checkpoints: string[];
  rows: GrowthRow[];
}

interface ProfileBadge {
  code: string;
  name: string;
  status: string;
  points: number;
  points_earned: number;
  staff_awarded: boolean;
}

interface ProfileCategory {
  key: string;
  label: string;
  earned: number;
  total: number;
  badges: ProfileBadge[];
}

interface SkillProfile {
  student_id: string;
  name: string;
  usn: string | null;
  stage: string;
  points_total: number;
  badges: { categories: ProfileCategory[]; earned_total: number; badge_total: number };
  growth: Growth;
  evidence_counts: Record<string, number>;
}

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  EXTERNAL_VERIFIED: 'External verified',
  BGSCET_ASSESSED: 'BGSCET assessed',
  APPLIED: 'Applied',
};

const CHECKPOINTS = ['T0', 'T1', 'T2', 'T3', 'T4'];

@Component({
  selector: 'app-badge-approvals',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './badge-approvals.component.html',
})
export class BadgeApprovalsComponent {
  readonly apiBase = environment.apiBase;
  private readonly auth = inject(AuthService);

  readonly isDirector = computed(() => {
    const role = this.auth.session()?.role;
    return role === 'DIRECTOR' || role === 'ADMIN';
  });

  readonly tab = signal<'approvals' | 'assessments' | 'profile'>('approvals');
  readonly checkpoints = CHECKPOINTS;

  readonly pending = signal<PendingEvidence[] | null>(null);
  readonly pendingError = signal<string | null>(null);
  readonly decidingId = signal<string | null>(null);
  readonly decideError = signal<string | null>(null);
  readonly notes: Record<string, string> = {};

  readonly mentees = signal<Mentee[]>([]);
  readonly selectedStudent = signal<string>('');

  // Assessments
  readonly checkpoint = signal('T0');
  readonly growthRows = signal<GrowthRow[] | null>(null);
  readonly scores: Record<string, string> = {};
  readonly savingScores = signal(false);
  readonly scoresError = signal<string | null>(null);
  readonly scoresFlash = signal(false);

  // Profile
  readonly profile = signal<SkillProfile | null>(null);
  readonly profileError = signal<string | null>(null);
  readonly awardBusy = signal<string | null>(null);

  constructor() {
    void this.loadPending();
    void this.loadMentees();
  }

  setTab(tab: 'approvals' | 'assessments' | 'profile'): void {
    this.tab.set(tab);
    const sid = this.selectedStudent();
    if (tab === 'assessments' && sid && !this.growthRows()) void this.loadGrowth(sid);
    if (tab === 'profile' && sid && !this.profile()) void this.loadProfile(sid);
  }

  private async loadPending(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/mentor/badge-evidence/pending`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.pendingError.set('Could not load the verification queue.');
        return;
      }
      this.pending.set((await res.json()) as PendingEvidence[]);
      this.pendingError.set(null);
    } catch {
      this.pendingError.set('Could not reach the server.');
    }
  }

  private async loadMentees(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/mentor/mentees`, { credentials: 'include' });
      if (!res.ok) return;
      const list = (await res.json()) as Mentee[];
      this.mentees.set(list);
      if (list.length && !this.selectedStudent()) this.selectedStudent.set(list[0].student_id);
    } catch {
      // The pickers stay empty; approvals still work.
    }
  }

  onStudentChange(studentId: string): void {
    this.selectedStudent.set(studentId);
    this.growthRows.set(null);
    this.profile.set(null);
    if (this.tab() === 'assessments') void this.loadGrowth(studentId);
    if (this.tab() === 'profile') void this.loadProfile(studentId);
  }

  async decide(row: PendingEvidence, decision: 'APPROVE' | 'REJECT' | 'MORE_INFO'): Promise<void> {
    this.decideError.set(null);
    this.decidingId.set(row.id);
    try {
      const res = await fetch(`${this.apiBase}/mentor/badge-evidence/${row.id}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: this.notes[row.id]?.trim() || null }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.decideError.set(detail?.detail ?? 'Could not record that decision.');
        return;
      }
      delete this.notes[row.id];
      await this.loadPending();
    } catch {
      this.decideError.set('Could not reach the server.');
    } finally {
      this.decidingId.set(null);
    }
  }

  evidenceFileUrl(id: string): string {
    return `${this.apiBase}/mentor/badge-evidence/${id}/file`;
  }

  evidenceTypeLabel(t: string): string {
    return EVIDENCE_TYPE_LABEL[t] ?? t;
  }

  // --- assessments ---------------------------------------------------------

  private async loadGrowth(studentId: string): Promise<void> {
    this.scoresError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/students/${studentId}/growth`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.scoresError.set('Could not load this student’s assessments.');
        return;
      }
      const g = (await res.json()) as Growth;
      this.growthRows.set(g.rows);
      this.prefillScores();
    } catch {
      this.scoresError.set('Could not reach the server.');
    }
  }

  onCheckpointChange(cp: string): void {
    this.checkpoint.set(cp);
    this.prefillScores();
  }

  private prefillScores(): void {
    const cp = this.checkpoint();
    for (const row of this.growthRows() ?? []) {
      const v = row.scores[cp];
      this.scores[row.capability] = v == null ? '' : String(v);
    }
  }

  async saveScores(): Promise<void> {
    const sid = this.selectedStudent();
    if (!sid) return;
    const payload: Record<string, number> = {};
    for (const row of this.growthRows() ?? []) {
      const raw = (this.scores[row.capability] ?? '').trim();
      if (!raw) continue; // partial entry is legal — speaking can wait
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 1 || v > 10) {
        this.scoresError.set(`${row.label}: scores are on a 1–10 scale.`);
        return;
      }
      payload[row.capability] = v;
    }
    if (Object.keys(payload).length === 0) {
      this.scoresError.set('Enter at least one score.');
      return;
    }
    this.savingScores.set(true);
    this.scoresError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/students/${sid}/assessments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpoint: this.checkpoint(), scores: payload }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.scoresError.set(detail?.detail ?? 'Could not save the scores.');
        return;
      }
      const g = (await res.json()) as Growth;
      this.growthRows.set(g.rows);
      this.prefillScores();
      this.scoresFlash.set(true);
      setTimeout(() => this.scoresFlash.set(false), 2500);
    } catch {
      this.scoresError.set('Could not reach the server.');
    } finally {
      this.savingScores.set(false);
    }
  }

  // --- profile -------------------------------------------------------------

  private async loadProfile(studentId: string): Promise<void> {
    this.profileError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/students/${studentId}/skill-profile`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.profileError.set('Could not load the skill profile.');
        return;
      }
      this.profile.set((await res.json()) as SkillProfile);
    } catch {
      this.profileError.set('Could not reach the server.');
    }
  }

  async award(badge: ProfileBadge): Promise<void> {
    const sid = this.selectedStudent();
    if (!sid) return;
    this.awardBusy.set(badge.code);
    try {
      const res = await fetch(
        `${this.apiBase}/mentor/students/${sid}/badges/${badge.code}/award`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Manually awarded' }),
        },
      );
      if (res.ok) await this.loadProfile(sid);
    } finally {
      this.awardBusy.set(null);
    }
  }

  async revoke(badge: ProfileBadge): Promise<void> {
    const sid = this.selectedStudent();
    if (!sid) return;
    const ok = window.confirm(`Revoke "${badge.name}"? The evidence history is kept.`);
    if (!ok) return;
    this.awardBusy.set(badge.code);
    try {
      const res = await fetch(
        `${this.apiBase}/mentor/students/${sid}/badges/${badge.code}/revoke`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Revoked' }),
        },
      );
      if (res.ok) await this.loadProfile(sid);
    } finally {
      this.awardBusy.set(null);
    }
  }

  exportUrl(): string {
    return `${this.apiBase}/director/badges/export.csv`;
  }

  formatScore(v: number | null): string {
    return v == null ? '—' : v.toFixed(1);
  }

  formatGrowth(v: number | null): string {
    if (v == null) return '—';
    return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
  }
}
