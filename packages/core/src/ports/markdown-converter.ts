/**
 * Port: turns a page's live editing state into canonical Markdown and plain search text, and Markdown into editing
 * state. Bytes and strings only: no Yjs, Milkdown or ProseMirror type crosses this boundary (M2 contracts, section 3).
 * Every method resolves; none rejects, whatever the input.
 */
export type ConvertFailure =
  | 'invalid-state'
  | 'too-large'
  | 'too-deep'
  | 'content-lost'
  | 'timeout'
  | 'out-of-memory'
  | 'internal';

export type ConvertResult =
  | { ok: true; markdown: string; text: string }
  | { ok: false; reason: ConvertFailure; detail: string };

export type SeedFailure = 'invalid-markdown' | 'too-large' | 'timeout' | 'out-of-memory' | 'internal';

export type SeedResult = { ok: true; state: Uint8Array } | { ok: false; reason: SeedFailure; detail: string };

export interface MarkdownConverter {
  /** Yjs update bytes in; Markdown and search text out, or a typed failure. Never throws. */
  toMarkdown(state: Uint8Array): Promise<ConvertResult>;
  /** Markdown in; Yjs update bytes out. Never throws. */
  seed(markdown: string): Promise<SeedResult>;
  /** Idempotent. Later calls return `{ ok: false, reason: 'internal', detail: 'closed' }`. */
  close(): Promise<void>;
}
