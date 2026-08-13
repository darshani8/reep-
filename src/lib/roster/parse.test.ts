import { describe, expect, it } from 'vitest';

import {
  degreeFromUsn,
  normaliseUsn,
  parseEmail,
  parsePhone,
  parseRoster,
  parseSemester,
  usnBranch,
  type RawRow,
} from './parse';

/**
 * The cases that matter here are the ones a real office export produces: a
 * banner row above the table, "Reg No" instead of "USN", a sheet with no degree
 * column at all (so UG/PG has to come off the USN), and the same student typed
 * twice. A suite built only from tidy input would pass while the real file
 * failed.
 */

/// A roster grid as `parseDelimited`/exceljs would hand it over: rows of cells.
function grid(...rows: (string | number | null)[][]): RawRow[] {
  return rows;
}

describe('normaliseUsn', () => {
  it('uppercases and strips spaces', () => {
    expect(normaliseUsn(' 1bg24mba001 ')).toBe('1BG24MBA001');
    expect(normaliseUsn('1bg24 mba 001')).toBe('1BG24MBA001');
  });

  it('is null for a blank cell', () => {
    expect(normaliseUsn('')).toBeNull();
    expect(normaliseUsn(null)).toBeNull();
  });

  it('keeps a provisional number rather than rejecting it', () => {
    // Admission-time numbers are not VTU USNs yet, but the identity still has
    // to be stable across re-imports.
    expect(normaliseUsn('prov-2026-14')).toBe('PROV-2026-14');
  });
});

describe('usnBranch and degreeFromUsn', () => {
  it('reads the branch code out of a USN', () => {
    expect(usnBranch('1BG24MBA001')).toBe('MBA');
    expect(usnBranch('1BG23CS045')).toBe('CS');
    expect(usnBranch('1BG22BBA010')).toBe('BBA');
  });

  it('classifies MBA and MCA as PG', () => {
    expect(degreeFromUsn('1BG24MBA001')).toBe('PG');
    expect(degreeFromUsn('1BG24MCA007')).toBe('PG');
  });

  it('classifies engineering and bachelor branches as UG', () => {
    expect(degreeFromUsn('1BG23CS045')).toBe('UG');
    expect(degreeFromUsn('1BG22BBA010')).toBe('UG');
    expect(degreeFromUsn('1BG23EC099')).toBe('UG');
  });

  it('is null when the USN does not parse as one', () => {
    expect(degreeFromUsn('PROV-2026-14')).toBeNull();
    expect(usnBranch('nonsense')).toBeNull();
  });
});

describe('parseSemester', () => {
  it('reads a bare number and a worded one', () => {
    expect(parseSemester('3')).toBe(3);
    expect(parseSemester('Semester 1')).toBe(1);
    expect(parseSemester('Sem-4')).toBe(4);
  });

  it('rejects a value outside 1–8', () => {
    expect(parseSemester('0')).toBeNull();
    expect(parseSemester('11')).toBeNull();
  });

  it('is null for a blank', () => {
    expect(parseSemester('')).toBeNull();
  });
});

describe('parseEmail', () => {
  it('lowercases a valid address', () => {
    expect(parseEmail('Ananya.R@bgscet.ac.in')).toBe('ananya.r@bgscet.ac.in');
  });

  it('is null for blank and false for junk', () => {
    expect(parseEmail('')).toBeNull();
    expect(parseEmail('not-an-email')).toBe(false);
    expect(parseEmail('N/A')).toBe(false);
  });
});

describe('parsePhone', () => {
  it('keeps digits and a leading plus', () => {
    expect(parsePhone('+91 98765 43210')).toBe('+919876543210');
    expect(parsePhone('9876543210')).toBe('9876543210');
  });

  it('drops filler that is not a number', () => {
    expect(parsePhone('-')).toBeNull();
    expect(parsePhone('N/A')).toBeNull();
  });
});

