/**
 * Placement & offers — the funnel for a batch and the offer decisions behind it.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/Placement.html` and
 * the brief is `02-admin-console-spec.md` §15. Four decisions in this build are
 * worth reading before changing it.
 *
 * THE FUNNEL DRAWS THE STAGES THE PAYLOAD CAN ANSWER, AND NAMES THE REST.
 * The board's funnel is six stages of DISTINCT STUDENTS — eligible, applied,
 * shortlisted, interviewed, offer received, placed. `GET /api/admin/placement`
 * counts three of those as distinct students today (`eligible`, `applied`,
 * `approved_students`); nothing on main records a shortlist or an interview
 * round, and `offers` is a count of OFFERS, not of the students holding them,
 * so drawing it in a funnel captioned "distinct students" would be a wrong
 * number rather than a missing one. Three stages are drawn, the other three are
 * named in the notice as `B12.3`, and nothing is guessed.
 *
 * A TILE NOBODY COMPUTES SHOWS A DASH. Placement rate is `approved_students`
 * over `eligible`, which is arithmetic on two figures the payload returns.
 * Median CTC, Highest and Multiple offers are not derivable from the newest
 * twenty-five offers the payload carries — a median of a page is not a median —
 * so those three tiles carry an em dash and a Phase 4 chip. The same holds for
 * the by-track split, which needs the offer-to-specialization link `B12.3`
 * adds.
 *
 * THE STATUS DONUT IS ARITHMETIC, NOT AN ESTIMATE. `offers` is every submitted
 * offer, `approved` is the approved ones and `GET /api/mentor/offers/pending`
 * is the authoritative pending list, so "not approved" is the remainder — three
 * real numbers, no sampling of the twenty-five rows on screen. When that
 * pending list does not answer (it is `require_admin`, so a MENTOR granted
 * `admin.placement` is refused it) the remainder is no longer a fact, and the
 * donut is WITHHELD rather than drawn off a floor.
 *
 * THE DECISION IS THE SELECTION. The board puts Reject and Approve offer in the
 * grid's toolbar over a checkbox column, so the selection is what gets decided;
 * only a PENDING offer is selectable, which is what makes "approve the
 * selection" unambiguous. Rejecting still needs a reason — the student is shown
 * it against their offer and nothing else — and the offers are posted one at a
 * time to `/mentor/offers/{id}/decision`, stopping at the first refusal with
 * the server's own sentence on screen rather than half a decision nobody can
 * see.
 *
 * The decision endpoint is `/mentor/offers/{id}/decision`, gated by
 * `require_admin` — the path says mentor, the guard says Main Admin, and the
 * guard is what governs. Kept there so there is one implementation of "approve
 * an offer".
 */

import { Component, ElementRef, OnDestroy, computed, effect, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AgGridAngular } from 'ag-grid-angular';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  RowSelectionOptions,
  SelectionChangedEvent,
  SelectionColumnDef,
  ValueFormatterParams,
} from 'ag-grid-community';

