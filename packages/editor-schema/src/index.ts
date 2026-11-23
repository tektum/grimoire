/**
 * The one editor plugin array, used by the browser editor (the web client, planned) and by the server converter (R7.7).
 *
 * A heading is a paragraph with a `level` attribute (0 = plain paragraph), so turning a block into a heading is an
 * attribute change on the same Yjs element and never a delete-and-recreate that would lose concurrent typing [R3.7].
 * The `heading` node stays in the schema (other preset pieces reference it) but is never produced.
 *
 * This package must not import yjs, y-prosemirror, piscina or any server library: it is shared with the browser.
 */
import { bulletListSchema, commonmark, docSchema, emphasisSchema, headingSchema, htmlSchema, strongSchema, imageSchema, linkSchema, orderedListSchema, paragraphSchema } from "@milkdown/preset-commonmark";
import {
  downgradeHeadingCommand,
  headingKeymap,
  syncHeadingIdPlugin,
  wrapInHeadingCommand,
  wrapInHeadingInputRule,
} from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask, gfm, tableCellSchema, tableHeaderSchema } from "@milkdown/preset-gfm";
import { commandsCtx, remarkStringifyOptionsCtx } from "@milkdown/core";
import { InputRule } from "@milkdown/prose/inputrules";
import { createSlice } from "@milkdown/ctx";
import type { Ctx, MilkdownPlugin } from "@milkdown/ctx";
import type { Command, EditorState, Transaction } from "@milkdown/prose/state";
import type { NodeType, ResolvedPos } from "@milkdown/prose/model";
import { Fragment, Mark, type Node } from "@milkdown/prose/model";
import { $command, $inputRule, $node, $remark, $useKeymap } from "@milkdown/utils";
import type { $MarkSchema, GetNodeSchema } from "@milkdown/utils";

/** Name of the Yjs fragment that holds the document. Milkdown's collab plugin uses this name. */
export const FRAGMENT_NAME = "prosemirror";

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

type Item = { node: Node; text: string | null; brk: boolean };

/**
 * Whitespace scans, linear in the length of the text. Regular expressions such as `/[ \t]+$/` are quadratic in V8 on a long
 * run of blanks followed by more text (the engine retries the run from every position): "a" + 100,000 spaces + "x" kept the
 * conversion worker busy for the whole 10 second timeout (review finding F1). Every trim in this package goes through these.
 */
const isBlank = (code: number): boolean => code === 0x20 || code === 0x09;
const JS_SPACES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const isJsSpace = (code: number): boolean => JS_SPACES.has(code) || (code >= 0x2000 && code <= 0x200a);
function runLength(value: string, from: number, step: 1 | -1, test: (code: number) => boolean): number {
  let at = step === 1 ? from : value.length - 1;
  let count = 0;
  while (at >= 0 && at < value.length && test(value.charCodeAt(at))) {
    count += 1;
    at += step;
  }
  return count;
}
/** The leading run of spaces and tabs (`/^[ \t]+/`). */
const leadingBlanks = (value: string): number => runLength(value, 0, 1, isBlank);
/** The trailing run of spaces and tabs (`/[ \t]+$/`). */
const trailingBlanks = (value: string): number => runLength(value, 0, -1, isBlank);
/** The leading and trailing runs of JavaScript whitespace (`/^\s+/`, `/\s+$/`). */
const leadingSpaces = (value: string): number => runLength(value, 0, 1, isJsSpace);
const trailingSpaces = (value: string): number => runLength(value, 0, -1, isJsSpace);
const isCode = (node: Node): boolean => node.marks.some((mark) => mark.type.name === "inlineCode");

/** The `marker` of emphasis and strong is not kept (`_` and `*` read the same, and the writer picks the valid one). */
const starMarks = (marks: readonly Mark[]): readonly Mark[] =>
  marks.map((mark) => ((mark.type.name === "emphasis" || mark.type.name === "strong") && mark.attrs["marker"] !== "*" ? mark.type.create({ ...mark.attrs, marker: "*" }) : mark));

/**
 * The normal form of one text block: what Markdown can keep. The Markdown writer writes exactly this, and
 * `normaliseForMarkdown` returns exactly this, from the one implementation, so they cannot drift:
 * - a newline inside a text node becomes a hard break (that is how Markdown reads it back);
 * - hard breaks at the start or end are dropped (a backslash at the end of a block is a literal backslash);
 * - of several hard breaks in a row the second and later are written `\` + newline (never a bare newline, which would
 *   end the paragraph), so they come back as hard breaks of the other kind (`isInline: false`);
 * - spaces and tabs at the start or end of the block, and beside a hard break, are dropped (CommonMark strips them);
 * - a space at the edge of a marked run leaves the marks that start or end there (Milkdown writes it outside).
 */
