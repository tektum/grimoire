import { describe, expect, it } from 'vitest';
import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { createHeadless } from '../../src/headless.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';

/**
 * The serialiser must cost about as much per run at 80,000 runs as at 10,000. Milkdown's own writer copies a block's array of children for every child it
 * visits (quadratic: 64 times the cost for 8 times the size); `src/serializer.ts` does not. Only the writing is timed (the verifying parse that follows a
 * save is a separate cost), in CPU time of one core, so a loaded machine does not fail it. The bound is a ratio with room for the collector: linear is 8,
 * quadratic is 64, the test allows 24. `SERIALIZER=upstream` runs the same measurement on Milkdown's own writer, to show the test fails on it.
 */
const cpu = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

describe('serialising runs of text with edge spaces around marks grows about linearly', () => {
  it('costs less than 24 times as much for 8 times the runs', async () => {
    const which = process.env['SERIALIZER'] === 'upstream' ? 'upstream' : 'copy';
    const headless = await createHeadless(undefined, which);
    const shape = SHAPES.find((candidate) => candidate.name === 'text with edge spaces around marks');
    if (shape === undefined) throw new Error('shape missing');
    const measure = (runs: number): number => {
      const doc = normaliseForMarkdown(headless.schema.nodeFromJSON(shape.build(runs)));
      const before = cpu();
      headless.serialize(doc);
      return cpu() - before;
    };
    measure(1_000); // warm up
    const small = measure(10_000);
    const large = measure(80_000);
    process.stdout.write(`\ncpu serialise (${which}): 10000 runs ${Math.round(small)}ms, 80000 runs ${Math.round(large)}ms, growth ${(large / Math.max(small, 1)).toFixed(1)}x for 8x the runs\n`);
    expect(large / Math.max(small, 1)).toBeLessThan(24);
  }, 180_000);
});
