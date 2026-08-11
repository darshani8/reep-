'use client';

import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';

import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import AutorenewRounded from '@mui/icons-material/AutorenewRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DoneRounded from '@mui/icons-material/DoneRounded';
import PrintRounded from '@mui/icons-material/PrintRounded';

/// Everything that is not the resume itself carries `no-print`, so this really
/// is "print the document" rather than "print the screen".
export function PrintButton() {
  return (
    <Button
      variant="contained"
      color="secondary"
      startIcon={<PrintRounded />}
      onClick={() => window.print()}
    >
      Print / Save as PDF
    </Button>
  );
}

export function CopyMarkdownButton({
  markdown,
  label = 'Copy markdown',
}: {
  markdown: string;
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Drop the confirmation after a moment without leaking a timer if the button
  // unmounts first.
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <Button
      variant="outlined"
      onClick={copy}
      startIcon={state === 'copied' ? <DoneRounded /> : <ContentCopyRounded />}
      color={state === 'copied' ? 'success' : 'primary'}
    >
      {state === 'copied'
        ? 'Copied'
        : state === 'failed'
          ? 'Select it and copy manually'
          : label}
    </Button>
  );
}

/// Lives inside the regenerate <form>, so useFormStatus reports that form's
/// submission — the server action re-reads REEP and files a new version.
export function RegenerateButton() {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="outlined"
      disabled={pending}
      startIcon={
        pending ? <CircularProgress size={16} color="inherit" /> : <AutorenewRounded />
      }
    >
      {pending ? 'Rewriting…' : 'Regenerate'}
    </Button>
  );
}