function normalisedBlock(node: Node, inCell = false, taskFirst = false): Node {
  // One pass can expose more to do (spaces moved out of a mark merge with a neighbour): repeat until it settles.
  let current = node;
  for (let pass = 0; pass < 5; pass++) {
    const next = normalisedOnce(current, inCell, taskFirst);
    if (next === current || next.eq(current)) return next;
    current = next;
  }
  return current;
}
function normalisedOnce(node: Node, inCell: boolean, taskFirst: boolean): Node {
  const schema = node.type.schema;
  const breakType = schema.nodes["hardbreak"];
  if (!breakType) return node;
  const singleLine = inCell || (typeof node.attrs["level"] === "number" && node.attrs["level"] > 0);
  let items: Item[] = [];
  const addText = (value: string, source: Node): void => {
    items.push({ node: schema.text(value, source.marks), text: value, brk: false });
  };
  const source: Node[] = [];
  // An address that is not allowed (`isSafeUrl`) is dropped here, so the saved Markdown never holds it: a link keeps its text and
  // loses the link, an image becomes its alt text (nothing if it has none), an image link keeps the image.
  node.forEach((child) => {
    if (child.isText) {
      const safe = child.marks.filter((mark) => mark.type.name !== "link" || isSafeUrl(mark.attrs["href"]));
      source.push(child.mark(starMarks(safe)));
    } else if (child.type.name === "image") {
      // Every image, whatever its source: a link mark with a refused address is dropped from it.
      const keep = child.marks.filter((mark) => mark.type.name !== "link" || isSafeUrl(mark.attrs["href"]));
      if (!isSafeUrl(child.attrs["src"], "image")) {
        const alt = String(child.attrs["alt"] ?? "");
        if (alt !== "") source.push(schema.text(alt, keep));
      } else if (child.attrs["href"] !== "" && !isSafeUrl(child.attrs["href"])) source.push(child.type.create({ ...child.attrs, href: "", linkTitle: "" }, null, keep));
      else source.push(keep.length === child.marks.length ? child : child.type.create(child.attrs, null, keep));
    } else source.push(child);
  });
  // A stored raw `<br>` node (also padded, or several in a row) is hard breaks: that is what the reader makes of it
  // (some Markdown exports write `<br>`).
  const breaksIn = (child: Node): number => (child.type.name === "html" && BREAKS_ONLY.test(String(child.attrs["value"] ?? "")) ? (String(child.attrs["value"]).match(/<br/gi) ?? []).length : 0);
  source.forEach((child) => {
    if (child.type === breakType) items.push({ node: child, text: null, brk: true });
    else if (breaksIn(child) > 0) for (let count = breaksIn(child); count > 0; count--) items.push({ node: breakType.create({ isInline: false }), text: null, brk: true });
    // A line ending in text, whether LF, CR or CRLF, is one hard break: the Markdown reader reads all three as one line ending.
    else if (child.isText && /[\r\n]/.test(child.text ?? "")) {
      (child.text ?? "").split(/\r\n|\r|\n/).forEach((part, index) => {
        if (index > 0) items.push({ node: breakType.create({ isInline: true }), text: null, brk: true });
        if (part !== "") addText(part, child);
      });
    } else items.push({ node: child, text: child.isText ? (child.text ?? "") : null, brk: false });
  });
  const strip = (index: number, side: "start" | "end"): void => {
    const item = items[index];
    // Code text is never trimmed: its spaces are characters (the writer pads the code span so they survive).
    if (item?.text == null || isCode(item.node)) return;
    const cut = side === "start" ? leadingBlanks(item.text) : trailingBlanks(item.text);
    if (cut > 0) item.text = side === "start" ? item.text.slice(cut) : item.text.slice(0, item.text.length - cut);
  };
  const measure = (): string => items.map((item) => (item.text ?? (item.brk ? "\u0001" : "\u0002"))).join("\u0000");
  // Repeat until nothing changes: removing a break or a space can expose the next one.
  for (let before = ""; before !== measure(); ) {
    before = measure();
    strip(0, "start");
    strip(items.length - 1, "end");
    items.forEach((item, index) => {
      if (!item.brk) return;
      strip(index - 1, "end");
      strip(index + 1, "start");
    });
    items = items.filter((item) => item.text !== "");
    while (items[0]?.brk) items.shift();
    while (items.at(-1)?.brk) items.pop();
  }
  // Raw HTML that would start an HTML block at the start of a line (in a paragraph, a list item or a quote) cannot be
  // written as HTML: it would swallow the lines after it. It is written, and read back, as the same literal text.
  // (A paragraph that is only one html node is a raw HTML block read from Markdown: it is written as one and stays one.)
  // A block that opens at a start condition of CommonMark 0.31 section 4.6 ("HTML blocks") and ends only at a
  // terminator the node does not hold would swallow what follows (1: `<pre` `<script` `<style` `<textarea` until its
  // closing tag; 2: `<!--` until `-->`; 3: `<?` until `?>`; 4: `<!` and a letter until `>`; 5: `<![CDATA[` until `]]>`;
  // conditions 6 and 7 end at a blank line, and the item is written loose). Alone in its paragraph that one is text too.
  if (!singleLine && items.length === 1) {
    const only = items[0];
    const value = only?.node.type.name === "html" ? String(only.node.attrs["value"] ?? "") : "";
    if (only && opensUnterminatedHtmlBlock(value)) items = [{ node: schema.text(value, only.node.marks), text: value, brk: false }];
  }
  if (!singleLine && items.length > 1) {
    items = items.map((item, index) => {
      const lineStart = index === 0 || items[index - 1]?.brk === true;
      const value = item.node.type.name === "html" ? String(item.node.attrs["value"] ?? "") : "";
      if (!lineStart || value === "" || !(startsHtmlBlock(value) || (items[index + 1] === undefined || items[index + 1]?.brk === true))) return item;
      return { node: schema.text(value, item.node.marks), text: value, brk: false };
    });
  }
  // Read inline, a whole element in one html node (`<aside>n</aside>`) comes back as its tags and the text between them.
  // Only a paragraph that is one node opening an HTML block (CommonMark 4.6 conditions 1 to 7), outside a heading, a cell and a task item, stays one.
  const soleValue = items.length === 1 && items[0]?.node.type.name === "html" ? String(items[0].node.attrs["value"] ?? "") : "";
  // An html node the reader makes from an HTML block is one paragraph holding the whole block (several lines): it is
  // a block when its first line opens one (conditions 1 to 6, or 7: a complete tag alone on the line).
  const blockHtml = !singleLine && !taskFirst && soleValue !== "" && opensHtmlBlock(soleValue);
  if (!blockHtml) {
    items = items.flatMap((item) => {
      const value = item.node.type.name === "html" ? String(item.node.attrs["value"] ?? "") : "";
      const parts = value.split(/(<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>)/);
      if (value === "" || parts.length < 3 || !parts.every((part, index) => (index % 2 === 1 ? true : /^[^<>&]*$/.test(part))) || (parts.length === 3 && parts[0] === "" && parts[2] === "")) return [item];
      return parts.flatMap((part, index): Item[] =>
        part === "" ? [] : index % 2 === 1 ? [{ node: item.node.type.create({ value: part }, null, item.node.marks), text: null, brk: false }] : [{ node: schema.text(part, item.node.marks), text: part, brk: false }],
      );
    });
  }
  // Raw HTML that is not complete (`<?php` with no `?>`, a lone `<!--`, a half tag) is not HTML to the reader (CommonMark 0.31
  // section 6.6, "Raw HTML"; alone in a paragraph it must at least open an HTML block, section 4.6): it comes back as text.
  items = items.map((item) => {
    const value = item.node.type.name === "html" ? String(item.node.attrs["value"] ?? "") : "";
    if (value === "" || INLINE_HTML.test(value) || blockHtml) return item;
    return { node: schema.text(value, item.node.marks), text: value, brk: false };
  });
  // A bare newline would end the paragraph after a break, and a heading or a table cell is one line: those breaks are
  // written as `<br />` (read back as a hard break of the `isInline: false` kind).
  items = items.map((item, index) => (item.brk && (singleLine || items[index - 1]?.brk) && item.node.attrs["isInline"] !== false ? { ...item, node: breakType.create({ isInline: false }) } : item));
  // A hard break carries the marks that continue across it (the reader gives it the enclosing marks; the editor makes
  // it with none), so a link, emphasis, strong or strike-through that spans a break is one run and is written once.
  items = items.map((item, index) => {
    if (!item.brk) return item;
    let before = index - 1;
    while (before >= 0 && items[before]?.brk) before -= 1;
    let after = index + 1;
    while (after < items.length && items[after]?.brk) after += 1;
    const left = items[before]?.node;
    const right = items[after]?.node;
    const shared = left && right ? left.marks.filter((mark) => mark.type.name !== "inlineCode" && right.marks.some((other) => other.eq(mark))) : [];
    return Mark.sameSet(item.node.marks, shared) ? item : { ...item, node: item.node.mark(Mark.setFrom(shared)) };
  });
  // Adjacent text runs with the same marks are one run (the edge rule below looks at whole runs).
  items = items.reduce<Item[]>((merged, item) => {
    const last = merged.at(-1);
    if (last?.text != null && item.text != null && Mark.sameSet(last.node.marks, item.node.marks)) merged[merged.length - 1] = { node: schema.text(last.text + item.text, last.node.marks), text: last.text + item.text, brk: false };
    else merged.push(item);
    return merged;
  }, []);
  // Spaces at the edge of a marked run: the spaces keep only the marks that continue across the boundary.
  const out: Node[] = [];
  items.forEach((item, index) => {
    const current = item.node;
    const value = item.text;
    if (value == null || current.marks.length === 0 || isCode(current)) {
      out.push(item.text != null && item.text !== current.text ? schema.text(item.text, current.marks) : current);
      return;
    }
    // Milkdown moves the whitespace out only when the run starts or ends with a plain space (`trimStart`/`trimEnd`).
    const lead = value.startsWith(" ") ? value.slice(0, leadingSpaces(value)) : "";
    const trail = value.length > lead.length && value.endsWith(" ") ? value.slice(value.length - trailingSpaces(value)) : "";
    const core = value.slice(lead.length, value.length - trail.length);
    const keep = (other: Item | undefined): Mark[] => (other ? current.marks.filter((mark) => other.node.marks.some((m) => m.eq(mark))) : []);
    if (lead) out.push(schema.text(lead, keep(items[index - 1])));
    if (core) out.push(schema.text(core, current.marks));
    if (trail) out.push(schema.text(trail, keep(items[index + 1])));
  });
  const content = Fragment.fromArray(out);
  return content.eq(node.content) ? node : node.type.create(node.attrs, content, node.marks);
}
/** Complete inline raw HTML (CommonMark 0.31 section 6.6): open tag, closing tag, comment, processing instruction, declaration, CDATA. */
const INLINE_HTML = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!---->|<!--(?!-?>)[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)$/;
const BREAKS_ONLY = /^\s*(?:<br\s*\/?>\s*)+$/i;
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
/** CommonMark HTML block start conditions 1 to 6: at the start of a line these begin a block even when text follows. */
const opensUnterminatedHtmlBlock = (value: string): boolean =>
  (/^<(?:pre|script|style|textarea)(?:[\s>]|$)/i.test(value) && !/<\/(?:pre|script|style|textarea)\s*>/i.test(value)) ||
  (value.startsWith("<!--") && !value.includes("-->")) ||
  (value.startsWith("<?") && !value.includes("?>")) ||
  (/^<!\[CDATA\[/.test(value) && !value.includes("]]>")) ||
  (/^<![A-Za-z]/.test(value) && !value.includes(">"));
/** Start conditions 1 to 7 of an HTML block, judged on the first line (condition 7: a complete tag alone, not script, style, pre or textarea). */
const opensHtmlBlock = (value: string): boolean =>
  startsHtmlBlock(value) || (/^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.test(value.split("\n")[0] ?? "") && !/^<\/?(?:script|style|pre|textarea)[\s>]/i.test(value));
const startsHtmlBlock = (value: string): boolean =>
  new RegExp(`^(?:<(?:pre|script|style|textarea)(?:[\\s>]|$)|<!--|<\\?|<![A-Za-z]|<!\\[CDATA\\[|</?(?:${BLOCK_TAGS})(?:[\\s/>]|$))`, "i").test(value);
const trimmedForMarkdown = (node: Node): Node => normalisedBlock(node);

/** In a heading or table cell the writer writes each hard break as the inline HTML `<br />`, which is read back as one. */
function breaksAsHtml(node: Node): Node {
  const html = node.type.schema.nodes["html"];
  const breakType = node.type.schema.nodes["hardbreak"];
  if (!html || !breakType) return node;
  const children: Node[] = [];
  node.forEach((child) => children.push(child.type === breakType ? html.create({ value: "<br />" }, null, child.marks) : child));
  return node.type.create(node.attrs, Fragment.fromArray(children), node.marks);
}

/**
 * The document as Markdown can keep it: the invisible differences between a live document and what is written and read
 * back. Pure; idempotent; for every document `serialise(doc)` equals `serialise(normaliseForMarkdown(doc))`, and reading
 * the Markdown back gives `normaliseForMarkdown(doc)` (list `spread` flags aside) except for the listed losses of
 * docs/proof/m2-schema-fixes.md. The server converter compares the re-read document with this, not with the live one.
 */
/** CRLF and CR in code are line endings the Markdown reader (and an HTML parser) turn into LF: the normal form says LF. */
function withLfLineEndings(node: Node): Node {
  if (!node.textContent.includes("\r")) return node;
  return node.type.create(node.attrs, node.type.schema.text(node.textContent.replaceAll("\r\n", "\n").replaceAll("\r", "\n")), node.marks);
}

function normalisedTree(doc: Node, top: boolean): Node {
  const walk = (node: Node, top: boolean): Node => {
    if (node.type.name === "code_block") return withLfLineEndings(node);
    if (node.isText || node.isLeaf) return node;
    if (node.isTextblock) return normalisedBlock(node);
    const children: Node[] = [];
    const cell = node.type.name === "table_cell" || node.type.name === "table_header";
    const task = node.type.name === "list_item" && node.attrs["checked"] != null;
    node.forEach((child, _offset, index) => children.push(cell && child.isTextblock ? normalisedBlock(child, true) : task && index === 0 && child.isTextblock ? normalisedBlock(child, false, true) : walk(child, false)));
    if (top) {
      while (children.length > 0 && isEmptyParagraph(children.at(-1) as Node)) children.pop();
      const paragraph = node.type.schema.nodes["paragraph"];
      if (children.length === 0 && paragraph) children.push(paragraph.create({ level: 0 }));
    }
    // List item labels are derived, as the reader derives them (the preset's remarkAddOrderInList: `index + start`,
    // and the editor's syncListOrderPlugin: `${index + order}.`): a stale, duplicated, missing or non-numeric label
    // comes back renumbered, so the normal form says the same.
    const listType = node.type.name === "ordered_list" ? "ordered" : node.type.name === "bullet_list" ? "bullet" : null;
    if (listType) {
      const order = typeof node.attrs["order"] === "number" ? (node.attrs["order"] as number) : 1;
      children.forEach((child, index) => {
        if (child.type.name === "list_item") children[index] = child.type.create({ ...child.attrs, label: listType === "ordered" ? `${index + order}.` : "•", listType }, child.content, child.marks);
      });
    }
    return node.type.create(node.attrs, Fragment.fromArray(children), node.marks);
  };
  return walk(doc, top);
}

export function normaliseForMarkdown(doc: Node): Node {
  return normalisedTree(doc, true);
}

/** Paragraph with a `level` attribute: 0 is a paragraph, 1 to 6 are headings. Markdown `#` to `######` map to it. */
export const paragraphWithLevel = paragraphSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    defining: true,
    attrs: { ...(base.attrs ?? {}), level: { default: 0, validate: "number" } },
    parseDOM: [...(base.parseDOM ?? []), ...LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } }))],
    toDOM: (node) => {
      const spec = base.toDOM?.(node) ?? ["p", 0];
      const level: unknown = node.attrs["level"];
      if (typeof level === "number" && level > 0 && Array.isArray(spec)) return [`h${level}`, ...spec.slice(1)];
      return spec;
    },
    parseMarkdown: {
      match: (node) => node.type === "paragraph" || node.type === "heading",
      runner: (state, node, type) => {
        state.openNode(type, { level: node.type === "heading" ? node.depth : 0 });
        if (node.children) state.next(node.children);
        else state.addText(typeof node.value === "string" ? node.value : "");
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === "paragraph",
      runner: (state, original, ...rest) => {
        const level0: unknown = original.attrs["level"];
        const node = typeof level0 === "number" && level0 > 0 ? breaksAsHtml(normalisedBlock(original)) : normalisedBlock(original);
        const level: unknown = node.attrs["level"];
        if (typeof level !== "number" || level <= 0) {
          base.toMarkdown.runner(state, node, ...rest);
          return;
        }
        state.openNode("heading", undefined, { depth: level });
        state.next(node.content);
        state.closeNode();
      },
    },
  };
});

