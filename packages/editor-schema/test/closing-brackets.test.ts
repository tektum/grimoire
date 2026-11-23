import { schemaCtx } from "@milkdown/core";
import type { Node } from "@milkdown/prose/model";
import { describe, expect, it } from "vitest";
import { CLOSING_BRACKET_LIMIT, escapeClosingBracketsCtx, hasTooManyClosingBrackets } from "../src/index.js";
import { bullets, code, em, item, link, para, quote, text } from "./build.js";
import type { Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

const closers = (n: number): string => "]".repeat(n);

async function docOf(...blocks: Json[]): Promise<{ doc: Node; serialize: (flag: boolean) => string }> {
  const editor = await makeEditor({ markdown: "x\n" });
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
  return {
    doc,
    serialize: (flag) => {
      editor.editor.action((ctx) => { ctx.set(escapeClosingBracketsCtx, flag); });
      return editor.serialize(doc);
    },
  };
}

describe("hasTooManyClosingBrackets: the count is the whole document's, outside code", () => {
  it("is false at the limit and true one past it", async () => {
    expect(hasTooManyClosingBrackets((await docOf(para(0, text(closers(CLOSING_BRACKET_LIMIT))))).doc)).toBe(false);
    expect(hasTooManyClosingBrackets((await docOf(para(0, text(closers(CLOSING_BRACKET_LIMIT + 1))))).doc)).toBe(true);
  });

  it("adds up text nodes, marks, blocks, lists and quotes, so splitting the brackets does not hide them", async () => {
    const half = Math.ceil((CLOSING_BRACKET_LIMIT + 1) / 4);
    const { doc } = await docOf(
      para(0, text(closers(half)), text("x", em), text(closers(half), link)),
      quote(para(0, text(closers(half)))),
      bullets(item(null, para(0, text(closers(half))))),
    );
    expect(hasTooManyClosingBrackets(doc)).toBe(true);
    expect(hasTooManyClosingBrackets((await docOf(para(0, text(closers(half))), quote(para(0, text(closers(half)))))).doc)).toBe(false);
  });

  it("does not count code: inline code and code blocks may hold any number", async () => {
    const { doc } = await docOf(
      para(0, text(closers(CLOSING_BRACKET_LIMIT + 1), code), text(closers(10))),
      { type: "code_block", attrs: { language: "" }, content: [{ type: "text", text: closers(CLOSING_BRACKET_LIMIT + 1) }] },
    );
    expect(hasTooManyClosingBrackets(doc)).toBe(false);
  });
});

describe("the text writer with the escape flag", () => {
  it("writes `]` as it always did while the flag is off", async () => {
    expect((await docOf(para(0, text("a] [b] c")))).serialize(false)).toBe("a] \\[b] c\n");
  });

  it("writes every `]` as `\\]` while the flag is on, once, and leaves code, links and trailing blanks alone", async () => {
    const { serialize } = await docOf(para(0, text("a] [b] c "), text("]]", code), text("x]y", link)));
    expect(serialize(true)).toBe("a\\] \\[b\\] c `]]`[x\\]y](u)\n");
  });

  it("does not escape a `]` that a backslash already escapes, and escapes one after an escaped backslash", async () => {
    const { serialize } = await docOf(para(0, text("p\\]q"), text(" r\\\\]s")));
    expect(serialize(false)).toBe("p\\\\]q r\\\\\\\\]s\n");
    expect(serialize(true)).toBe("p\\\\\\]q r\\\\\\\\\\]s\n");
  });
});
