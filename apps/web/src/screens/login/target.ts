/**
 * Where the browser goes after a sign-in: a path of this app, re-read through the URL parser with this page's origin. `?return=` has already been through
 * `safeReturn`; this is the second line, and it is the one that sees what a browser sees: a backslash counts as a slash there (`/\evil.example` is another host),
 * and so does a tab or a newline inside a scheme. Anything that does not resolve to this origin, or does not start with a single slash, goes to `/`.
 */
export function appTarget(path: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return `${origin}/`;
  }
  if (url.origin !== origin || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) return `${origin}/`;
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}
