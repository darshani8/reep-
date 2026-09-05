/**
 * The student landing screen — the handoff's Landing panel in full.
 *
 * Top to bottom: the greeting and login-streak chip; the three programme stage
 * cards (Reboot · Excel · Elevate) with the status legend; attendance by course
 * beside the VTU marks line chart; the Academic History section (10th / 12th /
 * UG cards and the declared education gaps); placement readiness beside the
 * recommendations; and the stat strip (stage donut, skill badges, mocks taken,
 * login streak). Every card carries its own empty state, exactly as the design
 * writes them, so a fresh student sees the same page shape as a senior one.
 *
 * TWO READS, NOT TWELVE. `GET /student/overview` is the aggregate the API
 * composes in one DB session for exactly this screen (dashboard, attendance,
 * results, streak, mocks, skills, readiness, recommendations — and now the
 * academic history); `GET /student/programme` is the stage catalogue with this
 * student's status per item. Only the overview decides the page's state: the
 * programme failing degrades the three cards, not the whole landing.
 *
 * The stage cards come from a code catalogue where only a student's STATUS is a
 * row (see app/models/milestone.py). A row with a `route` navigates — English
 * Baseline to its own screen, Mock Interview to the mock interviewer — and the
 * component keeps whatever route the API gives rather than mapping keys itself.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';

// ---- GET /student/programme ------------------------------------------------

interface ProgrammeItem {
  key: string;
  label: string;
  route: string | null;
  status: string;
  glyph: string;
  tone: 'good' | 'warn' | 'neutral';
  title: string;
}

interface Stage {
  key: string;
  label: string;
  completed: number;
  total: number;
  items: ProgrammeItem[];
}

interface Programme {
  stages: Stage[];
  completed: number;
  total: number;
  percent: number;
}

// ---- GET /student/overview (snake_case, verbatim from the API) --------------

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

interface Recommendation {
  title: string;
  why: string;
  cta_label: string;
  cta_route: string;
}

interface Qualification {
  level: string;
  institution: string;
  board: string | null;
  year: number;
  marks: number;
  max_marks: number;
  percent: number;
  medium: string | null;
  location: string | null;
  subjects: string | null;
}
interface AcademicGap {
  twelfth_to_grad_mo: number;
  diploma_to_grad_mo: number;
  grad_to_pg_mo: number;
  other_mo: number;
  total_mo: number;
}
interface Academics {
  qualifications: Qualification[];
  gap: AcademicGap;
}

interface Overview {
  dashboard: Dashboard;
  attendance: AttendanceSummary | null;
  results: SemesterResult[] | null;
  streak: Streak | null;
  mocks: MockAttempt[] | null;
  skills: StudentSkill[] | null;
  placement_readiness: PlacementReadiness | null;
  recommendations: { items: Recommendation[] } | null;
  academics: Academics | null;
}

// ---- view models -------------------------------------------------------------

type ChipTone = 'good' | 'warn' | 'risk' | 'neutral';

interface AttendanceBar {
  label: string;
  percent: number;
  caption: string;
}

interface MarksPoint {
  sem: number;
  x: number;
  y: number;
  label: string;
}
interface MarksChart {
  semesters: string[];
  points: MarksPoint[];
  solid: string;
  dashed: string;
  caption: string;
  aria: string;
}

interface QualificationCard {
  level: string;
  institution: string;
  board: string | null;
  year: number;
  percent: string;
  marks: string;
  medium: string | null;
  location: string | null;
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

/** The programme's stage names, in order — the donut's caption and the header's
 *  "Excel-Adv stage" both read from here. */
const STAGES: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'Reboot' },
  { key: 'EXCEL', label: 'Excel' },
  { key: 'EXCEL_ADVANCED', label: 'Excel-Adv' },
  { key: 'ELEVATE', label: 'Elevate' },
];

/** The three cards' names when the programme read itself fails, so the page
 *  keeps its shape and the cards can say why they are empty. */
const STAGE_CARD_LABELS = ['Reboot', 'Excel', 'Elevate'];

const QUALIFICATION_LABEL: Record<string, string> = {
  TENTH: '10th Standard',
  TWELFTH: '12th Standard',
  DIPLOMA: 'Diploma',
  UNDERGRAD: 'Undergraduate',
  POSTGRAD: 'Postgraduate',
};

const GAP_LABEL: [keyof AcademicGap, string][] = [
  ['twelfth_to_grad_mo', '12th → graduation'],
  ['diploma_to_grad_mo', 'Diploma → graduation'],
  ['grad_to_pg_mo', 'Graduation → PG'],
  ['other_mo', 'Other'],
];

type MockKind = 'GD' | 'INTERVIEW' | 'APTITUDE';
const MOCK_TYPES: { key: MockKind; label: string }[] = [
  { key: 'GD', label: 'GD' },
  { key: 'INTERVIEW', label: 'Interview' },
  { key: 'APTITUDE', label: 'Aptitude' },
];

