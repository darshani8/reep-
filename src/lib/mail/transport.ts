/**
 * Where an email goes when there is nowhere to send it.
 *
 * This deployment has no SMTP credentials, and inventing some would be the wrong
 * way to make the feature demonstrable — a registration flow that silently
 * fails to deliver its confirmation link is indistinguishable from one that was
 * never wired up, and the failure only shows up in front of an applicant. So the
 * mailer is an *interface* with a driver behind it, and the driver that ships
 * prints the message to the terminal. Everything upstream — the verification
 * link, the welcome note, the rejection — is written, addressed and logged
 * exactly as it will be when a real transport is dropped in; the only thing that
 * changes on the day credentials exist is which object is passed to `sendMail`.
 *
 * That is also why the console driver prints the *whole* body rather than a
 * "sent" line: whoever is running `npm run dev` is the mailbox, and they need
 * the confirmation link to click.
 *
 * No `server-only` here. This is an interface, a formatter and a `console.log` —
 * nothing that reads a secret or touches the database, so a script or a worker
 * can build and send a message without dragging a Next bundle in behind it. The
 * part that *does* touch the database (dedupe, `MailLog`) lives in `send.ts`.
 */

/// A message, already composed. The builders in `messages.ts` produce these.
export type MailMessage = {
  to: string;
  subject: string;
  /**
   * Plain text, and only plain text.
   *
   * Every message this product sends is a sentence and a link. HTML mail would
   * mean a second body to keep in step, a rendering surface for anything that
   * reaches it from a CV, and a spam-filter argument — for no gain a student
   * would notice on a phone.
   */
  text: string;
};

/// What happened, from the driver's point of view. Mapped straight onto
/// `MailStatus` by `send.ts`.
export type MailDeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * The whole contract a driver has to meet.
 *
 * One method, and it returns a result rather than throwing, because a failure to
 * send is an ordinary outcome that has to be recorded in `MailLog` rather than a
 * crash that takes the surrounding request with it. An applicant whose
 * confirmation mail bounced must still see their application submitted.
 */
export type MailTransport = {
  /// A name for the log line, e.g. `console`.
  readonly name: string;
  send(message: MailMessage): Promise<MailDeliveryResult>;
};

/**
 * The driver that ships: print it.
 *
 * The banner is loud on purpose. This is competing for attention with Next's own
 * request logging, and a confirmation link nobody notices in the scrollback is a
 * confirmation link nobody clicks.
 */
export function consoleTransport(write: (line: string) => void = console.info): MailTransport {
  return {
    name: 'console',
    async send(message: MailMessage): Promise<MailDeliveryResult> {
      write(formatForConsole(message));
      return { ok: true };
    },
  };
}

/// Split out so the formatting can be asserted on without capturing `console`.
export function formatForConsole(message: MailMessage): string {
  const rule = '─'.repeat(72);
  return [
    '',
    rule,
    '  MAIL (console driver — no SMTP credentials are configured)',
    `  To:      ${message.to}`,
    `  Subject: ${message.subject}`,
    rule,
    message.text,
    rule,
    '',
  ].join('\n');
}

/**
 * A driver that records instead of sending, for tests.
 *
 * Kept beside the real one rather than in a test helper so that the two cannot
 * drift: if the interface grows a method, this stops compiling in the same
 * commit as the driver above.
 */
export function collectingTransport(): MailTransport & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    name: 'collecting',
    sent,
    async send(message: MailMessage): Promise<MailDeliveryResult> {
      sent.push(message);
      return { ok: true };
    },
  };
}
