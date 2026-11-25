/** The sort values of the last row of a page, in the order of the query: rank, then the last edit in microseconds, then the page id. */
export interface SearchCursorKey {
  readonly rank: number;
  readonly editedAt: number;
  readonly id: string;
}

export class InvalidSearchCursor extends Error {
  constructor() {
    super('not a search cursor');
    this.name = 'InvalidSearchCursor';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_CHARS = 1024;

export function encodeSearchCursor(key: SearchCursorKey): string {
  return Buffer.from(JSON.stringify({ k: [key.rank, key.editedAt, key.id] }), 'utf8').toString('base64url');
}

/** The key in `cursor`, or `InvalidSearchCursor` for anything this module did not make: it is never half-trusted, since the parts become query parameters. */
export function decodeSearchCursor(cursor: string): SearchCursorKey {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS || !BASE64URL.test(cursor)) throw new InvalidSearchCursor();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidSearchCursor();
  }
  const keys = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 1 ? (parsed as { k?: unknown }).k : undefined;
  if (!Array.isArray(keys) || keys.length !== 3) throw new InvalidSearchCursor();
  const [rank, editedAt, id] = keys as unknown[];
  if (typeof rank !== 'number' || !Number.isFinite(Math.fround(rank)) || typeof editedAt !== 'number' || !Number.isSafeInteger(editedAt) || editedAt < 0 || typeof id !== 'string' || !UUID.test(id)) throw new InvalidSearchCursor();
  const key = { rank, editedAt, id };
  if (encodeSearchCursor(key) !== cursor) throw new InvalidSearchCursor();
  return key;
}

/**
 * The cursor of a hybrid answer (contracts section 15.5): the last row's fused score, edit time and id, under its own key so that it cannot be mistaken for the cursor of the full-text answer
 * (whose first number is a text rank, not a score). `decodeSearchCursor` refuses it, `decodeHybridCursor` refuses the other.
 */
export function encodeHybridCursor(key: SearchCursorKey): string {
  return Buffer.from(JSON.stringify({ h: [key.rank, key.editedAt, key.id] }), 'utf8').toString('base64url');
}

/** The key in a hybrid cursor, `undefined` for a cursor of the full-text answer, `InvalidSearchCursor` for anything this module did not make. */
export function decodeHybridCursor(cursor: string): SearchCursorKey | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS || !BASE64URL.test(cursor)) throw new InvalidSearchCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSearchCursor();
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && 'k' in parsed) {
    decodeSearchCursor(cursor); // one of ours, of the other kind (or invalid: it throws)
    return undefined;
  }
  const keys = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 1 ? (parsed as { h?: unknown }).h : undefined;
  if (!Array.isArray(keys) || keys.length !== 3) throw new InvalidSearchCursor();
  const [rank, editedAt, id] = keys as unknown[];
  if (typeof rank !== 'number' || !Number.isFinite(rank) || rank <= 0 || typeof editedAt !== 'number' || !Number.isSafeInteger(editedAt) || editedAt < 0 || typeof id !== 'string' || !UUID.test(id)) throw new InvalidSearchCursor();
  const key = { rank, editedAt, id };
  if (encodeHybridCursor(key) !== cursor) throw new InvalidSearchCursor();
  return key;
}
