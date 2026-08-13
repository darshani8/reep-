'use client';

import { useActionState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { StatusChip } from '@/components/status-chip';
import type { RuleRow } from '@/lib/registration/queries';

import { toggleRuleAction, type DecisionState } from './actions';

/**
 * What is currently deciding, and the two switches on it.
 *
 * This panel is the answer to "never hard-code the domain list in a component or
 * an env var". The rows come from `RegistrationRule`; nothing on this screen
 * knows what a college domain looks like, and a new intake is a row rather than a
 * deploy.
 *
 * Only `enabled` and `autoApprove` are editable, and that is a judgement rather
 * than an oversight — see the docblock on `toggleRuleAction`. A regex typed into
 * a queue screen stops matching silently, and the failure shows up a fortnight
 * later as applications quietly piling up for review.
 *
 * The conditions are spelled out per row in words, because the point of the AND
 * is lost if a reader has to infer it from two columns sitting next to each
 * other.
 */
export function RulePanel({ rules }: { rules: RuleRow[] }) {
  const [state, formAction, pending] = useActionState<DecisionState, FormData>(toggleRuleAction, {});

  if (rules.length === 0) {
    return (
      <Alert severity="warning">
        No registration rules exist, so every application that confirms its address lands
        in the queue above. That is a safe default and a slow one.
      </Alert>
    );
  }

  return (
    <Box component="form" action={formAction}>
      {state.error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {state.error}
        </Alert>
      ) : null}
      {state.message ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          {state.message}
        </Alert>
      ) : null}

      <Stack spacing={0}>
        {rules.map((rule) => (
          <Box
            key={rule.id}
            sx={{
              py: 2,
              borderBottom: 1,
              borderColor: 'divider',
              display: 'flex',
              gap: 2,
              alignItems: 'flex-start',
              flexWrap: 'wrap',
              opacity: rule.enabled ? 1 : 0.55,
              '&:last-of-type': { borderBottom: 0 },
            }}
          >
            <Box sx={{ minWidth: 0, flex: '1 1 340px' }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="subtitle1">{rule.name}</Typography>
                <StatusChip
                  tone={rule.enabled ? (rule.autoApprove ? 'good' : 'warning') : 'neutral'}
                  label={
                    !rule.enabled
                      ? 'Switched off'
                      : rule.autoApprove
                        ? 'Approves automatically'
                        : 'Sends to this queue'
                  }
                />
                <Typography variant="caption" color="text.disabled" className="tabular">
                  priority {rule.priority}
                </Typography>
              </Stack>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {describe(rule)}
              </Typography>
              {rule.cohortName ? (
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
                  Places matches on {rule.cohortName}.
                </Typography>
              ) : (
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
                  Names no cohort, so a match still needs someone to choose one.
                </Typography>
              )}
            </Box>

            <Stack direction="row" spacing={1} sx={{ flexShrink: 0, flexWrap: 'wrap' }}>
              <Button
                type="submit"
                size="small"
                name="field"
                value="enabled"
                disabled={pending}
                onClick={(event) => {
                  // The rule id travels with the click rather than as a field,
                  // so one form can carry every row without a hidden input per
                  // button fighting over the same name.
                  const form = event.currentTarget.form;
                  if (form) (form.elements.namedItem('ruleId') as HTMLInputElement).value = rule.id;
                }}
              >
                {rule.enabled ? 'Switch off' : 'Switch on'}
              </Button>
              <Button
                type="submit"
                size="small"
                name="field"
                value="autoApprove"
                disabled={pending || !rule.enabled}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  if (form) (form.elements.namedItem('ruleId') as HTMLInputElement).value = rule.id;
                }}
              >
                {rule.autoApprove ? 'Send to queue instead' : 'Approve automatically'}
              </Button>
            </Stack>
          </Box>
        ))}
      </Stack>

      <input type="hidden" name="ruleId" defaultValue="" />
    </Box>
  );
}

/**
 * The rule's conditions as a sentence.
 *
 * "and" rather than a comma, deliberately: the two halves of "within specified
 * domains" — the address and the programme — are an AND, and a director changing
 * one needs to see that the other still applies.
 */
function describe(rule: RuleRow): string {
  const clauses: string[] = [];
  if (rule.emailDomain) clauses.push(`the address ends in @${rule.emailDomain}`);
  if (rule.degreeLevel) clauses.push(`the applicant is ${rule.degreeLevel}`);
  if (rule.usnPattern) clauses.push(`the USN matches ${rule.usnPattern}`);
  if (clauses.length === 0) return 'Matches every application — the catch-all.';
  return `Matches when ${clauses.join(', and ')}.`;
}
