/**
 * Mentor / TPO Log — the student's own 1:1 history, and the SWOC written about
 * them.
 *
 * Named for both because both write here: the assigned mentor and the placement
 * cell. It is VIEW-ONLY apart from requesting a meeting — nothing on this screen
 * approves, verifies or signs anything, and no admin content appears on it.
 *
 * Reads `mentor_notes` filtered to the signed-in student. The screen says
 * plainly that these notes are visible to the student and the placement office,
 * which is why nothing is filtered by author or hidden here: a note a student
 * cannot see is a note that should not have been written on that table.
 *
 * The mentor's internal vocabulary is translated server-side — FLAGGED reads as
 * "Flagged for follow-up" — so this component renders `action_label` and never
 * the raw enum.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

/** One SWOC line, as /student/overview returns it. */
interface SwocItem {
  text: string;
}

interface SwocBoard {
  strengths: SwocItem[];
  weaknesses: SwocItem[];
  opportunities: SwocItem[];
  challenges: SwocItem[];
}

interface Meeting {
  id: string;
  met_on: string;
  day: string;
  month: string;
  title: string;
  location: string | null;
  action: string;
  action_label: string;
  note: string;
  logged_by: string;
}

interface NextMeeting {
  title: string;
  location: string | null;
  starts_at: string;
}

interface MentorLog {
  mentor_name: string | null;
  meetings_logged: number;
  last_meeting: string | null;
  open_actions: number;
  next_meeting: NextMeeting | null;
  meetings: Meeting[];
}

/** Four SWOC lists arrive as arrays; the card shows one sentence per box. */
function joinSwoc(items: SwocItem[]): string {
  return items.length ? items.map((i) => i.text).join(' · ') : 'No entries yet';
}

@Component({
  selector: 'app-mentor-log',
  standalone: true,
  templateUrl: './mentor-log.component.html',
  styleUrl: './mentor-log.component.scss',
})
export class MentorLogComponent {
  readonly state = signal<'loading' | 'data' | 'error'>('loading');
  readonly data = signal<MentorLog | null>(null);

  /** The request form is a DISCLOSURE, not a route. Asking for a 1:1 is three
   *  words and a send; a page transition for it loses the log the student is
   *  looking at while they decide what to say. */
  readonly requesting = signal(false);
  readonly sending = signal(false);
  readonly notice = signal<{ tone: 'good' | 'risk'; text: string } | null>(null);
  readonly reason = signal('');
  readonly preferred = signal('');

  /**
   * SWOC belongs with the mentor log, not on the dashboard.
   * It is written BY the mentor and the placement cell — the caption says so —
   * and on the landing screen it sat among things the student does, where a
   * judgement written about them read as another task. Here it is next to the
   * meetings where it was formed and where it gets revised.
   */
  readonly swoc = signal<SwocBoard | null>(null);

  readonly swocBoxes = computed(() => {
    const s = this.swoc();
    if (!s) return null;
    return [
      { cls: 'swoc-box swoc-s', title: 'Strength', text: joinSwoc(s.strengths) },
      { cls: 'swoc-box swoc-w', title: 'Weakness', text: joinSwoc(s.weaknesses) },
      { cls: 'swoc-box swoc-o', title: 'Opportunity', text: joinSwoc(s.opportunities) },
      { cls: 'swoc-box swoc-c', title: 'Challenge', text: joinSwoc(s.challenges) },
    ];
  });

  /** Its own fetch, so a failing overview leaves the meeting log intact. */
  private async loadSwoc(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/overview`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const body = (await res.json()) as { swoc?: SwocBoard | null };
      this.swoc.set(body.swoc ?? null);
    } catch {
      /* the card simply does not render */
    }
  }

  constructor() {
    void this.load();
    void this.loadSwoc();
  }

  openRequest(): void {
    this.notice.set(null);
    this.requesting.set(true);
  }

  cancelRequest(): void {
    this.requesting.set(false);
    this.reason.set('');
    this.preferred.set('');
  }

  async sendRequest(): Promise<void> {
    const reason = this.reason().trim();
    if (!reason) return;
    this.sending.set(true);
    this.notice.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/mentor-meetings/request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, preferred: this.preferred().trim() || null }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        detail?: string;
        detail_message?: string;
      };
      if (!res.ok) {
        // A student with no mentor gets a real explanation from the server —
        // showing it verbatim is more useful than "something went wrong".
        this.notice.set({ tone: 'risk', text: body.detail ?? 'Could not send that request.' });
        return;
      }
      this.cancelRequest();
      this.notice.set({
        tone: 'good',
        text: (body as { detail?: string }).detail ?? 'Request sent.',
      });
      await this.load();
    } catch {
      this.notice.set({ tone: 'risk', text: 'Could not reach the server. Please try again.' });
    } finally {
      this.sending.set(false);
    }
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      const res = await fetch(`${environment.apiBase}/student/mentor-meetings`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      this.data.set((await res.json()) as MentorLog);
      this.state.set('data');
    } catch {
      this.state.set('error');
    }
  }
}
