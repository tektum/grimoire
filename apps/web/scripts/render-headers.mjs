// Renders the response headers of the web client from headers/headers.template and the origins of a deployment.
//   node scripts/render-headers.mjs --api-origin https://app.example.test --collab-origin wss://app.example.test --store-origin https://files.example.test [--descope-origin https://api.descope.com] [--fingerprint-connect "https://host https://host"] [--signin login-document|app-wide] [--out dist]
// Writes headers.json into --out (default: dist): { "/index.html": [header lines], "/login.html": [header lines] }, the lines each built document is served with, the app's and the sign-in screen's.
// There is no `_headers` file for a static host: such a host matches rules against the requested path, not the document it serves, and cannot give `/login` one policy and every other route
// another without sending both to `/login`. The client needs a server that sets headers per document: its own server does (see docs/web-security.md).
// Exits 1 with one plain line on a missing or malformed origin.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(here, '../headers/headers.template');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The sections of the template: `[headers]` as an object, and each `[policy <name>]` as one line of text. */
export function parseTemplate(text) {
  const sections = {};
  let name;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const heading = /^\[(.+)\]$/.exec(line);
    if (heading) { name = heading[1]; sections[name] = []; continue; }
    if (name === undefined) throw new Error('a line before the first [section] of the header template');
    sections[name].push(line);
  }
  const headers = {};
  for (const line of sections['headers'] ?? []) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const policies = Object.fromEntries(Object.entries(sections).filter(([key]) => key.startsWith('policy ')).map(([key, lines]) => [key.slice('policy '.length), lines.join(' ')]));
  return { headers, policies };
}

/**
 * The canonical origin of `value`, which must be exactly an origin: a secure scheme (`https:`, `wss:`), or the plain one (`http:`, `ws:`) for a loopback host only (local development),
 * with no user, path, query or fragment. An explicit default port is accepted (`https://host:443` is `https://host`). The result holds no space, semicolon or other character a policy gives meaning to.
 */
export function originOf(name, value, secure, plain) {
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  const schemes = secure === plain ? `${secure} scheme` : `${secure} scheme, or ${plain} for localhost only`;
  const fail = () => new Error(`${name} must be an origin (${schemes}; host and optional port, no path), not ${JSON.stringify(value)}`);
  if (!URL.canParse(value)) throw fail();
  const url = new URL(value);
  const allowed = url.protocol === secure || (url.protocol === plain && LOOPBACK.has(url.hostname));
  if (!allowed || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[\s;,]/.test(value)) throw fail();
  return url.origin;
}

/** The three files as text, or throws an Error with a plain message. */
export function renderHeaders({ template = readFileSync(TEMPLATE, 'utf8'), apiOrigin, collabOrigin, storeOrigin, descopeOrigin = 'https://api.descope.com', fingerprintConnect = '', signin = 'login-document' } = {}) {
  if (signin !== 'login-document' && signin !== 'app-wide') throw new Error(`--signin must be login-document or app-wide, not ${signin}`);
  const values = {
    API_ORIGIN: originOf('--api-origin', apiOrigin, 'https:', 'http:'),
    COLLAB_ORIGIN: originOf('--collab-origin', collabOrigin, 'wss:', 'ws:'),
    STORE_ORIGIN: originOf('--store-origin', storeOrigin, 'https:', 'http:'),
    DESCOPE_ORIGIN: originOf('--descope-origin', descopeOrigin, 'https:', 'https:'),
    FINGERPRINT_CONNECT: fingerprintConnect.split(/\s+/).filter(Boolean).map((host) => originOf('--fingerprint-connect', host, 'https:', 'https:')).join(' '),
  };
  const { headers, policies } = parseTemplate(template);
  const fill = (policy) => policy.replace(/\{\{([A-Z_]+)\}\}/g, (_all, key) => values[key] ?? `{{${key}}}`).replace(/\s+;/g, ';').replace(/ {2,}/g, ' ');
  const documents = { '/index.html': fill(policies[signin === 'app-wide' ? 'full' : 'app'] ?? ''), '/login.html': fill(policies['full'] ?? '') };
  for (const [document, policy] of Object.entries(documents)) {
    if (policy === '' || policy.includes('{{')) throw new Error(`the policy of ${document} is empty or has an unfilled placeholder`);
  }
  const lines = Object.fromEntries(Object.entries(documents).map(([document, policy]) => [document, [...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), `Content-Security-Policy: ${policy}`]]));
  return { headersJson: `${JSON.stringify(lines, null, 2)}\n` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'api-origin': { type: 'string' }, 'collab-origin': { type: 'string' }, 'store-origin': { type: 'string' }, 'descope-origin': { type: 'string' }, 'fingerprint-connect': { type: 'string' }, signin: { type: 'string' }, out: { type: 'string' } } });
    const rendered = renderHeaders({
      apiOrigin: values['api-origin'], collabOrigin: values['collab-origin'], storeOrigin: values['store-origin'],
      ...(values['descope-origin'] === undefined ? {} : { descopeOrigin: values['descope-origin'] }),
      ...(values['fingerprint-connect'] === undefined ? {} : { fingerprintConnect: values['fingerprint-connect'] }),
      ...(values.signin === undefined ? {} : { signin: values.signin }),
    });
    const out = path.resolve(values.out ?? path.resolve(here, '../dist'));
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'headers.json'), rendered.headersJson);
    process.stdout.write(`render-headers: wrote headers.json to ${out}\n`);
  } catch (error) {
    process.stderr.write(`render-headers: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
