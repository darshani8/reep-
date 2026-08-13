import { describe, expect, it } from 'vitest';

import {
  buildRejectionEmail,
  buildVerificationEmail,
  buildWelcomeEmail,
  firstName,
  formatDeadline,
} from './messages';
import { collectingTransport, formatForConsole } from './transport';

const EXPIRES = new Date('2026-08-12T09:00:00.000Z');

describe('buildVerificationEmail', () => {
  const message = buildVerificationEmail({
    to: 'sahana.bhat@bgscet.ac.in',
    name: 'Sahana Bhat',
    link: 'http://localhost:3100/register/verify?token=abc',
    expiresAt: EXPIRES,
  });

  it('carries the link the whole flow depends on', () => {
    expect(message.text).toContain('http://localhost:3100/register/verify?token=abc');
  });

  it('quotes the deadline in the reader’s timezone, not the server’s', () => {
    // 09:00 UTC is 14:30 in Asia/Kolkata. A deadline rendered in whatever zone
    // the process happened to start in is a support ticket.
    expect(message.text).toContain('2:30 pm');
  });

  it('answers the two questions this message always provokes', () => {
    expect(message.text).toMatch(/works once/i);
    expect(message.text).toMatch(/if you did not apply/i);
  });

  it('does not reveal whether the address matched an auto-approval rule', () => {
    expect(message.text).not.toMatch(/approv/i);
  });
});

describe('buildWelcomeEmail', () => {
  const message = buildWelcomeEmail({
    to: 'sahana.bhat@bgscet.ac.in',
    name: 'Sahana Bhat',
    usn: '1BG24MBA113',
    cohortName: 'MBA Batch 2025-27 — Section B',
    temporaryPassword: 'abcd-efgh-ijkl',
    signInUrl: 'http://localhost:3100/login',
  });

  it('states the credential and that it is temporary', () => {
    expect(message.text).toContain('abcd-efgh-ijkl');
    expect(message.text).toMatch(/temporary/i);
    expect(message.text).toMatch(/change it/i);
  });

  it('names the cohort and the seat number the student will be known by', () => {
    expect(message.text).toContain('1BG24MBA113');
    expect(message.text).toContain('MBA Batch 2025-27 — Section B');
  });
});

describe('buildRejectionEmail', () => {
  it('passes the reviewer’s reason through word for word', () => {
    const message = buildRejectionEmail({
      to: 'imran.shaikh@gmail.com',
      name: 'Imran Shaikh',
      reason: '  That seat number is not on the 2026 admission list.  ',
    });

    expect(message.text).toContain('That seat number is not on the 2026 admission list.');
    expect(message.subject).toBe('About your REEP registration');
  });
});

describe('firstName', () => {
  it('opens with the first word, however long the full name is', () => {
    expect(firstName('VENKATARAMAN SUBRAMANIAN NARAYANAN')).toBe('VENKATARAMAN');
    expect(firstName('Ananya')).toBe('Ananya');
  });

  it('falls back rather than addressing an empty string', () => {
    expect(firstName('   ')).toBe('there');
  });
});

describe('formatDeadline', () => {
  it('is stable regardless of where the process is running', () => {
    expect(formatDeadline(EXPIRES)).toMatch(/12 Aug 2026/);
  });
});

describe('the transport contract', () => {
  it('hands the console driver something with the link visible in it', () => {
    const printed = formatForConsole({
      to: 'a@b.c',
      subject: 'Confirm your REEP registration',
      text: 'http://localhost:3100/register/verify?token=abc',
    });

    expect(printed).toContain('To:      a@b.c');
    expect(printed).toContain('register/verify?token=abc');
    expect(printed).toMatch(/no SMTP credentials/i);
  });

  it('records rather than sends, for a test', async () => {
    const transport = collectingTransport();
    const result = await transport.send({ to: 'a@b.c', subject: 's', text: 't' });

    expect(result).toEqual({ ok: true });
    expect(transport.sent).toEqual([{ to: 'a@b.c', subject: 's', text: 't' }]);
  });
});
