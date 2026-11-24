import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { Mapping, Signal } from '../../src/editor/core/map-signal';
import { failures } from './table';

const source = readFileSync(resolve(process.cwd(), 'apps/web/src/editor/core/map-signal.ts'), 'utf8');

/** `map-signal.ts` with one behaviour changed, loaded as a module of its own (the file has no imports). */
async function mutated(from: string, to: string): Promise<(signal: Signal) => Mapping> {
  expect(source, `the mutation applies: "${from}" is in map-signal.ts`).toContain(from);
  const js = ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: { mapSignal?: (signal: Signal) => Mapping } = {};
  runInNewContext(js, { exports: exported }); // the file has no imports, so it needs nothing else
  return exported.mapSignal!;
}

describe('a broken mapping fails the table test', () => {
  it('the table passes on the unchanged source (so a failure below is the mutation)', async () => {
    expect(failures(await mutated('const', 'const'))).toEqual([]);
  });

  it.each([
    ['seed-failed is retried by itself', "return error(TEXTS.cannotOpen, { noRetry: true });", 'return error(TEXTS.cannotOpen);'],
    ['page-full is not made to wait', "behaviour: 'BUSY', text: TEXTS.pageFull, minDelayMs: BUSY_MS", "behaviour: 'BUSY', text: TEXTS.pageFull"],
    ['forbidden stops saying so', "{ behaviour: 'NO_ACCESS', text: TEXTS.noAccess }", "{ behaviour: 'NO_ACCESS' }"],
    ['a close 1009 is retried, not shown as too large', "if (code === 1009) return { behaviour: 'LARGE', text: TEXTS.tooLarge };", ''],
    ['4429 is treated as an ordinary busy', "text: TEXTS.rateLimited, minDelayMs: RATE_LIMIT_MS", "text: TEXTS.busy, minDelayMs: BUSY_MS"],
    ['a client that is too old is not asked to reload', "{ behaviour: 'RELOAD', text: TEXTS.tooOld }", "{ behaviour: 'RETRY' }"],
  ])('%s', async (_name, from, to) => {
    const wrong = failures(await mutated(from, to));
    expect(wrong.length).toBeGreaterThan(0);
  });
});
