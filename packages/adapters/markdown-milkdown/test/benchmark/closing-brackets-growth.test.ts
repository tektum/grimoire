import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';
import { stateFromDocJson } from '../../src/testing/states.js';

/**
 * The save of a page of many `]` must cost about as much per bracket at 80,000 as at 10,000. The parser's footnote tokenizer walked back over every earlier
 * event for each `]` (quadratic: 64 times the cost for 8 times the size); the serialiser now writes them escaped. CPU time of one core (`process.cpuUsage`),
 * so a loaded machine does not fail it, and the bound is a ratio with room for the collector: linear is 8, quadratic is 64, the test allows 24. Sizes, ratio and the
 * pass or fail are what it asserts, never a time.
 */
const cpu = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

describe('closing brackets: the save grows about linearly', () => {
  const shape = SHAPES.find((candidate) => candidate.name === 'closing brackets');

  it('costs less than 24 times as much for 8 times the brackets', async () => {
    if (shape === undefined) throw new Error('shape missing');
    const run = async (size: number): Promise<number> => {
      const state = await stateFromDocJson(shape.build(size));
      const before = cpu();
      const result = await convertInProcess(state);
      const spent = cpu() - before;
      expect(result.ok).toBe(true);
      return spent;
    };
    await run(1_000); // warm the headless context
    const small = await run(10_000);
    const large = await run(80_000);
    process.stdout.write(`\ncpu closing brackets: 10000:${Math.round(small)}ms 80000:${Math.round(large)}ms growth ${(large / Math.max(small, 1)).toFixed(1)}x for 8x the size\n`);
    expect(large / Math.max(small, 1)).toBeLessThan(24);
  }, 180_000);
});
