'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { SectionCard } from '@/components/kit';

/**
 * The mentor action bar.
 *
 * Four things a mentor can do about what they have just read, and all four
 * really write to the database through the Server Actions in
 * `src/app/mentor/student/[id]/actions.ts`. Every one of them leaves a note, so
 * nothing happens to a student off the record.
 *
 * Only one of the four is loud. Writing a note is the thing a mentor does after
 * a conversation, so it gets the accent; flagging, nudging and booking a 1:1 are
 * one-tap side effects and sit underneath as plain text. A row of four equally
 * weighted buttons reads as a control panel, which is exactly the tone this
 * screen has to avoid.
 */

export type MentorActionResult = { ok: boolean; message: string };

type Handler = (studentId: string) => Promise<MentorActionResult>;

/// The quiet three. Labels are verbs in sentence case, and the busy label keeps
/// the same width so the row does not jump while a transition runs.
const QUIET_ACTIONS = [
  { key: 'flag', label: 'Flag for follow-up', busyLabel: 'Flagging…' },
  { key: 'nudge', label: 'Send nudge', busyLabel: 'Sending…' },
  { key: 'schedule', label: 'Schedule 1:1', busyLabel: 'Scheduling…' },
] as const;

export function FocusActionBar({
  studentId,
  studentName,
  onFlag,
  onNudge,
  onSchedule,
  onAddNote,
}: {
  studentId: string;
  studentName: string;
  onFlag: Handler;
  onNudge: Handler;
  onSchedule: Handler;
  onAddNote: (
    prev: MentorActionResult | null,
    formData: FormData,
  ) => Promise<MentorActionResult>;
}) {
  const [noteResult, saveNote, savingNote] = useActionState(onAddNote, null);
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<MentorActionResult | null>(null);
  const [noteText, setNoteText] = useState('');

  // Clear the box only once the note is actually filed. On failure the text
  // stays exactly where the mentor left it.
  useEffect(() => {
    if (noteResult?.ok) setNoteText('');
  }, [noteResult]);

  const firstName = studentName.split(' ')[0] ?? studentName;

  const handlers: Record<string, Handler> = {
    flag: onFlag,
    nudge: onNudge,
    schedule: onSchedule,
  };

  function run(key: string) {
    setBusy(key);
    setResult(null);
    startTransition(async () => {
      const next = await handlers[key](studentId);
      setResult(next);
      setBusy(null);
    });
  }

  const working = busy !== null;

  return (
    <Box className="no-print">
      <SectionCard
        title="Take action"
        subtitle={`Everything here writes a note, so ${firstName} can always be shown exactly what was recorded and when.`}
      >
        {/*
          The textarea is controlled, and that is load-bearing rather than
          stylistic. React resets an uncontrolled field once a form action
          returns — and returning `{ ok: false }` is a normal return, not a
          throw. So a mentor who wrote up a 1:1 and hit a session timeout or a
          database blip watched the note vanish and was told to try again with
          nothing left to try again with. The write-up of a conversation with a
          student is the least recoverable thing on this screen.
        */}
        <Box component="form" action={saveNote}>
          <input type="hidden" name="studentId" value={studentId} />
          <TextField
            name="noteText"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            multiline
            fullWidth
            minRows={3}
            placeholder={`What did you agree with ${firstName}?`}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
            sx={{ maxWidth: '72ch' }}
          />

          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <Button type="submit" variant="contained" color="secondary" disabled={savingNote}>
              {savingNote ? 'Saving…' : 'Save note'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              Visible to {firstName} and to programme staff.
            </Typography>
          </Stack>

          {noteResult && (
            <Alert severity={noteResult.ok ? 'success' : 'error'} role="status" sx={{ mt: 2 }}>
              {noteResult.message}
            </Alert>
          )}
        </Box>

        <Box sx={{ mt: 4 }}>
          <Typography variant="body2" color="text.secondary">
            Or record an action on its own — each one files its own note.
          </Typography>

          <Stack
            direction="row"
            spacing={0.5}
            useFlexGap
            sx={{ mt: 1, ml: '-10px', flexWrap: 'wrap' }}
          >
            {QUIET_ACTIONS.map((action) => (
              <Button
                key={action.key}
                variant="text"
                disabled={working}
                onClick={() => run(action.key)}
                sx={{ color: 'text.secondary' }}
              >
                {busy === action.key ? action.busyLabel : action.label}
              </Button>
            ))}
          </Stack>

          {result && (
            <Alert severity={result.ok ? 'success' : 'error'} role="status" sx={{ mt: 2 }}>
              {result.message}
            </Alert>
          )}
        </Box>
      </SectionCard>
    </Box>
  );
}
