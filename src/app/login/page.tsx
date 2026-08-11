import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

import { TechNote } from '@/components/kit';
import { HOME_FOR_ROLE, getSession } from '@/lib/auth';

import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — REEP Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * The one screen outside the role layouts, so it carries its own full-height
 * shell: brand panel on the left from lg up, sign-in on the right, and a
 * compact brand strip instead of the panel on narrow screens.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  const { next } = await searchParams;

  // Same-origin paths only, matching the check the action does before it
  // redirects. Anything else is dropped rather than shown back to the user.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : undefined;

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      {/* --- compact brand strip (below lg) ----------------------------- */}
      <Box
        sx={{
          display: { xs: 'flex', lg: 'none' },
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 2,
          px: { xs: 3, sm: 4 },
          py: 2,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
          <Typography sx={{ fontSize: '1.25rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
            REEP
          </Typography>
          <Typography
            variant="caption"
            sx={{ textTransform: 'uppercase', letterSpacing: '0.14em', opacity: 0.72 }}
          >
            Tracking Dashboard
          </Typography>
        </Box>
        <Typography
          variant="caption"
          sx={{ display: { xs: 'none', sm: 'block' }, opacity: 0.72 }}
        >
          Reboot. Excel. Elevate.
        </Typography>
      </Box>

      <Box sx={{ flex: 1, display: 'flex' }}>
        {/* --- brand panel (lg and up) ---------------------------------- */}
        <Box
          sx={{
            display: { xs: 'none', lg: 'flex' },
            flexDirection: 'column',
            justifyContent: 'space-between',
            width: '44%',
            maxWidth: 620,
            p: 7,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
          }}
        >
          <Box>
            <Typography sx={{ fontSize: '2rem', fontWeight: 600, letterSpacing: '-0.02em' }}>
              REEP
            </Typography>
            <Typography
              variant="subtitle2"
              sx={{ mt: 0.5, textTransform: 'uppercase', letterSpacing: '0.16em', opacity: 0.7 }}
            >
              Tracking Dashboard
            </Typography>
          </Box>

          <Box sx={{ maxWidth: 420 }}>
            <Typography
              component="p"
              sx={{ fontSize: '2rem', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em' }}
            >
              Reboot. Excel. Elevate.
            </Typography>
            <Typography variant="body1" sx={{ mt: 2, opacity: 0.78 }}>
              One place to see how far you have come in the programme, the hours you
              have put into each way of learning, and the certifications that carry
              you to placement readiness.
            </Typography>
          </Box>

          <Typography variant="caption" sx={{ opacity: 0.55 }}>
            BGSCET MBA · Reboot, Excel, Elevate Programme
          </Typography>
        </Box>

        {/* --- sign in -------------------------------------------------- */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            px: { xs: 3, sm: 5 },
            py: { xs: 5, sm: 8 },
            bgcolor: 'background.default',
          }}
        >
          <Box sx={{ width: '100%', maxWidth: 400 }}>
            <Typography variant="h1">Sign in</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {safeNext
                ? 'Sign in to carry on to the page you asked for.'
                : 'Use your BGSCET email address and password.'}
            </Typography>

            {session ? (
              <Alert
                severity="info"
                sx={{ mt: 2.5 }}
                action={
                  <Button size="small" href={HOME_FOR_ROLE[session.role]}>
                    Go to dashboard
                  </Button>
                }
              >
                You are already signed in as {session.name}.
              </Alert>
            ) : null}

            <LoginForm next={safeNext} />

            <TechNote>
              Signing in checks the password against a scrypt hash and hands back a
              signed session token, held in an http-only cookie for twelve hours.
              Middleware only checks that the cookie exists, so the edge bundle stays
              free of database and crypto code; every page then verifies the token and
              the role for itself. A <code>?next=</code> value is followed only when it
              is a path on this site. The demo accounts above are seed data for this
              review build and come out before anything real is loaded.
            </TechNote>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
