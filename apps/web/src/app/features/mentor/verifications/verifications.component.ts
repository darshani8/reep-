/**
 * Skill Verifications — the mentor's review queue, and the ONLY place a skill
 * becomes verified.
 *
 * A student files a claim on Skilling; it lands here, for their assigned mentor
 * and nobody else. There is no admin queue, no escalation and no second
 * approver: `GET /mentor/skill-claims/pending` narrows to the mentor's own group
 * server-side, and the review endpoint re-checks scope, so the routing is a
 * property of the API rather than of this screen.
 *
 * THREE OUTCOMES, AND TWO OF THEM NEED WORDS. Verify grants the skill and lights
 * the badge on the student's board. Request changes sends it back to be redone.
 * Reject refuses it. The last two are indistinguishable from a broken screen if
 * they arrive without a reason — the student sees the note and nothing else — so
 * the note is required for both, enforced here for the message and again in the
 * API for the guarantee.
 *
 * WHAT THIS SHOWS IS WHAT A CLAIM ACTUALLY CARRIES. The handoff's card also
 * lists a source/issuer, a date, a visibility and an outcome metric, from an
 * earlier version of the claim form that collected them; the form it settled on
 * collects a certificate, the skill it proves and a note. What the evidence IS
 * — its kind, its title and its file name — now travels with the claim, so the
 * card names it before the file is opened. Rendering the rest as empty labelled
 * rows would suggest the student left them blank rather than never being asked,
 * so they are omitted until the form asks.
 *
 * "Recently reviewed" is the same scope, read back: `GET /skill-claims/reviewed`
 * lists decided claims newest first, with the note the student was given, so a
 * decision does not vanish the moment it is made.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Claim {
  id: string;
  student_id: string;
  student_name: string;
  skill_id: string;
  skill_name: string;
  upload_id: string;
  claimed_level: number;
  status: string;
  student_note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  evidence_kind: string | null;
  evidence_title: string | null;
  evidence_file_name: string | null;
}

type Decision = 'GRANT' | 'CHANGES' | 'REJECT';

const LEVEL_NAMES = ['', 'Aware', 'Beginner', 'Working', 'Proficient', 'Expert'];

/** Upload.kind -> the words on the card. */
const EVIDENCE_KIND_LABEL: Record<string, string> = {
  CERTIFICATE_PROOF: 'Certificate',
  DOCUMENT: 'Document',
  RESUME: 'Resume',
  PROFILE_PHOTO: 'Photo',
};

interface Outcome {
  tone: 'good' | 'warn' | 'risk' | 'neutral';
  icon: string;
  label: string;
}

/** Status -> chip. Text and colour together, never colour alone. */
function outcomeFor(status: string): Outcome {
  switch (status) {
    case 'VERIFIED':
      return { tone: 'good', icon: 'check_circle', label: 'Verified' };
    case 'REJECTED':
      return { tone: 'risk', icon: 'cancel', label: 'Rejected' };
    case 'NEEDS_CHANGES':
      return { tone: 'warn', icon: 'undo', label: 'Needs changes' };
    default:
      return { tone: 'neutral', icon: 'hourglass_top', label: status };
  }
}

@Component({
  selector: 'app-mentor-verifications',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './verifications.component.html',
  styleUrl: './verifications.component.scss',
})
export class MentorVerificationsComponent {
  /// null = loading; [] = queue is clear.
  readonly claims = signal<Claim[] | null>(null);
  readonly error = signal<string | null>(null);

  /// null = loading; [] = nothing decided yet in this scope.
  readonly history = signal<Claim[] | null>(null);
  readonly historyError = signal<string | null>(null);

  /// Which card is expanded. One at a time: a decision deserves the whole card.
  readonly openId = signal<string | null>(null);
  /// Per-claim note text, kept by id so switching cards does not lose a draft.
  readonly notes = signal<Record<string, string>>({});
  readonly noteError = signal<string | null>(null);
  readonly deciding = signal<string | null>(null);

  readonly pendingCount = computed(() => (this.claims() ?? []).length);

  constructor() {
    void this.load();
    void this.loadHistory();
  }

  levelName(n: number): string {
    return LEVEL_NAMES[n] ?? `Level ${n}`;
  }

  evidenceKind(c: Claim): string {
    return (c.evidence_kind && EVIDENCE_KIND_LABEL[c.evidence_kind]) || 'Uploaded file';
  }

  /** Mentor-scoped download — the student route 404s for anyone but the owner. */
  fileUrl(uploadId: string): string {
    return `${environment.apiBase}/mentor/uploads/${uploadId}/file`;
  }

  outcome(status: string): Outcome {
    return outcomeFor(status);
  }

  note(id: string): string {
    return this.notes()[id] ?? '';
  }

  setNote(id: string, value: string): void {
    this.notes.update((n) => ({ ...n, [id]: value }));
    this.noteError.set(null);
  }

  toggle(id: string): void {
    this.openId.update((cur) => (cur === id ? null : id));
    this.noteError.set(null);
  }

  async decide(claim: Claim, decision: Decision): Promise<void> {
    const note = this.note(claim.id).trim();
    // Checked here so the mentor gets the message next to the field they must
    // fill; the API enforces the same rule so the guarantee does not depend on
    // this component being the only caller.
    if (decision !== 'GRANT' && !note) {
      this.noteError.set('Add a note explaining what needs to change.');
      return;
    }
    this.deciding.set(claim.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/mentor/skill-claims/${claim.id}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.error.set(d?.detail ?? 'Could not record that decision.');
        return;
      }
      this.openId.set(null);
      // Out of the queue locally — the server has already moved it out of
      // PENDING_REVIEW — and into Recently reviewed, where the outcome and the
      // note the student was given can be read back.
      this.claims.update((list) => (list ?? []).filter((c) => c.id !== claim.id));
      await this.loadHistory();
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/mentor/skill-claims/pending`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load the verification queue.');
        this.claims.set([]);
        return;
      }
      this.claims.set((await res.json()) as Claim[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.claims.set([]);
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/mentor/skill-claims/reviewed?limit=8`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.historyError.set('Could not load your recent decisions.');
        this.history.set([]);
        return;
      }
      this.history.set((await res.json()) as Claim[]);
      this.historyError.set(null);
    } catch {
      this.historyError.set('Could not reach the server.');
      this.history.set([]);
    }
  }
}
