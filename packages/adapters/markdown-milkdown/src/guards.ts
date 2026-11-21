import * as Y from 'yjs';
import type { ConvertFailure } from '@tektum/grimoire-core/ports/markdown-converter';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import type { ConverterLimits } from './limits.js';

/** What the guard needs of the schema: which node and mark types exist and which attributes they define. */
export interface SchemaLike {
  nodes: Readonly<Record<string, { spec: { attrs?: object | undefined } }>>;
  marks: Readonly<Record<string, { spec: { attrs?: object | undefined } }>>;
}

export type Guarded =
  | { ok: true; fragment: Y.XmlFragment; elements: number; textLength: number }
  | { ok: false; reason: ConvertFailure; detail: string };

const fail = (reason: ConvertFailure, detail: string): Guarded => ({ ok: false, reason, detail });

/**
 * Checks that run BEFORE any conversion, on the state bytes alone: size, a well-formed and complete update, no content
 * under another fragment name, nesting depth and block count. Hand-written because no library offers them
 * (see docs/proof/m2-conversion.md): y-prosemirror would recurse without a bound (a 1,000-deep tree overflows the stack) and drops
 * what it cannot read without saying so.
 *
 * It also counts what is there (elements and text characters), so `checkNoLoss` can compare with what survived.
 */
export function guardState(state: unknown, limits: ConverterLimits, schema?: SchemaLike): Guarded {
  if (!(state instanceof Uint8Array)) return fail('invalid-state', 'state is not a byte array');
  if (state.byteLength > limits.maxStateBytes) return fail('too-large', `state of ${state.byteLength} bytes exceeds the limit`);

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
  } catch {
    return fail('invalid-state', 'bytes are not a Yjs update');
  }
  // A truncated update leaves structs waiting for others that never arrive: converting would drop that content.
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
    return fail('invalid-state', 'update is incomplete');
  }
  for (const [name, type] of doc.share) {
    if (name !== FRAGMENT_NAME && isNonEmpty(type)) return fail('invalid-state', 'content under another top-level name');
  }
  let fragment: Y.XmlFragment;
  try {
    fragment = doc.getXmlFragment(FRAGMENT_NAME);
  } catch {
    return fail('invalid-state', 'document fragment has another type');
  }
  // A fragment only has children; map entries under its name (a Y.Map written there) would be ignored silently.
  for (const entry of fragment._map.values()) if (!entry.deleted) return fail('invalid-state', 'document fragment has map entries');

  // Iterative: a recursive walk would overflow the stack on the very input it has to refuse.
  let elements = 0;
  let textLength = 0;
  const stack: { parent: Y.XmlFragment | Y.XmlElement; depth: number }[] = [{ parent: fragment, depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const depth = item.depth + 1;
    for (const child of item.parent.toArray()) {
      if (child instanceof Y.XmlText) {
        // Text directly under the root is not a document: y-prosemirror would fail on it.
        if (item.parent === fragment) return fail('invalid-state', 'text directly under the document root');
        const measured = measureText(child, schema);
        if (typeof measured === 'string') return fail('content-lost', measured);
        textLength += measured;
        continue;
      }
      if (!(child instanceof Y.XmlElement) && !(child instanceof Y.XmlHook)) {
        return fail('invalid-state', 'document root holds something other than elements');
      }
      if (depth > limits.maxDepth) return fail('too-deep', `nesting is deeper than ${limits.maxDepth}`);
      elements += 1;
      if (elements > limits.maxBlocks) return fail('too-large', `more than ${limits.maxBlocks} blocks`);
      if (child instanceof Y.XmlElement) {
        const bad = schema ? checkElement(child, schema) : undefined;
        if (bad !== undefined) return fail('content-lost', bad);
        stack.push({ parent: child, depth });
      }
    }
  }
  return { ok: true, fragment, elements, textLength };
}

function isNonEmpty(type: { _length: number; _map: Map<string, { deleted: boolean }> }): boolean {
  if (type._length > 0) return true;
  for (const entry of type._map.values()) if (!entry.deleted) return true;
  return false;
}

