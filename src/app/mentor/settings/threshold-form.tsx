'use client';

import { useActionState, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { AlertRuleKey, AlertSeverity } from '@prisma/client';

import { StatusChip } from '@/components/kit';
import { SEVERITY_LABEL } from '@/lib/reep';

import { resetThresholdsAction, saveThresholdsAction, type ThresholdState } from './actions';
import {
  RULE_FIELDS,
  SEVERITY_OPTIONS,
  enabledName,
  fieldName,
  severityName,
} from './rule-fields';

/**
 * Five rules, one form.
 *
 * Each rule is a block, not a card: a column of five outlined panels is a lot
 * of ink around what is really one settings page, and the hairline between two
 * blocks says the same thing for a fraction of it. Only the save button carries
 * the accent — everything else on the screen is ink, a status, or a field.
 */

export type ThresholdRow = {
  ruleKey: AlertRuleKey;
  label: string;
  help: string;
  enabled: boolean;
  severity: AlertSeverity;
  params: Record<string, number>;
  defaults: Record<string, number>;
  configured: boolean;
};

export function ThresholdForm({
  cohortId,
  cohortCode,
  rows,
}: {
  cohortId: string;
  cohortCode: string;
  rows: ThresholdRow[];
}) {
  const [saveState, saveAction, saving] = useActionState<ThresholdState, FormData>(
    saveThresholdsAction,
    null,
  );
  const [resetState, resetAction, resetting] = useActionState<ThresholdState, FormData>(
    resetThresholdsAction,
    null,
  );

  // The inputs are uncontrolled, so when the server sends back different values
  // — after a clamp, or after a revert — the blocks have to remount or the old
  // number would sit in the box looking saved.
  const signature = rows
    .map((r) => `${r.ruleKey}:${r.enabled}:${r.severity}:${JSON.stringify(r.params)}`)
    .join('|');

  return (
    <>
      <Box component="form" action={saveAction}>
        <input type="hidden" name="cohortId" value={cohortId} />

        <Stack>
          {rows.map((row) => (
            <RuleBlock key={`${row.ruleKey}:${signature}`} row={row} cohortCode={cohortCode} />
          ))}
        </Stack>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{
            mt: 4,
            pt: 3,
            borderTop: 1,
            borderColor: 'divider',
            alignItems: { sm: 'center' },
          }}
        >
          <Button
            type="submit"
            variant="contained"
            color="secondary"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={15} color="inherit" /> : undefined}
            sx={{ flexShrink: 0 }}
          >
            {saving ? 'Saving and re-checking…' : `Save and re-check ${cohortCode}`}
          </Button>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            Saving stores these numbers against {cohortCode} and runs the alert scan
            immediately, so you can see what changed.
          </Typography>
        </Stack>

        {saveState && (
          <Alert severity={saveState.ok ? 'success' : 'error'} role="status" sx={{ mt: 2, mb: 0 }}>
            {saveState.message}
          </Alert>
        )}
      </Box>

      {/* A separate form: HTML forbids nesting one, and reverting is a different
          verb from saving. */}
      <Box component="form" action={resetAction} sx={{ mt: 4 }}>
        <input type="hidden" name="cohortId" value={cohortId} />
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { sm: 'center' } }}
        >
          <Button
            type="submit"
            size="small"
            disabled={resetting}
            sx={{ color: 'text.secondary', ml: '-10px', flexShrink: 0 }}
          >
            {resetting ? 'Reverting…' : 'Revert to programme defaults'}
          </Button>
          <Typography variant="caption" color="text.disabled" sx={{ flex: 1 }}>
            Deletes {cohortCode}&apos;s own numbers. Other cohorts are untouched.
          </Typography>
        </Stack>

        {resetState && (
          <Alert severity={resetState.ok ? 'success' : 'error'} role="status" sx={{ mt: 2, mb: 0 }}>
            {resetState.message}
          </Alert>
        )}
      </Box>
    </>
  );
}

// ---------------------------------------------------------------------------

/// One rule. The switch is stateful only so that turning a rule off can say so
/// in words above the numbers it would otherwise have used.
function RuleBlock({ row, cohortCode }: { row: ThresholdRow; cohortCode: string }) {
  const [enabled, setEnabled] = useState(row.enabled);

  return (
    <Box
      sx={{
        py: 4,
        borderTop: 1,
        borderColor: 'divider',
        '&:first-of-type': { borderTop: 0, pt: 0 },
      }}
    >
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ justifyContent: 'space-between', alignItems: { md: 'flex-start' } }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" component="h3">{row.label}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: '68ch' }}>
            {row.help}
          </Typography>
        </Box>

        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', gap: 1 }}
        >
          <StatusChip
            tone={row.configured ? 'info' : 'neutral'}
            variant="outlined"
            label={row.configured ? `Tuned for ${cohortCode}` : 'Programme default'}
          />
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Switch
              name={enabledName(row.ruleKey)}
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              color="secondary"
              slotProps={{ input: { 'aria-label': `${row.label} enabled` } }}
            />
            <Typography
              variant="body2"
              color={enabled ? 'text.primary' : 'text.disabled'}
              sx={{ width: 26 }}
            >
              {enabled ? 'On' : 'Off'}
            </Typography>
          </Stack>
        </Stack>
      </Stack>

      {!enabled && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          This rule is switched off. The numbers below are kept for {cohortCode} but are not
          being applied.
        </Typography>
      )}

      {/* The fields stay editable while a rule is off: a disabled input posts
          nothing, and the action would then clamp the missing value down to the
          bottom of its range. */}
      <Grid container spacing={2.5} sx={{ mt: 0.5, maxWidth: 900 }}>
        <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
          <TextField
            select
            fullWidth
            label="Severity"
            name={severityName(row.ruleKey)}
            defaultValue={row.severity}
            helperText="How loudly this one speaks"
          >
            {SEVERITY_OPTIONS.map((option) => (
              <MenuItem key={option} value={option}>
                {SEVERITY_LABEL[option]}
              </MenuItem>
            ))}
          </TextField>
        </Grid>

        {RULE_FIELDS[row.ruleKey].map((field) => (
          <Grid key={field.name} size={{ xs: 12, sm: 6, lg: 4 }}>
            <TextField
              fullWidth
              type="number"
              label={field.label}
              name={fieldName(row.ruleKey, field.name)}
              defaultValue={row.params[field.name]}
              helperText={`Default ${row.defaults[field.name]} · allowed ${field.min} to ${field.max}`}
              slotProps={{
                htmlInput: {
                  min: field.min,
                  max: field.max,
                  step: field.step,
                  className: 'tabular',
                },
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <Typography variant="caption" color="text.secondary">
                        {field.suffix}
                      </Typography>
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
