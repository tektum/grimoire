import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { renderDocumentHeaders, webOrigins } from './headers.js';
import type { DocumentPath } from './headers.js';

export interface WebClientOptions {
  /** The folder of the build: `dist/` (index.html, login.html, assets/), and `headers.template` beside it. */
  readonly root: string;
  readonly apiUrl: string;
  readonly collabUrl: string;
  readonly storeOrigin: string;
}

/** Paths the API owns: the web client never answers them, whatever the method. */
const API = /^\/(?:v1(?:\/|$)|healthz$|readyz$)/;
export const isApiPath = (pathname: string): boolean => API.test(pathname);

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves the built web client from this process, last in the chain (after the API and the health routes), for GET and HEAD only:
 * `/config.json` is made from the public address of the API (the build ships none that suits a deployment); `/login` is the sign-in document; a file of the build is served as it
 * is (hashed assets for a year, everything else revalidated); any other path without a file extension is the app (its router takes it from there); a missing file is a 404 and never the app.
 * Every document carries its own response headers, which the process sets itself (a static host would read them from a file). A refused path or method falls through.
 */
export function webClient(options: WebClientOptions): { readonly middleware: MiddlewareHandler; readonly serves: (pathname: string) => boolean } {
  const dist = path.resolve(options.root, 'dist');
  const templatePath = path.resolve(options.root, 'headers.template');
  for (const file of [path.join(dist, 'index.html'), path.join(dist, 'login.html'), templatePath]) {
    if (!existsSync(file)) throw new Error(`the web client is incomplete: ${file} is missing (GRIMOIRE_WEB_ROOT)`);
  }
  const headers = renderDocumentHeaders(readFileSync(templatePath, 'utf8'), webOrigins({ apiUrl: options.apiUrl, collabUrl: options.collabUrl, storeOrigin: options.storeOrigin }));
  const config = `${JSON.stringify({ apiUrl: new URL(options.apiUrl).origin })}\n`;
  const apply = (c: Context, document: DocumentPath | undefined, cache: string): void => {
    for (const line of document === undefined ? headers['/index.html'].filter((l) => !l.startsWith('Content-Security-Policy')) : headers[document]) {
      const colon = line.indexOf(':');
      c.header(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    c.header('Cache-Control', cache);
  };
  const document = (name: DocumentPath): MiddlewareHandler => async (c) => {
    const html = readFileSync(path.join(dist, name));
    apply(c, name, 'no-cache');
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.req.method === 'HEAD' ? c.body(null) : c.body(new Uint8Array(html));
  };
  const app = document('/index.html');
  const login = document('/login.html');
  const files = serveStatic({ root: path.relative(process.cwd(), dist) || '.' });
  const hashed = (pathname: string): boolean => /^\/assets\/.+-[\w-]{8,}\.[a-z0-9]+$/i.test(pathname);
  const hasExtension = (pathname: string): boolean => path.posix.extname(pathname) !== '';
  const serves = (pathname: string): boolean => !isApiPath(pathname);

  const middleware: MiddlewareHandler = async (c, next) => {
    const pathname = c.req.path;
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || isApiPath(pathname) || pathname.includes('\0') || pathname.includes('\\')) return next();
    if (pathname === '/config.json') {
      apply(c, undefined, 'no-store');
      c.header('Content-Type', 'application/json; charset=utf-8');
      return c.req.method === 'HEAD' ? c.body(null) : c.body(config);
    }
    if (pathname === '/login' || pathname === '/login.html') return login(c, next);
    if (pathname === '/' || pathname === '/index.html') return app(c, next);
    if (hasExtension(pathname)) {
      const target = path.join(dist, decodeURIComponent(pathname));
      if (!target.startsWith(`${dist}${path.sep}`) || !existsSync(target) || !statSync(target).isFile()) return next(); // outside the build or missing: the API's 404
      apply(c, undefined, hashed(pathname) ? IMMUTABLE : 'no-cache'); // before the body exists: the static handler builds its response first and cannot be given headers after it
      return files(c, next);
    }
    return app(c, next); // a route of the app
  };
  return { middleware, serves };
}
