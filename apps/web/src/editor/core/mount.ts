import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, rootCtx, schemaCtx } from '@milkdown/core';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { applyMarkdown, markdownOf } from './api';
import { presenceAwareness } from './awareness';
import { cursorBuilders } from './cursor';
import { guardLinks } from './links';
import type { Directory } from './directory';
import { uiPlugins } from './plugins';

export interface MountedEditor {
  /** Turns editing on or off without rebuilding the editor. */
  setEditable(editable: boolean): void;
  markdown(): string;
  applyMarkdown(markdown: string): void;
  /** Destroys the editor and removes its DOM. Resolves when it is gone. */
  destroy(): Promise<void>;
}

/** A mounted editor that can also say what its schema holds (for the tests of the screen's editor). */
export interface InspectableEditor extends MountedEditor {
  /** The names of the node and mark types of the editor's schema: what the screen's editor can hold. */
  schemaNames(): { readonly nodes: readonly string[]; readonly marks: readonly string[] };
}

const wrap = (editor: Editor, flag: { editable: boolean }, onDestroy: () => void = () => undefined): InspectableEditor => ({
  setEditable(editable) {
    flag.editable = editable;
    // An empty transaction makes ProseMirror read the `editable` option again.
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr);
    });
  },
  markdown: () => markdownOf(editor),
  schemaNames: () => editor.action((ctx) => ({ nodes: Object.keys(ctx.get(schemaCtx).nodes), marks: Object.keys(ctx.get(schemaCtx).marks) })),
  applyMarkdown: (markdown) => applyMarkdown(editor, markdown),
  destroy: async () => {
    onDestroy();
    await editor.destroy(true);
  },
});

const base = (element: HTMLElement, flag: { editable: boolean }): Editor =>
  Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, element);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => flag.editable }));
    })
    .use(grimoireEditorPlugins)
    .use(uiPlugins);

/** The saved text of a page, shown before the live editor is ready: the same editor with no connection, never editable. */
export async function mountReadOnly(element: HTMLElement, markdown: string): Promise<InspectableEditor> {
  const flag = { editable: false };
  const editor = base(element, flag).config((ctx) => void ctx.set(defaultValueCtx, markdown));
  await editor.create();
  return wrap(editor, flag, guardLinks(element));
}

/**
 * The live editor on a Yjs document. When `isCancelled()` turns true while it is being built (React strict mode runs an
 * effect twice) it is destroyed at once without ever being bound to the document, and null is returned.
 */
export async function mountLive(options: {
  element: HTMLElement;
  doc: Y.Doc;
  awareness: NonNullable<HocuspocusProvider['awareness']>;
  editable: boolean;
  isCancelled: () => boolean;
  /** Who is who: the signed-in id (the `user.id` that is published) and the directory the remote cursors take names from. */ presence: { userId: () => string | null; directory: Directory };
}): Promise<MountedEditor | null> {
  const flag = { editable: options.editable };
  const editor = base(options.element, flag).use(collab);
  await editor.create();
  if (options.isCancelled()) {
    await editor.destroy(true);
    return null;
  }
  const cursors = cursorBuilders(options.presence.directory);
  editor.action((ctx) => {
    const { cursorBuilder, selectionBuilder } = cursors;
    // Only `user.id`, `cursor` and `blockId` go out, at most four times a second; remote cursors show the directory name and the colour derived from the id.
    const awareness = presenceAwareness(options.awareness, { userId: options.presence.userId });
    ctx.get(collabServiceCtx).setOptions({ yCursorOpts: { cursorBuilder, selectionBuilder } }).bindDoc(options.doc).setAwareness(awareness).connect();
  });
  const stopGuarding = guardLinks(options.element);
  return wrap(editor, flag, () => {
    stopGuarding();
    cursors.dispose();
    // Unbinds the document and the awareness while the editor can still answer, so that taking the editor down does not apply a last change to a view that is going.
    try {
      editor.action((ctx) => void ctx.get(collabServiceCtx).disconnect());
    } catch {
      // the editor was already taken down: nothing is bound any more
    }
  });
}
