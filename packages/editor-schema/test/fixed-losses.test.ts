import { describe, expect, it } from "vitest";
import { commandsCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import { bullets, code, em, item, link, para, quote, readsBackAs, strong, text } from "./build.js";
import type { Json } from "./generate.js";
import { EditorState } from "@milkdown/prose/state";
import { Schema } from "@milkdown/prose/model";
import { headingInputRuleHandler, setBlockLevelCommand } from "../src/index.js";
import { makeEditor } from "./helpers.js";

const hardbreak = (isInline = true): Json => ({ type: "hardbreak", attrs: { isInline } });
const cell = (type: string, ...content: Json[]): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [para(0, ...content)] });

// Each of these was a listed loss that ordinary editing could produce; each now reads back as the same document.
describe("losses that no longer are", () => {
  it("a hard break in a table cell is written <br /> and read back as a hard break", async () => {
    const table: Json = { type: "table", content: [{ type: "table_header_row", content: [cell("table_header", text("h"))] }, { type: "table_row", content: [cell("table_cell", text("a"), hardbreak(), text("b"))] }] };
    const r = await readsBackAs(table);
    expect(r.markdown).toContain("a<br />b");
    expect(r).toMatchObject({ same: true, stable: true });
  });

  it("a hard break in a heading is written <br /> and read back in the same heading", async () => {
    const r = await readsBackAs(para(2, text("a"), hardbreak(), text("b")));
    expect(r.markdown).toBe("## a<br />b\n");
    expect(r).toMatchObject({ same: true, stable: true });
  });

  it("inline code next to emphasis, then a letter: `*`x`*two`", async () => {
    const r = await readsBackAs(para(0, text("x", em, code), text("two")));
    expect(r).toMatchObject({ same: true, stable: true });
  });

  it("a link between emphasised and strong runs", async () => {
    const r = await readsBackAs(para(0, text("a", em, strong), text("b", em, link), text("c", strong)));
    expect(r).toMatchObject({ same: true, stable: true });
  });

  it("a list that does not start at 1, first in a quote after a paragraph, is written after a blank line", async () => {
    const ordered: Json = { type: "ordered_list", attrs: { order: 3, spread: false }, content: [{ ...item(null, para(0, text("x"))), attrs: { label: "3.", listType: "ordered", spread: false, checked: null } }] };
    const r = await readsBackAs(bullets(item(null, para(0, text("a")), quote(ordered))));
    expect(r.markdown).toBe("* a\n\n  > 3. x\n");
    expect(r).toMatchObject({ same: true, stable: true });
  });
});

describe("a task checkbox in front of a heading cannot be written, so the editor does not make one", () => {
  const taskDoc: Json = { type: "bullet_list", attrs: { spread: false }, content: [item(false, para(0, text("todo")))] };

  it("the level command refuses the first block of a task item, and accepts it in a plain item", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(editorViewCtx)).state.schema;
    const view = editor.view();
    view.updateState(view.state.reconfigure({ plugins: view.state.plugins }));
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, schema.nodeFromJSON({ type: "doc", content: [taskDoc, { type: "bullet_list", attrs: { spread: false }, content: [item(null, para(0, text("plain")))] }] }).content));
    const call = (position: number, level: number): boolean => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      return editor.editor.action((ctx) => ctx.get(commandsCtx).call(setBlockLevelCommand.key, level));
    };
    expect(call(3, 2)).toBe(false);
    expect(editor.doc().firstChild?.firstChild?.firstChild?.attrs["level"]).toBe(0);
    expect(call(3, 0)).toBe(true);
    const plainStart = (editor.doc().firstChild?.nodeSize ?? 0) + 3;
    expect(call(plainStart, 2)).toBe(true);
    expect(editor.doc().child(1).firstChild?.firstChild?.attrs["level"]).toBe(2);
  });

  it("typing ## and a space in the first block of a task item does not make a heading", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const view = editor.view();
    const schema = view.state.schema;
    const empty: Json = { type: "bullet_list", attrs: { spread: false }, content: [item(false, para(0))] };
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, schema.nodeFromJSON({ type: "doc", content: [empty] }).content));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    view.dispatch(view.state.tr.insertText("##"));
    const { from, to } = view.state.selection;
    view.someProp("handleTextInput", (handler) => handler(view, from, to, " ", () => view.state.tr));
    expect(editor.doc().firstChild?.firstChild?.firstChild?.attrs["level"]).toBe(0);
  });
});

