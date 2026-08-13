import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { TechNote } from '@/components/kit';
import { HOME_FOR_ROLE, getSession } from '@/lib/auth';

import { StaffLoginForm } from './staff-login-form';

export const metadata = { title: 'Staff sign in — REEP Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * The mentor's way in.
 *
 * Two things about this file are load-bearing and neither is visible from the
 * URL.
 *
 * **The route group.** `/mentor/*` is wrapped by `app/mentor/layout.tsx`, whose
 * first line is `requireMentor()` — so a sign-in page filed under
 * `app/mentor/login` would be bounced to `/login` by its own layout before it
 * could render a single field. A route group is the documented way to opt a
 * segment out of a layout without moving its URL, so this page lives at
 * `app/(auth)/mentor/login` and still answers on `/mentor/login`. The middleware
 * matcher excludes the same path for the same reason; both guards had to move,
 * and missing either one produces the identical redirect loop.
 *
 * **The shared action.** The form posts to `loginAction` — the one the main
 * sign-in screen uses, which is the one that calls `authenticate()`. What is
 * mentor-specific here is the copy, the demo accounts on offer and the
 * destination. Forking the credential check to add a mentor flavour of it would
 * mean two places to get a password comparison right, and two session shapes for
 * every downstream guard to understand.
 */
export default async function MentorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  const { next } = await searchParams;

  // Same-origin paths only, matching the check the action repeats before it
  // redirects. Anything else falls back to the mentor dashboard, which is the
  // point of signing in here.
  const safeNext =
    next && next.startsWith('/') && !next.startsWith('//') ? next : '/mentor';

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
            Faculty Mentor
          </Typography>
        </Box>
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
              Faculty Mentor
            </Typography>
          </Box>

          <Box sx={{ maxWidth: 420 }}>
            <Typography
              component="p"
              sx={{ fontSize: '2rem', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em' }}
            >
              Your mentor group, on one screen.
            </Typography>
            <Typography variant="body1" sx={{ mt: 2, opacity: 0.78 }}>
              Who is behind pace and why, what each student has uploaded for you to
              verify, the notes from your last conversation with them, and the leave
              requests waiting on your signature.
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
            <Typography variant="h1">Mentor sign in</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              For faculty mentors and programme staff. Students sign in{' '}
              <Link href="/login">here</Link>.
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

            <StaffLoginForm next={safeNext} />

            <TechNote>
              This screen shares its credential check with the main sign-in page — one{' '}
              <code>authenticate()</code>, one session shape, one cookie — and differs
              only in its copy and in where it sends you afterwards. It is served from a
              route group so that the mentor layout&rsquo;s own{' '}
              <code>requireMentor()</code> guard does not redirect the sign-in page, and
              the middleware matcher excludes the same path for the same reason. Signing
              in as a student here is not an error: the session is honest about the role,
              and the role guard on <code>/mentor</code> quietly sends that account to its
              own dashboard instead.
            </TechNote>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
