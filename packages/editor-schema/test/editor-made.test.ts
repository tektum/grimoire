import { schemaCtx } from "@milkdown/core";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import { editorMadeDocument } from "./editor-made.js";
import type { Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

const COUNT = 2000;
const any = (node: Json, test: (n: Json) => boolean): boolean => test(node) || (node.content ?? []).some((child) => any(child, test));

/** Tokens with spaces carrying no marks: which marks cover a space at a run edge is invisible and not compared. */
function spaceInsensitive(value: unknown): string {
  return JSON.stringify(value, (key, inner: unknown) => (key === "spread" ? undefined : inner)).replace(/"marks":\[[^\]]*\](?=,"text":"\s+")/g, "");
}

describe("documents shaped like editor work (hard breaks in cells and headings, task headings, adjacent marks, late ordered lists)", () => {
  it(`${COUNT} documents: how many are a full fixed point, and why the others are not`, async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const classes = new Map<string, number>();
    const taskHeading = (n: Json): boolean => n.type === "list_item" && n.attrs?.["checked"] !== null && (n.content?.[0]?.attrs?.["level"] ?? 0) !== 0;
    /** The document with every task checkbox in front of a heading taken off: what is left must round-trip on its own. */
    const withoutTaskHeadings = (node: Json): Json => ({
      ...node,
      ...(taskHeading(node) ? { attrs: { ...node.attrs, checked: null } } : {}),
      ...(node.content ? { content: node.content.map(withoutTaskHeadings) } : {}),
    });
    /** "fixed": a full fixed point; "drift": the same document, a different second save; "lost": anything else. */
    const outcome = (json: Json): "fixed" | "drift" | "lost" => {
      const doc = schema.nodeFromJSON(json);
      const normal = normaliseForMarkdown(doc);
      const markdown = editor.serialize(doc);
      expect(editor.serialize(normal)).toBe(markdown);
      const read = editor.parse(markdown);
      const same = spaceInsensitive(normal.toJSON()) === spaceInsensitive(read.toJSON());
      if (!same) return "lost";
      return editor.serialize(read) === markdown ? "fixed" : "drift";
    };
    let fixed = 0;
    for (let seed = 1; seed <= COUNT; seed++) {
      const json = editorMadeDocument(seed);
      const first = outcome(json);
      if (first === "fixed") {
        fixed++;
        continue;
      }
      // A document with the known loss is explained by it only if it round-trips once the loss is taken out of it.
      const rest = any(json, taskHeading) ? outcome(withoutTaskHeadings(json)) : first;
      const label = rest === "fixed" ? "task checkbox in front of a heading" : rest === "drift" ? "second-save drift (Markdown text only)" : "other";
      classes.set(label, (classes.get(label) ?? 0) + 1);
    }
    process.stdout.write(`\neditor-made: ${fixed} of ${COUNT} full fixed points; ${JSON.stringify([...classes])}\n`);
    expect(classes.get("other") ?? 0).toBe(0);
    expect(classes.get("second-save drift (Markdown text only)") ?? 0).toBeLessThan(COUNT * 0.03); // measured: 37 of 2000. A known limit that is rare; a rise is a regression
    expect(fixed).toBeGreaterThan(COUNT * 0.6); // the rest are task checkboxes before headings, which the editor now refuses to make
  }, 300_000);
});
