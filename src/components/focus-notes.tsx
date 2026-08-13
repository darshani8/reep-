import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { EmptyState, StatusChip, type Tone } from '@/components/kit';
import type { MentorAction } from '@prisma/client';

/**
 * Mentor notes.
 *
 * The note log is also the audit trail — flagging, nudging and scheduling a 1:1
 * all write one — so each entry carries who wrote it, when, and which action it
 * came from. A student can be shown this list verbatim.
 *
 * Entries are separated by a hairline rather than marked with a coloured rule:
 * a note is not a status, and a stack of accent bars is ink spent on nothing.
 *
 * Every entry shows **two** timestamps, and that is the point rather than
 * clutter. `meetingAt` is when the conversation happened and is the one a mentor
 * means when they say "when did we last speak"; `createdAt` is when the note was
 * typed and cannot be edited. A note written up on Monday about Friday's meeting
 * is the ordinary case, and a log that shows only one of the two either dates
 * the conversation wrongly or loses the record of when it was written down.
 * Where they agree the line reads as a small redundancy, which is the price of
 * never having to wonder which of the two a single date meant.
 */

export type FocusNote = {
  id: string;
  noteText: string;
  /// When the conversation happened — editable by the author when they write up
  /// a meeting after the fact, or book one ahead.
  meetingAt: Date;
  /// When the row was written. Immutable, and the reason the pair is shown.
  createdAt: Date;
  linkedAction: MentorAction;
  authorName: string;
};

const ACTION_LABEL: Record<MentorAction, string | null> = {
  NONE: null,
  FLAGGED: 'Flagged for follow-up',
  NUDGE_SENT: 'Nudge sent',
  ONE_ON_ONE_SCHEDULED: '1:1 scheduled',
};

const ACTION_TONE: Record<MentorAction, Tone> = {
  NONE: 'neutral',
  FLAGGED: 'warning',
  NUDGE_SENT: 'info',
  ONE_ON_ONE_SCHEDULED: 'accent',
};

export function FocusNotes({ notes }: { notes: FocusNote[] }) {
  if (notes.length === 0) {
    return (
      <EmptyState
        title="No notes yet."
        hint="Anything you write, flag or schedule below lands here, newest at the top."
      />
    );
  }

  return (
    <Stack>
      {notes.map((note) => {
        const action = ACTION_LABEL[note.linkedAction];
        return (
          <Box
            key={note.id}
            sx={{
              py: 2,
              borderTop: 1,
              borderColor: 'divider',
              '&:first-of-type': { borderTop: 0, pt: 0 },
            }}
          >
            {action && (
              <Box sx={{ mb: 1 }}>
                <StatusChip tone={ACTION_TONE[note.linkedAction]} label={action} />
              </Box>
            )}

            <Typography variant="body2">{note.noteText}</Typography>

            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 0.75, display: 'block' }}
            >
              {note.authorName} · Met {formatMeeting(note.meetingAt)} · Written{' '}
              {formatNoteDate(note.createdAt)}
              {note.meetingAt > note.createdAt ? ' (scheduled)' : ''}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}

function formatNoteDate(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/// The meeting carries a time as well as a day — "we spoke on the 7th" and "we
/// spoke at 3:30 on the 7th" are different amounts of record, and a 1:1 booked
/// for next Tuesday is useless without the hour.
function formatMeeting(date: Date): string {
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
