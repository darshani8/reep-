/**
 * Roles & functions — the Main Admin's access console.
 *
 * Board: docs/redesign-2026-09/design/admin/Governance.html
 * Spec:  docs/redesign-2026-09/02-admin-console-spec.md §19
 *
 * ROLE IS WHO SOMEONE IS; A FUNCTION IS WHAT THEY MAY DO. The screen keeps the
 * two apart, and it keeps apart the two instruments that used to share it:
 * capability grants are deny-past-the-role-baseline for staff, while student
 * feature overrides are allow-until-switched-off. Those overrides now have
 * their own screen (`/admin/governance/features`, §20) and what is left here is
 * a card that links to it with the two counts the API already reports. One
 * control doing both would put "grant" and "remove" in the same place, on a
 * screen that decides who reads student marks.
 *
 * EVERY LIST COMES FROM THE SERVER, none is typed here. `/catalogue` serves the
 * functions from the same constants the API enforces, so a function cannot
 * appear in a dropdown that no call site checks. That is now true without an
 * asterisk: `ui.console_v2` — the temporary switch that admitted an account to
 * the redesigned screens, and the one entry in the catalogue that gated a
 * client rendering rather than an endpoint — was deleted in Phase 5, so every
 * function in this dropdown is one the API refuses requests over.
 * `/hierarchy` serves the scope targets the same way, each with the live
 * student count that makes a grant's blast radius a number instead of a name.
 *
 * TWO WORDS THAT SOUND THE SAME AND ARE NOT. A capability's `scope` is
 * `SCOPED` or `PROGRAMME` — whether a mentor group narrows the key AT ALL. A
 * grant's `scope_level`/`scope_id` is its REACH — how far this particular
 * handover goes. They are two columns on the grid and two fields on the form,
 * deliberately never merged: "Business Analytics, programme-wide" and
 * "Business Analytics, Civil only" are the same capability with opposite
 * consequences, and one column saying "Programme-wide" for both is the console
 * telling an admin they fenced something they did not.
 *
 * A PENDING GRANT HOLDS NOTHING, and the row says so in as many words. A
 * `carries_pii` capability granted by a DEPUTY is written `pending_approval`
 * and is ignored by `granted_capabilities` and `granted_reaches` until a
 * DIFFERENT holder of Governance approves it (B2.4). The Main Admin's own
 * grants are live the moment they are written (2026-09-16): the office is the
 * one authority here and does not wait for a deputy it appointed to agree, so
 * the office never sees its own rows in this state — a deputy's it does, and
 * approves. Painting a pending row like a live grant would be an admin
 * believing they handed over access that does not exist — so the status chip
 * reads "Awaiting approval — holds nothing", in the risk tone, and the row
 * offers Approve rather than nothing at all.
 *
 * WHAT THIS SCREEN STILL CANNOT ANSWER, AND SAYS SO. Two things, both honest
 * text rather than a disabled control pretending to be a missing feature:
 * `POST /grants` DERIVES a grant's review date (the expiry if one is named,
 * otherwise the API's default interval) and does not accept one, so the form's
 * Review field is read-only and points at Extend, which does take a date; and
 * `/catalogue` reports no per-function ENFORCED flag, so that column still says
 * "Not reported here" rather than claiming a check it cannot see. B2.1 answered
 * the enforcement question a different way — see `enforcementLabelFor`.
 *
 * THE REACH PREVIEW IS THE POINT OF THE GRANT PANEL. A governance screen that
 * does not show blast radius is how over-granting happens quietly, so the
 * preview recomputes on every change, counts the students the grant would
 * actually reach, and turns red for a PROGRAMME function with no scope target —
 * the ones with no mentor group to narrow them, which hand over the whole
 * college.
 *
 * THE REASON GATE IS REAL, not a red asterisk: the button stays disabled until
 * the reason clears the server's own floor, and it says which requirement is
 * missing. The API enforces the same floor on all four mutations, because a
 * client is not where that promise can be kept — and when it refuses anyway
 * (self-approval, a lapsed grant, a date in the past) its own sentence is what
 * reaches the screen.
 */

import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';
import { PluralPipe, plural } from '../../../shared/text/plural.pipe';

// ---- exact snake_case shapes of the governance router's Out models ---------

/** A rung of the institutional spine — `ScopeLevel` in `models/governance.py`.
 *  There is deliberately no PROGRAMME member there and none here: a grant that
 *  reaches everything hangs on NO rung, which is a null level and a null id on
 *  the row, not a seventh value. */
type ScopeLevel = 'COLLEGE' | 'DEPARTMENT' | 'COURSE' | 'SPECIALIZATION' | 'COHORT' | 'STUDENT';

interface CapabilityOut {
  key: string;
  label: string;
  scope: 'SCOPED' | 'PROGRAMME';
  carries_pii: boolean;
  /** Still absent on every deployment, which is why the enforcement column
   *  reads "Not reported here" rather than guessing. B2.1 did not add this flag:
   *  it DELETED the ten keys nothing checked and put a CI scan behind the rest
   *  (`tools/ci/check_capability_enforcement.py`). Left optional because a
   *  future `/catalogue` may still report it per row, and the column is already
   *  written to tell the two states apart. */
  enforced?: boolean;
}

interface FeatureOut {
  key: string;
  label: string;
  /** B2.2. Read on the switches screen; here only the count matters. */
  enforced?: boolean;
}

interface CatalogueOut {
  capabilities: CapabilityOut[];
  features: FeatureOut[];
  min_reason_chars: number;
}

/** One rung of `GET /hierarchy` — the scope-target option list, and the blast
 *  radius with it. `students` is a live count, which is what turns "scoped to
 *  AI & ML" into "reaches 86 students". */
interface HierarchyNode {
  scope: ScopeLevel;
  id: string;
  label: string;
  parent_id: string | null;
  students: number;
}

interface StaffOut {
  user_id: string;
  name: string;
  email: string;
  role: string;
}

interface GrantOut {
  id: string;
  capability: string;
  capability_label: string;
  /** The CAPABILITY's declared scope, `SCOPED` or `PROGRAMME` — whether a
   *  mentor group narrows the key at all. NOT the grant's reach; that is
   *  `scope_level` below, and the module docstring says why they stay apart. */
  scope: string;
  /** B1.2 — the grant's own reach. Null on both means programme-wide, which is
   *  the grant this endpoint has always written, so the absent value has
   *  exactly one meaning. */
  scope_level: ScopeLevel | null;
  scope_id: string | null;
  /** Resolved server-side, the same way an override's target is. Reads
   *  "(removed)" for a target deleted after the grant was made. */
  scope_label: string | null;
  /** B2.4. */
  carries_pii: boolean;
  approval_state: string;
  approved_by: string | null;
  approved_at: string | null;
  review_at: string | null;
  subject_kind: string;
  subject_id: string;
  subject_label: string;
  reason: string;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
}