/** The heading node exists so the rest of the preset resolves, but nothing parses into it or shows it. */
export const dormantHeading = headingSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return { ...base, parseDOM: [], parseMarkdown: { ...base.parseMarkdown, match: () => false } };
});

/** Where an address is used: a link may be `mailto:`, an image may not. */
export type UrlKind = "link" | "image";
const MAX_URL_LENGTH = 8192;
/**
 * Links: the web and mail, plus the schemes that only hand an address to another program and carry no content or script
 * (`tel`, `sms`, `xmpp`, `irc`, `ircs`, `ftp`, `ftps`, `matrix`, `geo`). The regression corpus has a real README with an `xmpp:` link, and
 * Milkdown's own link sanitiser allows `tel` and `ftp`. Images: `http` and `https` only (no `data:`, which can carry markup).
 */
const SCHEMES: Record<UrlKind, ReadonlySet<string>> = {
  link: new Set(["http", "https", "mailto", "tel", "sms", "xmpp", "irc", "ircs", "ftp", "ftps", "matrix", "geo"]),
  image: new Set(["http", "https"]),
};
const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

/** The scheme region of an address: what comes before the first `/`, `?` or `#`. Contains `:` only for an absolute address. */
function schemeOf(value: string): string | undefined {
  const colon = value.slice(0, firstDelimiter(value)).indexOf(":");
  return colon < 0 ? undefined : value.slice(0, colon);
}

