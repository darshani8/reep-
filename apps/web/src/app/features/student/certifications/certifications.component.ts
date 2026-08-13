/**
 * Student certifications — the Angular port of src/app/student/certifications.
 *
 * Stat tiles that follow the stage filter, a stage-tab filter (All + the four
 * REEP stages), and a table with each certification's pace (actual vs expected
 * %), provenance and due label. All shaping — pace status, due words, provider
 * line — is done by /api/student/certifications, so this renders ready rows.
 */

import { Component, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PageIntroComponent, SectionComponent, StatComponent, EmptyComponent, BannerComponent } from '../../../shared/kit/kit.components';
import { TONE_INK, type Tone } from '../../../shared/kit/tone';

interface CertRow {
  id: string;
  courseCode: string;
  stage: string;
  stageLabel: string;
  name: string;
  hoursLabel: string;
  isOptional: boolean;
  provider: string;
  sourceLabel: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  actualPct: number;
  expectedPct: number;
  showExpected: boolean;
  dueLabel: string;
  dueTone: Tone;
  dueSort: number;
  evidenced: boolean;
}

interface CertView {
  summary: { required: number; completed: number; inProgress: number; overdue: number };
  requiredDone: number;
  requiredTotal: number;
  missingProofCount: number;
  stageOrder: string[];
  stageLabels: Record<string, string>;
  stageCounts: Record<string, number>;
  rows: CertRow[];
}

@Component({
  selector: 'app-student-certifications',
  standalone: true,
  imports: [PageIntroComponent, SectionComponent, StatComponent, EmptyComponent, BannerComponent],
  templateUrl: './certifications.component.html',
  styleUrl: './certifications.component.scss',
})
export class CertificationsComponent {
  readonly toneInk = TONE_INK;
  readonly view = signal<CertView | null>(null);
  readonly error = signal<string | null>(null);
  /// 'ALL' or a Stage key.
  readonly stage = signal<string>('ALL');

  readonly visibleRows = computed(() => {
    const v = this.view();
    if (!v) return [];
    return this.stage() === 'ALL' ? v.rows : v.rows.filter((r) => r.stage === this.stage());
  });

  readonly counts = computed(() => {
    const rows = this.visibleRows();
    return {
      required: rows.filter((r) => !r.isOptional).length,
      completed: rows.filter((r) => r.status === 'COMPLETED').length,
      inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
      overdue: rows.filter((r) => r.status === 'OVERDUE').length,
      optional: rows.filter((r) => r.isOptional).length,
    };
  });

  readonly completedPct = computed(() => {
    const rows = this.visibleRows();
    return rows.length > 0 ? Math.round((this.counts().completed / rows.length) * 100) : 0;
  });

  readonly tabs = computed(() => {
    const v = this.view();
    if (!v) return [];
    return [
      { key: 'ALL', label: `All stages · ${v.rows.length}` },
      ...v.stageOrder.map((s) => ({ key: s, label: `${v.stageLabels[s]} · ${v.stageCounts[s]}` })),
    ];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/certifications`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your certifications.');
        return;
      }
      this.view.set((await res.json()) as CertView);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  setStage(key: string): void {
    this.stage.set(key);
  }

  stageLabel(): string {
    const v = this.view();
    return this.stage() === 'ALL' ? '' : v?.stageLabels[this.stage()] ?? '';
  }
}
