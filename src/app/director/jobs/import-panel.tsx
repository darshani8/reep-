'use client';

import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { GridColDef } from '@mui/x-data-grid';

import { StatusChip, type Tone } from '@/components/kit';
import { ReepGrid } from '@/components/reep-grid';

import type { ImportPreview, ImportPreviewRow } from '@/lib/jobs/preview';

/**
 * Upload, look, then commit.
 *
 * The dry run is not a courtesy. A weekly sheet is typed by hand and the person
 * uploading it is the one person who can tell "42 new vacancies" from "42 new
 * vacancies because the reference column shifted and nothing matched" — but
 * only if they are shown the two numbers before anything is written. So the
 * commit button is disabled until a preview has been read, and it says how many
 * rows it will create and how many it will overwrite.
 *
 * The same file object is posted both times. Nothing parsed in the browser is
 * sent back to the server to be trusted; see the route handler for why.
 */

const DISPOSITION_TONE: Record<ImportPreviewRow['disposition'], Tone> = {
  create: 'good',
  update: 'info',
  unchanged: 'neutral',
};

const DISPOSITION_LABEL: Record<ImportPreviewRow['disposition'], string> = {
  create: 'New',
  update: 'Updated',
  unchanged: 'No change',
};

/// The header row the parser understands, offered as a starting point so the
/// placement cell does not have to guess the column names.
const TEMPLATE_CSV = [
  'Ref,Job Title,Company,Degree Level,Location,Apply Link,Description,Skills,Posted On,Closing Date',
  'REEP-2026-W32-001,Business Analyst,Wipro,PG,Bengaluru,https://careers.example.com/ba,"Dashboards for the operations desk.","SQL, MS Excel",2026-08-05,2026-08-30',
  'REEP-2026-W32-002,Accounts Assistant,EY,UG,Bengaluru,https://careers.example.com/aa,"Ledgers and reconciliations.","Tally, Excel",2026-08-05,2026-08-24',
].join('\r\n');