/** Control characters, Unicode line and paragraph separators, and the invisible characters used to hide a scheme. */
function hasHiddenCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0xa0 || code === 0xad || code === 0x1680 || (code >= 0x2000 && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x2060 || code === 0x3000 || code === 0xfeff) return true;
  }
  return false;
}

/** Index of the first `/`, `?` or `#`: the end of the scheme region. */
function firstDelimiter(value: string): number {
  let end = 0;
  while (end < value.length && value[end] !== "/" && value[end] !== "?" && value[end] !== "#") end += 1;
  return end;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")", sol: "/", quest: "?", num: "#", period: "." };

/** Numeric character references and the few named ones that spell a scheme: what an HTML attribute would decode. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(colon|tab|newline|lpar|rpar|sol|quest|num|period));?/gi, (_all, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? _all;
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _all;
  });
}

function schemeIsSafe(value: string, kind: UrlKind): boolean {
  const scheme = schemeOf(value);
  return scheme === undefined || (SCHEME_NAME.test(scheme.toLowerCase()) && SCHEMES[kind].has(scheme.toLowerCase()));
}

/**
 * The one allow-list for the address of a link or an image (review finding F4). Allowed: `http`, `https`, `mailto` and the
 * hand-over schemes above (links only), and relative references (`/path`, `./a`, `a/b`, `#fragment`, `?query`, `//host/path`, a bare name). Refused: every other
 * scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, ...) in any spelling a browser would read as one, an address
 * with a control character, a line separator or an invisible character anywhere (a browser removes tabs and line feeds
 * inside a scheme: `java<TAB>script:`), leading or trailing spaces, an address longer than 8,192 characters, and an address whose
 * percent-decoded form would pass for one of those (`%6Aavascript:`, `javascript%3A`). A first segment with a colon that is not
 * an allowed scheme is refused too (RFC 3986 writes such a relative path as `./10:30`). Entities are the parser's business: it has
 * decoded them before an address reaches here, and a literal `&#106;avascript:` has a colon in its first segment.
 * What a refused address becomes is decided by the callers: the text of a link stays and the link goes, an image becomes its
 * alt text, an image link keeps the image.
 */
