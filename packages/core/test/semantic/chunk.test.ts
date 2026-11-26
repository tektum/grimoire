import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChunkRow } from '../../src/ports/embedding-store.js';
import { chunkText, chunkTextYielding } from '../../src/semantic/chunk.js';

// One token per whitespace-separated word, as the task says.
const words = (text: string): number => text.split(/\s+/).filter((w) => w !== '').length;
const MODEL = 'multilingual-e5-base';
const run = (text: string, model = MODEL) => chunkText(text, words, { model });
const gen = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${String(i)}`).join(' ');
const sentence = (i: number, n = 10) => `${Array.from({ length: n - 1 }, (_, k) => `w${String(i)}x${String(k)}`).join(' ')} end${String(i)}.`;
const sentences = (count: number, perSentence = 10) => Array.from({ length: count }, (_, i) => sentence(i, perSentence)).join(' ');

/** The characters of `text` outside the chunks that are not whitespace: none, when the chunks cover every non-blank character once and in order. */
function uncovered(text: string, chunks: readonly { unitStart: number; unitEnd: number }[]): string {
  const covered = new Array<number>(text.length).fill(0);
  for (const c of chunks) for (let i = c.unitStart; i < c.unitEnd; i += 1) covered[i] = (covered[i] as number) + 1;
  // By UTF-16 unit, like `covered` and the offsets: `[...text]` would go by code point and be off by one after every astral character.
  return Array.from({ length: text.length }, (_, i) => text.charAt(i)).map((ch, i) => ((covered[i] === 0 && ch.trim() !== '') || (covered[i] as number) > 1 ? `${ch}@${String(i)}` : '')).join('');
}

describe('chunkText', () => {
  it('cuts 1,000 words of paragraphs into chunks of about 200 tokens, none above 400, in order, covering every non-blank character once', () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i, 20)).join('\n\n');
    const chunks = run(text);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(400);
      expect(c.tokenCount).toBeGreaterThan(0);
      expect(text.slice(c.unitStart, c.unitEnd)).toBe(c.text);
    }
    expect(chunks.slice(0, -1).every((c) => c.tokenCount >= 100 && c.tokenCount <= 220)).toBe(true);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c, i) => i === 0 || (chunks[i - 1] as { unitEnd: number }).unitEnd <= c.unitStart)).toBe(true);
    expect(uncovered(text, chunks)).toBe('');
  });

  it('splits a single 900-word paragraph at sentence ends, then at the limit when a sentence has no end', () => {
    const paragraph = sentences(90, 10); // 900 words in sentences of ten
    const chunks = run(paragraph);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(400);
      expect(c.text.endsWith('.')).toBe(true); // every cut is at a sentence end
    }
    expect(uncovered(paragraph, chunks)).toBe('');

    const run900 = Array.from({ length: 900 }, (_, i) => `v${String(i)}`).join(' '); // no sentence end at all
    const cut = run(run900);
    expect(cut.every((c) => c.tokenCount <= 400)).toBe(true);
    expect(cut.length).toBeGreaterThanOrEqual(3);
    expect(uncovered(run900, cut)).toBe('');
  });

  it('cuts a word that is longer than the limit by itself, so no chunk is above it', () => {
    const count = (t: string): number => Math.ceil(t.replace(/\s/g, '').length / 3); // three characters a token
    const text = `start ${'x'.repeat(3000)} end`;
    const chunks = chunkText(text, count, { model: MODEL });
    expect(chunks.every((c) => c.tokenCount <= 400)).toBe(true);
    expect(chunks.map((c) => c.text).join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('gives no chunk for an empty text, a blank text and a text of 2 tokens, and one for 3', () => {
    expect(run('')).toEqual([]);
    expect(run(' \n\n \t ')).toEqual([]);
    expect(run('two tokens')).toEqual([]);
    expect(run('now three tokens')).toHaveLength(1);
  });

  it('never gives a chunk over 512 tokens, whatever the text and whatever options are asked for', () => {
    const text = `${sentences(200, 15)}\n${'word '.repeat(3000)}\n\n${sentences(40, 60)}`;
    for (const o of [{}, { targetTokens: 450, maxTokens: 900 }, { targetTokens: 10, maxTokens: 20 }]) {
      const chunks = chunkText(text, words, { model: MODEL, ...o });
      expect(Math.max(...chunks.map((c) => c.tokenCount))).toBeLessThanOrEqual(512);
    }
  });

  it('hashes the model name and the chunk text: the same text and model give the same hashes, another model or text gives others', () => {
    const text = sentences(60, 12);
    const a = run(text);
    const b = run(text);
    expect(a.map((c) => Buffer.from(c.contentHash).toString('hex'))).toEqual(b.map((c) => Buffer.from(c.contentHash).toString('hex')));
    expect(a[0]?.contentHash).toHaveLength(32);
    expect(Buffer.from(a[0]?.contentHash as Uint8Array)).toEqual(createHash('sha256').update(`${MODEL}\0${a[0]?.text ?? ''}`).digest());
    const other = run(text, 'multilingual-e5-small');
    expect(Buffer.from(other[0]?.contentHash as Uint8Array).equals(Buffer.from(a[0]?.contentHash as Uint8Array))).toBe(false);
    const edited = run(text.replace('end0.', 'changed0.'));
    expect(Buffer.from(edited[0]?.contentHash as Uint8Array).equals(Buffer.from(a[0]?.contentHash as Uint8Array))).toBe(false);
    expect(Buffer.from(edited[edited.length - 1]?.contentHash as Uint8Array).equals(Buffer.from(a[a.length - 1]?.contentHash as Uint8Array))).toBe(true); // an unchanged chunk keeps its hash
  });

  it('keeps the offsets in UTF-16 units of the text it was given, also with characters outside the basic plane and Windows line ends', () => {
    const text = `Ünï 🙂 first line here\r\n\r\nsecond 🙂 line goes here\r\nthird line of the page`;
    const chunks = run(text);
    for (const c of chunks) expect(text.slice(c.unitStart, c.unitEnd)).toBe(c.text);
    expect(uncovered(text, chunks)).toBe('');
  });

  it('starts and ends every chunk at a character that is not white space', () => {
    const text = '   indented first line here   \n\t\ttabbed second line\t\n\n  last line  ';
    for (const c of run(text)) {
      expect(c.text).toBe(c.text.trim());
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it('gives charStart and charEnd in Unicode code points, as ChunkRow and the store read them, and unitStart and unitEnd in UTF-16 units for slicing the string', () => {
    const text = '🙂🙂 first line here\n\nsecond 🙂 line goes here\nthird 𝒳 line';
    const chunks = chunkText(text, words, { model: MODEL, targetTokens: 3, maxTokens: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const points = Array.from(text);
    for (const c of chunks) {
      expect(points.slice(c.charStart, c.charEnd).join('')).toBe(c.text); // what PostgreSQL substr(text, charStart + 1, charEnd - charStart) reads
      expect(text.slice(c.unitStart, c.unitEnd)).toBe(c.text);
    }
    expect(chunks.some((c) => c.charStart !== c.unitStart)).toBe(true); // the astral characters make them differ
    expect(chunkText('plain ascii text here', words, { model: MODEL }).map((c) => [c.charStart, c.charEnd, c.unitStart, c.unitEnd])).toEqual([[0, 21, 0, 21]]);
    expect(chunkText('🙂 emoji first words', words, { model: MODEL })[0]).toMatchObject({ charStart: 0, charEnd: 19, unitStart: 0, unitEnd: 20 });
  });

  it('is assignable to a ChunkRow only with the same unit: a chunk passed straight to the store reads the right passage after an emoji', () => {
    const text = '🙂 alpha beta gamma';
    const [chunk] = chunkText(text, words, { model: MODEL });
    const row: ChunkRow = { chunkIndex: 0, contentHash: (chunk as { contentHash: Uint8Array }).contentHash, charStart: (chunk as { charStart: number }).charStart, charEnd: (chunk as { charEnd: number }).charEnd, tokenCount: 1 };
    expect(Array.from(text).slice(row.charStart, row.charEnd).join('')).toBe(text); // the whole text is one chunk: nothing read late
    const second = chunkText('🙂 first line here\n\nalpha beta gamma', words, { model: MODEL, targetTokens: 3, maxTokens: 10 }).at(-1);
    expect(Array.from('🙂 first line here\n\nalpha beta gamma').slice(second?.charStart, second?.charEnd).join('')).toBe('alpha beta gamma');
  });

  it('counts a lone surrogate as one code point and does not swallow the character after it, so later offsets do not drift', () => {
    const text = 'a\uD800 b c';
    const [chunk] = chunkText(text, words, { model: MODEL });
    expect(chunk).toMatchObject({ charStart: 0, charEnd: 6, unitStart: 0, unitEnd: 6 });
    const later = chunkText('x \uD800 first line here\n\n🙂 second line here', words, { model: MODEL, targetTokens: 3, maxTokens: 10 }).at(-1);
    expect(later?.text).toBe('🙂 second line here');
    expect(Array.from('x \uD800 first line here\n\n🙂 second line here').slice(later?.charStart, later?.charEnd).join('')).toBe('🙂 second line here');
  });

  it('counts tokens of the chunk as the counter says, not as the sum of its parts', () => {
    const count = (t: string): number => (t.includes('a b') ? 7 : words(t));
    const chunks = chunkText('a b c d e', count, { model: MODEL });
    expect(chunks.map((c) => c.tokenCount)).toEqual([7]);
  });

  it('never packs a chunk above maxTokens, whatever the target says: the target is held to the maximum', () => {
    const text = `${gen(80, 'a')}\n${gen(80, 'b')}`;
    const chunks = chunkText(text, words, { model: MODEL, maxTokens: 100 }); // the target is 200 by default
    expect(chunks.map((c) => c.tokenCount)).toEqual([80, 80]);
  });

  it('splits a packed chunk again when the counter says its real size is over the maximum, as a tokenizer that is not additive may', () => {
    // Every piece alone is 60 tokens, but two together are counted as 130: the sum would let them through.
    const count = (t: string): number => { const n = words(t); return n > 60 ? n + 10 : n; };
    const text = `${gen(60, 'a')}\n${gen(60, 'b')}`;
    const chunks = chunkText(text, count, { model: MODEL, targetTokens: 200, maxTokens: 125 });
    expect(chunks.map((c) => c.tokenCount)).toEqual([60, 60]);
    expect(uncovered(text, chunks)).toBe('');
  });

  it('cuts after the full-width sentence ends of Chinese and Japanese text, which has no white space after them', () => {
    const sentenceJa = (i: number): string => `これは${String(i)}番目の文章です${'あ'.repeat(8)}。`;
    const text = Array.from({ length: 60 }, (_, i) => sentenceJa(i)).join(''); // one long line, no spaces
    const count = (t: string): number => Math.ceil(t.length / 2);
    const chunks = chunkText(text, count, { model: MODEL, targetTokens: 40, maxTokens: 60 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.endsWith('。')).toBe(true); // every cut is after a sentence end
    expect(uncovered(text, chunks)).toBe('');
    const closing = chunkText('「はい。」と言った。それから、「いいえ！」とも。'.repeat(8), count, { model: MODEL, targetTokens: 12, maxTokens: 16 });
    for (const c of closing) expect(c.text.startsWith('」')).toBe(false); // a closing quote stays with its sentence
  });

  it('the helper that checks coverage sees an uncovered character after an astral one', () => {
    expect(uncovered('🙂a', [{ unitStart: 0, unitEnd: 2 }])).toBe('a@2');
    expect(uncovered('🙂a', [{ unitStart: 0, unitEnd: 3 }])).toBe('');
  });

  it('keeps stacked full-width marks together: a cut after 本当？！ is after the second mark, never between them', () => {
    const count = (t: string): number => Math.ceil(t.length / 2);
    const text = '本当？！はい。'.repeat(40);
    const chunks = chunkText(text, count, { model: MODEL, targetTokens: 2, maxTokens: 14 }); // a piece to a chunk, so every cut shows
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(['！', '？', '。'].includes(c.text.charAt(0))).toBe(false);
    expect(uncovered(text, chunks)).toBe('');
  });

  it('does not take quadratic time on a long line of closing quotes or brackets', () => {
    const count = (t: string): number => Math.ceil(t.length / 4);
    for (const unit of ['"', '」', ')']) {
      const text = `${unit.repeat(150_000)} end`;
      const began = performance.now();
      const chunks = chunkText(text, count, { model: MODEL });
      expect(performance.now() - began, `${unit} run`).toBeLessThan(2000);
      expect(uncovered(text, chunks)).toBe('');
    }
  });

  it('counts the text it cuts a long run from in work that grows with the run, not with the run times its pieces', () => {
    const text = 'x'.repeat(200_000);
    let counted = 0;
    const count = (t: string): number => { counted += t.length; return Math.ceil(t.length / 3); };
    const chunks = chunkText(text, count, { model: MODEL });
    expect(chunks.length).toBeGreaterThan(100);
    expect(counted).toBeLessThan(text.length * 30); // each piece costs a few probes of about its own size, not of the whole rest
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });
});

describe('chunkTextYielding', () => {
  const options = { model: MODEL };

  it('gives the same chunks as chunkText, offsets and hashes included, for text with long lines, a long sentence, blank lines and an astral character', async () => {
    const text = [sentences(30), '', `${gen(450, 'long')}`, `😀 ${sentences(8, 25)}`, '  ', gen(5, 'short'), `${'x'.repeat(3000)}`].join('\n');
    const yielded = await chunkTextYielding(text, words, options, () => Promise.resolve());
    expect(yielded.length).toBeGreaterThan(5);
    expect(yielded).toEqual(chunkText(text, words, options));
  });

  it('awaits a turn between its steps, one for each line it counts and one for each chunk it makes, and the turns come while the work goes on, not after it', async () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => gen(150, `p${String(i)}x`)).join('\n\n'); // 12 lines, 12 chunks of 150 tokens (a line is as long as the target)
    let turns = 0;
    let counted = 0;
    const countedAtTurn: number[] = [];
    const chunks = await chunkTextYielding(paragraphs, (t) => { counted += 1; return words(t); }, options, () => { turns += 1; countedAtTurn.push(counted); return Promise.resolve(); });
    expect(chunks).toHaveLength(12);
    expect(turns).toBe(24);
    expect(countedAtTurn[0]).toBe(1); // the first turn comes after the first line is counted, not after all of them
    expect(countedAtTurn[11]).toBeLessThan(counted); // and the last line step is not the end of the counting: the chunks are counted after it
  });

  it('has no chunk for a text of fewer than three tokens, after the turns for its lines', async () => {
    let turns = 0;
    expect(await chunkTextYielding('two words', words, options, () => { turns += 1; return Promise.resolve(); })).toEqual([]);
    expect(turns).toBe(1);
  });
});
