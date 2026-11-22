/**
 * Port: turns a page's live editing state into canonical Markdown and plain search text, and Markdown into editing
 * state. Bytes and strings only: no Yjs, Milkdown or ProseMirror type crosses this boundary.
 * Every method resolves; none rejects, whatever the input.
 */
/**
 * A failure carries a stable `reason` (callers branch on it) and a `detail` (for logs and for callers that tell "busy" from "broken": for the pool's
 * own refusals it is a stable code such as `one-at-a-time`, `no-key`, `queue-full`, `closed`). `message`, when present, is a plain sentence a person
 * can be shown; the pool sets it on every refusal it makes itself. Neither field ever holds page content.
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
  | { ok: false; reason: ConvertFailure; detail: string; message?: string };

export type SeedFailure = 'invalid-markdown' | 'too-large' | 'timeout' | 'out-of-memory' | 'internal';

export type SeedResult = { ok: true; state: Uint8Array } | { ok: false; reason: SeedFailure; detail: string; message?: string };

export interface MarkdownConverter {
  /** Yjs update bytes in; Markdown and search text out, or a typed failure. Never throws. */
  toMarkdown(state: Uint8Array): Promise<ConvertResult>;
  /**
   * Markdown in; Yjs update bytes out. Never throws.
   *
   * `key` is required, with no default: the caller on whose behalf the conversion runs. It is the user when there is one, and the
   * page for system-initiated seeds. An opaque, non-empty string, never page text. An implementation that isolates callers runs at
   * most one seed per key at a time and answers a second one at once with
   * `{ ok: false, reason: 'internal', detail: 'one-at-a-time' }`.
   *
   * NOTE, NOT YET MET: the planned HTTP API (create and import) MUST pass the signed-in user's id here, so that one user cannot
   * occupy more than one worker. Today only the collaboration host calls this, with the page id, which isolates nothing between users.
   */
  seed(markdown: string, key: string): Promise<SeedResult>;
  /**
   * Rebuild a page's editor state from Markdown that OUR OWN serialiser stored (a system-initiated rebuild: the host opening a page that has
   * Markdown and no state, the planned state reset). Never for Markdown a person or an importer supplied: that goes through `seed`.
   * It has its own limits, up to the stored-Markdown cap (1 MiB) with no line cap, and a longer time limit; `key` is the page's id.
   *
   * REQUIREMENT (spec R7.13): the create and import paths must NEVER leave user-supplied Markdown in a row without state (it would be rebuilt here with
   * these lenient limits): they call `seed` and store the state.
   *
   * INVARIANT: anything the save direction (`toMarkdown`) stores can be rebuilt by `reseed` (tests: save-then-reseed property test).
   */
  reseed(markdown: string, key: string): Promise<SeedResult>;
  /** Idempotent. Later calls return `{ ok: false, reason: 'internal', detail: 'closed' }`. */
  close(): Promise<void>;
}
