/**
 * Student landing (overview) — the ACTION-LED v2 desktop landing panel.
 *
 * The screen now opens with what the student should DO, then explains where
 * they stand, before the historical analytics:
 *   1. "Your next actions"   — GET /student/next-actions (rule-based to-do list)
 *   2. "Placement readiness" — GET /student/placement-readiness (score + factors)
 *   3. "Recommended for you" — GET /student/recommendations (next-skill nudges)
 *   4. SWOC as four actionable cards
 *   5. Skill badges (locked badges spell out their unlock condition)
 *   6. Analytics below: stage donut, attendance, VTU marks, mocks, streak.
 *
 * Every card is independent — when its endpoint is missing, empty or errors, the
 * card shows its own state and the rest of the screen is unaffected.
 */

import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

interface Dashboard {
  name: string;
  usn: string | null;
  current_stage: string;
  current_semester: number;
  latest_cgpa: number | null;
  attendance_percent: number;
}

interface CourseAttendance {
  course_code: string;
  present: number;
  total: number;
  percent: number;
}
interface AttendanceSummary {
  overall_percent: number;
  present: number;
  total: number;
  by_course: CourseAttendance[];
}

interface SemesterResult {
  semester: number;
  sgpa: number | null;
  cgpa: number | null;
}

interface Streak {
  current: number;
  longest: number;
  days_active: number;
  last_active: string | null;
}

interface SwocItem {
  source: string;
  text: string;
  weight: number;
}
interface SwocBoard {
  strengths: SwocItem[];
  weaknesses: SwocItem[];
  opportunities: SwocItem[];
  challenges: SwocItem[];
}

interface MockAttempt {
  type: string;
  taken_on: string;
  score: number | null;
  max_score: number | null;
  percent: number | null;
  notes: string | null;
}

interface StudentSkill {
  slug: string;
  name: string;
  category: string;
  level: number;
  verified: boolean;
}

/** GET /student/next-actions row (snake_case, verbatim from NextActionOut). */
interface NextAction {
  id: string;
  title: string;
  reason: string;
  cta_label: string;
  cta_route: string;
  status: string;
  deadline: string | null;
  priority: number;
}

/** GET /student/placement-readiness (verbatim from PlacementReadinessOut). */
interface ReadinessFactor {
  label: string;
  met: boolean;
  detail: string;
  weight: number;
}
interface PlacementReadiness {
  score: number;
  band: string;
  summary: string;
  factors: ReadinessFactor[];
}

/** GET /student/recommendations row (verbatim from RecommendationOut). */
interface Recommendation {
  title: string;
  why: string;
  cta_label: string;
  cta_route: string;
}

interface Bar {
  label: string;
  caption: string;
  heightPct: number;
}
interface Badge {
  name: string;
  icon: string;
  locked: boolean;
  title: string;
}

type ChipTone = 'good' | 'warn' | 'risk' | 'neutral';
interface StatusChip {
  cls: ChipTone;
  icon: string;
}

const STAGES: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'Reboot' },
  { key: 'EXCEL', label: 'Excel' },
  { key: 'EXCEL_ADVANCED', label: 'Excel-Adv' },
  { key: 'ELEVATE', label: 'Elevate' },
];

type MockKind = 'GD' | 'INTERVIEW' | 'APTITUDE';

const MOCK_TYPES: { key: MockKind; label: string }[] = [
  { key: 'GD', label: 'GD' },
  { key: 'INTERVIEW', label: 'Interview' },
  { key: 'APTITUDE', label: 'Aptitude' },
];

/** Status-label → chip tone + icon. TEXT is always the label itself, so colour
 *  is never the only signal. Unknown labels fall back to a neutral chip. */
const STATUS_CHIPS: Record<string, StatusChip> = {
  Overdue: { cls: 'risk', icon: 'warning' },
  'In progress': { cls: 'warn', icon: 'schedule' },
  Missing: { cls: 'risk', icon: 'error' },
  Incomplete: { cls: 'warn', icon: 'pending' },
  'Pending review': { cls: 'neutral', icon: 'hourglass_top' },
  Unverified: { cls: 'warn', icon: 'help' },
};

@Component({
  selector: 'app-student-overview',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './student-overview.component.html',
  styleUrl: './student-overview.component.scss',
})
export class StudentOverviewComponent {
  readonly stages = STAGES;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly dashboard = signal<Dashboard | null>(null);
  readonly attendance = signal<AttendanceSummary | null>(null);
  readonly results = signal<SemesterResult[] | null>(null);
  readonly streak = signal<Streak | null>(null);
  readonly swoc = signal<SwocBoard | null>(null);
  readonly mocks = signal<MockAttempt[] | null>(null);
  readonly skills = signal<StudentSkill[] | null>(null);

