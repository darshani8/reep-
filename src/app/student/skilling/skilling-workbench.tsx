'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SearchRounded from '@mui/icons-material/SearchRounded';

import { EmptyState, StatusChip, Surface } from '@/components/kit';
import type { Tone } from '@/components/tone';
import { useAbortable } from '@/lib/use-abortable';

/**
 * The interactive half of `/student/skilling`: claim a skill, browse the rest.
 *
 * The two halves are one component rather than two because they share a single
 * piece of state — which skill is selected. A student browsing the catalogue and
 * finding "Power BI" should be able to press Claim and have the upload form
 * already pointed at it; splitting the file would mean either lifting that
 * state into a third component or routing the intent through the URL, and both
 * cost more than the file is worth.
 *
 * The row types are declared here rather than imported from
 * `@/lib/skills/queries`, which carries `server-only`. They are the same shape,
 * checked at the call site in `page.tsx`; importing them across that boundary —
 * even type-only — puts a server module's specifier in the client graph, and
 * this codebase has one hard rule about that specifier.
 */

/// A catalogue skill as this screen needs it. Mirrors `CatalogueEntry`.
export type CatalogueRow = {
  slug: string;
  name: string;
  category: string;
  holding: { level: number; levelLabel: string; verified: boolean } | null;
  claimStatus: 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | null;
  demandCount: number;
};

export type ClaimableSkill = { slug: string; name: string; category: string };

/// Mirrors `SKILL_LEVELS` in `@/lib/skills/claim-rules`, for the same reason the
/// row types are mirrored. The server clamps whatever this posts, so the two
/// drifting apart is a wording bug, never a data one.
const LEVELS = [
  { value: 1, label: 'Aware — I know what it is' },
  { value: 2, label: 'Beginner — I followed a course module' },
  { value: 3, label: 'Working — I use it on coursework unaided' },
  { value: 4, label: 'Proficient — I can explain it to others' },
  { value: 5, label: 'Expert — I applied it on a real project' },
];

const ACCEPT = '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp';

const ALL_CATEGORIES = 'All categories';

