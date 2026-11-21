/**
 * Seeded generator of ProseMirror documents (as JSON) for the round-trip property test. It builds documents directly in
 * the schema, so it reaches states Markdown parsing would never produce (an empty list item, a nested list first in an
 * item, an empty first paragraph before a code block).
 *
 * What it does not cover: footnotes, raw HTML blocks, `\n` inside a text node, link reference definitions, tables with
 * column spans, and documents deeper than four levels or larger than a few dozen blocks.
 */
export type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string };

export type Random = () => number;

/** Linear congruential generator. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const pick = <T>(next: Random, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
const chance = (next: Random, p: number): boolean => next() < p;

/** Text made of Markdown-significant characters, plus ordinary words. */
const FRAGMENTS = [
  "word", "two words", "*", "**", "_", "__", "`", "``", "[", "]", "[a](b)", "<", ">", "<b>", "&", "&amp;", "#", "# ", "## x",
  "1. ", "1.", "2) ", "- ", "+ ", "* ", "> ", "---", "***", "===", "|", "\\", "\\\\", "\\*", "~", "~~", "$", "!", "![i](u)",
  "  ", " ", "\t", "trailing ", " leading", "a_b_c", "snake_case_name", "2*3*4", "[^1]", ":",
];
const CODE_LINES = ["```", "~~~", "````", "x = 1", "  indented", "", "# not heading", "* not list", "\t", "trailing ", "<br />", "---"];

/** Fragments that reach known limits of Markdown itself (see the proof note); only the `wild` documents use them. */
const WILD_FRAGMENTS = ["\u00a0", "a\nb"];
/** Text that GFM reads as a link: only the `addresses` documents use it, because it would drown every other class. */
const ADDRESS_FRAGMENTS = ["http://x.y", "www.x.y", "me@x.com", "<https://a.b>"];

/** `wild` documents add the fragments, mark combinations and shapes that hit the known limits; set by `document`. */
let wild = false;
let addresses = false;
let htmlHeavy = false;

/** Raw inline HTML of every kind that matters: the seven HTML block start conditions of CommonMark 0.31 section 4.6
 * (closed and not), whole elements, padded and doubled breaks, inline tags and comments. */
const HTML_VALUES = [
  "<pre>", "<pre>x</pre>", "<script>", "<style>x", "<textarea>", "<!--", "<!-- c -->", "<?php", "<?php x ?>", "<![CDATA[", "<![CDATA[x]]>", "<!DOCTYPE", "<!DOCTYPE html>",
  "<div>", "<aside>n</aside>", "<aside>", "</aside>", "<table>", "<span class=\"x\">", "<b>", "</b>", "<b>x</b>", "<custom-tag>", "<i>a</i><b>b</b>", "<img src=\"u\">",
  "<br>", "<br/>", "<br />", " <br> ", "<br><br>", "<BR>", "<br> <br>",
];

function text(next: Random): string {
  let out = "";
  const pool = [...FRAGMENTS, ...(wild ? WILD_FRAGMENTS : []), ...(addresses ? ADDRESS_FRAGMENTS : [])];
  for (let i = 0, n = 1 + Math.floor(next() * 3); i < n; i++) out += pick(next, pool);
  return out;
}

const MARKS = ["emphasis", "strong", "inlineCode", "strike_through", "link"] as const;

function marks(next: Random): Json["marks"] {
  if (chance(next, 0.55)) return undefined;
  const chosen = MARKS.filter(() => chance(next, 0.3));
  if (chosen.length === 0) return undefined;
  return chosen.map((type) => (type === "link" ? { type, attrs: { href: pick(next, ["u", "http://x.y/z", "a b", "(p)"]), title: pick(next, [null, "t"]) } } : { type }));
}

function inline(next: Random): Json[] {
  const items: Json[] = [];
  const count = pick(next, [0, 0, 1, 1, 1, 2, 3, 4]);
  for (let i = 0; i < count; i++) {
    const roll = next();
    if (roll < 0.1) items.push({ type: "hardbreak", attrs: { isInline: chance(next, 0.5) } });
    else if (roll < 0.13 || (htmlHeavy && roll < 0.4)) items.push({ type: "html", attrs: { value: pick(next, htmlHeavy ? HTML_VALUES : ["<b>", "</b>", "<div>", "<!-- c -->", "<br>", "<br />", "<BR/>", "<span class=\"x\">", "<pre>"]) } });
    else if (roll < 0.15) items.push({ type: "image", attrs: { src: pick(next, ["i.png", "http://x/y.png"]), alt: pick(next, ["", "alt", "a*b"]), title: pick(next, ["", "t"]), href: pick(next, ["", "", "http://l"]), linkTitle: "" } });
    else {
      const node: Json = { type: "text", text: text(next) };
      const m = marks(next);
      // Markdown cannot put a mark around the spaces at the edge of its text (see the normalisation table), so a
      // marked run starts and ends with a visible character.
      if (m) {
        // inlineCode next to other marks or text hits a CommonMark flanking limit (known limit in the proof note).
        node.marks = m;
        if (!wild) node.text = `x${node.text?.trim()}x`;
      }
      items.push(node);
    }
  }
  return items;
}

