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
  { path: '*', screen: 'notfound', who: 'anyone' },
];

/** The page's `urlId`: the text after the last `-` of the slug (a slug with no `-` is the id itself). */
export function urlIdOf(slug: string): string {
  return slug.slice(slug.lastIndexOf('-') + 1);
}

/** A `?return=` value is followed only if it is a path of this app: one leading `/`, no `\`, no scheme. Anything else gives `/`. */
export function safeReturn(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value) || /^\/[^/?#]*:/.test(value)) return '/';
  return value;
}
