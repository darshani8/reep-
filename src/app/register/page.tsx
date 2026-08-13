import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';

import { TechNote } from '@/components/kit';
import { HOME_FOR_ROLE, getSession } from '@/lib/auth';

import { RegisterForm } from './register-form';
import { RegisterShell } from './shell';

export const metadata = { title: 'Register — REEP Dashboard' };

/**
 * The app's first page that a stranger is meant to reach.
 *
 * `force-dynamic` because it reads the session — not to guard anything, but to
 * notice the one confusing case: somebody already signed in who has followed a
 * link to the signup form. Sending them away would be wrong (a director may be
 * looking at what applicants see), so it says so and offers the way back.
 */
export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const session = await getSession();

  return (
    <RegisterShell
      title="Apply to REEP"
      subtitle="One form. Upload your CV and we will fill in what we can read out of it, or type it yourself — either way you check every answer before it is submitted."
    >
      {session ? (
        <Alert
          severity="info"
          sx={{ mb: 3 }}
          action={
            <Button size="small" href={HOME_FOR_ROLE[session.role]}>
              Go to dashboard
            </Button>
          }
        >
          You are signed in as {session.name}. This form creates a new application, not a
          second account for you.
        </Alert>
      ) : null}

      <RegisterForm />

      <TechNote>
        This is the only unauthenticated write surface in the product, so it is the only
        one with a rate limiter in front of it: ten uploads and five applications an hour
        per IP, counted in process by <code>src/lib/rate-limit.ts</code>. An uploaded CV
        or photo goes to <code>storage/registration/&lt;token&gt;/</code> under a
        generated name — never into <code>Upload</code>, which requires a{' '}
        <code>studentId</code> that does not exist yet — and is promoted only if the
        application is approved; anything left after seven days is swept. The CV is read
        by pattern matching on this machine. A model is consulted only for fields that
        leaves empty, and only where <code>studentDataEgressAllowed()</code> permits it;
        otherwise the document never leaves the server and the note above the form says
        so. Nothing is decided until the confirmation link is clicked: &ldquo;within the
        specified domains&rdquo; is a claim until the address is proven, and the rules in{' '}
        <code>RegistrationRule</code> only run after it is.
      </TechNote>
    </RegisterShell>
  );
}