/** Length of the text, or a reason when a mark is not one the schema defines or carries attributes it does not define. */
function measureText(text: Y.XmlText, schema: SchemaLike | undefined): number | string {
  let length = 0;
  for (const op of text.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
    // An embedded object is counted as one so that a text y-prosemirror cannot read shows up as a difference.
    length += typeof op.insert === 'string' ? op.insert.length : 1;
    if (!schema || !op.attributes) continue;
    for (const [mark, value] of Object.entries(op.attributes)) {
      const type = schema.marks[mark];
      if (!type) return 'a mark outside the schema';
      if (value === null) continue;
      const allowed = Object.keys(type.spec.attrs ?? {});
      if (value && typeof value === 'object' && Object.keys(value).some((key) => !allowed.includes(key))) {
        return 'a mark attribute outside the schema';
      }
    }
  }
  return length;
}

const ALIGNMENTS: readonly unknown[] = ['left', 'center', 'right', null];

/**
 * Attribute rules y-prosemirror does not enforce: it keeps an unknown attribute out of the document and clamps or
 * ignores some invalid values, and each of those changes what the author wrote. Hand-written: no library offers it.
 */
function checkElement(element: Y.XmlElement, schema: SchemaLike): string | undefined {
  const type = schema.nodes[element.nodeName];
  if (!type) return 'a node outside the schema';
  const allowed = Object.keys(type.spec.attrs ?? {});
  const attrs = element.getAttributes() as Record<string, unknown>;
  for (const key of Object.keys(attrs)) if (!allowed.includes(key)) return 'an attribute outside the schema';
  const level = attrs['level'];
  if (level !== undefined && (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 6)) {
    return 'a block level that is not an integer from 0 to 6';
  }
  if (element.nodeName === 'heading' && level !== undefined && level === 0) return 'a heading with level 0';
  if ('alignment' in attrs && !ALIGNMENTS.includes(attrs['alignment'])) return 'a table alignment that is not left, center or right';
  return undefined;
}

export interface Counted {
  descendants(visit: (node: { isText: boolean; text?: string | null | undefined }) => void): void;
}

/**
 * The loss check: every element and every text character in the Yjs fragment must be in the ProseMirror document.
 * y-prosemirror drops a node it cannot build (unknown type, invalid attribute value) and the text of a paragraph that
 * has a mark outside the schema, without an error. Marks on inline atoms and null attributes cannot be seen this way.
 */
export function checkNoLoss(counted: Counted, expected: { elements: number; textLength: number }): string | undefined {
  let elements = 0;
  let textLength = 0;
  counted.descendants((node) => {
    if (node.isText) textLength += node.text?.length ?? 0;
    else elements += 1;
  });
  if (elements === expected.elements && textLength === expected.textLength) return undefined;
  return `document has ${expected.elements} elements and ${expected.textLength} characters, conversion kept ${elements} and ${textLength}`;
}

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown> | undefined;
}

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown> | undefined;
  content?: JsonNode[] | undefined;
  marks?: JsonMark[] | undefined;
  text?: string | undefined;
}

// Hand-written: `String.prototype.toWellFormed` is not in the ES2023 library this repository compiles against.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The database rejects U+0000 in text (PostgreSQL documents this) and a lone surrogate is not valid UTF-8. */
export const sanitise = (value: string): string =>
  value.replaceAll('\u0000', '\uFFFD').replace(LONE_SURROGATE, '\uFFFD');

const SPREAD_HOLDERS: readonly string[] = ['bullet_list', 'ordered_list', 'list_item'];

/** The tree as plain data with the one allowed difference removed: the list spacing flag, a writer hint with no visible effect. */
function comparable(node: JsonNode): JsonNode {
  // Accepted class 3, "sanitised characters": U+0000 and lone surrogates are replaced by the converter itself when
  // it saves, and the reader replaces them too; both sides are compared after the same replacement.
  // Accepted class 5, "order of marks": marks are a set. ProseMirror orders them by schema rank when it builds a document
  // and Yjs hands them over in the order of their attributes, so the same marks can arrive in either order.
  if (node.type === 'text') {
    const marks = node.marks ? [...node.marks].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)) : undefined;
    return { ...node, text: sanitise(node.text ?? ''), ...(marks ? { marks } : {}) };
  }
  const attrs = { ...(node.attrs ?? {}) };
  if (SPREAD_HOLDERS.includes(node.type)) delete attrs['spread'];
  return { ...node, attrs, ...(node.content ? { content: node.content.map(comparable) } : {}) };
}

