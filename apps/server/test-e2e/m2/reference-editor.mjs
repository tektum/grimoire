// The reference editor: the full browser editor on the shared plugin array under happy-dom, as `src/testing/reference-editor.ts` of the converter
// package builds it (same libraries, same plugin array, same collab binding). Written out here because that file is test support the package does
// not export, this task may not change a package.json, and the lint rules forbid importing across packages by path or through `node:module`.
// A `.mjs` file with a hand-written `.d.mts` because the Milkdown type files need `moduleResolution: Bundler`, which this folder's tsconfig does not use.
import { Editor, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/core';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';
import { Window } from 'happy-dom';

const GLOBALS = [
  'window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Text', 'DocumentFragment', 'MutationObserver',
  'Range', 'DOMParser', 'XMLSerializer', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLInputElement',
];
let happy;
let editorCount = 0;

/** Installs a happy-dom window as the globals ProseMirror reads (not `Event` and `CustomEvent`: the caller swaps those, see support.ts). */
export function installDom() {
  if (happy !== undefined) return happy;
  const win = new Window();
  const define = (key, value) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  for (const key of GLOBALS) { const value = key === 'window' ? win : Reflect.get(win, key); if (value !== undefined) define(key, value); }
  define('getSelection', () => win.getSelection());
  for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) define(key, win[key].bind(win));
  happy = win;
  return win;
}

/** A full editor bound to `ydoc` through the collab plugin, as the browser does. */
export async function createReferenceEditor(ydoc) {
  const win = installDom();
  const holder = win.document.createElement('div');
  editorCount += 1;
  const id = `reference-editor-${String(editorCount)}`;
  holder.id = id;
  win.document.body.appendChild(holder);
  const editor = Editor.make().config((ctx) => { ctx.set(rootCtx, `#${id}`); });
  editor.use(grimoireEditorPlugins);
  editor.use(collab);
  await editor.create();
  editor.action((ctx) => { ctx.get(collabServiceCtx).bindDoc(ydoc).connect(); });
  return {
    view: () => editor.action((ctx) => ctx.get(editorViewCtx)),
    markdown: () => editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)),
    destroy: () => editor.destroy(),
  };
}
