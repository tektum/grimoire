import { z } from '@hono/zod-openapi';
import { fail } from './error.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const MAX_CURSOR_CHARS = 1024;

/** The query of a paginated list: `limit` 1 to 100 (default 50) and an opaque `cursor`. A value out of range is the validation failure, 422 `invalid`. */
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(MAX_CURSOR_CHARS).optional(),
});

/** The sort values of the last row of a page. Order by a timestamp and an id, for instance. */
export type CursorKey = string | number;

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }

/** A cursor is base64url of `{"l": <list>, "k": [<sort values>]}`; the list name makes a cursor from one list useless to another. */
export function encodeCursor(list: string, keys: readonly CursorKey[]): string {
  return Buffer.from(JSON.stringify({ l: list, k: keys }), 'utf8').toString('base64url');
}

/**
 * The sort values in `cursor` for the list `list` with `arity` values, or undefined when there is no cursor (the first page).
 * Anything else that is not exactly a cursor this list issued is 422 `invalid`.
 */
export function decodeCursor(list: string, cursor: string | undefined, arity: number): readonly CursorKey[] | undefined {
  if (cursor === undefined) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('invalid'); }
  const value = parsed as { l?: unknown; k?: unknown } | null;
  const keys = value?.k;
  const valid = typeof value === 'object' && value !== null && value.l === list && Array.isArray(keys) && keys.length === arity
    && keys.every((k) => typeof k === 'string' || (typeof k === 'number' && Number.isFinite(k)));
  if (!valid || Buffer.from(text, 'utf8').toString('base64url') !== cursor) return fail('invalid');
  return keys as readonly CursorKey[];
}

/**
 * Turns `limit + 1` rows (fetch one more than the page, keyset order) into a page: the extra row only says there is more, and the
 * cursor is built from the last row that is returned. `nextCursor` is null on the last page.
 */
export function toPage<T>(list: string, rows: readonly T[], limit: number, keyOf: (row: T) => readonly CursorKey[]): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(list, keyOf(last)) : null };
}
