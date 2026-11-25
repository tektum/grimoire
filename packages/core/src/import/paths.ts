/** Entry paths and link targets of an import archive. Pure: no library, no file system. */

/** A scheme (`https:`, `mailto:`) or a drive letter (`C:`) at the start. */
const SCHEME_OR_DRIVE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The archive path a link points to, or undefined when it points at nothing inside the archive. `url` is the link as written in the Markdown of `fromPath`: it is split at a
 * query or fragment, percent-decoded once (so `%2e%2e/` is `../`, and `%252e` stays a name), joined to the folder of `fromPath` and normalised. A result that would leave the
 * archive root, a scheme (`https:`, `mailto:`), an absolute path, a drive letter, a backslash, a NUL, a malformed escape and an empty path all give undefined.
 *
 * The result is a key for looking up an entry of the archive, nothing else: it is never written into a page as a link. The import points an imported link at the page by its
 * internal id (`/p/<url_id>`) or at the attachment it made, and a link that resolves to nothing stays as it was and is judged like any external link.
 */
export function resolveLinkPath(url: string, fromPath: string): string | undefined {
  const bare = url.replace(/[?#].*$/s, '');
  if (bare === '' || SCHEME_OR_DRIVE.test(bare)) return undefined; // empty (a fragment-only link), a scheme, or a drive letter
  let decoded: string;
  try { decoded = decodeURIComponent(bare); } catch { return undefined; }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  // The page's own path is canonicalised like the link's segments (`.` and empty segments name nothing; the header check accepts them and the duplicate check merges them), and
  // an archive path is never a URL: a page whose own path starts like a scheme or a drive has no links.
  const folder = fromPath.split('/').slice(0, -1).filter((segment) => segment !== '' && segment !== '.');
  if (SCHEME_OR_DRIVE.test(folder[0] ?? fromPath.split('/').filter((segment) => segment !== '' && segment !== '.')[0] ?? '')) return undefined;
  const parts = [...folder];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (parts.pop() === undefined) return undefined; continue; }
    parts.push(segment);
  }
  // Joining can build what the raw link did not look like (`sub/../C:/x`, `a/../javascript:x`): the result is judged too, so no path that starts like a scheme or a drive comes
  // back, whatever way it was made (a root entry whose name has a colon cannot be linked to; below the root the colon is inside a name).
  const joined = parts.join('/').normalize('NFC');
  return parts.length === 0 || SCHEME_OR_DRIVE.test(joined) ? undefined : joined;
}
