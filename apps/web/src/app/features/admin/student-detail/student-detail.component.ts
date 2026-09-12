/**
 * Student 360 — one student, across every semester (spec §6, board
 * `design/admin/StudentDetail.html`).
 *
 * THIS SCREEN NAMES ONE STUDENT AND MUST NEVER WIDEN TO A LIST. Everything it
 * draws is that student's private record — marks, attendance, interviews,
 * mentor notes — so every read is by id and every refusal is theirs. The one
 * read that is not by id is the roster call below, and it is the reason B4.5
 * exists.
 *
 * WHAT IS LIVE, AND ON WHICH ENDPOINT THAT EXISTS ON `main` TODAY.
 *   GET   /api/admin/students                      the identity row — see below
 *   GET   /api/admin/students/{id}/weekly          six weeks of attendance and
 *                                                  ledger hours, verified skills
 *   GET   /api/mentor/students/{id}/interviews     every mock interview
 *   GET   /api/mentor/students/{id}/badges         earned / total / points
 *   GET   /api/mentor/students/{id}/ledger/summary the last 14 days
 *   GET   /api/mentor/students/{id}/english-baseline the CEFR attempt
 *   GET   /api/admin/cohorts                       the batches, for Move batch
 *   PATCH /api/admin/students/{id}                 Edit profile and Move batch
 *
 * THE IDENTITY ROW COMES FROM THE ROSTER, AND THAT IS THE COMPROMISE THIS
 * SCREEN IS WAITING ON. There is no `GET /api/admin/students/{id}` on `main`;
 * the composite read is B4.5 (Phase 4). So the row is picked out of the roster
 * list and the list is discarded in the same statement — never stored, never
 * rendered — because this screen must show one student and not a roster. When
 * B4.5 lands, `loadIdentity()` is the one function that changes.
 *
 * TWO OF THE READS ARE EXPECTED TO BE REFUSED, AND THE SCREEN SAYS SO RATHER
 * THAN LOOKING BROKEN. The ledger and the English baseline are gated on
 * `mentor.mentees`, which `_FACULTY_ONLY` in `app/governance.py` deliberately
 * keeps OUT of the Main Admin's baseline: the office account has no mentees.
 * The office grants itself that function in Governance when it needs to look,
 * with a reason, on the audit trail. A 403 there is the system working, so the
 * card prints the server's own sentence instead of an empty state that reads
 * as a bug.
 *
 * WHAT THE BOARD DRAWS THAT NOTHING CAN ANSWER YET, AND HOW IT IS DRAWN.
 * Per-semester results, ledger compliance and badge counts; the mentor's
 * history and handover window; the consent grant and the daily interview cap;
 * the weighted readiness score; Open items' uploads and claims; the other four
 * kinds of Recent activity. Each renders its EMPTY state and one
 * `.notice.accent` saying which task fills it — B4.1 (course shape), B4.5
 * (composite read), B6.3 (readiness inputs), B6.4 (cap reset), B9.1 (mentor
 * history) — and the controls that need an endpoint render disabled through
 * `PendingControlDirective`. A plausible number in a screenshot is
 * indistinguishable from working software.
 *
 * "NOTHING IS REWRITTEN ON PROMOTION" is the board's own headline on the
 * timeline and it is true of the schema today: promotion increments
 * `students.current_semester` and every other table keeps the semester number
 * it was written with. The copy stays.
 *
 * RE-SEND INVITE IS NOT A STUDENT ACTION AND IS NOT DRAWN AS ONE. The board
 * shows it; `issue_activation` refuses a STUDENT on purpose, because a
 * student's equivalent is the onboarding walk, which proves the mailbox with a
 * six-digit code before a password is set. The control is disabled and the
 * card says where the link actually comes from.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { plural } from '../../../shared/text/plural.pipe';
import {
  type ActivityEntry,
  type AdminStudentOut,
  type BadgeDashboardOut,
  type CohortOut,
  type EnglishBaselineOut,
  HIGHEST_SEMESTER,
  type InterviewSessionOut,
  type LedgerSummaryOut,
  NOT_READABLE,
  STAGES,
  type SemesterStep,
  type StudentWeeklyOut,
  formatDay,
  formatMoment,
  initialsOf,
  interviewActivityOf,
  interviewTallyOf,
  meanAttendancePercentOf,
  percentOf,
  semesterStepsUpTo,
  stageLabelOf,
} from './student-record';

/** Days of ledger history the summary card asks for — the same fortnight a
 *  mentor opens the ledger to judge "are they keeping it up". */
