import { expect, it } from 'vitest';
import { editorSweep, markdownSweep } from '../../src/testing/sweeps.js';

/** The full-size sweeps of the properties in test/convert/round-trip.test.ts (benchmark project, not `bun run test`). */
it('2,000 documents read from Markdown all convert', async () => {
  expect(await markdownSweep(2000)).toEqual([]);
}, 600_000);

it('2,000 editor documents: refusals are listed classes, accepted ones are one read-back from an exact fixed point', async () => {
  const { problems, counts } = await editorSweep(2000);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
  expect(problems).toEqual([]);
  expect(counts.ok).toBeGreaterThan(1500);
  expect(counts.refused).toBeGreaterThan(50);
  expect(counts.addressReadBack).toBeLessThan(10);
}, 600_000);
