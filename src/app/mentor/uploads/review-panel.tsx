'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import Alert from '@mui/material/Alert';

import { StatusChip } from '@/components/kit';
import { useAbortable } from '@/lib/use-abortable';

/**
 * One file awaiting a mentor's judgement.
 *
 * Not a card: a queue of outlined cards makes eight pending files look like
 * eight separate screens. Rows are separated by a hairline, and the only
 * surface on the row is the thumbnail — which is a genuine one, because it
 * holds a picture.
 *
 * Verifying is the point of the screen, so it is the only accented control;
 * rejecting and opening the file are plain text beside it.
 */

export type ReviewRow = {
  id: string;
  title: string;
  studentName: string;
  studentId: string;
  certLabel: string | null;
  kindLabel: string;
  uploadedLabel: string;
  sizeLabel: string;
  isImage: boolean;
  /// The progress the student has claimed, so the mentor can compare the
  /// certificate against what the platform reports.
  claimedProgressPct: number | null;
  selfReported: boolean;
};

export function ReviewCard({ row }: { row: ReviewRow }) {
  const router = useRouter();
  const { run } = useAbortable();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'VERIFIED' | 'REJECTED'>(null);
  const [error, setError] = useState<string | null>(null);
  const href = `/api/uploads/${row.id}`;

  /**
   * A verdict on a student's certificate is not something to send blind.
   *
   * This previously awaited the fetch without reading the response, so a 403 or
   * a 500 cleared the spinner, refreshed the list, and left the row exactly
   * where it was — the mentor believing the certificate was verified while the
   * student went on seeing "awaiting mentor check". A rejected promise was
   * worse: `busy` never cleared and both buttons stayed disabled until reload.
   */
  async function review(status: 'VERIFIED' | 'REJECTED') {
    if (busy) return;

    // A rejection the student cannot act on is a dead end — they are told to
    // upload something again with no idea what was wrong with the last one.
    if (status === 'REJECTED' && note.trim().length === 0) {
      setError('Say what is wrong with it — the student sees this note.');
      return;
    }

    setBusy(status);
    setError(null);

    const outcome = await run(async (signal) => {
      const res = await fetch(`${href}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ status, note }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          payload.error ?? `That did not save (${res.status}). Try again.`,
        );
      }
      return true;
    });

    if (outcome.status === 'error') {
      setError(outcome.error.message);
      setBusy(null);
      return;
    }
    if (outcome.status === 'cancelled') {
      setBusy(null);
      return;
    }

    // Stay busy: the refreshed queue removes this row entirely.
    router.refresh();
  }

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2.5}
      sx={{
        py: 3,
        borderTop: 1,
        borderColor: 'divider',
        '&:first-of-type': { borderTop: 0, pt: 0 },
      }}
    >
      <Box
        sx={{
          width: { xs: '100%', sm: 132 },
          height: { xs: 148, sm: 96 },
          flexShrink: 0,
          borderRadius: 1.5,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {row.isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={href}
            alt={row.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Typography variant="caption" color="text.disabled">
            PDF
          </Typography>
        )}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ justifyContent: 'space-between', alignItems: { sm: 'flex-start' } }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1">{row.studentName}</Typography>
            <Typography variant="body2" color="text.secondary">
              {row.certLabel ?? row.kindLabel}
            </Typography>
          </Box>
          <StatusChip tone="warning" label="Awaiting check" />
        </Stack>

        <Typography variant="caption" color="text.disabled" sx={{ mt: 0.75, display: 'block' }}>
          {row.title} · {row.sizeLabel} · uploaded {row.uploadedLabel}
        </Typography>

        {row.claimedProgressPct != null && (
          <Typography variant="body2" sx={{ mt: 1 }}>
            The platform reports{' '}
            <Box component="span" className="tabular">
              {row.claimedProgressPct.toFixed(0)}%
            </Box>{' '}
            complete
            {row.selfReported ? ' (self-reported)' : ' (provider-synced)'}.
          </Typography>
        )}

        <TextField
          fullWidth
          multiline
          minRows={1}
          placeholder="Note for the student — required if you reject it…"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (error) setError(null);
          }}
          sx={{ mt: 1.75, maxWidth: '64ch' }}
        />

        {error && (
          <Alert severity="error" role="alert" sx={{ mt: 1.5, maxWidth: '64ch' }}>
            {error}
          </Alert>
        )}

        <Stack direction="row" spacing={0.5} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            color="secondary"
            size="small"
            disabled={busy !== null}
            onClick={() => review('VERIFIED')}
          >
            {busy === 'VERIFIED' ? 'Verifying…' : 'Verify'}
          </Button>
          <Button
            size="small"
            disabled={busy !== null}
            onClick={() => review('REJECTED')}
            sx={{ color: 'text.secondary' }}
          >
            {busy === 'REJECTED' ? 'Rejecting…' : 'Reject'}
          </Button>
          <Button
            size="small"
            component="a"
            href={href}
            target="_blank"
            rel="noreferrer"
            sx={{ color: 'text.secondary' }}
          >
            Open file
          </Button>
        </Stack>
      </Box>
    </Stack>
  );
}
