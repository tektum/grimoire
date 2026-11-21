import { Window } from "happy-dom";
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx, schemaCtx, serializerCtx } from "@milkdown/core";
import { collab, collabServiceCtx } from "@milkdown/plugin-collab";
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { Node } from "@milkdown/prose/model";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { FRAGMENT_NAME, grimoireEditorPlugins } from "../src/index.js";

const GLOBALS = [
  "window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "DocumentFragment", "MutationObserver",
  "Range", "DOMParser", "XMLSerializer", "requestAnimationFrame", "cancelAnimationFrame", "HTMLInputElement",
  "CustomEvent", "Event",
] as const;

let installed: Window | undefined;

/** Install a happy-dom window as the globals ProseMirror reads (the real editor needs a DOM; the converter does not). */
export function installDom(): Window {
  if (installed) return installed;
  const win = new Window();
  for (const key of GLOBALS) {
    const value: unknown = key === "window" ? win : Reflect.get(win, key);
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "getSelection", { value: () => win.getSelection(), configurable: true, writable: true });
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
    Object.defineProperty(globalThis, key, { value: win[key].bind(win), configurable: true, writable: true });
  }
  installed = win;
  return win;
}

export interface TestEditor {
  editor: Editor;
  markdown(): string;
  doc(): Node;
  parse(markdown: string): Node;
  serialize(node: Node): string;
  view(): ReturnType<typeof viewOf>;
}
const viewOf = (editor: Editor) => editor.action((ctx) => ctx.get(editorViewCtx));

/** A full editor (the browser configuration) on the shared plugin array; optionally bound to a Yjs document. */
export async function makeEditor(options: { markdown?: string; ydoc?: Y.Doc; plugins?: MilkdownPlugin[] } = {}): Promise<TestEditor> {
  installDom();
  const root = document.body.appendChild(document.createElement("div"));
  const editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root);
    if (options.markdown !== undefined && !options.ydoc) ctx.set(defaultValueCtx, options.markdown);
  });
  editor.use(options.plugins ?? grimoireEditorPlugins);
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
    markdown: () => editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)),
    doc: () => viewOf(editor).state.doc,
    parse: (md) => editor.action((ctx) => ctx.get(parserCtx)(md)),
    serialize: (node) => editor.action((ctx) => ctx.get(serializerCtx)(node)),
    view: () => viewOf(editor),
  };
}

/** Markdown to document to Yjs fragment to document to Markdown, with no editor view in the middle. */
export async function yjsRoundTrip(markdown: string): Promise<{ direct: string; viaYjs: string }> {
  const editor = await makeEditor({ markdown });
  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(editor.doc(), ydoc.getXmlFragment(FRAGMENT_NAME));
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  const back = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT_NAME), schema);
  return { direct: editor.serialize(editor.doc()), viaYjs: editor.serialize(back as Node) };
}

/** Two Yjs documents that exchange updates once `flush` is called, so edits can be concurrent. */
export function linkDocs(a: Y.Doc, b: Y.Doc): { flush(): void } {
  const toB: Uint8Array[] = [];
  const toA: Uint8Array[] = [];
  a.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") toB.push(update);
  });
  b.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") toA.push(update);
  });
  return {
    flush() {
      for (const update of toB.splice(0)) Y.applyUpdate(b, update, "remote");
      for (const update of toA.splice(0)) Y.applyUpdate(a, update, "remote");
    },
  };
}
