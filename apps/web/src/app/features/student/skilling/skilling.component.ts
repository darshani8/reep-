/**
 * Student skilling — the reep-v2 port of the `data-p="skilling"` panel.
 *
 * Left: "Claim a skill" — pick a skill and a level, then upload the certificate
 * that evidences it; the file is posted and the claim filed against it. Right:
 * the student's own skills grouped by category with a verified/unverified chip
 * each. Then the handoff's "Recommended for you" card, and below it their skill
 * claims with a review-status chip (PENDING_REVIEW / VERIFIED / REJECTED).
 *
 * Four independent GETs (/student/skills, /student/skill-claims,
 * /student/skills/catalogue, /student/recommendations) so a missing or failing
 * endpoint degrades that section to an empty/error note on its own, never
 * blanking the screen. The recommendations card in particular is rule-based on
 * the server and calls NO model — nothing on this screen sends a student record
 * anywhere.
 */

import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

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
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface Recommendation {
  title: string;
  why: string;
  cta_label: string;
  cta_route: string;
}

interface StatusChip {
  cls: string;
  icon: string;
  label: string;
}

interface SkillGroup {
  category: string;
  skills: { slug: string; name: string; levelLabel: string; verified: boolean }[];
}

interface ClaimRow {
  id: string;
  skillName: string;
  levelLabel: string;
  chip: StatusChip;
  reviewNote: string | null;
}

// StudentSkill.level: 1 Aware · 2 Beginner · 3 Working · 4 Proficient · 5 Expert.
const LEVEL_NAMES = ['', 'Aware', 'Beginner', 'Working', 'Proficient', 'Expert'];
function levelName(n: number): string {
  return LEVEL_NAMES[n] ?? `Level ${n}`;
}

function statusChip(status: string): StatusChip {
  switch (status) {
    case 'VERIFIED':
      return { cls: 'good', icon: 'check_circle', label: 'Verified' };
    case 'REJECTED':
      return { cls: 'risk', icon: 'cancel', label: 'Rejected' };
    default:
      return { cls: 'warn', icon: 'schedule', label: 'Pending review' };
  }
}

@Component({
  selector: 'app-student-skilling',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './skilling.component.html',
  styleUrl: './skilling.component.scss',
})
export class SkillingComponent {
  /// null = still loading; [] = loaded but empty.
  readonly skills = signal<StudentSkill[] | null>(null);
  readonly claims = signal<SkillClaim[] | null>(null);
  readonly skillsError = signal<string | null>(null);
  readonly claimsError = signal<string | null>(null);

  readonly skillCount = computed(() => this.skills()?.length ?? 0);
  readonly verifiedCount = computed(() => (this.skills() ?? []).filter((s) => s.verified).length);

  /// Claim-a-skill form state.
  readonly catalogue = signal<{ id: string; name: string; category: string }[]>([]);
  readonly claimSkillId = signal<string>('');
  readonly claimLevel = signal<number>(3);
  readonly claiming = signal(false);
  readonly claimError = signal<string | null>(null);
  readonly claimOk = signal(false);

  /// Grouped by category; the server already sorts by (category, -level), so the
  /// first-seen order is category-sorted and strongest-first within each.
  readonly groups = computed<SkillGroup[] | null>(() => {
    const list = this.skills();
    if (list === null) return null;
    const map = new Map<string, SkillGroup['skills']>();
    for (const s of list) {
      const arr = map.get(s.category) ?? [];
      arr.push({ slug: s.slug, name: s.name, levelLabel: levelName(s.level), verified: s.verified });
      map.set(s.category, arr);
    }
    return [...map.entries()].map(([category, skills]) => ({ category, skills }));
  });

  readonly claimRows = computed<ClaimRow[] | null>(() => {
    const list = this.claims();
    if (list === null) return null;
    return list.map((c) => ({
      id: c.id,
      skillName: c.skill_name,
      levelLabel: levelName(c.claimed_level),
      chip: statusChip(c.status),
      reviewNote: c.review_note,
    }));
  });

  /** The handoff's "Recommended for you" card. `null` while in flight, `[]`
   *  when the server has nothing to suggest — and an empty list HIDES the card
   *  rather than rendering an empty one, because a heading with nothing under
   *  it reads as a screen that failed to load. */
  readonly recommendations = signal<Recommendation[] | null>(null);

  constructor() {
    void this.loadSkills();
    void this.loadClaims();
    void this.loadCatalogue();
    void this.loadRecommendations();
  }

  private async loadRecommendations(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/recommendations`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.recommendations.set([]);
        return;
      }
      const body = (await res.json()) as { items: Recommendation[] };
      this.recommendations.set(body.items ?? []);
    } catch {
      // No card rather than an error banner: a recommendation is a nice-to-have
      // beside the skills and claims this screen exists for.
      this.recommendations.set([]);
    }
  }

  private async loadCatalogue(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/skills/catalogue`, {
        credentials: 'include',
      });
      if (res.ok) this.catalogue.set(await res.json());
    } catch {
      /* the claim form just stays empty */
    }
  }

  /// Upload the certificate as proof, then file the claim against it.
  async onClaimFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const skillId = this.claimSkillId();
    if (!file || !skillId) return;
    this.claiming.set(true);
    this.claimError.set(null);
    this.claimOk.set(false);
    try {
      // 1. Store the certificate (magic-byte validated server-side).
      const form = new FormData();
      form.append('file', file);
      form.append('kind', 'CERTIFICATE_PROOF');
      form.append('title', file.name);
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
      // 2. File the claim against that upload.
      const claim = await fetch(`${environment.apiBase}/student/skill-claims`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_id: skillId, upload_id: uploadId, claimed_level: this.claimLevel() }),
      });
      if (!claim.ok) {
        this.claimError.set('Could not file the claim. Please try again.');
        return;
      }
      this.claimOk.set(true);
      this.claimSkillId.set('');
      await this.loadClaims(); // show the new PENDING_REVIEW claim
    } catch {
      this.claimError.set('Could not reach the server.');
    } finally {
      this.claiming.set(false);
      input.value = '';
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
      const res = await fetch(`${environment.apiBase}/student/skill-claims`, { credentials: 'include' });
      if (!res.ok) {
        this.claimsError.set('Could not load your skill claims.');
        return;
      }
      this.claims.set((await res.json()) as SkillClaim[]);
    } catch {
      this.claimsError.set('Could not reach the server.');
    }
  }
}
