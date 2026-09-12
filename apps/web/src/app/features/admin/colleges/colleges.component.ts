/**
 * Colleges — the tenant list, the Add-college panel, and the two cards that
 * say what a college admin and what the platform can do.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/Colleges.html`,
 * specified in `02-admin-console-spec.md` §3. It calls exactly two endpoints,
 * `GET` and `POST /api/admin/colleges` (`app/routers/admin.py`, capability
 * `admin.institution`), because those are the two the board draws a control
 * for. `PATCH /api/admin/colleges/{id}` also exists on main and NOTHING here
 * reaches it: the board shows no edit and no archive control, so fixing a typo
 * in a code or name, and archiving a college, are API-only from this screen.
 * That is a gap in the board, not in the API — it wants a decision, not a
 * button invented here.
 *
 * WHAT THE BOARD DRAWS THAT MAIN CANNOT ANSWER YET. Four of the tenant list's
 * six columns have no column, count or endpoint behind them today, so not one
 * of them is invented here — each renders an em dash, its header carries the
 * phase, and one `.notice.accent` above the grid names the task that fills it:
 *
 *   - registered email domains — `colleges.email_domains` is `B1.1`, Phase 3;
 *   - the college admin — a FACULTY account holding `admin.*` grants scoped to
 *     the college, with `GET /api/admin/colleges/{id}/admins` to read them
 *     back, is `B1.3`, Phase 3;
 *   - students and faculty per college — those lists are programme-wide today
 *     and gain a college filter with `scope_filter` in `B1.4`, Phase 3.
 *
 * The department count IS real (`CollegeOut.department_count`), so it is the
 * one number on a row and it sits in the name cell where the board puts it.
 * The board's "6 batches · VTU" has no source at all and is simply absent.
 *
 * THE COLLEGE-ADMIN CARD IS EXPLANATORY TEXT, NOT DATA. The board's nine lines
 * describe what a person holding college-scoped `admin.*` functions may and may
 * not do. They are written here from `02-admin-console-spec.md` §3 and the
 * capability catalogue in `apps/api-py/app/models/governance.py`, and each
 * allowed line names the keys it is made of, so a reader can check the sentence
 * against Governance. The card carries a warning of its own, because the
 * sentence is not true of main yet: every `admin.*` key is
 * `CapabilityScope.PROGRAMME` today, so a function granted in Governance covers
 * every college on the deployment. The college boundary is `B1.2`/`B1.3`.
 *
 * THE PLATFORM CARD REPORTS NOTHING, AND SAYS SO. Mail transport, the sender's
 * SES verification, the region, the retention window and the session policy are
 * facts about the deployment this browser cannot read; `GET
 * /api/admin/platform/status` is `B3.7`, Phase 3. Printing "ap-south-1" or
 * "180 days" from the repository's defaults would be a value nobody computed on
 * the host it is being read on — exactly the screenshot this phase forbids. So
 * each row states WHAT it will report and shows "Not reported yet". It is
 * rendered for the Main Admin alone (the route admits a granted faculty member
 * through `admin.institution`, and this card is the office's).
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

/** `CollegeOut` in `app/routers/admin.py`, snake_case exactly as it arrives. */
interface CollegeOut {
  id: string;
  code: string;
  name: string;
  campus: string | null;
  contact: string | null;
  status: string;
  department_count: number;
}

type ScreenState = 'loading' | 'ready' | 'error';

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

/** Registration domains (`B1.1`), the scoped college admin (`B1.2`/`B1.3`) and
 *  the per-college student and faculty lists (`B1.4`) all land in Phase 3. */
const COLLEGE_SCOPE_PHASE = 3;

/** Copying a catalogue between colleges is `B13`, Phase 4. */
const CATALOGUE_COPY_PHASE = 4;

/** `GET /api/admin/platform/status` is `B3.7`, Phase 3. */
const PLATFORM_STATUS_PHASE = 3;

/** The cutover runbook the harden phase is deployed from, in the repository. */
const HARDEN_RUNBOOK_URL = 'https://github.com/darshani8/reep-/blob/main/docs/cdk-cutover.md';

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

