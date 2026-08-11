'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';

type ScanSummary = {
  scanned: number;
  opened: number;
  reopened: number;
  autoResolved: number;
};

/// Posts to the scan endpoint, then refreshes the server component tree so the
/// queue below reflects the new state without a full page load. The result is
/// reported in plain words rather than as raw counts.
export function RescanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/alerts/scan', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const scan = (await res.json()) as ScanSummary;
      setResult({ ok: true, text: describe(scan) });
      router.refresh();
    } catch (error) {
      setResult({
        ok: false,
        text: error instanceof Error ? `The scan failed — ${error.message}` : 'The scan failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="contained"
        color="secondary"
        onClick={run}
        disabled={busy}
        startIcon={busy ? <CircularProgress size={15} color="inherit" /> : undefined}
      >
        {busy ? 'Checking…' : 'Check for new alerts'}
      </Button>

      <Snackbar
        open={result != null}
        autoHideDuration={7000}
        onClose={() => setResult(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={result?.ok ? 'success' : 'error'}
          onClose={() => setResult(null)}
          sx={{ mb: 0 }}
        >
          {result?.text}
        </Alert>
      </Snackbar>
    </>
  );
}

function describe(scan: ScanSummary): string {
  const parts: string[] = [];
  if (scan.opened > 0) parts.push(`${scan.opened} new`);
  if (scan.autoResolved > 0) parts.push(`${scan.autoResolved} closed automatically`);
  if (scan.reopened > 0) parts.push(`${scan.reopened} still firing`);

  const tail = parts.length > 0 ? parts.join(', ') : 'nothing changed';
  return `Checked ${scan.scanned} student${scan.scanned === 1 ? '' : 's'} — ${tail}.`;
}
