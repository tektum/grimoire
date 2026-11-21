import { describe, expect, it } from "vitest";
import { seeded } from "./generate.js";
import { makeEditor } from "./helpers.js";

// HTML blocks as the reader makes them (CommonMark 0.31, section 4.6): each of the seven start conditions, one line and
// several, followed by other blocks. Markdown -> document -> Markdown must be byte-identical and the document must re-read the same.
const WORDS = ["alpha", "beta", "gamma", "delta", "note"];

function block(kind: number, next: () => number): string {
  const pick = (items: readonly string[]): string => items[Math.floor(next() * items.length)] as string;
  const lines = (count: number, blank: boolean): string => Array.from({ length: count }, (_, i) => (blank && i === 1 ? "" : pick(WORDS))).join("\n");
  const count = 1 + Math.floor(next() * 3);
  switch (kind) {
    case 1: return `<${pick(["pre", "script", "style", "textarea"])}>\n${lines(count + 1, true)}\n</${["pre", "script", "style", "textarea"].find((tag) => tag) ?? "pre"}>`.replace(/<(pre|script|style|textarea)>([\s\S]*)<\/pre>/, (_m, tag: string, body: string) => `<${tag}>${body}</${tag}>`);
    case 2: return `<!--\n${lines(count + 1, true)}\n-->`;
    case 3: return `<?php\n${lines(count + 1, true)}\n?>`;
    case 4: return `<!DOCTYPE html>`;
    case 5: return `<![CDATA[\n${lines(count + 1, true)}\n]]>`;
    case 6: return `<${pick(["div", "section", "table", "details"])}>\n${lines(count, false)}\n</div>`.replace(/<(div|section|table|details)>([\s\S]*)<\/div>/, (_m, tag: string, body: string) => `<${tag}>${body}</${tag}>`);
    default: return `<a href="u">\n<img src="p"/>\n${lines(count, false)}\n</a>`;
  }
}

describe("raw HTML blocks read from Markdown are written back verbatim", () => {
  it("500 generated blocks of all seven kinds, one line and several, followed by a paragraph and a list: byte-identical, and the document re-reads identical", async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const failures: string[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const next = seeded(seed * 2654435761);
      const kind = 1 + (seed % 7);
      const markdown = `${block(kind, next)}\n\nafter ${seed}\n\n* item\n`;
      const doc = editor.parse(markdown);
      const written = editor.serialize(doc);
      const again = editor.parse(written);
      if (written !== markdown || JSON.stringify(again.toJSON()) !== JSON.stringify(doc.toJSON())) failures.push(`${kind}: ${JSON.stringify(markdown).slice(0, 120)} -> ${JSON.stringify(written).slice(0, 120)}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});
