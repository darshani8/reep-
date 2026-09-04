/**
 * Catalogue — the programme as designed.
 *
 * Every course, grouped by semester, with the certifications mapped to it
 * nested underneath. Nested rather than two flat lists because a certification
 * only means anything against the course it certifies, and the question this
 * screen exists to answer is which courses carry evidence and which do not.
 *
 * READ-ONLY, and that is the honest shape today. Courses and certifications are
 * seeded, and there is no endpoint that writes either — offering an Edit button
 * that posted nowhere would be worse than not having one.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Cert {
  code: string;
  name: string;
  provider: string;
  required_hours: number;
  is_optional: boolean;
  link: string | null;
}

interface Course {
  code: string;
  name: string;
  stage: string;
  dimension: string;
  semester: number;
  teaching_hours: number;
  self_learning_hours_required: number;
  model_type: string;
  duration_weeks: number;
  certifications: Cert[];
}

@Component({
  selector: 'app-director-catalogue',
  standalone: true,
  imports: [],
  templateUrl: './catalogue.component.html',
  styleUrl: './catalogue.component.scss',
})
export class DirectorCatalogueComponent {
  readonly courses = signal<Course[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly semesters = computed(() => {
    const rows = this.courses();
    if (rows === null) return null;
    const by = new Map<number, Course[]>();
    for (const c of rows) {
      const arr = by.get(c.semester) ?? [];
      arr.push(c);
      by.set(c.semester, arr);
    }
    return [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([semester, list]) => ({ semester, courses: list }));
  });

  readonly totals = computed(() => {
    const rows = this.courses() ?? [];
    const certs = rows.reduce((n, c) => n + c.certifications.length, 0);
    return {
      courses: rows.length,
      certs,
      // A course with no certification has no evidence path, which is the one
      // gap in the catalogue worth surfacing at the top.
      uncovered: rows.filter((c) => c.certifications.length === 0).length,
    };
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/director/catalogue`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load the catalogue.');
        this.courses.set([]);
        return;
      }
      this.courses.set((await res.json()) as Course[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.courses.set([]);
    }
  }
}
