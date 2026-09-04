/**
 * Evidence-backed skills — what the resume is allowed to claim, and on whose
 * word.
 *
 * The rule this exists to enforce: a resume may present a skill as VERIFIED only
 * when a mentor has verified it. Everything else — a claim still with the
 * mentor, one sent back for changes, one rejected — is visible to the student
 * here, labelled as what it is, and cannot be included. That is why include
 * state is filtered through `includable` on the way out rather than trusted from
 * storage: a skill included while verified and later un-verified must stop being
 * exported, and a stale id in the profile map must not be able to smuggle it
 * back in.
 *
 * Sources, all existing endpoints:
 *   GET /student/skills       — held skills, with `verified`
 *   GET /student/skill-claims — claims in flight, with their review state
 * The two are joined on skill name, since a claim names the skill it is for.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { ResumeBuilderService } from './resume-builder.service';

export type EvidenceStatus = 'verified' | 'in-review' | 'needs-changes' | 'student-added';

export interface EvidenceSkill {
  slug: string;
  name: string;
  category: string;
  status: EvidenceStatus;
  /** Human sentence for the row: where the claim stands and what it means. */
  statusNote: string;
  /** The upload backing it, when there is one — "View proof" targets this. */
  proofUploadId: string | null;
  verifiedOn: string | null;
  /** Only a verified skill may be put in the document. */
  includable: boolean;
  included: boolean;
}

interface StudentSkillRow {
  slug: string;
  name: string;
  category: string;
  level: number;
  verified: boolean;
  evidence_upload_id?: string | null;
}

interface ClaimRow {
  skill_name: string;
  upload_id: string;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
}

const CHIP: Record<EvidenceStatus, { cls: string; label: string }> = {
  verified: { cls: 'good', label: 'Verified' },
  'in-review': { cls: 'warn', label: 'In review' },
  'needs-changes': { cls: 'risk', label: 'Needs changes' },
  'student-added': { cls: 'neutral', label: 'Student-added' },
};

@Injectable({ providedIn: 'root' })
export class ResumeEvidenceService {
  private readonly svc = inject(ResumeBuilderService);

  readonly skills = signal<StudentSkillRow[] | null>(null);
  readonly claims = signal<ClaimRow[]>([]);
  readonly error = signal<string | null>(null);

  /** Slugs the student has chosen to include, as stored in the profile map. */
  private readonly includedSlugs = computed<string[]>(
    () =>
      (this.svc.section('evidence_skills', { included: [] }) as { included?: string[] }).included ??
      [],
  );

  readonly rows = computed<EvidenceSkill[] | null>(() => {
    const held = this.skills();
    if (held === null) return null;
    const claimByName = new Map(this.claims().map((c) => [c.skill_name, c]));
    const included = new Set(this.includedSlugs());

    return held.map((s) => {
      const claim = claimByName.get(s.name);
      let status: EvidenceStatus;
      let statusNote: string;

      if (s.verified) {
        status = 'verified';
        statusNote = 'A mentor checked the evidence and confirmed this skill.';
      } else if (claim?.status === 'PENDING_REVIEW') {
        status = 'in-review';
        statusNote = 'With your mentor. It can go on the resume once verified.';
      } else if (claim?.status === 'REJECTED') {
        status = 'needs-changes';
        statusNote = claim.review_note
          ? `Your mentor asked for a change: ${claim.review_note}`
          : 'Your mentor sent this back. Add stronger evidence and claim it again.';
      } else {
        status = 'student-added';
        statusNote = 'You added this yourself. Claim it with a certificate to have it verified.';
      }

      return {
        slug: s.slug,
        name: s.name,
        category: s.category,
        status,
        statusNote,
        proofUploadId: s.evidence_upload_id ?? claim?.upload_id ?? null,
        verifiedOn: s.verified ? (claim?.reviewed_at ?? null) : null,
        includable: s.verified,
        // An un-includable row can never read as included, whatever storage says.
        included: s.verified && included.has(s.slug),
      };
    });
  });

  readonly verifiedCount = computed(
    () => (this.rows() ?? []).filter((r) => r.status === 'verified').length,
  );
  readonly includedCount = computed(() => (this.rows() ?? []).filter((r) => r.included).length);

  /** The names that actually reach the document. */
  readonly includedNames = computed(() =>
    (this.rows() ?? []).filter((r) => r.included).map((r) => r.name),
  );

  chip(status: EvidenceStatus): { cls: string; label: string } {
    return CHIP[status];
  }

  proofUrl(uploadId: string): string {
    return `${environment.apiBase}/student/uploads/${uploadId}/file`;
  }

  toggle(slug: string): void {
    const row = (this.rows() ?? []).find((r) => r.slug === slug);
    if (!row?.includable) return; // guarded here as well as in the template
    const next = new Set(this.includedSlugs());
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    this.svc.patch('evidence_skills', { included: [...next] });
  }

  /**
   * One-click import: include every verified skill. The handoff's "Import
   * verified record" — the point is that a student never retypes what REEP
   * already holds. Returns how many were added so the caller can say so.
   */
  importVerified(): number {
    const verified = (this.rows() ?? []).filter((r) => r.includable);
    const before = new Set(this.includedSlugs());
    const added = verified.filter((r) => !before.has(r.slug)).length;
    this.svc.patch('evidence_skills', {
      included: [...new Set([...before, ...verified.map((r) => r.slug)])],
    });
    return added;
  }

  async load(): Promise<void> {
    if (this.skills() !== null) return;
    try {
      const [sRes, cRes] = await Promise.all([
        fetch(`${environment.apiBase}/student/skills`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/student/skill-claims`, { credentials: 'include' }),
      ]);
      if (!sRes.ok) {
        this.error.set('Could not load your skills.');
        this.skills.set([]);
        return;
      }
      this.skills.set((await sRes.json()) as StudentSkillRow[]);
      // Claims only enrich the rows; a failure here downgrades an "in review"
      // label to "student-added", which is the safe direction to be wrong in.
      if (cRes.ok) this.claims.set((await cRes.json()) as ClaimRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.skills.set([]);
    }
  }
}
