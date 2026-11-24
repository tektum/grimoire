/**
 * The response headers of the web client, made from the template the build ships (`apps/web/headers/headers.template`) and the origins of this deployment, at start.
 * `apps/web/scripts/render-headers.mjs` does the same for a static host; a test checks that both give the same lines.
 */
export interface Origins {
  readonly apiOrigin: string;
  readonly collabOrigin: string;
  readonly storeOrigin: string;
  /** The identity provider's API: `https://api.descope.com`, or the regional one a project is bound to. */
  readonly descopeOrigin: string;
}
export type Signin = 'login-document' | 'app-wide';
export type DocumentPath = '/index.html' | '/login.html';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The canonical origin of an address that must be exactly one: a secure scheme, or the plain one for a loopback host only (local development), with no user, path,
 * query or fragment. Same rule as `apps/web/scripts/render-headers.mjs`, whose output a test compares with this module's.
 */
function originOf(name: string, value: string, secure: string, plain: string): string {
  const schemes = secure === plain ? `${secure} scheme` : `${secure} scheme, or ${plain} for localhost only`;
  const fail = (): Error => new Error(`${name} must be an origin (${schemes}; host and optional port, no path)`);
  if (!URL.canParse(value)) throw fail();
  const url = new URL(value);
  if (!(url.protocol === secure || (url.protocol === plain && LOOPBACK.has(url.hostname))) || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[\s;,]/.test(value)) throw fail();
  return url.origin;
}

/** The origin of a public address, which may carry a path (`/collab`): only the origin counts. An address with a user, or that does not parse, is passed on for the origin check to refuse. */
const originOnly = (url: string): string => (URL.canParse(url) && new URL(url).username === '' && new URL(url).password === '' ? new URL(url).origin : url);

/** The public addresses of a deployment as the origins of the policy: a `http(s)` live editing address becomes the `ws(s)` origin of the same host. */
export function webOrigins(input: { readonly apiUrl: string; readonly collabUrl: string; readonly storeOrigin: string; readonly descopeUrl?: string | undefined }): Origins {
  const collab = URL.canParse(input.collabUrl) ? new URL(input.collabUrl) : undefined;
  const scheme = collab?.protocol === 'https:' ? 'wss:' : collab?.protocol === 'http:' ? 'ws:' : collab?.protocol ?? 'ws:';
  return {
    apiOrigin: originOf('the public API address', originOnly(input.apiUrl), 'https:', 'http:'),
    collabOrigin: originOf('the public live editing address', collab === undefined ? input.collabUrl : `${scheme}//${collab.host}`, 'wss:', 'ws:'),
    storeOrigin: originOf('the file store address', originOnly(input.storeOrigin), 'https:', 'http:'),
    descopeOrigin: originOf('the identity provider address', originOnly(input.descopeUrl ?? 'https://api.descope.com'), 'https:', 'https:'),
  };
}

/** Header lines of each built document: the plain headers of the template and the content security policy of that document. */
export function renderDocumentHeaders(template: string, origins: Origins, signin: Signin = 'login-document'): Readonly<Record<DocumentPath, readonly string[]>> {
  const sections: Record<string, string[]> = {};
  let name: string | undefined;
  for (const raw of template.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const heading = /^\[(.+)\]$/.exec(line);
    if (heading?.[1] !== undefined) { name = heading[1]; sections[name] = []; continue; }
    if (name === undefined) throw new Error('a line before the first [section] of the header template');
    sections[name]?.push(line);
  }
  const values: Record<string, string> = { API_ORIGIN: origins.apiOrigin, COLLAB_ORIGIN: origins.collabOrigin, STORE_ORIGIN: origins.storeOrigin, DESCOPE_ORIGIN: origins.descopeOrigin, FINGERPRINT_CONNECT: '' };
  const policy = (key: string): string => {
    const text = (sections[`policy ${key}`] ?? []).join(' ').replace(/\{\{([A-Z_]+)\}\}/g, (_all, k: string) => values[k] ?? `{{${k}}}`).replace(/\s+;/g, ';').replace(/ {2,}/g, ' ');
    if (text === '' || text.includes('{{')) throw new Error(`the policy ${key} of the header template is empty or has an unfilled placeholder`);
    return text;
  };
  const plain = (sections['headers'] ?? []);
  return {
    '/index.html': [...plain, `Content-Security-Policy: ${policy(signin === 'app-wide' ? 'full' : 'app')}`],
    '/login.html': [...plain, `Content-Security-Policy: ${policy('full')}`],
  };
}
