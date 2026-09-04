/**
 * Director → Courses. The curriculum, with programme-wide enrolment counts.
 *
 * GET /director/courses. READ-ONLY, deliberately: the catalogue is seeded
 * curriculum rather than something a director edits from a dashboard, and an
 * edit control here would imply a write path that does not exist. What this
 * screen is for is the other direction — which courses have people stuck in
 * them.
 *
 * `overdue` is the number worth looking at, so it is the one that renders as a
 * status chip rather than a bare figure.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface DirectorCourse {
  code: string;
  name: string;
  stage: string;
  dimension: string;
  semester: number;
  teaching_hours: number;
  self_learning_hours_required: number;
  model_type: string;
  duration_weeks: number;
  enrolled: number;
  completed: number;
  in_progress: number;
  overdue: number;
}

const MODEL_LABEL: Record<string, string> = {
  TEACHING_PLUS_SELF_LEARN: 'Teaching + self-learning',
  SUPERVISED_SELF_LEARN: 'Supervised self-learning',
  INSTRUCTOR_LED: 'Instructor led',
};

@Component({
  selector: 'app-director-courses',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './director-courses.component.html',
})
export class DirectorCoursesComponent {
  private readonly apiBase = environment.apiBase;

  readonly courses = signal<DirectorCourse[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly filter = signal('');
  readonly stageFilter = signal('all');

  readonly stages = computed(() => [
    ...new Set((this.courses() ?? []).map((c) => c.stage)),
  ]);

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const stage = this.stageFilter();
    return (this.courses() ?? []).filter((c) => {
      if (stage !== 'all' && c.stage !== stage) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q);
    });
  });

  readonly totals = computed(() => {
    const list = this.courses() ?? [];
    return {
      courses: list.length,
      enrolments: list.reduce((n, c) => n + c.enrolled, 0),
      completed: list.reduce((n, c) => n + c.completed, 0),
      overdue: list.reduce((n, c) => n + c.overdue, 0),
    };
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/director/courses`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set(
          res.status === 403
            ? 'The course catalogue is for directors and admins.'
            : 'Could not load the course catalogue.',
        );
        return;
      }
      this.courses.set((await res.json()) as DirectorCourse[]);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  modelLabel(v: string): string {
    return MODEL_LABEL[v] ?? v;
  }

  /** Completion as a percentage of enrolments — null, not 0, when nobody is
   *  enrolled. "0% complete" and "nobody has enrolled" are different facts. */
  completionPct(c: DirectorCourse): number | null {
    return c.enrolled > 0 ? Math.round((100 * c.completed) / c.enrolled) : null;
  }
}
