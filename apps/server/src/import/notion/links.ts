import { resolveLinkPath } from '@tektum/grimoire-core/import/paths';
import { splitName } from './names.js';

// constructed: [F§6]: the link forms are those the documentation shows (relative, percent-encoded, sometimes with spaces), not observed.

export interface IndexedItem { readonly itemId: string; readonly path: string; readonly kind: 'page' | 'attachment' }
export interface NotionIndex {
  readonly byPath: ReadonlyMap<string, IndexedItem>;
  /** constructed: [F§6] by the 32-character id in the last segment of the path, for what the path does not find. */
  readonly byId: ReadonlyMap<string, IndexedItem>;
}
export interface Target { readonly kind: 'page' | 'attachment'; readonly itemId: string; readonly fragment?: string }

export function buildIndex(items: readonly IndexedItem[]): NotionIndex {
  const byPath = new Map<string, IndexedItem>();
  const byId = new Map<string, IndexedItem>();
  for (const item of items) {
    const key = item.path.normalize('NFC');
    byPath.set(key, item);
    const id = splitName(item.path.split('/').at(-1) ?? '').id;
    if (id !== undefined && !byId.has(id)) byId.set(id, item);
  }
  return { byPath, byId };
}

/**
 * constructed: [F§6] a link in the Markdown of `fromPath`, resolved to an item of the export, or undefined (the link stays as it is and is counted `unresolved_link`): decoded once and
 * joined to the folder of the file (never beyond the archive root), matched by the normalised path, then by the id of the page it names. The fragment is kept apart.
 */
export function resolveNotionLink(url: string, fromPath: string, index: NotionIndex): Target | undefined {
  const path = resolveLinkPath(url, fromPath);
  if (path === undefined) return undefined;
  const hash = url.indexOf('#');
  const fragment = hash === -1 ? undefined : url.slice(hash + 1);
  const found = index.byPath.get(path) ?? (() => {
    const id = splitName(path.split('/').at(-1) ?? '').id;
    return id === undefined ? undefined : index.byId.get(id);
  })();
  if (found === undefined) return undefined;
  return { kind: found.kind, itemId: found.itemId, ...(fragment === undefined || fragment === '' ? {} : { fragment }) };
}
