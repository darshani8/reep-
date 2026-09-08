/**
 * Institution — the Main Admin's College → Department → Course →
 * Specialization → Batch console.
 *
 * THIS IS THE FIRST CALLER OF /api/admin/*. The write layer shipped with
 * twenty operations and no screen, which meant "optional to fill in the UI"
 * was true only in the sense that mattered least — there was no UI. Every
 * level here is created, listed and edited through those endpoints; nothing
 * is built through a seed.
 *
 * DRILL-DOWN, NOT A TREE WIDGET. Pick a college, its departments appear; pick
 * a department, its courses and its batches appear; pick a course, its
 * specializations appear. Each level is one select plus one inline "add"
 * form, so the whole hierarchy is one column and the batches are the other.
 *
 * THE BATCH FORM'S VALIDATORS COME FROM THE SERVER. `HierarchySchemaService`
 * fetches which of Course / Specialization is required; `buildBatchForm`
 * attaches `Validators.required` from that, and the "Required" / "Optional"
 * chip beside each select is the same flag. The word "Course" is never typed
 * in this file — it arrives as `level.label`. Flip the constant on the API and
 * this form follows with no edit.
 *
 * GRANDFATHERED ROWS STAY EDITABLE. A batch created while a level was optional
 * is blank there after the flip. The server lists it under
 * /cohorts/incomplete, flags it in `missing_levels`, and still accepts any
 * PATCH that does not widen the gap. So this form marks the control as
 * required (the admin should know) but excludes it from the save gate (the row
 * must not be bricked) — a validator's job is to TELL, the gate's job is to
 * REFUSE, and conflating them is how a switch becomes a lockout.
 *
 * CASCADING SELECTS ENFORCE CONTIGUITY. A specialization's parent is a course,
 * so "specialization, no course" is not representable in the database. The
 * specialization select is disabled until a course is picked, and changing the
 * course clears it. The server checks the same thing (a 422 from
 * _resolve_ancestry); the cascade just makes it unreachable from here.
 */

import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';

import { environment } from '../../../../environments/environment';
import { HierarchyLevel, HierarchySchemaService } from '../../../core/hierarchy-schema.service';

// ---- exact snake_case shapes of the admin router's Out models -------------

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

interface AcademicCourseOut {
  id: string;
  department_id: string;
  code: string;
  name: string;
  duration_months: number | null;
  status: string;
  specialization_count: number;
}

interface AcademicSpecializationOut {
  id: string;
  course_id: string;
  code: string;
  name: string;
  status: string;
  cohort_count: number;
}

interface AdminStudentRowOut {
  student_id: string;
  name: string;
  email: string;
  usn: string | null;
  current_stage: string | null;
  cohort_id: string | null;
}

interface AdminCohortOut {
  id: string;
  department_id: string | null;
  course_id: string | null;
  specialization_id: string | null;
  code: string;
  name: string;
  batch_label: string;
  degree_level: string;
  entry_date: string;
  expected_completion: string;
  student_count: number;
  missing_levels: string[];
}

type ScreenState = 'loading' | 'ready' | 'error';

/** The three optional-level keys the form binds; anything else is a bug in HIERARCHY_LEVELS. */
const LEVEL_OPTIONS: Record<string, 'courses' | 'specializations'> = {
  course: 'courses',
  specialization: 'specializations',
};

@Component({
  selector: 'app-director-institution',
  standalone: true,
  imports: [NgTemplateOutlet, ReactiveFormsModule],
  templateUrl: './institution.component.html',
  styleUrl: './institution.component.scss',
})
export class DirectorInstitutionComponent {
  private readonly schema = inject(HierarchySchemaService);

  // ---- screen -------------------------------------------------------------
  readonly state = signal<ScreenState>('loading');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly flash = signal<string | null>(null);

  /** The switch, as served. Labels and required flags both come from here. */
  readonly levels = signal<HierarchyLevel[]>([]);

