import type { ConvertFailure, MarkdownConverter, SeedFailure } from '../ports/markdown-converter.js';
import { markdownHash } from './hash.js';

declare const seeded: unique symbol;

/**
 * Markdown together with the editor state it was seeded into. The only way to get one is `seedUserMarkdown`, so a repository that
 * takes this type cannot be handed user-supplied Markdown without its state.
 */
export type SeededContent = {
  readonly state: Uint8Array;
  readonly markdown: string;
  readonly text: string;
  readonly hash: Buffer;
  readonly [seeded]: true;
};

/** A refusal of the seed (`stage: 'seed'`) or of the conversion back to Markdown after a good seed (`stage: 'convert'`). Never holds page text. */
export type SeedRefusal = {
  readonly ok: false;
  readonly stage: 'seed' | 'convert';
  readonly reason: SeedFailure | ConvertFailure;
  readonly detail: string;
  readonly message?: string;
};

/**
 * Seeds user-supplied Markdown with the strict limits. `userId` is the key, so one user holds at most one worker; it is never a page
 * id. Stores the serialiser's canonical Markdown, not the text that was sent.
 */
export async function seedUserMarkdown(
  converter: MarkdownConverter,
  userId: string,
  title: string,
  markdown: string,
): Promise<SeededContent | SeedRefusal> {
  const seed = await converter.seed(markdown, userId);
  if (!seed.ok) return refusal('seed', seed);
  const back = await converter.toMarkdown(seed.state);
  if (!back.ok) return refusal('convert', back);
  return { state: seed.state, markdown: back.markdown, text: back.text, hash: markdownHash(title, back.markdown) } as SeededContent;
}

export function isSeedRefusal(r: SeededContent | SeedRefusal): r is SeedRefusal {
  return 'ok' in r;
}

function refusal(stage: SeedRefusal['stage'], f: { reason: SeedFailure | ConvertFailure; detail: string; message?: string }): SeedRefusal {
  return { ok: false, stage, reason: f.reason, detail: f.detail, ...(f.message !== undefined ? { message: f.message } : {}) };
}
