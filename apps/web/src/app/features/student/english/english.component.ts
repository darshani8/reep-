/**
 * English Proficiency Baseline — the Reboot stage's CEFR-aligned assessment.
 *
 * A PENDING SECTION IS NOT A ZERO, and this screen is where that matters most:
 * the score is printed in a 27px numeral, so a speaking section that has not
 * been taken rendering as a confident "0" tells a student they failed something
 * they have not sat. The API sends `score: null` for a pending section
 * (app/models/english_baseline.py explains why the column is nullable), and the
 * template branches on `status`, never on a falsy score — `score || '--'` would
 * also swallow a genuine 0.
 *
 * "Provisional band" is likewise derived server-side from how many sections are
 * scored, so the word cannot outlive the section that resolves it.
 */

import { Component, signal } from '@angular/core';
import { DatePipe, LowerCasePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

interface Subscore {
  label: string;
  value: number | null;
}

interface Section {
  skill: string;
  label: string;
  icon: string;
  status: 'SCORED' | 'PENDING';
  score: number | null;
  band: string | null;
  minutes: number;
  subscores: Subscore[];
  has_report: boolean;
}

interface NextStep {
  title: string;
  sub: string;
  target: string | null;
}

interface Baseline {
  exists: boolean;
  status: string;
  overall_score: number | null;
  band: string | null;
  band_label: string | null;
  provisional: boolean;
  taken_on: string | null;
  sections_scored: number;
  sections_total: number;
  progress_percent: number;
  pending_label: string | null;
  report_available: boolean;
  strengths: string[];
  focus_areas: string[];
  next_steps: NextStep[];
  sections: Section[];
}

@Component({
  selector: 'app-english-baseline',
  standalone: true,
  imports: [DatePipe, LowerCasePipe, RouterLink],
  templateUrl: './english.component.html',
})
export class EnglishBaselineComponent {
  readonly state = signal<'loading' | 'data' | 'error'>('loading');
  readonly data = signal<Baseline | null>(null);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    try {
      const res = await fetch(`${environment.apiBase}/student/english-baseline`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      this.data.set((await res.json()) as Baseline);
      this.state.set('data');
    } catch {
      this.state.set('error');
    }
  }
}
