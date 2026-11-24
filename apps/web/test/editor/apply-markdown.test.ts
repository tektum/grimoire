import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDirectory } from '../../src/editor/core/directory';
import { mountLive, type MountedEditor } from '../../src/editor/core/mount';
import '../support/dom';

/** An editor bound to its own document, as the page screen builds it (the provider is never connected: the test relays the updates itself). */
async function liveEditor(): Promise<{ doc: Y.Doc; editor: MountedEditor }> {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: 'ws://127.0.0.1:1', autoConnect: false, maxAttempts: 1 });
  const provider = new HocuspocusProvider({ name: 'page', document: doc, websocketProvider: socket });
  provider.attach();
  const element = document.createElement('div');
  document.body.append(element);
  const editor = await mountLive({
    element,
    doc,
    awareness: provider.awareness!,
    editable: true,
    isCancelled: () => false,
    presence: { userId: () => 'me', directory: createDirectory({ fetchNames: async () => [] }) },
  });
  if (editor === null) throw new Error('the editor was not built');
  return { doc, editor };
}

const turn = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 20));
const relay = (from: Y.Doc, to: Y.Doc): void => {
  from.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(to, update, 'relay');
  });
};
const fragmentText = (doc: Y.Doc): string => doc.getXmlFragment('prosemirror').toString();

describe('applying a Markdown text to the live editor (what a restored version does)', () => {
  it('reaches the shared document and a second editor on it, and the old text is gone from both', async () => {
    const [a, b] = [await liveEditor(), await liveEditor()];
    relay(a.doc, b.doc);
    relay(b.doc, a.doc);
    await turn();
    a.editor.applyMarkdown('First text. Second text. Third text.');
    await turn();
    expect(fragmentText(a.doc)).toContain('Third text');
    expect(b.editor.markdown()).toContain('Third text');

    b.editor.applyMarkdown('Restored text.');
    await turn();
    expect(b.editor.markdown()).toContain('Restored text.');
    expect(fragmentText(b.doc)).toContain('Restored text.');
    expect(fragmentText(a.doc)).toContain('Restored text.'); // the other side sees it like any other edit
    expect(fragmentText(a.doc)).not.toContain('Third text');
    expect(a.editor.markdown()).toContain('Restored text.');
    expect(a.editor.markdown()).not.toContain('Third text');
  });
});
