export interface RouteSpec {
  readonly path: string;
  readonly screen: string;
  readonly who: 'anyone' | 'signed-in' | 'read' | 'writers' | 'admin';
}

/** The route table (contracts section 3). `/` redirects to the last or first collection. */
export const ROUTES: readonly RouteSpec[] = [
  { path: '/login', screen: 'login', who: 'anyone' },
  { path: '/c/:collectionId', screen: 'collections', who: 'read' },
  { path: '/p/:slug', screen: 'page', who: 'read' },
  { path: '/p/:slug/history', screen: 'history', who: 'read' },
  { path: '/p/:slug/history/:revisionId', screen: 'history', who: 'read' },
  { path: '/search', screen: 'search', who: 'signed-in' },
  { path: '/trash', screen: 'trash', who: 'signed-in' },
  { path: '/import', screen: 'import', who: 'writers' },
  { path: '/admin/users', screen: 'admin', who: 'admin' },
  { path: '/admin/groups', screen: 'admin', who: 'admin' },
  { path: '/admin/collections/:id/access', screen: 'admin', who: 'admin' },
  { path: '/help', screen: 'help', who: 'signed-in' },
  { path: '*', screen: 'notfound', who: 'anyone' },
];

/** The page's `urlId`: the text after the last `-` of the slug (a slug with no `-` is the id itself). */
export function urlIdOf(slug: string): string {
  return slug.slice(slug.lastIndexOf('-') + 1);
}

/**
 * What makes the main area a new screen: the address, except that the slug of a page's address stands for its id. A page that is renamed (its address follows its title) is the same screen, and must not
 * be rebuilt (the editor and its connection would restart for a name); the page and its history are different screens, as are two pages.
 */
export function screenKey(pathname: string): string {
  const page = /^\/p\/([^/]+)(\/.*)?$/.exec(pathname);
  return page === null ? pathname : `/p/${urlIdOf(page[1]!)}${page[2] ?? ''}`;
}

/** A `?return=` value is followed only if it is a path of this app: one leading `/`, no `\`, no scheme. Anything else gives `/`. */
export function safeReturn(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value) || /^\/[^/?#]*:/.test(value)) return '/';
  return value;
}