export function SkillingWorkbench({
  catalogue,
  claimable,
}: {
  catalogue: CatalogueRow[];
  claimable: ClaimableSkill[];
}) {
  const router = useRouter();
  const { run } = useAbortable();
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const [slug, setSlug] = useState(claimable[0]?.slug ?? '');
  const [level, setLevel] = useState(3);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL_CATEGORIES);

  const categories = useMemo(
    () => [ALL_CATEGORIES, ...new Set(catalogue.map((row) => row.category))],
    [catalogue],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalogue.filter((row) => {
      if (category !== ALL_CATEGORIES && row.category !== category) return false;
      if (!needle) return true;
      // Slug as well as name, because a student who saw `power-bi` on the jobs
      // board should be able to paste it in and find the skill.
      return (
        row.name.toLowerCase().includes(needle) || row.slug.toLowerCase().includes(needle)
      );
    });
  }, [catalogue, category, query]);

  /// Pressing Claim in the list points the form at that skill and brings the
  /// form into view — on a phone the two are stacked, so without the scroll the
  /// button appears to do nothing.
  function pick(next: string) {
    setSlug(next);
    setError(null);
    setDone(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

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
    if (!slug) {
      setError('Choose which skill the certificate proves.');
      return;
    }
    if (!file) {
      setError('Attach the certificate first.');
      return;
    }

    setBusy(true);
    setError(null);

    const body = new FormData();
    body.set('file', file);
    body.set('skillSlug', slug);
    body.set('level', String(level));

    const outcome = await run(async (signal) => {
      const res = await fetch('/api/skills/claims', { method: 'POST', body, signal });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? 'That claim did not go through.');
      return true;
    });

    setBusy(false);
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'error') {
      setError(outcome.error.message);
      return;
    }

    const claimed = catalogue.find((row) => row.slug === slug);
    setDone(
      `${claimed?.name ?? 'That skill'} is now with your mentor. It stays unverified until they have looked at the certificate.`,
    );
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
    router.refresh();
  }

  return (
    <Stack direction={{ xs: 'column', lg: 'row' }} spacing={{ xs: 5, lg: 6 }}>
      {/* --- claim form ---------------------------------------------------- */}
      <Box ref={formRef} sx={{ flex: { lg: '0 0 22rem' }, minWidth: 0 }}>
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary">
            A certificate is the evidence; your mentor is the one who turns it into a verified
            badge. Nothing you upload counts until they have.
          </Typography>

          <TextField
            select
            size="small"
            label="Which skill does this prove?"
            value={slug}
            onChange={(event) => pick(event.target.value)}
            disabled={claimable.length === 0}
            helperText={
              claimable.length === 0
                ? 'Every catalogue skill is either verified or already with your mentor.'
                : `${claimable.length} skills you can still claim`
            }
          >
            {claimable.map((skill) => (
              <MenuItem key={skill.slug} value={skill.slug}>
                {skill.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            label="How well do you know it?"
            value={level}
            onChange={(event) => setLevel(Number(event.target.value))}
            helperText="Your mentor can grant a lower level than you claim."
          >
            {LEVELS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>

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
            aria-label="Choose a certificate to upload"
            sx={{
              border: 1,
              borderStyle: 'dashed',
              borderColor: dragging ? 'text.secondary' : 'divider',
              bgcolor: dragging ? 'action.hover' : 'background.paper',
              borderRadius: 2,
              p: 3,
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
              accept={ACCEPT}
              onChange={(event) => choose(event.target.files?.[0] ?? null)}
            />
            {file ? (
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle2" sx={{ wordBreak: 'break-all' }}>
                  {file.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {(file.size / 1024).toFixed(0)} KB · click to choose another
                </Typography>
              </Stack>
            ) : (
              <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle2">Drop the certificate here</Typography>
                <Typography variant="caption" color="text.secondary">
                  PDF, Word or an image · up to 10 MB
                </Typography>
              </Stack>
            )}
          </Box>

          {error && (
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          )}
          {done && <Alert severity="success">{done}</Alert>}

          <Stack direction="row" spacing={1.5}>
            <Button
              variant="contained"
              color="secondary"
              onClick={submit}
              disabled={busy || !file || !slug}
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {busy ? 'Sending…' : 'Claim this skill'}
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

          <Surface sx={{ p: 2 }}>
            <Typography variant="caption" color="text.secondary">
              The file lands in the same queue as every other certificate, at{' '}
              <Box component="span" sx={{ fontWeight: 600 }}>
                Uploads
              </Box>
              . Delete it there and the claim goes with it.
            </Typography>
          </Surface>
        </Stack>
      </Box>

      {/* --- catalogue ------------------------------------------------------ */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2.5 }}>
          <TextField
            size="small"
            placeholder="Search skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            sx={{ flex: 1 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded fontSize="small" sx={{ color: 'text.disabled' }} />
                  </InputAdornment>
                ),
              },
            }}
          />
          <TextField
            select
            size="small"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            sx={{ minWidth: { sm: 220 } }}
          >
            {categories.map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
        </Stack>

        {filtered.length === 0 ? (
          <EmptyState
            title="No skill matches that."
            hint="Try the slug the jobs board uses — power-bi, financial-modelling — or clear the category filter."
          />
        ) : (
          <Box>
            {filtered.map((row) => (
              <CatalogueRowView
                key={row.slug}
                row={row}
                selected={row.slug === slug}
                onClaim={() => pick(row.slug)}
              />
            ))}
          </Box>
        )}
      </Box>
    </Stack>
  );
}

/// The standing of one catalogue skill, in the words the student needs. There
/// is no "verified" state a student can reach on their own, which is the point
/// the wording has to keep making.
function standing(row: CatalogueRow): { label: string; tone: Tone } | null {
  if (row.holding?.verified) return { label: 'Verified', tone: 'good' };
  if (row.claimStatus === 'PENDING_REVIEW') {
    return { label: 'Awaiting verification', tone: 'warning' };
  }
  if (row.holding) return { label: `Self-declared · ${row.holding.levelLabel}`, tone: 'neutral' };
  return null;
}

function CatalogueRowView({
  row,
  selected,
  onClaim,
}: {
  row: CatalogueRow;
  selected: boolean;
  onClaim: () => void;
}) {
  const state = standing(row);
  const claimable = !row.holding?.verified && row.claimStatus === null;

  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{
        py: 1.5,
        px: 1,
        mx: -1,
        alignItems: 'center',
        borderTop: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: selected ? 'action.hover' : 'transparent',
        '&:first-of-type': { borderTop: 0 },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap title={row.name}>
          {row.name}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {row.category}
          {row.demandCount > 0
            ? ` · ${row.demandCount} open posting${row.demandCount === 1 ? '' : 's'} ask${
                row.demandCount === 1 ? 's' : ''
              } for it`
            : ''}
        </Typography>
      </Box>

      {state && <StatusChip tone={state.tone} label={state.label} variant="outlined" />}

      {claimable && (
        <Button size="small" onClick={onClaim} sx={{ flexShrink: 0 }}>
          {selected ? 'Selected' : 'Claim'}
        </Button>
      )}
    </Stack>
  );
}
