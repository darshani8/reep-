'use client';

import { useActionState, useState } from 'react';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import {
  approveRegistrationAction,
  reevaluateRegistrationAction,
  rejectRegistrationAction,
  type DecisionState,
} from '../actions';

export type CohortChoice = { id: string; code: string; name: string; batchLabel: string };

/**
 * Approve, reject, or ask the rules again.
 *
 * Three separate `useActionState` hooks rather than one, because the three
 * outcomes have to be able to coexist on screen: a failed approval must not wipe
 * the rejection reason a director had started typing, and the temporary password
 * an approval returns has to stay visible while they read it out.
 *
 * The approval asks for two things that are *not* pre-filled from the
 * application, and that is the whole point of the screen:
 *
 *  - **The cohort.** `Student.cohortId` is required and permanent-ish; a wrong
 *    one puts a student on the wrong roster, the wrong leaderboard and the wrong
 *    set of vacancies. Only cohorts of the applicant's own degree level are
 *    offered, because `Cohort.degreeLevel` exists to stop a BBA batch being shown
 *    MBA-only postings.
 *  - **The USN.** It is unique and it is what every other screen identifies this
 *    person by. The applicant typed theirs from memory; a director confirms it
 *    against the admission record in front of them. The box is seeded with what
 *    was submitted and has to be looked at, not accepted by reflex — which is why
 *    it is a text field rather than a checkbox saying "yes, that USN".
 */
