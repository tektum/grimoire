// Renders the response headers of the web client from headers/headers.template and the origins of a deployment.
//   node scripts/render-headers.mjs --api-origin https://api.example.test --collab-origin wss://api.example.test --store-origin https://files.example.test [--signin login-document|app-wide] [--out dist]
// Writes three files into --out (default: dist):
//   headers       the format of a `_headers` file: one block per built document, `/index.html` (the app) and `/login.html` (the sign-in screen)
//   headers.json  { "/index.html": [header lines], "/login.html": [header lines] }: the same lines, for a server that sets them itself
//   redirects     `/login` is the sign-in document and every other path is the app
// Exits 1 with one plain line on a missing or malformed origin.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(here, '../headers/headers.template');

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

const origin = (name, value, schemes) => {
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  if (!URL.canParse(value)) throw new Error(`${name} must be an origin such as ${schemes[0]}//host`);
  const url = new URL(value);
  if (!schemes.includes(url.protocol) || url.origin !== value.replace(/\/$/, '') || url.username !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${name} must be an origin (${schemes.join(' or ')} scheme, host and optional port, no path), not ${value}`);
  }
  return url.origin;
};

/** The three files as text, or throws an Error with a plain message. */
export function renderHeaders({ template = readFileSync(TEMPLATE, 'utf8'), apiOrigin, collabOrigin, storeOrigin, fingerprintConnect = '', signin = 'login-document' } = {}) {
  if (signin !== 'login-document' && signin !== 'app-wide') throw new Error(`--signin must be login-document or app-wide, not ${signin}`);
  const values = {
    API_ORIGIN: origin('--api-origin', apiOrigin, ['https:', 'http:']),
    COLLAB_ORIGIN: origin('--collab-origin', collabOrigin, ['wss:', 'ws:']),
    STORE_ORIGIN: origin('--store-origin', storeOrigin, ['https:', 'http:']),
    FINGERPRINT_CONNECT: fingerprintConnect,
  };
  const { headers, policies } = parseTemplate(template);
  const fill = (policy) => policy.replace(/\{\{([A-Z_]+)\}\}/g, (_all, key) => values[key] ?? `{{${key}}}`).replace(/\s+;/g, ';').replace(/ {2,}/g, ' ');
  const documents = { '/index.html': fill(policies[signin === 'app-wide' ? 'full' : 'app'] ?? ''), '/login.html': fill(policies['full'] ?? '') };
  for (const [document, policy] of Object.entries(documents)) {
    if (policy === '' || policy.includes('{{')) throw new Error(`the policy of ${document} is empty or has an unfilled placeholder`);
  }
  const lines = Object.fromEntries(Object.entries(documents).map(([document, policy]) => [document, [...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), `Content-Security-Policy: ${policy}`]]));
  const file = Object.entries(lines).map(([document, block]) => `${document}\n${block.map((l) => `  ${l}`).join('\n')}\n`).join('\n');
  return { headers: file, headersJson: `${JSON.stringify(lines, null, 2)}\n`, redirects: '/login /login.html 200\n/* /index.html 200\n' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'api-origin': { type: 'string' }, 'collab-origin': { type: 'string' }, 'store-origin': { type: 'string' }, 'fingerprint-connect': { type: 'string' }, signin: { type: 'string' }, out: { type: 'string' } } });
    const rendered = renderHeaders({
      apiOrigin: values['api-origin'], collabOrigin: values['collab-origin'], storeOrigin: values['store-origin'],
      ...(values['fingerprint-connect'] === undefined ? {} : { fingerprintConnect: values['fingerprint-connect'] }),
      ...(values.signin === undefined ? {} : { signin: values.signin }),
    });
    const out = path.resolve(values.out ?? path.resolve(here, '../dist'));
    mkdirSync(out, { recursive: true });
    for (const [name, text] of [['headers', rendered.headers], ['headers.json', rendered.headersJson], ['redirects', rendered.redirects]]) writeFileSync(path.join(out, name), text);
    process.stdout.write(`render-headers: wrote headers, headers.json and redirects to ${out}\n`);
  } catch (error) {
    process.stderr.write(`render-headers: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
