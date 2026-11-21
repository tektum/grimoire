import { schemaCtx } from "@milkdown/core";
import { normaliseForMarkdown } from "../src/index.js";
import { bullets, em, item, para, quote, roundTrip, text } from "./build.js";
import { makeEditor } from "./helpers.js";
import type { Json } from "./generate.js";
import { describe, expect, it } from "vitest";

// Not losses: the meaning is kept, the text changes once on first save and is stable afterwards.
const cases: [string, string, string][] = [
  ["setext headings become ATX", "Setext\n======\n\nS2\n---\n", "# Setext\n\n## S2\n"],
  ["--- and ___ become ***", "a\n\n---\n\n___\n", "a\n\n***\n\n***\n"],
  ["a bare URL gains angle brackets", "see https://example.com now\n", "see <https://example.com> now\n"],
  ["a reference-style image is inlined", "![i][r]\n\n[r]: x.png\n", "![i](x.png)\n"],
  ["table cells are padded", "| a | b |\n| - | - |\n| longer cell | 2 |\n", "| a           | b |\n| ----------- | - |\n| longer cell | 2 |\n"],
  ["bullets become *", "- a\n- b\n", "* a\n* b\n"],
];

describe("normalisations on first save", () => {
  for (const [name, source, expected] of cases) {
    it(name, async () => {
      const once = (await makeEditor({ markdown: source })).markdown();
      expect(once).toBe(expected);
      expect((await makeEditor({ markdown: once })).markdown()).toBe(once);
    });
  }
});

// Normalisations made by the shared writer to documents that were built in the editor (not read from Markdown): the
// document changes once, the Markdown is stable, and the property test applies the same rules (round-trip-property).

const hardbreak = (isInline = false): Json => ({ type: "hardbreak", attrs: { isInline } });
const written = async (...blocks: Json[]): Promise<string> => (await roundTrip(...blocks)).markdown;

describe("normalisations made when a document is written", () => {
  it("hard breaks at the start or end of a block are dropped", async () => {
    expect(await written(para(0, hardbreak(), text("a"), hardbreak()), para(0, text("b")))).toBe("a\n\nb\n");
  });

  it("a hard break inside a heading is written <br /> and read back as a hard break", async () => {
    expect(await written(para(2, text("a"), hardbreak(), text("b")))).toBe("## a<br />b\n");
  });

  it("two hard breaks in a row survive: the second is written as a backslash break, so the blank line stays", async () => {
    const r = await roundTrip(para(0, text("a"), hardbreak(true), hardbreak(true), text("b")));
    const kinds = (r.after as { content: { content: { type: string; attrs?: { isInline: boolean } }[] }[] }).content[0]?.content.filter((n) => n.type === "hardbreak").map((n) => n.attrs?.isInline);
    expect(kinds).toEqual([true, false]);
    expect(r.again).toBe(r.markdown);
  });

  it("a newline inside a text node is written as a line break and read back as a hard break", async () => {
    const r = await roundTrip(para(0, text("a\nb")));
    expect(r.markdown).toBe("a\nb\n");
    expect(JSON.stringify(r.after)).toContain('"type":"hardbreak"');
  });

  it("spaces and tabs at the start and end of a block, and beside a hard break, are dropped", async () => {
    expect(await written(para(0, text("  a\t"), hardbreak(), text(" b "), hardbreak(), text("c ")))).toBe("a\\\nb\\\nc\n");
  });

  it("empty paragraphs at the end of the document are not written", async () => {
    expect(await written(para(0, text("a")), para(0), para(2))).toBe("a\n");
  });

  it("a space at the edge of a marked run moves outside the mark", async () => {
    expect(await written(para(0, text("x"), text("y ", em), text("z")))).toBe("x*y* z\n");
  });

  it("an item with an empty paragraph before another block is written loose (the paragraph is `<br />`)", async () => {
    const nested = bullets(item(null, para(0, text("n"))));
    expect(await written(bullets(item(null, para(0), nested)))).toBe("* <br />\n\n  * n\n");
  });

  it("a quote after a paragraph in an item, and a list with one loose item, are written loose", async () => {
    expect(await written(bullets(item(null, para(0, text("a")), para(0, text("b")))))).toBe("* a\n\n  b\n");
    expect(await written(bullets(item(null, para(0, text("a")), quote(para(0, text("q"))))))).toBe("* a\n  > q\n");
  });
});

describe("the exported normal form", () => {
  it("is what the writer writes and what reading gives back", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const doc = schema.nodeFromJSON({ type: "doc", content: [para(2, text(" h "), hardbreak(), text("i")), para(0, text("a"), hardbreak(), hardbreak()), para(0), para(0)] });
    const normal = normaliseForMarkdown(doc);
    expect(editor.serialize(normal)).toBe(editor.serialize(doc));
    expect(normaliseForMarkdown(normal).eq(normal)).toBe(true);
    expect(JSON.stringify(editor.parse(editor.serialize(doc)).toJSON())).toBe(JSON.stringify(normal.toJSON()));
  });
});
