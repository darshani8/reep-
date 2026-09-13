/**
 * Mentor mapping — the board at docs/redesign-2026-09/design/admin/MentorMapping.html
 * (02-admin-console-spec.md §9), on `/admin/mentors`.
 *
 * MENTOR-FIRST, deliberately. Pick a faculty member on the left rail; the
 * unassigned students sit on the right; tick the ones to seat and press the
 * view's one primary action. An earlier shape offered "assign a mentor to
 * students" and "assign students to a mentor" behind a toggle, which is the
 * same operation described twice.
 *
 * "N FREE" IS POLICY, NOT A ROW, AND IT IS STILL ADVISORY. The Mentor row has
 * no capacity; the figure is returned on every faculty member as `capacity`,
 * and nothing refuses an assignment past it — an admin who chooses to overload
 * one faculty member in a thin year should not have to edit .env first. The
 * rail says "At capacity" in the risk colour and lets them.
 *
 * B9.2 changed only WHERE THE NUMBER COMES FROM, which is what that sentence
 * was really complaining about: `departments.mentor_capacity` now answers it
 * when the department has named one, falling back to the programme's
 * `settings.mentor_capacity` otherwise, so tuning it for one department is a
 * row and not a deploy. `capacity_source` says which, so the screen can avoid
 * presenting a programme default as a departmental decision.
 *
 * mentor_id IS THE SCOPE KEY. It is what rule 2 filters staff access on, so
 * every write here is Main-Admin-only server-side and a mentor cannot reach
 * it — a mentor able to set it could assign themselves any student in the
 * programme and then read everything about them.
 *
 * Both lists are re-fetched after a change rather than patched locally: a
 * roster and a pool that disagree about where a student is are worse than a
 * moment's wait.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DRAW. The board shows the department /
 * batch / specialization filters, the assignment history with its handover
 * window, the required reason, the notifications and the bulk-assign-a-batch
 * action. Every one of those is a Phase 4 backend task (B9.1–B9.4, B1.5 in
 * Phase 3), so each control renders through PendingControlDirective and the
 * history card renders its EMPTY state with a `.notice.accent` — never a
 * plausible-looking sample row, which on a screenshot is indistinguishable
 * from working software.
 *
 * FACULTY ACCOUNTS MOVED. Creating a faculty login, re-minting an activation
 * link and filing somebody under a department were on this screen; they are
 * §7 Faculty (`/admin/faculty`) and §8 Add faculty (`/admin/faculty/new`) in
 * the redesign. This screen is the seating chart and nothing else.
 */

import { Component, computed, signal } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  MultiRowSelectionOptions,
  SelectionChangedEvent,
  ValueFormatterParams,
} from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { PluralPipe, plural } from '../../../shared/text/plural.pipe';

/**
 * WHAT PHASE 4d LANDED, AND WHAT IS STILL PENDING HERE.
 *
 * Landed on the server and wired on this screen: B9.2's REQUIRED REASON — the
 * assignment endpoint answers 422 without one, so the input below is live and
 * guards both the assign and the release buttons. Landed on the server and not
 * yet drawn: B9.1's history (recorded on every move; the read endpoint is per
 * STUDENT, and this board's card asks for it per faculty member), B9.3's batch
 * validation and audit, and B9.4's `cohort_id` / `q` filters.
 *
 * B9.2's NOTIFICATIONS DID NOT LAND AND ARE NOT PROMISED. `app/mail_transport.py`
 * falls back to a console outbox whenever `SES_FROM_ADDRESS` is unset, which is
 * every deployment today (B3.7) — the help text under the reason input used to
 * say "both people emailed, from Phase 4" and now says what is actually true.
 */
const MENTORING_BACKEND_PHASE = 4;

/**
 * A refusal names the function that was missing, because the two feeds this
 * screen draws are gated on DIFFERENT capabilities: `/unassigned-students` and
 * the assignment write take `admin.mentors` (the screen's own), while
 * `/mentor-load` takes `admin.analytics` (routers/console.py). The Main Admin
 * holds both, so a faculty account granted only `admin.mentors` in Governance
 * is the one reader who meets this — and "Could not load mentors and students."
 * gives them nothing to take to the office.
 */
const FORBIDDEN_READ =
  'Your account may not read one of these lists. The faculty load needs the ' +
  'admin.analytics function and the student pool needs admin.mentors — ask the Main Admin.';
const FORBIDDEN_WRITE = 'Your account may not change mentor assignments (admin.mentors).';

/** One student, as both `/mentor-load` and `/unassigned-students` return them. */
interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  stage: string | null;
}

