/**
 * Student skilling — the reep-v2 port of the `data-p="skilling"` panel.
 *
 * Left: "Claim a skill" — a dropzone placeholder. Binary file upload is not built
 * server-side yet, so it renders inert with a "file upload coming soon" note
 * rather than posting anything. Right: the student's own skills grouped by
 * category with a verified/unverified chip each. Below: their skill claims with a
 * review-status chip (PENDING_REVIEW / VERIFIED / REJECTED).
 *
 * Two independent GETs (/student/skills, /student/skill-claims) so a missing or
 * failing endpoint degrades that section to an empty/error note on its own,
 * never blanking the screen.
 */

import { Component, computed, signal } from '@angular/core';

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
  imports: [],
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

  constructor() {
    void this.loadSkills();
    void this.loadClaims();
    void this.loadCatalogue();
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