  // ---- the hierarchy ------------------------------------------------------
  readonly colleges = signal<CollegeOut[]>([]);
  readonly selectedCollegeId = signal<string | null>(null);
  readonly departments = signal<DepartmentOut[]>([]);
  readonly selectedDepartmentId = signal<string | null>(null);
  readonly courses = signal<AcademicCourseOut[]>([]);
  readonly selectedCourseId = signal<string | null>(null);
  readonly specializations = signal<AcademicSpecializationOut[]>([]);

  readonly selectedCollege = computed(
    () => this.colleges().find((c) => c.id === this.selectedCollegeId()) ?? null,
  );
  readonly selectedDepartment = computed(
    () => this.departments().find((d) => d.id === this.selectedDepartmentId()) ?? null,
  );
  readonly selectedCourse = computed(
    () => this.courses().find((c) => c.id === this.selectedCourseId()) ?? null,
  );

  // ---- batches ------------------------------------------------------------
  readonly batches = signal<AdminCohortOut[]>([]);
  /** Batches missing a now-required level — the morning-after-the-flip inbox. */
  readonly incomplete = signal<AdminCohortOut[]>([]);
  /** Batches filed under no department — the other inbox. */
  readonly unassigned = signal<AdminCohortOut[]>([]);

  /** Course options for the batch form (the selected department's), and the
   *  specialization options for whichever course the FORM has picked — which
   *  may differ from the structure column's selection. */
  readonly formSpecializations = signal<AcademicSpecializationOut[]>([]);

  readonly batchMode = signal<'closed' | 'create' | 'edit'>('closed');
  readonly editingBatchId = signal<string | null>(null);
  /** Levels required NOW that were blank on the row AS LOADED. See class doc. */
  readonly grandfathered = signal<Set<string>>(new Set());
  readonly batchError = signal<string | null>(null);

  // --- seating: who is in a batch, and who is in none ---------------------
  // The panel for one batch. Opening it loads two lists that must agree with
  // the write: a student is in exactly one of them.
  readonly seatingBatch = signal<AdminCohortOut | null>(null);
  readonly seated = signal<AdminStudentRowOut[]>([]);
  readonly unseated = signal<AdminStudentRowOut[]>([]);
  readonly seatPick = signal<string | null>(null);

  batchForm: FormGroup = this.buildBatchForm([]);

  // ---- inline "add" drafts ------------------------------------------------
  readonly collegeDraft = signal({ code: '', name: '', campus: '' });
  readonly departmentDraft = signal({ code: '', name: '', head: '' });
  readonly courseDraft = signal({ code: '', name: '', duration_months: '' });
  readonly specializationDraft = signal({ code: '', name: '' });
  readonly openAdd = signal<'college' | 'department' | 'course' | 'specialization' | null>(null);

  readonly degreeLevels = ['UG', 'PG'];

  constructor() {
    void this.load();
  }

  // =========================================================================
  // loading
  // =========================================================================

  async load(): Promise<void> {
    this.state.set('loading');
    this.error.set(null);
    try {
      const [levels, colleges, incomplete, unassigned] = await Promise.all([
        this.schema.load(),
        this.get<CollegeOut[]>('/admin/colleges'),
        this.get<AdminCohortOut[]>('/admin/cohorts/incomplete'),
        this.get<AdminCohortOut[]>('/admin/cohorts/unassigned'),
      ]);
      this.levels.set(levels);
      this.batchForm = this.buildBatchForm(levels);
      this.colleges.set(colleges);
      this.incomplete.set(incomplete);
      this.unassigned.set(unassigned);
      if (colleges.length && !this.selectedCollegeId()) {
        await this.pickCollege(colleges[0].id);
      }
      this.state.set('ready');
    } catch (e) {
      this.error.set(
        e instanceof TypeError
          ? 'Could not reach the server.'
          : 'The institution structure could not be loaded.',
      );
      this.state.set('error');
    }
  }

