/**
 * Colleges — the tenant list, the Add-college panel, and the two cards that
 * say what a college admin and what the platform can do.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/Colleges.html`,
 * specified in `02-admin-console-spec.md` §3. `PATCH /api/admin/colleges/{id}`
 * exists on main and NOTHING here reaches it: the board shows no edit and no
 * archive control, so fixing a typo in a code or name and archiving a college
 * are API-only from this screen. That is a gap in the board, not in the API —
 * it wants a decision, not a button invented here.
 *
 * CHANGING AN ALREADY-CREATED COLLEGE'S DOMAINS IS THE ONE EXCEPTION, and it is
 * not on this screen: `features/admin/institution` edits the fence on the
 * college it has selected, through that same PATCH. This screen writes the list
 * at CREATION and reads it back in the column; that one lives where an admin is
 * already looking at a single college's shape. Two screens, one column, one
 * writer each — which is only safe while they agree about what an empty list
 * means, so both say it in the same words.
 *
 * WHAT PHASE 3 TURNED ON HERE (2026-09-13). Two of the four columns the board
 * draws, and two of the three greyed fields in the Add-college panel, had no
 * endpoint when this screen was built. They have one now:
 *
 *   - registered email domains (`B1.1`) are `colleges.email_domains`, carried on
 *     `CollegeOut` and accepted by `CollegeIn`. The column renders the list, and
 *     the panel's field writes it at creation. An EMPTY list is not "nobody may
 *     join" — `app/institution_domains.py` falls back to the deployment's own
 *     `provisionable_email_domains` — so the cell says so in words rather than
 *     showing a dash, which would read as a fence that admits no one.
 *   - the college admin (`B1.3`) is a FACULTY account holding the eleven scoped
 *     `admin.*` grants `COLLEGE_ADMIN_CAPABILITIES` names. `GET` and `POST
 *     /api/admin/colleges/{id}/admins` read and write them, and the panel's
 *     field is a picker over `GET /api/admin/faculty` plus the reason the
 *     endpoint records.
 *
 * BOTH ADMIN ENDPOINTS ARE GATED ON `admin.governance`, NOT ON THIS SCREEN'S
 * `admin.institution` (`require_governance` in `app/routers/governance.py`),
 * and that is deliberate on the API's side: who holds what is Governance's
 * subject, so renaming a department must not also read the access map. A
 * granted faculty member therefore reaches this screen and cannot see or write
 * the college-admin column. The client checks `session.capabilities` to decide
 * whether to ASK — a filter that keeps a 403 off the screen, never an
 * authorisation; the API refuses regardless.
 *
 * WHAT STILL HAS NO SOURCE, AND WHY IT IS NOT A PHASE. Students and faculty per
 * college are the board's other two columns. `B1.4` landed and narrowed every
 * staff list to the caller's reach, but a per-college COUNT is not a field on
 * any response and no backlog item promises one — so those two headers no
 * longer carry a phase badge (a "Phase 3" label on a screen running Phase 3
 * code reads as a bug). They carry the reason instead, and the cells stay
 * dashes: a count computed here out of a list that is itself scoped and capped
 * would be a different number for every reader, presented as the college's.
 *
 * THE COLLEGE-ADMIN CARD IS EXPLANATORY TEXT, NOT DATA. The board's lines
 * describe what a person holding college-scoped `admin.*` functions may and may
 * not do. They are written here from `02-admin-console-spec.md` §3 and the
 * capability catalogue in `apps/api-py/app/models/governance.py`, and each
 * allowed line names the keys it is made of, so a reader can check the sentence
 * against Governance and against `COLLEGE_ADMIN_CAPABILITIES`.
 *
 * THE PLATFORM CARD REPORTS NOTHING, AND SAYS SO. Mail transport, the sender's
 * SES verification, the region, the retention window and the session policy are
 * facts about the deployment this browser cannot read; `GET
 * /api/admin/platform/status` is `B3.7`, which `05-delivery-workflow.md` puts
 * in PHASE 5 with the CDK harden deploy — it did not ship with Phase 3. Printing
 * "ap-south-1" or "180 days" from the repository's defaults would be a value
 * nobody computed on the host it is being read on. So each row states WHAT it
 * will report and shows "Not reported yet". It is rendered for the Main Admin
 * alone (the route admits a granted faculty member through `admin.institution`,
 * and this card is the office's).
 *
 * "DEPLOY HARDEN PHASE" IS A LINK TO THE RUNBOOK. `02-admin-console-spec.md` §3
 * is explicit: never a button that deploys. Nothing in this SPA may start an
 * infrastructure change — the deploy role in CI holds no CloudFormation rights
 * at all (AGENTS.md, "Infrastructure") — so the control is an anchor to the
 * cutover runbook and opens in a new tab.
 *
 * ONE PRIMARY BUTTON AT A TIME. "Add college" in the header is the view's
 * primary until the panel opens; from then on the panel's "Create college" is,
 * and the header button is not rendered.
 */

