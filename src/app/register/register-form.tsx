'use client';

import { useActionState, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import PersonRounded from '@mui/icons-material/PersonRounded';

import { REGISTRATION_FIELD_LABEL, type RegistrationField } from '@/lib/registration/schema';

import { submitRegistrationAction, type RegisterState } from './actions';

/**
 * The whole application, in one client component.
 *
 * It is one component rather than three because the CV upload writes into the
 * same eleven boxes the form submits — the same reason `login-form.tsx` keeps
 * its demo-account buttons beside its fields. Splitting them would mean lifting
 * every value into a parent for no gain.
 *
 * Every field is controlled, which is a bug fix rather than a preference and the
 * same one `profile-form.tsx` documents: React resets uncontrolled inputs once a
 * form action returns, and returning `{ errors }` is an ordinary return. An
 * applicant who mistyped their phone number would otherwise get the whole form
 * wiped, including whatever the CV had filled in for them.
 */

type Values = Record<RegistrationField, string>;

const EMPTY: Values = {
  name: '',
  email: '',
  phone: '',
  degreeLevel: 'PG',
  programme: '',
  branch: '',
  usn: '',
  linkedinUrl: '',
  city: '',
};

/// What the CV endpoint hands back. Kept as a type here rather than shared with
/// the route so the client never imports a module that pulls pdfjs in behind it.
type CvResponse = {
  token: string;
  fileName: string;
  fields: Partial<Values>;
  skills: string[];
  missing: RegistrationField[];
  missingLabels?: string[];
  note: string;
  autofilled: boolean;
  error?: string;
};

export function RegisterForm() {
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(
    submitRegistrationAction,
    {},
  );

  const [values, setValues] = useState<Values>(EMPTY);
  const [token, setToken] = useState('');

  const cvInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [cvBusy, setCvBusy] = useState(false);
  const [cvName, setCvName] = useState<string | null>(null);
  const [cvNote, setCvNote] = useState<string | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [filled, setFilled] = useState<RegistrationField[]>([]);
  const [stillMissing, setStillMissing] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);

  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const bind = (field: RegistrationField) => ({
    value: values[field],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value })),
    error: Boolean(state.errors?.[field]),
    helperText: state.errors?.[field],
  });

  async function uploadCv(file: File) {
    setCvBusy(true);
    setCvError(null);
    setCvNote(null);

    const body = new FormData();
    body.set('file', file);
    if (token) body.set('token', token);

    try {
      const response = await fetch('/api/register/cv', { method: 'POST', body });
      const payload = (await response.json()) as CvResponse;

      if (!response.ok) {
        setCvError(payload.error ?? 'That upload did not go through.');
        return;
      }

      setToken(payload.token);
      setCvName(payload.fileName);
      setCvNote(payload.note);
      setSkills(payload.skills ?? []);
      setStillMissing(payload.missingLabels ?? payload.missing.map((f) => REGISTRATION_FIELD_LABEL[f]));

      // Only fill boxes the applicant has not already typed in. A CV is a
      // suggestion; something they typed is an answer, and overwriting it would
      // be the auto-filler deciding it knows better.
      const proposed = payload.fields;
      const touched: RegistrationField[] = [];
      setValues((current) => {
        const next = { ...current };
        for (const [key, value] of Object.entries(proposed) as [RegistrationField, string][]) {
          if (!value) continue;
          if (next[key] && next[key] !== EMPTY[key]) continue;
          next[key] = value;
          touched.push(key);
        }
        return next;
      });
      setFilled(touched);
    } catch {
      setCvError('Could not reach the server. Check your connection and try again.');
    } finally {
      setCvBusy(false);
    }
  }

  async function uploadPhoto(file: File) {
    setPhotoBusy(true);
    setPhotoError(null);

    const body = new FormData();
    body.set('file', file);
    if (token) body.set('token', token);

    try {
      const response = await fetch('/api/register/photo', { method: 'POST', body });
      const payload = (await response.json()) as { token: string; fileName: string; sizeLabel: string; error?: string };
      if (!response.ok) {
        setPhotoError(payload.error ?? 'That photo did not go through.');
        return;
      }
      setToken(payload.token);
      setPhotoName(`${payload.fileName} · ${payload.sizeLabel}`);
    } catch {
      setPhotoError('Could not reach the server. Check your connection and try again.');
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <Box component="form" action={formAction}>
      <input type="hidden" name="uploadToken" value={token} />

      {/* --- CV, first, because it fills the rest ------------------------ */}
      <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
        Start from your CV
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Optional. We read the text out of it and fill in what we can find — you check
        every box before it is submitted. Skip this and fill the form in yourself; it
        makes no difference to how your application is treated.
      </Typography>

      <Box
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDragging(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) void uploadCv(dropped);
        }}
        onClick={() => cvInput.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') cvInput.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Choose a CV to upload"
        sx={{
          border: 1,
          borderStyle: 'dashed',
          borderColor: dragging ? 'text.secondary' : 'divider',
          bgcolor: dragging ? 'action.hover' : 'background.paper',
          borderRadius: 2,
          p: { xs: 3, sm: 4 },
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'border-color 150ms, background-color 150ms',
          '&:hover': { borderColor: 'text.disabled' },
        }}
      >
        <input
          ref={cvInput}
          type="file"
          hidden
          accept=".pdf,.docx"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) void uploadCv(chosen);
          }}
        />
        <Stack spacing={0.75} sx={{ alignItems: 'center' }}>
          <DescriptionRounded fontSize="small" color="disabled" />
          {cvBusy ? (
            <>
              <CircularProgress size={18} />
              <Typography variant="subtitle1">Reading your CV…</Typography>
            </>
          ) : cvName ? (
            <>
              <Typography variant="subtitle1">{cvName}</Typography>
              <Typography variant="caption" color="text.secondary">
                Click to replace it with a different file
              </Typography>
            </>
          ) : (
            <>
              <Typography variant="subtitle1">Drag your CV here, or click to browse</Typography>
              <Typography variant="caption" color="text.secondary">
                PDF or DOCX · up to 10 MB
              </Typography>
            </>
          )}
        </Stack>
      </Box>

      {cvError ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {cvError}
        </Alert>
      ) : null}

      {cvNote ? (
        <Alert severity="info" sx={{ mt: 2 }}>
          <Typography variant="body2">{cvNote}</Typography>
          {filled.length > 0 ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              Filled from your CV: {filled.map((field) => REGISTRATION_FIELD_LABEL[field]).join(', ')}.
            </Typography>
          ) : null}
          {stillMissing.length > 0 ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Still yours to fill in: {stillMissing.join(', ')}.
            </Typography>
          ) : null}
          {skills.length > 0 ? (
            <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {skills.slice(0, 12).map((skill) => (
                <Chip key={skill} label={skill} size="small" variant="outlined" />
              ))}
            </Box>
          ) : null}
        </Alert>
      ) : null}

      {/* --- The form itself --------------------------------------------- */}
      <Box sx={{ mt: 4, pt: 3.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
          About you
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
          Use the email address the college has on file for you if you have one — an
          application from a college address that matches an open intake is approved
          the moment you confirm it.
        </Typography>

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField fullWidth required name="name" label="Full name" autoComplete="name" {...bind('name')} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              required
              name="email"
              type="email"
              label="Email address"
              autoComplete="email"
              placeholder="you@bgscet.ac.in"
              {...bind('email')}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              required
              name="phone"
              type="tel"
              label="Phone"
              autoComplete="tel"
              placeholder="+91 98860 41125"
              {...bind('phone')}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField fullWidth required name="city" label="City" {...bind('city')} placeholder="Bengaluru" />
          </Grid>

          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField select fullWidth required name="degreeLevel" label="Degree level" {...bind('degreeLevel')}>
              <MenuItem value="PG">Postgraduate</MenuItem>
              <MenuItem value="UG">Undergraduate</MenuItem>
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField fullWidth required name="programme" label="Programme" placeholder="MBA" {...bind('programme')} />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField
              fullWidth
              required
              name="branch"
              label="Branch or specialisation"
              placeholder="Finance & Marketing"
              {...bind('branch')}
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="usn"
              label="USN (if you have one)"
              placeholder="1BG24MBA001"
              {...bind('usn')}
              helperText={state.errors?.usn ?? 'Leave this blank if the college has not issued yours yet.'}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              name="linkedinUrl"
              label="LinkedIn profile"
              placeholder="linkedin.com/in/your-handle"
              {...bind('linkedinUrl')}
              helperText={state.errors?.linkedinUrl ?? 'Optional. Shown on your REEP profile and resume header.'}
            />
          </Grid>
        </Grid>
      </Box>

      {/* --- Photo -------------------------------------------------------- */}
      <Box sx={{ mt: 4, pt: 3.5, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>
          Professional photo
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Optional. A clear head-and-shoulders picture, which becomes your profile photo
          if your application is approved. Nobody sees it before then except the
          programme office.
        </Typography>

        <input
          ref={photoInput}
          type="file"
          hidden
          accept=".png,.jpg,.jpeg,.webp"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) void uploadPhoto(chosen);
          }}
        />

        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Button
            type="button"
            variant="outlined"
            onClick={() => photoInput.current?.click()}
            disabled={photoBusy}
            startIcon={photoBusy ? <CircularProgress size={16} /> : <PersonRounded />}
          >
            {photoBusy ? 'Uploading…' : photoName ? 'Choose a different photo' : 'Choose a photo'}
          </Button>
          {photoName ? (
            <Typography variant="body2" color="text.secondary">
              {photoName}
            </Typography>
          ) : null}
        </Stack>

        {photoError ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {photoError}
          </Alert>
        ) : null}
      </Box>

      {state.error ? (
        <Alert severity="error" sx={{ mt: 3 }}>
          {state.error}
        </Alert>
      ) : null}
      {state.errors && Object.keys(state.errors).length > 0 ? (
        <Alert severity="warning" sx={{ mt: 3 }}>
          Some answers need another look — the boxes above say which.
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mt: 3.5, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          type="submit"
          variant="contained"
          color="secondary"
          size="large"
          disabled={pending || cvBusy}
          startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
          sx={{ minHeight: 46 }}
        >
          {pending ? 'Submitting…' : 'Submit application'}
        </Button>
        <Typography variant="caption" color="text.disabled" sx={{ maxWidth: '46ch' }}>
          We email you a link to confirm the address. Nothing is decided until you click
          it — the link works once and lasts 24 hours.
        </Typography>
      </Stack>
    </Box>
  );
}
