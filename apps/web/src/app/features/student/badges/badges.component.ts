/**
 * Skills Badge Profile — the student badge dashboard (framework doc §1–§17).
 *
 * Three tabs over GET /student/badges, /student/growth and
 * /student/badges/leaderboards:
 *
 *   Badges       the REBOOT → EXCEL → ELEVATE journey strip, then the five
 *                skill categories as tiles (sectoral grouped by track). Status
 *                is text + colour, never colour alone: gold=Earned,
 *                amber=Verification pending, purple=In progress, grey=Not
 *                started. Clicking a tile opens the §14 detail: description,
 *                requirement, evidence list with verdicts and reviewer notes,
 *                the approved-certification picker, and the claim form
 *                (evidence type / catalogue pick / one of your uploads).
 *                Readiness badges explain themselves instead of offering a
 *                form — they are assessment-threshold awards (§8).
 *   Growth       the seven §9 capabilities, T0–T4, current, growth from
 *                baseline and an inline SVG trend line. A missing score is a
 *                dash, never a zero — the English-baseline rule.
 *   Leaderboards §16's views, Most Improved ranked on growth, sectoral
 *                splittable by track.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface EvidenceRow {
  id: string;
  evidence_type: string;
  status: string;
  title: string;
  provider: string | null;
  completed_on: string | null;
  student_note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  from_catalogue: boolean;
  upload_id: string | null;
}

interface ApprovedCert {
  id: string;
  name: string;
  provider: string;
  evidence_type: string;
  stage: string;
  duration_text: string | null;
  is_free: boolean;
  url: string | null;
}

interface Badge {
  code: string;
  name: string;
  category: string;
  category_label: string;
  track: string | null;
  track_label: string | null;
  stage: string;
  points: number;
  description: string;
  requirement: string;
  staff_awarded: boolean;
  status: string;
  advanced_evidence_available: boolean;
  points_earned: number;
  earned_at: string | null;
  evidence: EvidenceRow[];
  approved_certifications: ApprovedCert[];
}

interface Category {
  key: string;
  label: string;
  earned: number;
  total: number;
  badges: Badge[];
}

interface Dashboard {
  stage: string;
  points_total: number;
  earned_total: number;
  badge_total: number;
  categories: Category[];
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

interface LeaderboardRow {
  rank: number;
  name: string;
  usn: string | null;
  value: number;
  is_me: boolean;
}

interface Leaderboard {
  view: string;
  label: string;
  unit: string;
  rows: LeaderboardRow[];
}

interface UploadRow {
  id: string;
  title: string;
  original_name: string;
}

type Tone = 'good' | 'warn' | 'risk' | 'neutral';

const STATUS_META: Record<string, { label: string; tone: Tone; icon: string }> = {
  NOT_STARTED: { label: 'Available', tone: 'neutral', icon: 'radio_button_unchecked' },
  IN_PROGRESS: { label: 'In progress', tone: 'neutral', icon: 'pending' },
  VERIFICATION_PENDING: { label: 'Verification pending', tone: 'warn', icon: 'hourglass_top' },
  EARNED: { label: 'Earned', tone: 'good', icon: 'verified' },
};

const EVIDENCE_STATUS_META: Record<string, { label: string; tone: Tone; icon: string }> = {
  PENDING_VERIFICATION: { label: 'Pending verification', tone: 'warn', icon: 'hourglass_top' },
  APPROVED: { label: 'Approved', tone: 'good', icon: 'check_circle' },
  REJECTED: { label: 'Rejected', tone: 'risk', icon: 'error' },
  MORE_INFO_REQUIRED: { label: 'More information required', tone: 'warn', icon: 'help' },
};

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  EXTERNAL_VERIFIED: 'External verified',
  BGSCET_ASSESSED: 'BGSCET assessed',
  APPLIED: 'Applied',
};

const CATEGORY_ICON: Record<string, string> = {
  MANAGERIAL: 'groups',
  SECTORAL: 'insights',
  PLATFORM: 'keyboard',
  THINKING: 'lightbulb',
  READINESS: 'work',
};

/** §2 — the journey strip. EXCEL_ADVANCED is still the EXCEL leg. */
const JOURNEY: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'REBOOT' },
  { key: 'EXCEL', label: 'EXCEL' },
  { key: 'ELEVATE', label: 'ELEVATE' },
];
const STAGE_INDEX: Record<string, number> = {
  REBOOT: 0,
  EXCEL: 1,
  EXCEL_ADVANCED: 1,
  ELEVATE: 2,
};

