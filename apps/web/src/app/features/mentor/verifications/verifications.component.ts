/**
 * Verifications — the mentor's review queue, and the ONLY place a skill becomes
 * verified or a submitted document stops being "in review".
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
 *
 * THE DOCUMENT QUEUE IS THE SAME SCOPE AND HAD NO CLIENT AT ALL. Every file a
 * student uploads — the certificate behind a claim, a profile photo, an offer
 * letter, an internship report — is written PENDING_REVIEW, and
 * `POST /mentor/uploads/{id}/review` is the only production writer of VERIFIED
 * or REJECTED on that row. Nothing in the app had ever called it. So the
 * student's own Uploads screen drew a three-step flow ending in "In review" and
 * a 'Pending review' chip that could never change, for the life of the
 * deployment. It is reviewed here rather than on a screen of its own because it
 * is the same reviewer, the same mentor group, the same `_assert_can_access_
 * student` gate and the same file the claim queue already opens with `fileUrl`.
 *
 * TWO OUTCOMES HERE, NOT THREE. `UploadStatus` carries NEEDS_CHANGES and the
 * review endpoint does not accept it: the body is VERIFY or REJECT and anything
 * else is a 422. So this queue offers exactly the two decisions the API will
 * take. Adding "Request changes" for symmetry with the claim queue above would
 * be a button that always fails.
 *
 * THE NOTE IS THE WHOLE OF WHAT THE STUDENT IS TOLD. `review_note` is the one
 * sentence their Uploads card shows under a decision ("Reviewer: …"), so a
 * rejection without one is a red chip and no way to know what to fix or whether
 * to upload it again. It is required here before a REJECT — and, unlike the
 * claim queue above, that rule is NOT mirrored in the API (`UploadReviewIn.note`
 * is optional). This is therefore a prompt to the reviewer and never a
 * guarantee about the data; do not describe it to a student as enforced, and do
 * not delete it on the grounds that the server does not ask.
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

/** A row of `GET /mentor/uploads/pending` (`UploadOut`), trimmed to what a
 *  pending row can actually carry — `reviewed_by_id`, `reviewed_at` and
 *  `review_note` are NULL on every row in this list by definition. */
interface PendingUpload {
  id: string;
  student_id: string;
  student_name: string;
  kind: string;
  title: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  uploaded_at: string;
}

type Decision = 'GRANT' | 'CHANGES' | 'REJECT';