export function isSafeUrl(value: unknown, kind: UrlKind = "link"): boolean {
  if (typeof value !== "string") return false;
  if (value.length > MAX_URL_LENGTH || hasHiddenCharacter(value)) return false;
  if (value !== value.trim()) return false;
  if (!schemeIsSafe(value, kind)) return false;
  if (value.includes("&")) {
    const decoded = decodeEntities(value);
    if (decoded !== value && (!schemeIsSafe(decoded, kind) || hasHiddenCharacter(decoded.slice(0, firstDelimiter(decoded))))) return false;
  }
  if (value.includes("%")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return true; // a malformed escape cannot be decoded by a browser either; the raw form passed above
    }
    if (decoded !== value && (!schemeIsSafe(decoded, kind) || hasHiddenCharacter(decoded.slice(0, firstDelimiter(decoded))))) return false;
  }
  return true;
}

/**
 * Loss fix 1 (image-link): y-prosemirror keeps marks on text only, so a link mark on an image atom is dropped by every
 * Yjs round trip. A link that wraps exactly one image is read into attributes of the image node instead (`href`,
 * `linkTitle`; attributes survive Yjs) and written back as a link around the image.
 */
export const imageWithLink = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), href: { default: "", validate: "string" }, linkTitle: { default: "", validate: "string" } },
    // An image with an address that is not allowed is not made: its alt text stands in (nothing, if it has none).
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type, ...rest) => {
        if (isSafeUrl(node.url, "image")) base.parseMarkdown.runner(state, node, type, ...rest);
        else if (typeof node.alt === "string" && node.alt !== "") state.addText(node.alt);
      },
    },
    // Only an allowed address reaches the DOM, and only the attributes an image needs (not `href`, `linkTitle`, ...).
    toDOM: (node) => ["img", { ...(isSafeUrl(node.attrs["src"], "image") && node.attrs["src"] !== "" ? { src: String(node.attrs["src"]) } : {}), alt: String(node.attrs["alt"] ?? ""), title: String(node.attrs["title"] ?? "") }],
    toMarkdown: {
      match: (node) => node.type.name === "image",
      runner: (state, node, ...rest) => {
        const href: unknown = node.attrs["href"];
        if (typeof href !== "string" || href === "") {
          base.toMarkdown.runner(state, node, ...rest);
          return;
        }
        const linkTitle: unknown = node.attrs["linkTitle"];
        state.openNode("link", undefined, { url: href, title: typeof linkTitle === "string" && linkTitle !== "" ? linkTitle : null });
        base.toMarkdown.runner(state, node, ...rest);
        state.closeNode();
      },
    },
  };
});

/** The link side of loss fix 1: `[![alt](src)](href)` becomes one image node carrying the link. */
export const linkAroundImage = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    // A link mark whose address is not allowed is not rendered as a link: a plain span.
    toDOM: (mark, inline) => (isSafeUrl(mark.attrs["href"]) ? base.toDOM?.(mark, inline) ?? ["span", 0] : ["span", 0]),
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type, ...rest) => {
        const [child] = node.children ?? [];
        const imageType = type.schema.nodes["image"];
        const linkIsSafe = isSafeUrl(node.url);
        if (node.children?.length === 1 && child?.type === "image" && imageType) {
          if (!isSafeUrl(child.url, "image")) {
            // The image is refused (its alt text stands in) and the link around it has nothing left to wrap but text.
            if (typeof child.alt === "string" && child.alt !== "") {
              if (linkIsSafe) base.parseMarkdown.runner(state, { ...node, children: [{ type: "text", value: child.alt }] }, type, ...rest);
              else state.addText(child.alt);
            }
            return;
          }
          state.addNode(imageType, {
            src: String(child.url ?? ""),
            alt: typeof child.alt === "string" ? child.alt : "",
            title: typeof child.title === "string" ? child.title : "",
            href: linkIsSafe ? String(node.url ?? "") : "",
            linkTitle: linkIsSafe && typeof node.title === "string" ? node.title : "",
          });
          return;
        }
        // The text of a link whose address is refused stays; the link does not.
        if (!linkIsSafe) state.next(node.children);
        else base.parseMarkdown.runner(state, node, type, ...rest);
      },
    },
  };
});

/**
 * Loss fix 2 (table-alignment): the preset gives table cells the alignment default `left`; y-prosemirror omits null
 * attributes, so an unaligned cell (null) came back as `left` and the table gained `:---`. Default null instead.
 */
const unalignedDefault = (prev: GetNodeSchema): GetNodeSchema => (ctx) => {
  const base = prev(ctx);
  const alignment = base.attrs?.["alignment"];
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), alignment: { ...(alignment ?? {}), default: null } },
    // A cell is written by the preset's own cell writer, not the paragraph writer: give it the trimmed paragraph.
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node, ...rest) => {
        const children: Node[] = [];
        node.forEach((child) => children.push(child.type.name === "paragraph" ? breaksAsHtml(normalisedBlock(child, true)) : child));
        base.toMarkdown.runner(state, node.type.create(node.attrs, Fragment.fromArray(children), node.marks), ...rest);
      },
    },
  };
};
export const tableCellUnaligned = tableCellSchema.extendSchema(unalignedDefault);
export const tableHeaderUnaligned = tableHeaderSchema.extendSchema(unalignedDefault);

/**
 * Tight or loose. The Markdown writer keeps an item tight (no blank line between its blocks) when `spread` is false,
 * but forces a blank line between two blocks that would otherwise run together. The result had blank lines in some
 * places only; read back, the blank line made the item loose and the next save wrote blank lines everywhere, so the
 * Markdown was not a fixed point. And an empty paragraph, written `<br />`, starts an HTML block that swallows the
 * next block when read back. Both cases are written loose from the start. The cases are those of mdast-util-to-markdown's
 * `join` (a block after a paragraph at the end of the previous block, a quote after a quote, an ordered list that
 * does not start at 1 after a paragraph) plus the empty paragraph. Uses the documented `extendSchema` point of the gfm
 * list item; no serializer is written.
 */