const LEDGER_WINDOW_DAYS = 14;

/** Activity lines the card shows before it stops. The board draws five. */
const RECENT_ACTIVITY_LINES = 5;

/** One read's outcome: the body, or the server's own sentence for refusing. */
interface ReadResult<T> {
  value: T | null;
  refusal: string | null;
}

@Component({
  selector: 'app-admin-student-detail',
  standalone: true,
  imports: [RouterLink, PendingControlDirective],
  templateUrl: './student-detail.component.html',
  styleUrl: './student-detail.component.scss',
})
export class AdminStudentDetailComponent {
  private readonly route = inject(ActivatedRoute);

  readonly studentId = this.route.snapshot.paramMap.get('id') ?? '';

  // --- what the screen has read -------------------------------------------

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly student = signal<AdminStudentOut | null>(null);
  readonly weekly = signal<StudentWeeklyOut | null>(null);
  readonly interviews = signal<InterviewSessionOut[]>([]);
  readonly badges = signal<BadgeDashboardOut | null>(null);
  readonly ledger = signal<LedgerSummaryOut | null>(null);
  readonly english = signal<EnglishBaselineOut | null>(null);
  readonly batches = signal<CohortOut[]>([]);

  /** Why the two `mentor.mentees` reads did not answer, in the API's own
   *  words. Almost always "You do not hold the 'Mentee log' capability", which
   *  is the Main Admin's baseline working as designed. */
  readonly menteeReadsRefusal = signal<string | null>(null);

  /** Why the batch list did not answer, if it did not. The select is then
   *  empty and the editor says why rather than looking broken. */
  readonly batchesRefusal = signal<string | null>(null);

  /** Why the six-week read did not answer, if it did not. `/weekly` is gated
   *  on `admin.analytics`, which this screen's own capability
   *  (`admin.students`, spec §6) does not imply: a faculty member granted the
   *  roster and not Analytics is refused here. That refusal used to render as
   *  "no sessions in the last six weeks", which is a claim about the student
   *  made out of a read that never happened. */
  readonly weeklyRefusal = signal<string | null>(null);

  // --- the editor ---------------------------------------------------------

  readonly editorOpen = signal(false);
  /** Which button opened the editor. `batch` adds the line that says so; both
   *  save through the same PATCH, because moving a batch IS editing a
   *  student and two write paths for one field is how they drift. */
  readonly editorIntent = signal<'profile' | 'batch'>('profile');

  readonly formName = signal('');
  readonly formEmail = signal('');
  readonly formUsn = signal('');
  readonly formBatchId = signal('');
  readonly formStage = signal('');
  readonly formSemester = signal(1);

  readonly stages = STAGES;
  readonly semesters: number[] = Array.from(
    { length: HIGHEST_SEMESTER },
    (_unused, index) => index + 1,
  );

  readonly notReadable = NOT_READABLE;

  constructor() {
    void this.loadEverything();
  }

  // --- the header ---------------------------------------------------------

  readonly studentName = computed(() => this.student()?.name ?? 'Student');

  readonly usnLabel = computed(() => this.student()?.usn ?? NOT_READABLE);

  readonly batchLabel = computed(() => this.student()?.batch ?? 'No batch yet');

  readonly departmentLabel = computed(() => this.student()?.department ?? 'No department yet');

  readonly mentorName = computed(() => this.student()?.mentor_name ?? null);

  readonly mentorInitials = computed(() => {
    const name = this.mentorName();
    if (name === null) {
      return '?';
    }
    return initialsOf(name);
  });

