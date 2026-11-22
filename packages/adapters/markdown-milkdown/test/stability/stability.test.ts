import { describe, expect, it } from 'vitest';
import { convertInProcess, seedInProcess } from '../../src/index.js';
import { getHeadless } from '../../src/headless.js';
import { loadCorpus } from '../../src/testing/corpus.js';

const corpus = loadCorpus();

async function convertMarkdown(markdown: string): Promise<{ markdown: string; text: string; state: Uint8Array }> {
  const seeded = await seedInProcess(markdown);
  if (!seeded.ok) throw new Error(`seed ${seeded.reason}: ${seeded.detail}`);
  const converted = await convertInProcess(seeded.state);
  if (!converted.ok) throw new Error(`convert ${converted.reason}: ${converted.detail}`);
  return { markdown: converted.markdown, text: converted.text, state: seeded.state };
}

describe('stability corpus', () => {
  it('has at least 32 committed cases', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(32);
  });

  describe.each(corpus)('$name', ({ markdown }) => {
    it('serialise, parse, serialise again is identical', async () => {
      const first = await convertMarkdown(markdown);
      const second = await convertMarkdown(first.markdown);
      expect(second.markdown).toBe(first.markdown);
    });

    it('the headless parser and serializer agree with the converter on the written Markdown', async () => {
      const first = await convertMarkdown(markdown);
      const headless = await getHeadless();
      expect(headless.serialize(headless.parse(first.markdown))).toBe(first.markdown);
    });

    it('the same state converted twice gives identical Markdown and text', async () => {
      const { state } = await convertMarkdown(markdown);
      expect(await convertInProcess(state)).toEqual(await convertInProcess(new Uint8Array(state)));
    });

    it('converts without loss (no content-lost, no failure)', async () => {
      const seeded = await seedInProcess(markdown);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      expect((await convertInProcess(seeded.state)).ok).toBe(true);
    });
  });
});