  async pickCollege(id: string | null): Promise<void> {
    this.selectedCollegeId.set(id);
    this.selectedDepartmentId.set(null);
    this.departments.set([]);
    this.courses.set([]);
    this.specializations.set([]);
    this.batches.set([]);
    this.closeBatchForm();
    if (!id) return;
    const departments = await this.get<DepartmentOut[]>(`/admin/colleges/${id}/departments`);
    this.departments.set(departments);
    if (departments.length) await this.pickDepartment(departments[0].id);
  }

  async pickDepartment(id: string | null): Promise<void> {
    this.selectedDepartmentId.set(id);
    this.selectedCourseId.set(null);
    this.courses.set([]);
    this.specializations.set([]);
    this.batches.set([]);
    this.closeBatchForm();
    if (!id) return;
    const [courses, batches] = await Promise.all([
      this.get<AcademicCourseOut[]>(`/admin/departments/${id}/academic-courses`),
      this.get<AdminCohortOut[]>(`/admin/departments/${id}/cohorts`),
    ]);
    this.courses.set(courses);
    this.batches.set(batches);
    if (courses.length) await this.pickCourse(courses[0].id);
  }

  async pickCourse(id: string | null): Promise<void> {
    this.selectedCourseId.set(id);
    this.specializations.set([]);
    if (!id) return;
    this.specializations.set(
      await this.get<AcademicSpecializationOut[]>(
        `/admin/academic-courses/${id}/academic-specializations`,
      ),
    );
  }

  // =========================================================================
  // inline creates — one small form per level, same shape each time
  // =========================================================================

  toggleAdd(which: 'college' | 'department' | 'course' | 'specialization'): void {
    this.openAdd.update((cur) => (cur === which ? null : which));
  }

  setDraft(
    which: 'college' | 'department' | 'course' | 'specialization',
    field: string,
    value: string,
  ): void {
    const target = {
      college: this.collegeDraft,
      department: this.departmentDraft,
      course: this.courseDraft,
      specialization: this.specializationDraft,
    }[which] as ReturnType<typeof signal<Record<string, string>>>;
    target.update((d) => ({ ...d, [field]: value }));
  }

  async addCollege(): Promise<void> {
    const d = this.collegeDraft();
    const created = await this.post<CollegeOut>('/admin/colleges', {
      code: d.code,
      name: d.name,
      campus: d.campus || null,
    });
    if (!created) return;
    this.colleges.update((list) => [...list, created]);
    this.collegeDraft.set({ code: '', name: '', campus: '' });
    this.openAdd.set(null);
    this.flash.set(`Added college ${created.code}`);
    await this.pickCollege(created.id);
  }

  async addDepartment(): Promise<void> {
    const college = this.selectedCollegeId();
    if (!college) return;
    const d = this.departmentDraft();
    const created = await this.post<DepartmentOut>(`/admin/colleges/${college}/departments`, {
      code: d.code,
      name: d.name,
      head: d.head || null,
    });
    if (!created) return;
    this.departments.update((list) => [...list, created]);
    this.departmentDraft.set({ code: '', name: '', head: '' });
    this.openAdd.set(null);
    this.flash.set(`Added department ${created.code}`);
    await this.pickDepartment(created.id);
  }

  async addCourse(): Promise<void> {
    const department = this.selectedDepartmentId();
    if (!department) return;
    const d = this.courseDraft();
    const created = await this.post<AcademicCourseOut>(
      `/admin/departments/${department}/academic-courses`,
      {
        code: d.code,
        name: d.name,
        duration_months: d.duration_months ? Number(d.duration_months) : null,
      },
    );
    if (!created) return;
    this.courses.update((list) => [...list, created]);
    this.courseDraft.set({ code: '', name: '', duration_months: '' });
    this.openAdd.set(null);
    this.flash.set(`Added course ${created.code}`);
    await this.pickCourse(created.id);
  }

