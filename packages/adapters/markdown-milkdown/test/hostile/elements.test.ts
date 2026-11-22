import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import { convertInProcess, DEFAULT_LIMITS, seedInProcess } from '../../src/index.js';
import { guardState } from '../../src/guards.js';
import { paragraphWith, stateFromFragment, stateFromMarkdown } from '../../src/testing/states.js';

const reason = (result: Awaited<ReturnType<typeof convertInProcess>>) => (result.ok ? 'ok' : result.reason);
const attr = (element: Y.XmlElement, key: string, value: unknown): Y.XmlElement => {
  element.setAttribute(key, value as string);
  return element;
};

describe('an element dropped without a change in the number of characters is content-lost', () => {
  // y-prosemirror drops a node whose attribute value is invalid and says nothing; only the element count shows it.
  it.each([
    ['an image whose src is not a string', () => attr(attr(new Y.XmlElement('image'), 'src', 5), 'alt', 'a')],
    ['an image whose alt is not a string', () => attr(new Y.XmlElement('image'), 'alt', 7)],
    ['a hard break whose isInline is not a boolean', () => attr(new Y.XmlElement('hardbreak'), 'isInline', 'yes')],
  ])('%s', async (_name, make) => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const paragraph = paragraphWith('same text');
        fragment.insert(0, [paragraph]);
        paragraph.insert(1, [make()]);
      });
    });
    expect(reason(await convertInProcess(state))).toBe('content-lost');
  });

  it('a horizontal rule at the document root: with an attribute the schema does not know it is dropped (content-lost), a plain one is kept', async () => {
    // A block node cannot sit inside a paragraph (it would be dropped for its placement alone), so it goes to the fragment root.
    const rule = (invalid: boolean) => stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('text'), invalid ? attr(new Y.XmlElement('hr'), 'x', 1) : new Y.XmlElement('hr')]);
    });
    expect(reason(await convertInProcess(rule(false)))).toBe('ok');
    expect(reason(await convertInProcess(rule(true)))).toBe('content-lost');
  });

  it('the attribute rules (schema given): a heading element of level 0, a level outside 0 to 6 and a node outside the schema are refused; a level of 2 is not', () => {
    const schema = { nodes: { heading: { spec: { attrs: { level: {} } } } }, marks: {} };
    const guard = (element: Y.XmlElement) => guardState(stateFromFragment((fragment) => { fragment.insert(0, [element]); }), DEFAULT_LIMITS, schema);
    expect(guard(attr(new Y.XmlElement('heading'), 'level', 0))).toMatchObject({ ok: false });
    expect(guard(attr(new Y.XmlElement('heading'), 'level', 7))).toMatchObject({ ok: false });
    expect(guard(new Y.XmlElement('mystery'))).toMatchObject({ ok: false });
    expect(guard(attr(new Y.XmlElement('heading'), 'level', 2))).toMatchObject({ ok: true });
  });

  it('an empty paragraph of an unknown type', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('text'), new Y.XmlElement('mystery')]);
    });
    expect(reason(await convertInProcess(state))).toBe('content-lost');
  });

  it('an empty table cell with an invalid alignment', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const table = new Y.XmlElement('table');
        const row = new Y.XmlElement('table_row');
        const cell = attr(new Y.XmlElement('table_cell'), 'alignment', 'diagonal');
        fragment.insert(0, [table]);
        table.insert(0, [row]);
        row.insert(0, [cell]);
        cell.insert(0, [new Y.XmlElement('paragraph')]);
      });
    });
    expect(reason(await convertInProcess(state))).toBe('content-lost');
  });
});

describe('an update that applies only in part', () => {
  it('is invalid-state, never Markdown of the part that did apply', async () => {
    const doc = new Y.Doc();
    doc.clientID = 3_000_000_005;
    const fragment = doc.getXmlFragment('prosemirror');
    fragment.insert(0, [paragraphWith('one')]);
    const first = Y.encodeStateAsUpdate(doc);
    const afterFirst = Y.encodeStateVector(doc);
    fragment.insert(1, [paragraphWith('two')]);
    const second = Y.encodeStateAsUpdate(doc, afterFirst);
    expect(reason(await convertInProcess(first))).toBe('ok');
    // The second update alone refers to structs it has not got: Yjs applies none of it and keeps it pending.
    expect(await convertInProcess(second)).toMatchObject({ ok: false, reason: 'invalid-state' });
  });
});