  readonly stageLabel = computed(() => {
    const row = this.student();
    if (row === null) {
      return NOT_READABLE;
    }
    return stageLabelOf(row.current_stage);
  });

  /** "Active" once they have signed in at least once, "Invited" until then —
   *  the same reading the roster grid gives the same column.
   *
   *  NULL-SAFE ON PURPOSE. `this.student()?.last_login_at !== null` reads
   *  `undefined !== null`, which is TRUE, so before the row is read — and
   *  after a refused read — the header printed a green "Active" chip for a
   *  student nobody had looked up. The chip is only drawn once there is a row
   *  (the template guards on `student()`); this keeps the computed honest if
   *  it is ever read from anywhere else. */
  readonly hasSignedIn = computed(() => {
    const row = this.student();
    return row !== null && row.last_login_at !== null;
  });

  readonly accountStatusLabel = computed(() => (this.hasSignedIn() ? 'Active' : 'Invited'));

  readonly semesterLine = computed(() => {
    const row = this.student();
    if (row === null) {
      return NOT_READABLE;
    }
    return `semester ${row.current_semester}`;
  });

  readonly enrolledLabel = computed(() => formatDay(this.student()?.enrolled_at ?? null));

  readonly lastSignInLabel = computed(() => {
    const row = this.student();
    if (row === null || row.last_login_at === null) {
      return 'Has not signed in yet';
    }
    return formatMoment(row.last_login_at);
  });

  // --- semester timeline --------------------------------------------------

  readonly semesterSteps = computed<SemesterStep[]>(() => {
    const row = this.student();
    if (row === null) {
      return [];
    }
    return semesterStepsUpTo(row.current_semester);
  });

  // --- readiness inputs (the score itself is B6.3) ------------------------

  readonly meanAttendancePercent = computed(() => meanAttendancePercentOf(this.weekly()));

  /** What the attendance meter says instead of a bar. "No sessions" is a fact
   *  about the six weeks and may only be printed when the six weeks were
   *  actually read; an unread window says so. */
  readonly attendanceNoneLine = computed(() => {
    if (this.weekly() === null) {
      return 'not readable';
    }
    return 'no sessions in the last six weeks';
  });

  readonly badgesEarnedPercent = computed(() => {
    const dashboard = this.badges();
    if (dashboard === null) {
      return null;
    }
    return percentOf(dashboard.earned_total, dashboard.badge_total);
  });

  readonly interviewTally = computed(() => interviewTallyOf(this.interviews()));

  readonly bestInterviewScore = computed(() => this.interviewTally().bestScore);

  /** What the meter says instead of a bar. "3 sat, none scored" and "none sat"
   *  are different facts, and neither is a zero. */
  readonly interviewsSatLine = computed(() => {
    const tally = this.interviewTally();
    if (tally.total === 0) {
      return 'none sat';
    }
    return `${tally.total} sat, none scored`;
  });

  readonly ledgerSubmittedPercent = computed(() => {
    const summary = this.ledger();
    if (summary === null) {
      return null;
    }
    return percentOf(summary.days_submitted, summary.window_days);
  });

  readonly englishLine = computed(() => {
    const attempt = this.english();
    if (attempt === null) {
      return null;
    }
    if (!attempt.exists) {
      return 'Not sat yet';
    }
    if (attempt.pending_label !== null && attempt.pending_label !== '') {
      return attempt.pending_label;
    }
    if (attempt.band_label === null) {
      return `${attempt.sections_scored} of ${plural(attempt.sections_total, 'section')} scored`;
    }
    return attempt.band_label;
  });

  readonly verifiedSkillCount = computed(() => {
    const record = this.weekly();
    if (record === null) {
      return null;
    }
    let total = 0;
    for (const category of record.skills_by_category) {
      total += category.count;
    }
    return total;
  });

  // --- open items ---------------------------------------------------------

