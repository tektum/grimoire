import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { convertInProcess, reseedInProcess, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';

const converter: MarkdownConverter = {
  seed: (markdown) => seedInProcess(markdown),
  reseed: (markdown) => reseedInProcess(markdown),
  toMarkdown: (state) => convertInProcess(state),
  close: () => Promise.resolve(),
};
const FIXED = 3_000_000_000;
const clients = (state: Uint8Array): number[] => [...new Set(Y.decodeUpdate(state).structs.map((s) => s.id.client))];

describe('SeededContent never holds the converter\'s fixed client id', () => {
  it('gives a reset after a create of the same text a different client id than the create\'s seed, and neither is the fixed one', async () => {
    const create = await seedUserMarkdown(converter, 'user-1', 'Doc', '# Same\n\ntext');
    const reset = await seedUserMarkdown(converter, 'user-1', 'Doc', '# Same\n\ntext');
    if (isSeedRefusal(create) || isSeedRefusal(reset)) throw new Error('seed refused');
    expect(clients(create.state)).toHaveLength(1);
    expect(clients(reset.state)).toHaveLength(1);
    expect(clients(create.state)).not.toEqual(clients(reset.state));
    expect([...clients(create.state), ...clients(reset.state)]).not.toContain(FIXED);
    expect(create.markdown).toBe(reset.markdown);
  });
});