  async addSpecialization(): Promise<void> {
    const course = this.selectedCourseId();
    if (!course) return;
    const d = this.specializationDraft();
    const created = await this.post<AcademicSpecializationOut>(
      `/admin/academic-courses/${course}/academic-specializations`,
      { code: d.code, name: d.name },
    );
    if (!created) return;
    this.specializations.update((list) => [...list, created]);
    this.specializationDraft.set({ code: '', name: '' });
    this.openAdd.set(null);
    this.flash.set(`Added specialization ${created.code}`);
  }

  // =========================================================================
  // the batch form
  // =========================================================================

  /** Controls for the fixed fields plus ONE per served level, validators from
   *  `required`. Nothing here names a level. */
  private buildBatchForm(levels: HierarchyLevel[]): FormGroup {
    const controls: Record<string, FormControl> = {
      code: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      batch_label: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      degree_level: new FormControl('PG', { nonNullable: true, validators: [Validators.required] }),
      entry_date: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      expected_completion: new FormControl('', {
        nonNullable: true,
        validators: [Validators.required],
      }),
    };
    for (const lv of levels) {
      controls[lv.field] = new FormControl<string | null>(
        null,
        lv.required ? [Validators.required] : [],
      );
    }
    return new FormGroup(controls);
  }

  levelControl(lv: HierarchyLevel): FormControl {
    return this.batchForm.get(lv.field) as FormControl;
  }

  levelOptions(lv: HierarchyLevel): { id: string; code: string; name: string }[] {
    const which = LEVEL_OPTIONS[lv.key];
    if (which === 'courses') return this.courses();
    if (which === 'specializations') return this.formSpecializations();
    return [];
  }

  /** A level is disabled until its parent has a value — the cascade. */
  levelDisabled(lv: HierarchyLevel): boolean {
    if (lv.key === 'specialization') return !this.batchForm.get('course_id')?.value;
    return false;
  }

  async onLevelChange(lv: HierarchyLevel): Promise<void> {
    if (lv.key !== 'course') return;
    // Changing the course clears anything under it and reloads its options.
    const courseId = this.batchForm.get('course_id')?.value as string | null;
    this.batchForm.get('specialization_id')?.setValue(null);
    this.formSpecializations.set(
      courseId
        ? await this.get<AcademicSpecializationOut[]>(
            `/admin/academic-courses/${courseId}/academic-specializations`,
          )
        : [],
    );
  }

  openCreateBatch(): void {
    this.batchForm = this.buildBatchForm(this.levels());
    this.formSpecializations.set([]);
    this.grandfathered.set(new Set());
    this.editingBatchId.set(null);
    this.batchError.set(null);
    this.batchMode.set('create');
  }

  async openEditBatch(b: AdminCohortOut): Promise<void> {
    this.batchForm = this.buildBatchForm(this.levels());
    this.batchForm.patchValue({
      code: b.code,
      name: b.name,
      batch_label: b.batch_label,
      degree_level: b.degree_level,
      entry_date: b.entry_date,
      expected_completion: b.expected_completion,
      course_id: b.course_id,
      specialization_id: b.specialization_id,
    });
    this.batchForm.get('code')?.disable(); // the code is the batch's handle; not edited here
    this.formSpecializations.set(
      b.course_id
        ? await this.get<AcademicSpecializationOut[]>(
            `/admin/academic-courses/${b.course_id}/academic-specializations`,
          )
        : [],
    );
    // Required NOW, blank on the row AS LOADED. Anything the admin clears
    // during this edit is NOT grandfathered — that is a fresh gap, and it is
    // refused normally.
    this.grandfathered.set(
      new Set(this.levels().filter((lv) => lv.required && !(b as any)[lv.field]).map((lv) => lv.field)),
    );
    this.editingBatchId.set(b.id);
    this.batchError.set(null);
    this.batchMode.set('edit');
  }

  closeBatchForm(): void {
    this.batchMode.set('closed');
    this.editingBatchId.set(null);
    this.batchError.set(null);
  }

