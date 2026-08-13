'use client';

import { useActionState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

import type { LeaveActionState } from './actions';

/**
 * Withdrawing your own request.
 *
 * Rendered only while the request is still live, and refused server-side once it
 * is not — a decision that has been taken is a record, and this button must not
 * be able to erase one. There is no confirmation dialog: withdrawing is
 * reversible by applying again, and a dialog on a two-click action is friction
 * spent on nothing.
 */
export function WithdrawButton({
  requestId,
  withdrawAction,
}: {
  requestId: string;
  withdrawAction: (
    prev: LeaveActionState,
    formData: FormData,
  ) => Promise<LeaveActionState>;
}) {
  const [result, submit, pending] = useActionState(withdrawAction, null);

  return (
    <Box component="form" action={submit}>
      <input type="hidden" name="requestId" value={requestId} />
      <Button type="submit" size="small" disabled={pending} sx={{ color: 'text.secondary', ml: '-8px' }}>
        {pending ? 'Withdrawing…' : 'Withdraw this request'}
      </Button>
      {result ? (
        <Alert severity={result.ok ? 'success' : 'error'} role="status" sx={{ mt: 1.5 }}>
          {result.message}
        </Alert>
      ) : null}
    </Box>
  );
}