const isPlainParagraph = (node: Node): boolean => node.type.name === "paragraph" && node.attrs["level"] === 0;
/** The last block reached by going into quotes and lists, as the Markdown writer does. */
const tailOf = (node: Node): Node => {
  let tail = node;
  while (["blockquote", "bullet_list", "ordered_list", "list_item"].includes(tail.type.name) && tail.childCount > 0) tail = tail.child(tail.childCount - 1);
  return tail;
};
/** A list that starts at a number other than 1 cannot interrupt a paragraph, also when a quote holds it as its first block. */
function startsWithLateOrderedList(node: Node): boolean {
  let head: Node | null = node;
  while (head && head.type.name === "blockquote") head = head.firstChild;
  return head?.type.name === "ordered_list" && head.attrs["order"] !== 1;
}
function mustBeLoose(left: Node, right: Node): boolean {
  if (left.type.name === "table" || right.type.name === "table") return true;
  // A paragraph that is only raw HTML is written as an HTML block, which runs on until a blank line.
  if (left.type.name === "paragraph" && left.childCount > 0 && Array.from({ length: left.childCount }, (_, i) => left.child(i)).every((child) => child.type.name === "html")) return true; // a table row would swallow the next line, so the writer forces a blank line
  if (isPlainParagraph(left) && isEmptyParagraph(left)) return true;
  if (left.type.name === "blockquote" && right.type.name === "blockquote") return true;
  if (isPlainParagraph(left) && startsWithLateOrderedList(right)) return true;
  return isPlainParagraph(tailOf(left)) && isPlainParagraph(right);
}
const itemNeedsLoose = (original: Node): boolean => {
  // Decided on the normal form, which is what is written (a raw `<pre>` paragraph is text by then).
  const item = normalisedTree(original, false);
  let loose = false;
  item.forEach((child, _offset, index) => {
    if (index < item.childCount - 1 && mustBeLoose(child, item.child(index + 1))) loose = true;
  });
  return loose;
};
export const listItemLooseWhenNeeded = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, original, ...rest) => {
        // The first paragraph of a task item is read inline after the checkbox, which the paragraph writer cannot know.
        const first = original.firstChild;
        const node = original.attrs["checked"] != null && first?.isTextblock ? original.copy(original.content.replaceChild(0, normalisedBlock(first, false, true))) : original;
        const written = itemNeedsLoose(node) && node.attrs["spread"] !== true ? node.type.create({ ...node.attrs, spread: true }, node.content, node.marks) : node;
        base.toMarkdown.runner(state, written, ...rest);
      },
    },
  };
});

/**
 * A list is loose when any of its items is: the writer separates all items by blank lines once one item has them, and
 * read back a list with one loose item is loose, so a tight list holding a loose item was not a fixed point.
 */
const looseListRunner = (node: Node): Node =>
  node.attrs["spread"] === true || !Array.from({ length: node.childCount }, (_, index) => node.child(index)).some((item) => item.attrs["spread"] === true || itemNeedsLoose(item))
    ? node
    : node.type.create({ ...node.attrs, spread: true }, node.content, node.marks);
export const bulletListLoose = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return { ...base, toMarkdown: { match: base.toMarkdown.match, runner: (state, node, ...rest) => base.toMarkdown.runner(state, looseListRunner(node), ...rest) } };
});
export const orderedListLoose = orderedListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return { ...base, toMarkdown: { match: base.toMarkdown.match, runner: (state, node, ...rest) => base.toMarkdown.runner(state, looseListRunner(node), ...rest) } };
});

/**
 * The preset skips the last empty paragraph of the document (it is the typing area, not content) but only one: with
 * two trailing empty blocks the first was written and, read back, became the last and was skipped, so the Markdown was
 * not a fixed point. This is the preset's `doc` node (the `$node` extension point; a `$node` has no `extendSchema`)
 * with the loop made to skip every trailing empty paragraph; the rest of the spec is copied unchanged.
 */
