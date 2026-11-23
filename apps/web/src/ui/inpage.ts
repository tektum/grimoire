/**
 * A link to `#id` on the page being shown. It keeps the current path and query so the link does not resolve against the document base,
 * and it collapses leading slashes: a pathname such as `//host` would otherwise make a protocol-relative URL that leaves the app.
 */
export function inPageHref(pathname: string, search: string, id: string): string {
  return `${pathname.replace(/^\/+/, '/')}${search}#${id}`;
}
