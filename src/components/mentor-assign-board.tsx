'use client';

import { useMemo, useState, useTransition } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CasinoOutlined from '@mui/icons-material/CasinoOutlined';
import SearchRounded from '@mui/icons-material/SearchRounded';
import {
  DataGrid,
  type GridColDef,
  type GridRowId,
  type GridRowSelectionModel,
} from '@mui/x-data-grid';

import { MeterCell } from '@/components/director-cells';
import { Surface } from '@/components/kit';
import {
  assignStudents,
  balanceStudents,
  type AssignResult,
} from '@/app/director/mentors/actions';

/**
 * The mentor-assignment board.
 *
 * Everything on this screen is one gesture split in three: narrow the list,
 * pick people out of it, then send them somewhere. So the filters, the
 * selection tools and the assign controls share one panel above the grid, and
 * the count of what is selected never leaves the screen — it is the only piece
 * of state a director can get wrong.
 *
 * The grid is MUI's `DataGrid` rather than the shared `ReepGrid`, because this
 * is the one screen in the product that needs a controlled selection model, and
 * lifting that into the shared component would put a prop on sixteen grids that
 * only one of them uses.
 */

export type AssignStudentRow = {
  id: string;
  name: string;
  usn: string;
  cohortId: string;
  cohortCode: string;
  /// "Excel · Sem 2" — already spelled out server-side.
  stageLabel: string;
  mentorId: string | null;
  /// The mentor's display name, or "Unassigned".
  mentorName: string;
  overallPct: number;
  /// Sorts honestly; the label is what the cell prints.
  idleDays: number;
  lastActiveLabel: string;
};

export type AssignMentorOption = {
  id: string;
  /// "Prof. Anita Desai"
  name: string;
  group: string;
  menteeCount: number;
};

export type AssignCohortOption = { id: string; code: string };

/// Sentinel for the mentor filter — a real empty `mentorId` is null, which a
/// `<Select>` value cannot be without going uncontrolled.
const UNASSIGNED = '__unassigned__';