/** What `UploadReviewIn.decision` accepts. VERIFY and REJECT and nothing else. */
type UploadDecision = 'VERIFY' | 'REJECT';

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

  /// null = loading; [] = no document is waiting.
  readonly uploads = signal<PendingUpload[] | null>(null);
  readonly uploadsError = signal<string | null>(null);
  /// Per-upload note text, keyed by id. Every document row is open at once —
  /// there is nothing to expand — so one shared draft would follow the reviewer
  /// from card to card and be sent with whichever one they pressed.
  readonly uploadNotes = signal<Record<string, string>>({});
  /// Which row is missing the note its rejection needs, and what to say on it.
  /// Keyed for the same reason: all the rows are on screen together, and a
  /// message under the wrong one reads as a screen that refuses at random.
  readonly uploadNoteError = signal<{ id: string; message: string } | null>(null);
  readonly decidingUpload = signal<string | null>(null);

  readonly pendingUploadCount = computed(() => (this.uploads() ?? []).length);

  constructor() {
    void this.load();
    void this.loadHistory();
    void this.loadUploads();
  }

  levelName(n: number): string {
    return LEVEL_NAMES[n] ?? `Level ${n}`;
  }

  evidenceKind(c: Claim): string {
    return (c.evidence_kind && EVIDENCE_KIND_LABEL[c.evidence_kind]) || 'Uploaded file';
  }

  /** The same vocabulary as a claim's evidence, off the same column. */
  uploadKind(u: PendingUpload): string {
    return EVIDENCE_KIND_LABEL[u.kind] ?? 'Uploaded file';
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

  uploadNote(id: string): string {
    return this.uploadNotes()[id] ?? '';
  }

  setUploadNote(id: string, value: string): void {
    this.uploadNotes.update((n) => ({ ...n, [id]: value }));
    if (this.uploadNoteError()?.id === id) {
      this.uploadNoteError.set(null);
    }
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
        this.error.set(await detailOf(res, 'Could not record that decision.'));
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

  /**
   * Verify or reject one uploaded document.
   *
   * The queue is REFETCHED afterwards rather than filtered in place, which is
   * the opposite of what the claim path above does and is deliberate. A claim's
   * card is expanded one at a time by the mentor who is deciding it; a document
   * sits in a list any other reviewer with scope may also be working through,
   * and the endpoint answers 409 the moment a row is no longer PENDING_REVIEW.
   * Only the server knows which rows are still waiting, so it is asked — a list
   * this screen edits by hand is a screen reporting its own assumption, which
   * is exactly how the batch promote/graduate dialogs came to render a
   * pre-write read under a button that had worked.
   */
  async decideUpload(upload: PendingUpload, decision: UploadDecision): Promise<void> {
    const note = this.uploadNote(upload.id).trim();
    if (decision === 'REJECT' && !note) {
      this.uploadNoteError.set({
        id: upload.id,
        message: 'Say what is wrong with it — this note is all the student is shown.',
      });
      return;
    }
    this.decidingUpload.set(upload.id);
    this.uploadsError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/mentor/uploads/${upload.id}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || null }),
      });
      if (!res.ok) {
        const refusal = await detailOf(res, 'Could not record that decision.');
        // Re-read BEFORE the message is shown, so a load failure cannot
        // overwrite it: a 409 here means the row has already been decided, and
        // leaving it on screen under the refusal is the queue disagreeing with
        // the database in front of the person being told why.
        await this.loadUploads();
        this.uploadsError.set(refusal);
        return;
      }
      this.uploadNoteError.set(null);
      // The draft is spent and the row it belonged to is leaving the list, so
      // the key goes with it rather than sitting in the map for a session.
      this.uploadNotes.update((n) => {
        const next = { ...n };
        delete next[upload.id];
        return next;
      });
      await this.loadUploads();
    } catch {
      this.uploadsError.set('Could not reach the server.');
    } finally {
      this.decidingUpload.set(null);
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

  /**
   * The document queue as the server has it, read at start-up and again after
   * every decision.
   *
   * A failure leaves `uploadsError` set and does NOT clear it on the next
   * successful read, unlike `loadHistory` above: this method is called from
   * `decideUpload` while a refusal is being reported, and a success here
   * blanking that signal would swallow the server's sentence. The signal is
   * cleared where the reviewer acts instead — at the top of `decideUpload`.
   */
  private async loadUploads(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/mentor/uploads/pending`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.uploadsError.set(await detailOf(res, 'Could not load the document queue.'));
        this.uploads.set([]);
        return;
      }
      this.uploads.set((await res.json()) as PendingUpload[]);
    } catch {
      this.uploadsError.set('Could not reach the server.');
      this.uploads.set([]);
    }
  }
}

/**
 * The server's own sentence where there is one.
 *
 * FastAPI answers a schema error with `detail` as a LIST of objects, so
 * `body.detail` rendered raw reads "[object Object]" — the trap
 * leave.component.ts hit when `LeaveIn` grew a date check, and what this
 * component did until the document queue arrived. The refusals worth showing
 * here name the actual problem ("Only a pending upload can be reviewed.",
 * "decision must be VERIFY or REJECT."), which is the difference between a
 * reviewer pressing the button again and a reviewer filing a bug.
 */
async function detailOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string') {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
      return String(detail[0].msg).replace(/^Value error,\s*/, '');
    }
  } catch {
    /* fall through to the status */
  }
  return `${fallback} (${response.status})`;
}
