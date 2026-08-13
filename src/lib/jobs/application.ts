/**
 * The difference between going to look at a posting and saying you applied.
 *
 * The board has to record two things about a student and a vacancy, and the
 * schema gives it one row: `JobApplication` is unique on (studentId, jobId).
 * That row is the student's self-attestation — `selfReported` defaults to true
 * because the dashboard cannot see the employer's portal and never will. But
 * the "click to apply" column also has to record the intent, and writing an
 * attestation the moment someone opens a link would turn "I went to read it"
 * into "I applied" in a placement report.
 *
 * So the intent is stored in the same row, marked by `notes` holding exactly
 * `OPENED_NOTE`. One constant, one predicate, and every reader of the table
 * goes through them; the alternative — a second table, or a boolean the schema
 * stage owns — is a migration this stage is not entitled to make, and free text
 * that only *some* code recognises is how the two states drift apart.
 *
 * Un-ticking the box deletes the row rather than reverting it to an intent. It
 * has to: nothing distinguishes "I opened it and did not apply" from "I ticked
 * this by mistake", and the honest reading of a student clearing the box is
 * that REEP should hold nothing about them and this vacancy. Opening the
 * posting again records the intent afresh.
 *
 * Pure, so both the Server Action and the board's tests read one definition.
 */

/// The marker that says this row is an opened link and not a claim. Written
/// verbatim; matched verbatim.
export const OPENED_NOTE = 'Opened the employer posting from the REEP jobs board.';

/// Where a student stands with one posting.
export type ApplicationState =
  /// No row: never opened, never claimed.
  | 'none'
  /// The link was followed. REEP knows nothing more than that.
  | 'opened'
  /// The student has attested that they applied.
  | 'applied';

/// The row as this module needs it — `notes` is the only column that decides.
export type ApplicationRow = { notes: string | null };

/**
 * Rows written before this distinction existed, and rows written by the seed,
 * carry a null `notes` and read as `applied`. That is the safe direction: an
 * attestation misread as an intent would silently empty a student's applied
 * list, whereas an intent misread as an attestation cannot happen at all — only
 * this module writes `OPENED_NOTE`.
 */
export function applicationState(row: ApplicationRow | null | undefined): ApplicationState {
  if (!row) return 'none';
  return row.notes === OPENED_NOTE ? 'opened' : 'applied';
}

export function hasApplied(row: ApplicationRow | null | undefined): boolean {
  return applicationState(row) === 'applied';
}
