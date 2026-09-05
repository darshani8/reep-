/**
 * Student skilling — claim a skill with a certificate, then watch the badge
 * board light up.
 *
 * The screen is two things stacked. The CLAIM CARD takes a certificate and the
 * badge it proves; the BADGE BOARD shows every badge in the catalogue, grouped
 * by category, outlined when available and lit when the student holds it
 * EARNED. That pairing is the whole point: the form says what you can earn and
 * the board says what you have, so the two dropdowns and the board read from the
 * SAME catalogue rather than from two lists that could drift.
 *
 * THE CATALOGUE IS THE 48-BADGE ONE (`GET /student/badges`, app/models/badge.py):
 * Managerial · Sectoral · Platform / Technical · Thinking · Career Readiness —
 * the categories the handoff's board is drawn with. A claim is a piece of
 * evidence against a badge (`POST /student/badges/{code}/evidence`), and only a
 * staff APPROVE on it mints the EARNED row that lights the pill: a certificate
 * is evidence, a badge is the verified recognition. Readiness badges refuse
 * evidence — they arrive on assessment thresholds — so they are on the board
 * but never in the claim dropdowns.
 *
 * THE TWO SELECTS ARE DEPENDENT, and deliberately. Picking a badge out of one
 * flat list of ~48 was the thing students got wrong most often — the categories
 * are how the programme talks about skills, so choosing a category first turns
 * one long list into five short ones. Badge is disabled until a category is
 * chosen and clears when the category changes, so the pair can never submit a
 * badge from a category the student is no longer looking at.
 *
 * The claim form does NOT ask for a level or an evidence type. The student
 * asserts the certificate; the mentor judges it on review.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface EvidenceRow {
  id: string;
  evidence_type: string;
  status: string; // PENDING_VERIFICATION | APPROVED | REJECTED | MORE_INFO_REQUIRED
  title: string;
  provider: string | null;
  review_note: string | null;
  created_at: string;
}

interface Badge {
  code: string;
  name: string;
  category: string;
  category_label: string;
  track_label: string | null;
  staff_awarded: boolean;
  status: string; // NOT_STARTED | IN_PROGRESS | VERIFICATION_PENDING | EARNED
  evidence: EvidenceRow[];
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

interface BoardBadge {
  code: string;
  name: string;
  /** Held EARNED — the pill glows and nothing can dim it. */
  acquired: boolean;
  /** Tapped for a preview of the earned state; purely visual, never stored. */
  previewed: boolean;
  /** The status a hover/tap explains: what this pill is waiting on. */
  hint: string;
}

interface BoardCategory {
  key: string;
  label: string;
  note: string;
  badges: BoardBadge[];
}

interface OpenClaim {
  id: string;
  badgeName: string;
  chipClass: string;
  chipIcon: string;
  chipLabel: string;
  reviewNote: string | null;
}

/** Anything the student still needs to see: in flight, or sent back. */
function openClaimChip(status: string): Omit<OpenClaim, 'id' | 'badgeName' | 'reviewNote'> | null {
  // MORE_INFO_REQUIRED and REJECTED look similar and mean different things: the
  // first is an instruction to claim again with better evidence, the second is
  // a no. The label has to carry that, because it is all the student gets.
  if (status === 'MORE_INFO_REQUIRED')
    return { chipClass: 'warn', chipIcon: 'edit_note', chipLabel: 'Needs changes' };
  if (status === 'REJECTED')
    return { chipClass: 'risk', chipIcon: 'cancel', chipLabel: 'Not verified' };
  if (status === 'PENDING_VERIFICATION')
    return { chipClass: 'warn', chipIcon: 'schedule', chipLabel: 'With your mentor' };
  return null; // APPROVED needs no row — the badge on the board is already lit.
}

const STATUS_HINT: Record<string, string> = {
  EARNED: 'Verified and acquired',
  VERIFICATION_PENDING: 'Verification pending — with your mentor',
  IN_PROGRESS: 'In progress — not yet verified',
  NOT_STARTED: 'Available — claim it with a certificate',
};

/** The design's per-category caption: "12 badges", "4 readiness badges". */
function categoryNote(cat: Category): string {
  const noun = cat.key === 'READINESS' ? 'readiness badges' : 'badges';
  return cat.earned > 0
    ? `${cat.total} ${noun} · ${cat.earned} earned`
    : `${cat.total} ${noun}`;
}

const MAX_CERT_BYTES = 5 * 1024 * 1024;

@Component({
  selector: 'app-student-skilling',
  standalone: true,
  imports: [],
  templateUrl: './skilling.component.html',
  styleUrl: './skilling.component.scss',
})
export class SkillingComponent {
  /// null = still loading.
  readonly dashboard = signal<Dashboard | null>(null);
  readonly boardError = signal<string | null>(null);

  /// Claim form.
  readonly claimCategory = signal('');
  readonly claimBadge = signal('');
  readonly claimFile = signal<File | null>(null);
  readonly claimIssuer = signal('');
  readonly claimNote = signal('');
  readonly claiming = signal(false);
  readonly claimError = signal<string | null>(null);
  readonly claimSubmitted = signal(false);

  /// Badge codes the student has tapped to preview the earned state.
  private readonly previewed = signal<Set<string>>(new Set());

  /// Categories a student can actually claim into — readiness badges are
  /// staff-awarded, so a category made only of those never appears here.
  readonly categories = computed(() =>
    (this.dashboard()?.categories ?? [])
      .filter((c) => c.badges.some((b) => !b.staff_awarded))
      .map((c) => ({ key: c.key, label: c.label })),
  );

