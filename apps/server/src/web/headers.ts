/**
 * The response headers of the web client, made from the template the build ships (`apps/web/headers/headers.template`) and the origins of this deployment, at start.
 * `apps/web/scripts/render-headers.mjs` does the same for a static host; a test checks that both give the same lines.
 */
export interface Origins {
  readonly apiOrigin: string;
  readonly collabOrigin: string;
  readonly storeOrigin: string;
}
export type Signin = 'login-document' | 'app-wide';
export type DocumentPath = '/index.html' | '/login.html';

const originOf = (name: string, value: string, schemes: readonly string[]): string => {
  if (!URL.canParse(value)) throw new Error(`${name} must be an origin such as ${schemes[0] ?? ''}//host`);
  const url = new URL(value);
  if (!schemes.includes(url.protocol)) throw new Error(`${name} must use ${schemes.join(' or ')}`);
  return url.origin;
};

/** `https://host/x` as `https://host`, and `http`/`https` public addresses as the `ws`/`wss` origin of the same host. */
export function webOrigins(input: { readonly apiUrl: string; readonly collabUrl: string; readonly storeOrigin: string }): Origins {
  const collab = new URL(input.collabUrl);
  const scheme = collab.protocol === 'https:' ? 'wss:' : collab.protocol === 'http:' ? 'ws:' : collab.protocol;
  return {
    apiOrigin: originOf('the public API address', input.apiUrl, ['https:', 'http:']),
    collabOrigin: originOf('the public live editing address', `${scheme}//${collab.host}`, ['wss:', 'ws:']),
    storeOrigin: originOf('the file store address', input.storeOrigin, ['https:', 'http:']),
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
  const values: Record<string, string> = { API_ORIGIN: origins.apiOrigin, COLLAB_ORIGIN: origins.collabOrigin, STORE_ORIGIN: origins.storeOrigin, FINGERPRINT_CONNECT: '' };
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
