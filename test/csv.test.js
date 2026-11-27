import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/sources/csv.js';

test('parses quoted fields, doubled quotes and embedded newlines', () => {
  const rows = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x, y', 'say "hi"', 'line1\nline2'],
  ]);
});

test('handles CRLF, a BOM, empty fields and blank lines', () => {
  const rows = parseCsv('﻿a,b\r\n1,\r\n\r\n,2');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', ''],
    ['', '2'],
  ]);
});
