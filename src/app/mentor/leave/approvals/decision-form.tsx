'use client';

import { useActionState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { LeaveActionState } from '../actions';

/**
 * Approve or reject, with a note.
 *
 * One form, two submit buttons. `name="decision"` on a submit button puts that
 * button's value into the FormData, so the verdict and the note arrive in the
 * same submission and the note cannot be lost between choosing and typing. It
 * also means the choice degrades to two plain buttons without JavaScript.
 *
 * The note is optional on an approval and asked for on a rejection, but not
 * *enforced* on either: a required field on the refusal path is how you get
 * "n/a" typed into an audit trail. The prompt does the work instead.
 *
 * Neither button is `color="error"`. Rejecting leave is a normal decision, not a
 * destructive one, and painting it red pushes the reader towards the other.
 */
export function DecisionForm({
  requestId,
  stage,
  requesterFirstName,
  decideAction,
}: {
  requestId: string;
  /// Which signature this is. The first is a recommendation and the second is
  /// the decision, and the buttons say so.
  stage: 'FIRST' | 'SECOND';
  requesterFirstName: string;
  decideAction: (
    prev: LeaveActionState,
    formData: FormData,
  ) => Promise<LeaveActionState>;
}) {
  const [result, submit, pending] = useActionState(decideAction, null);

  return (
    <Box component="form" action={submit}>
      <input type="hidden" name="requestId" value={requestId} />

      <TextField
        name="note"
        label="Note for the record"
        placeholder={
          stage === 'FIRST'
            ? `What should the programme office know about ${requesterFirstName}?`
            : 'Anything the record should carry with this decision'
        }
        multiline
        minRows={2}
        fullWidth
        slotProps={{ htmlInput: { maxLength: 1000 } }}
        sx={{ maxWidth: '60ch' }}
      />

      <Stack direction="row" spacing={1.5} useFlexGap sx={{ mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          type="submit"
          name="decision"
          value="APPROVED"
          variant="contained"
          color="secondary"
          disabled={pending}
        >
          {stage === 'FIRST' ? 'Recommend' : 'Approve'}
        </Button>
        <Button type="submit" name="decision" value="REJECTED" disabled={pending} sx={{ color: 'text.secondary' }}>
          Reject
        </Button>
        <Typography variant="caption" color="text.secondary">
          {stage === 'FIRST'
            ? 'A recommendation sends it to the second approver. A rejection ends it here.'
            : 'This is the second signature — either way, the request is settled.'}
        </Typography>
      </Stack>

      {result ? (
        <Alert severity={result.ok ? 'success' : 'error'} role="status" sx={{ mt: 2 }}>
          {result.message}
        </Alert>
      ) : null}
    </Box>
  );
}
