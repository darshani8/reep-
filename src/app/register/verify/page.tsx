import { headers } from 'next/headers';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { TechNote } from '@/components/kit';
import { retryAfterSeconds } from '@/lib/rate-limit';
import { confirmEmail, type ConfirmOutcome } from '@/lib/registration/intake';
import { clientKey, registrationVerifyLimiter } from '@/lib/registration/limits';

import { RegisterShell } from '../shell';

export const metadata = { title: 'Confirming your address — REEP Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * The link from the email, and everything that hangs off it.
 *
 * This is where "auto-approve if within the specified domains" finally runs, and
 * it runs *here* rather than at submission because until this request arrives the
 * domain is something the applicant typed. Clicking the link is the proof; the
 * rules in `RegistrationRule` are consulted immediately afterwards, and an
 * auto-approval creates the `User`, `Student` and `StudentProfile` in one
 * transaction before this page renders.
 *
 * **There is no error page.** Every outcome — expired, already used, unrecognised,
 * approved, sent to review, or a provisioning failure the applicant had nothing
 * to do with — is a sentence on this page. An applicant who is shown a stack
 * trace assumes their application is gone and files another one, or does not.
 * `verification.ts` decides which failures also route the application to a human;
 * this file only renders the answer.
 *
 * ## The one trade-off worth naming
 *
 * The token is consumed on GET. That is the right shape for a link in an email —
 * a confirm button would be a second click on a page the applicant did not ask
 * for — but it means a client that *prefetches* links (some corporate mail
 * gateways do) spends the token before its owner clicks. The consequence is
 * bounded rather than silent: the second click reports "already confirmed", and
 * the application is by then either approved or in the review queue, which is
 * where it was going anyway. If a gateway that does this ever appears in front of
 * real applicants, the fix is a POST behind a button on this page, and nothing in
 * `intake.ts` changes.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const now = new Date();

  const outcome = await resolve(token, now);

  return (
    <RegisterShell title={outcome.heading} width={620}>
      <Alert severity={outcome.tone === 'good' ? 'success' : outcome.tone === 'warning' ? 'warning' : 'info'}>
        {outcome.message}
      </Alert>

      <Stack direction="row" spacing={2} sx={{ mt: 4, flexWrap: 'wrap', gap: 1 }}>
        {outcome.accountCreated ? (
          <Button href="/login" variant="contained" color="secondary">
            Sign in
          </Button>
        ) : (
          <Button href="/login" variant="outlined">
            Go to sign in
          </Button>
        )}
        <Button href="/register" variant="text">
          Back to the form
        </Button>
      </Stack>

      {outcome.accountCreated ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 3, maxWidth: '60ch' }}>
          Your temporary password is in the email we just sent. In this review build there
          is no mail server, so it is printed in the terminal running the app — ask
          whoever is running it.
        </Typography>
      ) : null}

      <TechNote>
        The token is looked up by the SHA-256 of what is in the URL, against a unique
        index, and the row is marked consumed in the same transaction that stamps{' '}
        <code>Registration.emailVerifiedAt</code>. Only then does{' '}
        <code>decideRegistration()</code> read the <code>RegistrationRule</code> table:
        every populated condition on a rule must match — the email domain{' '}
        <em>and</em> the intake the USN belongs to — and the lowest-priority match wins.
        An auto-approval provisions the <code>User</code>, <code>Student</code> and{' '}
        <code>StudentProfile</code> in one transaction and promotes the quarantined CV and
        photo into <code>Upload</code> rows inside it, so a failure anywhere leaves no
        half-built student. Anything the rules cannot settle — including a rule that
        matches but names no cohort — goes to the review queue with the reason attached.
      </TechNote>
    </RegisterShell>
  );
}

async function resolve(token: string | undefined, now: Date): Promise<ConfirmOutcome> {
  if (!token || token.length < 16 || token.length > 128) {
    return {
      tone: 'info',
      heading: 'That link is incomplete',
      message:
        'The address in your browser is missing the confirmation code — mail clients sometimes break a long link over two lines. Copy the whole thing from the email, or register again and we will send a fresh one.',
      accountCreated: false,
    };
  }

  // A ceiling, though a loose one: this is a lookup against a unique index on a
  // 256-bit token, so there is nothing here to guess. See `limits.ts`.
  const verdict = registrationVerifyLimiter.check(
    clientKey(await headers(), 'reg-verify'),
    now.getTime(),
  );
  if (!verdict.allowed) {
    const minutes = Math.ceil(retryAfterSeconds(verdict, now.getTime()) / 60);
    return {
      tone: 'warning',
      heading: 'Too many attempts from this connection',
      message: `Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and open the link again. Your application is untouched.`,
      accountCreated: false,
    };
  }

  return confirmEmail(token, now);
}
