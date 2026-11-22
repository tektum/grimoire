import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import { convertInProcess } from '../../src/index.js';
import { makeReferenceEditor } from '../../src/testing/reference-editor.js';

/** An editor bound to a Yjs document through the collab plugin, as in the browser, edited like a user would. */
describe('a real collaborative editor against the converter', () => {
  it('converts the update of an edited page to what the editor itself serialises', async () => {
    const ydoc = new Y.Doc();
    const editor = await makeReferenceEditor({ ydoc, markdown: 'first line\n\nsecond line\n' });
    const view = editor.view();

    // typing at the end of the first paragraph
    view.dispatch(view.state.tr.insertText(' typed', 11));

    // a heading change: the same paragraph gets level 2 (an attribute change, as the editor commands do)
    const first = view.state.doc.child(0);
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { ...first.attrs, level: 2 }));

    // a list appended after the last block
    const list = editor.parse('- alpha\n- beta\n  - gamma\n');
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, list.content));

    // the Yjs binding writes asynchronously after a dispatch: wait until the document holds the last edit (bounded, no fixed sleep)
    const written = (): boolean => ydoc.getXmlFragment(FRAGMENT_NAME).toString().includes('gamma');
    await vi.waitFor(() => expect(written(), 'the Yjs binding wrote the last edit').toBe(true), { timeout: 10_000, interval: 5 });

    const expected = editor.markdown();
    expect(expected).toContain('## first line typed');
    expect(expected).toContain('* alpha');

    const converted = await convertInProcess(Y.encodeStateAsUpdate(ydoc));
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.markdown).toBe(expected);
    expect(converted.text).toContain('first line typed');
    await editor.destroy();
  }, 30_000);
});