import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { plural } from '../../../shared/text/plural.pipe';

/** `CollegeOut` in `app/routers/admin.py`, snake_case exactly as it arrives. */
interface CollegeOut {
  id: string;
  code: string;
  name: string;
  campus: string | null;
  contact: string | null;
  status: string;
  department_count: number;
  /** B1.1. Empty means the deployment's own list applies — never "nobody". */
  email_domains: string[];
}

/** `CollegeAdminGrantOut` — one of the eleven functions, and where it stands. */
interface CollegeAdminGrantOut {
  capability: string;
  label: string;
  /** `active` or `pending_approval` (B2.4: five of the eleven carry PII). */
  approval_state: string;
  grant_id: string;
}

/** `CollegeAdminOut` — a faculty account running one college. */
interface CollegeAdminOut {
  user_id: string;
  name: string;
  email: string;
  department_id: string | null;
  capabilities: CollegeAdminGrantOut[];
  /** Keys of the set this person does NOT hold for this college. */
  missing: string[];
}

/** `AdminFacultyRowOut` in `app/routers/admin_faculty.py`, the fields the
 *  picker needs. A disabled account is listed and LABELLED rather than hidden:
 *  the API will accept it, so hiding it would leave "why is X not in the list"
 *  unanswerable on the screen that asks the question. */
interface FacultyRow {
  user_id: string;
  name: string;
  email: string;
  department: string | null;
  disabled_at: string | null;
}

type ScreenState = 'loading' | 'ready' | 'error';

/** Whether the college-admin column could be read at all, and how it went.
 *  `off` is the honest state for a caller who does not hold `admin.governance`
 *  — nothing was asked, so nothing is claimed. */
type AdminsState = 'off' | 'loading' | 'ready' | 'error';

/** One allowed line of the college-admin card, with the catalogue keys it is
 *  made of so the sentence can be checked against Governance. */
interface CollegeAdminFunction {
  summary: string;
  capabilityKeys: string;
}

/** One line of the platform card: what the deployment will report, once it can. */
interface PlatformFact {
  label: string;
  reports: string;
}

/** Copying a catalogue between colleges is `B13`, Phase 4 — the only control on
 *  this screen still waiting for an endpoint. `POST
 *  /api/admin/catalogue/copy {from_course, to_course, parts[]}` does not exist
 *  on main, and the board's field names a COLLEGE where the task names a
 *  COURSE, so there is not even a shape to send yet. It stays disabled. */
const CATALOGUE_COPY_PHASE = 4;

/** `GET /api/admin/platform/status` is `B3.7`, and `05-delivery-workflow.md`
 *  schedules it in PHASE 5 ("Cleanup + hardening … CDK harden (B3.7) with the
 *  owner"), not Phase 3. The notice used to say Phase 3; it shipped with the
 *  Phase 2 board and Phase 3 has now come and gone without it, which is exactly
 *  the stale number that reads as a bug. The card reports nothing either way —
 *  only the date on the promise changed. */
const PLATFORM_STATUS_PHASE = 5;

