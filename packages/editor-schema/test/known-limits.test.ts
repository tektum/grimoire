import { describe, expect, it } from "vitest";
import type { Json } from "./generate.js";
import { bullets, em, link, readsBackAs, strong, differs, item, para, quote, roundTrip, text } from "./build.js";

// One minimal canary per known limit of docs/proof/m2-schema-fixes.md. Each asserts the loss: when a library upgrade
// or a schema change fixes it, the canary fails, and the note and the property test's classes must be updated.
describe("known limits (losses): each is pinned so a fix is noticed", () => {
  const loose = (spread: boolean, ...content: Json[]): Json => ({ ...item(null, ...content), attrs: { label: "•", listType: "bullet", spread, checked: null } });
  const a = para(0, text("a"));
  const b = para(0, text("b"));
  const c = para(0, text("c"));

  it("second-save drift 1: a quote holding a list whose first item ends with a nested list and whose second item is loose", async () => {
    const r = await roundTrip(quote(bullets(loose(false, a, bullets(loose(false, b))), loose(true, c))));
    expect(r.markdown).toBe("> * a\n>   * b\n>\n> * c\n");
    expect(differs(r)).toBe(false);
    expect(r.again).toBe("> * a\n>   * b\n> * c\n");
  });

  it("second-save drift 2: the same inside a list item", async () => {
    const r = await roundTrip(bullets(loose(false, a, quote(bullets(loose(false, b, bullets(loose(false, c))), loose(true, c))))));
    expect(differs(r)).toBe(false);
    expect(r.again).not.toBe(r.markdown);
  });

  it("email-like text is read back as a mailto link; a character reference does not help (the reader finds it in decoded text)", async () => {
    const r = await roundTrip(para(0, text("me@x.com")));
    expect(differs(r)).toBe(true);
    expect(JSON.stringify(r.after)).toContain("mailto:me@x.com");
  });

  it("text that looks like a web address becomes a link when read back", async () => {
    const r = await roundTrip(para(0, text("http://x.y")));
    expect(differs(r)).toBe(true);
    expect(JSON.stringify(r.after)).toContain('"type":"link"');
  });

  it("a task checkbox in front of a heading is lost", async () => {
    const r = await roundTrip(bullets(item(true, para(2, text("h")))));
    expect(r.markdown).toBe("* ## h\n");
    expect(differs(r)).toBe(true);
  });

  it("an empty heading at the end of the document is not written (the level is kept in Yjs, not in Markdown)", async () => {
    const r = await roundTrip(para(0, text("a")), para(2));
    expect(r.markdown).toBe("a\n");
  });

  it("hand-built only: a table with no columns cannot be written (the writer throws)", async () => {
    const empty: Json = { type: "table", content: [{ type: "table_header_row" }, { type: "table_row" }] };
    await expect(roundTrip(bullets(item(null, para(0, text("a")), empty)))).rejects.toThrow();
    await expect(roundTrip(empty)).rejects.toThrow();
  });

  it("two runs with partly overlapping marks and a space between them (emphasis+strong, then strong+link): the read-back differs", async () => {
    const r = await readsBackAs(para(0, text("Z", em, strong), text(" t", strong, link)));
    expect(r.same).toBe(false);
  });

  it("inline code with a backslash right before a pipe, in a table cell, loses the backslash (GFM cannot say it)", async () => {
    const codeCell = (type: string, value: string): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [para(0, { type: "text", text: value, marks: [{ type: "inlineCode" }] })] });
    const table = (value: string): Json => ({ type: "table", content: [{ type: "table_header_row", content: [codeCell("table_header", "h")] }, { type: "table_row", content: [codeCell("table_cell", value)] }] });
    const r = await roundTrip(table("a\\|b"));
    expect(JSON.stringify(r.after)).toContain('"text":"a|b"'); // the backslash is gone
    expect(differs(r)).toBe(true);
    // The same text is fine outside a table, and a pipe without a backslash is fine inside one.
    expect(differs(await roundTrip(para(0, { type: "text", text: "a\\|b", marks: [{ type: "inlineCode" }] })))).toBe(false);
    expect(differs(await roundTrip(table("a|b")))).toBe(false);
  });
});
