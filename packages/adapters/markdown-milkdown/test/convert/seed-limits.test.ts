import { describe, expect, it } from 'vitest';
import { convertInProcess, seedInProcess } from '../../src/index.js';

// Review finding F8: a seed was checked for bytes only, so a page could be created that no later save could convert
// (too-deep, too-large). The seed now applies the converter's own guards to its output.
const quotes = (levels: number): string => `${'> '.repeat(levels)}text\n`;
// Thematic breaks are the cheapest block in the Yjs state, so the block limit is reachable under the byte limit.
const paragraphs = (count: number): string => '***\n\n'.repeat(count);

describe('a seed is checked against the converter limits (depth 100, 50,000 blocks)', () => {
  it('99 nested quotes (a paragraph at depth 100) seed, and the seeded page converts back', async () => {
    const seeded = await seedInProcess(quotes(99));
    expect(seeded.ok).toBe(true);
    if (seeded.ok) expect(await convertInProcess(seeded.state)).toMatchObject({ ok: true });
  });

  it('100 nested quotes (depth 101) are refused as too-large, not seeded', async () => {
    expect(await seedInProcess(quotes(100))).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('49,990 thematic breaks seed, and the seeded page converts back', async () => {
    const seeded = await seedInProcess(paragraphs(49_990));
    expect(seeded.ok).toBe(true);
    if (seeded.ok) expect(await convertInProcess(seeded.state)).toMatchObject({ ok: true });
  }, 60_000);

  it('50,010 thematic breaks are refused as too-large', async () => {
    expect(await seedInProcess(paragraphs(50_010))).toMatchObject({ ok: false, reason: 'too-large' });
  }, 60_000);

  it('a document that the converter would refuse for its nesting of lists is refused at seed time', async () => {
    const lists = Array.from({ length: 60 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n');
    const seeded = await seedInProcess(`${lists}\n`);
    // 60 nested lists are 120 levels of list and item: over the depth limit.
    expect(seeded).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('every seed that succeeds converts back (200 documents of mixed shape)', async () => {
    for (let i = 1; i <= 200; i += 1) {
      const depth = 1 + (i % 120);
      const seeded = await seedInProcess(quotes(depth));
      if (!seeded.ok) {
        expect(depth).toBeGreaterThan(99);
        continue;
      }
      expect(await convertInProcess(seeded.state), `depth ${depth}`).toMatchObject({ ok: true });
    }
  }, 120_000);

  it('the limits apply as given: a smaller maxDepth refuses a shallower seed', async () => {
    expect(await seedInProcess(quotes(10), { maxDepth: 5 })).toMatchObject({ ok: false, reason: 'too-large' });
  });
});