  /** A validator TELLS; this gate REFUSES. Grandfathered blanks are excluded
   *  from the gate so a legacy batch is never bricked by the flip. */
  readonly saveBlocked = computed(() => {
    if (this.busy()) return true;
    const form = this.batchForm;
    const grand = this.grandfathered();
    for (const name of Object.keys(form.controls)) {
      const c = form.get(name);
      if (c && c.invalid && !c.disabled && !grand.has(name)) return true;
    }
    return false;
  });

  isGrandfathered(lv: HierarchyLevel): boolean {
    return this.grandfathered().has(lv.field);
  }

  async saveBatch(): Promise<void> {
    const department = this.selectedDepartmentId();
    if (!department) return;
    this.batchError.set(null);
    const raw = this.batchForm.getRawValue() as Record<string, unknown>;

    // Send the DEEPEST level only; the API derives its ancestors. Sending
    // both is also fine — they are checked, not trusted — but sending only
    // the leaf is the contract stated plainly.
    const body: Record<string, unknown> = {
      name: raw['name'],
      batch_label: raw['batch_label'],
      entry_date: raw['entry_date'],
      expected_completion: raw['expected_completion'],
    };
    if (this.batchMode() === 'create') {
      body['code'] = raw['code'];
      body['degree_level'] = raw['degree_level'];
    }
    for (const lv of this.levels()) {
      const v = raw[lv.field] as string | null;
      // Omit-means-keep on edit; on create a null is simply "not chosen".
      if (this.batchMode() === 'create' ? v : v !== undefined) body[lv.field] = v || null;
    }

    const res =
      this.batchMode() === 'create'
        ? await this.post<AdminCohortOut>(`/admin/departments/${department}/cohorts`, body, true)
        : await this.patch<AdminCohortOut>(`/admin/cohorts/${this.editingBatchId()}`, body, true);
    if (!res) return;
    this.flash.set(this.batchMode() === 'create' ? `Created batch ${res.code}` : `Saved ${res.code}`);
    this.closeBatchForm();
    await Promise.all([this.reloadBatches(), this.reloadInboxes()]);
  }

  async fileUnassigned(b: AdminCohortOut): Promise<void> {
    const department = this.selectedDepartmentId();
    if (!department) return;
    const res = await this.patch<AdminCohortOut>(`/admin/cohorts/${b.id}`, {
      department_id: department,
    });
    if (!res) return;
    this.flash.set(`Filed ${res.code} under ${this.selectedDepartment()?.code ?? 'department'}`);
    await Promise.all([this.reloadBatches(), this.reloadInboxes()]);
  }

  // =========================================================================
  // seating
  // =========================================================================

  async openSeating(b: AdminCohortOut): Promise<void> {
    this.seatingBatch.set(b);
    this.seatPick.set(null);
    await this.reloadSeating();
  }

  closeSeating(): void {
    this.seatingBatch.set(null);
    this.seated.set([]);
    this.unseated.set([]);
    this.seatPick.set(null);
  }

  private async reloadSeating(): Promise<void> {
    const b = this.seatingBatch();
    if (!b) return;
    try {
      const [inBatch, pool] = await Promise.all([
        this.get<AdminStudentRowOut[]>(`/admin/cohorts/${b.id}/students`),
        this.get<AdminStudentRowOut[]>('/admin/students/unseated'),
      ]);
      this.seated.set(inBatch);
      this.unseated.set(pool);
    } catch {
      this.error.set('Could not load the students for this batch.');
    }
  }

  /** PUT /admin/students/{id}/cohort with the open batch. */
  async seat(): Promise<void> {
    const b = this.seatingBatch();
    const sid = this.seatPick();
    if (!b || !sid) return;
    const who = this.unseated().find((s) => s.student_id === sid);
    const ok = await this.put<unknown>(`/admin/students/${sid}/cohort`, { cohort_id: b.id });
    if (ok === null) return;
    this.seatPick.set(null);
    this.flash.set(`${who?.name ?? 'Student'} seated in ${b.code}.`);
    await Promise.all([this.reloadSeating(), this.reloadBatches()]);
  }

