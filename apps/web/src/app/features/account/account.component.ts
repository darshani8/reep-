/**
 * My account — one screen for the login the person signed in with.
 *
 * Board: docs/redesign-2026-09/design/admin/Account.html
 * Spec:  docs/redesign-2026-09/02-admin-console-spec.md §24
 *
 * EVERY ROLE REACHES THIS, from the avatar menu, so nothing here may assume a
 * console. The panels hide themselves where they do not apply rather than
 * rendering a control that answers 403: a STUDENT and an ALUMNUS have no
 * signature (`/api/staff/signature` is `require_mentor`), so that card is not
 * drawn for them at all.
 *
 * THE PASSWORD PANEL IS DERIVED, NOT ASSUMED, and the derivation is the same
 * one the server makes. `password_door_open(db)` in app/routers/auth.py is
 * dev/CI always, `PASSWORD_LOGIN=true` always, `PASSWORD_LOGIN=false` never,
 * and otherwise open exactly when some account holds a real `scrypt:` hash —
 * and `GET /api/auth/sso/status` publishes that one bit as
 * `password_login_available`. So when the server says the door is SHUT, this
 * account holds no usable password either (no key exists anywhere, or keys are
 * forced off), and the honest screen is a sentence about Google rather than a
 * change-password form that cannot succeed. When it says OPEN the bit is about
 * the deployment and not about this row — accounts minted by `grant_access` and
 * `seed_roster` hold the SSO_ONLY sentinel — so the only per-account truth is
 * the 409 `POST /auth/change-password/code` answers, and that swaps the form
 * for the same sentence the moment it arrives. There is no endpoint that says
 * "does THIS account hold a password"; B15 adds one on `/auth/me`.
 *
 * ONE PROOF, NEVER TWO. `/auth/change-password` takes the emailed code or the
 * current password and refuses both together (`_authorised_to_change`). This
 * screen offers the CODE, like `/account/password` does: a student who set
 * their first password last week does not reliably remember it, and the code
 * proves the mailbox is readable now. The current-password path stays the
 * API's, for staff and for the tests; it is not a second form here.
 *
 * WHAT THE BOARD DRAWS THAT NO ENDPOINT ANSWERS TODAY — whether the Google
 * identity is linked and unlinking it, the email digests, the recent sign-in
 * list, and Sign out everywhere — is `B15` and `B3.6`, Phase 3. Each is a
 * disabled control through `PendingControlDirective` or an empty state beside
 * a `.notice.accent` that says what will fill it. None of it is sample data:
 * a screenshot of an invented sign-in row is indistinguishable from a real one.
 */

import { Component, computed, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import type { Role } from '../../core/session';
import { PendingControlDirective } from '../../shared/pending/pending.directive';

/** `GET /api/auth/sso/status` — which doors this SERVER offers. Unauthenticated
 *  by design and account-free: it reports the deployment, never a row. */
interface SignInDoors {
  google_available: boolean;
  password_login_available?: boolean;
  domain?: string | null;
  reason?: string | null;
}

/** `GET /api/staff/signature` — app/routers/signature.py `SignatureOut`. */
interface SignatureInfo {
  present: boolean;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: string | null;
}

/** What each role is called on screen. Mirrors `ROLE_LABEL` in
 *  layout/app-shell.component.ts — the console's vocabulary is Student /
 *  Faculty / Alumni and Main Admin, and "mentor" is a stored value. */
const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  MENTOR: 'Faculty',
  ADMIN: 'Main Admin',
  ALUMNI: 'Alumni',
};

/** The roles `require_mentor` admits, and therefore the only ones with a
 *  signature slot (app/routers/signature.py). */
const ROLES_WITH_A_SIGNATURE: Role[] = ['MENTOR', 'ADMIN'];

/** `app/set_password.py::MIN_PASSWORD_LENGTH`. The server refuses anything
 *  shorter with a sentence of its own; this only stops the round trip. */
const MIN_PASSWORD_LENGTH = 12;

/** A signature is a small image (`MAX_SIGNATURE_BYTES`, 2 MB). */
const MAX_SIGNATURE_MEGABYTES = 2;

