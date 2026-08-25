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

  constructor() {
    void this.load();
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
