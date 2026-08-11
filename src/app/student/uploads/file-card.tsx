'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import PictureAsPdfOutlined from '@mui/icons-material/PictureAsPdfOutlined';

import Alert from '@mui/material/Alert';

import { StatusChip, type Tone } from '@/components/kit';
import { useAbortable } from '@/lib/use-abortable';

export type FileCardRow = {
  id: string;
  title: string;
  kindLabel: string;
  status: 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED';
  mimeType: string;
  sizeLabel: string;
  uploadedLabel: string;
  certName: string | null;
  reviewNote: string | null;
  isImage: boolean;
};

const STATUS_TONE: Record<FileCardRow['status'], Tone> = {
  PENDING_REVIEW: 'warning',
  VERIFIED: 'good',
  REJECTED: 'critical',
};

const STATUS_LABEL: Record<FileCardRow['status'], string> = {
  PENDING_REVIEW: 'Awaiting mentor check',
  VERIFIED: 'Verified',
  REJECTED: 'Needs another upload',
};

/**
 * One uploaded file, as a row rather than a tile.
 *
 * A grid of thumbnails spends most of its area on chrome; what a student
 * actually scans for is the name, whether the mentor has looked at it, and what
 * the mentor said. Those read fastest in a line. The thumbnail shrinks to an
 * identifying square and keeps its job.
 */
export function FileCard({ row }: { row: FileCardRow }) {
  const router = useRouter();
  const { run } = useAbortable();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = `/api/uploads/${row.id}`;

  /**
   * The confirmation dialog in front of this is good; what followed it was not.
   *
   * The response was never read, so a refused delete closed the dialog and
   * refreshed the list with the file still on it and nothing said — the student
   * concludes the screen is stale and deletes again. A rejected promise left
   * `busy` true forever, disabling that row's Delete button until reload.
   * A failure now keeps the dialog open and says why.
   */
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);

    const outcome = await run(async (signal) => {
      const res = await fetch(href, { method: 'DELETE', signal });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          payload.error ?? `That could not be deleted (${res.status}).`,
        );
      }
      return true;
    });

    if (outcome.status === 'error') {
      setError(outcome.error.message);
      setBusy(false);
      return;
    }
    if (outcome.status === 'cancelled') {
      setBusy(false);
      return;
    }

    setConfirming(false);
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <Stack
        direction="row"
        spacing={2}
        sx={{
          py: 2,
          alignItems: 'flex-start',
          borderTop: 1,
          borderColor: 'divider',
          '&:first-of-type': { borderTop: 0, pt: 0 },
        }}
      >
        <Box
          sx={{
            width: 48,
            height: 48,
            flexShrink: 0,
            borderRadius: 1.5,
            overflow: 'hidden',
            bgcolor: 'action.hover',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
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
            <PictureAsPdfOutlined sx={{ fontSize: 20, color: 'text.disabled' }} />
          )}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap title={row.title}>
            {row.title}
          </Typography>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {row.kindLabel} · {row.sizeLabel} · {row.uploadedLabel}
            {row.certName ? ` · for ${row.certName}` : ''}
          </Typography>

          <Box sx={{ mt: 1 }}>
            <StatusChip tone={STATUS_TONE[row.status]} label={STATUS_LABEL[row.status]} />
          </Box>

          {row.reviewNote && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Your mentor said: “{row.reviewNote}”
            </Typography>
          )}
        </Box>

        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }} className="no-print">
          <Tooltip title="Open file">
            <IconButton
              size="small"
              component="a"
              href={href}
              target="_blank"
              rel="noreferrer"
              sx={{ color: 'text.disabled' }}
            >
              <OpenInNewRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton
              size="small"
              onClick={() => setConfirming(true)}
              sx={{ color: 'text.disabled' }}
            >
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Dialog
        open={confirming}
        onClose={() => {
          if (busy) return;
          setConfirming(false);
          setError(null);
        }}
      >
        <DialogTitle>Delete this file?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {row.title} will be removed permanently. If your mentor has already verified it,
            you will need to upload it again.
          </DialogContentText>
          {error && (
            <Alert severity="error" role="alert" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Keep it</Button>
          <Button color="error" onClick={remove} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
