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
 * lists evidence type, source, date, visibility, "what the student did" and an
 * outcome metric, from an earlier version of the claim form that collected them;
 * the form it settled on collects a certificate, a badge, an issuer and a note.
 * Rendering the rest as empty labelled rows would suggest the student left them
 * blank rather than never being asked, so they are omitted until the form asks.
 */

import { DatePipe, KeyValuePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface PendingClaim {
  id: string;
  student_id: string;
  student_name: string;
  skill_id: string;
  skill_name: string;
  upload_id: string;
  claimed_level: number;
  status: string;
  student_note: string | null;
  created_at: string;
}

type Decision = 'GRANT' | 'CHANGES' | 'REJECT';

const LEVEL_NAMES = ['', 'Aware', 'Beginner', 'Working', 'Proficient', 'Expert'];

@Component({
  selector: 'app-mentor-verifications',
  standalone: true,
  imports: [DatePipe, KeyValuePipe],
  templateUrl: './verifications.component.html',
  styleUrl: './verifications.component.scss',
})
export class MentorVerificationsComponent {
  /// null = loading; [] = queue is clear.
  readonly claims = signal<PendingClaim[] | null>(null);
  readonly error = signal<string | null>(null);

  /// Which card is expanded. One at a time: a decision deserves the whole card.
  readonly openId = signal<string | null>(null);
  /// Per-claim note text, kept by id so switching cards does not lose a draft.
  readonly notes = signal<Record<string, string>>({});
  readonly noteError = signal<string | null>(null);
  readonly deciding = signal<string | null>(null);
  /// Decided this session, so the card can report the outcome before it goes.
  readonly done = signal<Record<string, string>>({});

  readonly pendingCount = computed(() => (this.claims() ?? []).length);

  constructor() {
    void this.load();
  }

  levelName(n: number): string {
    return LEVEL_NAMES[n] ?? `Level ${n}`;
  }

  /** Mentor-scoped download — the student route 404s for anyone but the owner. */
  fileUrl(uploadId: string): string {
    return `${environment.apiBase}/mentor/uploads/${uploadId}/file`;
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

  async decide(claim: PendingClaim, decision: Decision): Promise<void> {
    const note = this.note(claim.id).trim();
    // Checked here so the mentor gets the message next to the field they must
    // fill; the API enforces the same rule so the guarantee does not depend on
    // this component being the only caller.
    if (decision !== 'GRANT' && !note) {
      this.noteError.set(
        decision === 'CHANGES'
          ? 'Say what needs changing — this note is all the student sees.'
          : 'Give a reason — the student is shown it.',
      );
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
      const label =
        decision === 'GRANT'
          ? `Verified — ${claim.skill_name} is now on ${claim.student_name}'s board.`
          : decision === 'CHANGES'
            ? `Sent back to ${claim.student_name} to redo.`
            : `Rejected. ${claim.student_name} has been given the reason.`;
      this.done.update((d) => ({ ...d, [claim.id]: label }));
      this.openId.set(null);
      // Drop it from the queue locally: the server has already moved it out of
      // PENDING_REVIEW, and refetching would make the card vanish before the
      // mentor has read what happened.
      this.claims.update((list) => (list ?? []).filter((c) => c.id !== claim.id));
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
      this.claims.set((await res.json()) as PendingClaim[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.claims.set([]);
    }
  }
}
