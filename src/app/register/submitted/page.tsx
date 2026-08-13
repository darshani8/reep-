import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { TechNote } from '@/components/kit';

import { RegisterShell } from '../shell';

export const metadata = { title: 'Check your email — REEP Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * "Now go and click the link."
 *
 * The address comes back in the query string because this page has no session to
 * read it from, and it is re-validated before being shown: a search parameter is
 * a string an attacker can put anything in, and this one is rendered in a
 * sentence. React escapes it, so the risk is not injection — it is that
 * `/register/submitted?to=Your%20account%20was%20deleted` becomes a page on our
 * own domain saying whatever somebody wants. Anything that is not an email
 * address is dropped and the generic wording is used instead.
 */
export default async function SubmittedPage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string; mail?: string }>;
}) {
  const { to, mail } = await searchParams;
  const address = to && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to) && to.length <= 160 ? to : null;
  const mailFailed = mail === 'failed';

  return (
    <RegisterShell
      title="Application received"
      subtitle="One step left, and it is in your inbox."
      width={620}
    >
      <Alert severity={mailFailed ? 'warning' : 'success'}>
        {mailFailed ? (
          <>
            Your application is saved, but we could not send the confirmation email
            {address ? <> to <strong>{address}</strong></> : null}. Nothing is lost —
            contact the programme office and they will confirm the address for you.
          </>
        ) : (
          <>
            We have sent a confirmation link
            {address ? <> to <strong>{address}</strong></> : ' to the address you gave'}.
            Click it and your application is complete.
          </>
        )}
      </Alert>

      <Box sx={{ mt: 4 }}>
        <Typography variant="h4" component="h2" sx={{ mb: 1 }}>
          What happens next
        </Typography>
        <Stack component="ol" spacing={1.25} sx={{ pl: 2.5, m: 0 }}>
          <Typography component="li" variant="body2" color="text.secondary">
            The link works once and stops working after 24 hours. If it expires before you
            get to it, your application is not lost — it goes to the programme office
            instead.
          </Typography>
          <Typography component="li" variant="body2" color="text.secondary">
            Clicking it proves the address is yours. Only then do we check it against the
            open intakes.
          </Typography>
          <Typography component="li" variant="body2" color="text.secondary">
            If your address and seat number match an open intake, your account is created
            straight away and we email you a temporary password. Otherwise the programme
            office reads the application and comes back to you.
          </Typography>
        </Stack>
      </Box>

      <Stack direction="row" spacing={2} sx={{ mt: 4 }}>
        <Button href="/login" variant="outlined">
          Go to sign in
        </Button>
      </Stack>

      <TechNote>
        Only the SHA-256 of the confirmation token is stored, in{' '}
        <code>EmailVerification.tokenHash</code> — the token itself exists in that one
        email and nowhere else, so a dump of the table confirms nobody&rsquo;s address.
        The row is marked consumed rather than deleted, which is how a second click is
        told apart from an expired link and given the right sentence. This build has no
        SMTP credentials, so the mailer&rsquo;s console driver prints the whole message,
        link included, to the terminal running <code>npm run dev</code>.
      </TechNote>
    </RegisterShell>
  );
}
