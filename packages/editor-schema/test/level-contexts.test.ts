import { commandsCtx, editorViewCtx, schemaCtx } from "@milkdown/core";
import type { Node, NodeType } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { describe, expect, it } from "vitest";
import { setBlockLevelCommand } from "../src/index.js";
import { item, para, text } from "./build.js";
import type { Json } from "./generate.js";
import { makeEditor, type TestEditor } from "./helpers.js";

const cell = (type: string): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [para(0, text("c"))] });
const table: Json = { type: "table", content: [{ type: "table_header_row", content: [cell("table_header")] }, { type: "table_row", content: [cell("table_cell")] }] };

/** Node types whose content rule can hold a paragraph, found by walking every content expression. */
function typesHoldingParagraphs(types: Record<string, NodeType>): string[] {
  const paragraph = types["paragraph"];
  return Object.values(types)
    .filter((type) => {
      const seen = new Set<unknown>();
      const walk = (match: NodeType["contentMatch"]): boolean => {
        if (seen.has(match)) return false;
        seen.add(match);
        for (let index = 0; index < match.edgeCount; index++) {
          const edge = match.edge(index);
          if (edge.type === paragraph || walk(edge.next)) return true;
        }
        return false;
      };
      return walk(type.contentMatch);
    })
    .map((type) => type.name)
    .sort();
}

async function load(blocks: Json[]): Promise<TestEditor> {
  const editor = await makeEditor({ markdown: "x\n" });
  const view = editor.view();
  const schema = view.state.schema;
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, schema.nodeFromJSON({ type: "doc", content: blocks }).content));
  return editor;
}

/** Put the cursor in the first paragraph inside a node of `parent` and ask for the level. */
function askForLevel(editor: TestEditor, parent: string, level: number): boolean {
  const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
  let at = -1;
  view.state.doc.descendants((node: Node, pos: number) => {
    if (at < 0 && node.type.name === "paragraph" && view.state.doc.resolve(pos + 1).node(view.state.doc.resolve(pos + 1).depth - 1).type.name === parent) at = pos + 1;
  });
  if (at < 0) throw new Error(`no paragraph inside ${parent}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  return editor.editor.action((ctx) => ctx.get(commandsCtx).call(setBlockLevelCommand.key, level));
}

describe("where a heading-level paragraph can be made", () => {
  it("the node types whose content can hold a paragraph are exactly the ones tested below", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    expect(typesHoldingParagraphs(schema.nodes)).toEqual(["blockquote", "doc", "footnote_definition", "list_item", "table_cell", "table_header"]);
  });

  it.each([
    ["doc", [para(0, text("a"))]],
    ["blockquote", [{ type: "blockquote", content: [para(0, text("a"))] }]],
    ["list_item", [{ type: "bullet_list", attrs: { spread: false }, content: [item(null, para(0, text("a")))] }]],
  ] as [string, Json[]][])("%s: the level command works and the level is written", async (parent, blocks) => {
    const editor = await load(blocks);
    expect(askForLevel(editor, parent, 2)).toBe(true);
    expect(editor.markdown()).toContain("## a");
  });

  it.each(["table_header", "table_cell"])("%s: the level command refuses (GFM cells cannot hold a heading)", async (parent) => {
    const editor = await load([table]);
    expect(askForLevel(editor, parent, 2)).toBe(false);
    expect(editor.markdown()).not.toContain("##");
  });

  it("the first block of a task item: refused", async () => {
    const editor = await load([{ type: "bullet_list", attrs: { spread: false }, content: [item(false, para(0, text("a")))] }]);
    expect(askForLevel(editor, "list_item", 2)).toBe(false);
  });

  it("typing ## and a space in a table cell does not make a heading, in a header and in a body cell", async () => {
    for (const parent of ["table_header", "table_cell"]) {
      const editor = await load([table]);
      const view = editor.view();
      let at = -1;
      view.state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === parent) at = pos + 2;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
      view.dispatch(view.state.tr.insertText("##"));
      const { from, to } = view.state.selection;
      view.someProp("handleTextInput", (handler) => handler(view, from, to, " ", () => view.state.tr));
      let levels = 0;
      view.state.doc.descendants((node) => {
        if (node.type.name === "paragraph" && node.attrs["level"] !== 0) levels += 1;
      });
      expect(levels, parent).toBe(0);
    }
  });

  it("a cell paragraph that already has a level (from Yjs or a paste) is written without it: a listed loss", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const levelled: Json = { type: "table", content: [{ type: "table_header_row", content: [{ ...cell("table_header"), content: [para(2, text("h"))] }] }, { type: "table_row", content: [cell("table_cell")] }] };
    const markdown = editor.serialize(schema.nodeFromJSON({ type: "doc", content: [levelled] }));
    expect(markdown).not.toContain("##");
    expect(JSON.stringify(editor.parse(markdown).toJSON())).not.toContain('"level":2');
  });

  it("footnote_definition: a levelled paragraph in a footnote is written and read back", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const definition: Json = { type: "footnote_definition", attrs: { label: "1" }, content: [para(2, text("note"))] };
    const doc = schema.nodeFromJSON({ type: "doc", content: [para(0, text("a "), { type: "footnote_reference", attrs: { label: "1" } }), definition] });
    const markdown = editor.serialize(doc);
    expect(JSON.stringify(editor.parse(markdown).toJSON())).toContain('"level":2');
  });
});