describe('parseRoster', () => {
  it('reads a clean sheet with an explicit degree column', () => {
    const { students, errors } = parseRoster(
      grid(
        ['USN', 'Name', 'Programme', 'Level', 'Email', 'Sem'],
        ['1BG24MBA001', 'Ananya R', 'MBA', 'PG', 'ananya@bgscet.ac.in', '1'],
        ['1BG23BBA010', 'Farhan Q', 'BBA', 'UG', 'farhan@bgscet.ac.in', '5'],
      ),
    );
    expect(errors).toHaveLength(0);
    expect(students).toHaveLength(2);
    expect(students[0]).toMatchObject({
      usn: '1BG24MBA001',
      name: 'Ananya R',
      degreeLevel: 'PG',
      degreeSource: 'column',
      semester: 1,
    });
    expect(students[1].degreeLevel).toBe('UG');
  });

  it('finds the header under a college banner row', () => {
    const { students, headerRow } = parseRoster(
      grid(
        ['BGS College of Engineering — Student Roster 2026', null, null],
        ['USN', 'Name', 'Branch'],
        ['1BG24MCA007', 'Rohan K', 'MCA'],
      ),
    );
    expect(headerRow).toBe(2);
    expect(students).toHaveLength(1);
    expect(students[0].degreeLevel).toBe('PG');
  });

  it('matches "Reg No" as the USN column', () => {
    const { students } = parseRoster(
      grid(
        ['Reg No', 'Student Name'],
        ['1BG24MBA001', 'Ananya R'],
      ),
    );
    expect(students).toHaveLength(1);
    expect(students[0].usn).toBe('1BG24MBA001');
  });

  it('derives UG/PG from the USN when no degree column exists', () => {
    // The common case: an export that lists USN and name and nothing that says
    // UG or PG. The branch code has to carry it.
    const { students, errors } = parseRoster(
      grid(
        ['USN', 'Name'],
        ['1BG24MBA001', 'Ananya R'],
        ['1BG23CS045', 'Meera S'],
      ),
    );
    expect(errors).toHaveLength(0);
    expect(students[0]).toMatchObject({ degreeLevel: 'PG', degreeSource: 'usn' });
    expect(students[1]).toMatchObject({ degreeLevel: 'UG', degreeSource: 'usn' });
  });

  it('skips a row it cannot place on either side, and says why', () => {
    const { students, errors } = parseRoster(
      grid(
        ['USN', 'Name'],
        ['1BG24MBA001', 'Ananya R'],
        ['PROV-99', 'Unplaced Person'],
      ),
    );
    expect(students).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 3, column: 'degreeLevel' });
    expect(errors[0].message).toContain('UG or PG');
  });

  it('skips a blank USN or name with the row number the operator sees', () => {
    const { students, errors } = parseRoster(
      grid(
        ['USN', 'Name'],
        ['1BG24MBA001', 'Ananya R'],
        ['', 'No USN'],
        ['1BG24MBA003', ''],
      ),
    );
    expect(students).toHaveLength(1);
    expect(errors).toEqual([
      { row: 3, column: 'usn', message: 'Blank USN — row skipped' },
      { row: 4, column: 'name', message: 'Blank name — row skipped' },
    ]);
  });

  it('keeps the last of a repeated USN and warns', () => {
    const { students, warnings } = parseRoster(
      grid(
        ['USN', 'Name', 'Sem'],
        ['1BG24MBA001', 'Ananya R', '1'],
        ['1BG24MBA001', 'Ananya Rao', '2'],
      ),
    );
    expect(students).toHaveLength(1);
    expect(students[0].name).toBe('Ananya Rao');
    expect(students[0].semester).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ row: 3, column: 'usn' });
  });

  it('imports a student with a broken email and warns rather than skipping', () => {
    const { students, warnings } = parseRoster(
      grid(
        ['USN', 'Name', 'Email'],
        ['1BG24MBA001', 'Ananya R', 'not-an-email'],
      ),
    );
    expect(students).toHaveLength(1);
    expect(students[0].email).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].column).toBe('email');
  });

  it('errors clearly when no header row is present', () => {
    const { students, errors } = parseRoster(grid(['just', 'some', 'values'], ['1', '2', '3']));
    expect(students).toHaveLength(0);
    expect(errors[0].column).toBe('header');
  });

  it('errors when the header names a name but no USN', () => {
    const { errors } = parseRoster(
      grid(
        ['Name', 'Branch'],
        ['Ananya R', 'MBA'],
      ),
    );
    // No usn column means findHeader never accepts the row, so this is a
    // header failure, which is the right thing to tell the operator.
    expect(errors[0].column).toBe('header');
  });

  it('ignores fully blank rows between blocks', () => {
    const { students, errors } = parseRoster(
      grid(
        ['USN', 'Name'],
        ['1BG24MBA001', 'Ananya R'],
        ['', ''],
        ['1BG24MBA002', 'Kiran P'],
      ),
    );
    expect(students).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });
});
