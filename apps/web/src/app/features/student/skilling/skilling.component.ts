/**
 * Student skilling — claim a skill with a certificate, then watch the badge
 * board light up.
 *
 * The screen is two things stacked. The CLAIM CARD takes a certificate and the
 * badge it proves; the BADGE BOARD shows every badge in the catalogue, grouped
 * by category, outlined when available and lit when the student holds it
 * verified. That pairing is the whole point: the form says what you can earn and
 * the board says what you have, so the two dropdowns and the board read from the
 * SAME catalogue rather than from two lists that could drift.
 *
 * THE TWO SELECTS ARE DEPENDENT, and deliberately. Picking a badge out of one
 * flat list of ~42 was the thing students got wrong most often — the categories
 * are how the programme talks about skills, so choosing a category first turns
 * one long list into five short ones. Badge is disabled until a category is
 * chosen and clears when the category changes, so the pair can never submit a
 * badge from a category the student is no longer looking at.
 *
 * The claim form does NOT ask for a level. The student asserts the certificate;
 * the mentor sets the level when they grant it (`granted_level` on the review),
 * so asking the student to grade themselves first was a number nobody used.
 * `claimed_level` still goes up at the API's default.
 *
 * Three independent GETs (catalogue, skills, claims) so a failing one degrades
 * its own section rather than blanking the screen.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface CatalogueSkill {
  id: string;
  slug: string;
  name: string;
  category: string;
}

interface StudentSkill {
  slug: string;
  name: string;
  category: string;
  level: number;
  verified: boolean;
}

interface SkillClaim {
  id: string;
  skill_id: string;
  skill_name: string;
  upload_id: string;
  claimed_level: number;
  status: string; // UploadStatus: PENDING_REVIEW | VERIFIED | REJECTED
  student_note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface BoardBadge {
  slug: string;
  name: string;
  acquired: boolean;
}

interface BoardCategory {
  category: string;
  note: string;
  badges: BoardBadge[];
}

interface OpenClaim {
  id: string;
  skillName: string;
  chipClass: string;
  chipIcon: string;
  chipLabel: string;
  reviewNote: string | null;
}

/** Anything the student still needs to see: in flight, or sent back. */
function openClaimChip(status: string): Omit<OpenClaim, 'id' | 'skillName' | 'reviewNote'> | null {
  if (status === 'REJECTED')
    return { chipClass: 'risk', chipIcon: 'cancel', chipLabel: 'Not verified' };
  if (status === 'PENDING_REVIEW')
    return { chipClass: 'warn', chipIcon: 'schedule', chipLabel: 'With your mentor' };
  return null; // VERIFIED needs no row — the badge on the board is already lit.
}

@Component({
  selector: 'app-student-skilling',
  standalone: true,
  imports: [],
  templateUrl: './skilling.component.html',
  styleUrl: './skilling.component.scss',
})
export class SkillingComponent {
  /// null = still loading; [] = loaded but empty.
  readonly catalogue = signal<CatalogueSkill[] | null>(null);
  readonly skills = signal<StudentSkill[] | null>(null);
  readonly claims = signal<SkillClaim[] | null>(null);
  readonly skillsError = signal<string | null>(null);
  readonly catalogueError = signal<string | null>(null);

  /// Claim form.
  readonly claimCategory = signal('');
  readonly claimBadge = signal('');
  readonly claimFile = signal<File | null>(null);
  readonly claimIssuer = signal('');
  readonly claimNote = signal('');
  readonly claiming = signal(false);
  readonly claimError = signal<string | null>(null);
  readonly claimSubmitted = signal(false);

  readonly categories = computed<string[]>(() => {
    const cat = this.catalogue();
    if (!cat) return [];
    return [...new Set(cat.map((s) => s.category))];
  });

  /// Only the chosen category's badges — empty until one is chosen, which is
  /// what disables and re-labels the second select.
  readonly badgeOptions = computed<CatalogueSkill[]>(() => {
    const chosen = this.claimCategory();
    if (!chosen) return [];
    return (this.catalogue() ?? []).filter((s) => s.category === chosen);
  });

  readonly claimFileName = computed(() => this.claimFile()?.name ?? '');
  readonly canSubmitClaim = computed(
    () => !!this.claimFile() && !!this.claimCategory() && !!this.claimBadge() && !this.claiming(),
  );

  /// Slugs the student holds VERIFIED — the board's lit set. An unverified
  /// StudentSkill is a claim in progress, not an earned badge, so it stays dark.
  private readonly verifiedSlugs = computed(
    () => new Set((this.skills() ?? []).filter((s) => s.verified).map((s) => s.slug)),
  );

