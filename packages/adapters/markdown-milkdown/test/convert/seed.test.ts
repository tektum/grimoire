import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { convertInProcess, seedInProcess } from '../../src/index.js';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';

describe('seedInProcess', () => {
  it("seeds '# H\\n\\ntext' as a paragraph with level 1 in the fragment prosemirror", async () => {
    const seeded = await seedInProcess('# H\n\ntext');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seeded.state);
    const [first, second] = doc.getXmlFragment(FRAGMENT_NAME).toArray();
    expect(first).toBeInstanceOf(Y.XmlElement);
    expect(first instanceof Y.XmlElement && [first.nodeName, first.getAttribute('level')]).toEqual(['paragraph', 1]);
    expect(second instanceof Y.XmlElement && [second.nodeName, second.getAttribute('level')]).toEqual(['paragraph', 0]);
    expect(doc.share.has(FRAGMENT_NAME)).toBe(true);
  });

  it('converting a seeded state and seeding the result again is stable', async () => {
    const first = await seedInProcess('# H\n\n- a\n- b\n\ntext *em*\n');
    if (!first.ok) throw new Error(first.detail);
    const converted = await convertInProcess(first.state);
    if (!converted.ok) throw new Error(converted.detail);
    const second = await seedInProcess(converted.markdown);
    if (!second.ok) throw new Error(second.detail);
    const again = await convertInProcess(second.state);
    expect(again).toEqual(converted);
  });

  it('gives the same bytes for the same Markdown', async () => {
    const a = await seedInProcess('# H\n\ntext\n');
    const b = await seedInProcess('# H\n\ntext\n');
    expect(a).toEqual(b);
  });

  it('returns too-large over maxSeedMarkdownBytes (bytes, not characters)', async () => {
    expect(await seedInProcess('x'.repeat(101), { maxSeedMarkdownBytes: 100 })).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await seedInProcess('\u00e9'.repeat(51), { maxSeedMarkdownBytes: 100 })).toMatchObject({ ok: false, reason: 'too-large' });
    expect((await seedInProcess('x'.repeat(100), { maxSeedMarkdownBytes: 100 })).ok).toBe(true);
  });

  it('returns too-large when the seeded state is over maxStateBytes', async () => {
    expect(await seedInProcess('some text', { maxStateBytes: 10 })).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('returns a typed failure, not a throw, for input that is not a string', async () => {
    expect(await seedInProcess(undefined as unknown as string)).toMatchObject({ ok: false, reason: 'invalid-markdown' });
  });

  it('seeds an empty page', async () => {
    const seeded = await seedInProcess('');
    if (!seeded.ok) throw new Error(seeded.detail);
    expect(await convertInProcess(seeded.state)).toEqual({ ok: true, markdown: '', text: '' });
  });
});
