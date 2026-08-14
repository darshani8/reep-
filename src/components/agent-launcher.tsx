'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import CloseRounded from '@mui/icons-material/CloseRounded';
import OpenInFullRounded from '@mui/icons-material/OpenInFullRounded';

import { AgentChat, type ChatTurn } from '@/components/agent-chat';
import { GeminiIcon } from '@/components/gemini-icon';

/**
 * The agent, reachable from every screen.
 *
 * A reader looking at one student's focus log should not have to navigate away
 * — losing the row they were reading — to ask a question about it. So the agent
 * gets a launcher in the corner of every screen, and the full page stays for
 * when someone wants the whole transcript.
 *
 * Three decisions worth keeping:
 *
 *  - **Nothing is fetched until it is opened.** This mounts on every page in the
 *    product. Loading a scope and twenty past runs on each render would put a
 *    database round-trip behind every navigation to pay for a panel most
 *    readers will not open on most screens.
 *  - **It stays mounted once opened.** A run is several calls to a local model,
 *    and `useAbortable` cancels on unmount — so tearing the panel down on close
 *    would silently kill a question still being answered. Closing hides it;
 *    only Cancel cancels.
 *  - **Scope copy comes from the server.** The sentence promising a student that
 *    no one else's record is reachable is written by the code that enforces it,
 *    not typed again here where it could drift.
 */

type Session = {
  scope: 'self' | 'programme';
  scopeNote: string;
  suggestions: string[];
  model: string | null;
  turns: ChatTurn[];
};

const WIDTH = 460;

export function AgentLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);

  // The dedicated page is the same agent. A button to open it on top of itself
  // is noise.
  const onAgentPage = pathname.endsWith('/assistant');

  useEffect(() => {
    if (!open || session || loading.current) return;
    loading.current = true;
    let cancelled = false;

    fetch('/api/agent')
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Session & { error?: string };
        if (!res.ok) throw new Error(body.error ?? 'The agent is unavailable.');
        return body;
      })
      .then((body) => {
        if (!cancelled) setSession(body);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
        // Let a reader who hit a transient failure try again by reopening.
        loading.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [open, session]);

  if (onAgentPage) return null;

  const home = pathname.startsWith('/mentor')
    ? '/mentor'
    : pathname.startsWith('/director')
      ? '/director'
      : '/student';

  return (
    <>
      <Tooltip title="Ask the REEP Agent" placement="left">
        <Fab
          color="secondary"
          aria-label="Open the REEP Agent"
          onClick={() => setOpen(true)}
          className="no-print"
          sx={{
            position: 'fixed',
            right: { xs: 16, sm: 24 },
            bottom: { xs: 16, sm: 24 },
            // Above the content and the permanent drawer, below MUI's own
            // modals so the panel it opens is not painted underneath it.
            zIndex: (theme) => theme.zIndex.drawer - 1,
          }}
        >
          <GeminiIcon />
        </Fab>
      </Tooltip>

      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        className="no-print"
        // Keeps a question that is still running alive when the panel is closed.
        slotProps={{
          root: { keepMounted: true },
          paper: {
            sx: {
              width: { xs: '100%', sm: WIDTH },
              maxWidth: '100%',
              display: 'flex',
              flexDirection: 'column',
            },
          },
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            px: 2.5,
            py: 1.75,
            alignItems: 'center',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }}>
            REEP Agent
          </Typography>

          <Tooltip title="Open the full page">
            <IconButton
              size="small"
              href={`${home}/assistant`}
              aria-label="Open the REEP Agent full page"
              sx={{ color: 'text.disabled' }}
            >
              <OpenInFullRounded sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>

          <IconButton
            size="small"
            onClick={() => setOpen(false)}
            aria-label="Close the REEP Agent"
            sx={{ color: 'text.disabled' }}
          >
            <CloseRounded sx={{ fontSize: 19 }} />
          </IconButton>
        </Stack>

        {error ? (
          <Box sx={{ p: 2.5 }}>
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          </Box>
        ) : !session ? (
          <Stack
            sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1.5 }}
            aria-live="polite"
          >
            <CircularProgress size={20} />
            <Typography variant="caption" color="text.secondary">
              Opening the agent…
            </Typography>
          </Stack>
        ) : (
          <AgentChat
            compact
            scopeNote={session.scopeNote}
            suggestions={session.suggestions}
            initialTurns={session.turns}
            modelHint={session.model ? `${session.model} · give it a moment` : undefined}
          />
        )}
      </Drawer>
    </>
  );
}
