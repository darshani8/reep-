'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import SyncRounded from '@mui/icons-material/SyncRounded';

type SyncResult = {
  ok: boolean;
  error?: string;
  provider?: string;
  total?: number;
  changed?: number;
  pointsGained?: number;
};

/**
 * Pulls the student's certification progress from the provider adapter on
 * demand.
 *
 * In production the same work runs nightly across the cohort; this button
 * exists so a student who has just finished a module can see it reflected
 * immediately rather than waiting for the batch.
 */
export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  async function sync() {
    setBusy(true);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const payload = (await res.json()) as SyncResult;
      setResult(res.ok ? payload : { ok: false, error: payload.error ?? 'Sync failed.' });
      if (res.ok) router.refresh();
    } catch {
      setResult({ ok: false, error: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        onClick={sync}
        disabled={busy}
        variant="contained"
        color="secondary"
        startIcon={
          busy ? <CircularProgress size={16} color="inherit" /> : <SyncRounded />
        }
      >
        {busy ? 'Syncing…' : 'Sync progress'}
      </Button>

      <Snackbar
        open={result !== null}
        autoHideDuration={6000}
        onClose={() => setResult(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={result?.ok ? 'success' : 'error'}
          onClose={() => setResult(null)}
          variant="filled"
        >
          {result?.ok
            ? result.changed === 0
              ? `Checked ${result.total} certifications with ${result.provider} — nothing new since the last sync.`
              : `Updated ${result.changed} of ${result.total} certifications (+${result.pointsGained}% progress).`
            : (result?.error ?? 'Sync failed.')}
        </Alert>
      </Snackbar>
    </>
  );
}
