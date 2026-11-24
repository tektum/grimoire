import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDirectory } from '../../src/editor/core/directory';
import { mountLive, mountReadOnly } from '../../src/editor/core/mount';
import '../support/dom';

const surface = (element: HTMLElement): HTMLElement => element.querySelector<HTMLElement>('.ProseMirror')!;

describe('the name of the editing surface', () => {
  it('the saved view has one: the surface is a text box, and a text box without a name fails the accessibility rule', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const editor = await mountReadOnly(element, '# Title\n\nText\n');
    expect(surface(element).getAttribute('aria-label')).toBe('Page text');
    expect(surface(element).getAttribute('aria-multiline')).toBe('true');
    await editor.destroy();
  });

  it('the live editor has the same name, editable or not', async () => {
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
    expect(editor).not.toBeNull();
    expect(surface(element).getAttribute('aria-label')).toBe('Page text');
    editor!.setEditable(false);
    expect(surface(element).getAttribute('aria-label')).toBe('Page text');
    await editor!.destroy();
  });
});
