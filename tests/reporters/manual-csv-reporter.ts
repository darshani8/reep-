/**
 * Writes `manual-test-results.csv`: one row per manual test case in
 * test-management/manual-test-cases.md, carrying the result of the automated
 * test tagged with its ID.
 *
 * WHY THIS IS A FILE AND NOT A DEPENDENCY. The brief named the npm package
 * `playwright-csv-reporter`, and no package by that name exists on the public
 * registry (a 404 on 2026-09-22, with nothing similar under another name). Do
 * not "fix" this by installing whatever someone publishes under that name
 * later: a reporter runs in-process on every test run, and a name nobody owned
 * when this was written is exactly the name a typosquatter registers.
 *
 * WHAT IT ENFORCES, and why a reporter is the place. The link between the
 * suites is a `@TC-NNN` tag in a test's title (see the manual file's "How the
 * manual and automated suites stay linked"), and a convention nobody checks
 * lasts until the first rename. So the run FAILS, through `onEnd`'s status
 * override, when:
 *   - a test carries no `@TC-NNN` tag, or names a case the manual file lacks;
 *   - a test's top-level `test.step()` titles differ from its case's numbered
 *     steps (numbering and markdown aside), which is what makes the "Failed
 *     step" column mean the same step a tester would follow by hand;
 *   - a case's "Automated test" field says it is not automated while a test
 *     automates it, or the manual file repeats an ID.
 * A case with no automated test in the run is a ROW, not a failure: "Not
 * automated" when its field says so, "Not run" when a filter such as `--grep`
 * left its test out.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

export interface ManualCsvReporterOptions {
  /** Where the CSV is written, relative to the Playwright config file. */
  outputFile?: string;
  /** The manual test cases, relative to the Playwright config file. */
  manualCases?: string;
  /** Set by Playwright itself, not by the config: `'list'` under `--list`. */
  _mode?: string;
}

export interface ManualCase {
  id: string;
  title: string;
  /** From the case's "Automated test" field: does it name a `@TC-NNN` tag? */
  automated: boolean;
  steps: string[];
}

const COLUMNS = [
  'Test Case ID',
  'Manual Test Case',
  'Automated Test',
  'Project',
  'Status',
  'Duration (ms)',
  'Failed Step',
  'Error',
  'Manual-only Checks',
  'Screenshots',
  'Location',
  'Executed At',
] as const;

type Row = Partial<Record<(typeof COLUMNS)[number], string | number>>;

/** `## TC-001 — Title`. Any dash, or a colon, may separate the two. */
const CASE_HEADING = /^##\s+(TC-\d+)\s*[—–:-]\s*(.+?)\s*$/;
const CASE_TAG = /^@(TC-\d+)$/;
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Reads the cases out of the manual file: the `## TC-NNN — Title` heading, the
 * "Automated test" row of its field table, and the numbered list under its
 * "### Steps" heading. Any other level-2 heading ends the case.
 */
export function parseManualCases(markdown: string): ManualCase[] {
  const cases: ManualCase[] = [];
  let current: ManualCase | undefined;
  let section = '';
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = CASE_HEADING.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2], automated: false, steps: [] };
      cases.push(current);
      section = '';
      continue;
    }
    if (/^##\s/.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const subheading = /^###\s+(.+)$/.exec(line);
    if (subheading) {
      section = subheading[1].trim().toLowerCase();
      continue;
    }
    const field = /^\|\s*Automated test\s*\|\s*(.*?)\s*\|$/i.exec(line);
    if (field) {
      current.automated = /@TC-\d+/.test(field[1]);
      continue;
    }
    if (section !== 'steps') continue;
    const item = /^\d+\.\s+(.*)$/.exec(line);
    if (item) {
      current.steps.push(item[1]);
    } else if (/^\s+\S/.test(line) && current.steps.length > 0) {
      // A list item wrapped onto an indented continuation line.
      current.steps[current.steps.length - 1] += ` ${line.trim()}`;
    }
  }
  return cases;
}

/** A step as a sentence: no list number, markdown emphasis or closing full stop. */
export function normalizeStep(text: string): string {
  return text
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:]$/, '');
}

/**
 * One CSV field, RFC 4180 quoted. A string starting with a formula character
 * is prefixed with an apostrophe, because Excel and Sheets would otherwise run
 * `=...`, `+...`, `-...` or `@...` found in an error message as a formula.
 */
export function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function caseIdsOf(test: TestCase): string[] {
  const ids = test.tags.map((tag) => CASE_TAG.exec(tag)?.[1]).filter((id): id is string => !!id);
  return [...new Set(ids)];
}

function statusOf(test: TestCase, result: TestResult | undefined): string {
  if (!result) return 'Not run';
  if (result.status === 'interrupted') return 'Interrupted';
  if (result.status !== 'passed' && result.annotations.some((a) => a.type === 'blocked')) {
    return 'Blocked';
  }
  switch (test.outcome()) {
    case 'expected':
      return 'Passed';
    case 'flaky':
      return 'Flaky';
    case 'skipped':
      return 'Skipped';
    case 'unexpected':
      return result.status === 'timedOut' ? 'Timed out' : 'Failed';
  }
}

export default class ManualCsvReporter implements Reporter {
  private readonly outputFile: string;
  private readonly manualCases: string;
  /**
   * `playwright test --list` runs no test but still ends with `onEnd`. Writing
   * then would replace the last real run's results with a column of "Not run",
   * so a listing only checks the links. `_mode` is Playwright's internal
   * option. If it is ever renamed, listing writes those "Not run" rows again,
   * which is untidy but never claims a result nobody produced.
   */
  private readonly listOnly: boolean;
  private configDir = process.cwd();
  private rootSuite: Suite | undefined;