function paragraph(next: Random, inTable = false): Json {
  const content = inline(next);
  const node: Json = { type: "paragraph", attrs: { level: inTable ? 0 : pick(next, [0, 0, 0, 0, 1, 2, 3, 6]) } };
  if (content.length) node.content = content;
  return node;
}

function listItem(next: Random, depth: number, label: string, listType: string): Json {
  const content: Json[] = [paragraph(next)];
  // The first block after the paragraph is the interesting case: nested block first means an empty first paragraph.
  if (chance(next, 0.6)) for (let i = 0, n = 1 + Math.floor(next() * 2); i < n; i++) content.push(block(next, depth + 1));
  // A heading cannot carry a task checkbox (known limit in the proof note), so only plain first paragraphs are checked.
  const first = content[0];
  const checked = listType === "bullet" && first && (wild || first.attrs?.["level"] === 0) ? pick(next, [null, null, null, true, false]) : null;
  return { type: "list_item", attrs: { label, listType, spread: chance(next, 0.3), checked }, content };
}

function list(next: Random, depth: number): Json {
  const ordered = chance(next, 0.4);
  const order = ordered ? pick(next, [1, 1, 1, 3, 10]) : 1;
  const items = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, i) => listItem(next, depth, ordered ? `${order + i}.` : "•", ordered ? "ordered" : "bullet"));
  // Labels are derived and can be out of step (two editors renumbering at once): stale, duplicated, missing, not a number.
  if (chance(next, 0.25)) items.forEach((it) => { if (it.attrs) it.attrs = { ...it.attrs, label: pick(next, ["5.", "5.", "x", "", "•", "1.", "0."]), ...(chance(next, 0.3) ? { listType: ordered ? "bullet" : "ordered" } : {}) }; });
  // A list whose start differs from its first label.
  const start = ordered && chance(next, 0.2) ? order + 4 : order;
  return ordered ? { type: "ordered_list", attrs: { order: start, spread: false }, content: items } : { type: "bullet_list", attrs: { spread: false }, content: items };
}

function table(next: Random): Json {
  const columns = 1 + Math.floor(next() * 3);
  const alignments = Array.from({ length: columns }, () => pick(next, [null, null, "left", "center", "right"]));
  const cell = (type: string, column: number): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: alignments[column] ?? null }, content: [paragraph(next, true)] });
  const header: Json = { type: "table_header_row", content: Array.from({ length: columns }, (_, c) => cell("table_header", c)) };
  const rows = Array.from({ length: 1 + Math.floor(next() * 2) }, (): Json => ({ type: "table_row", content: Array.from({ length: columns }, (_, c) => cell("table_cell", c)) }));
  return { type: "table", content: [header, ...rows] };
}

function code(next: Random): Json {
  const lines = Array.from({ length: Math.floor(next() * 4) }, () => pick(next, CODE_LINES));
  const node: Json = { type: "code_block", attrs: { language: pick(next, ["", "", "ts", "sh"]) } };
  if (lines.join("\n").length) node.content = [{ type: "text", text: lines.join("\n") }];
  return node;
}

export function block(next: Random, depth = 0): Json {
  const roll = next();
  if (depth >= 4 || roll < 0.3) return paragraph(next);
  if (roll < 0.55) return list(next, depth);
  if (roll < 0.65) return { type: "blockquote", content: Array.from({ length: 1 + Math.floor(next() * 2) }, () => block(next, depth + 1)) };
  if (roll < 0.75) return code(next);
  if (roll < 0.82) return { type: "hr" };
  if (roll < 0.9 && (wild || depth === 0)) return table(next);
  return paragraph(next);
}

export function document(seed: number, mode: "tame" | "wild" | "addresses" | "html" = "tame"): Json {
  wild = mode !== "tame";
  addresses = mode === "addresses";
  htmlHeavy = mode === "html";
  const next = seeded(seed);
  return { type: "doc", content: Array.from({ length: 1 + Math.floor(next() * 4) }, () => block(next)) };
}