const LEADERBOARD_VIEWS: { key: string; label: string }[] = [
  { key: 'overall', label: 'Overall' },
  { key: 'managerial', label: 'Managerial' },
  { key: 'sectoral', label: 'Sectoral' },
  { key: 'platform', label: 'Platform / Technical' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'readiness', label: 'Career Readiness' },
  { key: 'most_improved', label: 'Most Improved' },
];

const SECTORAL_TRACKS: { key: string; label: string }[] = [
  { key: '', label: 'All tracks' },
  { key: 'FINANCE', label: 'Finance' },
  { key: 'HR', label: 'Human Resources' },
  { key: 'MARKETING', label: 'Marketing' },
  { key: 'BUSINESS_ANALYTICS', label: 'Business Analytics' },
];

@Component({
  selector: 'app-student-badges',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './badges.component.html',
  styleUrl: './badges.component.scss',
})
export class BadgesComponent {
  private readonly apiBase = environment.apiBase;

  readonly journey = JOURNEY;
  readonly leaderboardViews = LEADERBOARD_VIEWS;
  readonly sectoralTracks = SECTORAL_TRACKS;
  readonly evidenceTypes = Object.entries(EVIDENCE_TYPE_LABEL).map(([value, label]) => ({
    value,
    label,
  }));

  readonly tab = signal<'badges' | 'growth' | 'leaderboards'>('badges');

  readonly dashboard = signal<Dashboard | null>(null);
  readonly error = signal<string | null>(null);

  readonly growth = signal<Growth | null>(null);
  readonly growthError = signal<string | null>(null);

  readonly leaderboard = signal<Leaderboard | null>(null);
  readonly lbView = signal('overall');
  readonly lbTrack = signal('');
  readonly lbError = signal<string | null>(null);

  readonly uploads = signal<UploadRow[]>([]);

  readonly selectedCode = signal<string | null>(null);
  readonly selected = computed<Badge | null>(() => {
    const code = this.selectedCode();
    if (!code) return null;
    for (const cat of this.dashboard()?.categories ?? []) {
      const hit = cat.badges.find((b) => b.code === code);
      if (hit) return hit;
    }
    return null;
  });

  readonly stageIndex = computed(() => STAGE_INDEX[this.dashboard()?.stage ?? ''] ?? 0);

  // --- claim form state ---
  claimCertId = '';
  claimType = 'EXTERNAL_VERIFIED';
  claimUploadId = '';
  claimTitle = '';
  claimProvider = '';
  claimCompletedOn = '';
  claimNote = '';
  readonly claiming = signal(false);
  readonly claimError = signal<string | null>(null);
  readonly claimFlash = signal(false);