/** Under the Students and Faculty headers, in place of a phase badge.
 *
 *  NOT `[reepPending]` AND NOT A PHASE. `B1.4` narrowed every staff list to the
 *  caller's reach, so "Phase 3" here has arrived and these columns are still
 *  empty: no response carries a per-college count and no backlog item adds one.
 *  Counting `GET /api/admin/students` client-side would print a number that is
 *  the READER's reach rather than the college's, under a header that claims
 *  otherwise. So the header states the truth and the cell stays a dash. */
const COUNT_UNSOURCED_NOTE = 'No per-college count';

/** `MIN_REASON_CHARS` in `app/routers/governance.py`. Checked here so the panel
 *  can say why "Create college" is not available BEFORE the college is written
 *  — a 422 from the appointment after the college exists is a half-done act the
 *  reader has to unpick. The server checks it again and is the authority. */
const MIN_REASON_CHARS = 20;

/** The cutover runbook the harden phase is deployed from, in the repository. */
const HARDEN_RUNBOOK_URL = 'https://github.com/darshani8/reep-/blob/main/docs/cdk-cutover.md';

/** `require_governance` (`app/routers/governance.py`) gates both college-admin
 *  endpoints. Held here to decide whether to ASK, never whether to allow. */
const GOVERNANCE_CAPABILITY = 'admin.governance';

/** `STATUS_ACTIVE` / `STATUS_DRAFT` / `STATUS_ARCHIVED` in
 *  `app/models/institution.py`, in the words the console uses. */
const COLLEGE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  DRAFT: 'Draft',
  ARCHIVED: 'Archived',
};

/** Status is text AND colour, never colour alone — these are the chip tones. */
const COLLEGE_STATUS_TONES: Record<string, string> = {
  ACTIVE: 'good',
  DRAFT: 'neutral',
  ARCHIVED: 'warn',
};

/** How a college admin's eleven functions are summarised in one table cell. */
interface AdminSummary {
  label: string;
  tone: string;
}

@Component({
  selector: 'app-admin-colleges',
  standalone: true,
  imports: [RouterLink, PendingControlDirective],
  templateUrl: './colleges.component.html',
  styleUrl: './colleges.component.scss',
})
export class AdminCollegesComponent implements OnInit {
  private readonly auth = inject(AuthService);

  readonly catalogueCopyPhase = CATALOGUE_COPY_PHASE;
  readonly platformStatusPhase = PLATFORM_STATUS_PHASE;
  readonly countUnsourcedNote = COUNT_UNSOURCED_NOTE;
  readonly minReasonChars = MIN_REASON_CHARS;
  readonly hardenRunbookUrl = HARDEN_RUNBOOK_URL;

  readonly state = signal<ScreenState>('loading');
  readonly loadError = signal<string | null>(null);
  readonly colleges = signal<CollegeOut[]>([]);
  readonly selectedCollegeId = signal<string | null>(null);

  readonly statusFilter = signal<string>('all');
  readonly campusFilter = signal<string>('all');

  /** B1.3. College id -> the faculty accounts running it. Only ever populated
   *  from a real response; a college with no entry is not "nobody", which is
   *  what `adminsState` is for. */
  readonly collegeAdmins = signal<Record<string, CollegeAdminOut[]>>({});
  readonly adminsState = signal<AdminsState>('off');
  readonly adminsError = signal<string | null>(null);

  readonly addPanelOpen = signal(false);
  readonly creatingCollege = signal(false);
  readonly createError = signal<string | null>(null);
  readonly createdCollegeName = signal<string | null>(null);
  readonly appointNote = signal<string | null>(null);
  readonly appointError = signal<string | null>(null);
  readonly newCollegeDraft = signal({ code: '', name: '', campus: '', contact: '', domains: '' });

  /** The faculty account to appoint as this college's admin, and the reason the
   *  appointment records. Both belong to the panel, not to the college row. */
  readonly appointUserId = signal<string>('');
  readonly appointReason = signal<string>('');
  readonly faculty = signal<FacultyRow[]>([]);
  readonly facultyError = signal<string | null>(null);
  readonly facultyLoading = signal(false);

