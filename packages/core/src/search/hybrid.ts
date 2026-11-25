import { SNIPPET_FALLBACK_CHARS, SNIPPET_MAX_CHARS } from './snippet.js';

/**
 * Hybrid search (contracts section 15.5): the full-text list and the semantic list of pages are fused by reciprocal rank, and the page of the answer is cut out of the fused order by a
 * key that is the same on every request. Everything here is a pure function of its lists; the repositories make the lists, inside the access filter, and nothing here reads a row that was not
 * handed over.
 */

/** The constant of reciprocal rank fusion: a page at rank `r` of a list scores `1 / (RRF_K + r)`, with `r` counted from 1. */
export const RRF_K = 60;

/** A page of a candidate list. The list is in rank order (best first), the position is the rank; the edit time breaks ties of the fused score. */
export interface Candidate {
  readonly id: string;
  /** The last edit, in microseconds (the full-text list's own sort key: the same number in both lists for the same page). */
  readonly editedAt: number;
}

export interface FusedRow {
  readonly id: string;
  readonly editedAt: number;
  /** The sum, over the lists the page is in, of `1 / (RRF_K + rank)`. */
  readonly score: number;
  /** The rank (from 1) in the full-text list, or undefined when the words did not find the page. */
  readonly fullTextRank: number | undefined;
  /** The rank (from 1) in the semantic list, or undefined when only the words found the page. */
  readonly semanticRank: number | undefined;
}

/** Best first: the higher score, then the later edit, then the greater id (the order of the existing full-text query: rank, edit time, id, all descending). */
export function compareFused(a: Pick<FusedRow, 'score' | 'editedAt' | 'id'>, b: Pick<FusedRow, 'score' | 'editedAt' | 'id'>): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.editedAt !== b.editedAt) return a.editedAt > b.editedAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

/**
 * The two lists fused. A page in both lists scores the sum of its two terms, so it outranks a page in one list at the same rank; a page in one list only keeps that list's term. The result is
 * a total order (score, edit time, id), the same for the same two lists whatever the order the rows came in, and a page appears once. An empty semantic list gives the full-text order unchanged,
 * and the other way round: the score of a single list falls with the rank, so the list's own order is kept.
 */
export function fuse(fullText: readonly Candidate[], semantic: readonly Candidate[]): FusedRow[] {
  const rows = new Map<string, { id: string; editedAt: number; fullTextRank: number | undefined; semanticRank: number | undefined }>();
  const add = (list: readonly Candidate[], field: 'fullTextRank' | 'semanticRank'): void => {
    list.forEach((c, i) => {
      const row = rows.get(c.id) ?? { id: c.id, editedAt: c.editedAt, fullTextRank: undefined, semanticRank: undefined };
      if (row[field] === undefined) row[field] = i + 1; // a page that a list names twice keeps its better place
      rows.set(c.id, row);
    });
  };
  add(fullText, 'fullTextRank');
  add(semantic, 'semanticRank');
  return [...rows.values()].map((r) => ({ ...r, score: (r.fullTextRank === undefined ? 0 : 1 / (RRF_K + r.fullTextRank)) + (r.semanticRank === undefined ? 0 : 1 / (RRF_K + r.semanticRank)) })).sort(compareFused);
}

/** What a request gives the next one: the fused row it ended on. It is the `rank`, `editedAt` and `id` of the cursor of `core/search/cursor` (the score is the rank). */
export interface FusedKey {
  readonly score: number;
  readonly editedAt: number;
  readonly id: string;
}

/**
 * The rows after `after` (all of them for none), at most `limit`, and whether more follow. The key is the last row's triple, so a row is returned once whatever the lists do between two requests
 * as long as they are the same: each request fuses again from the same two statements.
 */
export function pageOf(rows: readonly FusedRow[], after: FusedKey | undefined, limit: number): { readonly rows: FusedRow[]; readonly more: boolean } {
  const rest = after === undefined ? rows : rows.filter((r) => compareFused(after, r) < 0);
  return { rows: rest.slice(0, limit), more: rest.length > limit };
}

