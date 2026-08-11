'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useAbortable } from '@/lib/use-abortable';

/**
 * The assistant, as a conversation.
 *
 * Three things on screen that a chat box usually leaves off, all of them
 * because the thing answering is a model reading real student records:
 *
 *  - **The scope line.** Every reader is told, before they type, exactly what
 *    this can and cannot read for them. A student who does not know the
 *    assistant is walled to their own record will assume the wall is not there.
 *  - **What it read.** Each reply carries the tools it called and the record ids
 *    it cited. An answer with no citations is visibly an answer with no
 *    citations, which is the honest way to show one.
 *  - **An elapsed counter and a Cancel.** A run is several calls to a local
 *    model — tens of seconds each. A spinner sitting silently for two minutes
 *    is indistinguishable from a hang, and the reader must be able to stop it.
 */

export type ChatTurn = {
  id: string;
  question: string;
  answer: string;
  status: string;
  citations: string[];
  toolsUsed?: string[];
  model?: string | null;
  durationMs?: number;
};

export function AgentChat({
  scopeNote,
  suggestions,
  initialTurns,
  modelHint,
  compact = false,
}: {
  /// Written by the server from the session's role — never inferred here.
  scopeNote: string;
  suggestions: string[];
  initialTurns: ChatTurn[];
  modelHint?: string;
  /**
   * Panel layout rather than page layout: the transcript scrolls in its own
   * pane and the composer stays pinned to the bottom. On the page the whole
   * document scrolls instead, which is right there and wrong in a drawer —
   * a reader mid-conversation should not have to scroll to reach the box.
   */
  compact?: boolean;
}) {
  const { run, cancel, pending } = useAbortable();

  const [turns, setTurns] = useState<ChatTurn[]>(initialTurns);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pending) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, pending]);

  async function submit(text: string) {
    const asked = text.trim();
    if (asked.length < 3 || pending) return;

    setError(null);
    setQuestion('');

    const outcome = await run(async (signal) => {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ question: asked }),
      });
      const payload = (await res.json().catch(() => ({}))) as ChatTurn & { error?: string };
      if (!res.ok || !payload.answer) {
        throw new Error(payload.error ?? 'The assistant could not answer. Nothing was saved.');
      }
      return payload;
    });

    if (outcome.status === 'cancelled') {
      // Deliberate. Put the question back so it is not lost.
      setQuestion(asked);
      return;
    }
    if (outcome.status === 'error') {
      setQuestion(asked);
      setError(outcome.error.message);
      return;
    }
    setTurns((prev) => [...prev, { ...outcome.value, question: asked }]);
  }

  return (
    <Box
      sx={
        compact
          ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }
          : undefined
      }
    >
      <Box
        sx={
          compact
            ? { flex: 1, minHeight: 0, overflowY: 'auto', px: 2.5, pt: 2.5 }
            : undefined
        }
      >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3, maxWidth: '68ch' }}>
        {scopeNote}
      </Typography>

      <Stack spacing={4} sx={{ mb: 4 }}>
        {turns.map((turn) => (
          <Box key={turn.id}>
            <Typography
              variant="subtitle2"
              sx={{ mb: 1, display: 'flex', gap: 1, alignItems: 'baseline' }}
            >
              <Box component="span" sx={{ color: 'text.disabled' }}>
                Asked
              </Box>
              {turn.question}
            </Typography>

            <Typography
              variant="body2"
              sx={{ whiteSpace: 'pre-wrap', maxWidth: '72ch', color: 'text.primary' }}
            >
              {turn.answer}
            </Typography>

            <Stack
              direction="row"
              spacing={0.75}
              sx={{ mt: 1.5, flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}
            >
              {turn.status === 'REFUSED' && (
                <Chip size="small" color="warning" variant="outlined" label="Out of scope" />
              )}
              {turn.status === 'EXHAUSTED' && (
                <Chip size="small" variant="outlined" label="Cut short" />
              )}
              {/* Records, not vibes. An answer citing nothing shows nothing.
                  Deduplicated on read as well as on write: rows saved before
                  the loop started deduping are still in the table, and a
                  repeated id here is a duplicate React key. */}
              {[...new Set(turn.citations)].map((id) => (
                <Chip
                  key={id}
                  size="small"
                  variant="outlined"
                  label={id}
                  sx={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.6875rem' }}
                />
              ))}
              {turn.citations.length === 0 && turn.status === 'ANSWERED' && (
                <Typography variant="caption" color="text.disabled">
                  No records cited
                </Typography>
              )}
            </Stack>
          </Box>
        ))}
        <div ref={bottom} />
      </Stack>

      {turns.length === 0 && suggestions.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mb: 3, flexWrap: 'wrap', gap: 1 }}>
          {suggestions.map((s) => (
            <Chip
              key={s}
              label={s}
              variant="outlined"
              onClick={() => submit(s)}
              disabled={pending}
              sx={{ height: 'auto', py: 0.75, '& .MuiChip-label': { whiteSpace: 'normal' } }}
            />
          ))}
        </Stack>
      )}

      </Box>

      <Box
        sx={
          compact
            ? { borderTop: 1, borderColor: 'divider', px: 2.5, py: 2, bgcolor: 'background.default' }
            : undefined
        }
      >
      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {pending && (
        <Box aria-live="polite" sx={{ mb: 2 }}>
          <LinearProgress
            // Indeterminate on purpose: the loop does not know in advance how
            // many records it will need to read.
            sx={{ mb: 1 }}
            aria-label="Reading REEP records"
          />
          <Typography variant="caption" color="text.secondary" className="tabular">
            {elapsed}s elapsed{modelHint ? ` · ${modelHint}` : ''}
          </Typography>
        </Box>
      )}

      <Box
        component="form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void submit(question);
        }}
        aria-busy={pending}
      >
        <Stack
          // The drawer is narrower than the `sm` breakpoint it would otherwise
          // be measured against — breakpoints read the viewport, not this box —
          // so compact stacks unconditionally.
          direction={compact ? 'column' : { xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: compact ? 'stretch' : 'flex-start' }}
        >
          <TextField
            // Named and identified so the field is a real form control rather
            // than an anonymous box — assistive tech and password managers both
            // key off these, and the drawer and the page each render one.
            id={compact ? 'agent-question-panel' : 'agent-question-page'}
            name="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            label="Ask about the REEP record"
            placeholder={suggestions[0] ?? 'Ask a question'}
            fullWidth
            multiline
            maxRows={4}
            disabled={pending}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention every
              // reader already has from every other chat box.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit(question);
              }
            }}
          />
          <Stack direction="row" spacing={1} sx={{ pt: { sm: 1 } }}>
            <Button
              type="submit"
              variant="contained"
              color="secondary"
              disabled={pending || question.trim().length < 3}
              startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              {pending ? 'Reading…' : 'Ask'}
            </Button>
            {pending && (
              <Button variant="outlined" onClick={cancel}>
                Cancel
              </Button>
            )}
          </Stack>
        </Stack>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
        Answers come from REEP&rsquo;s own records and cite the ones they used. Every question and
        answer is logged with the records it read.
      </Typography>
      </Box>
    </Box>
  );
}
