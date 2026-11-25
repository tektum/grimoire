import { createHash } from 'node:crypto';

/** One chunk of a page's text, as it is embedded and stored. */
export interface Chunk {
  readonly chunkIndex: number;
  readonly text: string;
  /** Offsets of the chunk in the text it was cut from, in UTF-16 code units: `text.slice(charStart, charEnd) === chunk.text`. */
  readonly charStart: number;
  readonly charEnd: number;
  /** The tokens of the chunk as the counter says (not the sum of its parts). */
  readonly tokenCount: number;
  /** SHA-256 of the model name, one NUL byte and the chunk's text: another model, or another text, is another hash, so an unchanged chunk is not embedded again. */
  readonly contentHash: Uint8Array;
}

export interface ChunkOptions {
  /** The model's name: it is part of every hash. */
  readonly model: string;
  /** Chunks are packed up to about this many tokens. Default 200. */
  readonly targetTokens?: number;
  /**
   * No chunk has more tokens than this unless a single piece cannot be cut (never, with a counter that counts a character as at most a token), by the sum of its pieces and then by
   * the counter's own answer for the chunk (a chunk over it is split again). Default 400, under the model's 512: a caller whose model refuses fewer must pass the lower limit.
   * The target is held to it.
   */
  readonly maxTokens?: number;
}

/** A text with fewer tokens than this has no chunk: there is nothing to find it by. */
const MIN_TOKENS = 3;

interface Piece { readonly start: number; readonly end: number; readonly tokens: number }

/**
 * Ends of a sentence: a full stop, question or exclamation mark with the quotes and brackets that may close it, then white space; and the full-width ones (。！？), which Chinese and
 * Japanese text writes with no white space after them, with the closing quotes and brackets that stay with the sentence, at the point after them.
 */
const SENTENCE_END = /(?<=[.!?…]["')\]»”’]*)\s+|(?<=[。！？]["')\]」』）»”’]*)(?!["')\]」』）»”’])/g;
const WHITE_SPACE = /\s+/g;

/** The parts of `piece` between the matches of `separator` (white space is cut off both ends of every part), as pieces. */
function splitAt(text: string, piece: Piece, separator: RegExp, count: (t: string) => number): Piece[] {
  const parts: Piece[] = [];
  const body = text.slice(piece.start, piece.end);
  let from = 0;
  const push = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(body.charAt(a))) a += 1;
    while (b > a && /\s/.test(body.charAt(b - 1))) b -= 1;
    if (b > a) parts.push({ start: piece.start + a, end: piece.start + b, tokens: count(body.slice(a, b)) });
  };
  for (const m of body.matchAll(separator)) {
    push(from, m.index);
    from = m.index + m[0].length;
  }
  push(from, body.length);
  return parts;
}

/** A piece that is one unbroken run of characters and still too long: cut at the longest prefix the counter accepts, never between the halves of a surrogate pair. */
function cutRun(text: string, piece: Piece, max: number, count: (t: string) => number): Piece[] {
  const parts: Piece[] = [];
  let start = piece.start;
  while (start < piece.end) {
    const remaining = piece.end - start;
    let hi = Math.min(remaining, 64);
    // Grow the window until the counter says it is too long, so the search costs what the piece costs and not what is left of the run.
    while (hi < remaining && count(text.slice(start, start + hi)) <= max) hi = Math.min(remaining, hi * 2);
    let lo = 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (count(text.slice(start, start + mid)) <= max) lo = mid;
      else hi = mid - 1;
    }
    let end = start + lo;
    const last = text.charCodeAt(end - 1);
    if (end < piece.end && end - 1 > start && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push({ start, end, tokens: count(text.slice(start, end)) });
    start = end;
  }
  return parts;
}

/** Pieces of at most `max` tokens: a piece that is longer is cut at sentence ends, then at white space, then inside a word. */
function fit(text: string, piece: Piece, max: number, count: (t: string) => number): Piece[] {
  if (piece.tokens <= max) return [piece];
  const sentences = splitAt(text, piece, SENTENCE_END, count);
  return sentences.flatMap((sentence) => {
    if (sentence.tokens <= max) return [sentence];
    return splitAt(text, sentence, WHITE_SPACE, count).flatMap((word) => (word.tokens <= max ? [word] : cutRun(text, word, max, count)));
  });
}

/**
 * Cuts a page's text into chunks for the embedder: the blocks are the lines (a blank line is no block), packed in order up to about `targetTokens`, a block over `maxTokens`
 * is cut at sentence ends and then at white space. The chunks cover every character that is not white space exactly once, in order, and each keeps its offsets. A text
 * of fewer than 3 tokens has no chunk. `countTokens` is the embedder's own counter; it is called once for each piece and once for each chunk, never for the whole text.
 */
export function chunkText(text: string, countTokens: (text: string) => number, options: ChunkOptions): Chunk[] {
  const max = options.maxTokens ?? 400;
  const target = Math.min(options.targetTokens ?? 200, max);
  const lines = splitAt(text, { start: 0, end: text.length, tokens: 0 }, /[\r\n]+/g, countTokens);
  const pieces = lines.flatMap((line) => fit(text, line, max, countTokens));
  if (pieces.reduce((sum, p) => sum + p.tokens, 0) < MIN_TOKENS) return [];
  const groups: Piece[][] = [];
  let tokens = 0;
  for (const piece of pieces) {
    const last = groups[groups.length - 1];
    if (last !== undefined && tokens + piece.tokens <= target) {
      last.push(piece);
      tokens += piece.tokens;
    } else {
      groups.push([piece]);
      tokens = piece.tokens;
    }
  }
  const chunks: Omit<Chunk, 'chunkIndex'>[] = [];
  /** A group is one chunk unless the counter says the whole is over the limit although the sum of its parts was not: then it is halved, by pieces, until it is not. */
  const emit = (group: readonly Piece[]): void => {
    const start = (group[0] as Piece).start;
    const end = (group[group.length - 1] as Piece).end;
    const chunk = text.slice(start, end);
    const tokenCount = countTokens(chunk);
    if (tokenCount > max && group.length > 1) {
      const half = Math.ceil(group.length / 2);
      emit(group.slice(0, half));
      emit(group.slice(half));
      return;
    }
    chunks.push({ text: chunk, charStart: start, charEnd: end, tokenCount, contentHash: new Uint8Array(createHash('sha256').update(options.model).update('\0').update(chunk).digest()) });
  };
  for (const group of groups) emit(group);
  return chunks.map((c, chunkIndex) => ({ chunkIndex, ...c }));
}
