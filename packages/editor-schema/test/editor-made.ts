/**
 * Documents shaped like what people make in the editor, at higher than realistic frequencies for the shapes that used to
 * be refused: Shift-Enter (hard breaks) in paragraphs, headings and table cells; task items turned into headings;
 * bold, links and inline code applied next to each other; ordered lists that do not start at 1, nested in quotes and
 * lists; empty items; a trailing empty paragraph. Text is plain words with the odd punctuation mark, so what fails is
 * structure, not escaping. Own generator: it is not the converter's.
 */
import { seeded, type Json, type Random } from "./generate.js";

const WORDS = ["alpha", "beta", "gamma", "delta", "note", "plan", "release", "review", "draft", "team"];
const PUNCT = ["", "", "", ",", ".", "!", "?", ":", ")", "("];

const pick = <T>(next: Random, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
const chance = (next: Random, p: number): boolean => next() < p;
const words = (next: Random, count: number): string => Array.from({ length: count }, () => `${pick(next, WORDS)}${pick(next, PUNCT)}`).join(" ");

const mark = (next: Random, type: string): { type: string; attrs?: Record<string, unknown> } => (type === "link" ? { type, attrs: { href: pick(next, ["https://example.com/a", "/page"]), title: null } } : { type });

function inline(next: Random, breaks: boolean): Json[] {
  const out: Json[] = [];
  for (let i = 0, n = 1 + Math.floor(next() * 4); i < n; i++) {
    if (breaks && i > 0 && chance(next, 0.3)) out.push({ type: "hardbreak", attrs: { isInline: chance(next, 0.5) } });
    // bold, link and code applied side by side or nested: the combinations that used to break
    const chosen = ["emphasis", "strong", "strike_through", "inlineCode", "link"].filter(() => chance(next, 0.22)).slice(0, 2);
    const node: Json = { type: "text", text: words(next, 1 + Math.floor(next() * 2)) };
    if (chosen.length) node.marks = chosen.map((type) => mark(next, type));
    out.push(node);
    if (chance(next, 0.5)) out.push({ type: "text", text: " " });
  }
  return out;
}

const paragraph = (next: Random, level = 0, breaks = chance(next, 0.3)): Json => ({ type: "paragraph", attrs: { level }, content: inline(next, breaks) });

function item(next: Random, depth: number, ordered: boolean, index: number, order: number): Json {
  const heading = chance(next, 0.3) ? pick(next, [1, 2, 3]) : 0;
  const content: Json[] = [chance(next, 0.1) ? { type: "paragraph", attrs: { level: 0 } } : paragraph(next, heading)];
  if (chance(next, 0.4) && depth < 3) content.push(list(next, depth + 1));
  else if (chance(next, 0.15)) content.push(block(next, depth + 1));
  // Task items: most of them get a checkbox, including those whose first block is a heading.
  const checked = !ordered && chance(next, 0.4) ? chance(next, 0.5) : null;
  return { type: "list_item", attrs: { label: ordered ? `${order + index}.` : "•", listType: ordered ? "ordered" : "bullet", spread: chance(next, 0.2), checked }, content };
}

function list(next: Random, depth: number): Json {
  const ordered = chance(next, 0.45);
  const order = ordered ? pick(next, [1, 1, 3, 7]) : 1;
  const items = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, index) => item(next, depth, ordered, index, order));
  return ordered ? { type: "ordered_list", attrs: { order, spread: false }, content: items } : { type: "bullet_list", attrs: { spread: false }, content: items };
}

function table(next: Random): Json {
  const columns = 1 + Math.floor(next() * 3);
  const alignment = Array.from({ length: columns }, () => pick(next, [null, null, "left", "center", "right"]));
  const cell = (type: string, column: number): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: alignment[column] ?? null }, content: [paragraph(next, 0, chance(next, 0.35))] });
  return {
    type: "table",
    content: [
      { type: "table_header_row", content: Array.from({ length: columns }, (_, c) => cell("table_header", c)) },
      ...Array.from({ length: 1 + Math.floor(next() * 2) }, (): Json => ({ type: "table_row", content: Array.from({ length: columns }, (_, c) => cell("table_cell", c)) })),
    ],
  };
}

function block(next: Random, depth: number): Json {
  const roll = next();
  if (roll < 0.3) return paragraph(next, chance(next, 0.3) ? pick(next, [1, 2, 3, 4]) : 0);
  if (roll < 0.55) return list(next, depth);
  if (roll < 0.7) return { type: "blockquote", content: Array.from({ length: 1 + Math.floor(next() * 2) }, () => (depth < 3 ? block(next, depth + 1) : paragraph(next))) };
  if (roll < 0.8) return { type: "code_block", attrs: { language: pick(next, ["", "ts"]) }, content: [{ type: "text", text: words(next, 3) }] };
  if (roll < 0.85) return { type: "hr" };
  if (roll < 0.95) return table(next);
  return paragraph(next);
}

export function editorMadeDocument(seed: number): Json {
  const next = seeded(seed * 7919 + 13);
  const blocks = Array.from({ length: 2 + Math.floor(next() * 6) }, () => block(next, 0));
  if (chance(next, 0.6)) blocks.push({ type: "paragraph", attrs: { level: 0 } });
  return { type: "doc", content: blocks };
}
