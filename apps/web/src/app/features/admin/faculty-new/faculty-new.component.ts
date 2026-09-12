/**
 * Add faculty member — the four-step wizard.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/AddFaculty.html`,
 * specified in `02-admin-console-spec.md` §8. One endpoint on `main` creates a
 * faculty login — `POST /api/admin/faculty` (`app/routers/admin_faculty.py`,
 * `require_admin`) — and this screen is built on that one and on the two reads
 * the cascade needs: `GET /api/admin/colleges` and
 * `GET /api/admin/colleges/{id}/departments`. Nothing else is called.
 *
 * WHY A WIZARD AND NOT ONE FORM. The account IS the access control (AGENTS.md,
 * "the roster IS the access control"), and the board splits the decision into
 * the four questions the office actually asks in order: where this person
 * teaches, who they are, what they may do, and how they are invited. The
 * institution question is first because a faculty login filed under nothing is
 * invisible to every question that starts "who teaches in…".
 *
 * WHAT THE BOARD DRAWS THAT MAIN CANNOT ANSWER YET, and how each renders —
 * none of it is invented, and no control that would 404 is live:
 *
 *   - **Department required.** This wizard will not continue without one, and
 *     it says so in its own words. `AdminFacultyIn.department_id` is still
 *     OPTIONAL on the server (`B3.1`, Phase 3), so the help text says the form
 *     asks and does not claim the server refuses. A client-side rule that
 *     pretends to be a server rule is how the next person skips writing the
 *     server one.
 *   - **The college email domain fence** (`B3.2`, Phase 3, on the domains
 *     `B1.1` adds to the college). The address is checked here only for shape,
 *     exactly as the server's own validator checks it; the notice on step 2
 *     says plainly that no domain is enforced today and that the Main Admin
 *     typing the address is the check.
 *   - **Employee ID.** The board draws the input; there is no column behind it
 *     on `main`, so it renders disabled through `PendingControlDirective`
 *     rather than accepting a value this screen would silently drop.
 *   - **Functions at creation** (`B2.3`, Phase 3). The account is created as
 *     Faculty with no mentor group and no functions — that is what the endpoint
 *     does — so step 3 lists the functions as disabled choices and points at
 *     Roles & functions, which is the only place that records WHY a function
 *     was granted.
 *   - **Mail.** `GET /api/admin/platform/status` (`B3.7`) does not exist, so
 *     this screen never predicts whether the invitation can be emailed. The
 *     create response's own `emailed` flag is the answer, after the fact, and
 *     the activation link is shown exactly when it is `false` — the board's
 *     "a link is shown only if email is unavailable, once".
 *
 * THE LINK IS SHOWN ONCE, IN THIS SESSION. `POST /api/admin/faculty` returns
 * the activation link in its response and `shown_once` is `B3.4`; until that
 * lands, "once" is a property of this screen — the link is not stored, not
 * re-rendered after "Add another", and never listed. Re-minting one is the
 * Faculty screen's "Activation link" action, which is a deliberate act with its
 * own endpoint.
 *
 * ONE PRIMARY BUTTON. The footer's Continue is the view's primary through
 * steps 1–3, becomes "Create account & invite" on step 4, and becomes "Done"
 * once the account exists. Every other control here is secondary or ghost.
 */

