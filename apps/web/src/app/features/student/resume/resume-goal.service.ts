/**
 * The resume's GOAL — which role, where, and against which posting.
 *
 * A resume is only "good" relative to something. The builder used to be a
 * 15-section form with no target, so completeness was the only feedback it could
 * give and "80% complete" said nothing about whether the document would survive
 * the job the student actually wanted. The goal makes that judgement possible:
 * every downstream step (tailor, preview, export) reads it.
 *
 * IT PERSISTS THROUGH THE PROFILE MAP. ResumeBuilderService.data is an opaque
 * section-key map that round-trips to /student/resume-profile, so `goal` rides
 * along with it and needs no endpoint of its own. The backend's completeness
 * calculation counts a FIXED list of section keys, so an extra key cannot
 * inflate the percentage.
 *
 * THE MATCH NUMBER IS THE SERVER'S, NOT OURS. `match_percent`, `eligible` and
 * `reasons` come from GET /student/jobs, which applies the per-posting CGPA and
 * live-backlog gates. Recomputing a match here would produce a second, quieter
 * answer that could disagree with the Jobs screen — and the one thing this
 * screen must never do is tell a student they are eligible when the gate says
 * otherwise.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { ResumeBuilderService } from './resume-builder.service';

export interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string | null;
  required_skills: string[];
  match_percent: number;
  eligible: boolean;
  reasons: string[];
}

export interface ResumeGoal {
  role: string;
  location: string;
  opportunityId: string;
}

const DEFAULT_GOAL: ResumeGoal = { role: '', location: '', opportunityId: '' };

@Injectable({ providedIn: 'root' })
export class ResumeGoalService {
  private readonly svc = inject(ResumeBuilderService);

  /// null = not loaded yet; [] = loaded and there are no postings.
  readonly jobs = signal<JobRow[] | null>(null);
  readonly jobsError = signal<string | null>(null);

  readonly goal = computed<ResumeGoal>(() => ({
    ...DEFAULT_GOAL,
    ...(this.svc.section('goal', {}) as Partial<ResumeGoal>),
  }));

  /// Role options are the titles actually on offer plus whatever the student
  /// already chose, so the select can always show its own value.
  readonly roleOptions = computed<string[]>(() => {
    const titles = (this.jobs() ?? []).map((j) => j.title);
    const chosen = this.goal().role;
    return [...new Set([...titles, ...(chosen ? [chosen] : [])])];
  });

  readonly locationOptions = computed<string[]>(() => {
    const locs = (this.jobs() ?? []).map((j) => j.location).filter((l): l is string => !!l);
    const chosen = this.goal().location;
    return [...new Set([...locs, ...(chosen ? [chosen] : [])])];
  });

  readonly selectedJob = computed<JobRow | null>(() => {
    const id = this.goal().opportunityId;
    if (!id) return null;
    return (this.jobs() ?? []).find((j) => j.id === id) ?? null;
  });

  /**
   * The strip's right-hand chip. With no posting chosen there is no honest
   * number to show, so it says so rather than printing a 0% that reads as a
   * verdict.
   */
  readonly matchLabel = computed<string>(() => {
    const job = this.selectedJob();
    if (!job) return 'Choose an opportunity to see your match';
    const pct = Math.round(job.match_percent);
    // Eligibility is a gate, not a score: a 90% skill match on a posting whose
    // CGPA cut-off you miss is still not eligible, and saying "90% match" alone
    // would read as "you can apply".
    return job.eligible ? `${pct}% match · eligible` : `${pct}% match · not yet eligible`;
  });

  readonly matchTone = computed<'good' | 'warn' | 'neutral'>(() => {
    const job = this.selectedJob();
    if (!job) return 'neutral';
    return job.eligible ? 'good' : 'warn';
  });

  setRole(role: string): void {
    this.svc.patch('goal', { ...this.goal(), role });
  }
  setLocation(location: string): void {
    this.svc.patch('goal', { ...this.goal(), location });
  }
  setOpportunity(opportunityId: string): void {
    const job = (this.jobs() ?? []).find((j) => j.id === opportunityId);
    // Picking a posting is the strongest statement of intent on the strip, so it
    // fills in the role and location it implies rather than leaving three
    // controls that can disagree with each other.
    this.svc.patch('goal', {
      role: job?.title ?? this.goal().role,
      location: job?.location ?? this.goal().location,
      opportunityId,
    });
  }

  async load(): Promise<void> {
    if (this.jobs() !== null) return; // one fetch per session
    try {
      const res = await fetch(`${environment.apiBase}/student/jobs`, { credentials: 'include' });
      if (!res.ok) {
        this.jobsError.set('Could not load opportunities.');
        this.jobs.set([]);
        return;
      }
      this.jobs.set((await res.json()) as JobRow[]);
    } catch {
      this.jobsError.set('Could not reach the server.');
      this.jobs.set([]);
    }
  }
}