export function DecisionPanel({
  registrationId,
  cohorts,
  suggestedCohortId,
  suggestedUsn,
  emailVerified,
}: {
  registrationId: string;
  cohorts: CohortChoice[];
  /// The cohort the matched rule named, when it named one.
  suggestedCohortId: string | null;
  suggestedUsn: string;
  emailVerified: boolean;
}) {
  const [approveState, approveAction, approving] = useActionState<DecisionState, FormData>(
    approveRegistrationAction,
    {},
  );
  const [rejectState, rejectAction, rejecting] = useActionState<DecisionState, FormData>(
    rejectRegistrationAction,
    {},
  );
  const [rerunState, rerunAction, rerunning] = useActionState<DecisionState, FormData>(
    reevaluateRegistrationAction,
    {},
  );

  // Controlled, for the reason `profile-form.tsx` records: React resets
  // uncontrolled inputs when an action returns, and these actions return errors.
  const [cohortId, setCohortId] = useState(suggestedCohortId ?? cohorts[0]?.id ?? '');
  const [usn, setUsn] = useState(suggestedUsn);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const busy = approving || rejecting || rerunning;

  return (
    <Stack spacing={4}>
      {!emailVerified ? (
        <Alert severity="warning">
          <AlertTitle sx={{ fontWeight: 600, fontSize: '0.875rem' }}>
            This address has not been confirmed
          </AlertTitle>
          The applicant has not clicked the link we emailed them, so nothing has proved
          the address is theirs. Approving anyway creates a working account for whoever
          typed it — do it only if you have confirmed who they are another way.
        </Alert>
      ) : null}

      {approveState.temporaryPassword ? (
        <Alert severity="success">
          <AlertTitle sx={{ fontWeight: 600, fontSize: '0.875rem' }}>{approveState.message}</AlertTitle>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Their temporary password is shown once, here and in the emailed copy. It is
            stored only as a scrypt hash, so nobody — including you — can read it back
            after this page is closed.
          </Typography>
          <Box
            component="code"
            sx={{
              display: 'inline-block',
              px: 1.25,
              py: 0.75,
              borderRadius: 1,
              bgcolor: 'background.default',
              fontWeight: 600,
              fontSize: '1rem',
              letterSpacing: '0.04em',
            }}
          >
            {approveState.temporaryPassword}
          </Box>
        </Alert>
      ) : approveState.message ? (
        <Alert severity="success">{approveState.message}</Alert>
      ) : null}

      {/* --- Approve ------------------------------------------------------ */}
      <Box component="form" action={approveAction}>
        <input type="hidden" name="registrationId" value={registrationId} />

        <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
          Approve
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
          Creates the account, the student record and the profile in one go, and promotes
          the CV and photo out of quarantine. Check the seat number against the admission
          record before you do — it is unique and every other screen uses it.
        </Typography>

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              select
              fullWidth
              required
              name="cohortId"
              label="Cohort"
              value={cohortId}
              onChange={(event) => setCohortId(event.target.value)}
              disabled={cohorts.length === 0}
              helperText={
                cohorts.length === 0
                  ? 'No cohort exists at this degree level. Create one before approving.'
                  : suggestedCohortId
                    ? 'Suggested by the rule that matched. Change it if the rule is out of date.'
                    : 'No rule named a cohort, so this is yours to choose.'
              }
            >
              {cohorts.map((cohort) => (
                <MenuItem key={cohort.id} value={cohort.id}>
                  {cohort.code} — {cohort.name}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              required
              name="usn"
              label="Confirm USN"
              value={usn}
              onChange={(event) => setUsn(event.target.value.toUpperCase())}
              placeholder="1BG24MBA001"
              helperText={
                suggestedUsn
                  ? 'As submitted by the applicant. Correct it if the admission record differs.'
                  : 'The applicant gave no seat number. Enter the one the college issued.'
              }
            />
          </Grid>
          <Grid size={12}>
            <TextField
              fullWidth
              name="note"
              label="Note (optional)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Confirmed against the admission list of 4 August."
              helperText="Kept on the application as the record of why this was approved. Not emailed."
            />
          </Grid>
        </Grid>

        {approveState.error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {approveState.error}
          </Alert>
        ) : null}

        <Button
          type="submit"
          variant="contained"
          color="secondary"
          sx={{ mt: 2.5 }}
          disabled={busy || cohorts.length === 0}
        >
          {approving ? 'Creating the account…' : 'Approve and create the account'}
        </Button>
      </Box>

      {/* --- Reject ------------------------------------------------------- */}
      <Box component="form" action={rejectAction} sx={{ pt: 3.5, borderTop: 1, borderColor: 'divider' }}>
        <input type="hidden" name="registrationId" value={registrationId} />

        <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
          Reject
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
          The reason is emailed to the applicant word for word, so write something they
          can act on. No account is created and nothing is deleted — the application stays
          on this screen as the record.
        </Typography>

        <TextField
          fullWidth
          multiline
          rows={2}
          name="reason"
          label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="This seat number is not on the 2026 admission list. Check it and apply again with the number on your offer letter."
        />

        {rejectState.error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {rejectState.error}
          </Alert>
        ) : null}
        {rejectState.message ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            {rejectState.message}
          </Alert>
        ) : null}

        <Button type="submit" color="error" variant="outlined" sx={{ mt: 2.5 }} disabled={busy}>
          {rejecting ? 'Rejecting…' : 'Reject and email the reason'}
        </Button>
      </Box>

      {/* --- Re-run the rules --------------------------------------------- */}
      <Box component="form" action={rerunAction} sx={{ pt: 3.5, borderTop: 1, borderColor: 'divider' }}>
        <input type="hidden" name="registrationId" value={registrationId} />

        <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
          Ask the rules again
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
          Rules are data, so &ldquo;why was this not approved automatically?&rdquo; is
          often &ldquo;the rule was switched off at the time&rdquo;. Fix the rule, then run
          this — the applicant does not need another confirmation link.
        </Typography>

        {rerunState.error ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {rerunState.error}
          </Alert>
        ) : null}
        {rerunState.message ? (
          <Alert severity="info" sx={{ mb: 2 }}>
            {rerunState.message}
          </Alert>
        ) : null}

        <Button type="submit" variant="text" disabled={busy || !emailVerified}>
          {rerunning ? 'Re-evaluating…' : 'Re-evaluate against the current rules'}
        </Button>
      </Box>
    </Stack>
  );
}
