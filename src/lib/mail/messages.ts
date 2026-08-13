/**
 * The words the programme sends to an applicant.
 *
 * Composing a message and delivering one are separate jobs, and this file only
 * does the first. It reads no environment, opens no connection and touches no
 * database, so the exact text an applicant receives — including the link they
 * are asked to click and the deadline quoted beside it — can be asserted in a
 * test rather than read out of a terminal after a manual signup.
 *
 * Two things these messages will not do:
 *
 *  - **Quote back anything a CV supplied.** An uploaded document is
 *    attacker-controlled text, and a name lifted out of one is the last thing
 *    that should be pasted into an email header. Only the address the applicant
 *    typed and the values a reviewer has looked at reach a subject line.
 *  - **Say more than the recipient is entitled to know.** The confirmation mail
 *    does not reveal whether the address matched an auto-approval rule, because
 *    at that point the address is unproven and the answer would tell anyone who
 *    can guess an address which domains are on the list.
 */

import type { MailMessage } from './transport';

/// Signed off the same way on every message, so a student can tell a real one
/// from a phish by the fact that it names the programme and asks for nothing.
const SIGNATURE = [
  '',
  '— BGSCET MBA · Reboot, Excel, Elevate Programme',
  'This mailbox is not monitored. Reply to the programme office if you need help.',
].join('\n');

function compose(to: string, subject: string, body: readonly string[]): MailMessage {
  return { to, subject, text: [...body, SIGNATURE].join('\n') };
}

/**
 * "Confirm your address", the one message the whole flow depends on.
 *
 * The deadline is spelled out in words as well as being enforced, because the
 * commonest support question about a link like this is "how long do I have?" and
 * the second commonest is "I clicked it twice, did I break it?" — both answered
 * here rather than in a follow-up.
 */
export function buildVerificationEmail(params: {
  to: string;
  name: string;
  link: string;
  expiresAt: Date;
}): MailMessage {
  return compose(params.to, 'Confirm your REEP registration', [
    `Hello ${firstName(params.name)},`,
    '',
    'You (or someone using this address) applied to join the Reboot, Excel, Elevate',
    'Programme at BGSCET. Confirm the address to finish the application:',
    '',
    `    ${params.link}`,
    '',
    `The link works once and stops working at ${formatDeadline(params.expiresAt)}.`,
    'If it has expired by the time you get to it, your application is not lost — the',
    'programme office picks it up and confirms the address with you directly.',
    '',
    'If you did not apply, ignore this message. Nothing is created until the link is',
    'used, and nobody can use it but you.',
  ]);
}

/**
 * "You are in", with the temporary password.
 *
 * A password in an email is a compromise and worth naming as one: `User` has a
 * required `passwordHash` and this product has no set-your-own-password flow
 * yet, so an approved applicant either gets a credential this way or gets an
 * account they cannot open. The mitigation is that it is single-use in spirit —
 * the message tells them to change it — and that in this deployment the message
 * goes to a terminal a member of staff is already looking at.
 */
export function buildWelcomeEmail(params: {
  to: string;
  name: string;
  usn: string;
  cohortName: string;
  temporaryPassword: string;
  signInUrl: string;
}): MailMessage {
  return compose(params.to, 'Your REEP account is ready', [
    `Hello ${firstName(params.name)},`,
    '',
    `Your registration has been approved and you are enrolled on ${params.cohortName}.`,
    `Your university seat number on record is ${params.usn}.`,
    '',
    'Sign in here:',
    `    ${params.signInUrl}`,
    '',
    `    Email:    ${params.to}`,
    `    Password: ${params.temporaryPassword}`,
    '',
    'That password is temporary. Change it the first time you sign in, and do not',
    'forward this message to anybody.',
  ]);
}

/**
 * "Not this time", with the reviewer's reason.
 *
 * The reason is included verbatim rather than softened into a template. A
 * rejection an applicant cannot act on generates a phone call to the programme
 * office, and the reviewer already wrote the sentence that prevents it.
 */
export function buildRejectionEmail(params: {
  to: string;
  name: string;
  reason: string;
}): MailMessage {
  return compose(params.to, 'About your REEP registration', [
    `Hello ${firstName(params.name)},`,
    '',
    'The programme office has looked at your application and has not been able to',
    'take it forward. Their note:',
    '',
    `    ${params.reason.trim()}`,
    '',
    'If you think this is a mistake — a mistyped seat number, an address that is not',
    'the one the college has on file — reply to the programme office and they will',
    'reopen it.',
  ]);
}

/**
 * "Someone applied", to the reviewers.
 *
 * Carries the applicant's name and the reason a rule sent them to review, and
 * nothing else: this goes to a shared mailbox, and a phone number does not need
 * to be in it when the queue is one click away.
 */
export function buildReviewNoticeEmail(params: {
  to: string;
  applicantName: string;
  applicantEmail: string;
  reason: string;
  queueUrl: string;
}): MailMessage {
  return compose(params.to, `Registration to review — ${params.applicantName}`, [
    `${params.applicantName} <${params.applicantEmail}> confirmed their address and needs a`,
    'human decision.',
    '',
    `    ${params.reason}`,
    '',
    'Open the queue:',
    `    ${params.queueUrl}`,
  ]);
}

/**
 * The name to open with.
 *
 * A CV-derived full name can be forty characters of block capitals, and
 * "Hello VENKATARAMAN SUBRAMANIAN NARAYANAN," reads like a bank letter. The
 * first word is nearly always right; a single-word name is used whole.
 */
export function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return first || 'there';
}

/**
 * The deadline, in the timezone the reader is in.
 *
 * `en-IN` with an explicit Asia/Kolkata zone rather than the server's locale:
 * every recipient of this message is on one campus, and a deadline rendered in
 * UTC because the process happened to start that way is a support ticket.
 */
export function formatDeadline(when: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(when);
}