describe("the # input rule keeps the library's canReplaceWith guard", () => {
  // A section holds exactly a title then a paragraph; a title is a textblock but the section cannot hold a paragraph there.
  const schema = new Schema({
    nodes: {
      doc: { content: "section+" },
      section: { content: "title paragraph" },
      title: { content: "text*" },
      paragraph: { content: "text*", attrs: { level: { default: 0 } } },
      text: {},
    },
  });
  const state = (): EditorState => EditorState.create({ doc: schema.node("doc", null, [schema.node("section", null, [schema.node("title", null, [schema.text("## ")]), schema.node("paragraph", null, [schema.text("## ")])])]) });

  it("refuses where the context cannot hold a paragraph (the title), and applies where it can (the paragraph)", () => {
    const paragraph = schema.nodes["paragraph"];
    if (!paragraph) throw new Error("schema");
    expect(headingInputRuleHandler(paragraph, state(), 2, 2, 5)).toBeNull();
    const result = headingInputRuleHandler(paragraph, state(), 2, 7, 10);
    expect(result).not.toBeNull();
  });
});

describe("a mark that continues across a hard break is written once", () => {
  const brk = (isInline: boolean): Json => ({ type: "hardbreak", attrs: { isInline } });
  const marks: [string, { type: string; attrs?: Record<string, unknown> }, string, string][] = [
    ["link", { type: "link", attrs: { href: "u", title: null } }, "[", "](u)"],
    ["emphasis", { type: "emphasis" }, "*", "*"],
    ["strong", { type: "strong" }, "**", "**"],
    ["strike-through", { type: "strike_through" }, "~~", "~~"],
  ];
  it.each(marks)("%s over a Shift-Enter break (made in the editor, the break has no mark): one run, and it reads back as one", async (_name, mark, open, close) => {
    for (const inline of [true, false]) {
      const r = await readsBackAs(para(0, text("a", mark), brk(inline), text("b", mark)));
      expect(r.markdown, `${_name} ${inline}`).toBe(`${open}a${inline ? "\n" : "\\\n"}b${close}\n`);
      expect(r).toMatchObject({ same: true, stable: true });
    }
  });

  it("a link whose text wraps across two source lines in Markdown stays one link", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse("see [the plugin wiki\narticle](https://x.y/z) now\n");
    expect(editor.serialize(doc)).toBe("see [the plugin wiki\narticle](https://x.y/z) now\n");
    expect(JSON.stringify(doc.toJSON()).match(/"type":"link"/g)?.length).toBe(3); // two text runs and the break, one link
  });

  it("different links on the two sides are not joined", async () => {
    const other = { type: "link", attrs: { href: "v", title: null } };
    const r = await readsBackAs(para(0, text("a", { type: "link", attrs: { href: "u", title: null } }), brk(false), text("b", other)));
    expect(r.markdown).toContain("](u)");
    expect(r.markdown).toContain("](v)");
    expect(r).toMatchObject({ same: true, stable: true });
  });
});

describe("two things the reader got wrong on import", () => {
  it("nested emphasis keeps the outer italics: *a **b *c* d** e* (as the CommonMark reference renders it)", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse("*a **b *c* d** e*\n");
    const runs: [string, string[]][] = [];
    doc.descendants((node) => {
      if (node.isText) runs.push([node.text ?? "", node.marks.map((mark) => mark.type.name).sort()]);
    });
    expect(runs).toEqual([["a ", ["emphasis"]], ["b c d", ["emphasis", "strong"]], [" e", ["emphasis"]]]);
  });

  it("an imported empty to-do item (`* [ ]`, `* [x]`) is a task item with an empty paragraph, not the text [ ]", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse("* [ ]\n* [x]\n* [ ] done\n");
    const checked: unknown[] = [];
    doc.descendants((node) => {
      if (node.type.name === "list_item") checked.push(node.attrs["checked"]);
    });
    expect(checked).toEqual([false, true, false]);
    expect(editor.serialize(doc)).toBe("* [ ] <br />\n* [x] <br />\n* [ ] done\n");
    expect(editor.serialize(editor.parse(editor.serialize(doc)))).toBe(editor.serialize(doc));
  });
});

describe("a break element followed by a newline is one line break", () => {
  it("`here <br/>` + newline + text reads as one hard break (before, an html break and a second break)", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse("see [here](u) <br/>\nthen text\n");
    let breaks = 0;
    doc.descendants((node) => {
      if (node.type.name === "hardbreak") breaks += 1;
    });
    expect(breaks).toBe(1);
    expect(editor.serialize(doc)).toBe("see [here](u)\\\nthen text\n");
  });
});