  constructor() {
    void this.load();
    void this.loadUploads();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/student/badges`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your badge profile.');
        return;
      }
      this.dashboard.set((await res.json()) as Dashboard);
      this.error.set(null);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  private async loadUploads(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/student/uploads`, { credentials: 'include' });
      if (res.ok) this.uploads.set((await res.json()) as UploadRow[]);
    } catch {
      // The picker simply stays empty; the claim form still works without it.
    }
  }

  setTab(tab: 'badges' | 'growth' | 'leaderboards'): void {
    this.tab.set(tab);
    if (tab === 'growth' && !this.growth()) void this.loadGrowth();
    if (tab === 'leaderboards' && !this.leaderboard()) void this.loadLeaderboard();
  }

  private async loadGrowth(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/student/growth`, { credentials: 'include' });
      if (!res.ok) {
        this.growthError.set('Could not load your growth record.');
        return;
      }
      this.growth.set((await res.json()) as Growth);
      this.growthError.set(null);
    } catch {
      this.growthError.set('Could not reach the server.');
    }
  }

  async loadLeaderboard(): Promise<void> {
    this.lbError.set(null);
    try {
      const params = new URLSearchParams({ view: this.lbView() });
      if (this.lbView() === 'sectoral' && this.lbTrack()) params.set('track', this.lbTrack());
      const res = await fetch(`${this.apiBase}/student/badges/leaderboards?${params}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.lbError.set('Could not load the leaderboard.');
        return;
      }
      this.leaderboard.set((await res.json()) as Leaderboard);
    } catch {
      this.lbError.set('Could not reach the server.');
    }
  }

  setLbView(view: string): void {
    this.lbView.set(view);
    void this.loadLeaderboard();
  }

  select(code: string): void {
    this.selectedCode.set(this.selectedCode() === code ? null : code);
    this.resetClaimForm();
  }

  private resetClaimForm(): void {
    this.claimCertId = '';
    this.claimType = 'EXTERNAL_VERIFIED';
    this.claimUploadId = '';
    this.claimTitle = '';
    this.claimProvider = '';
    this.claimCompletedOn = '';
    this.claimNote = '';
    this.claimError.set(null);
  }

  /** Sectoral badges grouped by track for the §5 sub-headings. */
  trackGroups(cat: Category): { label: string; badges: Badge[] }[] {
    if (cat.key !== 'SECTORAL') return [{ label: '', badges: cat.badges }];
    const groups = new Map<string, Badge[]>();
    for (const b of cat.badges) {
      const key = b.track_label ?? '';
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    return [...groups.entries()].map(([label, badges]) => ({ label, badges }));
  }

  async markInProgress(badge: Badge): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/student/badges/${badge.code}/start`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) this.dashboard.set((await res.json()) as Dashboard);
    } catch {
      // Non-critical; the tile simply stays as it is.
    }
  }

  async submitClaim(badge: Badge): Promise<void> {
    this.claimError.set(null);
    const fromCatalogue = !!this.claimCertId;
    if (!fromCatalogue && !this.claimTitle.trim()) {
      this.claimError.set('Pick an approved certification, or describe your evidence.');
      return;
    }
    this.claiming.set(true);
    try {
      const body: Record<string, unknown> = {
        approved_certification_id: fromCatalogue ? this.claimCertId : null,
        evidence_type: fromCatalogue ? null : this.claimType,
        upload_id: this.claimUploadId || null,
        title: this.claimTitle.trim() || null,
        provider: this.claimProvider.trim() || null,
        note: this.claimNote.trim() || null,
      };
      if (this.claimCompletedOn) body['completed_on'] = this.claimCompletedOn;
      const res = await fetch(`${this.apiBase}/student/badges/${badge.code}/evidence`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.claimError.set(detail?.detail ?? 'Could not submit the evidence.');
        return;
      }
      this.dashboard.set((await res.json()) as Dashboard);
      this.resetClaimForm();
      this.claimFlash.set(true);
      setTimeout(() => this.claimFlash.set(false), 2500);
    } catch {
      this.claimError.set('Could not reach the server.');
    } finally {
      this.claiming.set(false);
    }
  }

  // --- view helpers ---

  statusLabel(status: string): string {
    return STATUS_META[status]?.label ?? status;
  }
  statusTone(status: string): Tone {
    return STATUS_META[status]?.tone ?? 'neutral';
  }
  statusIcon(status: string): string {
    return STATUS_META[status]?.icon ?? 'help';
  }
  evidenceStatusLabel(status: string): string {
    return EVIDENCE_STATUS_META[status]?.label ?? status;
  }
  evidenceStatusTone(status: string): Tone {
    return EVIDENCE_STATUS_META[status]?.tone ?? 'neutral';
  }
  evidenceTypeLabel(t: string): string {
    return EVIDENCE_TYPE_LABEL[t] ?? t;
  }
  categoryIcon(key: string): string {
    return CATEGORY_ICON[key] ?? 'star';
  }
  stageLabel(stage: string): string {
    return stage === 'EXCEL_ADVANCED' ? 'EXCEL' : stage;
  }

  /** Inline SVG polyline for a capability's assessed checkpoints (1–10). */
  sparkline(row: GrowthRow, checkpoints: string[]): string {
    const pts: string[] = [];
    checkpoints.forEach((cp, i) => {
      const s = row.scores[cp];
      if (s != null) {
        const x = 4 + (i * 92) / Math.max(1, checkpoints.length - 1);
        const y = 30 - ((s - 1) / 9) * 26;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
    });
    return pts.join(' ');
  }

  formatScore(v: number | null): string {
    return v == null ? '—' : v.toFixed(1);
  }

  formatGrowth(v: number | null): string {
    if (v == null) return '—';
    return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
  }
}
