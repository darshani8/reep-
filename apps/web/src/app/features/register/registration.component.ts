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
 * email or LinkedIn) AND, since 2026-09-22, for the two files: the submission
 * is ONE multipart request carrying every field and both files, and the API
 * refuses it without them. It used to be a JSON POST and two uploads after
 * the 201, and every way those two could fail — an edge refusing the body, a
 * phone losing its connection, the applicant closing the tab at "Try
 * attaching again", and by design for every application a rule auto-approved
 * at submit time — left an application in the office's queue with no CV and
 * no photo from a student who had filled in every box. The form still checks
 * each file's type and size before it posts, so the refusal is met once,
 * here, before the upload; a refusal from the server leaves no application
 * behind, so the same form is simply submitted again.
 * Course and Batch are required whenever the office has listed any under the
 * chosen department: a box that cannot be filled cannot be compulsory, and a
 * half-set-up college must not refuse every applicant.
 *
 * SPECIALIZATION IS A CHECKLIST (2026-09-22). Some students opt for a DUAL
 * specialization, and the <select> this box used to be let them name one of
 * their two, so the office learned of the other by phone or not at all. The
 * box is a list of tick boxes now, capped at the server's
 * `max_specializations` (two), and the API takes `specialization_ids` — the
 * ticks in order — writing the first into `specialization_id` and the other
 * into `second_specialization_id`. Both must sit under the chosen course; a
 * batch under one of them still fits, and a batch under a specialization
 * that is then unticked is cleared. The decisions are in
 * `core/specializations.ts`, with a spec.
 */