  /** The platform card is the office's. A faculty member granted
   *  `admin.institution` reaches this screen and does not see it. */
  readonly isMainAdmin = computed(() => this.auth.session()?.role === 'ADMIN');

  /** Whether to ASK for the college-admin data at all. A client-side capability
   *  check is a filter and never a gate — `require_governance` refuses the
   *  request regardless — but asking anyway would paint the column with a row
   *  of 403s for a reader who is doing nothing wrong. */
  readonly canReadCollegeAdmins = computed(
    () => this.auth.session()?.capabilities?.includes(GOVERNANCE_CAPABILITY) ?? false,
  );

  /** The campuses actually on record — the board's second filter, built from
   *  the data rather than from a list of states nothing stores. */
  readonly campusesOnRecord = computed(() => {
    const campuses = new Set<string>();
    for (const college of this.colleges()) {
      if (college.campus) {
        campuses.add(college.campus);
      }
    }
    return [...campuses].sort();
  });

  readonly visibleColleges = computed(() => {
    const status = this.statusFilter();
    const campus = this.campusFilter();
    return this.colleges().filter((college) => {
      const statusMatches = status === 'all' || college.status === status;
      const campusMatches = campus === 'all' || college.campus === campus;
      return statusMatches && campusMatches;
    });
  });

  /** The selected row, resolved INSIDE the filtered set and never outside it.
   *  A selection the filter has hidden would title the college-admin card after
   *  a college that is not on screen and leave the status bar reading
   *  "Selected: 1" over a list that shows no selected row — two statements the
   *  reader cannot check. Falling back to the first visible row keeps the card,
   *  the highlight and the count describing the same college. */
  readonly selectedCollege = computed(() => {
    const visible = this.visibleColleges();
    const id = this.selectedCollegeId();
    return visible.find((college) => college.id === id) ?? visible[0] ?? null;
  });

  /** The college-admin card is titled after the selected row, as on the board. */
  readonly selectedCollegeName = computed(() => this.selectedCollege()?.name ?? 'a college');

  readonly statusFilterLabel = computed(() => {
    const status = this.statusFilter();
    if (status === 'all') {
      return 'All';
    }
    return this.statusLabel(status);
  });

  readonly campusFilterLabel = computed(() => {
    const campus = this.campusFilter();
    if (campus === 'all') {
      return 'All';
    }
    return campus;
  });

  /** The picker is offered only where BOTH endpoints behind it can answer: the
   *  faculty list (Main Admin) and the appointment (`admin.governance`). */
  readonly canAppointAdmin = computed(() => this.canReadCollegeAdmins() && this.isMainAdmin());

  readonly appointReasonLength = computed(() => this.appointReason().trim().length);

  readonly appointReasonReady = computed(
    () => this.appointReasonLength() >= MIN_REASON_CHARS,
  );

  readonly canCreateCollege = computed(() => {
    const draft = this.newCollegeDraft();
    const hasCode = draft.code.trim().length > 0;
    const hasName = draft.name.trim().length > 0;
    // A picked faculty account without a usable reason blocks the WHOLE act,
    // rather than creating the college and failing the appointment after it.
    const appointReady = !this.appointUserId() || this.appointReasonReady();
    return hasCode && hasName && appointReady && !this.creatingCollege();
  });

  /** The lines of the board's college-admin card, in its order. */
  readonly collegeAdminCan: CollegeAdminFunction[] = [
    {
      summary: 'Structure, faculty, students and mentor mapping for the college',
      capabilityKeys: 'admin.institution · admin.students · admin.mentors',
    },
    {
      summary: "Registrations from the college's own email domains",
      capabilityKeys: 'admin.registrations',
    },
    {
      summary: 'Analytics, exports, SWOC notes and placement',
      capabilityKeys: 'admin.analytics · admin.exports · admin.swoc · admin.placement',
    },
    {
      summary: 'Jobs, catalogue and the interview question bank',
      capabilityKeys: 'admin.jobs · admin.catalogue · admin.interview_questions',
    },
  ];

