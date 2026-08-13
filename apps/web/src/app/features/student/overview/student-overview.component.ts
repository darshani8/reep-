/**
 * Student overview — the first screen through the shell.
 *
 * A faithful start on src/app/student/page.tsx: the REEP journey rail with the
 * student's current stage lit, and the header facts (stage, semester, USN) from
 * the live /api/student/meta endpoint. The eight analytic tiles (attendance,
 * VTU marks, SWOC, mocks, skills, streak) are their own migration slices — each
 * needs its NestJS data endpoint and a charted component — and land next.
 */

import { Component, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface StudentMeta {
  usn: string;
  currentStage: string;
  stageLabel: string;
  currentSemester: number;
}

const STAGES: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'Reboot' },
  { key: 'EXCEL', label: 'Excel' },
  { key: 'EXCEL_ADVANCED', label: 'Excel-Advanced' },
  { key: 'ELEVATE', label: 'Elevate' },
];

@Component({
  selector: 'app-student-overview',
  standalone: true,
  template: `
    <h1 class="reep-h1 page-title">Overview</h1>

    @if (meta(); as m) {
      <div class="rail" role="list" aria-label="REEP journey">
        @for (stage of stages; track stage.key; let i = $index) {
          <div
            class="rail__stage"
            role="listitem"
            [class.rail__stage--done]="i < currentIndex(m.currentStage)"
            [class.rail__stage--current]="stage.key === m.currentStage"
          >
            <span class="rail__dot"></span>
            <span class="rail__label">{{ stage.label }}</span>
          </div>
        }
      </div>

      <div class="facts">
        <div class="fact">
          <div class="fact__label reep-caption">Current stage</div>
          <div class="fact__value reep-h3">{{ m.stageLabel }}</div>
        </div>
        <div class="fact">
          <div class="fact__label reep-caption">Semester</div>
          <div class="fact__value reep-h3">{{ m.currentSemester }}</div>
        </div>
        <div class="fact">
          <div class="fact__label reep-caption">USN</div>
          <div class="fact__value reep-h3 tabular">{{ m.usn }}</div>
        </div>
      </div>

      <p class="note reep-body2">
        Attendance, VTU marks, SWOC, mocks, skills and streak tiles are being
        migrated to Angular — each with its own data endpoint and chart.
      </p>
    } @else if (error()) {
      <p class="note reep-body2">{{ error() }}</p>
    } @else {
      <p class="note reep-body2">Loading…</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .page-title {
        margin: 0 0 24px;
        color: var(--reep-text-primary);
      }
      .rail {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 28px;
        padding: 20px 24px;
        margin-bottom: 24px;
        background: var(--reep-neu-bg);
        border-radius: 12px;
        box-shadow: var(--reep-neu-shadow);
      }
      .rail__stage {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--reep-text-disabled);
      }
      .rail__dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--reep-divider);
      }
      .rail__stage--done {
        color: var(--reep-text-secondary);
      }
      .rail__stage--done .rail__dot {
        background: var(--reep-secondary-main);
      }
      .rail__stage--current {
        color: var(--reep-text-primary);
        font-weight: 600;
      }
      .rail__stage--current .rail__dot {
        background: var(--reep-secondary-main);
        box-shadow: 0 0 0 4px var(--reep-action-selected);
      }
      .rail__label {
        font-size: 0.875rem;
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }
      .fact {
        padding: 18px 20px;
        background: var(--reep-bg-paper);
        border-radius: 10px;
      }
      .fact__label {
        color: var(--reep-text-disabled);
      }
      .fact__value {
        margin-top: 4px;
        color: var(--reep-text-primary);
      }
      .note {
        color: var(--reep-text-secondary);
      }
    `,
  ],
})
export class StudentOverviewComponent {
  readonly stages = STAGES;
  readonly meta = signal<StudentMeta | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  currentIndex(stage: string): number {
    return STAGES.findIndex((s) => s.key === stage);
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/meta`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your record.');
        return;
      }
      this.meta.set((await res.json()) as StudentMeta);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }
}
