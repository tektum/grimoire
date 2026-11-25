/** Entry paths and link targets of an import archive. Pure: no library, no file system. */

/** A scheme (`https:`, `mailto:`) or a drive letter (`C:`) at the start. */
const SCHEME_OR_DRIVE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** A drive letter: one letter and a colon. */
const DRIVE = /^[A-Za-z]:/;

/**
 * The archive path a link points to, or undefined when it points at nothing inside the archive. `url` is the link as written in the Markdown of `fromPath`: it is split at a
 * query or fragment, percent-decoded once (so `%2e%2e/` is `../`, and `%252e` stays a name), joined to the folder of `fromPath` and normalised. A result that would leave the
 * archive root, a scheme (`https:`, `mailto:`), an absolute path, a drive letter, a backslash, a NUL, a malformed escape and an empty path all give undefined.
 */
export function resolveLinkPath(url: string, fromPath: string): string | undefined {
  const bare = url.replace(/[?#].*$/s, '');
  if (bare === '' || SCHEME_OR_DRIVE.test(bare)) return undefined; // empty (a fragment-only link), a scheme, or a drive letter
  let decoded: string;
  try { decoded = decodeURIComponent(bare); } catch { return undefined; }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  // The page's own path is canonicalised like the link's segments: `.` and empty segments name nothing (the header check accepts them and the duplicate check merges them).
  const folder = fromPath.split('/').slice(0, -1).filter((segment) => segment !== '' && segment !== '.');
  const parts = [...folder];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (parts.pop() === undefined) return undefined; continue; }
    parts.push(segment);
  }
  const joined = parts.join('/').normalize('NFC');
  // Joining can build what the raw link did not look like (`sub/../C:/x`, `a/../javascript:x`): the result is judged too. A link that starts with `./` or `../` names an entry,
  // whatever its name holds, so only a drive is refused there (`./notes:2026.md` is a file called notes:2026.md).
  const first = decoded.split('/')[0];
  const explicitlyRelative = first === '.' || first === '..';
  return parts.length === 0 || DRIVE.test(joined) || (!explicitlyRelative && SCHEME_OR_DRIVE.test(joined)) ? undefined : joined;
}
