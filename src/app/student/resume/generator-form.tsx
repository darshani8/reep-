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
 * The whole brief is four fields, two of them optional. Everything else the
 * resume needs is already in REEP, which is the point the screen is making.
 *
 * This posts to `/api/resume/generate` rather than calling the Server Action it
 * used to, for one reason: **a Server Action cannot be cancelled.** Generation
 * runs a local 12B model for around a minute, and a minute is long enough that
 * a reader will change their mind — mistyped the role, pasted the wrong posting,
 * or simply wants to leave. Over `fetch` the abort reaches the route handler,
 * which passes it to the model client, which drops the connection to Ollama.
 * The GPU is freed and no resume row is written.
 *
 * The elapsed counter is here for the same reason. A spinner that sits for
 * sixty seconds is indistinguishable from one that has hung, and the previous
 * copy claimed the wait was "a few seconds" — which stopped being true the day
 * the local model became the default writer.
 */
export function GeneratorForm({
  defaultRole,
  defaultIndustry,
  modelHint,
}: {
  defaultRole?: string;
  defaultIndustry?: string;
  /// Sets expectations honestly: a local model is far slower than a hosted one.
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
      const res = await fetch('/api/resume/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          targetRole,
          targetIndustry,
          title: String(form.get('title') ?? '').trim() || undefined,
          jobDescription:
            String(form.get('jobDescription') ?? '')
              .trim()
              .slice(0, 20_000) || undefined,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok || !payload.id) {
        throw new Error(
          payload.error ?? 'The generator could not finish. Nothing was saved.',
        );
      }
      return payload.id;
    });

    // Cancelled needs no message: the reader did it on purpose and the form is
    // exactly as they left it.
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
          placeholder="Business Analyst"
          defaultValue={defaultRole}
          required
          fullWidth
          disabled={pending}
          slotProps={{ htmlInput: { minLength: 2, maxLength: 120 } }}
        />

        <TextField
          name="targetIndustry"
          label="Industry"
          placeholder="Management consulting"
          defaultValue={defaultIndustry}
          required
          fullWidth
          disabled={pending}
          slotProps={{ htmlInput: { minLength: 2, maxLength: 120 } }}
        />

        <TextField
          name="title"
          label="Name this version (optional)"
          placeholder="Leave blank to name it after the job"
          fullWidth
          disabled={pending}
          slotProps={{ htmlInput: { maxLength: 120 } }}
        />

        <TextField
          name="jobDescription"
          label="Paste the job posting (optional)"
          placeholder="Paste it here and we will lead with the records that match it, and tell you which of its keywords you cannot yet back up."
          multiline
          minRows={4}
          fullWidth
          disabled={pending}
          slotProps={{ htmlInput: { maxLength: 20000 } }}
        />

        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}

        {pending && (
          <Box aria-live="polite">
            <LinearProgress
              // Indeterminate on purpose: the model gives no progress signal, and
              // a bar that pretends to know how far along it is would be a lie.
              sx={{ mb: 1 }}
              aria-label="Writing your resume"
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
            {pending ? 'Writing your resume…' : 'Generate my resume'}
          </Button>

          {pending && (
            <Button variant="outlined" onClick={cancel}>
              Cancel
            </Button>
          )}
        </Stack>

        <Typography variant="caption" color="text.secondary">
          {pending
            ? 'Reading your REEP record, drafting each section, and checking every line against a record before it is allowed onto the page. Cancel stops the model — nothing is saved.'
            : 'Saved as a new version. Nothing you generated before is overwritten.'}
        </Typography>
      </Stack>
    </Box>
  );
}
