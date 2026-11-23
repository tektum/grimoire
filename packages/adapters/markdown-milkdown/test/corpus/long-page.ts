import { sha256 } from './support.js';
import type { Pipeline } from './support.js';
import { observe } from './support.js';

/** Seeded generator (mulberry32): the same seed always gives the same page; a hand-written PRNG because Math.random cannot be seeded. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['page', 'editor', 'search', 'review', 'shared', 'notes', 'table', 'import', 'deploy', 'owner', 'draft', 'cache', 'שלום', '日本語', 'naïve'];

export const LONG_PAGE_SEED = 20261120;
/**
 * The Yjs state of this mix is about 3.5 times the Markdown, so 125 KB of Markdown, just under the 128 KiB seed limit, gives a
 * state well under the state limit (1,000,000 bytes by default). See the proof note.
 */
export const LONG_PAGE_TARGET_BYTES = 125_000;

/** A page built by repeating ten kinds of block, chosen at random, until it reaches the target size. */
export function buildLongPage(): string {
  const next = random(LONG_PAGE_SEED);
  const word = (): string => WORDS[Math.floor(next() * WORDS.length)] ?? 'x';
  const sentence = (): string => Array.from({ length: 6 + Math.floor(next() * 10) }, word).join(' ');
  const blocks: Array<() => string> = [
    () => `## ${sentence()}`,
    () => `${sentence()}. *${word()}* and **${word()}** and \`${word()}\` and [${word()}](https://example.org/${word()}).`,
    () => `* ${sentence()}\n  * ${sentence()}\n* ${sentence()}`,
    () => `1. ${sentence()}\n2. ${sentence()}`,
    () => `* [ ] ${sentence()}\n* [x] ${sentence()}`,
    () => `> ${sentence()}`,
    () => `\`\`\`ts\nconst ${word()} = '${sentence()}';\n\`\`\``,
    () => `| ${word()} | ${word()} |\n|---|---|\n| ${word()} | ${word()} |`,
    () => '***',
    () => `${sentence()}  \n${sentence()}`,
  ];
  const parts: string[] = [];
  let size = 0;
  while (size < LONG_PAGE_TARGET_BYTES) {
    const part = (blocks[Math.floor(next() * blocks.length)] as () => string)();
    parts.push(part);
    size += Buffer.byteLength(part) + 2;
  }
  return `${parts.join('\n\n')}\n`;
}

/** The record committed in place of the page: sizes and hashes of the input, the output and the search text. */
export async function describeLongPage(pipeline: Pipeline, markdown: string): Promise<string> {
  const result = await observe(pipeline, markdown);
  const record = {
    seed: LONG_PAGE_SEED,
    targetBytes: LONG_PAGE_TARGET_BYTES,
    inputBytes: Buffer.byteLength(markdown),
    inputSha256: sha256(markdown),
    outcome: result.first.outcome,
    outputBytes: Buffer.byteLength(result.first.markdown ?? ''),
    outputSha256: sha256(result.first.markdown ?? ''),
    textBytes: Buffer.byteLength(result.first.text ?? ''),
    textSha256: sha256(result.first.text ?? ''),
    secondSaveIdentical: result.stable,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}
