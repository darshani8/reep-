'use client';

import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import type { UploadKind } from '@prisma/client';

const KINDS: { value: UploadKind; label: string; help: string; accept: string }[] = [
  {
    value: 'CERTIFICATE_PROOF',
    label: 'Certificate',
    help: 'The completion certificate from the provider. Your mentor checks it against your logged progress.',
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp',
  },
  {
    value: 'RESUME',
    label: 'Resume / CV',
    help: 'An existing CV. The Resume Builder reads it so you start from your own wording.',
    accept: '.pdf,.doc,.docx',
  },
  {
    value: 'PROFILE_PHOTO',
    label: 'Photo',
    help: 'A clear head-and-shoulders photo for your profile and resume header.',
    accept: '.png,.jpg,.jpeg,.webp',
  },
  {
    value: 'DOCUMENT',
    label: 'Document',
    help: 'Internship or organizational-study reports, ID proof, anything else your mentor asks for.',
    accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp',
  },
];

export function UploadPanel({
  certifications,
}: {
  certifications: { code: string; name: string; courseCode: string }[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<UploadKind>('CERTIFICATE_PROOF');
  const [certCode, setCertCode] = useState(certifications[0]?.code ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const active = KINDS.find((k) => k.value === kind)!;

  function choose(next: File | null) {
    setFile(next);
    setError(null);
    setDone(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) choose(dropped);
  }

  async function submit() {
    if (!file) {
      setError('Choose a file first.');
      return;
    }

    setBusy(true);
    setError(null);

    const body = new FormData();
    body.set('file', file);
    body.set('kind', kind);
    body.set('title', file.name);
    if (kind === 'CERTIFICATE_PROOF' && certCode) body.set('certCode', certCode);

    try {
      const res = await fetch('/api/uploads', { method: 'POST', body });
      const payload = (await res.json()) as { error?: string };

      if (!res.ok) {
        setError(payload.error ?? 'That upload did not go through.');
        return;
      }

      setDone(`${file.name} uploaded.`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.25 }}>
          What are you uploading?
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={kind}
          onChange={(_, next: UploadKind | null) => {
            if (next) {
              setKind(next);
              choose(null);
            }
          }}
          sx={{ flexWrap: 'wrap' }}
        >
          {KINDS.map((option) => (
            <ToggleButton key={option.value} value={option.value} sx={{ px: 2 }}>
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          {active.help}
        </Typography>
      </Box>

      {kind === 'CERTIFICATE_PROOF' && (
        <TextField
          select
          size="small"
          label="Which certification?"
          value={certCode}
          onChange={(e) => setCertCode(e.target.value)}
          helperText="Only the certifications you are enrolled on are listed."
          disabled={certifications.length === 0}
        >
          {certifications.map((cert) => (
            <MenuItem key={cert.code} value={cert.code}>
              {cert.courseCode} — {cert.name}
            </MenuItem>
          ))}
        </TextField>
      )}

      {/* Drop zone. Clicking it opens the picker, so it works without a mouse
          drag and on touch devices. */}
      <Box
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Choose a file to upload"
        sx={{
          border: 1,
          borderStyle: 'dashed',
          borderColor: dragging ? 'text.secondary' : 'divider',
          bgcolor: dragging ? 'action.hover' : 'background.paper',
          borderRadius: 2,
          p: { xs: 3, sm: 4.5 },
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'border-color 150ms, background-color 150ms',
          '&:hover': { borderColor: 'text.disabled' },
        }}
      >
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={active.accept}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />

        {file ? (
          <Stack spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle1">{file.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {(file.size / 1024).toFixed(0)} KB · click to choose a different file
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle1">Drag a file here, or click to browse</Typography>
            <Typography variant="caption" color="text.secondary">
              {active.accept.replaceAll('.', '').replaceAll(',', ', ').toUpperCase()} · up to 10 MB
            </Typography>
          </Stack>
        )}
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {done && <Alert severity="success">{done}</Alert>}

      <Stack direction="row" spacing={1.5}>
        <Button
          variant="contained"
          color="secondary"
          onClick={submit}
          disabled={!file || busy}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
        {file && !busy && (
          <Button
            onClick={() => {
              choose(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
          >
            Clear
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