  /** The same PUT with null — an explicit un-seat, never "absent means keep". */
  async release(s: AdminStudentRowOut): Promise<void> {
    const b = this.seatingBatch();
    if (!b) return;
    const ok = await this.put<unknown>(`/admin/students/${s.student_id}/cohort`, { cohort_id: null });
    if (ok === null) return;
    this.flash.set(`${s.name} released from ${b.code}.`);
    await Promise.all([this.reloadSeating(), this.reloadBatches()]);
  }

  stageLabel(stage: string | null): string {
    return stage ? stage.replace('_', '-').toLowerCase().replace(/(^|-)\w/g, (c) => c.toUpperCase()) : '—';
  }

  private async reloadBatches(): Promise<void> {
    const department = this.selectedDepartmentId();
    if (!department) return;
    this.batches.set(await this.get<AdminCohortOut[]>(`/admin/departments/${department}/cohorts`));
  }

  private async reloadInboxes(): Promise<void> {
    const [incomplete, unassigned] = await Promise.all([
      this.get<AdminCohortOut[]>('/admin/cohorts/incomplete'),
      this.get<AdminCohortOut[]>('/admin/cohorts/unassigned'),
    ]);
    this.incomplete.set(incomplete);
    this.unassigned.set(unassigned);
  }

  // =========================================================================
  // display helpers
  // =========================================================================

  /** "MBA · FIN", or "—" for a batch attached at department level. */
  levelsOf(b: AdminCohortOut): string {
    const course = this.courses().find((c) => c.id === b.course_id)?.code;
    const spec = this.specializations().find((s) => s.id === b.specialization_id)?.code;
    const parts = [course, spec].filter((p): p is string => !!p);
    return parts.length ? parts.join(' · ') : '—';
  }

  readonly requiredLabels = computed(() =>
    this.levels()
      .filter((lv) => lv.required)
      .map((lv) => lv.label),
  );

  // =========================================================================
  // http
  // =========================================================================

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  private post<T>(path: string, body: unknown, toBatchError = false): Promise<T | null> {
    return this.write<T>('POST', path, body, toBatchError);
  }

  private patch<T>(path: string, body: unknown, toBatchError = false): Promise<T | null> {
    return this.write<T>('PATCH', path, body, toBatchError);
  }

  private put<T>(path: string, body: unknown): Promise<T | null> {
    return this.write<T>('PUT', path, body, false);
  }

  /** Writes surface their 4xx detail as text — the API's messages are written
   *  for the person reading them, so they are shown verbatim. */
  private async write<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
    toBatchError: boolean,
  ): Promise<T | null> {
    this.busy.set(true);
    this.flash.set(null);
    if (!toBatchError) this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}${path}`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await this.detailOf(res);
        if (toBatchError) this.batchError.set(detail);
        else this.error.set(detail);
        // A 422 naming a required level means the switch moved under us; the
        // next form build reads the fresh answer.
        if (res.status === 422 && /required/i.test(detail)) {
          this.levels.set(await this.schema.load(true));
        }
        return null;
      }
      // 204 has no body (the seating PUT). Returning {} rather than null keeps
      // "null means the write was refused" true for every caller.
      if (res.status === 204) return {} as T;
      return (await res.json()) as T;
    } catch {
      const msg = 'Could not reach the server.';
      if (toBatchError) this.batchError.set(msg);
      else this.error.set(msg);
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  private async detailOf(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (typeof j.detail === 'string') return j.detail;
      if (Array.isArray(j.detail)) {
        // pydantic's shape: [{msg, loc}] — the msg is what the validator wrote.
        return j.detail
          .map((d: { msg?: string }) => d.msg ?? '')
          .filter(Boolean)
          .join(' ')
          .replace(/^Value error, /, '');
      }
    } catch {
      /* fall through */
    }
    return `Request failed (${res.status}).`;
  }
}