/** Key order of an attribute object depends on where the node came from (Yjs, the parser, JSON): it is not a difference. */
const canonical = (_key: string, value: unknown): unknown =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a, canonical) === JSON.stringify(b, canonical);

/**
 * Accepted class 1, "address becomes link": plain text that looks like a web or email address is read back as a link
 * (the reader's autolink literal rule: the link target is the text itself, with `mailto:` or `http://` in front). The
 * text is identical and only a `link` mark is added to a run that had none. Marks are undone on exactly those runs
 * (a link whose target is the run's own text, with the optional prefix, and which the expected document did not have),
 * adjacent runs with equal marks are merged again, and the result must equal the expected inline content.
 */
function withoutAutolinks(content: JsonNode[], expected: JsonNode[]): JsonNode[] {
  // Where the expected document has a link, character by character: an address is an added autolink only on text that had none.
  const linked: boolean[] = [];
  for (const node of expected) for (let i = 0; i < (node.text ?? '').length; i += 1) linked.push((node.marks ?? []).some((m) => m.type === 'link'));
  const merged: JsonNode[] = [];
  let offset = 0;
  for (const node of content) {
    let marks = node.marks;
    const link = marks?.find((mark) => mark.type === 'link');
    const text = node.text ?? '';
    const href = String(link?.attrs?.['href'] ?? '');
    const literal = link !== undefined && !link.attrs?.['title'] && [text, `mailto:${text}`, `http://${text}`, `https://${text}`].includes(href);
    const hadLink = linked.slice(offset, offset + text.length).some(Boolean);
    offset += text.length;
    if (literal && !hadLink) marks = marks?.filter((mark) => mark !== link);
    const next: JsonNode = { ...node, ...(marks && marks.length > 0 ? { marks } : {}) };
    if (marks && marks.length === 0) delete next.marks;
    const last = merged.at(-1);
    if (last && last.type === 'text' && next.type === 'text' && sameJson(last.marks ?? [], next.marks ?? [])) {
      merged[merged.length - 1] = { ...last, text: `${last.text ?? ''}${next.text ?? ''}` };
    } else merged.push(next);
  }
  return merged;
}

/** Marks the writer cannot keep on a space at the edge of a marked run (CommonMark: `** x**` is not strong). Inline code keeps its spaces, so it is not here. */
const EDGE_DROPPABLE: readonly string[] = ['emphasis', 'strong', 'strike_through', 'link'];

/**
 * Accepted class 4, "space at the edge of a marked run": the writer moves ONE ordinary space (U+0020) at the start or end
 * of a marked run to outside the marks that start or end there, so on read-back that space has fewer marks. The smallest
 * case is a strong run `x ` followed by plain text: written `**x** `, read back with the space unmarked. A reader sees the
 * same words and the same spacing. The rule applies to a character only when ALL of these hold, on the side being
 * normalised: (a) it is a single U+0020 (never a tab, a no-break space, a zero-width character; two spaces in a row are
 * two characters, each with a neighbouring space, so (b) fails for both); (b) in the same block it is next to a
 * non-whitespace character that carries exactly its marks, so it is the edge of a longer marked run and not a run of
 * whitespace only (a lone marked space between letters, such as a link, a code span or a struck gap, is visible or
 * clickable and stays a difference); (c) its other neighbour has different marks (it is an edge, not inside the run).
 * What it then loses is only the marks of EDGE_DROPPABLE; any other mark stays and is compared. Equal runs are merged again.
 */
