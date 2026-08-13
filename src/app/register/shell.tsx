import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * The frame the three registration screens share.
 *
 * `/register` sits outside `/student`, `/mentor` and `/director`, so it gets
 * none of `AppShell` — there is no navigation to show someone who has no
 * account, and no name to put in the corner. `login/page.tsx` solved the same
 * problem by carrying its own full-height layout inline; this is that layout,
 * lifted into a component because three pages need it rather than one.
 *
 * Kept visually identical to the sign-in screen on purpose. An applicant who
 * follows a confirmation link out of their mailbox arrives here cold, and the
 * page they land on has to look like the same institution that emailed them.
 */
export function RegisterShell({
  title,
  subtitle,
  children,
  width = 720,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /// The form needs room for two columns; the confirmation pages read better
  /// narrow.
  width?: number;
}) {
  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      {/* --- compact brand strip (below lg) ------------------------------ */}
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
            Registration
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
            width: '34%',
            maxWidth: 460,
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
              Registration
            </Typography>
          </Box>

          <Box sx={{ maxWidth: 340 }}>
            <Typography
              component="p"
              sx={{ fontSize: '1.75rem', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em' }}
            >
              Reboot. Excel. Elevate.
            </Typography>
            <Typography variant="body1" sx={{ mt: 2, opacity: 0.78 }}>
              File this once. If your college address and your seat number match an open
              intake, your account is ready the moment you confirm the address —
              otherwise the programme office reads it and comes back to you.
            </Typography>
          </Box>

          <Typography variant="caption" sx={{ opacity: 0.55 }}>
            BGSCET MBA · Reboot, Excel, Elevate Programme
          </Typography>
        </Box>

        {/* --- content ---------------------------------------------------- */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            px: { xs: 3, sm: 5 },
            py: { xs: 5, sm: 7 },
            bgcolor: 'background.default',
            overflowX: 'hidden',
          }}
        >
          <Box sx={{ width: '100%', maxWidth: width }}>
            <Typography variant="h1">{title}</Typography>
            {subtitle ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: '64ch' }}>
                {subtitle}
              </Typography>
            ) : null}
            <Box sx={{ mt: 4 }}>{children}</Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
