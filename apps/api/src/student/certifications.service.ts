/**
 * Student certifications, server-side. Ports getStudentCertifications() plus the
 * per-row shaping the React page did (due label, provenance, pace). The pace
 * status comes from the verbatim-ported progress engine.
 */

import { Injectable } from '@nestjs/common';
import type { ProgressStatus, Stage } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { STAGE_LABEL, STAGE_ORDER } from '../reep/stage';
import { certificationStatus, STATUS_LABEL, formatHours } from '../reep/progress';
import { relativeDay } from '../jobs/relative-day';

type Tone = 'good' | 'warning' | 'critical' | 'info' | 'neutral' | 'accent';

const STATUS_TONE: Record<ProgressStatus, Tone> = {
  COMPLETED: 'good',
  IN_PROGRESS: 'warning',
  OVERDUE: 'critical',
  NOT_STARTED: 'neutral',
};

export interface CertRow {
  id: string;
  courseCode: string;
  stage: Stage;
  stageLabel: string;
  name: string;
  hoursLabel: string;
  isOptional: boolean;
  provider: string;
  sourceLabel: string;
  status: ProgressStatus;
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

export interface CertificationsView {
  summary: { required: number; completed: number; inProgress: number; overdue: number };
  requiredDone: number;
  requiredTotal: number;
  missingProofCount: number;
  stageOrder: Stage[];
  stageLabels: Record<string, string>;
  stageCounts: Record<string, number>;
  rows: CertRow[];
}

@Injectable()
export class CertificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(studentId: string): Promise<CertificationsView> {
    const [certs, proofs] = await Promise.all([
      this.prisma.certificationProgress.findMany({
        where: { studentId },
        select: {
          id: true,
          progressPct: true,
          hoursLogged: true,
          dueDate: true,
          startedAt: true,
          completedAt: true,
          lastSyncedAt: true,
          selfReported: true,
          certCode: true,
          cert: {
            select: {
              name: true,
              provider: true,
              requiredHours: true,
              dueWeek: true,
              isOptional: true,
              courseCode: true,
              course: { select: { stage: true } },
            },
          },
        },
      }),
      this.prisma.upload.findMany({
        where: { studentId, certCode: { not: null }, status: { not: 'REJECTED' } },
        select: { certCode: true },
      }),
    ]);

    const evidenced = new Set(proofs.map((p) => p.certCode));
    const now = new Date();

    const rows: CertRow[] = certs
      .map((c) => {
        const { status, pace } = certificationStatus(
          { progressPct: c.progressPct, dueDate: c.dueDate, startedAt: c.startedAt, completedAt: c.completedAt, cert: { dueWeek: c.cert.dueWeek } },
          now,
        );
        const due = describeDue(status, c.dueDate, c.completedAt, now);
        const provenance = describeSource(c.selfReported, c.lastSyncedAt, now);
        return {
          id: c.id,
          courseCode: c.cert.courseCode,
          stage: c.cert.course.stage,
          stageLabel: STAGE_LABEL[c.cert.course.stage],
          name: c.cert.name,
          hoursLabel: `${formatHours(c.hoursLogged)} of ${formatHours(c.cert.requiredHours)} logged`,
          isOptional: c.cert.isOptional,
          provider: c.cert.provider,
          sourceLabel: `${c.cert.provider} · ${provenance.toLowerCase()}`,
          status,
          statusLabel: STATUS_LABEL[status],
          statusTone: STATUS_TONE[status],
          actualPct: Math.round(pace.actualPct),
          expectedPct: Math.round(pace.expectedPct),
          showExpected: status !== 'COMPLETED',
          dueLabel: due.label,
          dueTone: due.tone,
          dueSort: due.sort,
          evidenced: evidenced.has(c.certCode),
        };
      })
      .sort((a, b) => a.courseCode.localeCompare(b.courseCode));

    const required = rows.filter((r) => !r.isOptional);
    const stageCounts = Object.fromEntries(
      STAGE_ORDER.map((s) => [s, rows.filter((r) => r.stage === s).length]),
    );

    return {
      summary: {
        required: required.length,
        completed: rows.filter((r) => r.status === 'COMPLETED').length,
        inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
        overdue: rows.filter((r) => r.status === 'OVERDUE').length,
      },
      requiredDone: required.filter((r) => r.status === 'COMPLETED').length,
      requiredTotal: required.length,
      missingProofCount: rows.filter((r) => r.status === 'COMPLETED' && !r.evidenced).length,
      stageOrder: STAGE_ORDER,
      stageLabels: STAGE_LABEL,
      stageCounts,
      rows,
    };
  }
}

function describeSource(selfReported: boolean, lastSyncedAt: Date | null, now: Date): string {
  if (selfReported || !lastSyncedAt) return 'Self-reported';
  return `Synced ${relativeDay(lastSyncedAt, now).toLowerCase()}`;
}

function describeDue(
  status: ProgressStatus,
  dueDate: Date,
  completedAt: Date | null,
  now: Date,
): { label: string; tone: Tone; sort: number } {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(dueDate) - startOf(now)) / 86_400_000);

  if (status === 'COMPLETED') {
    const when = completedAt
      ? completedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : null;
    return { label: when ? `Done ${when}` : 'Done', tone: 'good', sort: 10_000 };
  }
  if (days === 0) return { label: 'Due today', tone: 'warning', sort: 0 };
  if (days < 0) {
    const late = Math.abs(days);
    return { label: late === 1 ? '1 day overdue' : `${late} days overdue`, tone: 'critical', sort: days };
  }
  return {
    label: days === 1 ? '1 day left' : `${days} days left`,
    tone: days <= 7 ? 'warning' : 'neutral',
    sort: days,
  };
}