import { Component, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';
import { MAX_SPECIALIZATIONS_FALLBACK, specializationLabel, togglePick } from '../../core/specializations';

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
interface Hierarchy {
  levels: HierLevel[];
  colleges: HierCollege[];
  /// How many specializations may be ticked — the API's cap, served so the
  /// form refuses at the same number. Absent from a hierarchy that failed to
  /// load, where there is nothing to tick anyway.
  max_specializations?: number;
}

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
  /// The other tick of a dual specialization; null when one or none was ticked.
  second_specialization_id: string | null;
  requested_cohort_id: string | null;
  college_name: string | null;
  department_name: string | null;
  course_name: string | null;
  specialization_name: string | null;
  second_specialization_name: string | null;
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

  /// Files staged on the form, sent WITH the application in the one multipart
  /// request the submit handler builds. (The handler is not named as a call
  /// in this comment on purpose: `check_form_submit.py` reads its body from
  /// the first mention of the method name followed by a parenthesis, and one
  /// in a comment above the method would hand the guard the wrong braces.)
  readonly cvFile = signal<File | null>(null);
  readonly photoFile = signal<File | null>(null);
  /// Why the last picked file was refused, per picker; cleared on a good pick.
  readonly cvError = signal<string | null>(null);
  readonly photoError = signal<string | null>(null);
  readonly maxUploadMb = MAX_UPLOAD_MB;

  // -- where the applicant belongs: cascading pickers over the admin's hierarchy --
  readonly hier = signal<Hierarchy | null>(null);
  readonly collegeId = signal('');
  readonly departmentId = signal('');
  readonly courseId = signal('');
  /// The ticked specializations, in the order ticked — one, or two for a dual
  /// specialization. Sent as `specialization_ids`.
  readonly specializationIds = signal<string[]>([]);
  readonly batchId = signal('');

  readonly college = computed(() => (this.hier()?.colleges ?? []).find((c) => c.id === this.collegeId()) ?? null);
  readonly departments = computed(() => this.college()?.departments ?? []);
  readonly department = computed(() => this.departments().find((d) => d.id === this.departmentId()) ?? null);
  readonly courses = computed(() => this.department()?.courses ?? []);
  readonly course = computed(() => this.courses().find((c) => c.id === this.courseId()) ?? null);
  readonly specializations = computed(() => this.course()?.specializations ?? []);
  readonly maxSpecializations = computed(() => this.hier()?.max_specializations ?? MAX_SPECIALIZATIONS_FALLBACK);
  /// True once the cap is reached: the unticked boxes are drawn disabled.
  readonly picksFull = computed(() => this.specializationIds().length >= this.maxSpecializations());
  /// Batches of the chosen department, narrowed by course/specialization when
  /// chosen (a batch with no course sits under the whole department), current
  /// ones first. A batch under EITHER ticked specialization fits. Ended
  /// batches stay listed but marked - a late applicant is a Main Admin's
  /// call, not the form's.
  readonly batches = computed(() => {
    const d = this.department();
    if (!d) return [];
    let list = d.batches;
    if (this.courseId()) list = list.filter((b) => !b.course_id || b.course_id === this.courseId());
    const picks = this.specializationIds();
    if (picks.length) list = list.filter((b) => !b.specialization_id || picks.includes(b.specialization_id));
    return [...list].sort((a, z) => Number(z.current) - Number(a.current));
  });
  readonly required = computed(() => new Set((this.hier()?.levels ?? []).filter((l) => l.required).map((l) => l.key)));
  readonly hierarchyOk = computed(() => {
    const req = this.required();
    return (
      (!req.has('college') || !!this.collegeId()) &&
      (!req.has('department') || !!this.departmentId()) &&
      (!req.has('course') || !!this.courseId()) &&
      (!req.has('specialization') || this.specializationIds().length > 0)
    );
  });

  constructor() {
    void this.loadHierarchy();
  }

  setCollege(id: string): void {
    this.collegeId.set(id);
    this.departmentId.set('');
    this.courseId.set('');
    this.specializationIds.set([]);
    this.batchId.set('');
  }

  setDepartment(id: string): void {
    this.departmentId.set(id);
    this.courseId.set('');
    this.specializationIds.set([]);
    this.batchId.set('');
  }

  setCourse(id: string): void {
    this.courseId.set(id);
    this.specializationIds.set([]);
    this.batchId.set('');
  }

  isPicked(id: string): boolean {
    return this.specializationIds().includes(id);
  }

  /// One tick on the checklist. The <select> this replaces cleared the batch
  /// on EVERY change; with a checklist that would throw a chosen batch away
  /// for ticking the second box, so the batch is cleared only when it no
  /// longer fits — it hangs on a specialization that was just unticked.
  toggleSpecialization(id: string, checked: boolean): void {
    this.specializationIds.set(togglePick(this.specializationIds(), id, checked, this.maxSpecializations()));
    if (this.batchId() && !this.batches().some((b) => b.id === this.batchId())) this.batchId.set('');
  }

  /// A batch pins what it knows: its course and specialization fill the
  /// pickers above if they were left blank, and its degree level sets the
  /// degree field - the API derives the same ancestors, so the two agree.
  setBatch(id: string): void {
    this.batchId.set(id);
    const b = this.batches().find((x) => x.id === id);
    if (!b) return;
    if (b.course_id && !this.courseId()) this.courseId.set(b.course_id);
    if (b.specialization_id && !this.isPicked(b.specialization_id)) {
      this.specializationIds.set(
        togglePick(this.specializationIds(), b.specialization_id, true, this.maxSpecializations()),
      );
    }
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
    if (this.required().has('specialization') && !this.specializationIds().length) out.push('your specialization');
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

  /// "Finance and Marketing" on the result card's chain line, or one name, or
  /// null — the same sentence the reviewer's panel prints.
  readonly resultSpecialization = computed(() => {
    const r = this.result();
    return r ? specializationLabel(r.specialization_name, r.second_specialization_name) : null;
  });

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

    // `missing()` above has just refused a form without either file.
    const cv = this.cvFile();
    const photo = this.photoFile();
    if (!cv || !photo) return;

    this.pending.set(true);
    try {
      // ONE MULTIPART REQUEST: the fields and both files together, so the
      // application cannot be created without them. No Content-Type header —
      // the browser writes the multipart boundary itself.
      const fd = new FormData();
      const fields: Record<string, string> = {
        name: this.fullName.trim(),
        email: this.collegeEmail.trim(),
        usn: this.usn.trim(),
        phone: this.phone.trim(),
        personal_email: this.personalEmail.trim(),
        linkedin_url: this.linkedin.trim(),
        degree_level: this.degreeLevel,
      };
      for (const [key, value] of Object.entries(fields)) fd.append(key, value);
      // The claim: only the pickers that were used. An empty part would be
      // read as an id, and a picker left on "Choose …" names nothing.
      const claim: ReadonlyArray<readonly [string, string]> = [
        ['college_id', this.collegeId()],
        ['department_id', this.departmentId()],
        ['course_id', this.courseId()],
        ['requested_cohort_id', this.batchId()],
      ];
      for (const [key, value] of claim) if (value) fd.append(key, value);
      for (const id of this.specializationIds()) fd.append('specialization_ids', id);
      fd.append('cv', cv, cv.name);
      fd.append('photo', photo, photo.name);

      const res = await fetch(`${environment.apiBase}/register`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      if (!res.ok) {
        this.error.set(await this.detailOf(res));
        return;
      }
      this.result.set((await res.json()) as RegistrationResult);
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
    if (res.status === 422) return 'Please check the form — some details are not valid (422).';
    // The status stays in the sentence: a body with no `detail` is the shape
    // an edge refusal has, and "(403)" points at the edge where a sentence
    // about the form points at the applicant.
    return `Something went wrong submitting your registration (${res.status}). Please try again.`;
  }

  /// Start over after a hold so a mistyped email can be corrected in place.
  reset(): void {
    this.result.set(null);
    this.cvFile.set(null);
    this.photoFile.set(null);
    this.cvError.set(null);
    this.photoError.set(null);
    this.setCollege('');
    this.error.set(null);
  }
}