function withoutEdgeSpaceMarks(content: JsonNode[]): JsonNode[] {
  interface Unit { node: JsonNode; marks: string; text: boolean; ws: boolean; }
  const units: Unit[] = [];
  for (const node of content) {
    const marks = JSON.stringify(node.marks ?? [], canonical);
    if (node.type !== 'text') units.push({ node, marks, text: false, ws: false });
    else for (const ch of node.text ?? '') units.push({ node: { ...node, text: ch }, marks, text: true, ws: /\s/u.test(ch) });
  }
  const solid = (u: Unit | undefined, marks: string): boolean => u !== undefined && u.text && !u.ws && u.marks === marks;
  const differs = (u: Unit | undefined, marks: string): boolean => u === undefined ? false : !u.text || u.marks !== marks;
  const out: JsonNode[] = [];
  units.forEach((unit, index) => {
    let node = unit.node;
    const before = units[index - 1];
    const after = units[index + 1];
    const edge = node.text === ' ' && ((solid(before, unit.marks) && differs(after, unit.marks)) || (solid(after, unit.marks) && differs(before, unit.marks)));
    if (edge && node.marks) {
      const kept = node.marks.filter((mark) => !EDGE_DROPPABLE.includes(mark.type));
      const rest = Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'marks')) as unknown as JsonNode;
      node = kept.length > 0 ? { ...rest, marks: kept } : rest;
    }
    const last = out.at(-1);
    if (last && last.type === 'text' && node.type === 'text' && sameJson(last.marks ?? [], node.marks ?? [])) {
      out[out.length - 1] = { ...last, text: `${last.text ?? ''}${node.text ?? ''}` };
    } else out.push(node);
  });
  return out;
}

