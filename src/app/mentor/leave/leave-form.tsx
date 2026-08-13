'use client';

import { useActionState, useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { Fact, Surface } from '@/components/kit';

import type { LeaveActionState } from './actions';

/**
 * The application form.
 *
 * The two approvers are shown *before* the request is sent, not after. Who reads
 * your leave application is the first thing anybody wants to know, and a form
 * that reveals it on the confirmation screen has already made the decision for
 * you. They are plain facts rather than editable fields because the routing is a
 * rule about the mentor group, not a preference — see `resolveApprovers`.
 *
 * The dates are two `type="date"` inputs with `min`/`max` set from the same
 * bounds the Server Action validates against, so the picker cannot offer a day
 * the write will then refuse. The action still checks: an attribute on an input
 * is a courtesy, not a constraint.
 */

export function LeaveForm({
  applyAction,
  todayISO,
  earliestISO,
  latestISO,
  firstApproverName,
  secondApproverName,
  routingError,
}: {
  applyAction: (
    prev: LeaveActionState,
    formData: FormData,
  ) => Promise<LeaveActionState>;
  todayISO: string;
  earliestISO: string;
  latestISO: string;
  firstApproverName: string | null;
  secondApproverName: string | null;
  routingError: string | null;
}) {
  const [result, submit, pending] = useActionState(applyAction, null);

  const [fromDate, setFromDate] = useState(todayISO);
  const [toDate, setToDate] = useState(todayISO);
  const [reason, setReason] = useState('');

  // Only clear on success. A rejected submission leaves every field exactly
  // where it was — retyping the reason is the part nobody should have to redo.
  useEffect(() => {
    if (result?.ok) setReason('');
  }, [result]);

  // A one-day leave is the common case, so the last day follows the first until
  // the applicant moves it themselves.
  function changeFrom(value: string) {
    setFromDate(value);
    if (toDate < value) setToDate(value);
  }

  return (
    <Box component="form" action={submit}>
      <Stack spacing={2.5} sx={{ maxWidth: '52ch' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            label="First day"
            name="fromDate"
            type="date"
            required
            fullWidth
            value={fromDate}
            onChange={(event) => changeFrom(event.target.value)}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: earliestISO, max: latestISO },
            }}
          />
          <TextField
            label="Last day"
            name="toDate"
            type="date"
            required
            fullWidth
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
            helperText="Both days count"
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: fromDate, max: latestISO },
            }}
          />
        </Stack>

        <TextField
          label="Reason"
          name="reason"
          multiline
          minRows={3}
          required
          fullWidth
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What is the leave for, and what happens to the work it covers?"
          slotProps={{ htmlInput: { maxLength: 1000 } }}
        />

        <Surface sx={{ bgcolor: 'background.default' }}>
          <Typography variant="caption" color="text.secondary">
            This request needs two signatures, in this order.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={4} sx={{ mt: 1.5 }}>
            <Fact label="First approver" value={firstApproverName ?? 'Not routed'} />
            <Fact
              label="Second approver"
              value={secondApproverName ?? 'Named once the first signs'}
            />
          </Stack>
        </Surface>

        {routingError ? <Alert severity="warning">{routingError}</Alert> : null}

        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            type="submit"
            variant="contained"
            color="secondary"
            disabled={pending || routingError !== null}
          >
            {pending ? 'Sending…' : 'Apply for leave'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            You can withdraw it until the second signature lands.
          </Typography>
        </Stack>

        {result ? (
          <Alert severity={result.ok ? 'success' : 'error'} role="status">
            {result.message}
          </Alert>
        ) : null}
      </Stack>
    </Box>
  );
}
