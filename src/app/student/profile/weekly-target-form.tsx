'use client';

import { useActionState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { saveWeeklyTargetAction, type TargetState } from './actions';

export function WeeklyTargetForm({ current }: { current: number }) {
  const [state, formAction, pending] = useActionState<TargetState, FormData>(
    saveWeeklyTargetAction,
    {},
  );

  return (
    <Box component="form" action={formAction}>
      <Stack
        direction="row"
        sx={{ gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}
      >
        <TextField
          name="weeklyHourTarget"
          type="number"
          label="Hours per week"
          defaultValue={current}
          required
          sx={{ width: 168 }}
          slotProps={{
            htmlInput: { min: 1, max: 60, step: 0.5, className: 'tabular' },
          }}
        />
        <Button type="submit" variant="outlined" disabled={pending} sx={{ mt: 1 }}>
          {pending ? 'Saving…' : 'Save target'}
        </Button>
      </Stack>

      {state.error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {state.error}
        </Alert>
      ) : null}

      {state.ok && !pending ? (
        <Typography
          role="status"
          variant="body2"
          color="success.dark"
          sx={{ mt: 1.5, display: 'block' }}
        >
          Saved. Your Time Log now aims at {state.hours} hours a week.
        </Typography>
      ) : null}
    </Box>
  );
}
