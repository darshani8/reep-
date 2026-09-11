/**
 * Programme sign-up — the pre-login registration frame (the mockup's `.reg-frame`
 * block, not a shell `.panel`). Public: the applicant is not a user yet, so this
 * renders on its own route (`/register`) with no auth guard and no app shell.
 *
 * The form POSTs to the FastAPI `POST /register` (apps/api-py/app/routers/
 * registration.py). That endpoint runs the data-driven rule engine and answers
 * with a `status`: AUTO_APPROVED (a rule waved it through) or PENDING_REVIEW
 * (held for review, or no rule matched). We surface that verdict through the
 * global `.reg-approval` ok / flag banner and, on success, offer a link to
 * `/login`.
 *
 * Only the fields the endpoint accepts are sent (name, email, usn, phone,
 * degree_level). Personal email, LinkedIn and the CV / photo dropzones are on the
 * form for completeness but are placeholders the backend does not yet take.
 */

import { Component, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';

type DegreeLevel = 'UG' | 'PG';

/** Snake_case exactly as `RegistrationOut` returns it. */
/// The hierarchy the admin built, as the public form may see it: names and
/// codes only (see GET /api/register/hierarchy).
interface HierSpec { id: string; code: string; name: string }
interface HierCourse { id: string; code: string; name: string; specializations: HierSpec[] }
interface HierBatch {
  id: string; code: string; name: string; batch_label: string;
  department_id: string | null; course_id: string | null; specialization_id: string | null;
  degree_level: string; current: boolean;
}
interface HierDept { id: string; code: string; name: string; courses: HierCourse[]; batches: HierBatch[] }
interface HierCollege { id: string; code: string; name: string; departments: HierDept[] }
interface HierLevel { key: string; label: string; required: boolean }
interface Hierarchy { levels: HierLevel[]; colleges: HierCollege[] }

/// The applicant's own view of their application — the server's
/// `PublicRegistrationOut`, not the Main Admin queue's `RegistrationOut`. The
/// reviewer's stamp and remarks (`review_note`, `reviewed_by_id`,
/// `reviewed_at`) and the internal ids (`cohort_id`, `matched_rule_id`,
/// `approved_student_id`) are NOT sent to this screen: nobody here is signed
/// in, and the application id is the only thing standing in for an account.
interface RegistrationResult {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  degree_level: string;
  status: string; // AUTO_APPROVED | PENDING_REVIEW | APPROVED | REJECTED
  /// The rule engine's verdict, written FOR the applicant — the result card
  /// renders it verbatim.
  decision_reason: string | null;
  /// Kinds attached so far: "CV", "PHOTO". Filled by the uploads after the 201.
  documents: string[];
  /// The applicant's claim of where they belong, ids and resolved names.
  college_id: string | null;
  department_id: string | null;
  course_id: string | null;
  specialization_id: string | null;
  requested_cohort_id: string | null;
  college_name: string | null;
  department_name: string | null;
  course_name: string | null;
  specialization_name: string | null;
  requested_batch: string | null;
  created_at: string;
}

@Component({
  selector: 'app-registration',
  standalone: true,
  imports: [FormsModule, RouterLink, DecimalPipe],
  templateUrl: './registration.component.html',
  styleUrl: './registration.component.scss',
})
export class RegistrationComponent {
  // --- form model (two-way bound; only some of these reach the API) ---
  fullName = '';
  usn = '';
  collegeEmail = '';
  personalEmail = '';
  phone = '';
  linkedin = '';
  degreeLevel: DegreeLevel = 'PG';

  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<RegistrationResult | null>(null);

  /// Files staged on the form. Uploaded AFTER the application is created — the
  /// upload endpoint is keyed on the application id, which does not exist until
  /// the 201 — so a picked file is held here until then.
  readonly cvFile = signal<File | null>(null);
  readonly photoFile = signal<File | null>(null);
  /// What happened to each attachment, shown on the result card. The
  /// application itself is already in; a failed attachment is a warning, not a
  /// reason to make the applicant start over.
  readonly docNotes = signal<string[]>([]);

  // -- where the applicant belongs: cascading pickers over the admin's hierarchy --
  readonly hier = signal<Hierarchy | null>(null);
  readonly collegeId = signal('');
  readonly departmentId = signal('');
  readonly courseId = signal('');
  readonly specializationId = signal('');
  readonly batchId = signal('');

  readonly college = computed(() => (this.hier()?.colleges ?? []).find((c) => c.id === this.collegeId()) ?? null);
  readonly departments = computed(() => this.college()?.departments ?? []);
  readonly department = computed(() => this.departments().find((d) => d.id === this.departmentId()) ?? null);
  readonly courses = computed(() => this.department()?.courses ?? []);
  readonly course = computed(() => this.courses().find((c) => c.id === this.courseId()) ?? null);
  readonly specializations = computed(() => this.course()?.specializations ?? []);
  /// Batches of the chosen department, narrowed by course/specialization when
  /// chosen (a batch with no course sits under the whole department), current
  /// ones first. Ended batches stay listed but marked - a late applicant is a
  /// Main Admin's call, not the form's.
  readonly batches = computed(() => {
    const d = this.department();
    if (!d) return [];
    let list = d.batches;
    if (this.courseId()) list = list.filter((b) => !b.course_id || b.course_id === this.courseId());
    if (this.specializationId()) list = list.filter((b) => !b.specialization_id || b.specialization_id === this.specializationId());
    return [...list].sort((a, z) => Number(z.current) - Number(a.current));
  });
  readonly required = computed(() => new Set((this.hier()?.levels ?? []).filter((l) => l.required).map((l) => l.key)));
  readonly hierarchyOk = computed(() => {
    const req = this.required();
    return (
      (!req.has('college') || !!this.collegeId()) &&
      (!req.has('department') || !!this.departmentId()) &&
      (!req.has('course') || !!this.courseId()) &&
      (!req.has('specialization') || !!this.specializationId())
    );
  });

  constructor() {
    void this.loadHierarchy();
  }

  setCollege(id: string): void {
    this.collegeId.set(id);
    this.departmentId.set('');
    this.courseId.set('');
    this.specializationId.set('');
    this.batchId.set('');
  }

  setDepartment(id: string): void {
    this.departmentId.set(id);
    this.courseId.set('');
    this.specializationId.set('');
    this.batchId.set('');
  }

  setCourse(id: string): void {
    this.courseId.set(id);
    this.specializationId.set('');
    this.batchId.set('');
  }

  setSpecialization(id: string): void {
    this.specializationId.set(id);
    this.batchId.set('');
  }

  /// A batch pins what it knows: its course and specialization fill the
  /// pickers above if they were left blank, and its degree level sets the
  /// degree field - the API derives the same ancestors, so the two agree.
  setBatch(id: string): void {
    this.batchId.set(id);
    const b = this.batches().find((x) => x.id === id);
    if (!b) return;
    if (b.course_id && !this.courseId()) this.courseId.set(b.course_id);
    if (b.specialization_id && !this.specializationId()) this.specializationId.set(b.specialization_id);
    this.degreeLevel = b.degree_level as typeof this.degreeLevel;
  }

  private async loadHierarchy(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/register/hierarchy`);
      if (!res.ok) throw new Error(String(res.status));
      this.hier.set((await res.json()) as Hierarchy);
    } catch {
      // The form still works without the pickers; the office can seat them.
      this.hier.set({ levels: [], colleges: [] });
    }
  }

  onCv(ev: Event): void {
    this.cvFile.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  onPhoto(ev: Event): void {
    this.photoFile.set((ev.target as HTMLInputElement).files?.[0] ?? null);
  }

  /// Auto-approved is the only "account is active immediately" branch; every
  /// other terminal state on submission is a human-review hold.
  readonly approved = computed(() => this.result()?.status === 'AUTO_APPROVED');

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;

    this.error.set(null);
    if (!this.fullName.trim() || !this.collegeEmail.trim()) {
      this.error.set('Your full name and college email are both required.');
      return;
    }
    if (!this.hierarchyOk()) {
      this.error.set('Choose your college and department (and any level marked required).');
      return;
    }

    this.pending.set(true);
    try {
      const res = await fetch(`${environment.apiBase}/register`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: this.fullName.trim(),
          email: this.collegeEmail.trim(),
          usn: this.usn.trim() || null,
          phone: this.phone.trim() || null,
          degree_level: this.degreeLevel,
          college_id: this.collegeId() || null,
          department_id: this.departmentId() || null,
          course_id: this.courseId() || null,
          specialization_id: this.specializationId() || null,
          requested_cohort_id: this.batchId() || null,
        }),
      });
      if (!res.ok) {
        this.error.set(await this.detailOf(res));
        return;
      }
      const created = (await res.json()) as RegistrationResult;
      // Attach what was picked, one request per file, each reporting for
      // itself. The application is already created whatever happens here.
      const notes: string[] = [];
      for (const [kind, file, label] of [
        ['cv', this.cvFile(), 'CV'],
        ['photo', this.photoFile(), 'photo'],
      ] as const) {
        if (!file) continue;
        const fd = new FormData();
        fd.append('file', file, file.name);
        const up = await fetch(`${environment.apiBase}/register/${created.id}/documents/${kind}`, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });
        if (up.ok) {
          const updated = (await up.json()) as RegistrationResult;
          created.documents = updated.documents;
          notes.push(`${label} attached.`);
        } else {
          notes.push(`${label} could not be attached: ${await this.detailOf(up)}`);
        }
      }
      this.docNotes.set(notes);
      this.result.set(created);
    } catch {
      this.error.set('Could not reach the registration service. Is the API running on :3300?');
    } finally {
      this.pending.set(false);
    }
  }

  /// FastAPI puts the human-readable message on `detail`; fall back per status.
  private async detailOf(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') return body.detail;
    } catch {
      /* no JSON body — fall through to the status-based message */
    }
    if (res.status === 409) return 'An application with this email already exists.';
    if (res.status === 422) return 'Please check the form — some details are not valid.';
    return 'Something went wrong submitting your registration. Please try again.';
  }

  /// Start over after a hold so a mistyped email can be corrected in place.
  reset(): void {
    this.result.set(null);
    this.cvFile.set(null);
    this.photoFile.set(null);
    this.docNotes.set([]);
    this.setCollege('');
    this.error.set(null);
  }
}