@Component({
  selector: 'app-admin-colleges',
  standalone: true,
  imports: [RouterLink, PendingControlDirective],
  templateUrl: './colleges.component.html',
  styleUrl: './colleges.component.scss',
})
export class AdminCollegesComponent implements OnInit {
  private readonly auth = inject(AuthService);

  readonly collegeScopePhase = COLLEGE_SCOPE_PHASE;
  readonly catalogueCopyPhase = CATALOGUE_COPY_PHASE;
  readonly platformStatusPhase = PLATFORM_STATUS_PHASE;
  readonly hardenRunbookUrl = HARDEN_RUNBOOK_URL;

  readonly state = signal<ScreenState>('loading');
  readonly loadError = signal<string | null>(null);
  readonly colleges = signal<CollegeOut[]>([]);
  readonly selectedCollegeId = signal<string | null>(null);

  readonly statusFilter = signal<string>('all');
  readonly campusFilter = signal<string>('all');

  readonly addPanelOpen = signal(false);
  readonly creatingCollege = signal(false);
  readonly createError = signal<string | null>(null);
  readonly createdCollegeName = signal<string | null>(null);
  readonly newCollegeDraft = signal({ code: '', name: '', campus: '', contact: '' });

  /** The platform card is the office's. A faculty member granted
   *  `admin.institution` reaches this screen and does not see it. */
  readonly isMainAdmin = computed(() => this.auth.session()?.role === 'ADMIN');

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

  readonly canCreateCollege = computed(() => {
    const draft = this.newCollegeDraft();
    const hasCode = draft.code.trim().length > 0;
    const hasName = draft.name.trim().length > 0;
    return hasCode && hasName && !this.creatingCollege();
  });

  /** The nine lines of the board's college-admin card, in its order. */
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
      summary: "Leave sanction for the college's departments",
      capabilityKeys: 'mentor.leave_approve',
    },
    {
      summary: 'Analytics, exports, SWOC notes and interview records',
      capabilityKeys: 'admin.analytics · admin.exports · admin.swoc · admin.interview_audio',
    },
    {
      summary: 'Catalogue and interview question bank, per course',
      capabilityKeys: 'admin.catalogue · admin.interview_questions',
    },
    {
      summary: 'Grant department functions (HOD, placement officer) inside the college',
      capabilityKeys: 'granting is the Main Admin’s today · B1.3',
    },
  ];

  readonly collegeAdminNever: string[] = [
    'See or export another college',
    'Create a college, or a second Main Admin',
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
    } catch {
      this.loadError.set('The server could not be reached. No college was loaded.');
      this.state.set('error');
    }
  }

  selectCollege(collegeId: string): void {
    this.selectedCollegeId.set(collegeId);
  }

  openAddPanel(): void {
    this.createError.set(null);
    this.createdCollegeName.set(null);
    this.addPanelOpen.set(true);
  }

  closeAddPanel(): void {
    this.addPanelOpen.set(false);
    this.createError.set(null);
    this.newCollegeDraft.set({ code: '', name: '', campus: '', contact: '' });
  }

  setNewCollegeField(field: 'code' | 'name' | 'campus' | 'contact', value: string): void {
    this.newCollegeDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  setStatusFilter(value: string): void {
    this.statusFilter.set(value);
  }

  setCampusFilter(value: string): void {
    this.campusFilter.set(value);
  }

  /** POST /api/admin/colleges. The API's own refusals are shown verbatim —
   *  "A college with code BGSCET already exists." is written for the reader. */
  async createCollege(): Promise<void> {
    if (!this.canCreateCollege()) {
      return;
    }
    const draft = this.newCollegeDraft();
    this.creatingCollege.set(true);
    this.createError.set(null);
    this.createdCollegeName.set(null);
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
      this.newCollegeDraft.set({ code: '', name: '', campus: '', contact: '' });
      this.addPanelOpen.set(false);
    } catch {
      this.createError.set('The server could not be reached. No college was created.');
    } finally {
      this.creatingCollege.set(false);
    }
  }

  /** "BGSCET · Bengaluru · 3 departments" — every part of it a stored value. */
  collegeSubLine(college: CollegeOut): string {
    const departments =
      college.department_count === 1 ? '1 department' : `${college.department_count} departments`;
    const parts = [college.code];
    if (college.campus) {
      parts.push(college.campus);
    }
    parts.push(departments);
    return parts.join(' · ');
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