/**
 * Where a faculty member is filed, resolved by the API through
 * `users.department_id`. `filed` is what the screen branches on: a falsy
 * `department_name` cannot tell "nobody has filed this person" apart from "a
 * department whose name is blank", and those mean opposite things on a screen
 * whose job is to get everyone seated.
 */
interface StaffPlacement {
  filed: boolean;
  department_id: string | null;
  department_code: string | null;
  department_name: string | null;
  college_id: string | null;
  college_code: string | null;
  college_name: string | null;
}

interface MentorLoad {
  /** Null until the first student is assigned: the assignment creates the group. */
  mentor_id: string | null;
  /** The users.id the assignment is addressed by when there is no group yet. */
  user_id: string;
  name: string;
  department: string | null;
  designation: string | null;
  /** Resolved institutional position. See StaffPlacement. */
  placement: StaffPlacement;
  capacity: number;
  mentee_count: number;
  mentees: Mentee[];
}

const STAGE_LABEL: Record<string, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  EXCEL_ADVANCED: 'Excel-Adv',
  ELEVATE: 'Elevate',
};

/** "Dr. Meera Rao" -> "MR", for the rail's avatar. */
function initialsOf(name: string): string {
  const words = name.split(' ').filter((word) => word.length > 0);
  const letters = words.map((word) => word[0].toUpperCase());
  return letters.slice(0, 2).join('');
}

/** AG Grid cell renderers build their own DOM, so a name out of the roster
 *  reaches innerHTML: escape it here rather than trusting the database. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatUsn(params: ValueFormatterParams<Mentee, string | null>): string {
  return params.value ?? 'No USN';
}

/** The REEP stage as a chip — text and colour together, never colour alone. */
function renderStageCell(params: ICellRendererParams<Mentee, string | null>): string {
  const stage = params.value;
  if (stage === null || stage === undefined) return '<span class="chip neutral">Stage not set</span>';
  const label = STAGE_LABEL[stage] ?? stage;
  return `<span class="chip dot accent">${escapeHtml(label)}</span>`;
}

@Component({
  selector: 'app-admin-mentors-students',
  standalone: true,
  imports: [AgGridAngular, PendingControlDirective, PluralPipe],
  templateUrl: './mentors-students.component.html',
  styleUrl: './mentors-students.component.scss',
})
export class AdminMentorsStudentsComponent {
  readonly gridTheme = reepGridTheme;
  readonly mentoringBackendPhase = MENTORING_BACKEND_PHASE;

