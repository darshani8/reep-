/**
 * Catalogue — what students may enrol in, and which certifications count.
 *
 * The board (docs/redesign-2026-09/design/admin/Catalogue.html) draws four
 * tabs over two different kinds of thing, and only two of the four have a
 * backend today. What each one is, and why it renders the way it does:
 *
 *  SUBJECTS are the curriculum — seeded code, grouped by semester, with the
 *  certifications mapped to each and how many students are enrolled. READ-ONLY
 *  here, and the honest shape today: a subject carries a code, a stage, a
 *  dimension, a semester and a delivery model, and a four-field form cannot
 *  supply those without inventing them. There is no write endpoint and this
 *  screen does not pretend there is one; the board's "Import subjects" is
 *  B13 and is drawn disabled.
 *
 *  CERTIFICATIONS ↔ BADGES is the Approved Certification Catalogue
 *  (framework §12), the list administration genuinely maintains: which
 *  external certificates count as evidence towards which badge. The grid is by
 *  BADGE because that is the question the screen answers — which of the 48
 *  badges a student can actually reach, and which have nothing mapped to them
 *  yet. THE BADGE CATALOGUE IS CODE (AGENTS.md, models/badge.py), so this
 *  screen offers no add, no edit and no retire for a badge; the board's "Add
 *  badge" and "Retire badge" would be buttons with no endpoint behind them and
 *  never will have one. What it does offer is the mapping: "Add certification"
 *  writes an approved certification against a badge, and "Remove" DEACTIVATES
 *  rather than deletes, so evidence students have already filed keeps its
 *  reference and the row can be brought back.
 *
 *  Category and Points are read off the badge (never typed), so the two can
 *  never disagree with the catalogue.
 *
 *  STAGE RULES and the college/course scope controls are B13 (Phase 4). There
 *  is no endpoint and no table, so the tab renders its empty state and a note
 *  saying what will fill it — never a plausible-looking row.
 *
 *  INTERVIEW TRACKS are real and READ-ONLY here: the four tracks the mock
 *  interviewer runs, from `GET /api/admin/interview-questions/tracks`. That
 *  endpoint is the Question bank's, and its capability is
 *  `admin.interview_questions` — an account holding only `admin.catalogue`
 *  gets a 403, which is a fact about the grant and not an error, so it is
 *  reported as a note rather than as a failure.
 *
 * ONE COLUMN DIFFERS FROM THE BOARD ON PURPOSE. The board's "Earned" column
 * needs a per-badge earned count, which no endpoint computes today. The column
 * shows CLAIMS instead — evidence rows filed against this badge's
 * certifications, a real number that arrives with the certifications — and the
 * note above the grid says so. A dash in every row would have been the other
 * honest option; a number nobody computed would not.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

/** A certification mapped to a taught subject, as the subjects table shows it. */
interface SubjectCertification {
  code: string;
  name: string;
  provider: string;
  required_hours: number;
  is_optional: boolean;
  link: string | null;
}

/** A taught subject — `Course` in the API, "subject" on the board and in the
 *  office's vocabulary, because "Course" is MBA in the institutional spine. */
interface Subject {
  code: string;
  name: string;
  stage: string;
  dimension: string;
  semester: number;
  teaching_hours: number;
  self_learning_hours_required: number;
  model_type: string;
  duration_weeks: number;
  enrolled: number;
  certifications: SubjectCertification[];
}

/** A row of the Approved Certification Catalogue. */
interface ApprovedCertification {
  id: string;
  name: string;
  provider: string;
  badge_code: string;
  badge_name: string;
  badge_category: string;
  badge_points: number;
  evidence_type: string;
  stage: string;
  duration_text: string | null;
  is_free: boolean;
  url: string | null;
  active: boolean;
  claims: number;
}

/** One of the 48 code-defined badges. */
interface Badge {
  code: string;
  name: string;
  category: string;
  category_label: string;
  stage: string;
  points: number;
}

