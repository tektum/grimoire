// Serves the built client (apps/web/dist) on port 4173 for tests and the exit test, with the headers of render-headers.mjs applied (see createServer).
// Unknown paths get index.html, so a deep link such as /p/some-page-ab12cd loads the app (the router takes it from there).
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { parseTemplate } from './render-headers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

/**
 * Serves the built client. Headers: with a headers directory (the output of render-headers.mjs, which holds headers.json) every document gets the lines of its own block, the
 * app's for `index.html` and the sign-in screen's for `login.html`; without one, only the plain headers of the template (no content security policy) are set.
 */
export function createServer({ dist = path.join(webRoot, 'dist'), headersDir } = {}) {
  const plain = Object.entries(parseTemplate(readFileSync(path.join(webRoot, 'headers/headers.template'), 'utf8')).headers).map(([name, value]) => `${name}: ${value}`);
  const rendered = headersDir !== undefined && existsSync(path.join(headersDir, 'headers.json')) ? JSON.parse(readFileSync(path.join(headersDir, 'headers.json'), 'utf8')) : undefined;
  if (headersDir !== undefined && rendered === undefined) throw new Error(`no headers.json in ${headersDir}: run scripts/render-headers.mjs first`);
  for (const document of rendered === undefined ? [] : ['/index.html', '/login.html']) {
    const lines = rendered[document];
    // A partial file would serve a document with no policy while the headers are reported as configured.
    if (!Array.isArray(lines) || lines.length === 0 || !lines.every((l) => typeof l === 'string' && l.includes(':')) || !lines.some((l) => l.startsWith('Content-Security-Policy:'))) {
      throw new Error(`headers.json in ${headersDir} has no usable header lines, with a content security policy, for ${document}`);
    }
  }
  const set = (res, document) => {
    for (const line of rendered?.[document] ?? plain) {
      const colon = line.indexOf(':');
      res.setHeader(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  };
  const files = sirv(dist, {
    single: true,
    dev: true,
    setHeaders(res, pathname) {
      set(res, pathname === '/login.html' ? '/login.html' : '/index.html');
    },
  });
  return http.createServer((req, res) => {
    // The sign-in screen is its own document: `/login` is served as login.html.
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/login') req.url = `/login.html${url.search}`;
    files(req, res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const options = {};
  if (process.env.GRIMOIRE_WEB_DIST) options.dist = path.resolve(process.env.GRIMOIRE_WEB_DIST);
  if (process.env.GRIMOIRE_WEB_HEADERS_DIR) options.headersDir = path.resolve(process.env.GRIMOIRE_WEB_HEADERS_DIR);
  createServer(options).listen(port, () => process.stdout.write(`serving on http://localhost:${port}\n`));
}
