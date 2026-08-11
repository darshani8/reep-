'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddRounded from '@mui/icons-material/AddRounded';
import ArrowDropDownRounded from '@mui/icons-material/ArrowDropDownRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ErrorRounded from '@mui/icons-material/ErrorRounded';
import {
  DataGrid,
  GridCellModes,
  GridEditSingleSelectCell,
  useGridApiContext,
  type GridCellModesModel,
  type GridCellParams,
  type GridColDef,
  type GridColumnGroupingModel,
  type GridRenderCellParams,
  type GridRenderEditCellParams,
  type GridRowModel,
} from '@mui/x-data-grid';

import { SectionCard } from '@/components/kit';
import { clockLabel, minutesBetween, parseClock } from '@/lib/activity-rules';
import { formatDuration } from '@/lib/reep';

/**
 * A week of study, entered like a spreadsheet.
 *
 * The single-entry form this replaces was built for the daily case — one
 * evening, five fields, done. It is the wrong shape for the case that actually
 * loses data: a student who has not logged for a fortnight and now has eleven
 * rows to enter. Eleven trips through a form, each with a date picker reset in
 * the middle, is how a backlog becomes "I'll do it later" and then never.
 *
 * So this is a grid you type into. Tab across, tab down, paste a duration,
 * duplicate yesterday's row and change the date. Nothing is written until the
 * save button, and rows that fail stay on screen with the reason in the row —
 * the whole point of `/api/activity/bulk` returning per-row results rather than
 * one verdict for the batch.
 *
 * The columns are typed rather than free text (`singleSelect` for activity and
 * course, a real date input, minutes as a number) because the grid's job is to
 * make a valid row easy to produce, not to accept anything and argue afterwards.
 */

export type EntryActivityOption = { value: string; label: string };
export type EntryCourseOption = { code: string; name: string };

type RowState = 'draft' | 'saved' | 'failed';

/**
 * Every field starts empty.
 *
 * An earlier version pre-filled today's date, an hour, and the commonest
 * activity, on the theory that it saved typing. It does the opposite of what a
 * blank spreadsheet does: a row that already looks filled in is a row you have
 * to read and correct rather than one you simply type into, and a defaulted
 * "1 hour of an online course" is a claim about the student's week that nobody
 * made. Empty is both faster to fill and honest about what has been entered.
 *
 * `minutes` is nullable for the same reason — 0 would render as a real number
 * in the cell, which is not the same thing as blank.
 */
type EntryRow = {
  id: string;
  date: string;
  /// "Mon 5 Aug" — formatted on the server so no Date crosses the boundary and
  /// the first paint cannot disagree about the locale.
  dayLabel: string;
  /// Saturday and Sunday, tinted so a month reads as weeks at a glance.
  weekend: boolean;
  /// Minutes already on the record for this day, from earlier entries or a lab
  /// check-in. Present so the student can see what is there before adding to it.
  alreadyMin: number;
  activity: string;
  courseCode: string;
  /// Clock times as `"HH:MM"`, or empty. Both optional — a student who only
  /// remembers "about ninety minutes" can still type the minutes directly.
  from: string;
  to: string;
  minutes: number | null;
  note: string;
  state: RowState;
  message: string;
  /**
   * Added by the student with "+", rather than being one of the month's days.
   *
   * Recorded rather than inferred from "does this date appear twice". Both rows
   * on a doubled date answer yes to that, so a count could not tell the day's
   * own row from the copy — and the day's row carries the server's `alreadyMin`,
   * which is not the student's to delete.
   */
  extra: boolean;
};

/**
 * The minutes a row is worth, and where they came from.
 *
 * From and To own the duration whenever both are filled in, so the two can
 * never sit on screen disagreeing with each other — that is the failure this
 * shape is chosen to prevent. Typing 09:00–10:30 and then editing Minutes to 45
 * would leave a row claiming a ninety-minute block that lasted forty-five, and
 * the record would have no way to say which half was true. With one of the two
 * blank the student is back to entering a plain duration, which is the whole
 * point of leaving them optional.
 */
function derivedMinutes(row: EntryRow): number | null {
  const fromMin = parseClock(row.from);
  const toMin = parseClock(row.to);
  if (fromMin == null || toMin == null) return null;
  return minutesBetween(fromMin, toMin);
}

function effectiveMinutes(row: EntryRow): number | null {
  return derivedMinutes(row) ?? row.minutes;
}

/// True while From and To are driving the duration, which is also when the
/// Minutes cell stops being editable.
function minutesAreDerived(row: EntryRow): boolean {
  return derivedMinutes(row) != null;
}

const NO_COURSE = '';

/**
 * A cell that is a dropdown, and looks like one before you click it.
 *
 * These two columns rendered `null` when empty, on the reasoning that "—" down
 * thirty untouched rows is noise standing where nothing has been entered. That
 * reasoning was about *read* value and ignored *discovery*: an empty cell with
 * no rule beside it and no caret in it does not announce that it is a control
 * at all, so a student can look straight at the column they are meant to fill
 * and see nothing to fill. The caret is quiet — `text.disabled`, strengthening
 * on hover — but it is the difference between a field and a gap.
 *
 * The placeholder word is `aria-hidden`: the column header already names the
 * cell for a screen reader, and "Choose" repeated thirty times is worse than
 * silence there.
 */