  /// Only the chosen category's claimable badges — empty until one is chosen,
  /// which is what disables and re-labels the second select.
  readonly badgeOptions = computed<Badge[]>(() => {
    const chosen = this.claimCategory();
    if (!chosen) return [];
    const cat = (this.dashboard()?.categories ?? []).find((c) => c.key === chosen);
    return (cat?.badges ?? []).filter((b) => !b.staff_awarded);
  });

  readonly claimFileName = computed(() => this.claimFile()?.name ?? '');
  readonly canSubmitClaim = computed(
    () => !!this.claimFile() && !!this.claimCategory() && !!this.claimBadge() && !this.claiming(),
  );

  readonly board = computed<BoardCategory[] | null>(() => {
    const dash = this.dashboard();
    if (dash === null) return null;
    const previewed = this.previewed();
    return dash.categories.map((cat) => ({
      key: cat.key,
      label: cat.label,
      note: categoryNote(cat),
      badges: cat.badges.map((b) => ({
        code: b.code,
        name: b.name,
        acquired: b.status === 'EARNED',
        previewed: b.status !== 'EARNED' && previewed.has(b.code),
        hint: STATUS_HINT[b.status] ?? b.status,
      })),
    }));
  });

  /// "N skills currently illuminated" — earned pills plus the ones being
  /// previewed, which is exactly what is glowing on screen right now.
  readonly litCount = computed(() =>
    (this.board() ?? []).reduce(
      (n, cat) => n + cat.badges.filter((b) => b.acquired || b.previewed).length,
      0,
    ),
  );

  /**
   * Claims the student still has something to do about. The handoff drops the
   * claims list entirely once a claim is filed, which is right for the happy
   * path and wrong for a rejection — a mentor's "this certificate is for a
   * different badge" would never reach the student. So the panel renders only
   * when there IS something outstanding, and the screen matches the handoff
   * exactly whenever there is not.
   */
  readonly openClaims = computed<OpenClaim[]>(() => {
    const out: OpenClaim[] = [];
    for (const cat of this.dashboard()?.categories ?? []) {
      for (const b of cat.badges) {
        if (b.status === 'EARNED') continue;
        for (const e of b.evidence) {
          const chip = openClaimChip(e.status);
          if (chip) out.push({ id: e.id, badgeName: b.name, reviewNote: e.review_note, ...chip });
        }
      }
    }
    return out;
  });

  constructor() {
    void this.loadBoard();
  }

  onCategoryChange(value: string): void {
    this.claimCategory.set(value);
    // A badge from the previous category must not survive the switch.
    this.claimBadge.set('');
  }

  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    // Cleared so re-picking the SAME file still fires a change event.
    input.value = '';
    this.claimError.set(null);
    if (file && file.size > MAX_CERT_BYTES) {
      this.claimFile.set(null);
      this.claimError.set('That file is over 5 MB. Export a smaller PDF or JPEG and try again.');
      return;
    }
    this.claimFile.set(file);
  }

  /** Tap a pill to preview the earned state. An EARNED pill is already lit and
   *  does not toggle — nothing on this board can dim a verified badge. */
  togglePreview(badge: BoardBadge): void {
    if (badge.acquired) return;
    this.previewed.update((set) => {
      const next = new Set(set);
      if (next.has(badge.code)) next.delete(badge.code);
      else next.add(badge.code);
      return next;
    });
  }

  claimAnother(): void {
    this.claimSubmitted.set(false);
    this.claimCategory.set('');
    this.claimBadge.set('');
    this.claimFile.set(null);
    this.claimIssuer.set('');
    this.claimNote.set('');
    this.claimError.set(null);
  }

  /// Store the certificate, then file the evidence against the badge. Two
  /// calls, in that order: the claim needs an upload id, so a failed upload must
  /// not leave a claim pointing at nothing.
  async submitClaim(): Promise<void> {
    const file = this.claimFile();
    const code = this.claimBadge();
    if (!file || !code) return;
    const badge = this.badgeOptions().find((b) => b.code === code);
    this.claiming.set(true);
    this.claimError.set(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', 'CERTIFICATE_PROOF');
      const issuer = this.claimIssuer().trim();
      form.append(
        'title',
        issuer ? `${badge?.name ?? file.name} — ${issuer}` : (badge?.name ?? file.name),
      );
      const up = await fetch(`${environment.apiBase}/student/uploads`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!up.ok) {
        const d = await up.json().catch(() => null);
        this.claimError.set(d?.detail ?? 'Certificate upload failed (PDF or JPEG, up to 5 MB).');
        return;
      }
      const uploadId = (await up.json()).id as string;
      const note = this.claimNote().trim();
      const claim = await fetch(`${environment.apiBase}/student/badges/${code}/evidence`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evidence_type: 'EXTERNAL_VERIFIED',
          upload_id: uploadId,
          title: badge?.name ?? file.name,
          // The issuer belongs on the evidence as its provider — it describes the
          // certificate, which is what a reviewer opens.
          provider: issuer || null,
          note: note || null,
        }),
      });
      if (!claim.ok) {
        const d = await claim.json().catch(() => null);
        this.claimError.set(d?.detail ?? 'Could not file the claim. Please try again.');
        return;
      }
      // The response is the refreshed dashboard, so the board and the open
      // claims update from the same document the write returned.
      this.dashboard.set((await claim.json()) as Dashboard);
      this.claimSubmitted.set(true);
    } catch {
      this.claimError.set('Could not reach the server.');
    } finally {
      this.claiming.set(false);
    }
  }

  private async loadBoard(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/badges`, { credentials: 'include' });
      if (!res.ok) {
        this.boardError.set('Could not load the badge catalogue.');
        return;
      }
      this.dashboard.set((await res.json()) as Dashboard);
    } catch {
      this.boardError.set('Could not reach the server.');
    }
  }
}