/** Compare two nodes; `undefined` when equal or when they differ only by an accepted class, else the path of the first difference. */
function differ(expected: JsonNode, actual: JsonNode, path: string): string | undefined {
  if (expected.type !== actual.type) return `${path}: node type ${expected.type} became ${actual.type}`;
  if (!sameJson(expected.attrs ?? {}, actual.attrs ?? {})) return `${path}: attributes of ${expected.type} differ`;
  if (!sameJson(expected.marks ?? [], actual.marks ?? [])) return `${path}: marks differ`;
  if (expected.type === 'text') return expected.text === actual.text ? undefined : `${path}: text differs`;
  let want = expected.content ?? [];
  let have = actual.content ?? [];
  const inline = want.some((n) => n.type === 'text') || have.some((n) => n.type === 'text');
  if (inline && !sameJson(want, have)) {
    have = withoutEdgeSpaceMarks(withoutAutolinks(have, want));
    want = withoutEdgeSpaceMarks(want);
  }
  if (want.length !== have.length) return `${path}/${expected.type}: ${want.length} children became ${have.length}`;
  for (let i = 0; i < want.length; i += 1) {
    const found = differ(want[i] as JsonNode, have[i] as JsonNode, `${path}/${expected.type}[${i}]`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The read-back check. `expected` is the normal form of the document (`normaliseForMarkdown`), `actual` the document
 * read back from the Markdown written for it. They must be equal in node types, attributes, marks and text, with these
 * named exceptions: the list `spread` flag, accepted class 1 (`withoutAutolinks`), accepted class 3 (`sanitise`), accepted class 4 (`withoutEdgeSpaceMarks`) and accepted class 5 (the order of marks, in `comparable`). Accepted class 3 is `comparable`'s replacement of U+0000 and lone surrogates (the converter's own `sanitise`). The second accepted class of the
 * project decision, "second-save drift", is a difference in Markdown text only and so never reaches this comparison.
 * Returns the place of the first difference, or `undefined`.
 */
export function compareDocuments(expected: unknown, actual: unknown): string | undefined {
  return differ(comparable(expected as JsonNode), comparable(actual as JsonNode), '');
}

/**
 * What the Markdown reader can be made to do, bounded on the raw text: a conservative charge that never looks at block structure.
 * The reader is quadratic in the delimiters of one paragraph (10,000 unmatched `*a` cost 0.7 s, 20,000 cost 3 s, 30,000 closing
 * brackets about 40 s) and the converter's worker is killed after 10 s. Rule: the guard may count too much, it must never count too little.
 * So it charges every character of every line, whatever container the line is in (quote, list, code, table, heading): a paragraph never
 * continues over a blank line in any container, so a "context" is a run of non-blank lines, and wrapping text in any container can only
 * add characters to a run, never take any away. Nothing is exempt (a code block full of `*` is charged like prose).
 * `unescaped`: `* _ ~ [ ] ` and backtick, the characters that drive the reader's worst cases. `total`: those and the escaped ones.
 * Known limit (pinned by tests): a valid page with an extreme density of those characters in one run of lines (about 10,000 in a
 * row of non-blank lines) is refused as too complex, with the budget named.
 */
export const MAX_UNESCAPED_DELIMITERS = 10_000;
export const MAX_DELIMITERS = 100_000;
/** All runs together may cost about as much as four of the largest allowed ones (a few seconds of parsing). */
export const MAX_COST = 4 * MAX_UNESCAPED_DELIMITERS * MAX_UNESCAPED_DELIMITERS;

const DELIMITER_CODES = new Set(['*', '_', '~', '[', ']', '`'].map((c) => c.charCodeAt(0)));
const BACKSLASH = 92;
const LINE_END = /\r\n|\r|\n/g;
const BLANK = /^[ \t]*$/;

/** The charge of a document: the largest run (unescaped, total) and the sum of the squares of the runs' unescaped counts. */
export interface Complexity { readonly maxUnescaped: number; readonly maxTotal: number; readonly cost: number }

/** Linear in the length of the text. Lines end at LF, CRLF or a lone CR (as the reader's do). */
export function complexityOf(markdown: string): Complexity {
  let unescaped = 0;
  let total = 0;
  let maxUnescaped = 0;
  let maxTotal = 0;
  let cost = 0;
  const endRun = (): void => {
    maxUnescaped = Math.max(maxUnescaped, unescaped);
    maxTotal = Math.max(maxTotal, total);
    cost += unescaped * unescaped;
    unescaped = 0;
    total = 0;
  };
  let start = 0;
  while (start <= markdown.length) {
    LINE_END.lastIndex = start;
    const found = LINE_END.exec(markdown);
    const end = found ? found.index : markdown.length;
    const line = markdown.slice(start, end);
    start = found ? end + found[0].length : markdown.length + 1;
    if (BLANK.test(line)) {
      endRun();
      continue;
    }
    for (let i = 0; i < line.length; i += 1) {
      const code = line.charCodeAt(i);
      if (code === BACKSLASH) {
        if (DELIMITER_CODES.has(line.charCodeAt(i + 1))) total += 1;
        i += 1;
      } else if (DELIMITER_CODES.has(code)) {
        unescaped += 1;
        total += 1;
      }
    }
  }
  endRun();
  return { maxUnescaped, maxTotal, cost };
}

/** A sentence (never page text) naming the budget that is exceeded, or `undefined`. */
export function markdownComplexityProblem(markdown: string): string | undefined {
  const c = complexityOf(markdown);
  if (c.maxUnescaped > MAX_UNESCAPED_DELIMITERS || c.maxTotal > MAX_DELIMITERS) return `more than ${MAX_UNESCAPED_DELIMITERS} delimiters in one run of lines: too complex for the Markdown reader`;
  if (c.cost > MAX_COST) return 'more delimiter characters than the Markdown reader can take in the time it is given (the document-wide budget)';
  return undefined;
}

/**
 * The most children one block may have after the normal form. Milkdown's serializer copies a node's child list once per
 * child (`nextChildren.concat(child)` in `#maybeMergeChildren`), so a block of n children costs about n squared copies:
 * 15,000 children take 0.5 s, 30,000 take 2.3 s, 190,000 (one raw html value of 62,500 whole elements, which the reader splits
 * into tags and text) took 100 s. 25,000 is about 1.5 s. The document root is bounded by `maxBlocks` instead.
 */
export const MAX_CHILDREN = 25_000;

export interface Branching {
  childCount: number;
  descendants(visit: (node: Branching) => boolean | void): void;
}

/** A sentence if some block of the (normalised) document has more than `MAX_CHILDREN` children, else `undefined`. */
export function tooManyChildren(doc: Branching, maxBlocks: number): string | undefined {
  if (doc.childCount > maxBlocks) return `the document has more than ${maxBlocks} blocks`;
  let found = false;
  doc.descendants((node) => {
    if (node.childCount > MAX_CHILDREN) found = true;
    return !found;
  });
  return found ? `a block has more than ${MAX_CHILDREN} children` : undefined;
}
