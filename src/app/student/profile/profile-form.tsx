'use client';

import { useActionState, useState, type ChangeEvent } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import {
  saveProfileAction,
  setLeaderboardOptOutAction,
  type LeaderboardVisibilityState,
  type ProfileState,
} from './actions';
import { LIST_FIELDS, LIST_SPEC } from './json-lists';

export type ProfileDefaults = {
  phone: string;
  email: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  city: string;
  careerSummary: string;
  /// Already flattened to one-entry-per-line text by the page.
  lists: Record<string, string>;
  /// `StudentProfile.leaderboardOptOut`, when the page has read it.
  ///
  /// Optional, and the control below is built so that not knowing it is safe
  /// rather than merely tolerable: it never posts a value the student did not
  /// choose, so an unsupplied flag costs a line of copy on first render and
  /// nothing else. A required prop here would have been the wrong trade — this
  /// is the one field where guessing wrong puts a student back on a board they
  /// removed themselves from.
  leaderboardOptOut?: boolean;
};

export function ProfileForm({ defaults }: { defaults: ProfileDefaults }) {
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveProfileAction,
    {},
  );

  /**
   * Every field is controlled, and that is a bug fix rather than a preference.
   *
   * React resets uncontrolled fields once a form action returns, and returning
   * `{ error }` is an ordinary return — not a throw. So a student who filled in
   * the career summary and the four pipe-delimited list boxes, then mistyped
   * their email, got the whole form wiped and an error about one character they
   * could no longer see. Nothing had been saved server-side either.
   */
  const [text, setText] = useState({
    phone: defaults.phone ?? '',
    email: defaults.email ?? '',
    city: defaults.city ?? '',
    linkedinUrl: defaults.linkedinUrl ?? '',
    githubUrl: defaults.githubUrl ?? '',
    portfolioUrl: defaults.portfolioUrl ?? '',
    careerSummary: defaults.careerSummary ?? '',
  });
  const [lists, setLists] = useState<Record<string, string>>(() =>
    Object.fromEntries(LIST_FIELDS.map((f) => [f, defaults.lists[f] ?? ''])),
  );

  const bind = (key: keyof typeof text) => ({
    value: text[key],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setText((current) => ({ ...current, [key]: event.target.value })),
  });

  return (
    <>
      <Box component="form" action={formAction}>
        <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
          How to reach you
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          These sit in the header of every resume you generate.
        </Typography>

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="phone"
              type="tel"
              label="Phone"
              autoComplete="tel"
              {...bind('phone')}
              placeholder="+91 98xxx xxxxx"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="email"
              type="email"
              label="Contact email"
              autoComplete="email"
              {...bind('email')}
              placeholder="you@example.com"
              helperText="The address a recruiter should write to."
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="city"
              label="City"
              {...bind('city')}
              placeholder="Bengaluru, Karnataka"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="linkedinUrl"
              label="LinkedIn"
              {...bind('linkedinUrl')}
              placeholder="linkedin.com/in/your-handle"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="githubUrl"
              label="GitHub"
              {...bind('githubUrl')}
              placeholder="github.com/your-handle"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="portfolioUrl"
              label="Portfolio or website"
              {...bind('portfolioUrl')}
              placeholder="your-site.com"
            />
          </Grid>
        </Grid>

        <TextField
          fullWidth
          multiline
          rows={3}
          name="careerSummary"
          label="Career summary"
          {...bind('careerSummary')}
          placeholder="MBA candidate at BGSCET focused on retail analytics…"
          helperText="Two or three sentences on where you are headed. The builder rewrites this against the job description rather than inventing one from nothing."
          sx={{ mt: 2.5 }}
        />

        <Box sx={{ mt: 4, pt: 3, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
            Everything REEP cannot see
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Write one entry per line and separate the columns with a pipe character (
            <code>|</code>). The order of the columns is written under each box. Leave a column
            empty if it does not apply, but keep the pipes in place.
          </Typography>

          <Stack spacing={3}>
            {LIST_FIELDS.map((field) => {
              const spec = LIST_SPEC[field];
              return (
                <TextField
                  key={field}
                  fullWidth
                  multiline
                  rows={spec.rows}
                  name={field}
                  label={spec.label}
                  value={lists[field] ?? ''}
                  onChange={(event) =>
                    setLists((current) => ({ ...current, [field]: event.target.value }))
                  }
                  spellCheck={false}
                  helperText={`One per line: ${spec.format}. For example — ${spec.example}`}
                />
              );
            })}
          </Stack>
        </Box>

        <Stack
          direction="row"
          sx={{ mt: 3, gap: 2, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Button type="submit" variant="contained" color="secondary" disabled={pending}>
            {pending ? 'Saving…' : 'Save profile'}
          </Button>

          {state.ok && !pending ? (
            <Typography role="status" variant="body2" color="success.dark">
              Saved
              {state.savedAt
                ? ` at ${new Date(state.savedAt).toLocaleTimeString('en-IN', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`
                : ''}
              . Your next resume draft will use this.
            </Typography>
          ) : null}
        </Stack>

        {state.error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {state.error}
          </Alert>
        ) : null}
      </Box>

      {/* A sibling form, not a nested one — nested forms are invalid HTML, and
          keeping the two apart is also what stops a leaderboard preference
          riding along with every "Save profile". */}
      <LeaderboardVisibility current={defaults.leaderboardOptOut} />
    </>
  );
}

/**
 * Whether this student appears on the cohort leaderboards.
 *
 * Two explicit buttons rather than a checkbox, for one reason: a checkbox has
 * to be rendered pre-ticked or pre-unticked, so it needs the stored value
 * before it can be shown honestly, and a control that is wrong on first paint
 * is a control that opts people back in by accident. Two buttons state an
 * intent instead of reporting a state, so this works correctly whether or not
 * the page has told it what the flag currently is — and the moment either one
 * is pressed, the server's answer is what is displayed.
 *
 * The wording is deliberately about visibility to *others*. Opting out does not
 * cost the student their own standing — `leaderboard-scope.ts` keeps showing it
 * to them — and a student who believes otherwise will not use the control.
 */
function LeaderboardVisibility({ current }: { current?: boolean }) {
  const [state, formAction, pending] = useActionState<LeaderboardVisibilityState, FormData>(
    setLeaderboardOptOutAction,
    { optOut: current },
  );

  // The action's answer wins; `current` is only the opening position.
  const optOut = state.optOut ?? current;

  return (
    <Box
      component="form"
      action={formAction}
      sx={{ mt: 4, pt: 3, borderTop: 1, borderColor: 'divider' }}
    >
      <Typography variant="h4" component="h3" sx={{ mb: 0.5 }}>
        Leaderboards
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '72ch' }}>
        Your cohort has five boards — sign-in streak, certificates, verified skills, mocks
        taken and VTU results. Classmates only ever see your name, your position and a coarse
        band on them: never your USN, your marks, your attendance or the title of anything you
        have uploaded.{' '}
        <Link href="/student/leaderboards">Look at the boards</Link>.
      </Typography>

      <Typography variant="body2" sx={{ mb: 2, fontWeight: 500 }} role="status">
        {optOut == null
          ? 'Choose whether your classmates see you on the boards.'
          : optOut
            ? 'You are hidden from every leaderboard. You still see your own position on all five.'
            : 'You appear on your cohort’s leaderboards.'}
      </Typography>

      <Stack direction="row" sx={{ gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          type="submit"
          name="optOut"
          value="false"
          variant={optOut === false ? 'contained' : 'outlined'}
          color="secondary"
          disabled={pending || optOut === false}
        >
          Show me on the boards
        </Button>
        <Button
          type="submit"
          name="optOut"
          value="true"
          variant={optOut === true ? 'contained' : 'outlined'}
          color="secondary"
          disabled={pending || optOut === true}
        >
          Hide me from the boards
        </Button>

        {pending ? (
          <Typography variant="body2" color="text.secondary">
            Saving…
          </Typography>
        ) : null}
      </Stack>

      {state.error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {state.error}
        </Alert>
      ) : null}
    </Box>
  );
}
