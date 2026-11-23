import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { getHeadless } from '../../src/headless.js';
import { convertInProcess } from '../../src/index.js';
import {
  manyParagraphsState,
  nestedListState,
  nestedState,
  paragraphWith,
  stateFromFragment,
  stateFromMarkdown,
} from '../../src/testing/states.js';

const failure = (result: Awaited<ReturnType<typeof convertInProcess>>) => (result.ok ? 'ok' : result.reason);

describe('hostile input fails closed', () => {
  it('a node outside the schema returns content-lost', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const unknown = new Y.XmlElement('mystery');
        fragment.insert(0, [paragraphWith('kept'), unknown]);
        unknown.insert(0, [paragraphWith('inside')]);
      });
    });
    const result = await convertInProcess(state);
    expect(result).toMatchObject({ ok: false, reason: 'content-lost' });
  });

  it('a mark outside the schema returns content-lost (y-prosemirror would drop the paragraph text)', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        fragment.insert(0, [paragraph]);
        const text = new Y.XmlText();
        paragraph.insert(0, [text]);
        text.insert(0, 'hello world', { bogus: {} });
      });
    });
    expect(await convertInProcess(state)).toMatchObject({ ok: false, reason: 'content-lost' });
  });

  it('code_block.language = 123 returns content-lost', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const block = new Y.XmlElement('code_block');
        block.setAttribute('language', 123 as unknown as string);
        fragment.insert(0, [block]);
        block.insert(0, [new Y.XmlText('let x = 1')]);
      });
    });
    expect(await convertInProcess(state)).toMatchObject({ ok: false, reason: 'content-lost' });
  });

  it('a paragraph level that is not a number returns content-lost', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('text', { level: 'high' })]);
    });
    expect(failure(await convertInProcess(state))).toBe('content-lost');
  });

  it('a list nested 101 deep returns too-deep', async () => {
    const result = await convertInProcess(nestedListState(101));
    expect(result).toMatchObject({ ok: false, reason: 'too-deep' });
  });

  it('a 1,000-deep blockquote returns too-deep without a crash', async () => {
    expect(await convertInProcess(nestedState('blockquote', 1000))).toMatchObject({ ok: false, reason: 'too-deep' });
  });

  it('a 20,000-deep blockquote returns too-deep (the walk itself does not recurse)', async () => {
    expect(failure(await convertInProcess(nestedState('blockquote', 20_000), { maxStateBytes: 50_000_000 }))).toBe('too-deep');
  });

  it('depth exactly at the limit converts; one more fails', async () => {
    // blockquotes under the fragment at depth 1..n-1, the paragraph at depth n
    expect(failure(await convertInProcess(nestedState('blockquote', 99)))).toBe('ok');
    expect(failure(await convertInProcess(nestedState('blockquote', 100)))).toBe('too-deep');
    expect(failure(await convertInProcess(nestedState('blockquote', 5), { maxDepth: 5 }))).toBe('too-deep');
  });

  it('more than 50,000 blocks returns too-large', async () => {
    expect(await convertInProcess(manyParagraphsState(50_001))).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('the production default: 50,000 blocks are accepted by the block guard, 50,001 are refused', async () => {
    // maxStateBytes is raised so that only the block limit decides (the default state cap is 1 MB).
    const big = { maxStateBytes: 2 ** 31 };
    expect(failure(await convertInProcess(manyParagraphsState(50_000), big))).toBe('ok');
    expect(failure(await convertInProcess(manyParagraphsState(50_001), big))).toBe('too-large');
  }, 300_000);

  it('a block limit set to 50 accepts 50 blocks and refuses 51', async () => {
    expect(failure(await convertInProcess(manyParagraphsState(50), { maxBlocks: 50 }))).toBe('ok');
    expect(failure(await convertInProcess(manyParagraphsState(51), { maxBlocks: 50 }))).toBe('too-large');
  });

  it('a state over maxStateBytes returns too-large before it is read', async () => {
    const state = await stateFromMarkdown('some text\n');
    expect(failure(await convertInProcess(state, { maxStateBytes: state.byteLength - 1 }))).toBe('too-large');
    expect(failure(await convertInProcess(state, { maxStateBytes: state.byteLength }))).toBe('ok');
  });

  it('bytes that are not a Yjs update return invalid-state', async () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([255, 255, 255, 255, 255]),
      new TextEncoder().encode('# not a yjs update at all'),
      new Uint8Array(64).fill(7),
    ]) {
      expect(failure(await convertInProcess(bytes))).toBe('invalid-state');
    }
  });

  it('a truncated update returns invalid-state, never partial Markdown', async () => {
    const state = await stateFromMarkdown('# Title\n\nparagraph one\n\nparagraph two\n\n- a\n- b\n');
    for (const cut of [state.byteLength - 1, Math.floor(state.byteLength / 2), 5]) {
      const result = await convertInProcess(state.slice(0, cut));
      expect(result.ok, `cut at ${cut}`).toBe(false);
      expect(failure(result), `cut at ${cut}`).toBe('invalid-state');
    }
  });

  it('input that is not a byte array returns invalid-state', async () => {
    expect(failure(await convertInProcess('text' as unknown as Uint8Array))).toBe('invalid-state');
    expect(failure(await convertInProcess(undefined as unknown as Uint8Array))).toBe('invalid-state');
  });

  it('non-empty content under the fragment name default returns invalid-state', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('visible')]);
    }, 'default');
    expect(await convertInProcess(state)).toMatchObject({ ok: false, reason: 'invalid-state' });
  });

  it('content under another name next to the real fragment returns invalid-state', async () => {
    const state = stateFromFragment((fragment, doc) => {
      fragment.insert(0, [paragraphWith('real')]);
      doc.getText('notes').insert(0, 'hidden text');
    });
    expect(failure(await convertInProcess(state))).toBe('invalid-state');
  });

  it('an empty shared type under another name is not content', async () => {
    const state = stateFromFragment((fragment, doc) => {
      fragment.insert(0, [paragraphWith('real')]);
      doc.getText('unused');
    });
    expect(failure(await convertInProcess(state))).toBe('ok');
  });

  it('the fragment name holding another type returns invalid-state', async () => {
    const doc = new Y.Doc();
    doc.getMap('prosemirror').set('a', 1);
    expect(failure(await convertInProcess(Y.encodeStateAsUpdate(doc)))).toBe('invalid-state');
  });

  it('a lone surrogate and a NUL in a paragraph convert to U+FFFD and the result has no U+0000', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('a\u0000b \uD800 c \uDC00 d')]);
    });
    const result = await convertInProcess(state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const value of [result.markdown, result.text]) {
      expect(value).not.toContain('\u0000');
      expect(/[\uD800-\uDFFF]/.test(value)).toBe(false);
      expect(value).toContain('a\uFFFDb');
      expect(value).toContain('\uFFFD c \uFFFD d');
    }
  });

  it('a very long single paragraph converts', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('word '.repeat(100_000))]);
    });
    expect(failure(await convertInProcess(state, { maxStateBytes: 10_000_000 }))).toBe('ok');
  }, 30_000); // CPU-bound conversion of 500 KB of text; a loaded machine needs more than vitest's 5 s. No wall-clock assertion.

  it('a stack overflow past the depth check (limit raised) is too-deep, not a throw and not partial Markdown', async () => {
    const result = await convertInProcess(nestedState('blockquote', 30_000), {
      maxDepth: 1_000_000,
      maxStateBytes: 50_000_000,
      maxBlocks: 1_000_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'too-deep' });
    expect(result).not.toHaveProperty('markdown');
  });

  it('any other error while serialising is internal and carries no Markdown', async () => {
    const state = await stateFromMarkdown('# Title\n\ntext\n');
    const headless = await getHeadless();
    const spy = vi.spyOn(headless, 'serialize').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const result = await convertInProcess(state);
      expect(result).toMatchObject({ ok: false, reason: 'internal' });
      expect(result).not.toHaveProperty('markdown');
    } finally {
      spy.mockRestore();
    }
  });
});
