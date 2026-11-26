import type { IndexedItem, LinkIndex } from './profile.js';

/** An archive path as `resolveLinkPath` makes its targets: `.` and empty segments dropped, NFC, so an entry stored as `./a//b.md` is found by `a/b.md`. */
const canonicalPath = (path: string): string => path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/').normalize('NFC');

/**
 * The index a profile looks links up in: the items by their canonical path and, for a profile that reads an id from a name (`idOf`), by that id. Of the items of one id, the one
 * whose path sorts first keeps it, whatever the order of the items: `X <id>.csv` sorts before `X <id>_all.csv`, so a Notion link falls back by the id as it does by the path, to
 * the plain one when it is there.
 */
export function buildLinkIndex(items: readonly IndexedItem[], idOf?: (path: string) => string | undefined): LinkIndex {
  const byPath = new Map<string, IndexedItem>();
  const byId = new Map<string, IndexedItem>();
  for (const item of items) {
    const path = canonicalPath(item.path);
    byPath.set(path, item);
    const id = idOf?.(item.path);
    const held = id === undefined ? undefined : byId.get(id);
    if (id !== undefined && (held === undefined || path < canonicalPath(held.path))) byId.set(id, item);
  }
  return { byPath, byId };
}