  constructor(options: ManualCsvReporterOptions = {}) {
    this.outputFile = options.outputFile ?? 'manual-test-results.csv';
    this.manualCases = options.manualCases ?? 'test-management/manual-test-cases.md';
    this.listOnly = options._mode === 'list';
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    if (config.configFile) this.configDir = path.dirname(config.configFile);
    this.rootSuite = suite;
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | undefined> {
    const problems: string[] = [];
    const manualPath = path.resolve(this.configDir, this.manualCases);
    let cases: ManualCase[] = [];
    try {
      cases = parseManualCases(fs.readFileSync(manualPath, 'utf8'));
    } catch (error) {
      problems.push(
        `cannot read the manual test cases at ${manualPath}: ${(error as Error).message}`,
      );
    }
    const seen = new Set<string>();
    for (const c of cases) {
      if (seen.has(c.id)) problems.push(`${this.manualCases} lists ${c.id} more than once`);
      seen.add(c.id);
    }
    const caseById = new Map(cases.map((c) => [c.id, c]));

    const testsByCase = new Map<string, TestCase[]>();
    const unlinked: Row[] = [];
    for (const test of this.rootSuite?.allTests() ?? []) {
      const ids = caseIdsOf(test);
      if (ids.length === 0) {
        problems.push(`${this.where(test)} has no @TC-NNN tag in its title`);
        unlinked.push(this.row(test, undefined));
        continue;
      }
      for (const id of ids) {
        const manual = caseById.get(id);
        if (!manual) {
          problems.push(
            `${this.where(test)} is tagged @${id}, which is not a case in ${this.manualCases}`,
          );
          unlinked.push(this.row(test, id));
          continue;
        }
        if (!manual.automated) {
          problems.push(
            `${id}'s "Automated test" field says it is not automated, but ${this.where(test)} automates it`,
          );
        }
        if (ids.length === 1 && !this.listOnly) problems.push(...this.stepDrift(test, manual));
        testsByCase.set(id, [...(testsByCase.get(id) ?? []), test]);
      }
    }

    const rows: Row[] = [];
    for (const manual of cases) {
      const tests = testsByCase.get(manual.id) ?? [];
      if (tests.length === 0) {
        rows.push({
          'Test Case ID': manual.id,
          'Manual Test Case': manual.title,
          Status: manual.automated ? 'Not run' : 'Not automated',
        });
        continue;
      }
      for (const test of tests) rows.push(this.row(test, manual.id, manual.title));
    }
    rows.push(...unlinked);
    if (!this.listOnly) this.write(rows);

    if (problems.length === 0) return undefined;
    console.error(`\nThe automated tests and ${this.manualCases} are out of sync:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return result.status === 'passed' ? { status: 'failed' } : undefined;
  }

  private write(rows: Row[]): void {
    const outputPath = path.resolve(this.configDir, this.outputFile);
    const lines = [
      COLUMNS.map(csvCell).join(','),
      ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(',')),
    ];
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(String(r.Status), (counts.get(String(r.Status)) ?? 0) + 1);
    const summary = [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
    console.log(
      `\n${path.relative(process.cwd(), outputPath) || outputPath}: ${rows.length} rows (${summary})`,
    );
  }

  /** Compares the steps that RAN: a test that failed at step 3 never reached
   *  step 4, and that is a failure, not drift. Only a passing test must have
   *  run every step. */
  private stepDrift(test: TestCase, manual: ManualCase): string[] {
    const result = test.results.at(-1);
    if (!result) return [];
    const ran = result.steps
      .filter((s) => s.category === 'test.step')
      .map((s) => normalizeStep(s.title));
    const expected = manual.steps.map(normalizeStep);
    for (let i = 0; i < ran.length; i++) {
      if (ran[i] !== expected[i]) {
        return [
          `${manual.id} step ${i + 1}: the manual file says "${expected[i] ?? '(no such step)'}", ` +
            `${this.where(test)} says "${ran[i]}"`,
        ];
      }
    }
    if (result.status === 'passed' && ran.length !== expected.length) {
      return [
        `${manual.id} has ${expected.length} steps in the manual file, ${this.where(test)} ran ${ran.length}`,
      ];
    }
    return [];
  }

  private row(test: TestCase, id: string | undefined, manualTitle?: string): Row {
    const result = test.results.at(-1);
    const status = statusOf(test, result);
    const failed = result?.steps.find((s) => s.error);
    const error = result?.error?.message ?? result?.error?.value;
    const screenshots = (result?.attachments ?? [])
      .filter((a) => a.name === 'screenshot' && a.path)
      .map((a) => path.relative(this.configDir, a.path!).split(path.sep).join('/'));
    return {
      'Test Case ID': id ?? '',
      'Manual Test Case': manualTitle ?? `(not in ${this.manualCases})`,
      // Root, project and file titles are dropped: the Project and Location columns carry them.
      'Automated Test': test.titlePath().slice(3).join(' > '),
      Project: test.parent.project()?.name ?? '',
      Status: status,
      'Duration (ms)': result?.duration,
      'Failed Step': status === 'Blocked' ? 'Pre-conditions' : failed?.title,
      Error: error?.replace(ANSI, '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      'Manual-only Checks': (result?.annotations ?? test.annotations)
        .filter((a) => a.type === 'manual-only')
        .map((a) => a.description ?? '')
        .join('; '),
      Screenshots: screenshots.join(' | '),
      Location: this.where(test),
      'Executed At': result?.startTime.toISOString(),
    };
  }

  private where(test: TestCase): string {
    const file = path.relative(this.configDir, test.location.file).split(path.sep).join('/');
    return `${file}:${test.location.line}`;
  }
}
