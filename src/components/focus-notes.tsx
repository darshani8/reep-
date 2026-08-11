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
 */

export type FocusNote = {
  id: string;
  noteText: string;
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
              {note.authorName} · {formatNoteDate(note.createdAt)}
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
