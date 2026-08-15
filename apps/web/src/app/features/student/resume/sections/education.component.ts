/**
 * Resume Builder · Education section (rb-education).
 *
 * A read-only mirror of the student's academic record — it does NOT touch the
 * shared ResumeBuilderService map. The semester CGPA/backlog table, prior
 * qualifications and declared academic gaps are staff/registrar owned and edits
 * route through a mentor approval workflow, so this panel only renders and shows
 * the "edits require approval" notice.
 *
 * Two own endpoints back it (both cookie-authenticated GETs):
 *   - GET /student/results   -> SemesterResultOut[]  (the CGPA/backlog table)
 *   - GET /student/academics -> { qualifications, gap } (prior degrees + gaps)
 *
 * Matches the `data-p="education"` panel in docs/design-v2/resume-builder.html,
 * reusing the global reep-v2 classes (.notice/.card/.tbl/.entry/.empty/.field).
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../../environments/environment';

type Level = 'TENTH' | 'TWELFTH' | 'DIPLOMA' | 'UNDERGRAD' | 'POSTGRAD';

/** One prior qualification, verbatim from QualificationOut (snake_case). */
interface Qualification {
  level: Level;
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

/** AcademicGapOut — months between stages plus the server-summed total. */
interface Gap {
  twelfth_to_grad_mo: number;
  diploma_to_grad_mo: number;
  grad_to_pg_mo: number;
  other_mo: number;
  total_mo: number;
}

interface AcademicsResponse {
  qualifications: Qualification[];
  gap: Gap;
}

/** One row of GET /student/results (SemesterResultOut) — the fields the table uses. */
interface SemesterResult {
  semester: number;
  cgpa: number | null;
  closed_backlogs: number;
  live_backlogs: number;
}

const LEVEL_LABEL: Record<Level, string> = {
  TENTH: '10th standard',
  TWELFTH: '12th standard',
  DIPLOMA: 'Diploma',
  UNDERGRAD: 'Undergraduate',
  POSTGRAD: 'Postgraduate',
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

@Component({
  selector: 'rb-education',
  standalone: true,
  template: `
    @if (error()) {
      <div class="notice info">
        <span class="icon">error</span>
        <div>{{ error() }}</div>
      </div>
    } @else if (!loaded()) {
      <div class="empty"><span class="icon">hourglass_top</span><p>Loading your academic record…</p></div>
    } @else {
      <div class="notice info">
        <span class="icon">verified_user</span>
        <div>
          <b>Academic records require approval.</b> Edits here are submitted to your mentor rather
          than saved silently, because CGPA and backlog figures feed placement eligibility.
        </div>
      </div>

      <!-- Semester record: CGPA + backlogs (GET /student/results), read-only -->
      <div class="card">
        <h3>Semester record</h3>
        <div class="desc">
          Aggregate CGPA and backlogs are imported by the office. Each marksheet lives on its row in
          Attachments, so the proof and the number stay together.
        </div>
        @if (semesters().length === 0) {
          <div class="empty" style="padding:26px;">
            <span class="icon">table_rows</span><p>No semester results imported yet.</p>
          </div>
        } @else {
          <table class="tbl">
            <tr>
              <th>Year</th>
              <th>Semester</th>
              <th class="num">Aggregate CGPA</th>
              <th class="num">Closed backlogs</th>
              <th class="num">Live backlogs</th>
              <th>Marksheet</th>
            </tr>
            @for (s of semesters(); track s.semester) {
              <tr>
                <td>{{ year(s.semester) }}</td>
                <td>{{ roman(s.semester) }}</td>
                <td class="num">{{ s.cgpa != null ? s.cgpa : '—' }}</td>
                <td class="num">{{ s.closed_backlogs }}</td>
                <td class="num">{{ s.live_backlogs }}</td>
                <td style="color:var(--ink-400); font-size:11.5px;">In Attachments</td>
              </tr>
            }
            @if (aggregate(); as agg) {
              <tr>
                <td colspan="2"><b>Aggregate <span class="req" style="color:var(--risk)">*</span></b></td>
                <td class="num"><b>{{ agg.cgpa != null ? agg.cgpa : '—' }}</b></td>
                <td class="num"><b>{{ agg.closed }}</b></td>
                <td class="num"><b>{{ agg.live }}</b></td>
                <td></td>
              </tr>
            }
          </table>
        }
      </div>

      <!-- Other degrees (UG / PG prior qualifications) -->
      <div class="card">
        <h3>Other degrees</h3>
        @if (degrees().length === 0) {
          <div class="empty" style="padding:26px;">
            <span class="icon">school</span><p>No prior degrees on record.</p>
          </div>
        } @else {
          @for (q of degrees(); track $index) {
            <div class="entry">
              <div class="tools"><button type="button"><span class="icon" style="font-size:17px">visibility</span></button></div>
              <h4>
                {{ levelLabel(q.level) }}
                @if (q.subjects) { <span class="tag">{{ q.subjects }}</span> }
              </h4>
              <div class="org">{{ q.institution }}</div>
              <div class="meta">
                {{ q.board ? q.board + ' · ' : '' }}{{ q.year }} · {{ q.marks }} / {{ q.max_marks }}
                @if (q.percent) { ({{ q.percent }}%) }
              </div>
              @if (q.medium || q.location) {
                <div class="meta">
                  {{ q.medium ? 'Medium: ' + q.medium : '' }}{{ q.medium && q.location ? ' · ' : '' }}{{ q.location }}
                </div>
              }
            </div>
          }
        }
      </div>

      <!-- 12th / 10th -->
      <div class="grid2">
        <div class="card" style="margin-bottom:0;">
          <h3>12th standard</h3>
          @if (twelfth().length === 0) {
            <div class="empty" style="padding:26px;"><span class="icon">school</span><p>No 12th record added.</p></div>
          } @else {
            @for (q of twelfth(); track $index) {
              <div class="entry">
                <div class="tools"><button type="button"><span class="icon" style="font-size:17px">visibility</span></button></div>
                <h4>{{ q.institution }}</h4>
                <div class="meta">{{ q.board ? q.board + ' — ' : '' }}{{ q.year }} · {{ q.marks }} / {{ q.max_marks }}</div>
                @if (q.subjects || q.medium) {
                  <div class="meta">
                    {{ q.subjects ? 'Subjects: ' + q.subjects : '' }}{{ q.subjects && q.medium ? ' · ' : '' }}{{ q.medium ? 'Medium: ' + q.medium : '' }}
                  </div>
                }
              </div>
            }
          }
        </div>
        <div class="card" style="margin-bottom:0;">
          <h3>10th standard</h3>
          @if (tenth().length === 0) {
            <div class="empty" style="padding:26px;"><span class="icon">school</span><p>No 10th record added.</p></div>
          } @else {
            @for (q of tenth(); track $index) {
              <div class="entry">
                <div class="tools"><button type="button"><span class="icon" style="font-size:17px">visibility</span></button></div>
                <h4>{{ q.institution }}</h4>
                <div class="meta">{{ q.board ? q.board + ' — ' : '' }}{{ q.year }} · {{ q.marks }} / {{ q.max_marks }}</div>
                @if (q.medium) { <div class="meta">Medium: {{ q.medium }}</div> }
              </div>
            }
          }
        </div>
      </div>

      <!-- Diploma -->
      <div class="card" style="margin-top:18px;">
        <h3>Diploma (equivalent to 12th)</h3>
        @if (diploma().length === 0) {
          <div class="empty" style="padding:26px;"><span class="icon">school</span><p>No diploma record added.</p></div>
        } @else {
          @for (q of diploma(); track $index) {
            <div class="entry">
              <div class="tools"><button type="button"><span class="icon" style="font-size:17px">visibility</span></button></div>
              <h4>{{ q.institution }}</h4>
              <div class="meta">{{ q.board ? q.board + ' — ' : '' }}{{ q.year }} · {{ q.marks }} / {{ q.max_marks }}</div>
              @if (q.subjects) { <div class="meta">Subjects: {{ q.subjects }}</div> }
            </div>
          }
        }
      </div>

      <!-- Academic gaps (read-only) -->
      <div class="card">
        <h3>Academic gaps</h3>
        <div class="desc">
          Recruiters ask about these directly. Declaring them means the resume can explain rather
          than leave a hole. Managed with your mentor.
        </div>
        <div class="grid4">
          <div class="field"><label>12th → graduation (months)</label><input class="ctrl" [value]="gap().twelfth_to_grad_mo" disabled></div>
          <div class="field"><label>Diploma → graduation (months)</label><input class="ctrl" [value]="gap().diploma_to_grad_mo" disabled></div>
          <div class="field"><label>Graduation → PG (months)</label><input class="ctrl" [value]="gap().grad_to_pg_mo" disabled></div>
          <div class="field"><label>Other gap (months)</label><input class="ctrl" [value]="gap().other_mo" disabled></div>
        </div>
        <div class="desc" style="margin:0;">Total declared gap: <b>{{ gap().total_mo }}</b> months.</div>
      </div>
    }
  `,
})
export class RbEducationComponent {
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  readonly quals = signal<Qualification[]>([]);
  readonly gap = signal<Gap>({
    twelfth_to_grad_mo: 0,
    diploma_to_grad_mo: 0,
    grad_to_pg_mo: 0,
    other_mo: 0,
    total_mo: 0,
  });
  readonly semesters = signal<SemesterResult[]>([]);

  readonly degrees = computed(() =>
    this.quals().filter((q) => q.level === 'UNDERGRAD' || q.level === 'POSTGRAD'),
  );
  readonly twelfth = computed(() => this.quals().filter((q) => q.level === 'TWELFTH'));
  readonly tenth = computed(() => this.quals().filter((q) => q.level === 'TENTH'));
  readonly diploma = computed(() => this.quals().filter((q) => q.level === 'DIPLOMA'));

  /** Aggregate row: cumulative CGPA is the latest semester's, backlogs are summed. */
  readonly aggregate = computed(() => {
    const rows = this.semesters();
    if (rows.length === 0) return null;
    const withCgpa = rows.filter((r) => r.cgpa != null);
    return {
      cgpa: withCgpa.length ? withCgpa[withCgpa.length - 1].cgpa : null,
      closed: rows.reduce((a, r) => a + r.closed_backlogs, 0),
      live: rows.reduce((a, r) => a + r.live_backlogs, 0),
    };
  });

  constructor() {
    void this.load();
  }

  levelLabel(level: Level): string {
    return LEVEL_LABEL[level] ?? level;
  }

  year(semester: number): number {
    return Math.ceil(semester / 2);
  }

  roman(semester: number): string {
    return ROMAN[semester] ?? String(semester);
  }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      const [resultsRes, academicsRes] = await Promise.all([
        fetch(`${environment.apiBase}/student/results`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/student/academics`, { credentials: 'include' }),
      ]);
      if (!resultsRes.ok || !academicsRes.ok) {
        this.error.set('Could not load your academic record.');
        return;
      }
      const results = (await resultsRes.json()) as SemesterResult[];
      const academics = (await academicsRes.json()) as AcademicsResponse;
      this.semesters.set(results);
      this.quals.set(academics.qualifications ?? []);
      if (academics.gap) this.gap.set(academics.gap);
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }
}
