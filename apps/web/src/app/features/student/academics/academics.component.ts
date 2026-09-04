/**
 * Academic history — the 10th → PG chain, backlogs and gaps that feed the
 * placement eligibility engine (roadmap Phase B). Ported from pod.ai's
 * /academics.
 *
 * The student edits their qualifications and gap months; per-semester CGPA and
 * backlogs are staff-imported and shown read-only, so they cannot mark their own
 * backlogs cleared to slip past an eligibility gate.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';
import {
  PageIntroComponent,
  SectionComponent,
  EmptyComponent,
} from '../../../shared/kit/kit.components';

type Level = 'TENTH' | 'TWELFTH' | 'DIPLOMA' | 'UNDERGRAD' | 'POSTGRAD';

interface Qualification {
  id?: string;
  level: Level;
  institution: string;
  board: string | null;
  year: number;
  marks: number;
  maxMarks: number;
  medium: string | null;
  location: string | null;
  subjects: string | null;
}
interface Gap {
  twelfthToGradMo: number;
  diplomaToGradMo: number;
  gradToPgMo: number;
  otherMo: number;
}
interface Semester {
  semester: number;
  cgpa: number | null;
  closedBacklogs: number;
  liveBacklogs: number;
}
interface AcademicsView {
  qualifications: Qualification[];
  gap: Gap;
  semesters: Semester[];
}

const LEVEL_LABEL: Record<Level, string> = {
  TENTH: '10th Standard',
  TWELFTH: '12th Standard',
  DIPLOMA: 'Diploma',
  UNDERGRAD: 'Undergraduate',
  POSTGRAD: 'Postgraduate',
};
const LEVEL_ORDER: Level[] = ['TENTH', 'TWELFTH', 'DIPLOMA', 'UNDERGRAD', 'POSTGRAD'];

@Component({
  selector: 'app-student-academics',
  standalone: true,
  imports: [FormsModule, PageIntroComponent, SectionComponent, EmptyComponent],
  templateUrl: './academics.component.html',
  styleUrl: './academics.component.scss',
})
export class AcademicsComponent {
  readonly levelLabel = LEVEL_LABEL;
  readonly levels = LEVEL_ORDER;

  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);

  quals = signal<Qualification[]>([]);
  gap: Gap = { twelfthToGradMo: 0, diplomaToGradMo: 0, gradToPgMo: 0, otherMo: 0 };
  semesters = signal<Semester[]>([]);

  readonly totalGap = computed(
    () =>
      this.gap.twelfthToGradMo + this.gap.diplomaToGradMo + this.gap.gradToPgMo + this.gap.otherMo,
  );
  readonly liveBacklogs = computed(() => this.semesters().reduce((s, r) => s + r.liveBacklogs, 0));

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/academics`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load your academics.');
        return;
      }
      const v = (await res.json()) as AcademicsView;
      this.quals.set(v.qualifications);
      this.gap = v.gap;
      this.semesters.set(v.semesters);
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  addQualification(level: Level): void {
    this.quals.set([
      ...this.quals(),
      {
        level,
        institution: '',
        board: null,
        year: new Date().getFullYear(),
        marks: 0,
        maxMarks: 100,
        medium: null,
        location: null,
        subjects: null,
      },
    ]);
    this.saved.set(false);
  }
  removeQualification(i: number): void {
    this.quals.set(this.quals().filter((_, idx) => idx !== i));
    this.saved.set(false);
  }

  async save(): Promise<void> {
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/academics`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qualifications: this.quals(), gap: this.gap }),
      });
      if (!res.ok) {
        this.error.set('Could not save your academics.');
        return;
      }
      const v = (await res.json()) as AcademicsView;
      this.quals.set(v.qualifications);
      this.gap = v.gap;
      this.saved.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
