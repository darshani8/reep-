/**
 * What the agent tells the reader about itself.
 *
 * Two surfaces now render this — the full page and the floating panel — and a
 * third will exist the moment someone embeds it anywhere else. The scope line
 * is a promise about what the agent can and cannot read, so it must not be able
 * to say one thing in the drawer and another on the page. One definition, and
 * both import it.
 *
 * Pure, with no `server-only` import, so the route handler and the client panel
 * can both reach it.
 */

import type { ScopeKind } from './types';

export function scopeNote(kind: ScopeKind): string {
  switch (kind) {
    case 'self':
      return 'Ask about your own REEP record — progress, certifications, hours, attendance, alerts. This agent can read your record and no one else’s; asking about another student returns a refusal, not their data.';
    // A mentor's line has to say the limit out loud. Promising "any student" and
    // then refusing the third question reads as a broken assistant rather than
    // a scoped one, and the mentor has no way to tell which it was.
    case 'mentees':
      return 'Ask about the students assigned to you as their mentor — progress, certifications, hours, attendance, alerts and mentor notes. This agent reads your mentor group and no one else; programme-wide analytics are the director’s report.';
    default:
      return 'Ask about any student or the programme as a whole — progress, certifications, hours, attendance, alerts, mentor notes and cohort analytics. Name a student by USN, or search by name, stage or risk.';
  }
}

export function suggestions(kind: ScopeKind): string[] {
  switch (kind) {
    case 'self':
      return [
        'Am I on track to finish REEP before the cohort deadline?',
        'Which of my certifications are overdue, and which should I do first?',
        'When during the day do I actually get the most out of my study hours?',
      ];
    // Deliberately none about cohorts or the programme: a suggestion chip is a
    // promise that the question will be answered, and those two would be
    // refused.
    case 'mentees':
      return [
        'Which of my mentees are at risk right now, and what fired for each of them?',
        'Who in my mentor group has overdue certifications?',
        'Which of my mentees has not logged any hours this week?',
      ];
    default:
      return [
        'Which students are at risk right now, and what fired for each of them?',
        'Which courses are the biggest bottlenecks this term?',
        'How does the placement-ready share differ between cohorts?',
      ];
  }
}