/** A mock-interview track, read from the question bank. */
interface InterviewTrack {
  key: string;
  label: string;
  phases: string[];
  count: number;
  enabled_count: number;
}

type Tab = 'subjects' | 'badges' | 'stages' | 'tracks';

/** Whether a badge's certifications are mapped, as the grid filter asks it. */
type MappingFilter = 'ALL' | 'MAPPED' | 'UNMAPPED';

/** The catalogue's four stages, as the office says them. */
const STAGE_LABEL: Record<string, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  EXCEL_ADVANCED: 'Excel-Adv',
  ELEVATE: 'Elevate',
};

/** §8: readiness badges refuse evidence — staff award them when the
 *  assessment thresholds are met, so their verifier is not a mentor queue. */
const READINESS_CATEGORY = 'READINESS';

/** How many certification chips a grid row shows before it counts the rest. */
const CERTIFICATION_CHIPS_PER_ROW = 2;

/** The phase that makes the college/course scope, "Copy to course…", the
 *  subject import and the stage rules real (B13, 06-phase-prompts.md). */
const CATALOGUE_SCOPING_PHASE = 4;

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

@Component({
  selector: 'app-admin-catalogue',
  standalone: true,
  imports: [PendingControlDirective],
  templateUrl: './catalogue.component.html',
  styleUrl: './catalogue.component.scss',
})
export class AdminCatalogueComponent {
  readonly apiBase = environment.apiBase;
  readonly scopingPhase = CATALOGUE_SCOPING_PHASE;

  readonly tab = signal<Tab>('subjects');
  readonly subjects = signal<Subject[] | null>(null);
  readonly certifications = signal<ApprovedCertification[] | null>(null);
  readonly badges = signal<Badge[]>([]);
  readonly tracks = signal<InterviewTrack[] | null>(null);
  /** True when this account may read the catalogue but not the question bank. */
  readonly tracksNeedQuestionBank = signal(false);
  /** True when the tracks read FAILED (not a 403 — that is the grant note
   *  above). Without it the tab's else-branch says "Loading the interview
   *  tracks…" for ever, which is a spinner that is telling a lie. */
  readonly tracksFailed = signal(false);
  /** True when the Approved Certification Catalogue refused this account: it is
   *  the Main Admin's list (`require_admin`), while the screen itself opens on
   *  the grantable `admin.catalogue`. A granted faculty member therefore reads
   *  the subjects and is told plainly why the mapping is not theirs to edit —
   *  which is a fact about the grant, not a failure to load. */
  readonly certificationsAreMainAdminOnly = signal(false);

  /** The first read failed. It is NOT the same as "the catalogue is empty", and
   *  the two must not render the same sentence: `subjects.set([])` on a failed
   *  read made the table say "No courses in the catalogue yet" about a
   *  catalogue nobody could read. Failure leaves the signals null and this
   *  true, and every empty state asks this first. */
  readonly loadFailed = signal(false);

  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly loading = signal(true);

  readonly query = signal('');
  readonly skillArea = signal('ALL');
  readonly mapping = signal<MappingFilter>('ALL');
  readonly selectedBadgeCode = signal<string | null>(null);

  readonly formOpen = signal(false);
  readonly formName = signal('');
  readonly formProvider = signal('');
  readonly formBadgeCode = signal('');
  readonly formUrl = signal('');
  readonly formError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly busyCertificationId = signal<string | null>(null);

  /** Every skill area in the catalogue, for the filter — from the badges
   *  themselves, so a new category in models/badge.py appears here with it. */
  readonly skillAreas = computed(() => {
    const byValue = new Map<string, string>();
    for (const badge of this.badges()) {
      byValue.set(badge.category, badge.category_label);
    }
    return [...byValue].map(([value, label]) => ({ value, label }));
  });

