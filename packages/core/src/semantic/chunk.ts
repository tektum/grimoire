import { createHash } from 'node:crypto';

/** One chunk of a page's text, as it is embedded and stored. */
export interface Chunk {
  readonly chunkIndex: number;
  readonly text: string;
  /**
   * Offsets of the chunk in the text it was cut from, in Unicode code points: what `ChunkRow` holds and PostgreSQL's `substr` counts, so a chunk handed to the store reads the right
   * passage. They differ from the UTF-16 offsets after an astral character (an emoji). A lone surrogate counts as one.
   */
  readonly charStart: number;
  readonly charEnd: number;
  /** The same offsets in UTF-16 code units, for slicing the JavaScript string: `text.slice(unitStart, unitEnd) === chunk.text`. */
  readonly unitStart: number;
  readonly unitEnd: number;
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
 * Ends of a sentence: a full stop, question or exclamation mark with the quotes and brackets that may close it (at most three: the look-behind reads a few characters, never a whole
 * run), then white space; and the full-width ones (。！？), which Chinese and Japanese text writes with no white space after them, with the closing quotes and brackets that stay with
 * the sentence, at the point after them (never before another closer or another mark: a run of marks is one end).
 */
const SENTENCE_END = /(?<=[.!?…]["')\]»”’]{0,3})\s+|(?<=[。！？]["')\]」』）»”’]{0,3})(?!["')\]」』）»”’。！？])/g;
const WHITE_SPACE = /\s+/g;

/** One call of the counter, then a step: the counter is the embedder's tokenizer, and every call of it is main-thread work, so a caller that wants to give the event loop a turn can do so after each. */
function* counted(count: (t: string) => number, text: string): Generator<void, number> {
  const tokens = count(text);
  yield;
  return tokens;
}

/** The parts of `piece` between the matches of `separator` (white space is cut off both ends of every part), as `[start, end]` offsets in `text`: nothing is counted. */
function spansAt(text: string, piece: Piece, separator: RegExp): [number, number][] {
  const spans: [number, number][] = [];
  const body = text.slice(piece.start, piece.end);
  let from = 0;
  const push = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(body.charAt(a))) a += 1;
    while (b > a && /\s/.test(body.charAt(b - 1))) b -= 1;
    if (b > a) spans.push([piece.start + a, piece.start + b]);
  };
  for (const m of body.matchAll(separator)) {
    push(from, m.index);
    from = m.index + m[0].length;
  }
  push(from, body.length);
  return spans;
}

/** The parts of `piece` between the matches of `separator`, as pieces, each counted (a step for each); a part that is all of the piece (the separator is not in it) is the piece, with its count. */
function* splitAt(text: string, piece: Piece, separator: RegExp, count: (t: string) => number): Generator<void, Piece[]> {
  const spans = spansAt(text, piece, separator);
  const only = spans[0];
  if (spans.length === 1 && only !== undefined && only[0] === piece.start && only[1] === piece.end) return [piece];
  const parts: Piece[] = [];
  for (const [start, end] of spans) parts.push({ start, end, tokens: yield* counted(count, text.slice(start, end)) });
  return parts;
}

/** A piece that is one unbroken run of characters and still too long: cut at the longest prefix the counter accepts, never between the halves of a surrogate pair. */
function* cutRun(text: string, piece: Piece, max: number, count: (t: string) => number): Generator<void, Piece[]> {
  const parts: Piece[] = [];
  let start = piece.start;
  while (start < piece.end) {
    const remaining = piece.end - start;
    let hi = Math.min(remaining, 64);
    // Grow the window until the counter says it is too long, so the search costs what the piece costs and not what is left of the run.
    while (hi < remaining && (yield* counted(count, text.slice(start, start + hi))) <= max) hi = Math.min(remaining, hi * 2);
    let lo = 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((yield* counted(count, text.slice(start, start + mid))) <= max) lo = mid;
      else hi = mid - 1;
    }
    let end = start + lo;
    const last = text.charCodeAt(end - 1);
    if (end < piece.end && end - 1 > start && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push({ start, end, tokens: yield* counted(count, text.slice(start, end)) });
    start = end;
  }
  return parts;
}

/** Pieces of at most `max` tokens: a piece that is longer is cut at sentence ends, then at white space, then inside a word. */
function* fit(text: string, piece: Piece, max: number, count: (t: string) => number): Generator<void, Piece[]> {
  if (piece.tokens <= max) return [piece];
  const pieces: Piece[] = [];
  for (const sentence of yield* splitAt(text, piece, SENTENCE_END, count)) {
    if (sentence.tokens <= max) {
      pieces.push(sentence);
      continue;
    }
    for (const word of yield* splitAt(text, sentence, WHITE_SPACE, count)) {
      if (word.tokens <= max) pieces.push(word);
      else for (const part of yield* cutRun(text, word, max, count)) pieces.push(part);
    }
  }
  return pieces;
}

