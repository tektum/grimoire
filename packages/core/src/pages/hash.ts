import { createHash } from 'node:crypto';

/** The hash stored beside a page's Markdown: SHA-256 over the title, one NUL byte, then the Markdown (both UTF-8). */
export function markdownHash(title: string, markdown: string): Buffer {
  return createHash('sha256').update(title, 'utf8').update('\0').update(markdown, 'utf8').digest();
}