/**
 * The most pages found only by meaning that one answer holds. A nearest-neighbour search always has nearest pages, and with the models in use the similarity of a search that matches nothing
 * is in the band of real answers (docs/proof/m7-semantic-quality.md), so no similarity separates them: the answer is limited instead, and each of these pages shows the passage that was found.
 */
export const MEANING_ONLY_MAX = 5;

/**
 * The fused rows without the pages found only by meaning beyond the first `max` (in the fused order). Pages found by words, alone or with meaning, are never dropped. It is applied to the whole fused
 * list before a page is cut out of it, so that the same pages are dropped on every request.
 */
export function limitMeaningOnly(rows: readonly FusedRow[], max: number): FusedRow[] {
  let meaningOnly = 0;
  return rows.filter((row) => row.fullTextRank !== undefined || (meaningOnly += 1) <= max);
}

/** A chunk found by the vector query: where it is in the page's text and how near the query it is (cosine, 1 for the same direction). */
export interface ChunkMatch {
  readonly pageId: string;
  readonly chunkIndex: number;
  readonly similarity: number;
  readonly editedAt: number;
}

/**
 * The semantic list: the best chunk of each page, pages in the order of their best chunk, at most `limit` pages. The chunks may come in any order. Equal similarities are told apart by the
 * lower chunk index of a page and by the page's later edit and greater id across pages, so the same chunks always give the same list.
 */
export function bestChunkPerPage<T extends ChunkMatch>(chunks: readonly T[], limit: number): T[] {
  const best = new Map<string, T>();
  for (const c of chunks) {
    const held = best.get(c.pageId);
    if (held === undefined || c.similarity > held.similarity || (c.similarity === held.similarity && c.chunkIndex < held.chunkIndex)) best.set(c.pageId, c);
  }
  return [...best.values()]
    .sort((a, b) => (a.similarity !== b.similarity ? b.similarity - a.similarity : a.editedAt !== b.editedAt ? b.editedAt - a.editedAt : a.pageId > b.pageId ? -1 : 1)) // one chunk of each page: the ids differ
    .slice(0, limit);
}

/** Control characters that are not white space (those are collapsed below, and U+0085 is white space too): the snippet sentinels U+0001 and U+0002 are among them. */
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
/** Every kind of white space JavaScript knows (the no-break and the Unicode spaces, the line and paragraph separators, the byte order mark) and U+0085. */
const SPACES = /[\s\u0085]+/g;

/** `text` cut to at most `max` UTF-16 units: at the last space inside the limit when there is one past the first quarter, never inside a surrogate pair. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const space = text.lastIndexOf(' ', end);
  return (space > max / 4 ? text.slice(0, space) : text.slice(0, end)).trimEnd();
}

/**
 * The passage of a chunk, as the answer shows it: the plain text of `text[charStart, charEnd)`, control characters and the snippet sentinels (U+0001, U+0002) taken out, runs of white space made
 * one space, cut at a word boundary to at most 300 characters. No markup and no ranges: a passage is text. An empty chunk (offsets outside the text, or only controls) gives an empty passage.
 */
export function passageOf(text: string, charStart: number, charEnd: number): string {
  const start = Math.max(0, Math.min(charStart, text.length));
  const end = Math.max(start, Math.min(charEnd, text.length));
  return cutAtWord(text.slice(start, end).replace(CONTROLS, '').replace(SPACES, ' ').trim(), SNIPPET_MAX_CHARS);
}

/** What a page found only by meaning shows where a snippet goes, for the clients that do not know passages: the first 160 characters of the passage, with no ranges. */
export function snippetOfPassage(passage: string): { readonly text: string; readonly ranges: readonly [] } {
  if (passage.length <= SNIPPET_FALLBACK_CHARS) return { text: passage, ranges: [] };
  let end = SNIPPET_FALLBACK_CHARS;
  const code = passage.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: passage.slice(0, end), ranges: [] };
}
