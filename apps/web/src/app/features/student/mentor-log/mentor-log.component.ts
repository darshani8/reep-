/**
 * Mentor Meeting Log — the student's own 1:1 history.
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

import { Component, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { environment } from '../../../../environments/environment';

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

@Component({
  selector: 'app-mentor-log',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './mentor-log.component.html',
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

  constructor() {
    void this.load();
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
