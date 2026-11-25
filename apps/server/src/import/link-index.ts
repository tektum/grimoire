import type { IndexedItem, LinkIndex } from './profile.js';

/** An archive path as `resolveLinkPath` makes its targets: `.` and empty segments dropped, NFC, so an entry stored as `./a//b.md` is found by `a/b.md`. */
const canonicalPath = (path: string): string => path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/').normalize('NFC');

/**
 * The index a profile looks links up in: the items by their canonical path and, for a profile that reads an id from a name (`idOf`), by that id. The first item of an id keeps
 * it.
 */
export function buildLinkIndex(items: readonly IndexedItem[], idOf?: (path: string) => string | undefined): LinkIndex {
  const byPath = new Map<string, IndexedItem>();
  const byId = new Map<string, IndexedItem>();
  for (const item of items) {
    byPath.set(canonicalPath(item.path), item);
    const id = idOf?.(item.path);
    if (id !== undefined && !byId.has(id)) byId.set(id, item);
  }
  return { byPath, byId };
}