import { Component, OnInit, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

// ---- the exact snake_case shapes of the routers' Out models ---------------

interface CollegeOut {
  id: string;
  code: string;
  name: string;
  campus: string | null;
  contact: string | null;
  status: string;
  department_count: number;
}

interface DepartmentOut {
  id: string;
  college_id: string;
  code: string;
  name: string;
  head: string | null;
  status: string;
  cohort_count: number;
}

interface StaffPlacementOut {
  filed: boolean;
  department_id: string | null;
  department_code: string | null;
  department_name: string | null;
  college_id: string | null;
  college_code: string | null;
  college_name: string | null;
}

/** The created account, as `admin_faculty.AdminFacultyOut` answers it. */
interface CreatedFacultyOut {
  user_id: string;
  name: string;
  email: string;
  designation: string | null;
  department: string | null;
  placement: StaffPlacementOut;
  activation_link: string;
  emailed: boolean;
  expires_in_hours: number;
}

/** What the four steps collect, in the order the board asks for it. */
interface FacultyDraft {
  collegeId: string;
  departmentId: string;
  name: string;
  email: string;
  designation: string;
}

const EMPTY_DRAFT: FacultyDraft = {
  collegeId: '',
  departmentId: '',
  name: '',
  email: '',
  designation: '',
};

type LoadState = 'loading' | 'ready' | 'error';

/** The phase that makes the faculty-lifecycle controls work: `B3.1`–`B3.6`
 *  and `B2.3` are all Phase 3 (`06-phase-prompts.md`). */
const FACULTY_LIFECYCLE_PHASE = 3;

/** `models/institution.py::STATUS_ACTIVE`. Anything else is archived. */
const ACTIVE_STATUS = 'ACTIVE';

const FIRST_STEP = 1;
const INSTITUTION_STEP = 1;
const IDENTITY_STEP = 2;
const FUNCTIONS_STEP = 3;
const INVITE_STEP = 4;
const LAST_STEP = INVITE_STEP;

interface WizardStep {
  number: number;
  label: string;
}

const WIZARD_STEPS: WizardStep[] = [
  { number: INSTITUTION_STEP, label: 'Institution' },
  { number: IDENTITY_STEP, label: 'Identity' },
  { number: FUNCTIONS_STEP, label: 'Functions' },
  { number: INVITE_STEP, label: 'Invite' },
];

/** A function the office can give a faculty member, as Governance names it.
 *  These are LABELS, not data: no grant is read or written by this screen. */
interface FunctionChoice {
  label: string;
  description: string;
}

const FUNCTION_CHOICES: FunctionChoice[] = [
  {
    label: 'Mentor',
    description:
      'Mentee log, meeting notes, SWOC and evidence verification for their own group. Granted automatically when the Main Admin assigns this person their first student on Mentor mapping — never here.',
  },
  {
    label: 'HOD',
    description:
      'Department-wide reads and the first signature on a leave request from the department.',
  },
  {
    label: 'Placement officer',
    description: 'Jobs sheet, offers and the placement funnel for the scope they are given.',
  },
  {
    label: 'Verifier',
    description: 'The badge-evidence queue, without the rest of a mentor’s instruments.',
  },
];

@Component({
  selector: 'app-admin-add-faculty',
  standalone: true,
  imports: [RouterLink, PendingControlDirective],
  templateUrl: './faculty-new.component.html',
  styleUrl: './faculty-new.component.scss',
})
export class AdminAddFacultyComponent implements OnInit {
  readonly steps = WIZARD_STEPS;
  readonly functionChoices = FUNCTION_CHOICES;
  readonly facultyLifecyclePhase = FACULTY_LIFECYCLE_PHASE;
  readonly lastStep = LAST_STEP;

  readonly step = signal(FIRST_STEP);
  readonly draft = signal<FacultyDraft>({ ...EMPTY_DRAFT });

  readonly collegesState = signal<LoadState>('loading');
  readonly colleges = signal<CollegeOut[]>([]);
  readonly collegesError = signal<string | null>(null);

  readonly departmentsState = signal<LoadState>('ready');
  readonly departments = signal<DepartmentOut[]>([]);
  readonly departmentsError = signal<string | null>(null);

  readonly saving = signal(false);
  readonly createError = signal<string | null>(null);
  readonly created = signal<CreatedFacultyOut | null>(null);
  readonly copyMessage = signal<string | null>(null);

  /** Set when the admin tries to continue past a step that is not complete.
   *  The field errors are always drawn from the draft; this only decides
   *  whether they are shown yet, so an untouched form is not red. */
  readonly showValidation = signal(false);

  ngOnInit(): void {
    void this.loadColleges();
  }

  // ---- reads ------------------------------------------------------------

  async loadColleges(): Promise<void> {
    this.collegesState.set('loading');
    this.collegesError.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/colleges`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.collegesError.set(await this.detailOf(response));
        this.collegesState.set('error');
        return;
      }
      const colleges = (await response.json()) as CollegeOut[];
      this.colleges.set(colleges);
      this.collegesState.set('ready');
      if (colleges.length === 1) {
        this.selectCollege(colleges[0].id);
      }
    } catch {
      this.collegesError.set('The server could not be reached. No college was loaded.');
      this.collegesState.set('error');
    }
  }

  async loadDepartments(collegeId: string): Promise<void> {
    this.departmentsState.set('loading');
    this.departmentsError.set(null);
    this.departments.set([]);
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/colleges/${collegeId}/departments`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        this.departmentsError.set(await this.detailOf(response));
        this.departmentsState.set('error');
        return;
      }
      this.departments.set((await response.json()) as DepartmentOut[]);
      this.departmentsState.set('ready');
    } catch {
      this.departmentsError.set(
        'The server could not be reached. No department was loaded.',
      );
      this.departmentsState.set('error');
    }
  }

  // ---- the draft --------------------------------------------------------

  selectCollege(collegeId: string): void {
    // Changing the college clears the department: a department belongs to one
    // college, so carrying the old id forward would file this person in a
    // department of a college they were just moved out of.
    this.draft.update((draft) => ({ ...draft, collegeId, departmentId: '' }));
    if (collegeId === '') {
      this.departments.set([]);
      this.departmentsState.set('ready');
      return;
    }
    void this.loadDepartments(collegeId);
  }

  selectDepartment(departmentId: string): void {
    this.draft.update((draft) => ({ ...draft, departmentId }));
  }

  setName(name: string): void {
    this.draft.update((draft) => ({ ...draft, name }));
  }

  setEmail(email: string): void {
    this.draft.update((draft) => ({ ...draft, email }));
  }

  setDesignation(designation: string): void {
    this.draft.update((draft) => ({ ...draft, designation }));
  }

  // ---- what each step needs before it is complete -----------------------

  readonly selectedCollege = computed(() => {
    const collegeId = this.draft().collegeId;
    return this.colleges().find((college) => college.id === collegeId) ?? null;
  });

  readonly selectedDepartment = computed(() => {
    const departmentId = this.draft().departmentId;
    return this.departments().find((department) => department.id === departmentId) ?? null;
  });

  /** Both reads return ARCHIVED rows — `list_colleges`'s own docstring says so
   *  ("archived ones included"), and `list_departments` does not filter either.
   *  An archived department is still a legal `department_id`, so this wizard
   *  offers it and SAYS SO on the option: filtering it out makes a destination
   *  vanish with nothing on screen to explain where it went, and offering it
   *  unlabelled files a new faculty member into a department the office has
   *  already closed. */
  archivedSuffix(status: string | null | undefined): string {
    // A missing status is not an archived one: nothing chosen yet must read as
    // nothing, never as "Archived".
    return !status || status === ACTIVE_STATUS ? '' : ' · Archived';
  }

  readonly archivedPlacementChosen = computed(() => {
    const college = this.selectedCollege();
    const department = this.selectedDepartment();
    return (
      (college !== null && college.status !== ACTIVE_STATUS) ||
      (department !== null && department.status !== ACTIVE_STATUS)
    );
  });

  readonly collegeIsChosen = computed(() => this.selectedCollege() !== null);
  readonly departmentIsChosen = computed(() => this.selectedDepartment() !== null);

  readonly collegeHasNoDepartments = computed(
    () => this.departmentsState() === 'ready' && this.collegeIsChosen() && this.departments().length === 0,
  );

  /** True only while step 1 is actually showing the two selects. When the
   *  colleges are still loading, the read was refused, or this deployment has
   *  no college at all, there is no field to redden — so Continue has to say
   *  why it refused rather than doing nothing at all. */
  readonly institutionFieldsAreOnScreen = computed(
    () => this.collegesState() === 'ready' && this.colleges().length > 0,
  );

  readonly nameIsGiven = computed(() => this.draft().name.trim().length > 0);

  /** The server's own rule (`AdminFacultyIn._email`) is "contains an @ that is
   *  neither first nor last". A college address also has a dot in its domain,
   *  and saying so here costs one round trip less than the 422 does. */
  readonly emailLooksLikeAnAddress = computed(() => {
    const address = this.draft().email.trim().toLowerCase();
    const at = address.indexOf('@');
    if (at <= 0 || at !== address.lastIndexOf('@') || at === address.length - 1) {
      return false;
    }
    if (address.includes(' ')) {
      return false;
    }
    return address.slice(at + 1).includes('.');
  });

  readonly institutionStepIsComplete = computed(
    () => this.collegeIsChosen() && this.departmentIsChosen(),
  );
  readonly identityStepIsComplete = computed(
    () => this.nameIsGiven() && this.emailLooksLikeAnAddress(),
  );

  readonly currentStepIsComplete = computed(() => {
    const step = this.step();
    if (step === INSTITUTION_STEP) {
      return this.institutionStepIsComplete();
    }
    if (step === IDENTITY_STEP) {
      return this.identityStepIsComplete();
    }
    // Functions grants nothing today and Invite is the submit step, which has
    // its own gate below.
    return true;
  });

  readonly readyToCreate = computed(
    () => this.institutionStepIsComplete() && this.identityStepIsComplete(),
  );

  readonly accountExists = computed(() => this.created() !== null);

  /** The board's footer line. */
  readonly stepPosition = computed(() => `Step ${this.step()} of ${LAST_STEP}`);

  stepState(stepNumber: number): 'done' | 'active' | 'pending' {
    if (this.accountExists() && stepNumber < LAST_STEP) {
      return 'done';
    }
    if (stepNumber < this.step()) {
      return 'done';
    }
    if (stepNumber === this.step()) {
      return 'active';
    }
    return 'pending';
  }

  // ---- moving through the wizard ----------------------------------------

  continueToNextStep(): void {
    if (!this.currentStepIsComplete()) {
      this.showValidation.set(true);
      return;
    }
    this.showValidation.set(false);
    this.step.update((step) => Math.min(step + 1, LAST_STEP));
  }

  goToPreviousStep(): void {
    this.showValidation.set(false);
    this.step.update((step) => Math.max(step - 1, FIRST_STEP));
  }

  // ---- the one write ----------------------------------------------------

  async createFacultyAccount(): Promise<void> {
    if (!this.readyToCreate()) {
      this.showValidation.set(true);
      return;
    }
    if (this.saving() || this.accountExists()) {
      return;
    }
    this.saving.set(true);
    this.createError.set(null);
    const draft = this.draft();
    try {
      const response = await fetch(`${environment.apiBase}/admin/faculty`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          email: draft.email.trim().toLowerCase(),
          designation: draft.designation.trim() || null,
          department_id: draft.departmentId,
        }),
      });
      if (!response.ok) {
        this.createError.set(await this.detailOf(response));
        return;
      }
      this.created.set((await response.json()) as CreatedFacultyOut);
    } catch {
      this.createError.set(
        'The server could not be reached. No faculty account was created.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  async copyActivationLink(): Promise<void> {
    const account = this.created();
    if (account === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(account.activation_link);
      this.copyMessage.set('The activation link was copied to the clipboard.');
    } catch {
      this.copyMessage.set(
        'The clipboard is not available in this browser — select the link and copy it by hand.',
      );
    }
  }

  /** A second faculty member, from step 1, with nothing carried over — the
   *  previous activation link included, which is why it is not stored. */
  startAnotherFacultyMember(): void {
    this.draft.set({ ...EMPTY_DRAFT });
    this.departments.set([]);
    this.departmentsState.set('ready');
    this.departmentsError.set(null);
    this.created.set(null);
    this.createError.set(null);
    this.copyMessage.set(null);
    this.showValidation.set(false);
    this.step.set(FIRST_STEP);
    if (this.colleges().length === 1) {
      this.selectCollege(this.colleges()[0].id);
    }
  }

  /** The server's own sentence where there is one — its refusals name the
   *  address and the role ("already belongs to a MENTOR account") and a generic
   *  message would throw that away. FastAPI answers a schema error with
   *  `detail` as a LIST, which rendered raw says "[object Object]". */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail === 'string') {
        return detail;
      }
      if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
