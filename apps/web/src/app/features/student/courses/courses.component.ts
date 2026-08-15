/**
 * Student courses — the Angular port of the `data-p="courses"` mockup panel.
 *
 * A single dt-table (Course / Stage / Modules) driven by GET /student/courses.
 * "Modules" is the lecture ratio (attended / total) the endpoint already shapes;
 * a status chip is added per row. All shaping — the lecture ratio, the stage
 * enum, the enrolment status — comes from the FastAPI endpoint, so this renders
 * ready rows and only prettifies the enum labels for display.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Course {
  code: string;
  name: string;
  stage: string;
  dimension: string;
  semester: number;
  status: string;
  teaching_hours_attended: number;
  self_learning_hours_logged: number;
  lectures_attended: number;
  lectures_total: number;
  lecture_percent: number;
}

type LoadState = 'loading' | 'ready' | 'error';

interface Chip {
  cls: string;
  icon: string;
  label: string;
}

@Component({
  selector: 'app-student-courses',
  standalone: true,
  imports: [],
  templateUrl: './courses.component.html',
  styleUrl: './courses.component.scss',
})
export class CoursesComponent {
  readonly courses = signal<Course[]>([]);
  readonly state = signal<LoadState>('loading');

  readonly completedCount = computed(
    () => this.courses().filter((c) => c.status === 'COMPLETED').length,
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/courses`, { credentials: 'include' });
      if (!res.ok) {
        this.state.set('error');
        return;
      }
      this.courses.set((await res.json()) as Course[]);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  /// REBOOT → Reboot, EXCEL_ADVANCED → Excel Advanced.
  stageLabel(stage: string): string {
    return stage
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /// Map the ProgressStatus enum onto the global .chip tones + a Material Symbol.
  statusChip(status: string): Chip {
    switch (status) {
      case 'COMPLETED':
        return { cls: 'good', icon: 'check_circle', label: 'Completed' };
      case 'IN_PROGRESS':
        return { cls: 'warn', icon: 'pending', label: 'In progress' };
      case 'OVERDUE':
        return { cls: 'risk', icon: 'warning', label: 'Overdue' };
      default:
        return { cls: '', icon: 'schedule', label: 'Not started' };
    }
  }
}