  /** The skill-area pill reads the LABEL. The signal holds the badge category's
   *  raw value (`PLATFORM`), which is what the API filters on but not a word to
   *  put on a pill beside a dropdown that offered "Platform / Technical Skills". */
  readonly skillAreaLabel = computed(() => {
    const value = this.skillArea();
    if (value === 'ALL') return 'All';
    return this.skillAreas().find((area) => area.value === value)?.label ?? value;
  });

  readonly activeCertifications = computed(() =>
    (this.certifications() ?? []).filter((certification) => certification.active),
  );

  readonly removedCertifications = computed(() =>
    (this.certifications() ?? []).filter((certification) => !certification.active),
  );

  /** The badge rows the grid shows, after the quick filter and the two live
   *  filters. The quick filter searches the certifications too, because "where
   *  did we put PL-300" is the question that brings people to this screen. */
  readonly visibleBadges = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const area = this.skillArea();
    const mapping = this.mapping();
    return this.badges().filter((badge) => {
      if (area !== 'ALL' && badge.category !== area) return false;
      const mapped = this.activeCertificationsFor(badge.code).length > 0;
      if (mapping === 'MAPPED' && !mapped) return false;
      if (mapping === 'UNMAPPED' && mapped) return false;
      if (!needle) return true;
      return this.badgeMatches(badge, needle);
    });
  });

  readonly visibleSubjects = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const subjects = this.subjects() ?? [];
    if (!needle) return subjects;
    return subjects.filter((subject) => {
      const haystack = `${subject.code} ${subject.name} ${subject.dimension}`.toLowerCase();
      return haystack.includes(needle);
    });
  });

  readonly selectedBadge = computed(() => {
    const code = this.selectedBadgeCode();
    if (code === null) return null;
    return this.badges().find((badge) => badge.code === code) ?? null;
  });

  /** The selected badge's certifications, removed ones included: the drawer is
   *  where a removed row is brought back, so it has to be able to show one. */
  readonly selectedBadgeCertifications = computed(() => {
    const badge = this.selectedBadge();
    if (badge === null) return [];
    return this.certificationsFor(badge.code);
  });

  /** The evidence rules in play for the selected badge, read off the
   *  certifications mapped to it rather than guessed. */
  readonly selectedBadgeEvidenceRules = computed(() => {
    const rules = new Set<string>();
    for (const certification of this.selectedBadgeCertifications()) {
      if (certification.active) rules.add(certification.evidence_type);
    }
    return [...rules];
  });

  /** The badge the form maps to, for the derived Category / Points line. */
  readonly formBadge = computed(
    () => this.badges().find((badge) => badge.code === this.formBadgeCode()) ?? null,
  );

  constructor() {
    void this.load();
  }

  // --- reading -------------------------------------------------------------

  stageLabel(stage: string): string {
    return STAGE_LABEL[stage] ?? stage;
  }

  dimensionLabel(dimension: string): string {
    return titleCase(dimension);
  }

  evidenceRuleLabel(evidenceType: string): string {
    return titleCase(evidenceType);
  }

  subjectHours(subject: Subject): string {
    const total = subject.teaching_hours + subject.self_learning_hours_required;
    return `${Math.round(total * 10) / 10}`;
  }

  certificationsFor(badgeCode: string): ApprovedCertification[] {
    const rows = (this.certifications() ?? []).filter((row) => row.badge_code === badgeCode);
    const active = rows.filter((row) => row.active);
    const removed = rows.filter((row) => !row.active);
    return [...active, ...removed];
  }

  activeCertificationsFor(badgeCode: string): ApprovedCertification[] {
    return (this.certifications() ?? []).filter(
      (row) => row.badge_code === badgeCode && row.active,
    );
  }

  /** The first few chips a grid row shows. */
  chipCertificationsFor(badgeCode: string): ApprovedCertification[] {
    return this.activeCertificationsFor(badgeCode).slice(0, CERTIFICATION_CHIPS_PER_ROW);
  }

  /** How many more there are than the row has room for. */
  extraCertificationCount(badgeCode: string): number {
    const total = this.activeCertificationsFor(badgeCode).length;
    return Math.max(0, total - CERTIFICATION_CHIPS_PER_ROW);
  }

  /** Evidence rows students have filed against this badge's certifications,
   *  in any review state. NOT the number of students who earned the badge —
   *  see the module comment. */
  claimsFor(badgeCode: string): number {
    let claims = 0;
    for (const certification of this.certificationsFor(badgeCode)) {
      claims += certification.claims;
    }
    return claims;
  }

  badgeIsAwarded(badge: Badge): boolean {
    return badge.category === READINESS_CATEGORY;
  }

  verifierLabel(badge: Badge): string {
    return this.badgeIsAwarded(badge) ? 'Award' : 'Mentor';
  }

  verifierExplanation(badge: Badge): string {
    if (this.badgeIsAwarded(badge)) {
      return 'Readiness badges refuse evidence — staff award them when the assessment thresholds are met.';
    }
    return 'A student files evidence against one of these certifications; a mentor or the Main Admin approves it.';
  }

  // --- the grid and the drawer --------------------------------------------

  setTab(tab: Tab): void {
    this.tab.set(tab);
    this.query.set('');
    this.formOpen.set(false);
    this.formError.set(null);
    if (tab === 'tracks' && this.tracks() === null && !this.tracksNeedQuestionBank()) {
      void this.loadTracks();
    }
  }

  /** The tracks read failed; the tab offers the read again rather than sitting
   *  on a spinner. Real work, so it is a real button. */
  retryTracks(): void {
    void this.loadTracks();
  }

  selectBadge(badgeCode: string): void {
    const alreadyOpen = this.selectedBadgeCode() === badgeCode;
    this.selectedBadgeCode.set(alreadyOpen ? null : badgeCode);
  }

  closeDrawer(): void {
    this.selectedBadgeCode.set(null);
  }

  // --- the one write path: mapping a certification to a badge --------------

  openForm(badgeCode?: string): void {
    if (badgeCode !== undefined) this.formBadgeCode.set(badgeCode);
    if (!this.formBadgeCode() && this.badges().length) {
      this.formBadgeCode.set(this.badges()[0].code);
    }
    this.tab.set('badges');
    this.formOpen.set(true);
    this.formError.set(null);
  }

  closeForm(): void {
    this.formOpen.set(false);
    this.formError.set(null);
  }

  async addCertification(): Promise<void> {
    const name = this.formName().trim();
    if (!name) {
      this.formError.set('Give it a name first');
      return;
    }
    if (!this.formBadgeCode()) {
      this.formError.set('Pick the badge it counts towards');
      return;
    }
    const url = this.formUrl().trim();
    if (url && !/^https?:\/\//i.test(url)) {
      this.formError.set('The link must start with http:// or https://');
      return;
    }
    this.saving.set(true);
    this.formError.set(null);
    this.flash.set(null);
    try {
      const badge = this.formBadge();
      const response = await fetch(`${this.apiBase}/admin/approved-certifications`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          // The API requires a provider; "Unspecified" is what an empty field
          // honestly is, and it can be edited later.
          provider: this.formProvider().trim() || 'Unspecified',
          badge_code: this.formBadgeCode(),
          stage: badge?.stage ?? 'EXCEL',
          url: url || null,
        }),
      });
      if (!response.ok) {
        this.formError.set(await this.detailOf(response, 'Could not add that certification.'));
        return;
      }
      const row = (await response.json()) as ApprovedCertification;
      this.certifications.update((rows) => [row, ...(rows ?? [])]);
      this.formName.set('');
      this.formProvider.set('');
      this.formUrl.set('');
      this.formOpen.set(false);
      this.selectedBadgeCode.set(row.badge_code);
      this.flash.set(`${row.name} now counts towards ${row.badge_name}.`);
    } catch {
      this.formError.set('Could not reach the server.');
    } finally {
      this.saving.set(false);
    }
  }

  /** Remove from the catalogue = deactivate. The row keeps its history. */
  async setCertificationActive(
    certification: ApprovedCertification,
    active: boolean,
  ): Promise<void> {
    this.busyCertificationId.set(certification.id);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(
        `${this.apiBase}/admin/approved-certifications/${certification.id}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: certification.name,
            provider: certification.provider,
            badge_code: certification.badge_code,
            evidence_type: certification.evidence_type,
            stage: certification.stage,
            duration_text: certification.duration_text,
            is_free: certification.is_free,
            url: certification.url,
            active,
          }),
        },
      );
      if (!response.ok) {
        this.error.set(await this.detailOf(response, 'Could not update that certification.'));
        return;
      }
      const row = (await response.json()) as ApprovedCertification;
      this.certifications.update((rows) =>
        (rows ?? []).map((existing) => (existing.id === row.id ? row : existing)),
      );
      if (active) {
        this.flash.set(`${row.name} is back in the catalogue.`);
      } else {
        this.flash.set(`${row.name} is off the catalogue — evidence already filed keeps it.`);
      }
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.busyCertificationId.set(null);
    }
  }

  // --- loading -------------------------------------------------------------

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.loadFailed.set(false);
    try {
      const [subjectsResponse, certificationsResponse, badgesResponse] = await Promise.all([
        fetch(`${this.apiBase}/admin/catalogue`, { credentials: 'include' }),
        fetch(`${this.apiBase}/admin/approved-certifications`, { credentials: 'include' }),
        fetch(`${this.apiBase}/admin/badge-catalogue`, { credentials: 'include' }),
      ]);
      const certificationsRefused = certificationsResponse.status === 403;
      if (!subjectsResponse.ok || (!certificationsResponse.ok && !certificationsRefused)) {
        this.error.set('Could not load the catalogue.');
        this.loadFailed.set(true);
        return;
      }
      this.subjects.set((await subjectsResponse.json()) as Subject[]);
      if (certificationsRefused) {
        this.certificationsAreMainAdminOnly.set(true);
        this.certifications.set([]);
      } else {
        this.certifications.set((await certificationsResponse.json()) as ApprovedCertification[]);
      }
      if (badgesResponse.ok) {
        const badges = (await badgesResponse.json()) as Badge[];
        this.badges.set(badges);
        if (!this.formBadgeCode() && badges.length) this.formBadgeCode.set(badges[0].code);
      }
    } catch {
      this.error.set('Could not reach the server.');
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** The four tracks the mock interviewer runs. The endpoint belongs to the
   *  Question bank screen and asks for its capability, so a 403 here means
   *  "this account was not granted that function" — a note, not an error. */
  private async loadTracks(): Promise<void> {
    this.tracksFailed.set(false);
    this.error.set(null);
    try {
      const response = await fetch(`${this.apiBase}/admin/interview-questions/tracks`, {
        credentials: 'include',
      });
      if (response.status === 403) {
        this.tracksNeedQuestionBank.set(true);
        return;
      }
      if (!response.ok) {
        this.error.set('Could not load the interview tracks.');
        this.tracksFailed.set(true);
        return;
      }
      this.tracks.set((await response.json()) as InterviewTrack[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.tracksFailed.set(true);
    }
  }

  // --- helpers -------------------------------------------------------------

  private badgeMatches(badge: Badge, needle: string): boolean {
    const badgeText = `${badge.code} ${badge.name} ${badge.category_label}`.toLowerCase();
    if (badgeText.includes(needle)) return true;
    for (const certification of this.certificationsFor(badge.code)) {
      const certificationText = `${certification.name} ${certification.provider}`.toLowerCase();
      if (certificationText.includes(needle)) return true;
    }
    return false;
  }

  /** The server's own sentence where there is one. FastAPI answers a 422 with
   *  `detail` as a LIST, which renders as "[object Object]" if it is read
   *  straight onto the screen. */
  private async detailOf(response: Response, fallback: string): Promise<string> {
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* fall through to the fallback sentence */
    }
    return fallback;
  }
}