export function ImportPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [done, setDone] = useState<ImportPreview | null>(null);

  function choose(next: File | null) {
    setFile(next);
    setPreview(null);
    setDone(null);
    setError(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) choose(dropped);
  }

  async function send(mode: 'preview' | 'commit') {
    if (!file) {
      setError('Choose a sheet first.');
      return;
    }

    setBusy(mode);
    setError(null);

    const body = new FormData();
    body.set('file', file);
    body.set('mode', mode);

    try {
      const res = await fetch('/api/jobs/import', { method: 'POST', body });
      const payload = (await res.json().catch(() => ({}))) as ImportPreview & { error?: string };

      if (!res.ok) {
        setError(payload.error ?? 'That sheet could not be read.');
        return;
      }

      if (mode === 'commit') {
        setDone(payload);
        setPreview(null);
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
        // The board and the run history both change; the server component above
        // re-reads them.
        router.refresh();
      } else {
        setPreview(payload);
      }
    } catch {
      setError('Could not reach the server. Nothing was imported.');
    } finally {
      setBusy(null);
    }
  }

  function downloadTemplate() {
    const blob = new Blob([`﻿${TEMPLATE_CSV}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reep-jobs-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const columns: GridColDef[] = [
    {
      field: 'rowNumber',
      headerName: 'Row',
      width: 74,
    },
    {
      field: 'disposition',
      headerName: 'Effect',
      width: 118,
      renderCell: (params) => {
        const row = params.row as ImportPreviewRow;
        return (
          <StatusChip
            tone={DISPOSITION_TONE[row.disposition]}
            label={DISPOSITION_LABEL[row.disposition]}
          />
        );
      },
    },
    {
      field: 'title',
      headerName: 'Role',
      flex: 1,
      minWidth: 220,
      renderCell: (params) => {
        const row = params.row as ImportPreviewRow;
        return (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
              {row.title}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="div" noWrap>
              {row.company}
              {row.location ? ` · ${row.location}` : ''}
            </Typography>
          </Box>
        );
      },
    },
    { field: 'degreeLevel', headerName: 'Level', width: 84 },
    {
      field: 'skillsLabel',
      headerName: 'Skills',
      flex: 1,
      minWidth: 180,
      renderCell: (params) => {
        const row = params.row as ImportPreviewRow;
        return (
          <Typography variant="caption" color="text.secondary" noWrap>
            {row.skillsLabel || '—'}
          </Typography>
        );
      },
    },
    { field: 'closesLabel', headerName: 'Closes', width: 128 },
    {
      field: 'changesLabel',
      headerName: 'What changes',
      width: 180,
      renderCell: (params) => {
        const row = params.row as ImportPreviewRow;
        return (
          <Typography variant="caption" color="text.secondary" noWrap>
            {row.changesLabel || (row.disposition === 'create' ? 'Everything — new row' : '—')}
          </Typography>
        );
      },
    },
  ];

  return (
    <Stack spacing={3}>
      <Box
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Choose the weekly jobs sheet"
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
          accept=".xlsx,.csv"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />

        {file ? (
          <Stack spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle1">{file.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {(file.size / 1024).toFixed(0)} KB · click to choose a different sheet
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={0.75} sx={{ alignItems: 'center' }}>
            <Typography variant="subtitle1">
              Drag this week&apos;s sheet here, or click to browse
            </Typography>
            <Typography variant="caption" color="text.secondary">
              XLSX or CSV · up to 5 MB · nothing is written until you have read the preview
            </Typography>
          </Stack>
        )}
      </Box>

      {error && (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1.5 }}>
        <Button
          variant="contained"
          color="secondary"
          onClick={() => send('preview')}
          disabled={!file || busy != null}
          startIcon={busy === 'preview' ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {busy === 'preview' ? 'Reading the sheet…' : 'Check the sheet'}
        </Button>

        <Button
          variant="outlined"
          onClick={() => send('commit')}
          // Deliberately unreachable until a preview has been read: an import
          // nobody looked at is how a shifted column silently doubles the board.
          disabled={!preview || busy != null || preview.rows.length === 0}
          startIcon={busy === 'commit' ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {preview
            ? `Import ${preview.counts.create} new and ${preview.counts.update} changed`
            : 'Import'}
        </Button>

        <Box sx={{ flex: 1 }} />

        <Button size="small" onClick={downloadTemplate}>
          Download the column template
        </Button>
      </Stack>

      {done && (
        <Alert severity="success">
          <AlertTitle sx={{ fontWeight: 600, fontSize: '0.875rem' }}>
            {done.fileName} imported
          </AlertTitle>
          {done.committed?.created ?? 0} vacancies added, {done.committed?.updated ?? 0} updated,
          and {done.counts.unchanged} already on the board and left alone.
          {done.errors.length > 0
            ? ` ${done.errors.length} rows were skipped — they are listed below.`
            : ' Every row imported.'}
        </Alert>
      )}

      {(preview ?? done) && (
        <ReportBody report={(preview ?? done)!} columns={columns} committed={preview == null} />
      )}
    </Stack>
  );
}

function ReportBody({
  report,
  columns,
  committed,
}: {
  report: ImportPreview;
  columns: GridColDef[];
  committed: boolean;
}) {
  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Chip size="small" label={`${report.rowsSeen} rows read`} variant="outlined" />
        <Chip
          size="small"
          color="success"
          variant="outlined"
          label={`${report.counts.create} new`}
        />
        <Chip size="small" color="info" variant="outlined" label={`${report.counts.update} changed`} />
        <Chip size="small" variant="outlined" label={`${report.counts.unchanged} unchanged`} />
        {report.errors.length > 0 && (
          <Chip
            size="small"
            color="error"
            variant="outlined"
            label={`${report.errors.length} skipped`}
          />
        )}
      </Stack>

      {report.errors.length > 0 && (
        <Alert severity="warning">
          <AlertTitle sx={{ fontWeight: 600, fontSize: '0.875rem' }}>
            {report.errors.length} rows {committed ? 'were not imported' : 'will be skipped'}
          </AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {report.errors.map((issue) => (
              <li key={`${issue.row}-${issue.column}`}>
                <Typography variant="body2" component="span">
                  Row {issue.row} · {issue.column} — {issue.message}
                </Typography>
              </li>
            ))}
          </Box>
        </Alert>
      )}

      {report.warnings.length > 0 && (
        <Alert severity="info">
          <AlertTitle sx={{ fontWeight: 600, fontSize: '0.875rem' }}>
            {report.warnings.length} rows imported with something worth knowing
          </AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {report.warnings.map((issue) => (
              <li key={`${issue.row}-${issue.column}-${issue.message}`}>
                <Typography variant="body2" component="span">
                  Row {issue.row} · {issue.column} — {issue.message}
                </Typography>
              </li>
            ))}
          </Box>
        </Alert>
      )}

      {report.rows.length === 0 ? (
        <Alert severity="warning">
          No job rows were found in that sheet. The header row must name at least a job
          title, a company and a degree level.
        </Alert>
      ) : (
        <ReepGrid
          rows={report.rows}
          columns={columns}
          searchKeys={['title', 'company', 'skillsLabel']}
          searchPlaceholder="Search the sheet…"
          quickFilters={[
            { label: 'New', test: (row) => row.disposition === 'create' },
            { label: 'Changed', test: (row) => row.disposition === 'update' },
            { label: 'Unchanged', test: (row) => row.disposition === 'unchanged' },
          ]}
          pageSize={25}
          emptyLabel="Nothing in this sheet matches that."
        />
      )}
    </Stack>
  );
}