import * as echarts from 'echarts/core';
import { FunnelChart, PieChart } from 'echarts/charts';
import { LegendComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

import { environment } from '../../../../environments/environment';
import {
  REEP_CHART_THEME,
  SEQUENTIAL_RAMP,
  STATUS_COLOURS,
  registerReepChartTheme,
} from '../../../shared/charts/reep-echarts-theme';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

// The design system's chart theme, registered once for this lazily-loaded
// chunk. Registration alone does nothing — ECharts applies a theme at init —
// so every `echarts.init` below names it.
registerReepChartTheme(echarts);

echarts.use([FunnelChart, PieChart, TooltipComponent, LegendComponent, SVGRenderer]);

/** One submitted offer, as `GET /api/admin/placement` returns it. */
interface SubmittedOffer {
  id: string;
  student_id: string;
  student_name: string;
  usn: string | null;
  organisation: string;
  job_title: string;
  role_type: string;
  ctc_inr: number;
  status: string;
  created_at: string;
  decided_at: string | null;
}

/** One offer awaiting a decision, as `GET /api/mentor/offers/pending` returns
 *  it. Deliberately a smaller shape than the row above: no USN and no dates. */
interface OfferAwaitingDecision {
  id: string;
  student_id: string;
  student_name: string;
  job_title: string;
  organisation: string;
  role_type: string;
  ctc_inr: number;
  status: string;
}

/** `GET /api/admin/placement`. */
interface PlacementFigures {
  semester: number | null;
  eligible: number;
  applied: number;
  offers: number;
  approved: number;
  approved_students: number;
  recent: SubmittedOffer[];
  top_recruiters: { organisation: string; count: number }[];
}

/** One row of the Offers grid, reduced to what the board draws. */
interface OfferGridRow {
  id: string;
  studentName: string;
  initials: string;
  usn: string | null;
  organisation: string;
  jobTitle: string;
  roleTypeLabel: string;
  ctcInr: number;
  /** ISO, or null for a pending offer older than the newest twenty-five. */
  offerDate: string | null;
  status: string;
  statusLabel: string;
  statusTone: 'good' | 'warn' | 'risk';
  decidedAt: string | null;
}

/** One stage of the funnel, with what makes it a stage the payload can answer. */
interface FunnelStage {
  label: string;
  students: number;
}

const ROLE_LABEL: Record<string, string> = {
  FULL_TIME: 'Full-time',
  FULL_TIME_PLUS_INTERNSHIP: 'Job + internship',
  INTERNSHIP: 'Internship',
};

/** Offers per page in the grid, and what the page-size selector offers. */
const OFFERS_PER_PAGE = 10;
const PAGE_SIZE_CHOICES = [10, 25, 50];

/** The funnel's deepest fill, and how much lighter each stage below it is —
 *  the board's one purple stepping down, taken from the theme's own ramp. */
const FUNNEL_FILL = SEQUENTIAL_RAMP[1];
const FUNNEL_FADE_PER_STAGE = 0.16;

/** A stage with no students still has to be readable, so its bar keeps this
 *  much width and prints its zero rather than vanishing. */
const FUNNEL_MINIMUM_BAR = '12%';

/** Initials for the grid's avatar: first and last word of the name. */
function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const first = words[0].charAt(0);
  if (words.length === 1) return first.toUpperCase();
  const last = words[words.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}

/** Lakhs per annum, because that is how a CTC is read here. */
function ctcInLakhs(rupees: number): string {
  if (!rupees) return '—';
  const lakhs = rupees / 100_000;
  if (lakhs >= 10) return `₹ ${lakhs.toFixed(1)} LPA`;
  return `₹ ${lakhs.toFixed(2).replace(/0$/, '')} LPA`;
}

/** The status chip: text and tone together, in main's own words. */
function statusChipOf(status: string): { label: string; tone: 'good' | 'warn' | 'risk' } {
  if (status === 'APPROVED') return { label: 'Approved', tone: 'good' };
  if (status === 'REJECTED') return { label: 'Not approved', tone: 'risk' };
  return { label: 'Awaiting approval', tone: 'warn' };
}

/** AG Grid cell renderers build their own DOM, so a name out of the roster
 *  reaches innerHTML: escape it here rather than trusting the roster. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A cell renderer builds its DOM after Angular has compiled this component's
 *  stylesheet, so a class declared in placement.component.scss never reaches
 *  it — the emulated-encapsulation attribute is only put on template elements.
 *  `.avatar` and `.chip` are global and do reach it; everything else here is
 *  an inline style reading the design system's own tokens, which cascade into
 *  the grid's cells like any other element on the page. */
const FAINT_TEXT = 'color:var(--faint);font-size:11px';
const STACKED_CELL = 'display:inline-flex;flex-direction:column;line-height:1.25;min-width:0';

function renderStudentCell(params: ICellRendererParams<OfferGridRow>): string {
  const row = params.data;
  if (!row) return '';
  const usn = row.usn === null ? '' : `<span style="${FAINT_TEXT}">${escapeHtml(row.usn)}</span>`;
  return (
    `<span class="avatar">${escapeHtml(row.initials)}</span>` +
    `<span style="${STACKED_CELL}"><span>${escapeHtml(row.studentName)}</span>${usn}</span>`
  );
}

function renderRoleCell(params: ICellRendererParams<OfferGridRow>): string {
  const row = params.data;
  if (!row) return '';
  // The role type is USUALLY this file's own label, but `ROLE_LABEL` falls back
  // to the raw `role_type` the API sent, so it can be database text: escape it
  // like every other value that reaches innerHTML.
  return `${escapeHtml(row.jobTitle)} <span style="${FAINT_TEXT}">· ${escapeHtml(row.roleTypeLabel)}</span>`;
}

function renderStatusCell(params: ICellRendererParams<OfferGridRow>): string {
  const row = params.data;
  if (!row) return '';
  return `<span class="chip dot ${row.statusTone}">${row.statusLabel}</span>`;
}

/** The offer-letter column the board draws. `GET /api/admin/placement` returns
 *  no upload reference and no admin endpoint serves one, so every cell is a
 *  dash until B12.3 — a plausible file name here would be a fabricated record
 *  of a document nobody attached. */
function renderEvidenceCell(): string {
  return `<span style="${FAINT_TEXT}">—</span>`;
}

function formatCtc(params: ValueFormatterParams<OfferGridRow, number>): string {
  if (params.value === null || params.value === undefined) return '—';
  return ctcInLakhs(params.value);
}

function formatOfferDate(params: ValueFormatterParams<OfferGridRow, string | null>): string {
  if (!params.value) return '—';
  const when = new Date(params.value);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

@Component({
  selector: 'app-admin-placement',
  standalone: true,
  imports: [RouterLink, AgGridAngular, PendingControlDirective],
  templateUrl: './placement.component.html',
  styleUrl: './placement.component.scss',
})
export class AdminPlacementComponent implements OnDestroy {
  private readonly funnelChartHost = viewChild<ElementRef<HTMLDivElement>>('funnelChart');
  private readonly statusChartHost = viewChild<ElementRef<HTMLDivElement>>('statusChart');
  private readonly offersCard = viewChild<ElementRef<HTMLElement>>('offersCard');

  readonly gridTheme = reepGridTheme;
  readonly offersPerPage = OFFERS_PER_PAGE;
  readonly pageSizes = PAGE_SIZE_CHOICES;

  /** Every submitted offer this deployment can export today. The board's
   *  "Export offers" is this file; the batch-scoped `offers.csv` is B12.3. */
  readonly offersCsvUrl = `${environment.apiBase}/admin/exports/placement.csv`;

  readonly figures = signal<PlacementFigures | null>(null);
  readonly offersAwaitingDecision = signal<OfferAwaitingDecision[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly deciding = signal(false);
  readonly rejectionOpen = signal(false);
  readonly rejectionReason = signal('');
  readonly rejectionReasonMissing = signal(false);

  readonly quickFilter = signal('');
  readonly selectedOffers = signal<OfferGridRow[]>([]);

  private gridApi: GridApi<OfferGridRow> | null = null;
  private funnelChart: echarts.ECharts | null = null;
  private statusChart: echarts.ECharts | null = null;
  private funnelResizeObserver: ResizeObserver | null = null;
  private statusResizeObserver: ResizeObserver | null = null;

  constructor() {
    // AG Grid 33+ refuses to draw until its modules are registered, and fails
    // as an empty rectangle rather than an exception (shared/grid docstring).
    registerReepGrid();
    void this.loadPlacementFigures();
    void this.loadOffersAwaitingDecision();

    // Each chart element exists only while there is something to draw, so the
    // chart is created when it appears and disposed when it goes.
    effect(() => {
      const host = this.funnelChartHost();
      if (!host) {
        this.disposeFunnelChart();
        return;
      }
      this.drawFunnel(host.nativeElement);
    });
    effect(() => {
      const host = this.statusChartHost();
      if (!host) {
        this.disposeStatusChart();
        return;
      }
      this.drawOfferStatusDonut(host.nativeElement);
    });
  }

  ngOnDestroy(): void {
    this.disposeFunnelChart();
    this.disposeStatusChart();
  }

  // --- what the header and the funnel say ------------------------------------

  /** What the sub-line says while the figures are in flight, and after a
   *  failure. Main's own two sentences. */
  readonly figuresPlaceholderNote = computed<string>(() => {
    if (this.error()) return 'Placement figures unavailable.';
    return 'Loading the placement figures…';
  });

  /** The three stages `GET /api/admin/placement` counts as distinct students.
   *  Shortlisted, interviewed and offer-received are named in the notice. */
  readonly funnelStages = computed<FunnelStage[]>(() => {
    const placement = this.figures();
    if (!placement) return [];
    return [
      { label: 'Eligible students', students: placement.eligible },
      { label: 'Applied to ≥1 job', students: placement.applied },
      { label: 'Placed (approved offer)', students: placement.approved_students },
    ];
  });

  /** The chart is a `role="img"`, so its accessible name has to carry the
   *  numbers the bars draw — without this a screen reader is told a funnel
   *  exists and none of what is in it. */
  readonly funnelSummary = computed<string>(() => {
    const stages = this.funnelStages();
    if (stages.length === 0) return 'Placement funnel';
    const spoken = stages.map((stage) => `${stage.label}: ${stage.students} students`).join('; ');
    return `Placement funnel, counts are distinct students. ${spoken}.`;
  });

  readonly offerStatusSummary = computed<string>(() => {
    const split = this.offerStatusSplit();
    if (split.length === 0) return 'Submitted offers by status';
    const spoken = split.map((slice) => `${slice.label}: ${slice.count}`).join('; ');
    return `Submitted offers by status. ${spoken}.`;
  });

  readonly applyRatePercent = computed<number | null>(() => {
    const placement = this.figures();
    if (!placement || placement.eligible === 0) return null;
    return Math.round((placement.applied / placement.eligible) * 100);
  });

  readonly placementRatePercent = computed<number | null>(() => {
    const placement = this.figures();
    if (!placement || placement.eligible === 0) return null;
    return Math.round((placement.approved_students / placement.eligible) * 100);
  });

  /** The two conversion figures under the funnel that this payload can answer.
   *  The board's "Shortlist -> interview" and "Interview -> offer" need the two
   *  stages nothing counts yet, so they are named in the notice instead. */
  readonly funnelRates = computed<{ label: string; value: string }[]>(() => {
    const rates: { label: string; value: string }[] = [];
    const applyRate = this.applyRatePercent();
    if (applyRate !== null) {
      rates.push({ label: 'Apply rate', value: `${applyRate}%` });
    }
    const placementRate = this.placementRatePercent();
    if (placementRate !== null) {
      rates.push({ label: 'Placement rate', value: `${placementRate}%` });
    }
    return rates;
  });

  /** A rate nobody can compute — no student on the roster — is a dash, not a
   *  confident 0%. */
  readonly placementRateLabel = computed<string>(() => {
    const placementRate = this.placementRatePercent();
    if (placementRate === null) return '—';
    return `${placementRate}%`;
  });

  /** The board's first drop-off line: eligible students with no application. */
  readonly eligibleWhoNeverApplied = computed<number | null>(() => {
    const placement = this.figures();
    if (placement === null) return null;
    const neverApplied = placement.eligible - placement.applied;
    if (neverApplied < 0) return 0;
    return neverApplied;
  });

  readonly knowsEligibleWhoNeverApplied = computed(() => this.eligibleWhoNeverApplied() !== null);

  // --- the offers awaiting a decision ----------------------------------------

  /** The pending list is the authority on how many offers are waiting; when
   *  that call is refused, the offers already on screen are what is left to
   *  count, which is what this screen did before the list was read. */
  readonly offersAwaitingCount = computed<number>(() => {
    const awaiting = this.offersAwaitingDecision();
    if (awaiting !== null) return awaiting.length;
    return this.offerRows().filter((row) => row.status === 'PENDING_APPROVAL').length;
  });

  /** Whether that count is the TOTAL or only a floor. `GET /api/mentor/offers/
   *  pending` is `require_admin` — a MENTOR the Main Admin granted
   *  `admin.placement` is refused it — and the fallback above can only see the
   *  newest twenty-five offers, so on that account the number is "at least
   *  this many", and it is written that way rather than presented as a total. */
  readonly waitingCountIsExact = computed(() => this.offersAwaitingDecision() !== null);

  readonly offersAwaitingLabel = computed<string>(() =>
    this.waitingCountIsExact() ? `${this.offersAwaitingCount()}` : `${this.offersAwaitingCount()}+`,
  );

  /** Every offer on screen: the newest twenty-five the figures carry, plus any
   *  offer still awaiting a decision that is older than all of them. */
  readonly offerRows = computed<OfferGridRow[]>(() => {
    const placement = this.figures();
    const rows: OfferGridRow[] = [];
    if (placement !== null) {
      for (const offer of placement.recent) {
        rows.push(rowFromSubmittedOffer(offer));
      }
    }
    const idsAlreadyOnScreen = new Set(rows.map((row) => row.id));
    const awaiting = this.offersAwaitingDecision();
    if (awaiting !== null) {
      for (const offer of awaiting) {
        if (idsAlreadyOnScreen.has(offer.id)) continue;
        rows.push(rowFromOfferAwaitingDecision(offer));
      }
    }
    return rows;
  });

  readonly offersAreEmpty = computed(() => this.figures() !== null && this.offerRows().length === 0);

  /** The date on the oldest waiting offer — but only when every waiting offer
   *  carries one. An offer that is not among the newest twenty-five is OLDER
   *  than all of them, so "oldest 08 Sep" would name the wrong day. */
  readonly oldestWaitingOfferDate = computed<string | null>(() => {
    const waiting = this.offerRows().filter((row) => row.status === 'PENDING_APPROVAL');
    if (waiting.length === 0) return null;
    let oldest: string | null = null;
    for (const row of waiting) {
      if (row.offerDate === null) return null;
      if (oldest === null || row.offerDate < oldest) {
        oldest = row.offerDate;
      }
    }
    if (oldest === null) return null;
    return new Date(oldest).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  });

  readonly selectedOfferCount = computed(() => this.selectedOffers().length);

  readonly canDecideSelection = computed(() => this.selectedOfferCount() > 0 && !this.deciding());

  readonly topRecruiters = computed<{ organisation: string; count: number }[]>(() => {
    const placement = this.figures();
    if (placement === null) return [];
    return placement.top_recruiters;
  });
  readonly noRecruitersYet = computed(
    () => this.figures() !== null && this.topRecruiters().length === 0,
  );

  // --- the grid --------------------------------------------------------------

  readonly offerColumns: ColDef<OfferGridRow>[] = [
    {
      field: 'studentName',
      headerName: 'Student',
      pinned: 'left',
      minWidth: 220,
      flex: 1.6,
      cellStyle: { display: 'flex', alignItems: 'center', gap: '8px' },
      cellRenderer: renderStudentCell,
    },
    { field: 'organisation', headerName: 'Company', minWidth: 150, flex: 1.1 },
    {
      field: 'jobTitle',
      headerName: 'Role',
      minWidth: 200,
      flex: 1.5,
      cellRenderer: renderRoleCell,
    },
    {
      field: 'ctcInr',
      headerName: 'CTC',
      type: 'numericColumn',
      minWidth: 120,
      valueFormatter: formatCtc,
      headerTooltip: 'Cost to company as the student recorded it, in lakhs per annum',
    },
    {
      field: 'offerDate',
      headerName: 'Offer date',
      minWidth: 130,
      sort: 'desc',
      valueFormatter: formatOfferDate,
      headerTooltip: 'When the student submitted the offer for approval',
    },
    {
      colId: 'evidence',
      headerName: 'Evidence',
      minWidth: 130,
      sortable: false,
      filter: false,
      cellRenderer: renderEvidenceCell,
      headerTooltip: 'The offer letter travels with the scoped placement payload (B12.3)',
    },
    {
      field: 'statusLabel',
      headerName: 'Status',
      minWidth: 160,
      cellRenderer: renderStatusCell,
    },
  ];

  readonly defaultOfferColumn: ColDef<OfferGridRow> = {
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
    suppressHeaderMenuButton: false,
  };

  /** Only an offer still awaiting a decision can be selected, which is what
   *  makes "approve the selection" a sentence with one meaning. */
  readonly offerSelection: RowSelectionOptions<OfferGridRow> = {
    mode: 'multiRow',
    checkboxes: true,
    headerCheckbox: true,
    enableClickSelection: false,
    isRowSelectable: (node) => node.data?.status === 'PENDING_APPROVAL',
  };

  readonly selectionColumn: SelectionColumnDef = { pinned: 'left', width: 46 };

  onGridReady(event: GridReadyEvent<OfferGridRow>): void {
    this.gridApi = event.api;
  }

  onOfferSelectionChanged(event: SelectionChangedEvent<OfferGridRow>): void {
    this.selectedOffers.set(event.api.getSelectedRows());
  }

  setQuickFilter(event: Event): void {
    const box = event.target as HTMLInputElement;
    this.quickFilter.set(box.value);
  }

  /** The board's third tab. There is one Offers table and it is on this screen,
   *  so the tab brings it into view rather than pretending to be a route. */
  showOffers(): void {
    const card = this.offersCard();
    if (!card) return;
    card.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // The tab moves the reader's attention, so it moves the keyboard with it.
    card.nativeElement.focus({ preventScroll: true });
  }

  // --- the decision ----------------------------------------------------------

  openRejection(): void {
    this.rejectionOpen.set(true);
    this.rejectionReasonMissing.set(false);
  }

  cancelRejection(): void {
    this.rejectionOpen.set(false);
    this.rejectionReason.set('');
    this.rejectionReasonMissing.set(false);
  }

  setRejectionReason(event: Event): void {
    const box = event.target as HTMLInputElement;
    this.rejectionReason.set(box.value);
    this.rejectionReasonMissing.set(false);
  }

  async approveSelectedOffers(): Promise<void> {
    await this.decideSelectedOffers('APPROVE', null);
  }

  async confirmRejection(): Promise<void> {
    const reason = this.rejectionReason().trim();
    if (reason.length === 0) {
      this.rejectionReasonMissing.set(true);
      return;
    }
    await this.decideSelectedOffers('REJECT', reason);
  }

  /** One POST per offer, in order, stopping at the first refusal with the
   *  server's own sentence on screen. A loop that carried on would leave the
   *  office reading "2 approved" over a list where four were selected. */
  private async decideSelectedOffers(decision: 'APPROVE' | 'REJECT', note: string | null): Promise<void> {
    const chosen = this.selectedOffers();
    if (chosen.length === 0 || this.deciding()) return;

    this.deciding.set(true);
    this.error.set(null);
    this.flash.set(null);
    let decided = 0;
    for (const offer of chosen) {
      const wasDecided = await this.postDecision(offer, decision, note);
      if (!wasDecided) break;
      decided += 1;
    }
    this.deciding.set(false);

    if (decided > 0) {
      this.flash.set(this.decisionSentence(chosen[0], decision, decided));
      this.gridApi?.deselectAll();
      this.selectedOffers.set([]);
      this.cancelRejection();
      // The funnel, the donut and the recruiters moved too; re-read rather
      // than patch.
      await this.loadPlacementFigures();
      await this.loadOffersAwaitingDecision();
    }
  }

  private decisionSentence(first: OfferGridRow, decision: 'APPROVE' | 'REJECT', decided: number): string {
    if (decided === 1 && decision === 'APPROVE') {
      return `${first.studentName}'s offer from ${first.organisation} is approved and counts towards placement.`;
    }
    if (decided === 1) {
      return `${first.studentName}'s offer from ${first.organisation} was not approved; they have your remarks.`;
    }
    if (decision === 'APPROVE') {
      return `${decided} offers are approved and count towards placement.`;
    }
    return `${decided} offers were not approved; each student has your remarks.`;
  }

  private async postDecision(
    offer: OfferGridRow,
    decision: 'APPROVE' | 'REJECT',
    note: string | null,
  ): Promise<boolean> {
    try {
      const response = await fetch(`${environment.apiBase}/mentor/offers/${offer.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      if (!response.ok) {
        this.error.set(await detailOf(response, 'Could not record that decision.'));
        return false;
      }
      return true;
    } catch {
      this.error.set('Could not reach the server.');
      return false;
    }
  }

  // --- the two reads ---------------------------------------------------------

  private async loadPlacementFigures(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/admin/placement`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.error.set('Could not load the placement figures.');
        return;
      }
      this.figures.set((await response.json()) as PlacementFigures);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  /** The waiting list is read separately because the figures carry only the
   *  newest twenty-five offers, and an offer older than those is still an
   *  offer somebody is waiting on. A refusal here is not an error banner: the
   *  screen falls back to counting the offers it already has. */
  private async loadOffersAwaitingDecision(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/mentor/offers/pending`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.offersAwaitingDecision.set(null);
        return;
      }
      this.offersAwaitingDecision.set((await response.json()) as OfferAwaitingDecision[]);
    } catch {
      this.offersAwaitingDecision.set(null);
    }
  }

  // --- the two charts --------------------------------------------------------

  /** The board's funnel: one bar per stage, the count inside it and the stage
   *  name beside it. Two funnel series over the same geometry is what puts a
   *  label in both places — ECharts draws one label per series — and the second
   *  is transparent and silent, so it is furniture rather than a series. */
  private drawFunnel(host: HTMLDivElement): void {
    const stages = this.funnelStages();
    if (stages.length === 0) return;

    if (!this.funnelChart) {
      this.funnelChart = echarts.init(host, REEP_CHART_THEME, { renderer: 'svg' });
      // ECharts cannot size itself inside a flex/grid parent that changes
      // without the window doing so — the sidebar collapsing is exactly that.
      this.funnelResizeObserver = new ResizeObserver(() => this.funnelChart?.resize());
      this.funnelResizeObserver.observe(host);
    }

    const widest = Math.max(...stages.map((stage) => stage.students), 1);
    const bars = stages.map((stage, index) => ({
      name: stage.label,
      value: stage.students,
      itemStyle: { color: FUNNEL_FILL, opacity: 1 - index * FUNNEL_FADE_PER_STAGE },
    }));
    const geometry = {
      type: 'funnel',
      sort: 'none',
      min: 0,
      max: widest,
      minSize: FUNNEL_MINIMUM_BAR,
      maxSize: '100%',
      gap: 6,
      left: 0,
      width: '58%',
      top: 8,
      bottom: 8,
    };

    this.funnelChart.setOption(
      {
        tooltip: {
          trigger: 'item',
          formatter: (point: { name: string; value: number }) =>
            `<b>${point.name}</b><br/>${point.value} of ${widest} students`,
        },
        series: [
          {
            ...geometry,
            name: 'Placement funnel',
            data: bars,
            label: {
              show: true,
              position: 'inside',
              formatter: '{c}',
              color: '#ffffff',
              fontSize: 11,
              fontWeight: 600,
            },
            itemStyle: { borderWidth: 0, borderRadius: 3 },
          },
          {
            ...geometry,
            name: 'Placement funnel stages',
            silent: true,
            z: 1,
            data: bars.map((bar) => ({ name: bar.name, value: bar.value, itemStyle: { opacity: 0 } })),
            label: { show: true, position: 'right', formatter: '{b}', color: '#585566', fontSize: 11.5 },
          },
        ],
      },
      { notMerge: true },
    );
  }

  /** Approved, waiting and not approved, as three counts rather than a sample:
   *  every submitted offer is one of the three, so the third is the remainder. */
  readonly offerStatusSplit = computed<{ label: string; count: number }[]>(() => {
    const placement = this.figures();
    if (!placement || placement.offers === 0) return [];
    // "Not approved" is a REMAINDER, so it is only a fact while the waiting
    // count is a total. On an account the waiting list refuses, subtracting a
    // floor would move every unseen pending offer into the "not approved"
    // slice — a wrong number drawn with the confidence of a chart.
    if (!this.waitingCountIsExact()) return [];
    const waiting = this.offersAwaitingCount();
    const notApproved = placement.offers - placement.approved - waiting;
    return [
      { label: 'Approved', count: placement.approved },
      { label: 'Awaiting approval', count: waiting },
      { label: 'Not approved', count: notApproved < 0 ? 0 : notApproved },
    ];
  });

  /** No offers at all — the honest empty state. Distinct from the one below,
   *  which is offers this account cannot split. */
  readonly noOffersYet = computed(() => {
    const placement = this.figures();
    return placement !== null && placement.offers === 0;
  });

  /** Offers exist, but the waiting count is a floor, so the split is withheld. */
  readonly offerSplitUnavailable = computed(() => {
    const placement = this.figures();
    return placement !== null && placement.offers > 0 && !this.waitingCountIsExact();
  });

  private drawOfferStatusDonut(host: HTMLDivElement): void {
    const split = this.offerStatusSplit();
    if (split.length === 0) return;

    if (!this.statusChart) {
      this.statusChart = echarts.init(host, REEP_CHART_THEME, { renderer: 'svg' });
      this.statusResizeObserver = new ResizeObserver(() => this.statusChart?.resize());
      this.statusResizeObserver.observe(host);
    }

    this.statusChart.setOption(
      {
        // Status is not a series: the tones are the design system's own, so an
        // approved offer is the same green here as on its chip.
        color: [STATUS_COLOURS.good, STATUS_COLOURS.warn, STATUS_COLOURS.risk],
        tooltip: { trigger: 'item', formatter: '{b}: <b>{c}</b> ({d}%)' },
        legend: { bottom: 0, left: 'center', itemGap: 12 },
        series: [
          {
            type: 'pie',
            name: 'Offers by status',
            radius: ['54%', '78%'],
            center: ['50%', '42%'],
            avoidLabelOverlap: true,
            label: { show: false },
            data: split.map((slice) => ({ name: slice.label, value: slice.count })),
          },
        ],
      },
      { notMerge: true },
    );
  }

  private disposeFunnelChart(): void {
    this.funnelResizeObserver?.disconnect();
    this.funnelResizeObserver = null;
    this.funnelChart?.dispose();
    this.funnelChart = null;
  }

  private disposeStatusChart(): void {
    this.statusResizeObserver?.disconnect();
    this.statusResizeObserver = null;
    this.statusChart?.dispose();
    this.statusChart = null;
  }
}

function rowFromSubmittedOffer(offer: SubmittedOffer): OfferGridRow {
  const chip = statusChipOf(offer.status);
  return {
    id: offer.id,
    studentName: offer.student_name,
    initials: initialsOf(offer.student_name),
    usn: offer.usn,
    organisation: offer.organisation,
    jobTitle: offer.job_title,
    roleTypeLabel: ROLE_LABEL[offer.role_type] ?? offer.role_type,
    ctcInr: offer.ctc_inr,
    offerDate: offer.created_at,
    status: offer.status,
    statusLabel: chip.label,
    statusTone: chip.tone,
    decidedAt: offer.decided_at,
  };
}

function rowFromOfferAwaitingDecision(offer: OfferAwaitingDecision): OfferGridRow {
  const chip = statusChipOf(offer.status);
  return {
    id: offer.id,
    studentName: offer.student_name,
    initials: initialsOf(offer.student_name),
    usn: null,
    organisation: offer.organisation,
    jobTitle: offer.job_title,
    roleTypeLabel: ROLE_LABEL[offer.role_type] ?? offer.role_type,
    ctcInr: offer.ctc_inr,
    offerDate: null,
    status: offer.status,
    statusLabel: chip.label,
    statusTone: chip.tone,
    decidedAt: null,
  };
}

/** The server's own sentence where there is one — FastAPI answers a schema
 *  error with `detail` as a LIST, and rendering that raw says "[object
 *  Object]" on the screen the placement office is reading. */
async function detailOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
      return detail[0].msg;
    }
  } catch {
    /* fall through to the sentence this screen already had */
  }
  return fallback;
}
