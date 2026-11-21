import { Window } from 'happy-dom';
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx, schemaCtx, serializerCtx } from '@milkdown/core';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import type * as Y from 'yjs';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';

/**
 * The full browser editor on the shared plugin array under happy-dom: the reference the headless converter is compared
 * with (parity tests, and the end-to-end save scenarios). Test support only: happy-dom is a devDependency,
 * and nothing in `index.ts` imports this file.
 */

const GLOBALS = [
  'window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver',
  'Range', 'DOMParser', 'XMLSerializer', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLInputElement',
  'CustomEvent', 'Event',
] as const;

let installed: Window | undefined;
let nextId = 0;

/** Install a happy-dom window as the globals ProseMirror reads. The converter itself needs none of them. */
export function installDom(): Window {
  if (installed) return installed;
  const win = new Window();
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of GLOBALS) {
    const value: unknown = key === 'window' ? win : Reflect.get(win, key);
    if (value !== undefined) define(key, value);
  }
  define('getSelection', () => win.getSelection());
  for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const) define(key, win[key].bind(win));
  installed = win;
  return win;
}

const viewOf = (editor: Editor) => editor.action((ctx) => ctx.get(editorViewCtx));

/** A full editor; optionally bound to a Yjs document through the collab plugin, as the browser does. */
export async function makeReferenceEditor(options: { markdown?: string; ydoc?: Y.Doc } = {}) {
  const win = installDom();
  // A selector string: `rootCtx` resolves it with the global `document`, and the DOM types are not in this library set.
  const holder = win.document.createElement('div');
  const id = `reference-editor-${(nextId += 1)}`;
  holder.id = id;
  win.document.body.appendChild(holder);
  const editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, `#${id}`);
    if (options.markdown !== undefined && !options.ydoc) ctx.set(defaultValueCtx, options.markdown);
  });
  editor.use(grimoireEditorPlugins);
  if (options.ydoc) editor.use(collab);
  await editor.create();
  const { ydoc, markdown } = options;
  if (ydoc) {
    editor.action((ctx) => {
      const service = ctx.get(collabServiceCtx).bindDoc(ydoc);
      if (markdown !== undefined) service.applyTemplate(markdown);
      service.connect();
    });
  }
  return {
    editor,
    /** The editor's own serializer applied to its current document. */
    markdown: () => editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)),
    doc: () => viewOf(editor).state.doc,
    view: () => viewOf(editor),
    parse: (text: string) => editor.action((ctx) => ctx.get(parserCtx)(text)),
    schema: () => editor.action((ctx) => ctx.get(schemaCtx)),
    destroy: () => editor.destroy(),
  };
}

export type ReferenceEditor = Awaited<ReturnType<typeof makeReferenceEditor>>;