/** An MBA is four semesters; the chart always draws at least that many so the
 *  unpublished ones read as "not yet" rather than as absent. */
const MIN_SEMESTERS = 4;

@Component({
  selector: 'app-student-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class StudentHomeComponent {
  private readonly auth = inject(AuthService);

  readonly stageCardLabels = STAGE_CARD_LABELS;
  readonly gapLabels = GAP_LABEL;

  readonly state = signal<'loading' | 'data' | 'error'>('loading');
  readonly overview = signal<Overview | null>(null);
  readonly programme = signal<Programme | null>(null);
  /** True when the programme read failed while the overview succeeded. */
  readonly programmeError = signal(false);

  constructor() {
    void this.load();
  }

  // ---- header ----------------------------------------------------------------

  /** First name only — the greeting reads "Welcome back, Asha", not a full legal
   *  name. The dashboard carries the session's name; the session itself is the
   *  fallback while the read is in flight. */
  readonly firstName = computed(() => {
    const name = (this.overview()?.dashboard.name ?? this.auth.session()?.name ?? '').trim();
    return name ? name.split(/\s+/)[0] : null;
  });

  readonly subline = computed(() => {
    const d = this.overview()?.dashboard;
    if (!d) return null;
    const stage = STAGES.find((s) => s.key === d.current_stage)?.label ?? this.prettify(d.current_stage);
    const parts = [`${stage} stage`, `Semester ${d.current_semester}`];
    if (d.usn) parts.push(d.usn);
    return parts.join(' · ');
  });

  readonly streak = computed(() => this.overview()?.streak ?? null);

  // ---- attendance --------------------------------------------------------------

  readonly attendanceBars = computed<AttendanceBar[]>(() => {
    const att = this.overview()?.attendance;
    if (!att) return [];
    if (att.by_course.length) {
      return att.by_course.map((c) => ({
        label: c.course_code,
        percent: this.clampPct(c.percent),
        caption: `${Math.round(c.percent)}%`,
      }));
    }
    // Attendance recorded but not broken down by course: one overall row is
    // still the truth, so it is shown rather than the empty line.
    if (att.total > 0) {
      return [
        {
          label: 'Overall',
          percent: this.clampPct(att.overall_percent),
          caption: `${Math.round(att.overall_percent)}%`,
        },
      ];
    }
    return [];
  });

  // ---- VTU marks -----------------------------------------------------------------

  readonly marksChart = computed<MarksChart | null>(() => {
    const rows = this.overview()?.results ?? [];
    const published = rows
      .map((r) => ({ sem: r.semester, val: r.cgpa ?? r.sgpa }))
      .filter((r): r is { sem: number; val: number } => r.val != null)
      .sort((a, b) => a.sem - b.sem);
    if (!published.length) return null;

    const n = Math.max(MIN_SEMESTERS, ...published.map((p) => p.sem));
    const x = (sem: number) => ((sem - 0.5) / n) * 100;
    const y = (val: number) => 100 - Math.max(0, Math.min(10, val)) * 10;

    const points = published.map((p) => ({
      sem: p.sem,
      x: x(p.sem),
      y: y(p.val),
      label: p.val.toFixed(1),
    }));
    const solid = points.map((p) => `${p.x},${p.y}`).join(' ');

    // The dashed continuation holds the last published value across the
    // semesters still to come — a flat "not yet" line, never a projection.
    const last = points[points.length - 1];
    const pending = Array.from({ length: n }, (_, i) => i + 1).filter(
      (sem) => !published.some((p) => p.sem === sem),
    );
    const future = pending.filter((sem) => sem > last.sem);
    const dashed = future.length
      ? [last, ...future.map((sem) => ({ x: x(sem), y: last.y }))]
          .map((p) => `${p.x},${p.y}`)
          .join(' ')
      : '';

    const semesters = Array.from({ length: n }, (_, i) => `Sem ${i + 1}`);
    const caption = pending.length
      ? `CGPA out of 10 · ${this.semRange(pending)} not published yet`
      : 'CGPA out of 10';
    const aria =
      'CGPA by semester: ' +
      points.map((p) => `Sem ${p.sem} ${p.label}`).join(', ') +
      (pending.length ? `; ${this.semRange(pending)} not published yet` : '');

    return { semesters, points, solid, dashed, caption, aria };
  });

  readonly marksAxis = [10, 8, 6, 4, 2, 0];

  // ---- academic history ----------------------------------------------------------

  readonly qualifications = computed<QualificationCard[]>(() => {
    const quals = this.overview()?.academics?.qualifications ?? [];
    return quals.map((q) => ({
      level: QUALIFICATION_LABEL[q.level] ?? this.prettify(q.level),
      institution: q.institution,
      board: q.board,
      year: q.year,
      percent: `${Math.round(q.percent)}%`,
      marks: `${this.trimNumber(q.marks)} / ${this.trimNumber(q.max_marks)}`,
      medium: q.medium,
      location: q.location,
    }));
  });

  readonly gap = computed(() => this.overview()?.academics?.gap ?? null);

  /** Only the gap lines with months in them — a zero line says nothing. */
  readonly gapLines = computed(() => {
    const g = this.gap();
    if (!g) return [];
    return GAP_LABEL.filter(([key]) => g[key] > 0).map(([key, label]) => ({
      label,
      months: g[key],
    }));
  });

  // ---- placement readiness -----------------------------------------------------

  readonly readiness = computed(() => this.overview()?.placement_readiness ?? null);

  bandChip(band: string): ChipTone {
    if (band === 'Ready' || band === 'On track') return 'good';
    if (band === 'Developing') return 'warn';
    return 'risk';
  }

  readonly recommendations = computed<Recommendation[] | null>(() => {
    const r = this.overview()?.recommendations;
    return r ? r.items : null;
  });

  // ---- stage donut -----------------------------------------------------------------

  readonly stagePct = computed(() => {
    const key = this.overview()?.dashboard.current_stage;
    const idx = STAGES.findIndex((s) => s.key === key);
    if (idx < 0) return 0;
    return Math.round(((idx + 1) / STAGES.length) * 100);
  });

  readonly donutStyle = computed(() => {
    const p = this.stagePct();
    return `conic-gradient(var(--purple-mid) 0% ${p}%, var(--hairline) ${p}% 100%)`;
  });

  // ---- skill badges ---------------------------------------------------------------

  readonly badges = computed<Badge[] | null>(() => {
    const rows = this.overview()?.skills;
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
    if (/comm|present|english|speak|writing/.test(hay)) return 'groups';
    if (/analy|data|insight|statist|power ?bi|tableau|excel|spreadsheet/.test(hay)) return 'insights';
    if (/sql|database|python|java|code|program|develop/.test(hay)) return 'keyboard';
    if (/lead|manage|strateg/.test(hay)) return 'workspace_premium';
    return 'verified';
  }

  // ---- mocks -----------------------------------------------------------------------

  readonly mockCounts = computed(() => {
    const rows = this.overview()?.mocks;
    if (!rows) return null;
    const counts: Record<MockKind, number> = { GD: 0, INTERVIEW: 0, APTITUDE: 0 };
    for (const m of rows) {
      if (m.type === 'GD' || m.type === 'INTERVIEW' || m.type === 'APTITUDE') counts[m.type] += 1;
    }
    return counts;
  });

  readonly hasMocks = computed(() => {
    const c = this.mockCounts();
    return !!c && c.GD + c.INTERVIEW + c.APTITUDE > 0;
  });

  readonly mockSummary = computed(() => {
    const c = this.mockCounts();
    return c ? `GD: ${c.GD} · Interview: ${c.INTERVIEW} · Aptitude: ${c.APTITUDE}` : '';
  });

  readonly mockBars = computed<Bar[]>(() => {
    const c = this.mockCounts();
    if (!c) return [];
    const max = Math.max(c.GD, c.INTERVIEW, c.APTITUDE, 1);
    return MOCK_TYPES.map((t) => {
      const n = c[t.key];
      return {
        label: t.label,
        caption: `${n}`,
        heightPct: n > 0 ? Math.max(Math.round((n / max) * 100), 10) : 3,
      };
    });
  });

  // ---- streak ------------------------------------------------------------------------

  readonly streakCells = computed<boolean[]>(() => {
    const on = Math.min(this.streak()?.current ?? 0, 7);
    return Array.from({ length: 7 }, (_, i) => i < on);
  });

  // ---- loading -------------------------------------------------------------------------

  async load(): Promise<void> {
    this.state.set('loading');
    this.programmeError.set(false);
    const [overview, programme] = await Promise.allSettled([
      this.get<Overview>('/student/overview'),
      this.get<Programme>('/student/programme'),
    ]);

    if (programme.status === 'fulfilled') this.programme.set(programme.value);
    else this.programmeError.set(true);

    if (overview.status === 'fulfilled' && overview.value?.dashboard) {
      this.overview.set(overview.value);
      this.state.set('data');
    } else {
      this.state.set('error');
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  }

  // ---- helpers ---------------------------------------------------------------------------

  private clampPct(v: number): number {
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  private prettify(value: string): string {
    const words = value.replace(/_/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /** 88 → "88", 88.5 → "88.5" — marks print as recorded, without a trailing .0. */
  private trimNumber(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  /** [3, 4] → "Sem 3–4"; [4] → "Sem 4"; [2, 4] → "Sem 2, 4". */
  private semRange(sems: number[]): string {
    if (sems.length === 1) return `Sem ${sems[0]}`;
    const contiguous = sems.every((s, i) => i === 0 || s === sems[i - 1] + 1);
    return contiguous ? `Sem ${sems[0]}–${sems[sems.length - 1]}` : `Sem ${sems.join(', ')}`;
  }
}
