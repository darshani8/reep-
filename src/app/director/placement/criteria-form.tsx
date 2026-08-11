'use client';

import { useActionState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SaveRounded from '@mui/icons-material/SaveRounded';

import type { PlacementCriteriaShape } from '@/lib/progress';
import { updatePlacementCriteria, type CriteriaState } from './actions';

function Threshold({
  name,
  label,
  helper,
  defaultValue,
}: {
  name: string;
  label: string;
  helper: string;
  defaultValue: number;
}) {
  return (
    <TextField
      name={name}
      label={label}
      helperText={helper}
      type="number"
      required
      fullWidth
      size="small"
      defaultValue={Math.round(defaultValue)}
      slotProps={{ htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' } }}
    />
  );
}

export function CriteriaForm({ criteria }: { criteria: PlacementCriteriaShape }) {
  const [state, formAction, pending] = useActionState<CriteriaState, FormData>(
    updatePlacementCriteria,
    {},
  );

  return (
    <Box component="form" action={formAction}>
      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Threshold
            name="minReepCompletionPct"
            label="Minimum REEP completion"
            helper="How far through the journey"
            defaultValue={criteria.minReepCompletionPct}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Threshold
            name="minCertCompletionPct"
            label="Minimum certifications"
            helper="Share of required certs finished"
            defaultValue={criteria.minCertCompletionPct}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Threshold
            name="minAttendancePct"
            label="Minimum attendance"
            helper="Instructor-led sessions attended"
            defaultValue={criteria.minAttendancePct}
          />
        </Grid>
      </Grid>

      {/* The accent belongs to the one primary action on this screen — the save
          button below — so the switch is plain ink. */}
      <Box sx={{ mt: 2.5 }}>
        <FormControlLabel
          control={<Switch name="requireCoreCerts" defaultChecked={criteria.requireCoreCerts} />}
          label="Every core certification must be finished"
          slotProps={{ typography: { variant: 'body2' } }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', ml: 6 }}>
          A fourth, all-or-nothing check. Switch it off and eligibility rests on the three
          percentages above.
        </Typography>
      </Box>

      {state.error && (
        <Alert severity="error" sx={{ mt: 2.5 }}>
          {state.error}
        </Alert>
      )}
      {state.message && (
        <Alert severity="success" sx={{ mt: 2.5 }}>
          {state.message}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} sx={{ mt: 2.5, alignItems: 'center' }}>
        <Button
          type="submit"
          variant="contained"
          color="secondary"
          disabled={pending}
          startIcon={<SaveRounded />}
        >
          {pending ? 'Saving…' : 'Save criteria'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Every student is re-checked against the new numbers straight away.
        </Typography>
      </Stack>
    </Box>
  );
}
