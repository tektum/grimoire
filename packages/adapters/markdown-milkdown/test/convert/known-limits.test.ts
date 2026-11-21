import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { paragraphWith, stateFromFragment, stateFromMarkdown } from '../../src/testing/states.js';

/** Canaries for the "Known limits" of docs/proof/m2-conversion.md: each fails when the behaviour it records changes. */
async function markdownOf(markdown: string): Promise<string> {
  const result = await convertInProcess(await stateFromMarkdown(markdown));
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.markdown;
}

describe('known limits (canaries)', () => {
  it('a link around an image and other content loses the link on the image only (mark on an inline atom)', async () => {
    expect(await markdownOf('[![a](b.png) tail](https://example.com/c)\n')).toBe('![a](b.png) [tail](https://example.com/c)\n');
  });

  it('an empty paragraph is written as <br /> and an empty heading as its marker only', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('one'), new Y.XmlElement('paragraph'), paragraphWith('', { level: 2 }), paragraphWith('two')]);
    });
    const result = await convertInProcess(state);
    expect(result.ok && result.markdown).toBe('one\n\n<br />\n\n##\n\ntwo\n');
  });

  it('footnotes and math are plain text: no plugin gives them a node', async () => {
    const written = await markdownOf('claim[^1]\n\n[^1]: note\n');
    expect(written).toBe('claim[^1]\n\n[^1]: note\n'); // the reference and its definition survive as text, in full
    expect(await markdownOf('$a_b$\n')).toBe('$a_b$\n');
  });

  it('bullets are written with a star', async () => {
    expect(await markdownOf('- a\n- b\n')).toBe('* a\n* b\n');
  });

  it('a hard break at the end of a block is not written (a normalisation, nothing visible is lost)', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const paragraph = paragraphWith('text');
        fragment.insert(0, [paragraph]);
        paragraph.insert(1, [new Y.XmlElement('hardbreak')]);
      });
    });
    expect(await convertInProcess(state)).toMatchObject({ ok: true, markdown: 'text\n' });
  });

  it('a hard break inside a heading survives (the schema writes it as an inline <br />)', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const heading = paragraphWith('before', { level: 2 });
        fragment.insert(0, [heading]);
        heading.insert(1, [new Y.XmlElement('hardbreak'), new Y.XmlText('after')]);
      });
    });
    const result = await convertInProcess(state);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.markdown).toContain('<br />');
  });
});
