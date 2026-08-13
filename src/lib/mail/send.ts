import 'server-only';

/**
 * Sending a message once, and being able to prove it was sent.
 *
 * `MailLog.dedupeKey` is unique, and this module is the reason that column
 * exists. The registration flow has three places where the same message can be
 * asked for twice — an applicant double-clicking submit, a reviewer approving
 * from a stale page, a retried Server Action — and each of them ends with a
 * student receiving a duplicate and trusting the next one less.
 *
 * The ordering below is the whole mechanism, and it is the counter-intuitive
 * way round on purpose: **the log row is claimed before the transport is
 * called.** Sending first and logging afterwards leaves a window in which two
 * requests both send and then both discover the conflict, which is precisely the
 * case the unique index was added for. Claiming first means the loser of the
 * race never calls the transport at all; the cost is that a crash between the
 * claim and the send records a message that never left, which is the safer of
 * the two lies — a missing email gets reported, a duplicate one erodes trust
 * silently.
 *
 * `server-only` because it reads the database and the deployment's base URL.
 * The message text is built in `messages.ts` and the driver lives in
 * `transport.ts`, both of which stay importable from a script.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

import { consoleTransport, type MailMessage, type MailTransport } from './transport';

/// What `sendMail` did, from the caller's point of view. None of these are
/// exceptions: a registration is submitted whether or not its confirmation mail
/// made it out, and the applicant is told which happened.
export type MailSendOutcome =
  | { status: 'SENT' }
  | { status: 'SUPPRESSED'; because: 'already-sent' }
  | { status: 'FAILED'; error: string };

/**
 * The driver in use.
 *
 * One driver today. It is behind a function rather than a constant so that the
 * day an SMTP transport is added, the choice is made in this one place from
 * configuration — and so that a caller can never accidentally hold a reference
 * to the console driver after a real one is configured.
 */
export function mailTransport(): MailTransport {
  return consoleTransport();
}

/**
 * Where this deployment thinks it is.
 *
 * Verification links have to be absolute — they are clicked out of a mail
 * client, which has no origin to resolve against — so a base URL is the one
 * piece of ambient configuration the registration flow genuinely needs. The
 * fallback matches `npm run dev`'s port so that a developer who has not set
 * anything still gets a link they can click.
 */
export function appBaseUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return 'http://localhost:3100';
}

export async function sendMail(params: {
  /// Free text, matching `MailLog.kind` — `registration-verify`,
  /// `registration-welcome`, `registration-rejected`.
  kind: string;
  /// The caller's idea of "this exact message, once". Include whatever makes it
  /// unique: an id, and a period if the message repeats on a schedule.
  dedupeKey: string;
  message: MailMessage;
  transport?: MailTransport;
}): Promise<MailSendOutcome> {
  const { kind, dedupeKey, message } = params;
  const transport = params.transport ?? mailTransport();

  let claimed: { id: string };
  try {
    claimed = await prisma.mailLog.create({
      data: {
        kind,
        recipient: message.to,
        dedupeKey,
        subject: message.subject,
        status: 'SENT',
      },
      select: { id: true },
    });
  } catch (error) {
    // P2002 is the unique index on `dedupeKey` doing its job. Any other error is
    // a real database problem and must not be reported as a duplicate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { status: 'SUPPRESSED', because: 'already-sent' };
    }
    throw error;
  }

  const result = await transport.send(message);
  if (result.ok) return { status: 'SENT' };

  // The claim stands — deleting it would let a retry send twice — but the row is
  // corrected so the log tells the truth about what happened.
  await prisma.mailLog.update({
    where: { id: claimed.id },
    data: { status: 'FAILED', error: result.error.slice(0, 500) },
  });
  return { status: 'FAILED', error: result.error };
}