export function MentorAssignBoard({
  rows,
  mentors,
  cohorts,
}: {
  rows: AssignStudentRow[];
  mentors: AssignMentorOption[];
  cohorts: AssignCohortOption[];
}) {
  const [query, setQuery] = useState('');
  const [cohortFilter, setCohortFilter] = useState('');
  const [mentorFilter, setMentorFilter] = useState('');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [randomN, setRandomN] = useState('10');

  const [targetMentor, setTargetMentor] = useState('');
  const [balanceIds, setBalanceIds] = useState<string[]>([]);

  const [result, setResult] = useState<AssignResult | null>(null);
  const [confirmingUnassign, setConfirmingUnassign] = useState(false);
  const [pending, startTransition] = useTransition();

  // --- what the grid is showing --------------------------------------------

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (cohortFilter && row.cohortId !== cohortFilter) return false;
      if (mentorFilter === UNASSIGNED && row.mentorId !== null) return false;
      if (mentorFilter && mentorFilter !== UNASSIGNED && row.mentorId !== mentorFilter) {
        return false;
      }
      if (needle) {
        return (
          row.name.toLowerCase().includes(needle) || row.usn.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [rows, query, cohortFilter, mentorFilter]);

  // --- selection ------------------------------------------------------------

  /// Selected ids in roster order, so the round-robin the server runs deals the
  /// same students to the same mentors as the preview counted.
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedIds = useMemo(() => selectedRows.map((r) => r.id), [selectedRows]);
  const count = selectedIds.length;

  /// Selected but not currently on screen. A selection deliberately survives a
  /// filter change, which means the button's count can exceed what the director
  /// can actually see — worth saying out loud before a bulk write.
  const hiddenSelected = useMemo(
    () => count - filtered.filter((row) => selected.has(row.id)).length,
    [count, filtered, selected],
  );

  const selectionModel = useMemo<GridRowSelectionModel>(
    () => ({ type: 'include', ids: new Set<GridRowId>(selected) }),
    [selected],
  );

  function replaceSelection(next: ReadonlySet<string>) {
    setSelected(next);
    // A stale "Moved 8 students" under a fresh selection reads as a fresh result.
    setResult(null);
  }

  function handleSelectionChange(model: GridRowSelectionModel) {
    if (model.type === 'include') {
      replaceSelection(new Set(Array.from(model.ids, String)));
      return;
    }
    // The header checkbox emits an *exclude* model meaning "everything in the
    // grid except these". Fold it back into an explicit set so selections made
    // under a different filter survive.
    const next = new Set(selected);
    for (const row of filtered) {
      if (model.ids.has(row.id)) next.delete(row.id);
      else next.add(row.id);
    }
    replaceSelection(next);
  }

  function selectAllFiltered() {
    const next = new Set(selected);
    for (const row of filtered) next.add(row.id);
    replaceSelection(next);
  }

  /**
   * N students at random out of what is currently filtered.
   *
   * Fisher–Yates on a copy, unseeded: this is a way of grabbing an arbitrary
   * group to move, not a sample anyone needs to reproduce.
   */
  function pickRandom() {
    const wanted = Math.max(0, Math.min(filtered.length, Math.floor(Number(randomN) || 0)));
    const pool = filtered.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    replaceSelection(new Set(pool.slice(0, wanted).map((r) => r.id)));
  }

  // --- previews -------------------------------------------------------------

  /// How many of the selected students each mentor is about to lose.
  const losingByMentor = useMemo(() => {
    const out = new Map<string, number>();
    for (const row of selectedRows) {
      if (row.mentorId) out.set(row.mentorId, (out.get(row.mentorId) ?? 0) + 1);
    }
    return out;
  }, [selectedRows]);

  const assignPreview = useMemo(() => {
    if (!targetMentor || count === 0) return null;
    const mentor = mentors.find((m) => m.id === targetMentor);
    if (!mentor) return null;
    const after = mentor.menteeCount - (losingByMentor.get(mentor.id) ?? 0) + count;
    return { name: mentor.name, before: mentor.menteeCount, after };
  }, [targetMentor, count, mentors, losingByMentor]);

  /**
   * The round-robin split, before it happens. Student *i* goes to mentor
   * *i % mentors*, which the server repeats exactly — so these numbers are a
   * promise, not an estimate.
   */
  const balancePreview = useMemo(() => {
    if (balanceIds.length === 0 || count === 0) return null;
    const per = Math.floor(count / balanceIds.length);
    const remainder = count % balanceIds.length;

    const gaining = new Map<string, number>();
    balanceIds.forEach((id, i) => gaining.set(id, per + (i < remainder ? 1 : 0)));

    return mentors
      .filter((m) => gaining.has(m.id) || losingByMentor.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        before: m.menteeCount,
        after: m.menteeCount - (losingByMentor.get(m.id) ?? 0) + (gaining.get(m.id) ?? 0),
      }));
  }, [balanceIds, count, mentors, losingByMentor]);

  // --- writes ---------------------------------------------------------------

  function run(action: () => Promise<AssignResult>) {
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      // A finished move is not still pending review — drop the selection so the
      // next action starts from a clean slate rather than repeating this one.
      if (!outcome.error) setSelected(new Set());
    });
  }

  const busy = pending || count === 0;

  // --- columns --------------------------------------------------------------

  const columns: GridColDef[] = [
    { field: 'name', headerName: 'Student', flex: 1.3, minWidth: 190 },
    { field: 'usn', headerName: 'USN', width: 150, cellClassName: 'tabular' },
    { field: 'cohortCode', headerName: 'Cohort', width: 130 },
    { field: 'stageLabel', headerName: 'Stage', width: 160 },
    {
      field: 'mentorName',
      headerName: 'Current mentor',
      width: 200,
      display: 'flex',
      renderCell: (params) => (
        <Typography
          variant="body2"
          noWrap
          color={params.row.mentorId ? 'text.primary' : 'text.disabled'}
        >
          {params.row.mentorName}
        </Typography>
      ),
    },
    {
      field: 'overallPct',
      headerName: 'Overall',
      width: 160,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      display: 'flex',
      renderCell: (params) => <MeterCell value={Number(params.value)} />,
    },
    {
      field: 'idleDays',
      headerName: 'Last active',
      width: 130,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      valueFormatter: (_value, row) => row.lastActiveLabel,
    },
  ];

  // --------------------------------------------------------------------------

  return (
    <Box>
      {/* --- narrow the list ------------------------------------------------ */}
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        useFlexGap
        sx={{ mb: 2.5, alignItems: { md: 'center' }, flexWrap: 'wrap' }}
      >
        <TextField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or USN…"
          // See reep-grid: the placeholder names nothing for a screen reader.
          sx={{ minWidth: { md: 260 } }}
          slotProps={{
            htmlInput: { 'aria-label': 'Search students by name or USN' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <TextField
          select
          label="Cohort"
          value={cohortFilter}
          onChange={(e) => setCohortFilter(e.target.value)}
          sx={{ minWidth: 180 }}
          // "All cohorts" is a real choice with an empty value, so the label has
          // to float out of its way rather than waiting to be filled.
          slotProps={{ inputLabel: { shrink: true } }}
        >
          <MenuItem value="">All cohorts</MenuItem>
          {cohorts.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.code}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Mentor"
          value={mentorFilter}
          onChange={(e) => setMentorFilter(e.target.value)}
          sx={{ minWidth: 230 }}
          slotProps={{ inputLabel: { shrink: true } }}
        >
          <MenuItem value="">All mentors</MenuItem>
          <MenuItem value={UNASSIGNED}>Unassigned</MenuItem>
          {mentors.map((m) => (
            <MenuItem key={m.id} value={m.id}>
              {m.name}
            </MenuItem>
          ))}
        </TextField>

        <Box sx={{ flex: 1 }} />

        <Typography variant="caption" color="text.secondary" className="tabular">
          {filtered.length} of {rows.length} students
        </Typography>
      </Stack>

      {/* --- select, then send ---------------------------------------------- */}
      <Surface sx={{ mb: 3 }}>
        <Stack spacing={2.25} divider={<Divider />}>
          {/* selection tools */}
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            useFlexGap
            sx={{ alignItems: { md: 'center' }, flexWrap: 'wrap' }}
          >
            <Typography
              className="tabular"
              sx={{ fontSize: '1.125rem', fontWeight: 600, minWidth: 118 }}
              color={count > 0 ? 'text.primary' : 'text.disabled'}
            >
              {count} selected
            </Typography>

            <Button size="small" variant="outlined" onClick={selectAllFiltered}>
              Select all filtered
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={() => replaceSelection(new Set())}
              disabled={count === 0}
            >
              Clear selection
            </Button>

            <Box sx={{ flex: 1 }} />

            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <TextField
                label="Pick random"
                type="number"
                value={randomN}
                onChange={(e) => setRandomN(e.target.value)}
                sx={{ width: 130 }}
                slotProps={{ htmlInput: { min: 1, max: filtered.length, step: 1 } }}
              />
              <Button
                size="small"
                variant="outlined"
                onClick={pickRandom}
                startIcon={<CasinoOutlined />}
                disabled={filtered.length === 0}
              >
                Pick
              </Button>
            </Stack>
          </Stack>

          {/* assign */}
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            useFlexGap
            sx={{ alignItems: { md: 'center' }, flexWrap: 'wrap' }}
          >
            <TextField
              select
              label="Assign to"
              value={targetMentor}
              onChange={(e) => setTargetMentor(e.target.value)}
              sx={{ minWidth: 250 }}
              slotProps={{ inputLabel: { shrink: true } }}
            >
              <MenuItem value="">Choose a mentor…</MenuItem>
              {mentors.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.name} — {m.menteeCount} now
                </MenuItem>
              ))}
            </TextField>

            <Button
              variant="contained"
              color="secondary"
              disabled={busy || !targetMentor}
              onClick={() =>
                run(() => assignStudents({ studentIds: selectedIds, mentorId: targetMentor }))
              }
            >
              {pending ? 'Working…' : `Assign ${count} ${count === 1 ? 'student' : 'students'}`}
            </Button>

            {/*
              Unassign has no preview and no undo: the previous mentorId values
              are not recorded anywhere, so "select all filtered" with no filter
              set followed by one click detaches every student in the programme
              and a director would have to rebuild 46 assignments by hand.
              Assign, right next to it, at least names its target and previews
              the resulting caseload.
            */}
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() => setConfirmingUnassign(true)}
            >
              Unassign
            </Button>

            {assignPreview ? (
              <Typography variant="caption" color="text.secondary">
                {assignPreview.name} goes from {assignPreview.before} to{' '}
                <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {assignPreview.after}
                </Box>{' '}
                mentees.
              </Typography>
            ) : null}
          </Stack>

          {/* balance */}
          <Box>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              useFlexGap
              sx={{ alignItems: { md: 'center' }, flexWrap: 'wrap' }}
            >
              <TextField
                select
                label="Split evenly across"
                value={balanceIds}
                onChange={(e) =>
                  setBalanceIds(
                    typeof e.target.value === 'string'
                      ? e.target.value.split(',').filter(Boolean)
                      : (e.target.value as unknown as string[]),
                  )
                }
                sx={{ minWidth: 300 }}
                slotProps={{
                  inputLabel: { shrink: true },
                  select: {
                    multiple: true,
                    renderValue: (value) => {
                      const ids = value as string[];
                      if (ids.length === 0) return 'Choose mentors…';
                      return mentors
                        .filter((m) => ids.includes(m.id))
                        .map((m) => m.name)
                        .join(', ');
                    },
                    displayEmpty: true,
                  },
                }}
              >
                {mentors.map((m) => (
                  <MenuItem key={m.id} value={m.id}>
                    {m.name}
                  </MenuItem>
                ))}
              </TextField>

              <Button
                variant="outlined"
                disabled={busy || balanceIds.length === 0}
                onClick={() =>
                  run(() => balanceStudents({ studentIds: selectedIds, mentorIds: balanceIds }))
                }
              >
                Apply even split
              </Button>

              {balancePreview === null ? (
                <Typography variant="caption" color="text.disabled">
                  Deals the selected students round-robin. The resulting counts appear here
                  before anything is written.
                </Typography>
              ) : null}
            </Stack>

            {balancePreview ? (
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ mt: 1.75, flexWrap: 'wrap', alignItems: 'center' }}
              >
                <Typography variant="caption" color="text.secondary">
                  After the split:
                </Typography>
                {balancePreview.map((m) => (
                  <Chip
                    key={m.id}
                    size="small"
                    variant="outlined"
                    label={`${m.name} ${m.before} → ${m.after}`}
                    sx={{ color: m.after === m.before ? 'text.secondary' : 'text.primary' }}
                  />
                ))}
              </Stack>
            ) : null}
          </Box>
        </Stack>

        {result?.error ? (
          <Alert severity="error" sx={{ mt: 2.5 }}>
            {result.error}
          </Alert>
        ) : null}
        {result?.message ? (
          <Alert severity="success" sx={{ mt: 2.5 }}>
            {result.message}
          </Alert>
        ) : null}
      </Surface>

      <DataGrid
        rows={filtered}
        columns={columns}
        checkboxSelection
        keepNonExistentRowsSelected
        rowSelectionModel={selectionModel}
        onRowSelectionModelChange={handleSelectionChange}
        // A stray click while reading a row must never wipe a 20-student
        // selection — the checkbox is the only way in and out.
        disableRowSelectionOnClick
        disableColumnMenu
        autoHeight
        pageSizeOptions={[10, 25, 50, 100]}
        initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
        localeText={{ noRowsLabel: 'No students match those filters.' }}
        rowHeight={52}
        columnHeaderHeight={46}
      />

      <Dialog
        open={confirmingUnassign}
        onClose={() => setConfirmingUnassign(false)}
        aria-labelledby="unassign-title"
      >
        <DialogTitle id="unassign-title">
          Unassign {count} {count === 1 ? 'student' : 'students'}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            They will not appear on any mentor&rsquo;s roster, alert queue or upload
            review until they are assigned again. The current assignments are not
            recorded anywhere, so this cannot be undone — each one would have to be
            set by hand.
          </DialogContentText>

          {losingByMentor.size > 0 && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 2, flexWrap: 'wrap' }}>
              {mentors
                .filter((m) => losingByMentor.has(m.id))
                .map((m) => (
                  <Chip
                    key={m.id}
                    size="small"
                    variant="outlined"
                    label={`${m.name} ${m.menteeCount} → ${m.menteeCount - (losingByMentor.get(m.id) ?? 0)}`}
                  />
                ))}
            </Stack>
          )}

          {/* A selection survives a filter change by design, so the grid can
              easily be showing fewer students than the button is about to
              move. Saying so is the difference between a deliberate act and a
              surprise. */}
          {hiddenSelected > 0 && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {hiddenSelected} of them {hiddenSelected === 1 ? 'is' : 'are'} hidden by
              the current filter.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmingUnassign(false)}>Keep them</Button>
          <Button
            color="error"
            disabled={busy}
            onClick={() => {
              setConfirmingUnassign(false);
              run(() => assignStudents({ studentIds: selectedIds, mentorId: null }));
            }}
          >
            Unassign {count}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