  readonly board = computed<BoardCategory[] | null>(() => {
    const cat = this.catalogue();
    if (cat === null) return null;
    const lit = this.verifiedSlugs();
    const byCategory = new Map<string, BoardBadge[]>();
    for (const s of cat) {
      const arr = byCategory.get(s.category) ?? [];
      arr.push({ slug: s.slug, name: s.name, acquired: lit.has(s.slug) });
      byCategory.set(s.category, arr);
    }
    return [...byCategory.entries()].map(([category, badges]) => ({
      category,
      // The handoff hardcoded a per-category caption ("12 badges"). Counting the
      // real rows says the same thing and cannot go stale.
      note: `${badges.length} badges · ${badges.filter((b) => b.acquired).length} earned`,
      badges,
    }));
  });

  readonly litCount = computed(() => this.verifiedSlugs().size);

  /**
   * Claims the student still has something to do about. The handoff drops the
   * claims list entirely once a claim is filed, which is right for the happy
   * path and wrong for a rejection — a mentor's "this certificate is for a
   * different badge" would never reach the student. So the panel renders only
   * when there IS something outstanding, and the screen matches the handoff
   * exactly whenever there is not.
   */
  readonly openClaims = computed<OpenClaim[]>(() => {
    return (this.claims() ?? []).flatMap((c) => {
      const chip = openClaimChip(c.status);
      if (!chip) return [];
      return [{ id: c.id, skillName: c.skill_name, reviewNote: c.review_note, ...chip }];
    });
  });

  constructor() {
    void this.loadCatalogue();
    void this.loadSkills();
    void this.loadClaims();
  }

  onCategoryChange(value: string): void {
    this.claimCategory.set(value);
    // A badge from the previous category must not survive the switch.
    this.claimBadge.set('');
  }

  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.claimFile.set(input.files?.[0] ?? null);
    this.claimError.set(null);
    // Cleared so re-picking the SAME file still fires a change event.
    input.value = '';
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

  /// Store the certificate, then file the claim against it. Two calls, in that
  /// order: the claim needs an upload id, so a failed upload must not leave a
  /// claim pointing at nothing.
  async submitClaim(): Promise<void> {
    const file = this.claimFile();
    const skillId = this.claimBadge();
    if (!file || !skillId) return;
    const badge = this.badgeOptions().find((b) => b.id === skillId);
    this.claiming.set(true);
    this.claimError.set(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', 'CERTIFICATE_PROOF');
      // The issuer belongs on the artefact, not the claim — it describes the
      // certificate, which is what a reviewer opens.
      const issuer = this.claimIssuer().trim();
      form.append('title', issuer ? `${badge?.name ?? file.name} — ${issuer}` : (badge?.name ?? file.name));
      const up = await fetch(`${environment.apiBase}/student/uploads`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!up.ok) {
        const d = await up.json().catch(() => null);
        this.claimError.set(d?.detail ?? 'Certificate upload failed (PDF/PNG/JPEG, up to 10 MB).');
        return;
      }
      const uploadId = (await up.json()).id as string;
      const note = this.claimNote().trim();
      const claim = await fetch(`${environment.apiBase}/student/skill-claims`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skill_id: skillId,
          upload_id: uploadId,
          student_note: note || null,
        }),
      });
      if (!claim.ok) {
        this.claimError.set('Could not file the claim. Please try again.');
        return;
      }
      this.claimSubmitted.set(true);
      await this.loadClaims();
    } catch {
      this.claimError.set('Could not reach the server.');
    } finally {
      this.claiming.set(false);
    }
  }

  private async loadCatalogue(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/skills/catalogue`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.catalogueError.set('Could not load the skill catalogue.');
        return;
      }
      this.catalogue.set((await res.json()) as CatalogueSkill[]);
    } catch {
      this.catalogueError.set('Could not reach the server.');
    }
  }

  private async loadSkills(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/skills`, { credentials: 'include' });
      if (!res.ok) {
        this.skillsError.set('Could not load your skills.');
        return;
      }
      this.skills.set((await res.json()) as StudentSkill[]);
    } catch {
      this.skillsError.set('Could not reach the server.');
    }
  }

  private async loadClaims(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/skill-claims`, {
        credentials: 'include',
      });
      if (res.ok) this.claims.set((await res.json()) as SkillClaim[]);
    } catch {
      /* The open-claims panel simply does not render. */
    }
  }
}
