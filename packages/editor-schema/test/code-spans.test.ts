import { schemaCtx } from "@milkdown/core";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import type { Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

// Every inline code text of up to 5 characters from backslash, pipe, backtick, space and a letter (3,900 of them), in a
// paragraph and in a table cell. GFM un-escapes `\|` to `|` in a cell before reading inline content, and `\\|` ends the
// cell, so a backslash directly before a pipe has no form inside a cell (GFM spec, "Tables (extension)": "It is possible
// to include a pipe in a cell's content by escaping it, including inside other inline spans"; there is no other escape).
const ALPHABET = ["\\", "|", "`", " ", "a"];

function strings(): string[] {
  const out: string[] = [];
  const grow = (prefix: string): void => {
    if (prefix !== "") out.push(prefix);
    if (prefix.length < 5) for (const char of ALPHABET) grow(prefix + char);
  };
  grow("");
  return out;
}

const code = (value: string): Json => ({ type: "text", text: value, marks: [{ type: "inlineCode" }] });
const cell = (type: string, value: string): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [{ type: "paragraph", attrs: { level: 0 }, content: [code(value)] }] });

describe("inline code made of backslash, pipe, backtick, space and a letter", () => {
  it("round-trips in a paragraph (all) and in a table cell (all but a backslash right before a pipe)", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const all = strings();
    const bad = { paragraph: 0, cellWithBackslashPipe: 0, cellOther: [] as string[] };
    for (const value of all) {
      const paragraph = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", attrs: { level: 0 }, content: [code(value)] }] });
      const table = schema.nodeFromJSON({ type: "doc", content: [{ type: "table", content: [{ type: "table_header_row", content: [cell("table_header", "h")] }, { type: "table_row", content: [cell("table_cell", value)] }] }] });
      for (const [doc, kind] of [[paragraph, "paragraph"], [table, "cell"]] as const) {
        const markdown = editor.serialize(doc);
        const read = editor.parse(markdown);
        const fine = JSON.stringify(normaliseForMarkdown(doc).toJSON()) === JSON.stringify(read.toJSON()) && editor.serialize(read) === markdown;
        if (fine) continue;
        if (kind === "paragraph") bad.paragraph++;
        else if (value.includes("\\|")) bad.cellWithBackslashPipe++;
        else bad.cellOther.push(value);
      }
    }
    expect(all.length).toBe(3905);
    expect(bad.paragraph).toBe(0);
    expect(bad.cellOther).toEqual([]);
    expect(bad.cellWithBackslashPipe).toBeGreaterThan(0);
  }, 120_000);

  it("spaces at the edge of code are kept: `  y  ` (read as ' y '), a code text of two spaces each side, one side only, and all spaces", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    expect(editor.serialize(editor.parse("`  y  `\n"))).toBe("`  y  `\n");
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    for (const value of ["  y  ", " y", "y ", "   ", " ", " ` "]) {
      const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", attrs: { level: 0 }, content: [{ type: "text", text: "a", marks: [] }, code(value), { type: "text", text: "b" }] }] });
      const markdown = editor.serialize(doc);
      // The text node that carries the inline-code mark holds exactly the value: neither the edge spaces nor the mark may be lost.
      const codeTexts: string[] = [];
      editor.parse(markdown).descendants((node) => {
        if (node.isText && node.marks.some((mark) => mark.type.name === "inlineCode")) codeTexts.push(node.text ?? "");
      });
      expect(codeTexts, JSON.stringify(value)).toEqual([value]);
    }
  });
});