/** `GET /review` — the two lists an admin has to act on, and they are two on
 *  purpose. A pending grant holds nothing and somebody is waiting; an expiring
 *  one is working now and will stop. */
interface ReviewOut {
  horizon_days: number;
  pending: GrantOut[];
  expiring: GrantOut[];
}

interface GroupMemberOut {
  user_id: string;
  name: string;
  email: string;
}

interface GroupOut {
  id: string;
  name: string;
  description: string | null;
  members: GroupMemberOut[];
  capabilities: string[];
}

interface OverrideOut {
  id: string;
  feature: string;
  feature_label: string;
  enabled: boolean;
  students_affected: number;
}

// ---- what the template reads ----------------------------------------------

/** One row of the grants grid, with every cell already a sentence. */
interface GrantRow {
  id: string;
  functionKey: string;
  functionLabel: string;
  subjectLabel: string;
  subjectInitials: string;
  subjectKindLabel: string;
  /** The CAPABILITY's declared scope. Unchanged words, unchanged meaning. */
  functionScopeLabel: string;
  functionScopeIsProgrammeWide: boolean;
  /** B1.2 — the GRANT's reach, which is a different question. */
  reachLabel: string;
  reachIsNarrowed: boolean;
  reachIsWholeCollege: boolean;
  reachScopeId: string | null;
  grantedByLabel: string;
  expiresLabel: string;
  reviewLabel: string;
  statusLabel: string;
  statusTone: 'good' | 'warn' | 'risk';
  isPending: boolean;
  isExpiringSoon: boolean;
  isDueForReview: boolean;
  carriesPersonalData: boolean;
  approvedByLabel: string;
  reason: string;
  searchText: string;
}

/** One row of the functions catalogue. */
interface FunctionCatalogueRow {
  key: string;
  label: string;
  reachLabel: string;
  reachIsProgrammeWide: boolean;
  personalDataLabel: string;
  carriesPersonalData: boolean;
  enforcementLabel: string;
  enforcementIsReported: boolean;
  enforcementIsServerChecked: boolean;
  liveGrantCount: number;
}

/** One option of the scope-target select, flattened out of the hierarchy tree
 *  with its depth already in the label — a `<select>` cannot nest. */
interface ScopeOption {
  key: string;
  label: string;
}

type ScreenState = 'loading' | 'ready' | 'error';
type GovernanceTab = 'grants' | 'review' | 'catalogue' | 'groups';
type GrantSubjectMode = 'users' | 'groups';
type GrantStatusFilter = 'all' | 'live' | 'expiring' | 'pending';
/** The three lifecycle writes, which share one reason box. The value is also
 *  the last path segment of the endpoint, which is why it is these words. */
type GrantAction = 'approve' | 'extend' | 'revoke';

/** `APPROVAL_PENDING` in `models/governance.py`. A grant in this state is
 *  listed, audited and HOLDS NOTHING until a second holder of Governance
 *  approves it — the one fact this screen must never render as "Live". */
const APPROVAL_PENDING = 'pending_approval';

/** A grant inside this window is called out before it lapses, so a function
 *  nobody renewed is not discovered by the person who lost it. THE SERVER OWNS
 *  THIS NUMBER (`REVIEW_HORIZON_DAYS`) and reports it as `/review`'s
 *  `horizon_days`; this is only what the grid uses before that answer arrives.
 *  Pinning the client to its own 30 would let the review queue list a grant the
 *  grid beside it still calls "Live" the day somebody changes one of them. */
const EXPIRING_SOON_DAYS = 30;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const ROWS_PER_PAGE_CHOICES = [10, 25, 50];
const DEFAULT_ROWS_PER_PAGE = 10;

/** What a rung is called on screen. AGENTS.md: the UI says "Course",
 *  "Specialization" and "Batch" — `Cohort` is the stored name, not a label. */
const RUNG_LABEL: Record<ScopeLevel, string> = {
  COLLEGE: 'College',
  DEPARTMENT: 'Department',
  COURSE: 'Course',
  SPECIALIZATION: 'Specialization',
  COHORT: 'Batch',
  STUDENT: 'Student',
};