function SelectCell({ text, placeholder }: { text: string; placeholder: string }) {
  return (
    <Stack
      direction="row"
      sx={{ width: '100%', gap: 0.5, alignItems: 'center', justifyContent: 'space-between' }}
    >
      {text ? (
        <span>{text}</span>
      ) : (
        <Typography
          component="span"
          variant="body2"
          color="text.disabled"
          aria-hidden
          sx={{ fontSize: '0.8125rem' }}
        >
          {placeholder}
        </Typography>
      )}
      <ArrowDropDownRounded
        aria-hidden
        sx={{
          fontSize: 18,
          flexShrink: 0,
          color: 'text.disabled',
          opacity: 0.55,
          '.MuiDataGrid-row:hover &': { opacity: 1 },
        }}
      />
    </Stack>
  );
}

/**
 * A clock time, typed or picked, in a grid cell.
 *
 * `<input type="time">` rather than a picker component: it is the control the
 * platform already gives a student — typeable as digits, arrow-keyed, and with
 * the browser's own picker behind the icon — and it needs no extra dependency
 * to reach the one thing this column has to be, which is fast to fill thirty
 * times. It also carries locale for free, so a 12-hour phone shows AM/PM while
 * the value the grid stores stays `"HH:MM"`.
 */
function TimeEditCell(params: GridRenderEditCellParams<EntryRow, string>) {
  const api = useGridApiContext();
  const { id, field, value, hasFocus, row } = params;
  const ref = useRef<HTMLInputElement>(null);

  // The column header names this cell for a sighted reader; a screen reader
  // reaching the input gets only "time, blank" without this, with no way to
  // tell From from To or one day's row from the next thirty.
  const label = `${field === 'from' ? 'Start' : 'End'} time for ${row.dayLabel}`;

  // Single-click editing means this mounts already-focused; without moving
  // focus into it the first keystroke goes to the grid and moves the selection
  // instead of typing a time.
  useEffect(() => {
    if (hasFocus) ref.current?.focus();
  }, [hasFocus]);

  return (
    <Box
      component="input"
      ref={ref}
      type="time"
      aria-label={label}
      value={value ?? ''}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
        void api.current.setEditCellValue({ id, field, value: event.target.value });
      }}
      sx={{
        width: '100%',
        height: '100%',
        border: 'none',
        outline: 'none',
        background: 'transparent',
        font: 'inherit',
        fontSize: '0.8125rem',
        color: 'text.primary',
        paddingInline: '8px',
        // Chrome hides the picker button until hover otherwise, which makes the
        // cell look like a plain text box in exactly the state a student is
        // looking at it.
        '&::-webkit-calendar-picker-indicator': { opacity: 0.6, cursor: 'pointer' },
      }}
    />
  );
}

/// A filled clock time reads as itself; an empty one has to say that it is a
/// time, or the column is three blank cells wide and nothing suggests typing.
function TimeCell({ value }: { value: string }) {
  const parsed = parseClock(value);
  return parsed == null ? (
    <Typography
      component="span"
      variant="body2"
      color="text.disabled"
      aria-hidden
      sx={{ fontSize: '0.8125rem' }}
    >
      --:--
    </Typography>
  ) : (
    <span className="tabular">{clockLabel(parsed)}</span>
  );
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `row-${seq}`;
}

/**
 * A row is one day, whether or not anything happened on it.
 *
 * The grid opened with five undated blank rows, which is the right shape for
 * "log last night" and the wrong one for the case it was built for: coming back
 * after a fortnight away. There, the hard part is not typing — it is
 * *remembering which days*, and an undated blank row gives no help with that.
 * A month laid out a day per row turns recall into recognition, and the days
 * already on the record are visible rather than something to guess at.
 */
function dayRow(day: { iso: string; label: string; weekend: boolean; alreadyMin: number }): EntryRow {
  return {
    id: nextId(),
    date: day.iso,
    dayLabel: day.label,
    weekend: day.weekend,
    alreadyMin: day.alreadyMin,
    activity: '',
    courseCode: NO_COURSE,
    from: '',
    to: '',
    minutes: null,
    note: '',
    state: 'draft',
    message: '',
    extra: false,
  };
}

/**
 * Nothing entered on this day yet.
 *
 * The date is deliberately not part of the test. It is the row's identity in a
 * month view, not something the student typed — counting it would mark all
 * thirty rows as started and put "Pick what you did" down the whole column
 * before anyone had touched it.
 */
function isUntouched(row: EntryRow): boolean {
  return (
    !row.activity &&
    !row.courseCode &&
    !row.from &&
    !row.to &&
    row.minutes == null &&
    row.note.trim().length === 0
  );
}

/// Name the one thing still missing rather than saying "incomplete" — a student
/// half-way through a row wants to know which cell to go back to.
function missingFrom(row: EntryRow): string {
  if (!row.activity) return 'Pick what you did';
  // A single time is the one state that looks filled in but says nothing: it
  // gives neither a duration nor a usable start, so name the missing half
  // rather than falling through to "Add minutes" beside a From the student can
  // plainly see they entered.
  if (row.from && !row.to) return 'Add the end time';
  if (row.to && !row.from) return 'Add the start time';
  const total = effectiveMinutes(row);
  if (total == null) return 'Add minutes';
  if (total < 5) return 'At least 5 minutes';
  if (total > 720) return 'At most 12 hours';
  if (row.activity === 'OTHER' && !row.note.trim()) return 'Add a note';
  return 'Incomplete';
}

