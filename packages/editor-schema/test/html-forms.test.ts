import { schemaCtx } from "@milkdown/core";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import { bullets, item, para, readsBackAs, text } from "./build.js";
import type { Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

const html = (value: string): Json => ({ type: "html", attrs: { value } });

/** The normal form of the blocks as JSON text. */
const normalForm = async (...blocks: Json[]): Promise<string> => {
  const editor = await makeEditor({ markdown: "x\n" });
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  return JSON.stringify(normaliseForMarkdown(schema.nodeFromJSON({ type: "doc", content: blocks })).toJSON());
};

// CommonMark 0.31, section 4.6 "HTML blocks", lists seven start conditions. Conditions 1 to 5 end at a terminator
// (`</pre>` and friends, `-->`, `?>`, `>`, `]]>`); 6 and 7 end at a blank line. The value is not closed inside the node,
// so written bare it would swallow the blocks after it.
const CONDITIONS: [number, string][] = [
  [1, "<pre>"],
  [2, "<!--"],
  [3, "<?php"],
  [4, "<!DOCTYPE"],
  [5, "<![CDATA["],
  [6, "<div>"],
  [7, "<custom-tag>"],
];

// Conditions 1 to 5 need a terminator the node does not hold, so the opening tag is kept as literal text; 6 and 7 end at a blank line and stay HTML.
const STAYS_HTML = new Set([6, 7]);
const opening = (condition: number, value: string): string => JSON.stringify(STAYS_HTML.has(condition) ? html(value) : { type: "text", text: value });

describe("raw HTML that opens a block: the blocks after it survive", () => {
  it.each(CONDITIONS)("start condition %i (%s), at the top level", async (condition, value) => {
    const r = await readsBackAs(para(0, html(value)), para(0, text("z")), para(0, text("end")));
    expect(r).toMatchObject({ same: true, stable: true });
    expect(r.markdown).toContain("z");
    // An opening tag that is not closed inside its node becomes the literal text of the same characters (written as raw HTML it would swallow the blocks
    // after it); those blocks are kept. The comparison above only compares the normaliser with itself, so the exact normal form is stated here.
    const normal = await normalForm(para(0, html(value)), para(0, text("z")), para(0, text("end")));
    expect(normal).toContain(opening(condition, value));
    expect(normal.includes('"type":"html"')).toBe(STAYS_HTML.has(condition));
    expect(normal).toContain('"text":"z"');
    expect(normal).toContain('"text":"end"');
  });

  it.each(CONDITIONS)("start condition %i (%s), alone in a tight list item before another block", async (condition, value) => {
    const r = await readsBackAs(bullets(item(null, para(0, html(value)), para(0, text("z")))));
    expect(r).toMatchObject({ same: true, stable: true });
    expect(r.markdown).toContain("z");
    const normal = await normalForm(bullets(item(null, para(0, html(value)), para(0, text("z")))));
    expect(normal).toContain(opening(condition, value));
    expect(normal).toContain('"text":"z"');
  });

  it("the closed forms stay HTML", async () => {
    for (const value of ["<pre>x</pre>", "<!-- c -->", "<?php x ?>", "<!DOCTYPE html>", "<![CDATA[x]]>"]) {
      const r = await readsBackAs(para(0, html(value)), para(0, text("z")));
      expect(r.markdown.startsWith(value), value).toBe(true);
      expect(r, value).toMatchObject({ same: true, stable: true });
    }
  });
});

describe("a whole element in one html node is read back as its tags and the text between them", () => {
  const split = async (...blocks: Json[]): Promise<string> => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    return JSON.stringify(normaliseForMarkdown(schema.nodeFromJSON({ type: "doc", content: blocks })).toJSON());
  };

  const tag = (value: string): Json => ({ type: "html", attrs: { value } });
  const doc = (...content: Json[]): string => JSON.stringify({ type: "doc", content });
  const taskItem = (...content: Json[]): Json => ({ type: "list_item", attrs: { label: "\u2022", listType: "bullet", spread: false, checked: false }, content });

  // Each case lists the exact normal form: the type, tag and text of every node (nothing is derived from the normaliser's own output).
  it.each([
    ["after text", para(0, text("a "), html("<aside>n</aside>")), doc(para(0, text("a "), tag("<aside>"), text("n"), tag("</aside>")))],
    ["in a heading", para(2, html("<b>x</b>")), doc(para(2, tag("<b>"), text("x"), tag("</b>")))],
    ["in a task item", bullets(item(false, para(0, html("<b>x</b>")))), doc({ type: "bullet_list", attrs: { spread: false }, content: [taskItem(para(0, tag("<b>"), text("x"), tag("</b>")))] })],
  ] as [string, Json, string][])("%s: the normal form is exactly the tag, the text and the closing tag, and equals the read-back (a normalisation: the reader sees nothing change)", async (_name, block, expected) => {
    expect(await split(block)).toBe(expected);
    expect(await readsBackAs(block)).toMatchObject({ same: true, stable: true });
  });

  it("alone in a paragraph, a block element (`<div>x</div>`) is an HTML block and stays one node; an inline one (`<b>x</b>`) splits", async () => {
    expect((await split(para(0, html("<div>x</div>")))).match(/"type":"html"/g)?.length).toBe(1);
    expect(await readsBackAs(para(0, html("<div>x</div>")))).toMatchObject({ same: true, stable: true });
    expect((await split(para(0, html("<b>x</b>")))).match(/"type":"html"/g)?.length).toBe(2);
    expect(await readsBackAs(para(0, html("<b>x</b>")))).toMatchObject({ same: true, stable: true });
  });
});

describe("break elements in html values", () => {
  it.each([" <br> ", "<br><br>", "<br> <br>", "<BR/>"])("the value %j is hard breaks in the normal form, as the reader makes of it", async (value) => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const doc = schema.nodeFromJSON({ type: "doc", content: [para(0, text("a"), html(value), text("b"))] });
    const normal = JSON.stringify(normaliseForMarkdown(doc).toJSON());
    expect(normal.match(/"type":"hardbreak"/g)?.length, "one hard break for every br element").toBe(value.match(/<br\s*\/?>/gi)?.length);
    expect(normal).not.toContain('"type":"html"');
    expect(await readsBackAs(para(0, text("a"), html(value), text("b")))).toMatchObject({ same: true, stable: true });
  });
});
