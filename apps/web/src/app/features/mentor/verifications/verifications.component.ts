/**
 * Faculty → Verifications. The two review queues that turn a student's upload
 * into a verified fact: documents, and skill claims.
 *
 * GET /mentor/uploads/pending + POST /mentor/uploads/{id}/review, and
 * GET /mentor/skill-claims/pending + POST /mentor/skill-claims/{id}/review.
 * Every one is rule-2 scoped server-side, and each review re-checks the scope
 * on the way in — a MENTOR with no group gets two empty queues, never the
 * programme's.
 *
 * BADGE EVIDENCE IS NOT HERE. That queue lives on the Badge Centre with the
 * catalogue, the assessment entry and the skill profile it belongs to; a third
 * copy of it on this screen would be a second place to approve the same row,
 * and the two would disagree the first time one of them was changed.
 *
 * Granting a skill claim at a REDUCED level is the reason the grant control is
 * a level select rather than a bare "approve": the API accepts
 * `granted_level`, and a mentor who can only approve-as-claimed will approve a
 * level-5 claim they believe is a 3.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface PendingUpload {
  id: string;
  student_id: string;
  student_name: string;
  kind: string;
  cert_code: string | null;
  title: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  uploaded_at: string;
}

interface PendingClaim {
  id: string;
  student_id: string;
  student_name: string;
  skill_id: string;
  skill_name: string;
  upload_id: string;
  claimed_level: number;
  status: string;
  created_at: string;
}

@Component({
  selector: 'app-mentor-verifications',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './verifications.component.html',
})
export class MentorVerificationsComponent {
  private readonly apiBase = environment.apiBase;

  readonly tab = signal<'uploads' | 'claims'>('uploads');

  readonly uploads = signal<PendingUpload[] | null>(null);
  readonly claims = signal<PendingClaim[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly busyId = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  /** Per-row review note and granted level, keyed by row id. Held outside the
   *  row objects so a reload does not wipe a note a reviewer is halfway
   *  through typing. */
  readonly notes = signal<Record<string, string>>({});
  readonly grantLevels = signal<Record<string, number>>({});

  readonly levels = [1, 2, 3, 4, 5];

  readonly pendingTotal = computed(
    () => (this.uploads()?.length ?? 0) + (this.claims()?.length ?? 0),
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [u, c] = await Promise.all([
        fetch(`${this.apiBase}/mentor/uploads/pending`, { credentials: 'include' }),
        fetch(`${this.apiBase}/mentor/skill-claims/pending`, { credentials: 'include' }),
      ]);
      if (!u.ok) {
        this.error.set(
          u.status === 403
            ? 'Verifications are for mentors, directors and admins.'
            : 'Could not load the document queue.',
        );
        return;
      }
      this.error.set(null);
      this.uploads.set((await u.json()) as PendingUpload[]);
      this.claims.set(c.ok ? ((await c.json()) as PendingClaim[]) : []);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  setNote(id: string, value: string): void {
    this.notes.update((m) => ({ ...m, [id]: value }));
  }
  note(id: string): string {
    return this.notes()[id] ?? '';
  }

  setGrantLevel(id: string, value: number): void {
    this.grantLevels.update((m) => ({ ...m, [id]: Number(value) }));
  }
  grantLevel(c: PendingClaim): number {
    return this.grantLevels()[c.id] ?? c.claimed_level;
  }

  /** The MENTOR-scoped stream, not the student's own `/student/uploads/...`
   *  route — that one is scoped to the signed-in student's rows and would 404
   *  for every reviewer, leaving this queue asking for a verdict on a file
   *  nobody could open. */
  fileUrl(u: PendingUpload): string {
    return `${this.apiBase}/mentor/uploads/${u.id}/file`;
  }

  sizeKb(bytes: number): string {
    return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  async reviewUpload(u: PendingUpload, decision: 'VERIFY' | 'REJECT'): Promise<void> {
    this.busyId.set(u.id);
    this.actionError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/uploads/${u.id}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: this.note(u.id).trim() || null }),
      });
      if (res.status === 409) {
        this.actionError.set('Someone else has already reviewed this document.');
        await this.load();
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.actionError.set(detail?.detail ?? 'Could not record that review.');
        return;
      }
      this.flash.set(
        `${u.title} ${decision === 'VERIFY' ? 'verified' : 'rejected'} for ${u.student_name}.`,
      );
      setTimeout(() => this.flash.set(null), 3000);
      await this.load();
    } catch {
      this.actionError.set('Could not reach the server.');
    } finally {
      this.busyId.set(null);
    }
  }

  async reviewClaim(c: PendingClaim, decision: 'GRANT' | 'REJECT'): Promise<void> {
    this.busyId.set(c.id);
    this.actionError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/skill-claims/${c.id}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          granted_level: decision === 'GRANT' ? this.grantLevel(c) : null,
          note: this.note(c.id).trim() || null,
        }),
      });
      if (res.status === 409) {
        this.actionError.set('Someone else has already reviewed this claim.');
        await this.load();
        return;
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.actionError.set(detail?.detail ?? 'Could not record that review.');
        return;
      }
      this.flash.set(
        decision === 'GRANT'
          ? `${c.skill_name} granted at level ${this.grantLevel(c)} for ${c.student_name}.`
          : `${c.skill_name} claim rejected for ${c.student_name}.`,
      );
      setTimeout(() => this.flash.set(null), 3000);
      await this.load();
    } catch {
      this.actionError.set('Could not reach the server.');
    } finally {
      this.busyId.set(null);
    }
  }
}