  /** The two open items any endpoint on `main` can answer for one student:
   *  ledger days in the window that were never submitted, and an English
   *  attempt still waiting on a section. Everything else the board lists —
   *  pending uploads, badge claims, missing profile fields — is B4.5. */
  readonly openItems = computed<{ chip: string; tone: string; text: string }[]>(() => {
    const items: { chip: string; tone: string; text: string }[] = [];
    const summary = this.ledger();
    if (summary !== null) {
      const unsubmitted = summary.days_with_anything - summary.days_submitted;
      if (unsubmitted > 0) {
        items.push({
          chip: 'Time sheet',
          tone: 'warn',
          text: `${unsubmitted} of the last ${plural(summary.window_days, 'day')} started and never submitted`,
        });
      }
    }
    const attempt = this.english();
    if (attempt !== null && attempt.exists && attempt.sections_scored < attempt.sections_total) {
      items.push({
        chip: 'English',
        tone: 'neutral',
        text: `${attempt.sections_scored} of ${plural(attempt.sections_total, 'section')} scored`,
      });
    }
    return items;
  });

  // --- recent activity ----------------------------------------------------

  readonly recentActivity = computed<ActivityEntry[]>(() =>
    interviewActivityOf(this.interviews(), RECENT_ACTIVITY_LINES),
  );

  // --- the editor ---------------------------------------------------------

  readonly editorTitle = computed(() =>
    this.editorIntent() === 'batch' ? 'Move batch' : 'Edit profile',
  );

  readonly canSaveProfile = computed(() => {
    if (this.busy()) {
      return false;
    }
    return this.formName().trim() !== '' && this.formEmail().trim() !== '';
  });

  openEditor(intent: 'profile' | 'batch'): void {
    const row = this.student();
    if (row === null) {
      return;
    }
    this.formName.set(row.name);
    this.formEmail.set(row.email);
    this.formUsn.set(row.usn ?? '');
    this.formBatchId.set(row.cohort_id ?? '');
    this.formStage.set(row.current_stage);
    this.formSemester.set(row.current_semester);
    this.editorIntent.set(intent);
    this.editorOpen.set(true);
  }

  closeEditor(): void {
    this.editorOpen.set(false);
  }

  onName(value: string): void {
    this.formName.set(value);
  }

  onEmail(value: string): void {
    this.formEmail.set(value);
  }

  onUsn(value: string): void {
    this.formUsn.set(value);
  }

  onBatch(value: string): void {
    this.formBatchId.set(value);
  }

  onStage(value: string): void {
    this.formStage.set(value);
  }

  onSemester(value: string): void {
    const semester = Number(value);
    if (Number.isNaN(semester)) {
      return;
    }
    this.formSemester.set(semester);
  }

