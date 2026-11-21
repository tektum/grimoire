import { schemaCtx } from "@milkdown/core";
import type { Node } from "@milkdown/prose/model";
import type { Json } from "./generate.js";
import { normaliseForMarkdown } from "../src/index.js";
import { makeEditor } from "./helpers.js";

/** Small builders for hand-written documents (JSON) and the round trip through Markdown. */
export const text = (value: string, ...marks: Json["marks"] extends infer M ? (M extends (infer E)[] ? E[] : never) : never): Json => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
export const para = (level: number, ...content: Json[]): Json => ({ type: "paragraph", attrs: { level }, ...(content.length ? { content } : {}) });
export const item = (checked: boolean | null, ...content: Json[]): Json => ({ type: "list_item", attrs: { label: "•", listType: "bullet", spread: false, checked }, content });
export const bullets = (...items: Json[]): Json => ({ type: "bullet_list", attrs: { spread: false }, content: items });
export const quote = (...content: Json[]): Json => ({ type: "blockquote", content });
export const em = { type: "emphasis" };
export const strong = { type: "strong" };
export const code = { type: "inlineCode" };
export const link = { type: "link", attrs: { href: "u", title: null } };

export async function roundTrip(...blocks: Json[]): Promise<{ markdown: string; before: unknown; after: unknown; again: string }> {
  const editor = await makeEditor({ markdown: "x\n" });
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  const doc: Node = schema.nodeFromJSON({ type: "doc", content: blocks });
  const markdown = editor.serialize(doc);
  const read = editor.parse(markdown);
  return { markdown, before: doc.toJSON(), after: read.toJSON(), again: editor.serialize(read) };
}
export const differs = (r: { before: unknown; after: unknown }): boolean => JSON.stringify(r.before).replaceAll('"spread":true', '"spread":false') !== JSON.stringify(r.after).replaceAll('"spread":true', '"spread":false');


const withoutFlags = (node: Node): string => JSON.stringify(node.toJSON(), (key, value: unknown) => (key === "spread" ? undefined : value));

/** The Markdown, whether reading it back gives the normal form of the document (list `spread` aside), and whether a second write is the same. */
export async function readsBackAs(...blocks: Json[]): Promise<{ markdown: string; same: boolean; stable: boolean }> {
  const editor = await makeEditor({ markdown: "x\n" });
  const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
  const doc: Node = schema.nodeFromJSON({ type: "doc", content: blocks });
  const markdown = editor.serialize(doc);
  const read = editor.parse(markdown);
  return { markdown, same: withoutFlags(normaliseForMarkdown(doc)) === withoutFlags(read), stable: editor.serialize(read) === markdown };
}
