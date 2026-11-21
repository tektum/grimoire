import { schemaCtx } from "@milkdown/core";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import { para, readsBackAs, text } from "./build.js";
import type { Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

const html = (value: string): Json => ({ type: "html", attrs: { value } });
const hardbreak: Json = { type: "hardbreak", attrs: { isInline: false } };

describe("converted on load: a bare break element is a hard break", () => {
  it.each(["<br>", "<br/>", "<br />", "<BR>", "<Br / >".replace(" / ", " /")])("%s in Markdown reads as a hard break", async (value) => {
    const editor = await makeEditor({ markdown: "x\n" });
    const doc = editor.parse(`a${value}b\n`);
    expect(JSON.stringify(doc.toJSON())).toContain('"type":"hardbreak"');
    expect(JSON.stringify(doc.toJSON())).not.toContain('"type":"html"');
  });

  it("a stored html node that is a bare break: the normal form has a hard break, and it reads back as that", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const doc = schema.nodeFromJSON({ type: "doc", content: [para(0, text("a"), html("<br>"), text("b"))] });
    const normal = normaliseForMarkdown(doc);
    expect(JSON.stringify(normal.toJSON())).toContain('"type":"hardbreak"');
    expect(JSON.stringify(normal.toJSON())).not.toContain('"type":"html"');
    expect(JSON.stringify(editor.parse(editor.serialize(doc)).toJSON())).toBe(JSON.stringify(normal.toJSON()));
  });

  it("typed text that spells <br /> stays text", async () => {
    const r = await readsBackAs(para(0, text("a <br /> b")));
    expect(r).toMatchObject({ same: true, stable: true });
    expect(r.markdown).toBe("a \\<br /> b\n");
  });
});

describe("raw HTML at the start of a line", () => {
  it("an html node alone on its line is written as the same literal text (it would start an HTML block)", async () => {
    const r = await readsBackAs(para(0, html("</b>"), hardbreak, text("&")));
    expect(r.markdown).toBe("\\</b>\\\n&\n");
    expect(r).toMatchObject({ same: true, stable: true });
  });

  it("a block-level tag at the start of a line is written as text even with text after it", async () => {
    const r = await readsBackAs(para(0, html("<div>"), text("x")));
    expect(r.markdown.startsWith("\\<div>")).toBe(true);
    expect(r).toMatchObject({ same: true, stable: true });
  });

  it("an inline tag followed by text keeps being HTML, and so does one after the start of the line", async () => {
    const r = await readsBackAs(para(0, text("a "), html("<b>"), text("x"), html("</b>")));
    expect(r.markdown).toBe("a <b>x</b>\n");
    expect(r).toMatchObject({ same: true, stable: true });
    const r2 = await readsBackAs(para(0, html("<b>"), text("x"), html("</b>")));
    expect(r2.markdown).toBe("<b>x</b>\n");
    expect(r2).toMatchObject({ same: true, stable: true });
  });
});