  async saveProfile(): Promise<void> {
    const row = this.student();
    if (row === null || this.busy()) {
      return;
    }
    const changes = this.changedFields(row);
    if (Object.keys(changes).length === 0) {
      this.flash.set('Nothing changed.');
      this.editorOpen.set(false);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/students/${this.studentId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return;
      }
      const saved = (await response.json()) as AdminStudentOut;
      this.student.set(saved);
      this.editorOpen.set(false);
      this.flash.set('Saved.');
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Only what the reader actually changed. `cohort_id: null` is the explicit
   *  un-seat the API reads through `model_fields_set`, so an empty batch
   *  select has to travel as a null and never as an omission. */
  private changedFields(row: AdminStudentOut): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    const name = this.formName().trim();
    if (name !== row.name) {
      changes['name'] = name;
    }
    const email = this.formEmail().trim().toLowerCase();
    if (email !== row.email) {
      changes['email'] = email;
    }
    const usn = this.formUsn().trim().toUpperCase();
    const currentUsn = row.usn ?? '';
    if (usn !== currentUsn) {
      changes['usn'] = usn === '' ? null : usn;
    }
    const batchId = this.formBatchId();
    const currentBatchId = row.cohort_id ?? '';
    if (batchId !== currentBatchId) {
      changes['cohort_id'] = batchId === '' ? null : batchId;
    }
    if (this.formStage() !== row.current_stage) {
      changes['current_stage'] = this.formStage();
    }
    if (this.formSemester() !== row.current_semester) {
      changes['current_semester'] = this.formSemester();
    }
    return changes;
  }

  // --- reading ------------------------------------------------------------

  private async loadEverything(): Promise<void> {
    if (this.studentId === '') {
      this.error.set('No student was named in the address.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    await this.loadIdentity();
    if (this.student() === null) {
      this.loading.set(false);
      return;
    }
    await Promise.all([
      this.loadWeekly(),
      this.loadInterviews(),
      this.loadBadges(),
      this.loadMenteeRecords(),
      this.loadBatches(),
    ]);
    this.loading.set(false);
  }

  /**
   * The one student's identity row.
   *
   * `GET /api/admin/students` answers with the roster and there is no by-id
   * read until B4.5. The matching row is taken and the rest is dropped here,
   * inside this function, so no other student ever reaches a signal or the
   * template.
   */
  private async loadIdentity(): Promise<void> {
    const roster = await this.read<AdminStudentOut[]>('/admin/students');
    if (roster.value === null) {
      this.error.set(roster.refusal ?? 'This student could not be read.');
      return;
    }
    const row = roster.value.find((candidate) => candidate.student_id === this.studentId);
    if (row === undefined) {
      this.error.set('No student with that id, or they are outside the students you may read.');
      return;
    }
    this.student.set(row);
  }

  private async loadWeekly(): Promise<void> {
    const weekly = await this.read<StudentWeeklyOut>(`/admin/students/${this.studentId}/weekly`);
    this.weekly.set(weekly.value);
    this.weeklyRefusal.set(weekly.refusal);
  }

  private async loadInterviews(): Promise<void> {
    const interviews = await this.read<InterviewSessionOut[]>(
      `/mentor/students/${this.studentId}/interviews`,
    );
    this.interviews.set(interviews.value ?? []);
  }

  private async loadBadges(): Promise<void> {
    const badges = await this.read<BadgeDashboardOut>(`/mentor/students/${this.studentId}/badges`);
    this.badges.set(badges.value);
  }

  /** The two reads gated on `mentor.mentees`. They share one refusal line
   *  because they share one capability: telling the reader twice that the
   *  office account does not hold the Mentee log is noise, not information. */
  private async loadMenteeRecords(): Promise<void> {
    const ledger = await this.read<LedgerSummaryOut>(
      `/mentor/students/${this.studentId}/ledger/summary?days=${LEDGER_WINDOW_DAYS}`,
    );
    this.ledger.set(ledger.value);
    const english = await this.read<EnglishBaselineOut>(
      `/mentor/students/${this.studentId}/english-baseline`,
    );
    this.english.set(english.value);
    if (ledger.value === null) {
      this.menteeReadsRefusal.set(ledger.refusal);
      return;
    }
    if (english.value === null) {
      this.menteeReadsRefusal.set(english.refusal);
    }
  }

  private async loadBatches(): Promise<void> {
    const cohorts = await this.read<CohortOut[]>('/admin/cohorts');
    this.batches.set(cohorts.value ?? []);
    this.batchesRefusal.set(cohorts.refusal);
  }

  private async read<T>(path: string): Promise<ReadResult<T>> {
    try {
      const response = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
      if (!response.ok) {
        return { value: null, refusal: await this.detailOf(response) };
      }
      return { value: (await response.json()) as T, refusal: null };
    } catch {
      return { value: null, refusal: 'The server could not be reached.' };
    }
  }

  /** FastAPI answers a schema error with `detail` as a LIST; rendered raw it
   *  reads "[object Object]". The server's refusals name the rule they are
   *  keeping, so its own sentence is kept wherever there is one. */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      const detail = body.detail;
      if (typeof detail === 'string') {
        return detail;
      }
      if (Array.isArray(detail)) {
        const messages: string[] = [];
        for (const entry of detail) {
          const message = (entry as { msg?: string }).msg;
          if (typeof message === 'string') {
            messages.push(message);
          }
        }
        if (messages.length > 0) {
          return messages.join(' ');
        }
      }
    } catch {
      /* not JSON — fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