describe('what is not a document', () => {
  it('text directly under the root is invalid-state', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [new Y.XmlText('loose text')]);
    });
    expect(await convertInProcess(state)).toMatchObject({ ok: false, reason: 'invalid-state' });
  });

  it('a Y.Text at the fragment name is invalid-state', async () => {
    const doc = new Y.Doc();
    doc.getText('prosemirror').insert(0, 'plain text');
    expect(await convertInProcess(Y.encodeStateAsUpdate(doc))).toMatchObject({ ok: false, reason: 'invalid-state' });
  });

  it('a failure carries a fixed sentence, never the text of an error or of the page', async () => {
    const secret = 'SECRET-PAGE-TEXT';
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        fragment.insert(0, [paragraph]);
        const text = new Y.XmlText();
        paragraph.insert(0, [text]);
        text.insert(0, secret, { bogus: {} });
      });
    });
    const result = await convertInProcess(state);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    if (!result.ok) expect(result.detail.length).toBeLessThan(200);
  });
});

describe('values and attributes the schema does not define are refused, not corrected', () => {
  const paragraphAt = (level: unknown) =>
    stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('heading text', { level: level as string })]);
    });

  it.each([7, -1, 1.5, 'high', null])('a block level of %s is content-lost', async (level) => {
    expect(reason(await convertInProcess(paragraphAt(level)))).toBe('content-lost');
  });

  it.each([0, 1, 6])('a block level of %i is accepted', async (level) => {
    expect(reason(await convertInProcess(paragraphAt(level)))).toBe('ok');
  });

  it('a table alignment that is not left, centre or right is content-lost; the three are accepted', async () => {
    const base = await stateFromMarkdown('| a | b |\n|---|---|\n| c | d |\n');
    const table = (alignment: string) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, base);
      const find = (parent: Y.XmlFragment | Y.XmlElement): Y.XmlElement | undefined => {
        for (const child of parent.toArray()) {
          if (!(child instanceof Y.XmlElement)) continue;
          if (child.nodeName === 'table_header') return child;
          const found = find(child);
          if (found) return found;
        }
        return undefined;
      };
      const cell = find(doc.getXmlFragment('prosemirror'));
      if (!cell) throw new Error('no header cell');
      cell.setAttribute('alignment', alignment);
      return Y.encodeStateAsUpdate(doc);
    };
    expect(reason(await convertInProcess(table('diagonal')))).toBe('content-lost');
    // One cell of a column aligned alone would not read back as the same table: only the value check is on trial here.
    for (const ok of ['left', 'center', 'right']) expect(reason(await convertInProcess(table(ok), { verifyRoundTrip: false }))).toBe('ok');
  });

  it('an attribute the node does not define is content-lost', async () => {
    const state = stateFromFragment((fragment) => {
      fragment.insert(0, [paragraphWith('text', { futureFlag: 'x' })]);
    });
    expect(await convertInProcess(state)).toMatchObject({ ok: false, reason: 'content-lost' });
  });

  it('an attribute a mark does not define is content-lost', async () => {
    const state = stateFromFragment((fragment, doc) => {
      doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        fragment.insert(0, [paragraph]);
        const text = new Y.XmlText();
        paragraph.insert(0, [text]);
        text.insert(0, 'bold text', { strong: { colour: 'red' } });
      });
    });
    expect(await convertInProcess(state)).toMatchObject({ ok: false, reason: 'content-lost' });
  });
});

describe('URL schemes that are not allowed are not stored (review finding F4; the allow-list is `isSafeUrl` in editor-schema)', () => {
  it('a javascript: link keeps its text and loses the link, at seed time and at save time', async () => {
    const seeded = await seedInProcess('[click](javascript:alert(1))\n');
    expect(seeded.ok).toBe(true);
    if (seeded.ok) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, seeded.state);
      const xml = doc.getXmlFragment(FRAGMENT_NAME).toString();
      expect(xml).toContain('click'); // seed time: the text is there and no link mark carries the unsafe address
      expect(xml).not.toMatch(/javascript:/i);
    }
    const result = await convertInProcess(await stateFromMarkdown('[click](javascript:alert(1))\n'));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.markdown).toBe('click\n');
  });
});
