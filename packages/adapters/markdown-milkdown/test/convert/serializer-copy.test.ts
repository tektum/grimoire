import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHeadless } from '../../src/headless.js';
import { COPIED_FROM } from '../../src/serializer.js';
import { loadCorpus } from '../../src/testing/corpus.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';
import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';

/**
 * `src/serializer.ts` is a copy of Milkdown's `SerializerState` with a linear merge of children. It must write the same bytes as the original for every
 * document, so these tests write the corpus and the adversarial shapes with both and compare, and the version guard stops the copy from outliving the
 * version it was made from.
 */
describe('the copy of the Milkdown serializer', () => {
  it('was made from the installed version of @milkdown/transformer: when this fails, re-read the upstream serializer/state.ts and update the copy and COPIED_FROM', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../../node_modules/@milkdown/transformer/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(`@milkdown/transformer@${manifest.version}`).toBe(COPIED_FROM);
  });

  it('writes the same Markdown as the original for every case of the corpus', async () => {
    const [copy, upstream] = await Promise.all([createHeadless(undefined, 'copy'), createHeadless(undefined, 'upstream')]);
    const cases = loadCorpus();
    expect(cases.length).toBeGreaterThan(40);
    for (const { name, markdown } of cases) {
      const doc = normaliseForMarkdown(copy.parse(markdown));
      expect(copy.serialize(doc), name).toBe(upstream.serialize(doc));
    }
  });

  it('writes the same Markdown as the original for every adversarial shape, including runs of equal marks that merge', async () => {
    const [copy, upstream] = await Promise.all([createHeadless(undefined, 'copy'), createHeadless(undefined, 'upstream')]);
    for (const shape of SHAPES) {
      for (const size of [60, 400]) {
        const doc = normaliseForMarkdown(copy.schema.nodeFromJSON(shape.build(size)));
        expect(copy.serialize(doc), `${shape.name} ${String(size)}`).toBe(upstream.serialize(doc));
      }
    }
  });
});
