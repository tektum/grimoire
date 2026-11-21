import { editorViewCtx, schemaCtx } from "@milkdown/core";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import { code, em, link, para, roundTrip, strong, text } from "./build.js";
import type { Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

const strike = { type: "strike_through" };
const NAMES = (json: unknown): string => JSON.stringify(json);

/** `a`, a run of only whitespace carrying one mark, `b`: does the mark survive Markdown, and does the normal form say so? */
async function lone(whitespace: string, mark: { type: string }): Promise<{ markdown: string; survives: boolean; normalKeeps: boolean }> {
  const editor = await makeEditor({ markdown: "x\n" });
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  const doc = schema.nodeFromJSON({ type: "doc", content: [para(0, text("a"), text(whitespace, mark), text("b"))] });
  const markdown = editor.serialize(doc);
  const has = (json: unknown): boolean => NAMES(json).includes(`"type":"${mark.type}"`);
  const normal = normaliseForMarkdown(doc);
  expect(NAMES(editor.parse(markdown).toJSON())).toBe(NAMES(normal.toJSON())); // the normal form agrees with the read-back
  return { markdown, survives: has(editor.parse(markdown).toJSON()), normalKeeps: has(normal.toJSON()) };
}

describe("a run of only whitespace between two letters, with a mark", () => {
  // Visible, if small: a clickable gap, a monospace gap, a struck gap. The mark is lost; the normal form says so.
  it.each([["link", link], ["strike-through", strike]] as [string, { type: string }][])("%s on one space: the mark is lost (a visible loss)", async (_name, mark) => {
    const r = await lone(" ", mark);
    expect(r.markdown).toBe("a b\n");
    expect(r.survives).toBe(false);
    expect(r.normalKeeps).toBe(false);
  });

  it.each([["link", link], ["strike-through", strike]] as [string, { type: string }][])("%s on several spaces: the mark is lost as well", async (_name, mark) => {
    expect((await lone("   ", mark)).survives).toBe(false);
  });

  // Code text is never trimmed: spaces are characters, and the writer pads the code span so they survive.
  it("inline code keeps one space and several spaces between two letters", async () => {
    for (const spaces of [" ", "   "]) {
      const r = await lone(spaces, code);
      expect(r.survives).toBe(true);
      expect(r.markdown).toBe(`a\`${spaces}\`b\n`);
    }
  });

  // Nothing to see: an emphasised or strong space looks like any other.
  it.each([["emphasis", em], ["strong", strong]] as [string, { type: string }][])("%s on a space: the mark is dropped, invisibly", async (_name, mark) => {
    const r = await lone(" ", mark);
    expect(r.markdown).toBe("a b\n");
    expect(r.survives).toBe(false);
  });

  // A tab and a no-break space are written as a character reference or inside the delimiters, and keep every mark.
  it.each([["tab", "\t"], ["no-break space", "\u00a0"]])("a %s keeps its mark through the round trip", async (_name, whitespace) => {
    for (const mark of [link, code, strike, em, strong]) {
      const r = await lone(whitespace, mark);
      expect(r.survives, `${mark.type} ${_name}`).toBe(true);
      expect(r.normalKeeps).toBe(true);
    }
  });
});

describe("what the editor can make that a generator also makes", () => {
  const cell = (type: string, ...content: Json[]): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [para(0, ...content)] });

  it("a table with an empty header row (header text deleted) round-trips and is stable", async () => {
    const table: Json = { type: "table", content: [{ type: "table_header_row", content: [cell("table_header"), cell("table_header")] }, { type: "table_row", content: [cell("table_cell", text("a")), cell("table_cell", text("b"))] }] };
    const r = await roundTrip(table);
    expect(r.markdown).toBe("|   |   |\n| - | - |\n| a | b |\n");
    expect(r.again).toBe(r.markdown);
    expect(NAMES(r.after)).toContain('"type":"table_header"');
  });

  it("list labels: the editor keeps them in step (deleting the first item renumbers), so a stale one comes only from outside", async () => {
    const editor = await makeEditor({ markdown: "1. a\n2. b\n3. c\n" });
    const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
    const labels = (): string[] => {
      const out: string[] = [];
      view.state.doc.descendants((node) => {
        if (node.type.name === "list_item") out.push(String(node.attrs["label"]));
      });
      return out;
    };
    expect(labels()).toEqual(["1.", "2.", "3."]);
    const first = view.state.doc.firstChild?.firstChild;
    view.dispatch(view.state.tr.delete(1, 1 + (first?.nodeSize ?? 0)));
    expect(labels()).toEqual(["1.", "2."]);
  });

  it("a label that is out of step (hand-built, or a merged Yjs copy) is derived: the read-back and the normal form both renumber it", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const li = (label: string, t: string): Json => ({ type: "list_item", attrs: { label, listType: "ordered", spread: false, checked: null }, content: [para(0, text(t))] });
    const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "ordered_list", attrs: { order: 1, spread: false }, content: [li("5.", "x"), li("9.", "y")] }] });
    const markdown = editor.serialize(doc);
    expect(markdown).toBe("1. x\n2. y\n");
    expect(NAMES(editor.parse(markdown).toJSON())).toContain('"label":"2."');
    expect(NAMES(normaliseForMarkdown(doc).toJSON())).toContain('"label":"2."');
    expect(NAMES(normaliseForMarkdown(doc).toJSON())).not.toContain('"label":"9."');
  });
});