  // Action-led sections (null = section failed to load → per-card error state).
  readonly nextActions = signal<NextAction[] | null>(null);
  readonly readiness = signal<PlacementReadiness | null>(null);
  readonly recommendations = signal<Recommendation[] | null>(null);

  constructor() {
    void this.load();
  }

  // ---- header --------------------------------------------------------------

  readonly firstName = computed(() => {
    const n = this.dashboard()?.name?.trim() ?? '';
    return n ? n.split(/\s+/)[0] : '';
  });

  readonly stageLabel = computed(() => {
    const key = this.dashboard()?.current_stage;
    return STAGES.find((s) => s.key === key)?.label ?? key ?? '';
  });

  // ---- next actions --------------------------------------------------------

  /** Show the most urgent few; the endpoint already sorts by priority asc. */
  readonly topActions = computed(() => this.nextActions()?.slice(0, 4) ?? []);

  statusChip(status: string): StatusChip {
    return STATUS_CHIPS[status] ?? { cls: 'neutral', icon: 'info' };
  }

  formatDeadline(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---- placement readiness -------------------------------------------------

  bandChip(band: string): ChipTone {
    if (band === 'Ready' || band === 'On track') return 'good';
    if (band === 'Developing') return 'warn';
    return 'risk';
  }

  // ---- stage donut ---------------------------------------------------------

  readonly stagePct = computed(() => {
    const key = this.dashboard()?.current_stage;
    const idx = STAGES.findIndex((s) => s.key === key);
    if (idx < 0) return 0;
    return Math.round(((idx + 1) / STAGES.length) * 100);
  });

  readonly donutStyle = computed(() => {
    const p = this.stagePct();
    return `conic-gradient(var(--amber-600) 0% ${p}%, var(--line) ${p}% 100%)`;
  });

  // ---- attendance bars -----------------------------------------------------

  readonly attendanceBars = computed<Bar[]>(() => {
    const att = this.attendance();
    if (att && att.by_course.length) {
      return att.by_course.slice(0, 6).map((c) => ({
        label: c.course_code,
        caption: `${Math.round(c.percent)}%`,
        heightPct: this.clampH(c.percent),
      }));
    }
    // Fall back to the single overall % the dashboard always carries.
    const d = this.dashboard();
    if (d != null) {
      return [
        {
          label: 'Overall',
          caption: `${Math.round(d.attendance_percent)}%`,
          heightPct: this.clampH(d.attendance_percent),
        },
      ];
    }
    return [];
  });

  // ---- VTU marks bars (per semester, from CGPA/SGPA on a 10-scale) ---------

  readonly marksBars = computed<Bar[]>(() => {
    const rows = this.results();
    if (rows && rows.length) {
      const bars = rows
        .map((r) => ({ sem: r.semester, val: r.cgpa ?? r.sgpa }))
        .filter((r): r is { sem: number; val: number } => r.val != null)
        .map((r) => ({
          label: `Sem ${r.sem}`,
          caption: r.val.toFixed(1),
          heightPct: this.clampH(r.val * 10),
        }));
      if (bars.length) return bars;
    }
    const d = this.dashboard();
    if (d?.latest_cgpa != null) {
      return [
        {
          label: `Sem ${d.current_semester}`,
          caption: d.latest_cgpa.toFixed(1),
          heightPct: this.clampH(d.latest_cgpa * 10),
        },
      ];
    }
    return [];
  });

  // ---- SWOC ----------------------------------------------------------------

  readonly swocBoxes = computed(() => {
    const s = this.swoc();
    if (!s) return null;
    return [
      {
        cls: 'swoc-box swoc-s',
        title: 'Strength',
        text: this.joinSwoc(s.strengths),
        frame: 'Leverage this in your applications and interviews.',
      },
      {
        cls: 'swoc-box swoc-w',
        title: 'Weakness',
        text: this.joinSwoc(s.weaknesses),
        frame: 'Recommended activity — turn this into a skilling goal.',
      },
      {
        cls: 'swoc-box swoc-o',
        title: 'Opportunity',
        text: this.joinSwoc(s.opportunities),
        frame: 'Act before the window closes — check the jobs board and deadlines.',
      },
      {
        cls: 'swoc-box swoc-c',
        title: 'Challenge',
        text: this.joinSwoc(s.challenges),
        frame: 'Plan a prep task now to get ahead of this.',
      },
    ];
  });

  private joinSwoc(items: SwocItem[]): string {
    return items.length ? items.map((i) => i.text).join(' · ') : 'No entries yet';
  }

  // ---- mocks ---------------------------------------------------------------

  readonly mockCounts = computed(() => {
    const rows = this.mocks();
    if (!rows) return null;
    const counts = { GD: 0, INTERVIEW: 0, APTITUDE: 0 };
    for (const m of rows) {
      if (m.type === 'GD' || m.type === 'INTERVIEW' || m.type === 'APTITUDE') {
        counts[m.type] += 1;
      }
    }
    return counts;
  });

  readonly mockSummary = computed(() => {
    const c = this.mockCounts();
    if (!c) return '';
    return `GD: ${c.GD} · Interview: ${c.INTERVIEW} · Aptitude: ${c.APTITUDE}`;
  });

  readonly mockBars = computed<Bar[]>(() => {
    const c = this.mockCounts();
    if (!c) return [];
    const max = Math.max(c.GD, c.INTERVIEW, c.APTITUDE, 1);
    return MOCK_TYPES.map((t) => {
      const n = c[t.key] ?? 0;
      return {
        label: t.label,
        caption: `${n}`,
        heightPct: n > 0 ? Math.max(Math.round((n / max) * 100), 10) : 3,
      };
    });
  });

  readonly hasMocks = computed(() => {
    const c = this.mockCounts();
    return !!c && c.GD + c.INTERVIEW + c.APTITUDE > 0;
  });

  // ---- skill badges --------------------------------------------------------

  readonly badges = computed<Badge[] | null>(() => {
    const rows = this.skills();
    if (!rows) return null;
    // Verified (unlocked) first, then the locked ones, capped for the row.
    const ordered = [...rows].sort((a, b) => Number(b.verified) - Number(a.verified));
    return ordered.slice(0, 8).map((s) => ({
      name: s.name,
      icon: s.verified ? this.skillIcon(s) : 'lock',
      locked: !s.verified,
      title: s.verified
        ? `${s.name} — verified`
        : `Verify a ${s.category} skill to unlock this badge`,
    }));
  });

  private skillIcon(s: StudentSkill): string {
    const hay = `${s.slug} ${s.name} ${s.category}`.toLowerCase();
    if (/excel|spreadsheet/.test(hay)) return 'calculate';
    if (/comm|present|english|speak|writing/.test(hay)) return 'groups';
    if (/analy|data|insight|statist|power ?bi|tableau/.test(hay)) return 'insights';
    if (/sql|database|python|java|code|program|develop/.test(hay)) return 'terminal';
    if (/finance|account|invest|market/.test(hay)) return 'payments';
    if (/lead|manage|strateg/.test(hay)) return 'workspace_premium';
    return 'verified';
  }

  // ---- streak --------------------------------------------------------------

  readonly streakChip = computed(() => {
    const s = this.streak();
    if (!s) return null;
    if (s.current <= 0) return { text: 'No active streak', tone: 'warn' as const };
    return { text: `${s.current}-day login streak`, tone: 'good' as const };
  });

  readonly streakCells = computed<boolean[]>(() => {
    const on = Math.min(this.streak()?.current ?? 0, 7);
    return Array.from({ length: 7 }, (_, i) => i < on);
  });

  // ---- helpers -------------------------------------------------------------

  /// Keep a non-zero value visible (min 6%) while clamping to the chart height.
  private clampH(v: number): number {
    if (v <= 0) return 3;
    return Math.max(6, Math.min(100, Math.round(v)));
  }

  private async load(): Promise<void> {
    const [dash, att, res, streak, swoc, mocks, skills, actions, readiness, recos] =
      await Promise.all([
        this.getJson<Dashboard>('/student/dashboard'),
        this.getJson<AttendanceSummary>('/student/attendance'),
        this.getJson<SemesterResult[]>('/student/results'),
        this.getJson<Streak>('/student/streak'),
        this.getJson<SwocBoard>('/student/swoc'),
        this.getJson<MockAttempt[]>('/student/mocks'),
        this.getJson<StudentSkill[]>('/student/skills'),
        this.getJson<{ actions: NextAction[] }>('/student/next-actions'),
        this.getJson<PlacementReadiness>('/student/placement-readiness'),
        this.getJson<{ items: Recommendation[] }>('/student/recommendations'),
      ]);

    if (dash == null) {
      this.error.set('Could not load your overview.');
      this.loading.set(false);
      return;
    }

    this.dashboard.set(dash);
    this.attendance.set(att);
    this.results.set(res);
    this.streak.set(streak);
    this.swoc.set(swoc);
    this.mocks.set(mocks);
    this.skills.set(skills);
    this.nextActions.set(actions ? actions.actions : null);
    this.readiness.set(readiness);
    this.recommendations.set(recos ? recos.items : null);
    this.loading.set(false);
  }

  /// One shape for every read: null on any non-OK response or network error, so
  /// a missing sub-endpoint becomes a per-card empty state, never a crash.
  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
