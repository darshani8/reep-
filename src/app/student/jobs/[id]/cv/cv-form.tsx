'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useAbortable } from '@/lib/use-abortable';

/**
 * The same two fields the resume screen asks for, with the posting already
 * filled in.
 *
 * The job description is *not* an editable field here, which is the whole
 * difference: on `/student/resume` the student pastes a posting, and on this
 * screen REEP already has it. It is shown above this form as text so they can
 * read what the draft will be written against, and sent by the route handler
 * from the `Job` row rather than from anything this component posts — a
 * description travelling through the browser could come back edited, and the
 * resume would then be tailored to a posting that does not exist.
 *
 * Posted over `fetch` rather than through a Server Action for the reason the
 * resume generator is: an action cannot be cancelled, and a local model takes
 * about a minute.
 */
export function CvForm({
  jobId,
  defaultRole,
  defaultIndustry,
  modelHint,
}: {
  jobId: string;
  defaultRole: string;
  defaultIndustry?: string;
  /// Sets expectations honestly — a local model is far slower than a hosted one.
  modelHint?: string;
}) {
  const router = useRouter();
  const { run, cancel, pending } = useAbortable();

  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!pending) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [pending]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const targetRole = String(form.get('targetRole') ?? '').trim();
    const targetIndustry = String(form.get('targetIndustry') ?? '').trim();

    if (targetRole.length < 2 || targetIndustry.length < 2) {
      setError('Enter both a target role and a target industry.');
      return;
    }

    setError(null);

    const outcome = await run(async (signal) => {
      const res = await fetch(`/api/jobs/${jobId}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          targetRole,
          targetIndustry,
          title: String(form.get('title') ?? '').trim() || undefined,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !payload.id) {
        throw new Error(payload.error ?? 'The generator could not finish. Nothing was saved.');
      }
      return payload.id;
    });

    // Cancelled needs no message: the reader did it on purpose.
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'error') {
      setError(outcome.error.message);
      return;
    }
    router.push(`/student/resume/${outcome.value}`);
  }

  return (
    <Box component="form" onSubmit={onSubmit} aria-busy={pending}>
      <Stack spacing={2.5}>
        <TextField
          name="targetRole"
          label="Job you are applying for"
          defaultValue={defaultRole}
          required
          fullWidth
          disabled={pending}
          helperText="Taken from the posting. Change it if you are pitching yourself differently."
          slotProps={{ htmlInput: { minLength: 2, maxLength: 120 } }}
        />

        <TextField
          name="targetIndustry"
          label="Industry"
          placeholder="IT services"
          defaultValue={defaultIndustry}
          required
          fullWidth
          disabled={pending}
          helperText="The weekly sheet does not carry an industry, so this one is yours to name."
          slotProps={{ htmlInput: { minLength: 2, maxLength: 120 } }}
        />

        <TextField
          name="title"
          label="Name this version (optional)"
          placeholder="Leave blank to name it after the posting"
          fullWidth
          disabled={pending}
          slotProps={{ htmlInput: { maxLength: 120 } }}
        />

        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}

        {pending && (
          <Box aria-live="polite">
            <LinearProgress
              // Indeterminate on purpose: the model gives no progress signal.
              sx={{ mb: 1 }}
              aria-label="Writing your CV"
            />
            <Typography variant="caption" color="text.secondary" className="tabular">
              {elapsed}s elapsed{modelHint ? ` · ${modelHint}` : ''}
            </Typography>
          </Box>
        )}

        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Button
            type="submit"
            variant="contained"
            color="secondary"
            disabled={pending}
            startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {pending ? 'Writing your CV…' : 'Build my CV for this job'}
          </Button>

          {pending && (
            <Button variant="outlined" onClick={cancel}>
              Cancel
            </Button>
          )}
        </Stack>

        <Typography variant="caption" color="text.secondary">
          {pending
            ? 'Reading your REEP record, drafting each section against this posting, and checking every line against a record before it is allowed onto the page. Cancel stops the model — nothing is saved.'
            : 'Saved as a new version, filed against this posting. Nothing you generated before is overwritten.'}
        </Typography>
      </Stack>
    </Box>
  );
}
