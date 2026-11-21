import { editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import { commandsCtx } from "@milkdown/core";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { FRAGMENT_NAME, setBlockLevelCommand } from "../src/index.js";
import { linkDocs, makeEditor, type TestEditor } from "./helpers.js";

function cursorAtEndOfFirstBlock(editor: TestEditor): void {
  const view = editor.view();
  const first = view.state.doc.firstChild;
  if (!first) throw new Error("empty document");
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, first.nodeSize - 1)));
}

describe("two editors on one Yjs document", () => {
  it("a level change and concurrent typing both survive, as an attribute of the same paragraph", async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const sync = linkDocs(docA, docB);
    const a = await makeEditor({ ydoc: docA, markdown: "hello\n" });
    sync.flush();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "remote");
    const b = await makeEditor({ ydoc: docB });
    expect(b.markdown()).toBe("hello\n");

    // Concurrent: A turns the paragraph into level 2, B types at its end; nothing is exchanged in between.
    cursorAtEndOfFirstBlock(a);
    expect(a.editor.action((ctx) => ctx.get(commandsCtx).call(setBlockLevelCommand.key, 2))).toBe(true);
    cursorAtEndOfFirstBlock(b);
    const bView = b.editor.action((ctx) => ctx.get(editorViewCtx));
    bView.dispatch(bView.state.tr.insertText(" world"));
    sync.flush();

    for (const editor of [a, b]) {
      expect(editor.markdown()).toBe("## hello world\n");
      expect(editor.doc().firstChild?.attrs["level"]).toBe(2);
    }
    const fragment = docA.getXmlFragment(FRAGMENT_NAME);
    const first = fragment.get(0);
    expect(first).toBeInstanceOf(Y.XmlElement);
    expect(first instanceof Y.XmlElement && first.nodeName).toBe("paragraph");
    expect(first instanceof Y.XmlElement && first.getAttribute("level")).toBe(2);
  });
});