/**
 * How much of the start of a line is counted to see that the line is over the limit: 8 characters for each token of the limit. A line that has more tokens than `maxTokens` in that start has
 * more in all of it (the tokens of a text are not fewer than those of its start, cut where the white space is), so the whole of a line of 140,000 characters is not handed to the counter at
 * once (132 ms for 20,000 words) and the line is cut at once. A line that is not over the limit in its start is counted whole, as it always was.
 */
const PROBE_CHARS_PER_TOKEN = 8;

/** The end of the start of `line` that is counted to see whether the line is over the limit: `probe` characters, less back to the last white space in the second half when there is one. */
function probeEnd(line: string, probe: number): number {
  for (let i = probe; i > probe / 2; i -= 1) if (/\s/.test(line.charAt(i))) return i;
  return probe;
}

/**
 * The cut of a page's text into chunks as steps: a `yield` after each line has been counted and fitted and after each chunk has been made, so that a caller can give the event loop a turn
 * between them (counting the tokens of a page of 20,000 words is 600 ms of main-thread work on a hosted runner, in one piece). The blocks are the lines (a blank line is no block), packed in
 * order up to about `targetTokens`, a block over `maxTokens` is cut at sentence ends and then at white space. The chunks cover every character that is not white space exactly once, in order,
 * and each keeps its offsets. A text of fewer than 3 tokens has no chunk. `countTokens` is the embedder's own counter; it is called once for each piece and once for each chunk, never for
 * the whole text.
 */
function* chunkSteps(text: string, countTokens: (text: string) => number, options: ChunkOptions): Generator<void, Chunk[]> {
  const max = options.maxTokens ?? 400;
  const target = Math.min(options.targetTokens ?? 200, max);
  // The lines are found without counting them: each is counted below, a step for each count.
  const pieces: Piece[] = [];
  const probe = PROBE_CHARS_PER_TOKEN * max;
  for (const [start, end] of spansAt(text, { start: 0, end: text.length, tokens: 0 }, /[\r\n]+/g)) {
    const line = text.slice(start, end);
    let tokens = Number.POSITIVE_INFINITY; // a line over the limit is cut by `fit` and its own count is not used
    if (line.length <= probe || (yield* counted(countTokens, line.slice(0, probeEnd(line, probe)))) <= max) tokens = yield* counted(countTokens, line);
    for (const piece of yield* fit(text, { start, end, tokens }, max, countTokens)) pieces.push(piece);
  }
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
  const chunks: Omit<Chunk, 'chunkIndex' | 'charStart' | 'charEnd'>[] = [];
  /** A group is one chunk unless the counter says the whole is over the limit although the sum of its parts was not: then it is halved, by pieces, until it is not. */
  function* emit(group: readonly Piece[]): Generator<void> {
    const start = (group[0] as Piece).start;
    const end = (group[group.length - 1] as Piece).end;
    const chunk = text.slice(start, end);
    const tokenCount = yield* counted(countTokens, chunk);
    if (tokenCount > max && group.length > 1) {
      const half = Math.ceil(group.length / 2);
      yield* emit(group.slice(0, half));
      yield* emit(group.slice(half));
      return;
    }
    chunks.push({ text: chunk, unitStart: start, unitEnd: end, tokenCount, contentHash: new Uint8Array(createHash('sha256').update(options.model).update('\0').update(chunk).digest()) });
  }
  for (const group of groups) yield* emit(group);
  // Code point offsets, in one pass over the text in order (the chunks are in order and never cut a surrogate pair).
  let unit = 0;
  let point = 0;
  const pointAt = (utf16: number): number => {
    for (; unit < utf16; unit += 1) {
      const code = text.charCodeAt(unit);
      if (code >= 0xd800 && code <= 0xdbff && unit + 1 < text.length) {
        const next = text.charCodeAt(unit + 1);
        if (next >= 0xdc00 && next <= 0xdfff) unit += 1; // a pair is one point; a lone high surrogate is one point and does not take the character after it
      }
      point += 1;
    }
    return point;
  };
  return chunks.map((c, chunkIndex) => ({ chunkIndex, ...c, charStart: pointAt(c.unitStart), charEnd: pointAt(c.unitEnd) }));
}

/** Cuts a page's text into chunks for the embedder (see `chunkSteps`), all at once. */
export function chunkText(text: string, countTokens: (text: string) => number, options: ChunkOptions): Chunk[] {
  const steps = chunkSteps(text, countTokens, options);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  return step.value;
}

/** The same chunks as `chunkText`, with `yieldToLoop` awaited between the steps: the caller says what a turn of its event loop is (`setImmediate`), so the cut is never one long block. */
export async function chunkTextYielding(text: string, countTokens: (text: string) => number, options: ChunkOptions, yieldToLoop: () => Promise<void>): Promise<Chunk[]> {
  const steps = chunkSteps(text, countTokens, options);
  let step = steps.next();
  while (step.done !== true) {
    await yieldToLoop();
    step = steps.next();
  }
  return step.value;
}
