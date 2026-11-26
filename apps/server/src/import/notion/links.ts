import { resolveLinkPath } from '@tektum/grimoire-core/import/paths';
import type { LinkIndex, Target } from '../profile.js';
import { idOf } from './names.js';

// constructed: [F§6]: the link forms are those the documentation shows (relative, percent-encoded, sometimes with spaces), not observed.

/**
 * constructed: [F§6] a link in the Markdown of `fromPath`, resolved to an item of the export, or undefined (the link stays as it is and is counted `unresolved_link`): decoded once and
 * joined to the folder of the file (never beyond the archive root), matched by the normalised path, then by the id of the page it names. The fragment is kept apart.
 */
export function resolveNotionLink(url: string, fromPath: string, index: LinkIndex): Target | undefined {
  const path = resolveLinkPath(url, fromPath);
  if (path === undefined) return undefined;
  const hash = url.indexOf('#');
  const fragment = hash === -1 ? undefined : url.slice(hash + 1);
  // A link to a database's `X <id>.csv` when the export holds only `X <id>_all.csv` (M7-T08: a real export has no plain CSV of a database).
  const allCsv = /\.csv$/i.test(path) && !/_all\.csv$/i.test(path) ? index.byPath.get(path.replace(/\.csv$/i, '_all.csv')) : undefined;
  const id = idOf(path);
  const found = index.byPath.get(path) ?? allCsv ?? (id === undefined ? undefined : index.byId.get(id));
  if (found === undefined) return undefined;
  return { kind: found.kind, itemId: found.itemId, ...(fragment === undefined || fragment === '' ? {} : { fragment }) };
}
