// The model's tokenizer, loaded by the model's thread (`worker.ts`) and nowhere else: it is 160 MB of live objects, and on the server's own heap every full GC of them stops the event loop. The thread
// counts for the chunker and tokenizes each embedding call. A shell, proved by the container tests with the real tokenizer file.
import { readFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';

export interface TokenCounter {
  /** The tokens of `text` as the model counts them, the special tokens the tokenizer adds left out; 0 for an empty text. */
  count(text: string): number;
  /** The ids of `text` with the special tokens the model expects (what is sent to the model). */
  encode(text: string): readonly number[];
}

export function loadTokenCounter(file: string): TokenCounter {
  const tokenizer = new Tokenizer(JSON.parse(readFileSync(file, 'utf8')) as object, {});
  const specials = tokenizer.encode('').ids.length;
  return { count: (text) => (text === '' ? 0 : Math.max(0, tokenizer.encode(text).ids.length - specials)), encode: (text) => tokenizer.encode(text).ids };
}
