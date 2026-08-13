import 'server-only';

/**
 * The two steps an applicant actually performs, and the order they happen in.
 *
 * Submitting writes a row and sends a link. Clicking the link proves the address
 * and *only then* runs the rules. That ordering is the security property of the
 * feature and it is worth restating where the code does it, because the
 * tempting shortcut is right there: the domain is knowable the instant the form
 * is submitted, and running `decideRegistration` at that point would let an
 * applicant see "approved" a second after typing. It would also mean anyone who
 * can spell `x@bgscet.ac.in` gets a STUDENT account and a look at the roster and
 * the leaderboards, without ever holding the mailbox. So the decision waits.
 *
 * Both functions are total. Neither throws for anything an applicant can cause —
 * a duplicate address, an expired link, a mail server that is not there — and a
 * failure never costs the application. A submitted registration whose
 * confirmation email failed to send is still a submitted registration, and the
 * screen says so rather than pretending it went out.
 */

import type { Prisma } from '@prisma/client';

import { appBaseUrl, sendMail } from '@/lib/mail/send';
import {
  buildVerificationEmail,
  buildWelcomeEmail,
} from '@/lib/mail/messages';
import { prisma } from '@/lib/db';

import { attachRegistration, bundleForRegistration, createBundle } from './quarantine';
import { loadRuleFacts } from './queries';
import { provisionStudent } from './provision';
import { decideRegistration } from './rules';
import type { RegistrationInput } from './schema';
import {
  checkVerification,
  hashVerificationToken,
  mintVerificationToken,
  verificationLink,
  verificationOutcome,
} from './verification';

// ---------------------------------------------------------------------------
// Step one: the form
// ---------------------------------------------------------------------------

export type SubmitOutcome =
  | {
      ok: true;
      email: string;
      /// False when the transport refused. The applicant is told, and told what
      /// happens next, rather than being left watching an inbox.
      mailSent: boolean;
    }
  | { ok: false; error: string };

export async function submitApplication(params: {
  input: RegistrationInput;
  /// The quarantine bundle holding an uploaded CV and photo, when there is one.
  /// Applicants who typed the form by hand have none, and that is a normal path.
  uploadToken: string | null;
  now: Date;
}): Promise<SubmitOutcome> {
  const { input, now } = params;

  // Two different collisions with two different answers. An existing *account*
  // means this person is already in the system and wants the sign-in page; an
  // existing *application* means they have already done this and are waiting.
  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existingUser) {
    return {
      ok: false,
      error: 'That address already has a REEP account. Sign in instead — or use the address the college has on file for you.',
    };
  }

  const existing = await prisma.registration.findUnique({
    where: { email: input.email },
    select: { status: true },
  });
  if (existing) {
    return {
      ok: false,
      error:
        existing.status === 'REJECTED'
          ? 'An earlier application from this address was not taken forward. Contact the programme office rather than applying again.'
          : 'An application from this address is already with us. Check that mailbox for the confirmation link — we cannot send a second application, only another link.',
    };
  }

  const registration = await prisma.registration.create({
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      usn: input.usn ?? null,
      degreeLevel: input.degreeLevel,
      // Not DRAFT: the applicant has finished with it, the system has not.
      // Nothing is decided here — `matchedRuleId` and `decisionReason` stay
      // empty until the address is proven.
      status: 'PENDING_VERIFICATION',
    },
    select: { id: true, name: true, email: true },
  });

  // The programme, branch, city and LinkedIn link have no column on
  // `registrations`; the quarantine manifest is their record. See the docblock
  // in `quarantine.ts`.
  //
  // A bundle is created even when nothing was uploaded, and that is not
  // incidental: without one, an applicant who typed the form by hand would have
  // their city and LinkedIn link dropped on the floor — the reviewer would see
  // four dashes and `StudentProfile.city` / `.linkedinUrl` would be null on
  // approval, for no reason but that they had no CV to attach them to.
  const token = params.uploadToken ?? (await createBundle(now)).token;
  await attachRegistration(
    token,
    registration.id,
    {
      programme: input.programme,
      branch: input.branch,
      city: input.city,
      linkedinUrl: input.linkedinUrl ?? null,
    },
    now,
  );

  const minted = mintVerificationToken(now);
  const verification = await prisma.emailVerification.create({
    data: {
      registrationId: registration.id,
      tokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
    },
    select: { id: true },
  });

  const result = await sendMail({
    kind: 'registration-verify',
    dedupeKey: `registration-verify:${verification.id}`,
    message: buildVerificationEmail({
      to: registration.email,
      name: registration.name,
      link: verificationLink(appBaseUrl(), minted.token),
      expiresAt: minted.expiresAt,
    }),
  });

  return { ok: true, email: registration.email, mailSent: result.status === 'SENT' };
}

// ---------------------------------------------------------------------------
// Step two: the link
// ---------------------------------------------------------------------------

/// What the confirmation page should say. A shape rather than a status code,
/// because every branch of this — including all three failures — is a page with
/// a sentence on it and never an error.
export type ConfirmOutcome = {
  tone: 'good' | 'info' | 'warning';
  heading: string;
  message: string;
  /// True once an account exists, so the page can offer the sign-in link.
  accountCreated: boolean;
};