  readonly mentors = signal<MentorLoad[] | null>(null);
  readonly pool = signal<Mentee[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly busy = signal(false);
  /**
   * The last load did not answer. It is a THIRD state, beside "loading" and
   * "loaded", and it has to be: setting the two lists to `[]` on a failure made
   * the screen state, in its own words, "No faculty on the roster yet" and
   * "Every student has a mentor" — two assertions about the institution
   * produced by a 403 or a dropped connection.
   */
  readonly loadFailed = signal(false);

  readonly selectedMentorUserId = signal<string | null>(null);
  /** The student ids ticked in the grid, kept as the grid reports them. */
  readonly selectedStudentIds = signal<string[]>([]);
  /** The grid's quick filter, as typed in the card head. */
  readonly poolSearch = signal('');

  /**
   * B9.2's reason, and it is REQUIRED — `POST /admin/students/{id}/mentor`
   * answers 422 without one. This input and the server's `reason` field landed
   * in the same change on purpose: the endpoint was breaking, the live client
   * posted `{mentor_id}` and nothing else, and shipping either half alone is an
   * assign button that fails on a working console.
   *
   * IT GUARDS THE RELEASE BUTTON AS WELL AS THE ASSIGN BUTTON. Releasing a
   * student is the move nothing else on any screen reports — the student simply
   * stops appearing in a group — so it is the one that most needs a sentence
   * saying why.
   */
  readonly assignReason = signal('');

  readonly hasReason = computed(() => this.assignReason().trim().length > 0);

  private grid: GridApi<Mentee> | null = null;

  readonly selectedMentor = computed(
    () => (this.mentors() ?? []).find((one) => one.user_id === this.selectedMentorUserId()) ?? null,
  );
  readonly selectedMentorName = computed(() => this.selectedMentor()?.name ?? 'this faculty member');
  readonly unassignedCount = computed(() => (this.pool() ?? []).length);
  readonly selectedStudentCount = computed(() => this.selectedStudentIds().length);

  readonly canAssign = computed(() => {
    if (this.selectedMentor() === null) return false;
    if (this.selectedStudentCount() === 0) return false;
    if (!this.hasReason()) return false;
    return !this.busy();
  });

  /** Why the primary action is disabled, on the control rather than in a notice
   *  the reader has to hunt for. Empty when it is enabled. */
  readonly assignBlockedBecause = computed(() => {
    if (this.selectedMentor() === null) return 'Pick a faculty member first.';
    if (this.selectedStudentCount() === 0) return 'Tick at least one student.';
    if (!this.hasReason()) return 'Say why this student is being seated here.';
    return '';
  });

  /** The primary action's words, which name both halves of the act. */
  readonly assignActionLabel = computed(() => {
    const count = this.selectedStudentCount();
    if (count === 0) return 'Assign the selected students';
    return `Assign ${count} selected to ${this.selectedMentorName()}`;
  });

  readonly columns: ColDef<Mentee>[] = [
    {
      field: 'usn',
      headerName: 'USN',
      pinned: 'left',
      minWidth: 170,
      flex: 1,
      valueFormatter: formatUsn,
    },
    { field: 'name', headerName: 'Student', minWidth: 190, flex: 1.4 },
    { field: 'stage', headerName: 'Stage', minWidth: 150, flex: 1, cellRenderer: renderStageCell },
  ];

  readonly defaultColumn: ColDef<Mentee> = {
    sortable: true,
    resizable: true,
    filter: true,
    suppressHeaderMenuButton: false,
  };

  /** Checkbox selection, with the bulk action under the grid as the board draws
   *  it. Clicking the row selects too: on a seating screen the whole row is the
   *  target a reader aims at. */
  readonly rowSelection: MultiRowSelectionOptions<Mentee> = {
    mode: 'multiRow',
    checkboxes: true,
    headerCheckbox: true,
    enableClickSelection: true,
  };

  /** AG Grid keeps the ticks across a refresh when rows have a stable id. */
  readonly rowIdOf = (params: { data: Mentee }): string => params.data.student_id;

  constructor() {
    registerReepGrid();
    void this.refresh();
  }

  onGridReady(event: GridReadyEvent<Mentee>): void {
    this.grid = event.api;
  }

  /**
   * The grid lives inside an `@if`, so seating the LAST student destroys it
   * while this component keeps the handle. AG Grid 36 answers a call on a dead
   * api with a console error, so ask it first. (`gridPreDestroy` is a grid
   * event but not an `ag-grid-angular` @Output, so binding it would have been a
   * listener that never fires — the dead control this phase forbids.)
   */
  private get liveGrid(): GridApi<Mentee> | null {
    const api = this.grid;
    if (api === null || api.isDestroyed()) return null;
    return api;
  }

  /** The failure card's one control: ask for both lists again. */
  async retry(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  onSelectionChanged(event: SelectionChangedEvent<Mentee>): void {
    const rows = event.api.getSelectedRows();
    this.selectedStudentIds.set(rows.map((student) => student.student_id));
  }

  searchPool(value: string): void {
    this.poolSearch.set(value);
  }

  selectMentor(userId: string): void {
    this.selectedMentorUserId.set(userId);
    this.flash.set(null);
  }

  isSelectedMentor(mentor: MentorLoad): boolean {
    return mentor.user_id === this.selectedMentorUserId();
  }

  initials(name: string): string {
    return initialsOf(name);
  }

  /** "Associate Professor · Management Studies", or what the roster holds. */
  facultyLine(mentor: MentorLoad): string {
    const parts: string[] = [];
    if (mentor.designation !== null && mentor.designation.trim().length > 0) {
      parts.push(mentor.designation);
    }
    if (mentor.placement.filed && mentor.placement.department_name !== null) {
      parts.push(mentor.placement.department_name);
    } else if (mentor.department !== null && mentor.department.trim().length > 0) {
      parts.push(mentor.department);
    }
    if (parts.length === 0) return 'Department not on record';
    return parts.join(' · ');
  }

  /** How full this faculty member's group is, as a percentage of the bar. */
  loadPercent(mentor: MentorLoad): number {
    if (mentor.capacity <= 0) return 0;
    return Math.min(100, Math.round((100 * mentor.mentee_count) / mentor.capacity));
  }

  isAtCapacity(mentor: MentorLoad): boolean {
    return mentor.mentee_count >= mentor.capacity;
  }

  /** The one line under the name that says what the load means. */
  loadNote(mentor: MentorLoad): string {
    if (mentor.mentor_id === null) return 'Becomes a mentor on first assignment';
    if (this.isAtCapacity(mentor)) return `At capacity — programme capacity is ${mentor.capacity}`;
    const free = mentor.capacity - mentor.mentee_count;
    return `${plural(free, 'place')} free`;
  }

  menteeLine(student: Mentee): string {
    const parts = [student.usn ?? 'No USN'];
    if (student.stage !== null) parts.push(STAGE_LABEL[student.stage] ?? student.stage);
    return parts.join(' · ');
  }

  /** Move every ticked student in the pool onto the selected faculty member. */
  async assignSelectedStudents(): Promise<void> {
    const mentor = this.selectedMentor();
    const studentIds = this.selectedStudentIds();
    if (mentor === null || studentIds.length === 0) return;
    const seated = plural(studentIds.length, 'student');
    await this.writeMentor(studentIds, mentor, `${seated} assigned to ${mentor.name}`);
  }

  /** Release one student back to the pool. Needs the same reason an assignment
   *  does — see `assignReason`. */
  async releaseStudent(student: Mentee): Promise<void> {
    if (!this.hasReason()) {
      this.flash.set(null);
      this.error.set('Say why this student is being released, then press Release again.');
      return;
    }
    const mentor = this.selectedMentor();
    const from = mentor === null ? 'their mentor' : mentor.name;
    await this.writeMentor([student.student_id], null, `${student.name} released from ${from}`);
  }

  /** Null target releases. A target with no group yet is sent by USER id: the
   *  API creates the group on that first assignment, which is how a faculty
   *  account becomes a mentor — by this act, not by a flag at creation. */
  private async writeMentor(
    studentIds: string[],
    target: MentorLoad | null,
    message: string,
  ): Promise<void> {
    const body = this.assignmentBody(target);
    this.busy.set(true);
    this.error.set(null);
    // A stale "3 students assigned to …" sitting under a red failure notice is
    // the screen telling the reader both that it worked and that it did not.
    this.flash.set(null);
    let failure: string | null = null;
    try {
      for (const studentId of studentIds) {
        const response = await fetch(`${environment.apiBase}/admin/students/${studentId}/mentor`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          // This is a request PER STUDENT, so a refusal partway through leaves
          // some of them seated. Stop, then RELOAD — returning without a
          // refresh leaves already-assigned students drawn in the pool, which
          // is the one list on this screen that must not lie.
          failure =
            response.status === 403
              ? FORBIDDEN_WRITE
              : 'Could not save that change — the lists have been reloaded, so what you see is what was saved.';
          break;
        }
      }
    } catch {
      failure = 'Could not reach the server — the lists have been reloaded.';
    }
    this.liveGrid?.deselectAll();
    this.selectedStudentIds.set([]);
    await this.refresh();
    if (failure === null) {
      this.flash.set(message);
      // Cleared only on success. After a failure the words stay in the box, or
      // the retry costs the admin the sentence they just typed.
      this.assignReason.set('');
    } else if (!this.loadFailed()) {
      // refresh() clears the error it does not raise; the write's reason is the
      // more specific one, unless the reload failed too and is already saying so.
      this.error.set(failure);
    }
    this.busy.set(false);
  }

  private assignmentBody(target: MentorLoad | null): Record<string, string | null> {
    // `reason` on every body, release included: the server requires it on all
    // three shapes, which is the point — a release is the move that leaves no
    // other trace.
    const reason = this.assignReason().trim();
    if (target === null) return { mentor_id: null, reason };
    if (target.mentor_id !== null) return { mentor_id: target.mentor_id, reason };
    return { mentor_user_id: target.user_id, reason };
  }

  private async refresh(): Promise<void> {
    this.error.set(null);
    try {
      const [loadResponse, poolResponse] = await Promise.all([
        fetch(`${environment.apiBase}/admin/mentor-load`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/admin/unassigned-students`, { credentials: 'include' }),
      ]);
      if (!loadResponse.ok || !poolResponse.ok) {
        const forbidden = loadResponse.status === 403 || poolResponse.status === 403;
        this.error.set(forbidden ? FORBIDDEN_READ : 'Could not load mentors and students.');
        this.failLoad();
        return;
      }
      const mentors = (await loadResponse.json()) as MentorLoad[];
      this.mentors.set(mentors);
      this.pool.set((await poolResponse.json()) as Mentee[]);
      this.loadFailed.set(false);
      // Keep a selection across a refresh, and make one on first load so the
      // two cards are never an empty prompt when there is a faculty member.
      if (this.selectedMentorUserId() === null && mentors.length > 0) {
        this.selectedMentorUserId.set(mentors[0].user_id);
      }
    } catch {
      this.error.set('Could not reach the server.');
      this.failLoad();
    }
  }

  /** Nothing is known, so nothing is drawn: the two lists go back to "not
   *  loaded" rather than to "empty", which is a claim about the roster. */
  private failLoad(): void {
    this.mentors.set(null);
    this.pool.set(null);
    this.loadFailed.set(true);
  }
}
