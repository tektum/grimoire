// Serves the built client (apps/web/dist) on port 4173 for tests and the exit test, with the headers of the rendered header file applied.
// Unknown paths get index.html, so a deep link such as /p/some-page-ab12cd loads the app (the router takes it from there).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

/** Header lines of a `_headers` file: a path line, then indented `Name: value` lines. Returns the headers of the `/*` block. */
export function parseHeaders(text) {
  const headers = {};
  let applies = false;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      applies = raw.trim() === '/*';
      continue;
    }
    const colon = raw.indexOf(':');
    if (applies && colon > 0) headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return headers;
}

export function createServer({ dist = path.join(webRoot, 'dist'), headersFile = path.join(webRoot, 'headers/headers.template') } = {}) {
  const headers = parseHeaders(readFileSync(headersFile, 'utf8'));
  const files = sirv(dist, {
    single: true,
    dev: true,
    setHeaders(res) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    },
  });
  return http.createServer((req, res) => files(req, res));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const options = {};
  if (process.env.GRIMOIRE_WEB_DIST) options.dist = path.resolve(process.env.GRIMOIRE_WEB_DIST);
  if (process.env.GRIMOIRE_WEB_HEADERS) options.headersFile = path.resolve(process.env.GRIMOIRE_WEB_HEADERS);
  createServer(options).listen(port, () => process.stdout.write(`serving on http://localhost:${port}\n`));
}