/** Two letters for the avatar: first and last word of the name. */
function initialsOf(name: string): string {
  const words = name.trim().split(' ').filter((word) => word.length > 0);
  if (words.length === 0) {
    return '?';
  }
  const first = words[0].charAt(0);
  if (words.length === 1) {
    return first.toUpperCase();
  }
  const last = words[words.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}

@Component({
  selector: 'app-governance',
  standalone: true,
  // RouterLink is REQUIRED for the two links out of this screen — student
  // feature switches and the audit log. A routerLink in a standalone component
  // that does not import it is inert markup that renders and does nothing.
  imports: [RouterLink, PluralPipe],
  templateUrl: './governance.component.html',
  styleUrl: './governance.component.scss',
})
export class GovernanceComponent {
  readonly rowsPerPageChoices = ROWS_PER_PAGE_CHOICES;

  readonly state = signal<ScreenState>('loading');
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly tab = signal<GovernanceTab>('grants');

  /** `?tab=review` opens the queue directly, so another screen can send an
   *  admin to the thing they asked for rather than to this screen's front page.
   *  The Faculty board's "Review expiring grants" is the caller.
   *
   *  Read ONCE at construction and never written back: the tab is ordinary
   *  in-screen state, and pushing every click into the URL would put four
   *  history entries between an admin and the screen they came from. An
   *  unrecognised value leaves the default standing rather than blanking the
   *  screen — a bad query string is somebody's stale bookmark, not an error. */
  private readonly openedAt = inject(ActivatedRoute).snapshot.queryParamMap.get('tab');

  /** WHO is granting decides whether a `carries_pii` grant waits: the Main
   *  Admin's grants are live at once, a deputy's wait for a second holder of
   *  Governance (B2.4, amended 2026-09-16). The SERVER decides
   *  (`initial_approval_state` in routers/governance.py); this only lets the
   *  button and the note say which act is about to happen, and `grantFlash`
   *  still reads the answer the server actually gave. */
  private readonly session = inject(AuthService).session;
  readonly isMainAdmin = computed(() => this.session()?.role === 'ADMIN');

  // ---- server data --------------------------------------------------------
  readonly capabilities = signal<CapabilityOut[]>([]);
  readonly studentFeatures = signal<FeatureOut[]>([]);
  readonly featureOverrides = signal<OverrideOut[]>([]);
  readonly minReason = signal(20);
  readonly staff = signal<StaffOut[]>([]);
  readonly grants = signal<GrantOut[]>([]);
  readonly groups = signal<GroupOut[]>([]);
  readonly hierarchy = signal<HierarchyNode[]>([]);

  private readonly functionSelect =
    viewChild<ElementRef<HTMLSelectElement>>('functionSelect');

  // =========================================================================
  // the institutional spine — scope targets, and the blast radius with them
  // =========================================================================

  private readonly nodeById = computed(() => {
    const byId = new Map<string, HierarchyNode>();
    for (const node of this.hierarchy()) {
      byId.set(node.id, node);
    }
    return byId;
  });

  /** Every id from this rung up to its college, itself included. Guarded
   *  against a cycle rather than trusting the shape: this walks server data,
   *  and a loop here would hang the screen rather than mis-render a cell. */
  private chainOf(id: string): Set<string> {
    const chain = new Set<string>();
    const byId = this.nodeById();
    let cursor: string | null = id;
    while (cursor && !chain.has(cursor)) {
      chain.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    return chain;
  }

  /** Does a grant with this reach touch the filtered rung?
   *
   *  TRUE ON THE WHOLE CHAIN, IN BOTH DIRECTIONS, and a programme-wide grant
   *  matches everything. Filtering to Civil has to show the grant scoped to one
   *  Civil batch (narrower) AND the one scoped to the college it sits in
   *  (wider) AND the un-narrowed ones, because all three reach a Civil student.
   *  A filter that showed only exact matches would answer "who can see Civil"
   *  with the shortest and most reassuring of the three lists. */
  private reachTouches(scopeId: string | null, filterId: string): boolean {
    if (!filterId) {
      return true;
    }
    if (!scopeId) {
      return true;
    }
    return this.chainOf(scopeId).has(filterId) || this.chainOf(filterId).has(scopeId);
  }

  readonly colleges = computed(() => this.hierarchy().filter((n) => n.scope === 'COLLEGE'));

  /** Departments of the chosen college, or all of them. Narrowing the second
   *  select from the first is what stops the pair offering a combination that
   *  can never match a row. */
  readonly departmentsInScope = computed(() => {
    const college = this.collegeFilter();
    return this.hierarchy().filter(
      (n) => n.scope === 'DEPARTMENT' && (college === '' || n.parent_id === college),
    );
  });

  /** Every rung, depth-first, with its student count — the grant form's scope
   *  target list. STUDENT is not offered: `/hierarchy` does not serve students
   *  (a college of them is not a dropdown) though the API would store one. */
  readonly scopeOptions = computed<ScopeOption[]>(() => {
    const childrenOf = new Map<string | null, HierarchyNode[]>();
    for (const node of this.hierarchy()) {
      const siblings = childrenOf.get(node.parent_id) ?? [];
      siblings.push(node);
      childrenOf.set(node.parent_id, siblings);
    }
    const out: ScopeOption[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null, depth: number): void => {
      for (const node of childrenOf.get(parent) ?? []) {
        if (seen.has(node.id)) {
          continue;
        }
        seen.add(node.id);
        out.push({
          key: `${node.scope}:${node.id}`,
          // NBSP, because a <select> collapses leading spaces in an <option>.
          label:
            `${'  '.repeat(depth)}${RUNG_LABEL[node.scope]} · ${node.label} — ` +
            `${plural(node.students, 'student')}`,
        });
        walk(node.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });

  /** Students in the whole college, summed from the top rung so the number the
   *  programme-wide warning quotes is the API's own count and not a guess. */
  readonly totalStudents = computed(() =>
    this.colleges().reduce((sum, node) => sum + node.students, 0),
  );

  private rungLabel(level: ScopeLevel | null): string {
    return level ? RUNG_LABEL[level] : 'Programme';
  }

  // =========================================================================
  // the grants grid
  // =========================================================================

  readonly quickFilter = signal('');
  readonly collegeFilter = signal('');
  readonly departmentFilter = signal('');
  readonly functionFilter = signal('');
  readonly statusFilter = signal<GrantStatusFilter>('all');
  readonly selectedGrantIds = signal<string[]>([]);
  readonly rowsPerPage = signal(DEFAULT_ROWS_PER_PAGE);
  readonly pageIndex = signal(0);
  readonly rowsAreCompact = signal(false);

  /** Role by user id, so a grant row can say "Faculty" beside the name. The
   *  grants endpoint returns a label, never a role; the staff endpoint has it. */
  private readonly roleByUserId = computed(() => {
    const byId = new Map<string, string>();
    for (const person of this.staff()) {
      byId.set(person.user_id, person.role);
    }
    return byId;
  });

  readonly grantRows = computed<GrantRow[]>(() =>
    this.grants().map((grant) => this.toGrantRow(grant)),
  );

  readonly filteredGrants = computed<GrantRow[]>(() => {
    const needle = this.quickFilter().trim().toLowerCase();
    const functionKey = this.functionFilter();
    const status = this.statusFilter();
    const college = this.collegeFilter();
    const department = this.departmentFilter();
    return this.grantRows().filter((row) => {
      if (needle.length > 0 && !row.searchText.includes(needle)) {
        return false;
      }
      if (functionKey.length > 0 && row.functionKey !== functionKey) {
        return false;
      }
      if (!this.reachTouches(row.reachScopeId, college)) {
        return false;
      }
      if (!this.reachTouches(row.reachScopeId, department)) {
        return false;
      }
      if (status === 'pending') {
        return row.isPending;
      }
      if (status === 'expiring') {
        return row.isExpiringSoon || row.isDueForReview;
      }
      if (status === 'live') {
        return !row.isPending && !row.isExpiringSoon && !row.isDueForReview;
      }
      return true;
    });
  });

  readonly pageCount = computed(() => {
    const pages = Math.ceil(this.filteredGrants().length / this.rowsPerPage());
    return Math.max(pages, 1);
  });
  readonly currentPage = computed(() => Math.min(this.pageIndex(), this.pageCount() - 1));
  readonly pagedGrants = computed<GrantRow[]>(() => {
    const start = this.currentPage() * this.rowsPerPage();
    return this.filteredGrants().slice(start, start + this.rowsPerPage());
  });
  readonly isFirstPage = computed(() => this.currentPage() === 0);
  readonly isLastPage = computed(() => this.currentPage() >= this.pageCount() - 1);
  readonly pagerLabel = computed(() => `Page ${this.currentPage() + 1} of ${this.pageCount()}`);
  readonly rowRangeLabel = computed(() => {
    const total = this.filteredGrants().length;
    if (total === 0) {
      return '0 of 0';
    }
    const first = this.currentPage() * this.rowsPerPage() + 1;
    const last = Math.min(first + this.rowsPerPage() - 1, total);
    return `${first} to ${last} of ${total}`;
  });

  readonly allOnPageAreSelected = computed(() => {
    const page = this.pagedGrants();
    if (page.length === 0) {
      return false;
    }
    const selected = new Set(this.selectedGrantIds());
    return page.every((row) => selected.has(row.id));
  });

  readonly expiringSoonCount = computed(
    () => this.grantRows().filter((row) => row.isExpiringSoon).length,
  );
  readonly pendingApprovalCount = computed(
    () => this.grantRows().filter((row) => row.isPending).length,
  );

  readonly collegeFilterLabel = computed(
    () => this.nodeById().get(this.collegeFilter())?.label ?? 'All colleges',
  );
  readonly departmentFilterLabel = computed(
    () => this.nodeById().get(this.departmentFilter())?.label ?? 'All departments',
  );
  readonly functionFilterLabel = computed(() => {
    const chosen = this.capabilities().find((one) => one.key === this.functionFilter());
    if (!chosen) {
      return 'All functions';
    }
    return chosen.label;
  });
  readonly statusFilterLabel = computed(() => {
    if (this.statusFilter() === 'live') {
      return 'Live';
    }
    if (this.statusFilter() === 'expiring') {
      return 'Needs review';
    }
    if (this.statusFilter() === 'pending') {
      return 'Awaiting approval';
    }
    return 'All';
  });

  private toGrantRow(grant: GrantOut): GrantRow {
    const functionIsProgrammeWide = grant.scope === 'PROGRAMME';
    const isGroup = grant.subject_kind === 'GROUP';
    const role = this.roleByUserId().get(grant.subject_id);
    const kindLabel = isGroup ? 'Access group' : this.staffRoleLabel(role);
    const isPending = grant.approval_state === APPROVAL_PENDING;
    const horizon = this.reviewHorizonDays();
    const expiringSoon = this.fallsWithin(grant.expires_at, horizon);
    const dueForReview = !expiringSoon && this.fallsWithin(grant.review_at, horizon);
    const isNarrowed = !!grant.scope_level && !!grant.scope_id;
    const reachLabel = isNarrowed
      ? `${this.rungLabel(grant.scope_level)} · ${grant.scope_label ?? grant.scope_id}`
      : 'Everything the function reaches';
    // THE THREE STATES ARE NOT ONE. "Awaiting approval" is a grant that does
    // nothing; "Expiring soon" is one that works and will stop; "Due for
    // review" is one with no end date that the queue has brought back up. A
    // single "needs attention" would put the dead one and the live one in the
    // same chip on the day they collide.
    let statusLabel = 'Live';
    let statusTone: 'good' | 'warn' | 'risk' = 'good';
    if (isPending) {
      statusLabel = 'Awaiting approval — holds nothing';
      statusTone = 'risk';
    } else if (expiringSoon) {
      statusLabel = 'Expiring soon';
      statusTone = 'warn';
    } else if (dueForReview) {
      statusLabel = 'Due for review';
      statusTone = 'warn';
    }
    const searchParts = [
      grant.subject_label,
      grant.capability_label,
      grant.reason,
      kindLabel,
      grant.scope_label ?? '',
      statusLabel,
    ];
    return {
      id: grant.id,
      functionKey: grant.capability,
      functionLabel: grant.capability_label,
      subjectLabel: grant.subject_label,
      subjectInitials: initialsOf(grant.subject_label),
      subjectKindLabel: kindLabel,
      functionScopeLabel: functionIsProgrammeWide ? 'Programme-wide' : 'Their mentor group',
      functionScopeIsProgrammeWide: functionIsProgrammeWide,
      reachLabel,
      reachIsNarrowed: isNarrowed,
      reachIsWholeCollege: !isNarrowed && functionIsProgrammeWide,
      reachScopeId: isNarrowed ? grant.scope_id : null,
      grantedByLabel: grant.granted_by ?? '—',
      expiresLabel: this.asDayLabel(grant.expires_at),
      reviewLabel: this.asDayLabel(grant.review_at),
      statusLabel,
      statusTone,
      isPending,
      isExpiringSoon: expiringSoon,
      isDueForReview: dueForReview,
      carriesPersonalData: grant.carries_pii,
      approvedByLabel: grant.approved_by ?? '—',
      reason: grant.reason,
      searchText: searchParts.join(' ').toLowerCase(),
    };
  }

  /** The vocabulary on screen is Student / Faculty / Alumni and Main Admin;
   *  "mentor" is a stored value, not a label (AGENTS.md). */
  private staffRoleLabel(role: string | undefined): string {
    if (role === 'ADMIN') {
      return 'Main Admin';
    }
    if (role === 'MENTOR') {
      return 'Faculty';
    }
    return 'Individual';
  }

  private asDayLabel(value: string | null): string {
    if (!value) {
      return '—';
    }
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) {
      return '—';
    }
    return when.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private fallsWithin(value: string | null, days: number): boolean {
    if (!value) {
      return false;
    }
    const when = new Date(value).getTime();
    if (Number.isNaN(when)) {
      return false;
    }
    return when <= Date.now() + days * MILLISECONDS_PER_DAY;
  }

  // ---- grid controls ------------------------------------------------------

  setQuickFilter(value: string): void {
    this.quickFilter.set(value);
    this.pageIndex.set(0);
  }

  /** Changing the college drops a department that is no longer inside it —
   *  otherwise the pair silently reads as "Civil, in a college Civil is not in"
   *  and the grid is empty for a reason nothing on screen explains. */
  setCollegeFilter(value: string): void {
    this.collegeFilter.set(value);
    const department = this.nodeById().get(this.departmentFilter());
    if (department && value !== '' && department.parent_id !== value) {
      this.departmentFilter.set('');
    }
    this.pageIndex.set(0);
  }

  setDepartmentFilter(value: string): void {
    this.departmentFilter.set(value);
    this.pageIndex.set(0);
  }

  setFunctionFilter(value: string): void {
    this.functionFilter.set(value);
    this.pageIndex.set(0);
  }

  setStatusFilter(value: string): void {
    this.statusFilter.set(value as GrantStatusFilter);
    this.pageIndex.set(0);
  }

  setRowsPerPage(value: string): void {
    const size = Number(value);
    if (Number.isNaN(size) || size <= 0) {
      return;
    }
    this.rowsPerPage.set(size);
    this.pageIndex.set(0);
  }

  goToPreviousPage(): void {
    this.pageIndex.set(Math.max(this.currentPage() - 1, 0));
  }

  goToNextPage(): void {
    this.pageIndex.set(Math.min(this.currentPage() + 1, this.pageCount() - 1));
  }

  toggleRowDensity(): void {
    this.rowsAreCompact.update((compact) => !compact);
  }

  isGrantSelected(id: string): boolean {
    return this.selectedGrantIds().includes(id);
  }

  toggleGrantSelection(id: string): void {
    this.selectedGrantIds.update((ids) =>
      ids.includes(id) ? ids.filter((one) => one !== id) : [...ids, id],
    );
  }

  toggleSelectionForPage(): void {
    const pageIds = this.pagedGrants().map((row) => row.id);
    if (this.allOnPageAreSelected()) {
      this.selectedGrantIds.update((ids) => ids.filter((one) => !pageIds.includes(one)));
      return;
    }
    this.selectedGrantIds.update((ids) => {
      const merged = new Set(ids);
      for (const id of pageIds) {
        merged.add(id);
      }
      return [...merged];
    });
  }

  // =========================================================================
  // the grant panel
  // =========================================================================

  readonly grantMode = signal<GrantSubjectMode>('users');
  readonly pickedUserIds = signal<string[]>([]);
  readonly pickedGroupIds = signal<string[]>([]);
  /** The dropdown's current value, before Add moves it into the chip list. */
  readonly userToAdd = signal('');
  readonly groupToAdd = signal('');
  readonly capabilityKey = signal('');
  /** `LEVEL:id`, or '' for the programme-wide grant. The empty string posts
   *  NEITHER field — not an empty one: `GrantIn` refuses a level without an id
   *  and an id without a level, and omitting both is the grant this endpoint
   *  has always written. */
  readonly grantScope = signal('');
  readonly grantExpiry = signal('');
  readonly grantReason = signal('');
  readonly grantBusy = signal(false);

  readonly scopedCapabilities = computed(() =>
    this.capabilities().filter((one) => one.scope === 'SCOPED'),
  );
  readonly programmeCapabilities = computed(() =>
    this.capabilities().filter((one) => one.scope === 'PROGRAMME'),
  );
  readonly chosenCapability = computed(
    () => this.capabilities().find((one) => one.key === this.capabilityKey()) ?? null,
  );
  readonly chosenScopeNode = computed(() => {
    const key = this.grantScope();
    if (!key) {
      return null;
    }
    return this.nodeById().get(key.slice(key.indexOf(':') + 1)) ?? null;
  });
  readonly pickedCount = computed(() =>
    this.grantMode() === 'users' ? this.pickedUserIds().length : this.pickedGroupIds().length,
  );
  /** Staff not already in the chip list — so the dropdown cannot offer a
   *  duplicate, and the Add button never silently does nothing. */
  readonly addableStaff = computed(() => {
    const picked = new Set(this.pickedUserIds());
    return this.staff().filter((person) => !picked.has(person.user_id));
  });
  readonly addableGroups = computed(() => {
    const picked = new Set(this.pickedGroupIds());
    return this.groups().filter((group) => !picked.has(group.id));
  });
  readonly pickedStaff = computed(() =>
    this.pickedUserIds()
      .map((id) => this.staff().find((person) => person.user_id === id))
      .filter((person): person is StaffOut => !!person),
  );
  readonly pickedGroups = computed(() =>
    this.pickedGroupIds()
      .map((id) => this.groups().find((group) => group.id === id))
      .filter((group): group is GroupOut => !!group),
  );

  readonly grantReasonShort = computed(
    () => this.grantReason().trim().length < this.minReason(),
  );
  readonly canGrant = computed(
    () => this.pickedCount() > 0 && !this.grantReasonShort() && !this.grantBusy(),
  );
  readonly grantBlockedBecause = computed(() => {
    if (this.pickedCount() === 0) {
      return this.grantMode() === 'users'
        ? 'Add at least one person'
        : 'Add at least one access group';
    }
    if (this.grantReasonShort()) {
      return `A reason of at least ${plural(this.minReason(), 'character')} is required`;
    }
    return null;
  });

  /** What the chosen function carries, in the panel's help line. Derived from
   *  the catalogue the API serves, never from a sentence typed here per key. */
  readonly chosenFunctionHelp = computed(() => {
    const chosen = this.chosenCapability();
    if (!chosen) {
      return 'Choose the function this grant hands over.';
    }
    const reach =
      chosen.scope === 'PROGRAMME'
        ? 'Programme-wide: no mentor group narrows it.'
        : 'Scoped: it reaches only students already in the holder’s mentor group.';
    if (chosen.carries_pii) {
      return `${reach} It shows a student’s own record.`;
    }
    return reach;
  });

  readonly chosenFunctionCarriesPersonalData = computed(() => {
    const chosen = this.chosenCapability();
    return !!chosen && chosen.carries_pii;
  });

  /** Whether THIS session's grant of the chosen function will wait for a
   *  second holder of Governance — a deputy's does, the Main Admin's never. */
  readonly chosenGrantNeedsApproval = computed(
    () => this.chosenFunctionCarriesPersonalData() && !this.isMainAdmin(),
  );

  /** THE BLAST RADIUS, recomputed on every change and counted in students.
   *  "86 students" is the sentence that makes a PII grant's cost visible; "AI &
   *  ML" is a name that costs nothing to read past. */
  readonly grantReach = computed(() => {
    const chosen = this.chosenCapability();
    const count = this.pickedCount();
    if (!chosen || count === 0) {
      return null;
    }
    const noun =
      this.grantMode() === 'users'
        ? plural(count, 'faculty member')
        : plural(count, 'access group');
    const inherit =
      this.grantMode() === 'groups' ? ' Every current and future member inherits it.' : '';
    const target = this.chosenScopeNode();
    if (target) {
      // A scope target narrows a PROGRAMME key to the rung. It narrows a SCOPED
      // one FURTHER — the mentor-group rule still applies on top — so the count
      // is a ceiling there and the sentence says so rather than promising it.
      const narrowing =
        chosen.scope === 'PROGRAMME'
          ? `${plural(target.students, 'student')} today`
          : `at most ${plural(target.students, 'student')}, and only those already in ` +
            'their own mentor group';
      return {
        wide: false,
        text:
          `Narrowed to ${this.rungLabel(target.scope).toLowerCase()} ${target.label}. ${noun} ` +
          `would reach ${chosen.label} for ${narrowing}.${inherit}`,
      };
    }
    if (chosen.scope === 'PROGRAMME') {
      return {
        wide: true,
        text:
          `Programme-wide, with no scope target. ${noun} would reach ${chosen.label} for every ` +
          `student in the college — ${plural(this.totalStudents(), 'student')} today. The ` +
          `mentor-group rule does not narrow this one.${inherit}`,
      };
    }
    return {
      wide: false,
      text:
        `Scoped, with no scope target. ${noun} would reach ${chosen.label} for students already ` +
        `in their own mentor group, and no one else.${inherit}`,
    };
  });

  /** ONE SUBMIT, TWO WORDS FOR IT. A `carries_pii` grant is not a different
   *  request — `POST /grants` writes a deputy's `pending_approval` by itself —
   *  so the board's separate "Send for approval" button would have been a
   *  second control for one act, and the honest version is the button saying
   *  which act it is about to perform. For the Main Admin it is always "Give
   *  access": the office's grants are live at once. */
  readonly grantButtonLabel = computed(() => {
    const count = this.pickedCount();
    if (this.chosenGrantNeedsApproval()) {
      return count > 1 ? `Send for approval · ${count}` : 'Send for approval';
    }
    if (count > 1) {
      return `Give access to ${count}`;
    }
    return 'Give access';
  });

  /** The review date the API will derive, said in words rather than guessed as
   *  a date: `POST /grants` takes no review date, and mirroring its default
   *  interval here would be a number that drifts the day the server's changes. */
  readonly reviewDerivedLabel = computed(() =>
    this.grantExpiry() ? 'At the expiry date' : 'On the API’s default interval',
  );

  setGrantMode(mode: GrantSubjectMode): void {
    this.grantMode.set(mode);
  }

  addUser(): void {
    const id = this.userToAdd();
    if (!id) {
      return;
    }
    this.pickedUserIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
    this.userToAdd.set('');
  }

  removeUser(id: string): void {
    this.pickedUserIds.update((ids) => ids.filter((one) => one !== id));
  }

  addGroup(): void {
    const id = this.groupToAdd();
    if (!id) {
      return;
    }
    this.pickedGroupIds.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
    this.groupToAdd.set('');
  }

  removeGroup(id: string): void {
    this.pickedGroupIds.update((ids) => ids.filter((one) => one !== id));
  }

  /** The header's "Grant function" — the panel is always on the Grants tab, so
   *  this moves there and puts the cursor where the grant starts. */
  focusGrantForm(): void {
    this.tab.set('grants');
    // The panel is only in the DOM on the Grants tab, so arriving from the
    // catalogue or the groups tab the query is still empty at this line and
    // the header button only changed tab, in silence. Focus after the view has
    // been rendered again.
    this.afterRender(() => this.functionSelect()?.nativeElement.focus());
  }

  /** Run once the current change-detection pass has put the node in the DOM. */
  private afterRender(work: () => void): void {
    setTimeout(work, 0);
  }

  clearGrantForm(): void {
    this.pickedUserIds.set([]);
    this.pickedGroupIds.set([]);
    this.userToAdd.set('');
    this.groupToAdd.set('');
    this.grantScope.set('');
    this.grantExpiry.set('');
    this.grantReason.set('');
  }

  async grant(): Promise<void> {
    if (!this.canGrant()) {
      return;
    }
    this.grantBusy.set(true);
    const body: Record<string, unknown> = {
      capability: this.capabilityKey(),
      reason: this.grantReason().trim(),
      user_ids: this.grantMode() === 'users' ? this.pickedUserIds() : [],
      group_ids: this.grantMode() === 'groups' ? this.pickedGroupIds() : [],
    };
    if (this.grantExpiry()) {
      body['expires_at'] = `${this.grantExpiry()}T23:59:59Z`;
    }
    // B1.2. BOTH OR NEITHER, and "neither" means the keys are absent rather
    // than present and empty: `GrantIn` refuses a half pair with a 422, and an
    // empty string in one of them is exactly that half pair.
    const scope = this.grantScope();
    if (scope) {
      const split = scope.indexOf(':');
      body['scope_level'] = scope.slice(0, split);
      body['scope_id'] = scope.slice(split + 1);
    }
    const created = await this.write<GrantOut[]>('POST', '/admin/governance/grants', body);
    this.grantBusy.set(false);
    if (created === null) {
      return;
    }
    this.flash.set(this.grantFlash(created));
    this.grantReason.set('');
    this.pickedUserIds.set([]);
    this.pickedGroupIds.set([]);
    await this.refreshGrants();
  }

  /** Say what was actually written. A grant that is awaiting approval must not
   *  be reported as "Granted": that is the admin walking away believing a
   *  colleague can open a screen that will refuse them. */
  private grantFlash(created: GrantOut[]): string {
    if (created.length === 0) {
      return 'Already held at that reach — nothing to change.';
    }
    const pending = created.filter((g) => g.approval_state === APPROVAL_PENDING).length;
    if (pending === created.length) {
      return (
        `Sent for approval: ${plural(created.length, 'grant')}. ` +
        'It holds nothing until a different admin approves it.'
      );
    }
    return `Granted to ${plural(created.length, 'subject')}.`;
  }

  // =========================================================================
  // the review queue — B2.4's two lists
  // =========================================================================

  readonly reviewHorizonDays = signal(EXPIRING_SOON_DAYS);
  readonly reviewPending = signal<GrantOut[]>([]);
  readonly reviewExpiring = signal<GrantOut[]>([]);

  readonly reviewPendingRows = computed<GrantRow[]>(() =>
    this.reviewPending().map((grant) => this.toGrantRow(grant)),
  );
  readonly reviewExpiringRows = computed<GrantRow[]>(() =>
    this.reviewExpiring().map((grant) => this.toGrantRow(grant)),
  );
  readonly reviewCount = computed(
    () => this.reviewPending().length + this.reviewExpiring().length,
  );

  openReviewQueue(): void {
    this.tab.set('review');
  }

  // =========================================================================
  // approve / extend / revoke — three writes, one reason box
  // =========================================================================

  /** The grants whose one shared reason box is open, and which write is about
   *  to be made. Empty means closed, and opening a second set closes the first
   *  — there is never more than one reason box on screen to mistake for
   *  another. ONE BOX FOR THREE WRITES because all three ask the same question
   *  and the API enforces the same floor on each; the kind is on the heading,
   *  the button and the endpoint, so nothing has to be guessed from context. */
  readonly actionKind = signal<GrantAction | null>(null);
  readonly actionIds = signal<string[]>([]);
  /** The reason box opens ABOVE the grid; a row on page five is far from it, so
   *  it takes focus rather than appearing off-screen. */
  private readonly actionReasonBox =
    viewChild<ElementRef<HTMLTextAreaElement>>('actionReasonBox');
  readonly actionReason = signal('');
  readonly actionExpiry = signal('');
  readonly actionReview = signal('');
  readonly actionBusy = signal(false);

  readonly actionRows = computed<GrantRow[]>(() => {
    const ids = new Set(this.actionIds());
    return this.grantRows().filter((row) => ids.has(row.id));
  });

  readonly actionReasonShort = computed(
    () => this.actionReason().trim().length < this.minReason(),
  );

  readonly actionTitle = computed(() => {
    const count = this.actionRows().length;
    switch (this.actionKind()) {
      case 'approve':
        return `Approve ${plural(count, 'grant')}`;
      case 'extend':
        return `Extend ${plural(count, 'grant')}`;
      case 'revoke':
        return count > 1 ? `Remove access · ${count}` : 'Remove access';
      default:
        return '';
    }
  });

  readonly actionVerb = computed(() => {
    switch (this.actionKind()) {
      case 'approve':
        return this.actionBusy() ? 'Approving…' : 'Approve';
      case 'extend':
        return this.actionBusy() ? 'Extending…' : 'Extend';
      default:
        return this.actionBusy() ? 'Removing…' : 'Remove access';
    }
  });

  readonly actionIcon = computed(() => {
    switch (this.actionKind()) {
      case 'approve':
        return 'how_to_reg';
      case 'extend':
        return 'schedule';
      default:
        return 'block';
    }
  });

  readonly actionButtonClass = computed(() =>
    this.actionKind() === 'revoke' ? 'btn danger' : 'btn primary',
  );

  readonly actionReasonPlaceholder = computed(() => {
    switch (this.actionKind()) {
      case 'approve':
        return 'Why this is agreed to, in a sentence someone can audit in a year.';
      case 'extend':
        return 'Why it is STILL needed — a fresh decision, not the first one repeated.';
      default:
        return 'Why this is being taken away, in a sentence someone can audit in a year.';
    }
  });

  readonly actionBlockedBecause = computed(() => {
    if (this.actionReasonShort()) {
      return `A reason of at least ${plural(this.minReason(), 'character')} is required`;
    }
    if (this.actionKind() === 'extend' && !this.actionExpiry() && !this.actionReview()) {
      return 'Name a new expiry, a new review date, or both';
    }
    return null;
  });

  readonly canRunAction = computed(
    () => this.actionBlockedBecause() === null && !this.actionBusy(),
  );

  startAction(kind: GrantAction, rows: GrantRow[]): void {
    // Approve only ever applies to a grant that is waiting for it; the API
    // answers 409 "already active" otherwise, and a batch that contained one
    // live row would stop there having done part of the work.
    const eligible = kind === 'approve' ? rows.filter((row) => row.isPending) : rows;
    if (eligible.length === 0) {
      return;
    }
    this.actionKind.set(kind);
    this.actionIds.set(eligible.map((row) => row.id));
    this.actionReason.set('');
    this.actionExpiry.set('');
    this.actionReview.set('');
    this.afterRender(() => this.actionReasonBox()?.nativeElement.focus());
  }

  startActionForSelection(kind: GrantAction): void {
    const selected = new Set(this.selectedGrantIds());
    this.startAction(
      kind,
      this.grantRows().filter((row) => selected.has(row.id)),
    );
  }

  cancelAction(): void {
    this.actionKind.set(null);
    this.actionIds.set([]);
    this.actionReason.set('');
    this.actionExpiry.set('');
    this.actionReview.set('');
  }

  /** Was a `window.prompt`. The reason is mandatory and >= `minReason` on the
   *  server, and a native prompt cannot enforce that before sending — so a
   *  short reason came back as a 422 the operator had to interpret. Inline, the
   *  confirm button simply stays disabled and says why, which is how the grant
   *  control on this same screen already behaves.
   *
   *  THE CLIENT-SIDE CHECK IS A HINT AND NOT THE RULE. The server refuses for
   *  reasons this form cannot know — approving your own grant, extending one
   *  that has already lapsed, a date in the past — and `write` puts its own
   *  sentence on screen when it does. */
  async runAction(): Promise<void> {
    const kind = this.actionKind();
    if (!kind || !this.canRunAction()) {
      return;
    }
    const rows = this.actionRows();
    if (rows.length === 0) {
      return;
    }
    this.actionBusy.set(true);
    const body: Record<string, unknown> = { reason: this.actionReason().trim() };
    if (kind === 'extend') {
      if (this.actionExpiry()) {
        body['expires_at'] = `${this.actionExpiry()}T23:59:59Z`;
      }
      if (this.actionReview()) {
        body['review_at'] = `${this.actionReview()}T23:59:59Z`;
      }
    }
    let doneCount = 0;
    try {
      for (const row of rows) {
        const done = await this.write<GrantOut>(
          'POST',
          `/admin/governance/grants/${row.id}/${kind}`,
          body,
        );
        if (done === null) {
          break;
        }
        doneCount = doneCount + 1;
      }
    } finally {
      this.actionBusy.set(false);
    }
    if (doneCount === 0) {
      return;
    }
    this.flash.set(this.actionFlash(kind, doneCount, rows[0]));
    this.cancelAction();
    this.selectedGrantIds.set([]);
    await this.refreshGrants();
  }

  private actionFlash(kind: GrantAction, count: number, first: GrantRow): string {
    if (kind === 'approve') {
      return count === 1
        ? `Approved “${first.functionLabel}” for ${first.subjectLabel}. It is live now.`
        : `Approved ${plural(count, 'grant')}. They are live now.`;
    }
    if (kind === 'extend') {
      return count === 1
        ? `Extended “${first.functionLabel}” for ${first.subjectLabel}.`
        : `Extended ${plural(count, 'grant')}.`;
    }
    return count === 1
      ? `Revoked “${first.functionLabel}” from ${first.subjectLabel}.`
      : `Revoked ${plural(count, 'function')}.`;
  }

  // =========================================================================
  // the functions catalogue
  // =========================================================================

  readonly functionCatalogue = computed<FunctionCatalogueRow[]>(() => {
    const liveGrantsByKey = new Map<string, number>();
    for (const grant of this.grants()) {
      liveGrantsByKey.set(grant.capability, (liveGrantsByKey.get(grant.capability) ?? 0) + 1);
    }
    return this.capabilities().map((capability) => ({
      key: capability.key,
      label: capability.label,
      reachLabel: capability.scope === 'PROGRAMME' ? 'Programme-wide' : 'Mentor group',
      reachIsProgrammeWide: capability.scope === 'PROGRAMME',
      personalDataLabel: capability.carries_pii ? 'Personal record' : 'No personal record',
      carriesPersonalData: capability.carries_pii,
      enforcementLabel: this.enforcementLabelFor(capability),
      enforcementIsReported: capability.enforced !== undefined,
      enforcementIsServerChecked: capability.enforced === true,
      liveGrantCount: liveGrantsByKey.get(capability.key) ?? 0,
    }));
  });

  /** THE HONEST ANSWER, and it is still "the API does not report this per row".
   *
   *  B2.1 answered the underlying question and answered it somewhere else:
   *  rather than adding an `enforced` flag to `/catalogue`, it DELETED the ten
   *  `student.*` keys that no call site checked, and
   *  `tools/ci/check_capability_enforcement.py` now fails CI if a key reaches
   *  no `require_capability` / `has_capability` / `scope_filter` call anywhere
   *  under `app/`. So the catalogue is enforced by construction — but this
   *  column can only report what the payload carries, and the payload carries
   *  nothing, so it says that instead of restating a guarantee it cannot see.
   *  A hand-kept list here of which keys are wired would be right only on the
   *  day it was written, which is the mistake the whole catalogue endpoint
   *  exists to avoid. */
  private enforcementLabelFor(capability: CapabilityOut): string {
    if (capability.enforced === undefined) {
      return 'Not reported here';
    }
    return capability.enforced ? 'Checked on every request' : 'Not wired yet';
  }

  readonly anyEnforcementIsReported = computed(() =>
    this.functionCatalogue().some((row) => row.enforcementIsReported),
  );

  // =========================================================================
  // access groups
  // =========================================================================

  readonly newGroupName = signal('');
  /** The name survives the request, so without this a second click before the
   *  first answered posted the same name twice and read back the API's 409. */
  readonly groupBusy = signal(false);
  readonly memberGroupId = signal('');
  readonly memberUserId = signal('');
  readonly memberReason = signal('');
  readonly memberBusy = signal(false);

  readonly memberReasonShort = computed(
    () => this.memberReason().trim().length < this.minReason(),
  );
  readonly canAddMember = computed(
    () =>
      this.memberGroupId().length > 0 &&
      this.memberUserId().length > 0 &&
      !this.memberReasonShort() &&
      !this.memberBusy(),
  );
  readonly addMemberBlockedBecause = computed(() => {
    if (this.memberGroupId().length === 0) {
      return 'Choose an access group';
    }
    if (this.memberUserId().length === 0) {
      return 'Choose a faculty member';
    }
    if (this.memberReasonShort()) {
      return `A reason of at least ${plural(this.minReason(), 'character')} is required`;
    }
    return null;
  });

  async createGroup(): Promise<void> {
    const name = this.newGroupName().trim();
    if (name.length < 2 || this.groupBusy()) {
      return;
    }
    this.groupBusy.set(true);
    const made = await this.write<GroupOut>('POST', '/admin/governance/groups', { name });
    this.groupBusy.set(false);
    if (made === null) {
      return;
    }
    this.newGroupName.set('');
    this.flash.set(`Created “${made.name}”.`);
    await this.refreshGrants();
  }

  /** Adding a member hands them every function the group holds, which is why
   *  the API asks for the same reason a grant asks for. */
  async addMemberToGroup(): Promise<void> {
    if (!this.canAddMember()) {
      return;
    }
    this.memberBusy.set(true);
    const groupId = this.memberGroupId();
    const done = await this.write<GroupOut>(
      'POST',
      `/admin/governance/groups/${groupId}/members`,
      { user_ids: [this.memberUserId()], reason: this.memberReason().trim() },
    );
    this.memberBusy.set(false);
    if (done === null) {
      return;
    }
    this.flash.set(`Added to “${done.name}”.`);
    this.memberUserId.set('');
    this.memberReason.set('');
    await this.refreshGrants();
  }

  async removeMemberFromGroup(group: GroupOut, member: GroupMemberOut): Promise<void> {
    const done = await this.write<GroupOut>(
      'DELETE',
      `/admin/governance/groups/${group.id}/members/${member.user_id}`,
      null,
    );
    if (done === null) {
      return;
    }
    this.flash.set(`Removed ${member.name} from “${group.name}”.`);
    await this.refreshGrants();
  }

  labelForFunctionKey(key: string): string {
    const known = this.capabilities().find((one) => one.key === key);
    if (!known) {
      return key;
    }
    return known.label;
  }

  // =========================================================================
  // the student feature switches, which live on their own screen now
  // =========================================================================

  readonly featureOverridesInForce = computed(
    () => this.featureOverrides().filter((override) => !override.enabled).length,
  );
  readonly featureSummary = computed(() => {
    const switches = this.studentFeatures().length;
    const inForce = this.featureOverridesInForce();
    if (inForce === 0) {
      return `${plural(switches, 'switch', 'switches')} · every feature is on for every student.`;
    }
    return (
      `${plural(switches, 'switch', 'switches')} · ${inForce} switched off ` +
      `${inForce === 1 ? 'somewhere' : 'in places'}.`
    );
  });

  constructor() {
    const asked = this.openedAt;
    if (asked === 'review' || asked === 'grants' || asked === 'catalogue' || asked === 'groups') {
      this.tab.set(asked);
    }
    void this.load();
  }

  // =========================================================================
  // loading
  // =========================================================================

  private async load(): Promise<void> {
    this.state.set('loading');
    try {
      const [catalogue, staff, grants, groups, overrides, spine, review] = await Promise.all([
        this.get<CatalogueOut>('/admin/governance/catalogue'),
        this.get<StaffOut[]>('/admin/governance/staff'),
        this.get<GrantOut[]>('/admin/governance/grants'),
        this.get<GroupOut[]>('/admin/governance/groups'),
        this.get<OverrideOut[]>('/admin/governance/features'),
        this.get<HierarchyNode[]>('/admin/governance/hierarchy'),
        this.get<ReviewOut>('/admin/governance/review'),
      ]);
      this.capabilities.set(catalogue.capabilities);
      this.studentFeatures.set(catalogue.features);
      this.minReason.set(catalogue.min_reason_chars);
      this.staff.set(staff);
      this.grants.set(grants);
      this.groups.set(groups);
      this.featureOverrides.set(overrides);
      this.hierarchy.set(spine);
      this.applyReview(review);
      if (!this.capabilityKey() && catalogue.capabilities.length > 0) {
        this.capabilityKey.set(catalogue.capabilities[0].key);
      }
      this.state.set('ready');
    } catch {
      this.error.set('Could not load governance. Reload the page to try again.');
      this.state.set('error');
    }
  }

  private applyReview(review: ReviewOut): void {
    this.reviewHorizonDays.set(review.horizon_days);
    this.reviewPending.set(review.pending);
    this.reviewExpiring.set(review.expiring);
  }

  /** Reload after a write. THIS CANNOT BE ALLOWED TO THROW: it is awaited from
   *  five handlers that have already set a success flash, so a failed reload
   *  used to surface as an unhandled rejection and a screen quietly showing the
   *  state from before the change. Say so instead.
   *
   *  The review queue is reloaded with the register, because every write on
   *  this screen moves a row between them: an approval empties the pending
   *  list, an extension takes a grant off the expiring one. */
  private async refreshGrants(): Promise<void> {
    try {
      const [grants, groups, review] = await Promise.all([
        this.get<GrantOut[]>('/admin/governance/grants'),
        this.get<GroupOut[]>('/admin/governance/groups'),
        this.get<ReviewOut>('/admin/governance/review'),
      ]);
      this.grants.set(grants);
      this.groups.set(groups);
      this.applyReview(review);
    } catch {
      this.error.set(
        'The change was saved, but this list could not be reloaded. Reload the page to see it.',
      );
    }
  }

  // =========================================================================
  // http
  // =========================================================================

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`${path}: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async write<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<T | null> {
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}${path}`, {
        method,
        credentials: 'include',
        headers: body === null ? {} : { 'Content-Type': 'application/json' },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return null;
      }
      if (response.status === 204) {
        return undefined as unknown as T;
      }
      return (await response.json()) as T;
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
      return null;
    }
  }

  /** The server's own sentence where there is one — its refusals name the
   *  numbers ("at least 20 characters") and a generic message would throw that
   *  away. FastAPI answers a schema error with `detail` as a LIST, which
   *  rendered raw says "[object Object]". */
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
