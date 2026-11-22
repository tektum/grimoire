import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Benchmark (project `benchmark`; `bun run bench:convert` or `bun run test:benchmark`; never part of `bun run test`).
 * Each step runs in a fresh Node process on the built package (`dist`): one process builds the state, another converts
 * it, so the peak memory is the converter's. Writes test-results/m2/bench-<size>.json at the repository root and prints
 * the numbers; docs/proof/m2-conversion.md holds the table of a recorded run.
 */
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const child = join(packageDir, 'test/benchmark/bench-child.mjs');

const SHAPES = ['prose', 'lists', 'tables', 'code', 'mixed'] as const;
const SIZES = [
  { label: '10KB', bytes: 10 * 1024 },
  { label: '100KB', bytes: 100 * 1024 },
  { label: '1MB', bytes: 1024 * 1024 },
] as const;

const run = (args: string[]): Record<string, number> =>
  JSON.parse(execFileSync(process.execPath, [child, ...args], { encoding: 'utf8', maxBuffer: 1 << 24 })) as Record<string, number>;

function measure(shape: string, size: number): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), 'grimoire-bench-'));
  try {
    const file = join(dir, 'state.bin');
    const built = run(['build', shape, String(size), file]);
    const converted = run(['convert', file]);
    return { ...built, ...converted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('conversion benchmark', () => {
  it('measures time and peak memory per shape and size, cold start, block count and state shrink', () => {
    expect(existsSync(join(packageDir, 'dist/index.js')), 'build first: bun run build').toBe(true);
    const results: Record<string, unknown[]> = {};
    for (const { label, bytes } of SIZES) {
      results[label] = SHAPES.map((shape) => {
        const measured = measure(shape, bytes);
        expect(measured['markdownBytes']).toBeGreaterThan(bytes * 0.9);
        return { shape, ...measured };
      });
    }
    // At the state cap (1,536,000 bytes): the Markdown size that gives about that state for each shape (state/Markdown
    // ratios of docs/proof/m2-schema-fixes.md), which is the largest page that can be live.
    const CAP_BYTES: Record<string, number> = { prose: 880_000, lists: 140_000, tables: 105_000, code: 1_400_000, mixed: 300_000 };
    results['state-cap'] = SHAPES.map((shape) => ({ shape, ...measure(shape, CAP_BYTES[shape] ?? 100_000) }));
    results['50000-blocks'] = [{ shape: 'blocks', ...measure('blocks', 50_000) }];
    const shrink = run(['shrink', String(100 * 1024)]);
    const machine = { node: process.version, platform: `${process.platform} ${arch()} ${release()}`, cpu: cpus()[0]?.model ?? '?', cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) };
    const out = join(repoRoot, 'test-results/m2');
    mkdirSync(out, { recursive: true });
    for (const [label, rows] of Object.entries(results)) writeFileSync(join(out, `bench-${label}.json`), JSON.stringify({ machine, rows }, null, 2));
    writeFileSync(join(out, 'bench-shrink.json'), JSON.stringify({ machine, ...shrink }, null, 2));
    process.stdout.write(`${JSON.stringify({ machine, results, shrink })}\n`);
    expect(shrink['stateAfter']).toBeLessThan(shrink['stateBefore'] ?? 0);
  }, 900_000);
});