export const docWithoutTrailingEmpties = $node("doc", () => ({
  content: "block+",
  parseMarkdown: {
    match: ({ type }) => type === "root",
    runner: (state, node, type) => {
      state.injectRoot(node, type);
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "doc",
    runner: (state, node) => {
      let end = node.childCount;
      while (end > 0 && isEmptyParagraph(node.child(end - 1))) end -= 1;
      state.openNode("root");
      state.next(node.content.cut(0, offsetOf(node, end)));
    },
  },
}));
const isEmptyParagraph = (node: Node): boolean => node.type.name === "paragraph" && trimmedForMarkdown(node).content.size === 0;
const offsetOf = (node: Node, index: number): number => {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += node.child(i).nodeSize;
  return offset;
};

/**
 * Milkdown's writer returns a text node that ends with whitespace and holds none of `* _ \\` unescaped, to keep the
 * trailing space. So `[a](b) ` or `<b> ` or `&amp; ` before an image or a mark reached the Markdown raw and read back as a
 * link, HTML or an entity. This writer escapes the text as usual and then adds the trailing whitespace, telling the
 * escaper that whitespace follows. It replaces one `handlers.text` entry of the documented remark-stringify options.
 */
/**
 * Milkdown replaces mdast-util-to-markdown's `emphasis` and `strong` handlers with simple ones that skip the library's
 * delimiter ("attention") machinery, which picks `*` or `_` and encodes neighbouring characters so the delimiters stay
 * valid next to code, links and punctuation. Dropping the two overrides gives that machinery back; the only price is
 * that the `marker` attribute no longer chooses the character (`_em_` is written `*em*`, an invisible change).
 */
const withoutAttentionHandlers = <T extends object>(handlers: T | null | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(handlers ?? {}).filter(([name]) => name !== "emphasis" && name !== "strong")) as Partial<T>;

/**
 * A text with more than this many `]` (in the whole document, outside code) has them all written as `\\]`. Normal text keeps its `]` as the serialiser
 * writes it (a `]` with no `[` before it is plain text), but the Markdown parser's footnote tokenizer walks back over every earlier event for each such `]`,
 * so thousands of them in one block cost time with the square of their number (the verifying parse of a save is where it shows). `\\]` is a character
 * escape: it reads back as the same text and costs nothing. The count is per document, so splitting the brackets over many text nodes, marks or blocks
 * does not get round it, and the limit is high enough that no ordinary page reaches it.
 */
export const CLOSING_BRACKET_LIMIT = 2000;

/** Whether the document has more than `CLOSING_BRACKET_LIMIT` `]` in text that is not code. Stops counting once it knows. */
export function hasTooManyClosingBrackets(doc: Node): boolean {
  let count = 0;
  doc.descendants((node, _pos, parent) => {
    if (count > CLOSING_BRACKET_LIMIT) return false;
    if (node.isText && parent?.type.name !== "code_block" && !isCode(node)) {
      for (const char of node.text ?? "") if (char === "]") count += 1;
    }
    return true;
  });
  return count > CLOSING_BRACKET_LIMIT;
}

/** Set by the converter before it serialises a document for which `hasTooManyClosingBrackets` is true. */
export const escapeClosingBracketsCtx = createSlice(false, "grimoireEscapeClosingBrackets");

/** `]` not already escaped, written `\\]`. A backslash run of odd length before it escapes it already. */
function escapeUnescapedClosers(value: string): string {
  let out = "";
  let backslashes = 0;
  for (const char of value) {
    out += char === "]" && backslashes % 2 === 0 ? "\\]" : char;
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  return out;
}

export const escapingTextWriter: MilkdownPlugin = (ctx) => {
  ctx.inject(escapeClosingBracketsCtx);
  // In the synchronous part: the options are read when `init` builds the remark processor, which comes later.
  ctx.update(remarkStringifyOptionsCtx, (options) => ({
    ...options,
    handlers: {
      ...withoutAttentionHandlers(options.handlers),
      text: (node, _parent, state, info) => {
        const value = node.value;
        const trailing = value.slice(value.length - trailingBlanks(value));
        const body = value.slice(0, value.length - trailing.length);
        const safe = state.safe(body, { ...info, encode: [], after: trailing === "" ? info.after : trailing.charAt(0) });
        return (ctx.get(escapeClosingBracketsCtx) ? escapeUnescapedClosers(safe) : safe) + trailing;
      },
    },
  }));
  return () => undefined;
};

/**
 * Inline `<br>` and `<br />` are read as a hard break (they are how a heading or a table cell, which are one line,
 * write one). The empty-paragraph placeholder, a `<br />` that is alone in its paragraph, is folded away by the preset
 * before this runs. Other inline HTML is untouched.
 */
export const htmlBreakIsHardBreak = htmlSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type, ...rest) => {
        const breakType = type.schema.nodes["hardbreak"];
        if (breakType && typeof node.value === "string" && /^<br\s*\/?>$/i.test(node.value.trim())) state.addNode(breakType, { isInline: false });
        else base.parseMarkdown.runner(state, node, type, ...rest);
      },
    },
  };
});

/**
 * Where Markdown has no way to write a heading-level paragraph, the editor does not make one: the first block of a
 * task item (GFM puts the checkbox only in front of a paragraph, so the checkbox would be lost) and a table cell (a
 * GFM cell is one line of inline content, so the level would be lost).
 */
function levelCannotBeWritten($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth - 1; depth >= 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "table_cell" || name === "table_header") return true;
    if (depth === $pos.depth - 1 && name === "list_item" && $pos.node(depth).attrs["checked"] != null && $pos.index(depth) === 0) return true;
  }
  return false;
}

/** Reading always gives the `*` marker: `_em_` and `*em*` are the same mark (the writer chooses the valid character). */
const starMarker = <Id extends string>(schema: $MarkSchema<Id>) =>
  schema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return { ...base, parseMarkdown: { match: base.parseMarkdown.match, runner: (state, node, type, ...rest) => base.parseMarkdown.runner(state, { ...node, marker: "*" }, type, ...rest) } };
  });
export const emphasisStar = starMarker(emphasisSchema);
export const strongStar = starMarker(strongSchema);

type MarkdownTree = { type: string; children?: MarkdownTree[]; value?: string; checked?: boolean | null; position?: { start: { offset?: number }; end: { offset?: number } } };
const BREAK_ELEMENT = /^<br\s*\/?>$/i;
const MARK_NODES = new Set(["emphasis", "strong", "delete"]);

/**
 * Two corrections to what the reader makes of Markdown, as a remark transform (an mdast pass after parsing):
 * 1. Emphasis inside emphasis (`*a **b *c* d** e*`), and strong in strong, strike in strike: marks are a set in the
 *    document, so the inner one closing removed the outer one for the rest of the text (`d` and `e` lost their
 *    italics; `marked`, a CommonMark renderer, keeps them). The inner node is unwrapped: the same text, one mark.
 * 2. A break element followed by a newline is one break, not two.
 * 3. A list item whose whole first paragraph is the checkbox (`* [ ]` with nothing after it) is an empty task item, as the
 *    editor writes one (`* [ ] <br />`), not a bullet with the text `[ ]`.
 */
export const tidyReading = $remark("grimoire-tidy-reading", () => () => (root) => {
  const tree = root as unknown as MarkdownTree; // mdast's own types do not allow the `checked` write below
  const walk = (node: MarkdownTree, open: ReadonlySet<string>): void => {
    if (!node.children) return;
    const next: MarkdownTree[] = [];
    for (const child of node.children) {
      if (MARK_NODES.has(child.type) && open.has(child.type)) {
        walk(child, open);
        next.push(...(child.children ?? []));
      } else {
        walk(child, MARK_NODES.has(child.type) ? new Set([...open, child.type]) : open);
        next.push(child);
      }
    }
    // `<br/>` then a newline is one line break to a reader (the newline after a break element is only whitespace), but
    // the editor's own line-break pass makes a break of every newline: drop that one, or the two would be two breaks.
    node.children = next.filter((child, index) => {
      const before = next[index - 1];
      if (child.type === "break" && before?.type === "html" && BREAK_ELEMENT.test(before.value ?? "")) return false;
      if (child.type === "text" && child.value === "") return false;
      return true;
    });
    if (node.type === "listItem" && node.checked == null) {
      const [first] = node.children;
      const only = first?.type === "paragraph" && first.children?.length === 1 ? first.children[0] : undefined;
      const marker = only?.type === "text" ? /^\[([ xX])\]$/.exec(only.value ?? "") : null;
      // Only a bare checkbox in the source: an escaped bracket (`\[ ]`) decodes to the same three characters but is 4 characters of source, and is text.
      const start = only?.position?.start.offset; const end = only?.position?.end.offset;
      const bare = start === undefined || end === undefined || end - start === (only?.value ?? "").length;
      if (first && marker && bare) {
        node.checked = marker[1] !== " ";
        first.children = [];
      }
    }
  };
  walk(tree, new Set());
});

