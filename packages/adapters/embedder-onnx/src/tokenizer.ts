// Counts tokens on the main thread, with the model's own tokenizer: the chunker asks for every paragraph, synchronously. A shell, proved by the container tests with the real tokenizer file.
import { readFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';

export interface TokenCounter {
  /** The tokens of `text` as the model counts them, the special tokens the tokenizer adds left out; 0 for an empty text. */
  count(text: string): number;
}

export function loadTokenCounter(file: string): TokenCounter {
  const tokenizer = new Tokenizer(JSON.parse(readFileSync(file, 'utf8')) as object, {});
  const specials = tokenizer.encode('').ids.length;
  return { count: (text) => (text === '' ? 0 : Math.max(0, tokenizer.encode(text).ids.length - specials)) };
}
