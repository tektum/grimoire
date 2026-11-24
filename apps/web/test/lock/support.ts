import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Editor, editorViewCtx, rootCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import type { EditorView } from '@milkdown/prose/view';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';
import * as Y from 'yjs';
import { createDirectory } from '../../src/editor/core/directory';
import { uiPlugins } from '../../src/editor/core/plugins';
import { lockContext } from '../../src/editor/lock';
import '../support/dom';

export interface CollabEditor {
  readonly editor: Editor;
  readonly doc: Y.Doc;
  readonly element: HTMLElement;
  readonly awareness: HocuspocusProvider['awareness'] & {};
  readonly ctx: Ctx;
  view(): EditorView;
  /** Another person's cursor, as the awareness would say it: `userId` is in the block with this id. */
  remote(clientId: number, userId: string, blockId: string | null): void;
  destroy(): Promise<void>;
}

/** The screen's editor bound to a shared document with a real awareness, as `mountLive` binds it, with the lock's context set (names from `names`). */
export async function collabEditor(markdown: string, options: { userId?: string; names?: Record<string, string>; doc?: Y.Doc } = {}): Promise<CollabEditor> {
  const doc = options.doc ?? new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: 'ws://127.0.0.1:1', autoConnect: false, maxAttempts: 1 });
  const provider = new HocuspocusProvider({ name: 'page', document: doc, websocketProvider: socket });
  provider.attach();
  const awareness = provider.awareness!;
  const element = document.createElement('div');
  document.body.append(element);
  const directory = createDirectory({ fetchNames: async (ids) => ids.flatMap((id) => (options.names?.[id] === undefined ? [] : [{ id, name: options.names[id]! }])) });
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, element);
    })
    .use(grimoireEditorPlugins)
    .use(collab)
    .use(uiPlugins);
  await editor.create();
  editor.action((ctx) => {
    ctx.set(lockContext.key, { awareness: awareness as never, userId: () => options.userId ?? 'me', directory }); // as the screen's mount sets it, once the editor is built
    ctx.get(collabServiceCtx).bindDoc(doc).setAwareness(awareness).connect();
  });
  const view = (): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));
  const ctx = editor.action((c) => c);
  if (markdown !== '') editor.action((c) => void c.get(collabServiceCtx).applyTemplate(markdown, () => true));
  return {
    editor,
    doc,
    element,
    awareness,
    ctx,
    view,
    remote: (clientId, userId, blockId) => {
      awareness.states.set(clientId, { user: { id: userId }, blockId });
      directory.request([userId]);
    },
    destroy: async () => {
      editor.action((ctx) => void ctx.get(collabServiceCtx).disconnect()); // as the screen does, so that taking the editor down applies no last change to a view that is going
      await editor.destroy(true);
      element.remove();
    },
  };
}
