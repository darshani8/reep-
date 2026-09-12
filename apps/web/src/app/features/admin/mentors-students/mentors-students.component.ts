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
 * "N FREE" IS POLICY, NOT A ROW. The Mentor row has no capacity; the figure is
 * settings.mentor_capacity, returned on every faculty member as `capacity`, and
 * nothing refuses an assignment past it — an admin who chooses to overload one
 * faculty member in a thin year should not have to edit .env first. The rail
 * says "At capacity" in the risk colour and lets them.
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

/**
 * B9.1 (history + the 90-day handover read), B9.2 (required reason, audit,
 * notifications), B9.3 (bulk assign a batch) and B9.4 (filters + pagination)
 * all land on the Phase 4 mentoring branch — 06-phase-prompts.md, Phase 4d.
 */
const MENTORING_BACKEND_PHASE = 4;

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
  imports: [AgGridAngular, PendingControlDirective],
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

  readonly selectedMentorUserId = signal<string | null>(null);
  /** The student ids ticked in the grid, kept as the grid reports them. */
  readonly selectedStudentIds = signal<string[]>([]);
  /** The grid's quick filter, as typed in the card head. */
  readonly poolSearch = signal('');

  private grid: GridApi<Mentee> | null = null;

  readonly selectedMentor = computed(
    () => (this.mentors() ?? []).find((one) => one.user_id === this.selectedMentorUserId()) ?? null,
  );
  readonly selectedMentorName = computed(() => this.selectedMentor()?.name ?? 'this faculty member');
  readonly unassignedCount = computed(() => (this.pool() ?? []).length);
  readonly selectedStudentCount = computed(() => this.selectedStudentIds().length);

  /** Places left under the programme's capacity; never below zero on screen —
   *  an overloaded mentor reads "At capacity", not "-3 free". */
  readonly placesFree = computed(() => {
    const mentor = this.selectedMentor();
    if (mentor === null) return 0;
    return Math.max(0, mentor.capacity - mentor.mentee_count);
  });

  readonly canAssign = computed(() => {
    if (this.selectedMentor() === null) return false;
    if (this.selectedStudentCount() === 0) return false;
    return !this.busy();
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
    return `${free} place${free === 1 ? '' : 's'} free`;
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
    const seated = studentIds.length === 1 ? '1 student' : `${studentIds.length} students`;
    await this.writeMentor(studentIds, mentor, `${seated} assigned to ${mentor.name}`);
  }

  /** Release one student back to the pool. */
  async releaseStudent(student: Mentee): Promise<void> {
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
    try {
      for (const studentId of studentIds) {
        const response = await fetch(`${environment.apiBase}/admin/students/${studentId}/mentor`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          this.error.set('Could not save that assignment.');
          return;
        }
      }
      this.grid?.deselectAll();
      this.selectedStudentIds.set([]);
      this.flash.set(message);
      await this.refresh();
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.busy.set(false);
    }
  }

  private assignmentBody(target: MentorLoad | null): Record<string, string | null> {
    if (target === null) return { mentor_id: null };
    if (target.mentor_id !== null) return { mentor_id: target.mentor_id };
    return { mentor_user_id: target.user_id };
  }

  private async refresh(): Promise<void> {
    try {
      const [loadResponse, poolResponse] = await Promise.all([
        fetch(`${environment.apiBase}/admin/mentor-load`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/admin/unassigned-students`, { credentials: 'include' }),
      ]);
      if (!loadResponse.ok || !poolResponse.ok) {
        this.error.set('Could not load mentors and students.');
        this.mentors.set([]);
        this.pool.set([]);
        return;
      }
      const mentors = (await loadResponse.json()) as MentorLoad[];
      this.mentors.set(mentors);
      this.pool.set((await poolResponse.json()) as Mentee[]);
      // Keep a selection across a refresh, and make one on first load so the
      // two cards are never an empty prompt when there is a faculty member.
      if (this.selectedMentorUserId() === null && mentors.length > 0) {
        this.selectedMentorUserId.set(mentors[0].user_id);
      }
    } catch {
      this.error.set('Could not reach the server.');
      this.mentors.set([]);
      this.pool.set([]);
    }
  }
}
