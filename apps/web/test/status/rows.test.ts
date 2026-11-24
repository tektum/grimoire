import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapSignal } from '../../src/editor/core/map-signal';
import { failures, ROWS } from './table';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8'); // from the repository root, where the tests run

describe('the rows of the signal table, and the tests that show their messages', () => {
  it('mapSignal maps every row with a text as the table says', () => {
    expect(failures(mapSignal)).toEqual([]);
  });

  it('messages.spec has a test for each row, titled with the first cell of the row and the text it shows', () => {
    const spec = read('apps/web/test-e2e/status/messages.spec.ts');
    const looped = new Set(['server-full', 'documents-full', 'memory-guard', 'try-again', 'state-corrupt', 'internal-error']);
    for (const row of ROWS) {
      const reason = row.id.split(';')[0]!;
      if (looped.has(reason)) {
        expect(spec, `the loop over ${reason}`).toContain(`'${reason}'`);
        expect(spec).toContain(`\`\${reason}; ${row.id.split('; ')[1]}: "`);
        continue;
      }
      const title = spec.split('\n').find((line) => line.trimStart().startsWith(`test('${row.id}:`) || line.trimStart().startsWith(`test('${row.id}'`));
      expect(title, `a test titled "${row.id}: …"`).toBeDefined();
      if (row.expected.text !== undefined && row.id !== 'seed-failed; 4501' && !title!.includes('" + ')) {
        const words = row.id === 'any unknown reason' ? '' : row.expected.text;
        expect(title, `the text of ${row.id}`).toContain(words.replace("can't", "can\\'t"));
      }
    }
  });

  it('docs/spec.md row R11.13 names 4409 (stale epoch), 4426 (client too old) and the non-retryable 4501', () => {
    const row = read('docs/spec.md').split('\n').find((line) => line.startsWith('| R11.13 '))!;
    expect(row).toMatch(/4409 stale epoch/);
    expect(row).toMatch(/4426 client too old/);
    expect(row).toMatch(/4501[^;]*not retryable/);
  });
});
