import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/semantic/chunk.js';

// One token per whitespace-separated word, as the task says.
const words = (text: string): number => text.split(/\s+/).filter((w) => w !== '').length;
const MODEL = 'multilingual-e5-base';
const run = (text: string, model = MODEL) => chunkText(text, words, { model });
const sentence = (i: number, n = 10) => `${Array.from({ length: n - 1 }, (_, k) => `w${String(i)}x${String(k)}`).join(' ')} end${String(i)}.`;
const sentences = (count: number, perSentence = 10) => Array.from({ length: count }, (_, i) => sentence(i, perSentence)).join(' ');

/** The characters of `text` outside the chunks that are not whitespace: none, when the chunks cover every non-blank character once and in order. */
function uncovered(text: string, chunks: readonly { charStart: number; charEnd: number }[]): string {
  const covered = new Array<number>(text.length).fill(0);
  for (const c of chunks) for (let i = c.charStart; i < c.charEnd; i += 1) covered[i] = (covered[i] as number) + 1;
  return [...text].map((ch, i) => ((covered[i] === 0 && ch.trim() !== '') || (covered[i] as number) > 1 ? `${ch}@${String(i)}` : '')).join('');
}

describe('chunkText', () => {
  it('cuts 1,000 words of paragraphs into chunks of about 200 tokens, none above 400, in order, covering every non-blank character once', () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i, 20)).join('\n\n');
    const chunks = run(text);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(400);
      expect(c.tokenCount).toBeGreaterThan(0);
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
    expect(chunks.slice(0, -1).every((c) => c.tokenCount >= 100 && c.tokenCount <= 220)).toBe(true);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c, i) => i === 0 || (chunks[i - 1] as { charEnd: number }).charEnd <= c.charStart)).toBe(true);
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
    for (const c of chunks) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    expect(uncovered(text, chunks)).toBe('');
  });

  it('starts and ends every chunk at a character that is not white space', () => {
    const text = '   indented first line here   \n\t\ttabbed second line\t\n\n  last line  ';
    for (const c of run(text)) {
      expect(c.text).toBe(c.text.trim());
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it('counts tokens of the chunk as the counter says, not as the sum of its parts', () => {
    const count = (t: string): number => (t.includes('a b') ? 7 : words(t));
    const chunks = chunkText('a b c d e', count, { model: MODEL });
    expect(chunks.map((c) => c.tokenCount)).toEqual([7]);
  });
});
