'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import LoginRounded from '@mui/icons-material/LoginRounded';
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded';
import VisibilityRounded from '@mui/icons-material/VisibilityRounded';

import { loginAction, type LoginState } from './actions';

/**
 * The whole sign-in interaction lives in one client component because the demo
 * account buttons have to write into the same two fields the form submits.
 * Splitting them would mean lifting state into a third component for no gain.
 */

const DEMO_PASSWORD = 'reep2026';

const DEMO_ACCOUNTS: { email: string; who: string; role: string }[] = [
  { email: 'ananya.r@bgscet.ac.in', who: 'Ananya R.', role: 'Student, on track' },
  { email: 'aditi.k@bgscet.ac.in', who: 'Aditi K.', role: 'Student, behind on hours' },
  { email: 'rakesh.iyer@bgscet.ac.in', who: 'Prof. Rakesh Iyer', role: 'Faculty mentor' },
  { email: 's.manjunath@bgscet.ac.in', who: 'Dr. S. Manjunath', role: 'Programme director' },
];

/// Separate component so `useFormStatus` can read the parent form's state.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="contained"
      color="secondary"
      size="large"
      fullWidth
      disabled={pending}
      startIcon={
        pending ? <CircularProgress size={16} color="inherit" /> : <LoginRounded />
      }
      sx={{ mt: 0.5, minHeight: 46 }}
    >
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, {});

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  function fillFrom(demoEmail: string) {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setShowPassword(false);
  }

  return (
    <>
      <Box component="form" action={formAction} sx={{ mt: 3 }}>
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <Stack spacing={2}>
          <TextField
            label="Email"
            name="email"
            type="email"
            required
            fullWidth
            autoComplete="username"
            placeholder="you@bgscet.ac.in"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <TextField
            label="Password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            required
            fullWidth
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      edge="end"
                      size="small"
                      onClick={() => setShowPassword((shown) => !shown)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <VisibilityOffRounded fontSize="small" />
                      ) : (
                        <VisibilityRounded fontSize="small" />
                      )}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          {state.error ? <Alert severity="error">{state.error}</Alert> : null}

          <SubmitButton />
        </Stack>
      </Box>

      {/* Demo accounts. This build is an internal review prototype, so the
          seeded logins are deliberately on the page rather than in a doc. */}
      <Card sx={{ mt: 4 }}>
        <CardContent sx={{ p: 2.5, '&:last-child': { pb: 2.5 } }}>
          <Typography variant="h4" component="h2">Demo accounts</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            Choose one to fill the form. They all use the password{' '}
            <Box
              component="code"
              sx={{
                px: 0.75,
                py: 0.25,
                borderRadius: 1,
                bgcolor: 'background.default',
                fontWeight: 600,
              }}
            >
              {DEMO_PASSWORD}
            </Box>
            .
          </Typography>

          <Stack spacing={0.5} sx={{ mt: 1.5 }}>
            {DEMO_ACCOUNTS.map((account) => {
              const chosen = email === account.email;
              return (
                <Button
                  key={account.email}
                  type="button"
                  onClick={() => fillFrom(account.email)}
                  sx={{
                    px: 1.5,
                    py: 1.25,
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    color: 'text.primary',
                    bgcolor: chosen ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: chosen ? 'action.selected' : 'action.hover' },
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1">{account.who}</Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', fontWeight: 400 }}
                    >
                      {account.role} · {account.email}
                    </Typography>
                  </Box>
                </Button>
              );
            })}
          </Stack>
        </CardContent>
      </Card>
    </>
  );
}