export async function confirmEmail(token: string, now: Date): Promise<ConfirmOutcome> {
  const row = await prisma.emailVerification.findUnique({
    where: { tokenHash: hashVerificationToken(token) },
    select: {
      id: true,
      expiresAt: true,
      consumedAt: true,
      registrationId: true,
      registration: { select: { id: true, status: true } },
    },
  });

  const check = checkVerification(row, now);
  if (!check.ok) {
    const outcome = verificationOutcome(check.failure);

    // An expired link is not the applicant's fault and their application is not
    // lost — it goes to a human, which is what `routeToReview` means. A row that
    // has already been settled is left exactly as it is.
    if (outcome.routeToReview && row && isUndecided(row.registration.status)) {
      await prisma.registration.update({
        where: { id: row.registrationId },
        data: { status: 'PENDING_REVIEW', decisionReason: outcome.reason },
      });
    }

    return {
      tone: 'info',
      heading: 'We could not confirm that link',
      message: outcome.message,
      accountCreated: false,
    };
  }

  // Consume and stamp together: a link that has confirmed an address must be
  // spent, even if everything after this fails.
  await prisma.$transaction([
    prisma.emailVerification.update({
      where: { id: row!.id },
      data: { consumedAt: now },
    }),
    prisma.registration.update({
      where: { id: row!.registrationId },
      data: { emailVerifiedAt: now },
    }),
  ]);

  return decideAndApply(row!.registrationId, now);
}

function isUndecided(status: string): boolean {
  return status === 'DRAFT' || status === 'PENDING_VERIFICATION' || status === 'PENDING_REVIEW';
}

/**
 * Run the rules against a now-verified application and act on the answer.
 *
 * Split out so the same path can be re-run — a director who fixes a rule and
 * wants an application re-evaluated calls this rather than asking the applicant
 * for another link.
 */
export async function decideAndApply(registrationId: string, now: Date): Promise<ConfirmOutcome> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
  });
  if (!registration) {
    return {
      tone: 'info',
      heading: 'We could not find that application',
      message:
        'The link was valid but the application it belongs to is no longer here. Register again and we will send a fresh link.',
      accountCreated: false,
    };
  }

  const bundle = await bundleForRegistration(registration.id);
  const rules = await loadRuleFacts();

  const decision = decideRegistration(
    {
      email: registration.email,
      emailVerified: registration.emailVerifiedAt !== null,
      usn: registration.usn,
      degreeLevel: registration.degreeLevel,
      programme: bundle?.extras?.programme ?? null,
    },
    rules,
  );

  const settle = async (data: Prisma.RegistrationUpdateInput) => {
    await prisma.registration.update({ where: { id: registration.id }, data });
  };

  if (decision.status === 'PENDING_REVIEW') {
    await settle({
      status: 'PENDING_REVIEW',
      decisionReason: decision.reason,
      matchedRule: decision.matchedRuleId ? { connect: { id: decision.matchedRuleId } } : undefined,
      cohort: decision.cohortId ? { connect: { id: decision.cohortId } } : undefined,
    });
    return underReview(decision.reason);
  }

  // Auto-approval still needs the two things a `Student` row cannot be created
  // without. A rule that matches but names no cohort, or an applicant with no
  // USN, is a rule that has said "this person is who they say they are" and not
  // "here is where they go" — so it becomes a two-second decision for a human
  // rather than a guess.
  if (!decision.cohortId || !registration.usn) {
    const reason = !decision.cohortId
      ? `${decision.reason} The rule names no cohort, so the programme office assigns one.`
      : `${decision.reason} No USN was given, so the programme office confirms it before the record is created.`;
    await settle({
      status: 'PENDING_REVIEW',
      decisionReason: reason,
      matchedRule: { connect: { id: decision.matchedRuleId! } },
      cohort: decision.cohortId ? { connect: { id: decision.cohortId } } : undefined,
    });
    return underReview(reason);
  }

  await settle({
    decisionReason: decision.reason,
    matchedRule: { connect: { id: decision.matchedRuleId! } },
    cohort: { connect: { id: decision.cohortId } },
  });

  const provisioned = await provisionStudent({
    registrationId: registration.id,
    cohortId: decision.cohortId,
    usn: registration.usn,
    // Nobody read this one. That is what AUTO_APPROVED records.
    reviewedById: null,
    status: 'AUTO_APPROVED',
    reviewNote: null,
    bundle,
    now,
  });

  if (!provisioned.ok) {
    // A rule said yes and the database said no — a USN already on the roster, a
    // cohort deleted since the rule was written. Never an error page for the
    // applicant: it becomes the reviewer's problem, with the reason attached.
    const reason = `${decision.reason} Automatic approval could not complete: ${provisioned.error}`;
    await settle({ status: 'PENDING_REVIEW', decisionReason: reason });
    return underReview(reason);
  }

  await sendMail({
    kind: 'registration-welcome',
    dedupeKey: `registration-welcome:${provisioned.studentId}`,
    message: buildWelcomeEmail({
      to: registration.email,
      name: registration.name,
      usn: provisioned.usn,
      cohortName: provisioned.cohortName,
      temporaryPassword: provisioned.temporaryPassword,
      signInUrl: `${appBaseUrl()}/login`,
    }),
  });

  return {
    tone: 'good',
    heading: 'Address confirmed — your account is ready',
    message: `You are enrolled on ${provisioned.cohortName} as ${provisioned.usn}. We have emailed you a temporary password; change it the first time you sign in.`,
    accountCreated: true,
  };
}

function underReview(reason: string): ConfirmOutcome {
  return {
    tone: 'info',
    heading: 'Address confirmed — your application is with the programme office',
    message: `${reason} Somebody will look at it and you will hear back by email. There is nothing further for you to do.`,
    accountCreated: false,
  };
}