export type EntryDay = {
  iso: string;
  label: string;
  weekend: boolean;
  alreadyMin: number;
};

export function ActivityEntryGrid({
  activities,
  courses,
  days,
  todayISO,
  earliestISO,
  earliestLabel,
}: {
  activities: EntryActivityOption[];
  courses: EntryCourseOption[];
  /// The month, newest day first, built on the server — so the row set cannot
  /// disagree with the server about what "today" is or how far back the
  /// student is allowed to reach.
  days: EntryDay[];
  todayISO: string;
  earliestISO: string;
  earliestLabel: string;
}) {
  const router = useRouter();

  const [rows, setRows] = useState<EntryRow[]>(() => days.map(dayRow));
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    null,
  );

  /**
   * Single click opens the cell for editing.
   *
   * DataGrid's default is double-click, which is right for a grid you mostly
   * read. This one is a grid you only ever type into, and the reference the
   * request named is a spreadsheet — where one click and a keystroke replaces
   * the cell. Driving `cellModesModel` by hand is the supported way to get it.
   */
  const [cellModes, setCellModes] = useState<GridCellModesModel>({});

  /// The grid's own DOM, so "did that click land outside the grid" is a question
  /// about the element rather than about coordinates.
  const gridWrapRef = useRef<HTMLDivElement>(null);

  /// `saveAll` has to read `rows` *after* committing an open editor, and the
  /// commit is a state update it cannot await. This always holds the latest.
  const rowsRef = useRef<EntryRow[]>([]);

  /// Set synchronously on entry to `saveAll`, because `busy` does not take
  /// effect until the next render — see the note there.
  const savingRef = useRef(false);

  /**
   * A dropdown closes its cell as soon as an option is picked.
   *
   * Left to itself, `GridEditSingleSelectCell` in cell-edit mode chooses the
   * value and then *stays open*, waiting for Enter, Tab or a focus-out that may
   * never come: MUI's own focus-restore has nothing to restore to when the menu
   * was reached from a `tabIndex=-1` grid cell, so `document.activeElement` ends
   * up on `<body>`. The cell is left in edit mode with focus nowhere — Escape,
   * Enter and Tab all land on nothing, and because the value is still only in
   * the grid's editing state, the Status column, the Save count and the live
   * region all keep describing the value the student just replaced. The only way
   * out is a mouse click, so a keyboard-only student is simply stuck.
   *
   * The deferral is not decoration. `onValueChange` is awaited *before*
   * `setEditCellValue`, so committing here would close the editor before the
   * chosen value was written and drop it. A macrotask runs after both have
   * settled.
   */
  function selectEditCell(params: GridRenderEditCellParams<EntryRow>) {
    return (
      <GridEditSingleSelectCell
        {...params}
        aria-label={`${params.colDef.headerName}, ${params.row.dayLabel}`}
        onValueChange={() => {
          setTimeout(() => {
            setCellModes((prev) => ({
              ...prev,
              [params.id]: {
                ...(prev[params.id] ?? {}),
                [params.field]: { mode: GridCellModes.View },
              },
            }));
          }, 0);
        }}
      />
    );
  }

  function openCell(params: GridCellParams) {
    if (!params.isEditable) return;
    setCellModes((prev) => ({
      ...prev,
      [params.id]: {
        ...(prev[params.id] ?? {}),
        [params.field]: { mode: GridCellModes.Edit },
      },
    }));
  }

  /// Any cell still open. A value typed into one is not in `rows` yet, so
  /// everything that reads `rows` — the save button most of all — is looking at
  /// a row the student has already filled in and cannot see it.
  const openEditors = Object.values(cellModes)
    .flatMap((fields) => Object.values(fields))
    .filter((cell) => cell.mode === GridCellModes.Edit).length;

  /// Sending a cell back to View is what makes DataGrid commit it — the same
  /// path Enter takes.
  function commitOpenCells() {
    setCellModes((prev) => {
      const next: GridCellModesModel = {};
      for (const [id, fields] of Object.entries(prev)) {
        next[id] = Object.fromEntries(
          Object.keys(fields).map((field) => [field, { mode: GridCellModes.View }]),
        );
      }
      return next;
    });
  }

  /**
   * Clicking away from the grid commits the cell you were in.
   *
   * Without this, a student who types the last number and reaches straight for
   * Save is stuck: the value lives in the editor, `rows` has not seen it, so the
   * button still reads "Nothing to save" and — being disabled — swallows the
   * click without so much as a flicker. The row looks filled in and the page
   * behaves as if it is empty, which is the worst version of this: no error to
   * read and nothing to try. Only Enter or Tab got the value out.
   *
   * A spreadsheet commits the cell when you click anywhere else, so this does
   * too. The portal check is load-bearing — the `singleSelect` menu renders
   * outside the grid's DOM, so without it choosing an option from the dropdown
   * would count as clicking away and close the editor before the choice landed.
   */
  useEffect(() => {
    if (openEditors === 0) return;

    function commitOnPointerDownOutside(event: PointerEvent) {
      const target = event.target as Element | null;
      if (!target?.isConnected) return;
      if (gridWrapRef.current?.contains(target)) return;
      /**
       * The backdrop is part of the menu's DOM but means the opposite of it.
       *
       * An open dropdown lays an invisible full-screen backdrop over the page,
       * so *every* click outside the list lands on it and never reaches what the
       * student aimed at. It should at least dismiss the dropdown — and it did
       * not: `GridEditSingleSelectCell` only stops editing when its `onClose`
       * receives the reason `'backdropClick'`, and MUI's own `SelectInput` calls
       * `onClose(event)` with no reason argument at all, so that test can never
       * pass. Escape happens to work because the same line also checks
       * `event.key`. Clicking away left the list open over a cell still in edit
       * mode, and a second click was needed to get anywhere.
       *
       * Checked before the portal exemption below, which exists for the opposite
       * case: a click on an actual option must not be mistaken for a click away.
       */
      if (target.closest('.MuiBackdrop-root')) {
        commitOpenCells();
        return;
      }
      if (target.closest('.MuiPopover-root, .MuiModal-root, .MuiDataGrid-menu')) return;
      commitOpenCells();
    }

    document.addEventListener('pointerdown', commitOnPointerDownOutside, true);
    return () => document.removeEventListener('pointerdown', commitOnPointerDownOutside, true);
  }, [openEditors]);

  const activityLabels = useMemo(
    () => new Map(activities.map((a) => [a.value, a.label])),
    [activities],
  );

  // A row is worth sending once it has a day, an activity and a sane length —
  // and, for "Something else", the words that are the only record of what it was.
  function isReady(row: EntryRow): boolean {
    if (!row.date || !row.activity) return false;
    if (row.from && !row.to) return false;
    if (row.to && !row.from) return false;
    const total = effectiveMinutes(row);
    if (total == null || total < 5 || total > 720) return false;
    if (row.activity === 'OTHER' && row.note.trim().length === 0) return false;
    return true;
  }

  rowsRef.current = rows;

  const ready = rows.filter(isReady);
  /// Distinct days carrying time, counting what was already on the record plus
  /// anything typed but not yet sent.
  const daysWithTime = new Set(
    rows.filter((r) => r.alreadyMin > 0 || isReady(r)).map((r) => r.date),
  ).size;

  /// The first started-but-unsendable row, for the announced status below.
  const blocking = rows
    .map((row, index) => ({ row, index }))
    .find(({ row }) => !isUntouched(row) && row.state !== 'saved' && !isReady(row));
  // `effectiveMinutes`, not `row.minutes` — the latter is only ever what was
  // typed, so a row whose duration comes from From and To would count as zero
  // and the "N in total" beside the button would contradict the rows above it.
  const totalMinutes = ready.reduce((sum, r) => sum + (effectiveMinutes(r) ?? 0), 0);

  /**
   * A second entry for the same day.
   *
   * A day is rarely one thing — a lecture in the morning and two hours of
   * practice that evening are two rows with one date. The month gives one row
   * per day as the starting point; this is how a day grows past it.
   */
  function addRowFor(id: string) {
    setRows((current) => {
      const index = current.findIndex((r) => r.id === id);
      if (index === -1) return current;
      const source = current[index];
      const extra: EntryRow = {
        ...source,
        id: nextId(),
        // The copy is another slot on the same day, not a copy of the entry —
        // and it must not repeat the day's existing total, or the column would
        // double-count it.
        alreadyMin: 0,
        activity: '',
        courseCode: NO_COURSE,
        from: '',
        to: '',
        minutes: null,
        note: '',
        state: 'draft',
        message: '',
        extra: true,
      };
      return [...current.slice(0, index + 1), extra, ...current.slice(index + 1)];
    });
  }

  /**
   * Clears what was typed rather than removing the day — the month is fixed.
   * Extra rows added for a day are genuinely removed.
   *
   * The removal used to be gated on `isUntouched(row)` while the button that
   * calls this was disabled on exactly the same test, so the two conditions
   * could never both hold and an added row was permanent: filling it in enabled
   * the button, clicking it took the blanking branch, and blanking it disabled
   * the button again. `extra` is the row's own history rather than a guess from
   * its contents, so removal no longer depends on the state that hides the
   * control.
   *
   * A day's own row is never removed even when a copy sits beside it: the month
   * is the server's list of days this student may log against, and nothing in
   * this component can add a day back.
   */
  function clearRow(id: string) {
    setRows((current) => {
      const row = current.find((r) => r.id === id);
      if (!row) return current;
      if (row.extra) return current.filter((r) => r.id !== id);
      return current.map((r) =>
        r.id === id
          ? { ...r, activity: '', courseCode: NO_COURSE, from: '', to: '', minutes: null, note: '', state: 'draft' as RowState, message: '' }
          : r,
      );
    });
  }

  /// DataGrid hands back the edited row; editing anything clears that row's
  /// previous verdict, because a failure message about the old value is worse
  /// than none.
  function processRowUpdate(updated: GridRowModel): GridRowModel {
    const edited = updated as EntryRow;
    const raw = edited.minutes;
    // Clearing the cell must leave it blank, not silently become 0 — the row is
    // then "not filled in yet" rather than "zero minutes of study".
    const typedMinutes =
      raw == null || (raw as unknown as string) === '' || !Number.isFinite(Number(raw))
        ? null
        : Math.round(Number(raw));

    // Times are normalised on the way in rather than on every read: a browser
    // that hands back "9:05" or "09:05:00" is stored as "09:05", so the value
    // the cell shows, the value compared against the other time, and the value
    // posted are the same string.
    const normalise = (value: string) => {
      const parsed = parseClock(value ?? '');
      return parsed == null ? '' : clockLabel(parsed);
    };

    const withTimes: EntryRow = {
      ...edited,
      from: normalise(edited.from),
      to: normalise(edited.to),
      minutes: typedMinutes,
    };

    /**
     * `minutes` holds what the student typed, and only that.
     *
     * It used to be overwritten with the derived duration whenever both times
     * were present, which quietly turned a number the grid worked out into a
     * number the student had supposedly entered. Clearing the times then left
     * that value behind as their own: 09:00–10:30 followed by deleting both
     * times left `90` sitting in Minutes, and a row erased down to blank fields
     * came back as ready-to-save with ninety minutes nobody had claimed. It also
     * destroyed whatever they had typed before reaching for the clock.
     *
     * The derived value is computed on read by `effectiveMinutes` instead, so
     * the two never overwrite each other and removing a time simply hands the
     * row back to the number it had.
     */
    const next: EntryRow = {
      ...withTimes,
      minutes: typedMinutes,
      state: 'draft',
      message: '',
    };
    setRows((current) => current.map((r) => (r.id === next.id ? next : r)));
    return next;
  }

  async function saveAll() {
    /**
     * The in-flight guard is a ref, and it is set before the first `await`.
     *
     * `busy` cannot do this job: it is React state, so it only takes effect on
     * the next render, and the commit wait below yields for up to ~192ms before
     * `setBusy(true)` is ever reached. Through that whole window the button is
     * enabled and a second activation — a held Enter repeats at roughly 30ms —
     * re-enters here, finds the cells already committed, and POSTs the identical
     * batch. These entries carry no idempotency key, so that is a duplicated
     * fortnight of study, silently doubled on the enrolment.
     */
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await runSave();
    } finally {
      savingRef.current = false;
    }
  }

  async function runSave() {
    // Whatever cell is still open is part of what the student meant to save, so
    // it is committed first and the batch read back afterwards — from the ref,
    // because `rows` in this closure predates the commit.
    //
    // The commit is a chain of state updates this cannot await —
    // `cellModesModel` → DataGrid's effect → `processRowUpdate` → `setRows` —
    // and a single tick is not enough for it: the first version of this used
    // `setTimeout(0)` and read the row back before the value had landed, so the
    // click committed the cell and saved nothing, and the student had to press
    // Save twice. `setRows` always builds a new array, so waiting on the array's
    // identity waits for the actual result rather than for a guessed delay.
    if (openEditors > 0) {
      const before = rowsRef.current;
      commitOpenCells();
      for (let i = 0; i < 12 && rowsRef.current === before; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    }

    const pending = rowsRef.current.filter(isReady);
    if (pending.length === 0) {
      setBanner({ tone: 'error', text: 'Nothing is filled in yet — add minutes to a day first.' });
      return;
    }

    setBusy(true);
    setBanner(null);

    try {
      const res = await fetch('/api/activity/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: pending.map((row) => ({
            date: row.date,
            activity: row.activity,
            durationMin: effectiveMinutes(row),
            courseCode: row.courseCode || undefined,
            note: row.note.trim() || undefined,
            // Only sent when the student actually said what time it was. A row
            // entered as a plain duration keeps the server's mode-based guess
            // rather than being anchored at a clock time nobody claimed.
            startMin: parseClock(row.from) ?? undefined,
          })),
        }),
      });

      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        savedCount?: number;
        results?: { index: number; ok: boolean; error?: string }[];
      };

      if (!payload.ok || !payload.results) {
        setBanner({ tone: 'error', text: payload.error ?? 'That did not save. Try again.' });
        return;
      }

      // Results come back indexed against `pending`, not against every row on
      // screen, so map back through it rather than by grid position.
      const verdict = new Map<string, { ok: boolean; error?: string }>();
      for (const result of payload.results) {
        const row = pending[result.index];
        if (row) verdict.set(row.id, { ok: result.ok, error: result.error });
      }

      // A saved row folds into the day's running total and empties itself.
      //
      // Leaving thirty rows marked "Saved" would fill the month with entries
      // the student has to mentally subtract, and would make a second entry for
      // the same day a fight with a row that looks finished. Rolling the time
      // into "Already logged" is the same information in the place the month
      // view already reads it from, and hands back an empty row for that day.
      setRows((current) =>
        current.map((row) => {
          const outcome = verdict.get(row.id);
          if (!outcome) return row;
          if (!outcome.ok) {
            return { ...row, state: 'failed', message: outcome.error ?? 'Could not save' };
          }
          return {
            ...row,
            alreadyMin: row.alreadyMin + (effectiveMinutes(row) ?? 0),
            activity: '',
            courseCode: NO_COURSE,
            from: '',
            to: '',
            minutes: null,
            note: '',
            state: 'draft',
            message: '',
          };
        }),
      );

      const saved = payload.savedCount ?? 0;
      const failed = payload.results.length - saved;

      setBanner(
        failed === 0
          ? { tone: 'success', text: `Logged ${saved} ${saved === 1 ? 'entry' : 'entries'}.` }
          : {
              tone: 'error',
              text: `Logged ${saved} of ${payload.results.length}. The ${failed} still on screen say why in the last column — fix and save again.`,
            },
      );

      if (saved > 0) router.refresh();
    } catch {
      // Deliberately not "try again". The request may have reached the server
      // and written every row before the connection dropped — there is no
      // idempotency key on these entries, so a confident retry is how a
      // fortnight of study becomes a fortnight logged twice, with the hours
      // silently doubled on the enrolment. Reloading is the only way to know.
      setBanner({
        tone: 'error',
        text: 'Lost the connection before the server answered, so we cannot tell whether these saved. Reload the Time Log and check the table below before saving again.',
      });
    } finally {
      setBusy(false);
    }
  }

  // --- columns --------------------------------------------------------------

  const columns: GridColDef[] = [
    {
      field: 'dayLabel',
      headerName: 'Day',
      width: 124,
      // Not editable any more: the day *is* the row in a month view, so there is
      // nothing to pick and nothing to mistype.
      editable: false,
      sortable: false,
      display: 'flex',
      renderCell: (params: GridRenderCellParams<EntryRow>) => (
        <Typography
          variant="body2"
          sx={{
            color: params.row.date === todayISO ? 'secondary.main' : 'text.primary',
            fontWeight: params.row.date === todayISO ? 600 : 400,
          }}
        >
          {params.row.dayLabel}
          {params.row.date === todayISO ? ' · today' : ''}
        </Typography>
      ),
    },
    {
      field: 'alreadyMin',
      headerName: 'On record',
      width: 88,
      editable: false,
      sortable: false,
      display: 'flex',
      renderCell: (params: GridRenderCellParams<EntryRow>) =>
        params.row.alreadyMin > 0 ? (
          <Typography variant="body2" className="tabular" color="text.secondary">
            {formatDuration(params.row.alreadyMin)}
          </Typography>
        ) : null,
    },
    {
      field: 'activity',
      headerName: 'What you did',
      width: 162,
      editable: true,
      cellClassName: 'cell-editable',
      type: 'singleSelect',
      // The blank option is a real, selectable value rather than an absence —
      // otherwise a cleared cell holds a value the column does not know about,
      // and the grid renders it as an empty box it will warn about.
      valueOptions: [
        // Spelled out rather than a bare em dash: read aloud, "—" is either
        // silence or the word "dash", so the option that clears the cell had no
        // name. The Course column below has always said this properly.
        { value: '', label: '— none —' },
        ...activities.map((a) => ({ value: a.value, label: a.label })),
      ],
      renderCell: (params: GridRenderCellParams<EntryRow>) => (
        <SelectCell
          text={
            params.row.activity
              ? (activityLabels.get(params.row.activity) ?? params.row.activity)
              : ''
          }
          placeholder="Choose"
        />
      ),
      renderEditCell: selectEditCell,
    },
    {
      field: 'courseCode',
      headerName: 'Course',
      width: 92,
      editable: true,
      cellClassName: 'cell-editable',
      type: 'singleSelect',
      valueOptions: [
        { value: NO_COURSE, label: '— none —' },
        ...courses.map((c) => ({ value: c.code, label: c.code })),
      ],
      // Blank means "no particular course", which is a normal thing to log —
      // the column says so once in its header rather than on every row.
      renderCell: (params: GridRenderCellParams<EntryRow>) => (
        <SelectCell text={params.row.courseCode || ''} placeholder="Any" />
      ),
      renderEditCell: selectEditCell,
    },
    {
      field: 'from',
      headerName: 'From',
      width: 84,
      editable: true,
      sortable: false,
      cellClassName: 'cell-editable',
      display: 'flex',
      renderCell: (params: GridRenderCellParams<EntryRow>) => <TimeCell value={params.row.from} />,
      renderEditCell: (params) => <TimeEditCell {...params} />,
    },
    {
      field: 'to',
      headerName: 'To',
      width: 84,
      editable: true,
      sortable: false,
      cellClassName: 'cell-editable',
      display: 'flex',
      renderCell: (params: GridRenderCellParams<EntryRow>) => <TimeCell value={params.row.to} />,
      renderEditCell: (params) => <TimeEditCell {...params} />,
    },
    {
      field: 'minutes',
      headerName: 'Minutes',
      width: 88,
      // Editable only while From and To are not both filled in — see
      // `derivedMinutes`. A cell you can type into that then ignores what you
      // typed is worse than one that visibly stops accepting input.
      editable: true,
      sortable: false,
      type: 'number',
      align: 'left',
      headerAlign: 'left',
      cellClassName: (params) => (minutesAreDerived(params.row as EntryRow) ? '' : 'cell-editable'),
      display: 'flex',
      renderCell: (params: GridRenderCellParams<EntryRow>) => {
        const derived = derivedMinutes(params.row);
        if (derived != null) {
          // Shown as the duration rather than a bare number, because at this
          // point it is an answer the grid worked out, not something typed.
          return (
            <Typography variant="body2" className="tabular" color="text.secondary">
              {formatDuration(derived)}
            </Typography>
          );
        }
        return params.row.minutes == null ? null : (
          <span className="tabular">{params.row.minutes}</span>
        );
      },
    },
    {
      field: 'note',
      headerName: 'Note',
      flex: 1,
      minWidth: 128,
      editable: true,
      cellClassName: 'cell-editable',
      type: 'string',
    },
    {
      field: 'state',
      headerName: 'Status',
      width: 124,
      sortable: false,
      editable: false,
      display: 'flex',
      renderCell: (params: GridRenderCellParams<EntryRow>) => {
        const row = params.row;
        if (row.state === 'failed') {
          // Not a Tooltip on a non-focusable div, and not truncated: the reason
          // a row was refused is the whole point of the column, and hover is
          // not available to a keyboard or a touch screen.
          return (
            <Stack
              direction="row"
              spacing={0.75}
              sx={{ alignItems: 'flex-start', minWidth: 0, py: 0.5 }}
            >
              <ErrorRounded sx={{ fontSize: 16, color: 'error.main', flexShrink: 0, mt: 0.2 }} />
              <Typography variant="caption" color="error.dark" sx={{ whiteSpace: 'normal' }}>
                {row.message}
              </Typography>
            </Stack>
          );
        }
        // An untouched row says nothing. Five blank rows each labelled
        // "Incomplete" reads as five errors before the student has typed a
        // character.
        if (isUntouched(row)) return null;

        if (!isReady(row)) {
          return (
            <Typography variant="caption" color="text.secondary">
              {missingFrom(row)}
            </Typography>
          );
        }
        return (
          <Typography variant="caption" color="text.secondary">
            {formatDuration(effectiveMinutes(row) ?? 0)} · ready
          </Typography>
        );
      },
    },
    {
      field: 'actions',
      headerName: 'Row actions',
      width: 78,
      sortable: false,
      editable: false,
      filterable: false,
      display: 'flex',
      // Named for the accessibility tree but not on screen: a visible heading
      // over two icons is a label for something nobody needed labelled, while an
      // unnamed columnheader is a gap in the grid a screen reader reads out.
      renderHeader: () => null,
      renderCell: (params: GridRenderCellParams<EntryRow>) => (
        <Stack direction="row">
          <Tooltip title={`Add another entry for ${params.row.dayLabel}`}>
            <IconButton
              size="small"
              aria-label={`Add another entry for ${params.row.dayLabel}`}
              onClick={() => addRowFor(params.row.id)}
            >
              <AddRounded sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
          {/* The span is load-bearing: a disabled button fires no events, so a
              Tooltip attached straight to it never opens — and MUI warns once
              per row about it. The wrapper is what the Tooltip listens to, which
              is also the only way the hint is available on the rows where the
              control is greyed out. */}
          {/* One control, two jobs, and the label has to say which. On a day's
              own row it empties the fields; on a row the student added it takes
              the row away, because the month's days are the server's list and an
              added slot is the only thing here that is theirs to remove. */}
          <Tooltip title={params.row.extra ? 'Remove this entry' : 'Clear this row'}>
            <span style={{ display: 'inline-flex' }}>
              <IconButton
                size="small"
                aria-label={
                  params.row.extra
                    ? `Remove this extra entry for ${params.row.dayLabel}`
                    : `Clear the entry for ${params.row.dayLabel}`
                }
                // An added row is always removable — including while blank, which
                // is exactly when a student wants the "+" they just pressed undone.
                disabled={!params.row.extra && isUntouched(params.row)}
                onClick={() => clearRow(params.row.id)}
              >
                <DeleteOutlineRounded sx={{ fontSize: 17 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      ),
    },
  ];

  /**
   * From, To and Minutes are one question with three cells.
   *
   * Grouping them under a single header is what makes the derivation legible
   * without a paragraph of help text: the student can see that Minutes belongs
   * with the two times rather than being a fourth independent thing to fill in,
   * which is exactly the confusion a bare row of ten equal headers creates.
   */
  const columnGroups: GridColumnGroupingModel = [
    {
      groupId: 'logged',
      headerName: 'Logged',
      headerAlign: 'left',
      children: [{ field: 'from' }, { field: 'to' }, { field: 'minutes' }],
    },
  ];

  // --------------------------------------------------------------------------

  return (
    <SectionCard
      title="Log your study time"
      subtitle={`One row per day, ${earliestLabel} to today. Fill the days you studied and save them together.`}
    >
      {/* A weekend tint is what makes thirty rows read as four weeks rather
          than a list. It is decoration only — no meaning rests on it. */}
      <Box
        ref={gridWrapRef}
        sx={{
          '& .row-weekend': { bgcolor: 'action.hover' },
          // 30 rows at the shared row height is far taller than a screen, so
          // the grid scrolls inside itself and the page keeps its rhythm.
          height: 460,
        }}
      >
        <DataGrid
          // Two grids sit on this screen; unnamed, a screen-reader user has no
          // way to tell which one they have landed in.
          aria-label="Log your study time, one row per day"
          rows={rows}
          columns={columns}
          columnGroupingModel={columnGroups}
          editMode="cell"
          cellModesModel={cellModes}
          onCellModesModelChange={setCellModes}
          onCellClick={openCell}
          processRowUpdate={processRowUpdate}
          onProcessRowUpdateError={() => undefined}
          // Minutes stops taking input for the rows where From and To have
          // already answered it. Per-cell rather than per-column because it is a
          // property of the row's contents, not of the column.
          isCellEditable={(params) =>
            params.field !== 'minutes' || !minutesAreDerived(params.row as EntryRow)
          }
          getRowClassName={(params) =>
            (params.row as EntryRow).weekend ? 'row-weekend' : ''
          }
          disableRowSelectionOnClick
          disableColumnMenu
          hideFooter
          // Matches ReepGrid. The session table sits directly below this one on
          // the same screen; a 10px row-height difference between two tables in
          // one view reads as two components from two products.
          rowHeight={56}
          columnHeaderHeight={46}
          // The group row holds one short word. Left at the default it takes
          // the full column-header height, so the two header rows ate 93px of a
          // 460px box and left 8.2 rows showing.
          columnGroupHeaderHeight={30}
          localeText={{ noRowsLabel: 'No days available to log.' }}
        />
      </Box>

      {banner && (
        <Alert severity={banner.tone} sx={{ mt: 2 }}>
          {banner.text}
        </Alert>
      )}

      {/*
        The save button reads "Nothing to save" and is disabled whenever a row
        is incomplete, which tells a sighted reader to look at the Status column
        and tells a screen-reader user nothing at all. This names the first row
        still blocking the save, and is the only announced route to that reason.
      */}
      <Box
        role="status"
        aria-live="polite"
        sx={{
          position: 'absolute',
          // Strings, not bare numbers. MUI's `sx` reads a unitless width or
          // height of 1 as the *fraction* 1 — i.e. 100% — so this "1px by 1px"
          // region was rendering 1905×874 and pushing the document 284px wider
          // than the viewport. It was never visible (`clip` hides it and keeps
          // it out of hit-testing), but every page carrying this grid scrolled
          // sideways because of it.
          width: '1px',
          height: '1px',
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {blocking
          ? // The day, not an ordinal. The grid's own `aria-rowindex` starts at 3
            // — the `Logged` column group adds a header level — so "Row 1" named
            // a row the screen reader calls row 3, and there are no row numbers
            // on screen to reconcile the two against. The date is what the
            // student is looking at.
            `${blocking.row.dayLabel}: ${missingFrom(blocking.row).toLowerCase()}.`
          : ready.length > 0
            ? `${ready.length} ${ready.length === 1 ? 'row' : 'rows'} ready to save.`
            : ''}
      </Box>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ mt: 2.5, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
        useFlexGap
        className="no-print"
      >
        {/*
          Stays enabled while a cell is open even when `ready` is empty: the
          count is computed from `rows`, which cannot see the cell being typed
          into, and a disabled button eats the click rather than committing it.
        */}
        <Button
          variant="contained"
          color="secondary"
          onClick={saveAll}
          /**
           * The last term is what keeps the click from being swallowed.
           *
           * Clicking Save fires `pointerdown` first, which commits the open cell
           * (see the effect above). React flushes that before the browser
           * dispatches `click`, so on a row that is still incomplete after the
           * commit, `openEditors` fell to 0 while `ready` stayed 0 — the button
           * disabled itself under the cursor and a disabled button dispatches no
           * click, so `saveAll` never ran and the "Nothing is filled in yet"
           * banner it would have shown was unreachable. The student pressed Save,
           * watched it grey out, and got no reason why.
           *
           * Anything typed anywhere keeps the button live, so the click always
           * lands and always answers.
           */
          disabled={
            busy ||
            (ready.length === 0 && openEditors === 0 && rows.every(isUntouched))
          }
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {busy
            ? 'Saving…'
            : ready.length > 0
              ? `Save ${ready.length} ${ready.length === 1 ? 'row' : 'rows'}`
              : openEditors > 0
                ? 'Save'
                : 'Nothing to save'}
        </Button>

        {ready.length > 0 && (
          <Typography variant="body2" color="text.secondary" className="tabular">
            {formatDuration(totalMinutes)} in total
          </Typography>
        )}

        {/* The month at a glance: how much of it already has time against it.
            This is the number the grid exists to move. */}
        <Typography variant="body2" color="text.secondary" className="tabular">
          {/* Distinct dates on both sides. `rows.length` counted rows, so one
              press of "+" turned a 30-day month into "of 31 days". */}
          {daysWithTime} of {new Set(rows.map((r) => r.date)).size} days have time logged
        </Typography>

        <Box sx={{ flex: 1 }} />

        <Typography variant="caption" color="text.disabled" sx={{ maxWidth: '56ch' }}>
          Click any cell to edit it, Tab to move across, Enter to commit. Give From and To and
          the minutes work themselves out; or leave both blank and type the minutes yourself —
          45, 90, 120. Everything logged here stays self-reported until your mentor confirms it.
        </Typography>
      </Stack>
    </SectionCard>
  );
}
