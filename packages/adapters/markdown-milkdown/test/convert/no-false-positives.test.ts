import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { generateRandomDocument } from '../../src/testing/generate.js';
import { loadCorpus } from '../../src/testing/corpus.js';
import { stateFromMarkdownDirect } from '../../src/testing/states.js';

/**
 * Loss detection must not reject a legitimate document. Documents are built through the real plugin array (the headless
 * parser) and y-prosemirror, never by hand, so each is something an editor could have produced.
 */
describe('no false positives in loss detection', () => {
  it('converts every case of the stability corpus', async () => {
    for (const { name, markdown } of loadCorpus()) {
      const result = await convertInProcess(await stateFromMarkdownDirect(markdown));
      expect(result.ok, name).toBe(true);
    }
  }, 60_000);

  it('converts 150 seeded random documents with the loss and attribute guards, each twice with identical output', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 150; seed += 1) {
      const state = await stateFromMarkdownDirect(generateRandomDocument(seed * 7919));
      // The round trip check has its own sweep (round-trip.test.ts): here only the guards before it are on trial.
      const result = await convertInProcess(state, { verifyRoundTrip: false });
      if (!result.ok) failures.push(`seed ${seed}: ${result.reason} ${result.detail}`);
      else if (JSON.stringify(await convertInProcess(state, { verifyRoundTrip: false })) !== JSON.stringify(result)) failures.push(`seed ${seed}: not deterministic`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('the random documents cover every construct (not a sample of plain paragraphs)', () => {
    const all = Array.from({ length: 1000 }, (_, i) => generateRandomDocument((i + 1) * 7919)).join('\n');
    for (const marker of ['# ', '- [ ]', '1. ', '> ', '| a | b |', '```', '![', '/l0 "t")', '<kbd>', '<div>', '***']) {
      expect(all, marker).toContain(marker);
    }
  });
});
