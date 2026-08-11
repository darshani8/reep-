import { describe, expect, it } from 'vitest';

import { UTF8_BOM, csvDocument, escapeCell, toCsv } from './csv';

const COLUMNS = [
  { key: 'usn', header: 'USN', width: 14 },
  { key: 'name', header: 'Name', width: 24 },
  { key: 'hours', header: 'Hours', width: 8 },
];

describe('escapeCell', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeCell('Asha Nair')).toBe('Asha Nair');
  });

  it('renders an absent value as an empty field, not "undefined"', () => {
    expect(escapeCell(undefined)).toBe('');
  });

  it('renders booleans as Yes/No for the reader, not true/false', () => {
    expect(escapeCell(true)).toBe('Yes');
    expect(escapeCell(false)).toBe('No');
  });

  it('renders finite numbers bare so the spreadsheet treats them as numbers', () => {
    expect(escapeCell(42)).toBe('42');
    expect(escapeCell(0)).toBe('0');
    expect(escapeCell(-3.5)).toBe('-3.5');
  });

  it('blanks a non-finite number rather than writing NaN into a cell', () => {
    expect(escapeCell(NaN)).toBe('');
    expect(escapeCell(Infinity)).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(escapeCell('Nair, Asha')).toBe('"Nair, Asha"');
  });

  it('doubles an embedded quote and wraps the field', () => {
    expect(escapeCell('She said "done"')).toBe('"She said ""done"""');
  });

  it('quotes a field containing a newline so the row does not split', () => {
    expect(escapeCell('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCell('line one\r\nline two')).toBe('"line one\r\nline two"');
  });

  describe('formula neutralisation', () => {
    it.each([
      ['=1+1', "'=1+1"],
      ['+1', "'+1"],
      ['-1', "'-1"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\tstarts with tab', "'\tstarts with tab"],
    ])('prefixes %j so a spreadsheet reads it as text', (input, expected) => {
      expect(escapeCell(input)).toBe(expected);
    });

    it('neutralises the classic DDE payload a mentor note could carry', () => {
      const payload = '=cmd|\' /C calc\'!A0';

      expect(escapeCell(payload).startsWith("'")).toBe(true);
    });

    it('does not prefix a negative number, which is data rather than text', () => {
      // The string '-1' is neutralised; the number -1 must stay a number or the
      // spreadsheet column stops being summable.
      expect(escapeCell(-1)).toBe('-1');
    });

    it('does not prefix text that merely contains an operator', () => {
      expect(escapeCell('A=B')).toBe('A=B');
    });
  });
});

describe('toCsv', () => {
  it('writes the header in the declared column order', () => {
    expect(toCsv(COLUMNS, []).split('\r\n')[0]).toBe('USN,Name,Hours');
  });

  it('emits a header-only document for an empty roster, not an empty string', () => {
    const csv = toCsv(COLUMNS, []);

    expect(csv).toBe('USN,Name,Hours');
    expect(csv.includes('\r\n')).toBe(false);
  });

  it('uses CRLF between rows, which is what RFC 4180 and Excel expect', () => {
    const csv = toCsv(COLUMNS, [
      { usn: '1BG23MBA01', name: 'Asha Nair', hours: 12 },
      { usn: '1BG23MBA02', name: 'Ravi Kumar', hours: 8 },
    ]);

    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  it('writes an empty field for a column a row does not carry, keeping rows aligned', () => {
    const csv = toCsv(COLUMNS, [{ usn: '1BG23MBA01', name: 'Asha Nair' }]);

    expect(csv.split('\r\n')[1]).toBe('1BG23MBA01,Asha Nair,');
  });

  it('keeps every row at the same field count even when values contain commas', () => {
    const csv = toCsv(COLUMNS, [
      { usn: '1BG23MBA01', name: 'Nair, Asha', hours: 12 },
      { usn: '1BG23MBA02', name: 'Kumar', hours: 8 },
    ]);
    const [header, ...rows] = csv.split('\r\n');

    // A comma inside quotes must not count as a separator.
    for (const row of rows) {
      expect(splitCsvRow(row)).toHaveLength(splitCsvRow(header).length);
    }
  });

  it('round-trips a value containing every awkward character', () => {
    const nasty = 'Nair, "Asha"\r\nsecond line';
    const csv = toCsv([{ key: 'note', header: 'Note', width: 40 }], [{ note: nasty }]);

    expect(splitCsvRow(csv.slice(csv.indexOf('\r\n') + 2))[0]).toBe(nasty);
  });
});

describe('csvDocument', () => {
  it('leads with the BOM so Excel on Windows decodes UTF-8', () => {
    const doc = csvDocument(COLUMNS, []);

    expect(doc.startsWith(UTF8_BOM)).toBe(true);
    expect(doc.codePointAt(0)).toBe(0xfeff);
  });

  it('applies the BOM exactly once', () => {
    const doc = csvDocument(COLUMNS, [{ usn: 'A', name: 'B', hours: 1 }]);

    expect([...doc].filter((c) => c === UTF8_BOM).length).toBe(1);
  });

  it('is the BOM followed by exactly what toCsv produced', () => {
    const rows = [{ usn: '1BG23MBA01', name: 'Asha Nair', hours: 12 }];

    expect(csvDocument(COLUMNS, rows)).toBe(`${UTF8_BOM}${toCsv(COLUMNS, rows)}`);
  });

  it('preserves non-ASCII names, which is the reason the BOM is there', () => {
    const doc = csvDocument([{ key: 'name', header: 'Name', width: 20 }], [
      { name: 'ಅಶಾ ನಾಯರ್' },
    ]);

    expect(doc).toContain('ಅಶಾ ನಾಯರ್');
  });
});

/// A minimal RFC 4180 reader, so the tests above check what a spreadsheet would
/// actually parse rather than re-implementing the writer's own assumptions.
function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];

    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }

  fields.push(field);
  return fields;
}