/** Command: set the level (0 to 6) of the block that holds the cursor, as an attribute change. */
export const setBlockLevelCommand = $command("SetBlockLevel", (ctx) => (level?: number) => (state, dispatch) => {
  const paragraph = paragraphSchema.type(ctx);
  const { $from } = state.selection;
  if ($from.parent.type !== paragraph) return false;
  const target = level ?? 0;
  if (target > 0 && levelCannotBeWritten($from)) return false;
  if (!Number.isInteger(target) || target < 0 || target > 6) return false;
  if ($from.parent.attrs["level"] === target) return true;
  dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, level: target }));
  return true;
});

/** `#` to `######` followed by a space at the start of a block turns it into that level. */
/**
 * The `#` input rule's handler, as the library's `textblockTypeInputRule` does it (the context must be able to hold a
 * paragraph where the block is: `canReplaceWith`), with two refusals added: code blocks, and  the first block of a task item or a table cell.
 */
export function headingInputRuleHandler(paragraph: NodeType, state: EditorState, level: number, start: number, end: number): Transaction | null {
  const $start = state.doc.resolve(start);
  if (!$start.parent.isTextblock || $start.parent.type.spec.code || levelCannotBeWritten($start)) return null;
  if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), paragraph)) return null;
  return state.tr.delete(start, end).setBlockType(start, start, paragraph, { level });
}

export const headingLevelInputRule = $inputRule(
  (ctx) => new InputRule(/^(?<hashes>#{1,6})\s$/, (state, match, start, end) => headingInputRuleHandler(paragraphSchema.type(ctx), state, match.groups?.["hashes"]?.length ?? 0, start, end)),
);

const levelKey = (level: number) => ({
  shortcuts: `Mod-Alt-${level}`,
  command: (ctx: Ctx): Command => () => ctx.get(commandsCtx).call(setBlockLevelCommand.key, level),
});

/** Keyboard: Mod-Alt-1 to 6 set a level, Mod-Alt-0 resets it, Backspace at the start of a heading makes it text. */
export const headingLevelKeymap = $useKeymap("headingLevelKeymap", {
  SetLevel0: levelKey(0),
  SetLevel1: levelKey(1),
  SetLevel2: levelKey(2),
  SetLevel3: levelKey(3),
  SetLevel4: levelKey(4),
  SetLevel5: levelKey(5),
  SetLevel6: levelKey(6),
  HeadingToText: {
    shortcuts: "Backspace",
    command: (ctx: Ctx): Command => (state) => {
      const { selection } = state;
      if (!selection.empty || selection.$from.parentOffset !== 0) return false;
      const level: unknown = selection.$from.parent.attrs["level"];
      if (typeof level !== "number" || level <= 0) return false;
      return ctx.get(commandsCtx).call(setBlockLevelCommand.key, 0);
    },
  },
});

// Pieces of the commonmark preset that act on the `heading` node: replaced by the level versions above.
const removed = new Set<MilkdownPlugin>(
  [downgradeHeadingCommand, headingKeymap, syncHeadingIdPlugin, wrapInHeadingCommand, wrapInHeadingInputRule].flat(),
);

/**
 * Replace a preset plugin group by its extended version at the same position. Node order matters: ProseMirror fills an
 * empty `doc` with the first block type in schema order, which must stay `paragraph` (an appended paragraph overflows).
 */
function replaceGroup(plugins: MilkdownPlugin[], group: MilkdownPlugin[], replacement: MilkdownPlugin[]): MilkdownPlugin[] {
  if (group.length !== replacement.length) throw new Error("editor-schema: plugin group changed size");
  return plugins.map((plugin) => {
    const index = group.indexOf(plugin);
    return index < 0 ? plugin : (replacement[index] ?? plugin);
  });
}

/** The exact plugin array: commonmark (heading parts swapped for the level versions), gfm, and the level pieces. */
const swaps: [MilkdownPlugin | MilkdownPlugin[], MilkdownPlugin | MilkdownPlugin[]][] = [
  [docSchema, docWithoutTrailingEmpties],
  [paragraphSchema, paragraphWithLevel],
  [headingSchema, dormantHeading],
  [imageSchema, imageWithLink],
  [htmlSchema, htmlBreakIsHardBreak],
  [emphasisSchema, emphasisStar],
  [strongSchema, strongStar],
  [bulletListSchema, bulletListLoose],
  [orderedListSchema, orderedListLoose],
  [linkSchema, linkAroundImage],
];
const gfmSwaps: typeof swaps = [
  [extendListItemSchemaForTask, listItemLooseWhenNeeded],
  [tableCellSchema, tableCellUnaligned],
  [tableHeaderSchema, tableHeaderUnaligned],
];
const swap = (plugins: MilkdownPlugin[], list: typeof swaps): MilkdownPlugin[] =>
  list.reduce((acc, [from, to]) => replaceGroup(acc, [from].flat(), [to].flat()), plugins);

/**
 * Mark rank is registration order and decides nesting: the preset registers `link` after emphasis and strong, so the
 * link ended up innermost and `[*em* and **st**](u)` was written as two links. Registering the link group before
 * emphasis makes it the outermost mark, so one link wraps the whole text.
 */
function moveBefore(plugins: MilkdownPlugin[], group: MilkdownPlugin[], before: MilkdownPlugin[]): MilkdownPlugin[] {
  const rest = plugins.filter((plugin) => !group.includes(plugin));
  const at = rest.indexOf(before[0] as MilkdownPlugin);
  if (at < 0) throw new Error("editor-schema: emphasis plugin not found");
  return [...rest.slice(0, at), ...group, ...rest.slice(at)];
}

export const grimoireEditorPlugins: MilkdownPlugin[] = [
  ...moveBefore(swap(commonmark, swaps).filter((plugin) => !removed.has(plugin)), [linkAroundImage].flat(), [emphasisStar].flat()),
  ...swap(gfm, gfmSwaps),
  escapingTextWriter,
  tidyReading,
  setBlockLevelCommand,
  headingLevelInputRule,
  headingLevelKeymap,
].flat();