/** Google link state and unlinking — `B15`, Phase 3. */
const GOOGLE_LINK_PHASE = 3;
/** `POST /api/auth/sign-out-everywhere` — `B3.6`, Phase 3. */
const SIGN_OUT_EVERYWHERE_PHASE = 3;
/** `notification_prefs` and the digests — `B15`, Phase 3. */
const EMAIL_DIGEST_PHASE = 3;
/** `last_sign_ins[]` from the new `login_events` table — `B15`, Phase 3. */
const RECENT_SIGN_INS_PHASE = 3;

/** The two new passwords have to agree before either is worth posting. */
function bothPasswordsMatch(group: AbstractControl): ValidationErrors | null {
  const chosen = group.get('new_password')?.value;
  const repeated = group.get('confirm')?.value;
  if (!chosen || !repeated) {
    return null;
  }
  return chosen === repeated ? null : { mismatch: true };
}

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [ReactiveFormsModule, PendingControlDirective],
  templateUrl: './account.component.html',
  styleUrl: './account.component.scss',
})
export class AccountComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly googleLinkPhase = GOOGLE_LINK_PHASE;
  readonly signOutEverywherePhase = SIGN_OUT_EVERYWHERE_PHASE;
  readonly emailDigestPhase = EMAIL_DIGEST_PHASE;
  readonly recentSignInsPhase = RECENT_SIGN_INS_PHASE;
  readonly minPasswordLength = MIN_PASSWORD_LENGTH;
  readonly maxSignatureMegabytes = MAX_SIGNATURE_MEGABYTES;

  // ---- who is signed in ---------------------------------------------------

  readonly session = this.auth.session;
  readonly displayName = computed(() => this.session()?.name ?? '');
  readonly emailAddress = computed(() => this.session()?.email ?? '');
  readonly roleLabel = computed(() => ROLE_LABEL[this.session()?.role as Role] ?? 'Student');
  readonly holdsASignatureSlot = computed(() => {
    const role = this.session()?.role;
    if (!role) {
      return false;
    }
    return ROLES_WITH_A_SIGNATURE.includes(role);
  });

  readonly signingOut = signal(false);

  // ---- which doors this server offers -------------------------------------

  readonly doors = signal<SignInDoors | null>(null);
  /** Until the probe has answered, no claim about either door is made. */
  readonly signInDoorsKnown = computed(() => this.doors() !== null);
  readonly googleDoorOpen = computed(() => this.doors()?.google_available === true);
  readonly collegeDomain = computed(() => this.doors()?.domain ?? null);

  /** The server's own sentence for why Google sign-in is not offered, or null
   *  when it is offered (or when the probe has not answered). */
  readonly googleDoorShutReason = computed(() => {
    const doors = this.doors();
    if (doors === null || doors.google_available) {
      return null;
    }
    return doors.reason ?? null;
  });

  /** The server says no account can sign in with a password here. See the
   *  class docstring: that answer also settles this account. */
  readonly passwordDoorShut = computed(() => this.doors()?.password_login_available === false);

  /** 409 from `/auth/change-password/code`: this row holds the SSO_ONLY
   *  sentinel, whatever the deployment's door does. */
  readonly accountHoldsNoPassword = signal(false);

  readonly signsInWithGoogleOnly = computed(
    () => this.accountHoldsNoPassword() || this.passwordDoorShut(),
  );

  // ---- change password: request a code, then spend it ---------------------

  readonly sendingCode = signal(false);
  readonly codeSent = signal(false);
  /** What the server said when it mailed the code — it names the address and
   *  how long the code lives, so neither is guessed here. */
  readonly codeNote = signal<string | null>(null);
  readonly savingPassword = signal(false);
  readonly passwordError = signal<string | null>(null);
  readonly passwordFlash = signal<string | null>(null);

  readonly passwordForm = new FormGroup(
    {
      code: new FormControl('', {
        nonNullable: true,
        validators: [Validators.required, Validators.pattern(/^\d{6}$/)],
      }),
      new_password: new FormControl('', {
        nonNullable: true,
        validators: [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)],
      }),
      confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    },
    { validators: [bothPasswordsMatch] },
  );

  // ---- signature ----------------------------------------------------------

  readonly signature = signal<SignatureInfo | null>(null);
  readonly signatureBusy = signal(false);
  readonly signatureError = signal<string | null>(null);
  readonly signatureFlash = signal<string | null>(null);
  readonly confirmSignatureRemoval = signal(false);

  /** The read failed. A FAILED READ IS NOT AN EMPTY SLOT: rendering "No
   *  signature on file" because the GET 500'd tells a mentor who has one that
   *  they have none, and the next thing they do is upload over it. The card
   *  says what happened and offers the read again. */
  readonly signatureLoadFailed = signal(false);

  /** Null until `GET /staff/signature` has answered — the loading state. */
  readonly signatureStillLoading = computed(() => this.signature() === null);

  /** The row when there IS one on file, so the template reads its fields
   *  without a chain of optional access. */
  readonly signatureOnFile = computed(() => {
    const info = this.signature();
    if (info === null || !info.present) {
      return null;
    }
    return info;
  });

  /** The preview, cache-busted by the upload time so a replacement shows at
   *  once rather than after a hard refresh. */
  readonly signatureImageUrl = computed(() => {
    const info = this.signatureOnFile();
    if (info === null) {
      return null;
    }
    const version = encodeURIComponent(info.uploaded_at ?? '');
    return `${environment.apiBase}/staff/signature/image?v=${version}`;
  });

  constructor() {
    void this.loadSignInDoors();
    if (this.holdsASignatureSlot()) {
      void this.loadSignature();
    }
  }

  // ---- loads --------------------------------------------------------------

  /** Ask which sign-in doors exist. It fails CLOSED for the password form and
   *  OPEN for Google, the same way the login screen's probe does: a probe that
   *  cannot answer must never become the reason a form is hidden AND must never
   *  promise a door the server does not have. */
  private async loadSignInDoors(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/auth/sso/status`, {
        credentials: 'include',
      });
      if (!response.ok) {
        return;
      }
      this.doors.set((await response.json()) as SignInDoors);
    } catch {
      // Leave `doors` null: the password panel then shows the form, which is
      // the state that lets somebody finish what they came to do.
    }
  }

  async loadSignature(): Promise<void> {
    this.signatureError.set(null);
    this.signatureLoadFailed.set(false);
    try {
      const response = await fetch(`${environment.apiBase}/staff/signature`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(await this.detailOf(response));
      }
      this.signature.set((await response.json()) as SignatureInfo);
    } catch (err) {
      this.signature.set(null);
      this.signatureLoadFailed.set(true);
      this.signatureError.set(this.messageFrom(err, 'Could not load your signature.'));
    }
  }

  // ---- change password ----------------------------------------------------

  /** Ask for the code. Re-asking supersedes the previous one server-side, so
   *  there is never more than one live code in the mailbox. */
  async sendCode(): Promise<void> {
    if (this.sendingCode()) {
      return;
    }
    this.sendingCode.set(true);
    this.passwordError.set(null);
    this.passwordFlash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/auth/change-password/code`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.status === 409) {
        this.accountHoldsNoPassword.set(true);
        return;
      }
      if (!response.ok) {
        this.passwordError.set(await this.detailOf(response));
        return;
      }
      const body = (await response.json()) as { message?: string };
      this.codeNote.set(body.message ?? null);
      this.codeSent.set(true);
      this.passwordForm.controls.code.reset('');
    } catch {
      this.passwordError.set('Could not reach the server. Try again in a moment.');
    } finally {
      this.sendingCode.set(false);
    }
  }

  /** Spend the code and set the new password. Other devices go; this one stays,
   *  because the API re-issues this cookie at the new token_version before it
   *  answers and `refresh()` reads it back. */
  async changePassword(): Promise<void> {
    if (this.passwordForm.invalid || this.savingPassword()) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    this.savingPassword.set(true);
    this.passwordError.set(null);
    this.passwordFlash.set(null);
    const { code, new_password } = this.passwordForm.getRawValue();
    try {
      const response = await fetch(`${environment.apiBase}/auth/change-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, new_password }),
      });
      if (response.status === 409) {
        this.accountHoldsNoPassword.set(true);
        return;
      }
      if (!response.ok) {
        await this.reportRefusedChange(response);
        return;
      }
      await this.auth.refresh();
      this.resetPasswordForm();
      this.passwordFlash.set(
        'Password changed. Your other devices have been signed out; this one stays.',
      );
    } catch {
      this.passwordError.set('Could not reach the server. Try again in a moment.');
    } finally {
      this.savingPassword.set(false);
    }
  }

  /** A REFUSED CODE IS NOT SPENT. `consume_user_code` compares first and only
   *  then runs the single-use UPDATE, so a wrong or expired code leaves the
   *  live one untouched (`app/account_links.py`) — and a 422 is refused BEFORE
   *  the proof is consumed at all (`change_password` checks
   *  `password_problem` first, on purpose). So the person stays on step two
   *  with the code they were emailed still good: the field is cleared, because
   *  the digits in it are the ones that were just refused, and "Send a new
   *  code" is beside it for the case where the code really has expired.
   *  Dropping back to step one here forced a re-issue after every typo. */
  private async reportRefusedChange(response: Response): Promise<void> {
    this.passwordError.set(await this.detailOf(response));
    this.passwordForm.patchValue({ code: '' });
    this.passwordForm.controls.code.markAsUntouched();
  }

  cancelPasswordChange(): void {
    this.resetPasswordForm();
    this.passwordError.set(null);
  }

  private resetPasswordForm(): void {
    this.passwordForm.reset();
    this.codeSent.set(false);
    this.codeNote.set(null);
  }

  // ---- signature ----------------------------------------------------------

  async uploadSignature(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const chosenFile = input.files?.[0];
    input.value = '';
    if (!chosenFile || this.signatureBusy()) {
      return;
    }
    this.signatureBusy.set(true);
    this.signatureError.set(null);
    this.signatureFlash.set(null);
    try {
      const form = new FormData();
      form.append('file', chosenFile, chosenFile.name);
      const response = await fetch(`${environment.apiBase}/staff/signature`, {
        method: 'PUT',
        credentials: 'include',
        body: form,
      });
      if (!response.ok) {
        throw new Error(await this.detailOf(response));
      }
      this.signature.set((await response.json()) as SignatureInfo);
      this.signatureFlash.set('Signature saved. It appears on your leave papers from now on.');
    } catch (err) {
      this.signatureError.set(this.messageFrom(err, 'Could not upload the signature.'));
    } finally {
      this.signatureBusy.set(false);
    }
  }

  async removeSignature(): Promise<void> {
    if (this.signatureBusy()) {
      return;
    }
    this.signatureBusy.set(true);
    this.signatureError.set(null);
    this.signatureFlash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/staff/signature`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(await this.detailOf(response));
      }
      this.confirmSignatureRemoval.set(false);
      this.signatureFlash.set(
        'Signature removed. Your leave papers show your name and the time only.',
      );
      await this.loadSignature();
    } catch (err) {
      this.signatureError.set(this.messageFrom(err, 'Could not remove the signature.'));
    } finally {
      this.signatureBusy.set(false);
    }
  }

  // ---- this device --------------------------------------------------------

  /** Sign out HERE. One device at a time means there is never another live
   *  session to end as well; ending them all is `B3.6`. */
  async signOut(): Promise<void> {
    if (this.signingOut()) {
      return;
    }
    this.signingOut.set(true);
    try {
      await this.auth.logout();
      await this.router.navigate(['/login']);
    } finally {
      this.signingOut.set(false);
    }
  }

  // ---- formatting ---------------------------------------------------------

  uploadedOn(iso: string | null): string {
    if (!iso) {
      return '';
    }
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  fileSize(bytes: number | null): string {
    if (!bytes) {
      return '';
    }
    const oneMegabyte = 1024 * 1024;
    if (bytes >= oneMegabyte) {
      return `${(bytes / oneMegabyte).toFixed(1)} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  fileKind(mimeType: string | null): string {
    return mimeType === 'image/png' ? 'PNG' : 'JPEG';
  }

  // ---- errors -------------------------------------------------------------

  /** The server's own sentence where there is one — its refusals name the
   *  numbers. FastAPI answers a schema error with `detail` as a LIST, which
   *  rendered raw says "[object Object]". */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      const detail = body.detail;
      if (typeof detail === 'string') {
        return detail;
      }
      if (Array.isArray(detail) && detail.length > 0) {
        const first = detail[0] as { msg?: unknown };
        if (typeof first.msg === 'string') {
          return first.msg;
        }
      }
    } catch {
      /* not JSON; fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }

  private messageFrom(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
  }
}
