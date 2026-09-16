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
 * EVERY BOX IS COMPULSORY EXCEPT SPECIALIZATION (2026-09-16), the owner's rule
 * for this form, and the CV and the photo with them. The API holds the same
 * rule for the typed fields (`RegisterIn` refuses a blank USN, phone, personal
 * email or LinkedIn); the two files are posted after the 201, so the form is
 * what refuses to submit without them, and it checks each file's type and
 * size BEFORE the application is created — a 413 or 415 after the 201 would
 * leave an application in the queue with no way for the applicant to retry.
 * Course and Batch are required whenever the office has listed any under the
 * chosen department: a box that cannot be filled cannot be compulsory, and a
 * half-set-up college must not refuse every applicant.
 */

import { Component, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';

type DegreeLevel = 'UG' | 'PG';

/** The server's per-file cap (`document_store.MAX_BYTES`), stated on the form. */
export const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
/** What each upload may be — the same table `attach_document` sniffs against. */
const CV_TYPES: ReadonlySet<string> = new Set(['application/pdf']);
const PHOTO_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

/** `true` when the browser's type OR the extension says the file is allowed —
 *  some browsers report an empty `type` for a drag-and-dropped file. */
function fileIsOneOf(file: File, types: ReadonlySet<string>, extensions: readonly string[]): boolean {
  if (file.type && types.has(file.type)) return true;
  const name = file.name.toLowerCase();
  return extensions.some((ext) => name.endsWith(ext));
}

/** Snake_case exactly as `RegistrationOut` returns it. */
/// The hierarchy the admin built, as the public form may see it: names and
/// codes only (see GET /api/register/hierarchy).
interface HierSpec { id: string; code: string; name: string }
interface HierCourse { id: string; code: string; name: string; specializations: HierSpec[] }
interface HierBatch {
  // `name` is the batch itself: a YEAR. `display_label` is that with its spine
  // composed back on from the links ("General MBA - Finance · 2026-28"), which
  // is the only form an applicant can pick from — every batch a department
  // runs this year is called "2026-28".
  id: string; code: string; name: string; batch_label: string; display_label: string;
  department_id: string | null; course_id: string | null; specialization_id: string | null;
  course_name: string | null; specialization_name: string | null;
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
  /// Why the last picked file was refused, per picker; cleared on a good pick.
  readonly cvError = signal<string | null>(null);
  readonly photoError = signal<string | null>(null);
  /// The application the last submission created, kept so a failed
  /// attachment can be retried against the same id rather than the
  /// applicant meeting the duplicate guard on "Submit another".
  private createdId: string | null = null;
  readonly maxUploadMb = MAX_UPLOAD_MB;
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
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    const problem = file ? this.fileProblem(file, CV_TYPES, ['.pdf'], 'a PDF') : null;
    this.cvError.set(problem);
    this.cvFile.set(problem ? null : file);
    if (problem) input.value = '';
  }

  onPhoto(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    const problem = file ? this.fileProblem(file, PHOTO_TYPES, ['.png', '.jpg', '.jpeg'], 'a PNG or JPG') : null;
    this.photoError.set(problem);
    this.photoFile.set(problem ? null : file);
    if (problem) input.value = '';
  }

  /// The two checks the server would make after the 201, made before it.
  private fileProblem(file: File, types: ReadonlySet<string>, extensions: readonly string[], wanted: string): string | null {
    if (!fileIsOneOf(file, types, extensions)) {
      return `${file.name} is not ${wanted}. Choose ${wanted}.`;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      return `${file.name} is ${mb} MB; the limit is ${MAX_UPLOAD_MB} MB.`;
    }
    return null;
  }

  /// Everything the form still needs before it may be submitted, in the
  /// order the boxes appear. Empty means submit.
  missing(): string[] {
    const out: string[] = [];
    if (!this.cvFile()) out.push('your CV (PDF)');
    if (!this.fullName.trim()) out.push('your full name');
    if (!this.usn.trim()) out.push('your USN');
    if (!this.collegeEmail.trim()) out.push('your college email');
    if (!this.personalEmail.trim()) out.push('your personal email');
    if (!this.phone.trim()) out.push('your phone number');
    if (!this.linkedin.trim()) out.push('your LinkedIn profile');
    if (!this.collegeId()) out.push('your college');
    if (!this.departmentId()) out.push('your department');
    if (!this.courseId() && this.courses().length) out.push('your course');
    if (this.required().has('specialization') && !this.specializationId()) out.push('your specialization');
    if (!this.batchId() && this.batches().length) out.push('your batch');
    if (!this.photoFile()) out.push('your photo (PNG or JPG)');
    return out;
  }

  /// Auto-approved is the only branch a seating rule decided without a human;
  /// every other terminal state on submission is a human-review hold.
  ///
  /// IT IS NOT "ACTIVE IMMEDIATELY", and the card no longer says so (B11.4).
  /// Approval mints the account with an unusable password sentinel and emails a
  /// setup link; the applicant still has to confirm the address with a
  /// six-digit code and set a password before they can sign in.
  readonly approved = computed(() => this.result()?.status === 'AUTO_APPROVED');

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;

    this.error.set(null);
    const missing = this.missing();
    if (missing.length) {
      this.error.set(
        missing.length === 1
          ? `Please add ${missing[0]}.`
          : `Please add ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}.`,
      );
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
          usn: this.usn.trim(),
          phone: this.phone.trim(),
          personal_email: this.personalEmail.trim(),
          linkedin_url: this.linkedin.trim(),
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
      this.createdId = created.id;
      await this.attachDocuments(created);
      this.result.set(created);
    } catch {
      this.error.set('Could not reach the registration service. Is the API running on :3300?');
    } finally {
      this.pending.set(false);
    }
  }

  /// Attach both files, one request per file, each reporting for itself. The
  /// application is already created whatever happens here; a file that fails
  /// is retried from the result card against the same application, never by
  /// submitting again (which meets the duplicate guard).
  private async attachDocuments(created: RegistrationResult): Promise<void> {
    const notes: string[] = [];
    for (const [kind, file, label, stored] of [
      ['cv', this.cvFile(), 'CV', 'CV'],
      ['photo', this.photoFile(), 'photo', 'PHOTO'],
    ] as const) {
      if (!file) continue;
      if (created.documents.includes(stored)) {
        notes.push(`${label} attached.`);
        continue;
      }
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
  }

  /// True while a note on the result card says a file did not land.
  readonly attachmentsIncomplete = computed(() => this.docNotes().some((n) => n.includes('could not')));

  async retryAttachments(): Promise<void> {
    const current = this.result();
    if (!current || !this.createdId || this.pending()) return;
    this.pending.set(true);
    try {
      const copy = { ...current, documents: [...current.documents] };
      await this.attachDocuments(copy);
      this.result.set(copy);
    } catch {
      this.docNotes.set([...this.docNotes(), 'Could not reach the registration service to retry.']);
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
    // NOT "an application with this email already exists" (B11.4). That is
    // verbatim the sentence the server deleted from its own 409 on purpose: it
    // turned the most public screen in the product into a "has X applied to this
    // college" lookup for anyone holding a list of names, and applying somewhere
    // is not something an applicant chose to publish. Restoring it as a
    // client-side fallback restores the oracle — a body with no `detail` is the
    // one case where this screen speaks for the server, so it must say what the
    // server would have said.
    if (res.status === 409) {
      return (
        'This application could not be accepted. If you have already applied, ' +
        'or you think this is a mistake, contact the placement office.'
      );
    }
    if (res.status === 422) return 'Please check the form — some details are not valid.';
    return 'Something went wrong submitting your registration. Please try again.';
  }

  /// Start over after a hold so a mistyped email can be corrected in place.
  reset(): void {
    this.result.set(null);
    this.createdId = null;
    this.cvFile.set(null);
    this.photoFile.set(null);
    this.cvError.set(null);
    this.photoError.set(null);
    this.docNotes.set([]);
    this.setCollege('');
    this.error.set(null);
  }
}
