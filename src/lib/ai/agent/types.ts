/**
 * The shapes the loop passes around.
 *
 * Kept free of `server-only` imports so the client chat panel can import the
 * answer type without dragging Prisma into the browser bundle.
 */

export type AgentStatus = 'ANSWERED' | 'EXHAUSTED' | 'REFUSED' | 'FAILED';

/**
 * How wide a run's data access is.
 *
 * Declared here rather than in `scope.ts` because the client chat panel needs
 * it to render the right copy, and `scope.ts` is `server-only` — importing it
 * from the browser graph throws by design. `scope.ts` re-exports this, so
 * server callers still get it from where they expect.
 *
 * These strings are also *stored*: `store.ts` stamps `scope.kind` onto
 * `AgentRun.scope`, which is a plain `String` column. So a value here can be
 * added but never renamed or reused — rows written before `mentees` existed
 * still say `programme` for the mentors who now resolve to `mentees`, and an
 * audit reader has to be able to take those at face value.
 */
export type ScopeKind = 'self' | 'mentees' | 'programme';

/**
 * What one model call decided.
 *
 * Flat, with empty strings rather than a discriminated union, because a 12B
 * model handles `{"tool": "", "answer": "..."}` far more reliably than nested
 * variants — the same reason the resume schema is flat. `kind` is derived here
 * after parsing, not asked of the model.
 */
export type Decision =
  | { kind: 'call'; reasoning: string; tool: string; args: Record<string, unknown> }
  | { kind: 'answer'; reasoning: string; answer: string; citations: string[] };

/**
 * One turn of the loop, as recorded in the trace.
 *
 * `denied` is separate from `error` on purpose: a tool that refused an
 * out-of-scope lookup did its job, and an administrator reading the log needs
 * to see that distinctly from a tool that broke.
 */
export type AgentStep = {
  tool: string;
  args: Record<string, unknown>;
  /// Citable id for whatever this step returned, e.g. `certifications#1BG24MBA001`.
  factId?: string;
  /// Compact text handed back to the model. Never raw JSON — see tools.ts.
  digest?: string;
  denied?: boolean;
  error?: string;
  ms: number;
};

export type AgentAnswer = {
  id: string;
  status: AgentStatus;
  answer: string;
  citations: string[];
  /// Tool names in the order they ran, for the "what it read" line under the
  /// reply. The full trace stays server-side.
  toolsUsed: string[];
  scope: ScopeKind;
  model: string | null;
  steps: number;
  durationMs: number;
};