  readonly collegeAdminNever: string[] = [
    'See or export another college',
    'Create a college, or a second Main Admin',
    'Grant a function to anybody, including themselves — admin.governance is not in the set',
    'Play back an interview recording — admin.interview_audio is its own decision',
    'Change platform settings — mail, region, retention',
  ];

  /** What `GET /api/admin/platform/status` will report, row by row. Values are
   *  deliberately absent: this browser knows none of them. */
  readonly platformFacts: PlatformFact[] = [
    {
      label: 'Mail transport',
      reports: 'Amazon SES, or the console transport that writes invites and codes to the API log',
    },
    {
      label: 'Sender',
      reports: 'the From address, and whether SES has verified it',
    },
    {
      label: 'Region · Rule 1',
      reports: 'the region the API runs in, and whether student data may reach a remote model',
    },
    {
      label: 'Interview retention',
      reports: 'how long transcripts and audio are kept before the sweeper deletes them',
    },
    {
      label: 'Sessions',
      reports:
        'session lifetime — one device per account, and the Main Admin door’s emailed code, are enforced in code today',
    },
  ];

  ngOnInit(): void {
    void this.loadColleges();
  }

  async loadColleges(): Promise<void> {
    this.state.set('loading');
    this.loadError.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/colleges`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.loadError.set(await this.detailOf(response));
        this.state.set('error');
        return;
      }
      const colleges = (await response.json()) as CollegeOut[];
      this.colleges.set(colleges);
      // No opening selection is set here: `selectedCollege` already resolves to
      // the first VISIBLE row, so seeding an id would only add a second place
      // that decides which college the card is about.
      this.state.set('ready');
      void this.loadCollegeAdmins(colleges);
    } catch {
      this.loadError.set('The server could not be reached. No college was loaded.');
      this.state.set('error');
    }
  }

  /**
   * B1.3. Who runs each college, from `GET /api/admin/colleges/{id}/admins`.
   *
   * ONE REQUEST PER COLLEGE, because that is the endpoint's shape: it answers
   * for one college and there is no list-wide form of it. A tenant list is a
   * handful of rows, so the fan-out is bounded by the thing being rendered
   * rather than by a page size; the alternative — leaving the column empty
   * while the endpoint exists — is the dash that means two different things
   * this screen was written to avoid.
   *
   * A FAILURE EMPTIES THE COLUMN RATHER THAN FILLING IT PARTLY. Half a column
   * of admins and half of dashes is unreadable: the reader cannot tell the
   * college with no admin from the request that did not come back.
   */
  private async loadCollegeAdmins(colleges: CollegeOut[]): Promise<void> {
    if (!this.canReadCollegeAdmins()) {
      this.adminsState.set('off');
      this.collegeAdmins.set({});
      return;
    }
    if (colleges.length === 0) {
      this.adminsState.set('ready');
      this.collegeAdmins.set({});
      return;
    }
    this.adminsState.set('loading');
    this.adminsError.set(null);
    try {
      const responses = await Promise.all(
        colleges.map((college) =>
          fetch(`${environment.apiBase}/admin/colleges/${college.id}/admins`, {
            credentials: 'include',
          }),
        ),
      );
      const failed = responses.find((response) => !response.ok);
      if (failed) {
        this.adminsError.set(await this.detailOf(failed));
        this.collegeAdmins.set({});
        this.adminsState.set('error');
        return;
      }
      const bodies = (await Promise.all(
        responses.map((response) => response.json()),
      )) as CollegeAdminOut[][];
      const byCollege: Record<string, CollegeAdminOut[]> = {};
      colleges.forEach((college, index) => {
        byCollege[college.id] = bodies[index];
      });
      this.collegeAdmins.set(byCollege);
      this.adminsState.set('ready');
    } catch {
      this.adminsError.set('The server could not be reached. No college admin was read.');
      this.collegeAdmins.set({});
      this.adminsState.set('error');
    }
  }

  /** `GET /api/admin/faculty` — the accounts the picker offers. Main Admin
   *  only on the API (`require_admin`), which is why the field says so instead
   *  of rendering an empty list for anybody else. */
  private async loadFaculty(): Promise<void> {
    if (!this.canAppointAdmin() || this.faculty().length > 0 || this.facultyLoading()) {
      return;
    }
    this.facultyLoading.set(true);
    this.facultyError.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/faculty`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.facultyError.set(await this.detailOf(response));
        return;
      }
      this.faculty.set((await response.json()) as FacultyRow[]);
    } catch {
      this.facultyError.set('The server could not be reached. No faculty account was listed.');
    } finally {
      this.facultyLoading.set(false);
    }
  }

  selectCollege(collegeId: string): void {
    this.selectedCollegeId.set(collegeId);
  }

  openAddPanel(): void {
    this.createError.set(null);
    this.createdCollegeName.set(null);
    this.appointNote.set(null);
    this.appointError.set(null);
    this.addPanelOpen.set(true);
    void this.loadFaculty();
  }

  closeAddPanel(): void {
    this.addPanelOpen.set(false);
    this.createError.set(null);
    this.newCollegeDraft.set({ code: '', name: '', campus: '', contact: '', domains: '' });
    this.appointUserId.set('');
    this.appointReason.set('');
  }

  setNewCollegeField(
    field: 'code' | 'name' | 'campus' | 'contact' | 'domains',
    value: string,
  ): void {
    this.newCollegeDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  setAppointUserId(value: string): void {
    this.appointUserId.set(value);
  }

  setAppointReason(value: string): void {
    this.appointReason.set(value);
  }

  setStatusFilter(value: string): void {
    this.statusFilter.set(value);
  }

  setCampusFilter(value: string): void {
    this.campusFilter.set(value);
  }

  /**
   * POST /api/admin/colleges, then — when a faculty account was picked — POST
   * /api/admin/colleges/{id}/admins. The API's own refusals are shown verbatim;
   * "A college with code BGSCET already exists." is written for the reader.
   *
   * TWO WRITES, REPORTED SEPARATELY. The appointment cannot be folded into the
   * create (it needs the college's id, and it is a different endpoint behind a
   * different capability), so the second one can fail after the first has
   * succeeded. The college is then real and un-administered, and the panel says
   * exactly that rather than reporting either a clean success or a clean
   * failure — both of which would leave the reader to discover the truth from
   * the table.
   */
  async createCollege(): Promise<void> {
    if (!this.canCreateCollege()) {
      return;
    }
    const draft = this.newCollegeDraft();
    this.creatingCollege.set(true);
    this.createError.set(null);
    this.createdCollegeName.set(null);
    this.appointNote.set(null);
    this.appointError.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/colleges`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: draft.code.trim(),
          name: draft.name.trim(),
          campus: draft.campus.trim() || null,
          contact: draft.contact.trim() || null,
          email_domains: this.parseDomains(draft.domains),
        }),
      });
      if (!response.ok) {
        this.createError.set(await this.detailOf(response));
        return;
      }
      const created = (await response.json()) as CollegeOut;
      this.colleges.update((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
      this.selectedCollegeId.set(created.id);
      this.createdCollegeName.set(created.name);
      this.collegeAdmins.update((map) => ({ ...map, [created.id]: [] }));
      await this.appointAdmin(created);
      this.newCollegeDraft.set({ code: '', name: '', campus: '', contact: '', domains: '' });
      this.appointUserId.set('');
      this.appointReason.set('');
      this.addPanelOpen.set(false);
    } catch {
      this.createError.set('The server could not be reached. No college was created.');
    } finally {
      this.creatingCollege.set(false);
    }
  }

  /** The second write. Silent when no faculty account was picked — appointing
   *  nobody is the normal case, and a college with no admin is a state the
   *  table already renders. */
  private async appointAdmin(college: CollegeOut): Promise<void> {
    const userId = this.appointUserId();
    if (!userId) {
      return;
    }
    const person = this.faculty().find((row) => row.user_id === userId);
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/colleges/${college.id}/admins`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId, reason: this.appointReason().trim() }),
        },
      );
      if (!response.ok) {
        this.appointError.set(
          `${college.name} was created, but ${person?.name ?? 'that account'} was not appointed: ${await this.detailOf(response)}`,
        );
        return;
      }
      const admin = (await response.json()) as CollegeAdminOut;
      this.collegeAdmins.update((map) => ({ ...map, [college.id]: [admin] }));
      const pending = admin.capabilities.filter(
        (grant) => grant.approval_state !== 'active',
      ).length;
      const live = admin.capabilities.length - pending;
      this.appointNote.set(
        pending > 0
          ? `${admin.name} was appointed: ${live} of ${admin.capabilities.length} functions are live and ${pending} carry a student's own records, so they hold nothing until a second holder of admin.governance approves each in Roles & functions.`
          : `${admin.name} was appointed with ${plural(admin.capabilities.length, 'function')}.`,
      );
    } catch {
      this.appointError.set(
        `${college.name} was created, but the server could not be reached to appoint ${person?.name ?? 'that account'}.`,
      );
    }
  }

  /** "bgscet.ac.in, @sjbit.ac.in" -> ["bgscet.ac.in", "sjbit.ac.in"].
   *
   *  Split on commas, spaces and newlines because all three are how a list
   *  gets pasted. The API normalises and de-duplicates again (`_clean_domains`)
   *  and is the authority; this only keeps an empty entry from a trailing
   *  comma out of the request. */
  private parseDomains(value: string): string[] {
    return value
      .split(/[\s,;]+/)
      .map((domain) => domain.trim().replace(/^@/, '').toLowerCase())
      .filter((domain) => domain.length > 0);
  }

  /** "BGSCET · Bengaluru · 3 departments" — every part of it a stored value. */
  collegeSubLine(college: CollegeOut): string {
    const departments = plural(college.department_count, 'department');
    const parts = [college.code];
    if (college.campus) {
      parts.push(college.campus);
    }
    parts.push(departments);
    return parts.join(' · ');
  }

  /** The Domains cell. An empty list is a real, documented setting — the
   *  deployment's own `provisionable_email_domains` applies — so it is stated
   *  rather than dashed. */
  domainsLabel(college: CollegeOut): string {
    return college.email_domains.length > 0
      ? college.email_domains.join(', ')
      : 'Deployment list';
  }

  hasDomains(college: CollegeOut): boolean {
    return college.email_domains.length > 0;
  }

  adminsFor(college: CollegeOut): CollegeAdminOut[] {
    return this.collegeAdmins()[college.id] ?? [];
  }

  /** One chip per college admin, saying how much of the set is actually live.
   *  "Appointed" alone would hide the five grants that are waiting for a second
   *  approval — which is the difference between a working console and a
   *  colleague asking why half of theirs answers 403. */
  adminSummary(admin: CollegeAdminOut): AdminSummary {
    const pending = admin.capabilities.filter((grant) => grant.approval_state !== 'active').length;
    const total = admin.capabilities.length + admin.missing.length;
    if (pending > 0) {
      return { label: `${pending} awaiting approval`, tone: 'warn' };
    }
    if (admin.missing.length > 0) {
      return { label: `${admin.capabilities.length} of ${total} functions`, tone: 'warn' };
    }
    return { label: plural(admin.capabilities.length, 'function'), tone: 'good' };
  }

  /** "Ravi Kumar · ravi@bgscet.ac.in" for the picker, with a disabled account
   *  named as one. */
  facultyLabel(row: FacultyRow): string {
    const where = row.department ? ` · ${row.department}` : '';
    const disabled = row.disabled_at ? ' · disabled' : '';
    return `${row.name} · ${row.email}${where}${disabled}`;
  }

  statusLabel(status: string): string {
    return COLLEGE_STATUS_LABELS[status] ?? status;
  }

  /** The status chip's classes. Status is text AND colour: the label is always
   *  rendered beside the tone, never the tone alone. */
  statusChipClass(status: string): string {
    const tone = COLLEGE_STATUS_TONES[status] ?? 'neutral';
    return `chip dot ${tone}`;
  }

  /** The server's own sentence where there is one. FastAPI answers a schema
   *  error with `detail` as a LIST, which rendered raw says "[object Object]". */
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
