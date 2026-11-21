/*
 * Why this exists next to pino: the research (docs/research/12-reference-architectures.md, Part 3)
 * measured that pino's path-based `redact` misses keys nested deeper than its wildcards reach,
 * URL query strings, and connection strings inside messages, error messages and stacks.
 * This scrubber is applied to every value before it reaches pino. It fails closed: when a string
 * is ambiguous, more is removed, never less. It also flattens values pino cannot serialise safely
 * (getters, proxies, Map, Set, Date, Error, bigint, functions) into plain data.
 *
 * Recognised in free text: URLs with credentials (scheme://user:password@host, including PostgreSQL URLs), query strings and fragments,
 * key=value and "key": "value" pairs whose key looks secret, bearer and basic credentials, and JWTs. This is a best-effort safety net, not a
 * guarantee: the rule is that code never logs a secret, and named fields are redacted by name. Known limits (pinned by tests named
 * "known limit"): an unquoted value ends at a ; so a value containing one is cut there, and scheme-less credentials such as
 * user:secret@tcp(host:3306)/db are not recognised.
 */
export const REDACTED = '[redacted]';
export const UNSERIALISABLE = '[unserialisable]';
export const MAX_STRING_CHARS = 2048;
const MAX_DEPTH = 8;
const MAX_ITEMS = 200;
const MAX_NODES = 2000;
const TRUNCATED = '[truncated]';

// Fail-closed key rule. The key is normalised two ways. (1) Joined: lower case, letters only; it is
// secret when it CONTAINS a strong word (so `token2`, `tokenizer`, `secretary`, `sessionless` are
// redacted; accepted over-redaction). (2) Segments: split on any non-alphanumeric, camelCase and
// letter/digit boundaries; secret when a segment EQUALS a short word (so `key2`, `sort_key` are
// redacted but `keyboard`, `turkey`, `bypass`, `author` are not). `code` is deliberately absent:
// it would hide error codes. A key longer than MAX_KEY_CHARS is always treated as secret.
const STRONG_WORDS = [
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'jwt', 'bearer', 'authorization', 'cookie',
  'session', 'credential', 'signature', 'apikey', 'privatekey', 'accesskey', 'secretkey', 'signingkey',
  'encryptionkey', 'sshkey', 'connectionstring', 'databaseurl', 'dsn', 'csrf', 'xsrf', 'mnemonic',
];
const SHORT_WORDS = new Set([
  'pass', 'auth', 'sid', 'sig', 'otp', 'pin', 'salt', 'key', 'query', 'search', 'nonce', 'hmac', 'pem', 'seed', 'cert',
]);
export const MAX_KEY_CHARS = 256;
export function isSecretKey(key: string): boolean {
  if (key.length > MAX_KEY_CHARS) return true;
  const joined = key.toLowerCase().replace(/[^a-z]/g, '');
  if (STRONG_WORDS.some((w) => joined.includes(w))) return true;
  const spaced = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');
  return spaced.toLowerCase().split(/[^a-z0-9]+/).some((x) => SHORT_WORDS.has(x));
}

/** Text for a key: scrubbed, and cut (with a suffix) when over-long. */
function keyText(key: string): string {
  return key.length > MAX_KEY_CHARS
    ? `${redactString(key.slice(0, MAX_KEY_CHARS))}…[truncated ${key.length - MAX_KEY_CHARS} chars]`
    : redactString(key);
}

const isKeyChar = (c: string): boolean => /[\w-]/.test(c);

const isQuote = (c: string | undefined): boolean => c === '"' || c === "'";

/**
 * key=value / key: value, also with a quoted key ("password": "x", 'token' = 'x'), judged by the same rule as a structured field
 * (isSecretKey). The value of a secret-looking key runs to the closing quote when it is quoted, otherwise to the next ; or newline.
 * Linear.
 */
function cutKeyValues(s: string): string {
  let out = '';
  let pos = 0; // everything before pos is already emitted
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '=' && c !== ':') continue;
    let b = i;
    while (b > pos && s[b - 1] === ' ') b--;
    const closing = b > pos && isQuote(s[b - 1]) ? s[b - 1] : '';
    if (closing !== '') b--;
    let a = b;
    while (a > pos && isKeyChar(s[a - 1] ?? '')) a--;
    if (a === b || !isSecretKey(s.slice(a, b))) continue;
    let start = i + 1;
    while (start < s.length && s[start] === ' ') start++;
    const q = isQuote(s[start]) ? (s[start] ?? '') : '';
    let end = start;
    if (q !== '') {
      end = start + 1; // up to the next unescaped matching quote; none means the rest of the text
      while (end < s.length && s[end] !== q) end += s[end] === '\\' ? 2 : 1;
      end = Math.min(end + 1, s.length);
    } else {
      while (end < s.length && s[end] !== ';' && s[end] !== '\n') end++;
    }
    out += `${s.slice(pos, a)}${s.slice(a, b)}${closing}=${REDACTED}`;
    pos = end;
    i = end - 1;
  }
  return out + s.slice(pos);
}

/** Per whitespace-delimited token: cut at a fragment, or at a query (a URL's query to the end). */
function cutQueriesAndFragments(s: string): string {
  let out = '';
  let pos = 0;
  const re = /\S+/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    out += s.slice(pos, m.index);
    pos = re.lastIndex;
    const tok = m[0];
    const q = tok.indexOf('?');
    const h = tok.indexOf('#', 1);
    if (h > 0 && (q < 0 || h < q)) {
      out += `${tok.slice(0, h)}#${REDACTED}`;
    } else if (q >= 0) {
      out += `${tok.slice(0, q)}?${REDACTED}`;
      const scheme = tok.indexOf('://');
      if (scheme >= 0 && scheme < q) return out; // a URL's query may contain spaces: drop the rest
    } else {
      out += tok;
    }
  }
  return out + s.slice(pos);
}

/**
 * Removes userinfo, key=value secrets, bearer/basic credentials, JWTs, query strings, fragments.
 * Input is capped first; every step is a single linear pass.
 */
export function redactString(input: string): string {
  let s = input;
  let truncated = 0;
  if (s.length > MAX_STRING_CHARS) {
    truncated = s.length - MAX_STRING_CHARS;
    s = s.slice(0, MAX_STRING_CHARS);
    // the cut may fall inside a secret: drop the trailing partial token
    let e = s.length;
    while (e > 0 && !/\s/.test(s[e - 1] ?? '')) e--;
    s = s.slice(0, e);
  }
  // userinfo: from the first :// to the LAST @ (the password may contain @ / : ? # or spaces)
  const scheme = s.indexOf('://');
  const at = s.lastIndexOf('@');
  if (scheme >= 0 && at > scheme) s = `${s.slice(0, scheme + 3)}${REDACTED}${s.slice(at)}`;
  s = cutKeyValues(s);
  s = s.replace(/\b(bearer|basic)\s+[^\s;,]+/gi, `$1 ${REDACTED}`);
  // JWT-shaped: a run of word, dot and dash characters that contains eyJ and a dot
  s = s.replace(/[\w.-]+/g, (run) => (run.includes('eyJ') && run.includes('.') ? REDACTED : run));
  s = cutQueriesAndFragments(s);
  return truncated > 0 ? `${s}…[truncated ${truncated} chars]` : s;
}

interface Budget { nodes: number; readonly seen: WeakSet<object> }

function safeGet(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return UNSERIALISABLE;
  }
}

/** A placeholder for anything that carries binary data (Buffer, typed arrays, Blob, ...). */
function binaryPlaceholder(value: object): string | undefined {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (value instanceof Blob) return `[binary ${value.size} bytes]`;
  const o = value as Record<string, unknown>;
  if (typeof o['arrayBuffer'] === 'function' || typeof o['byteLength'] === 'number' || o['buffer'] instanceof ArrayBuffer || o['buffer'] instanceof SharedArrayBuffer) {
    const n = typeof o['byteLength'] === 'number' ? o['byteLength'] : o['size'];
    return `[binary ${typeof n === 'number' ? n : '?'} bytes]`;
  }
  return undefined;
}

/**
 * Map keys. Strings are kept (and scrubbed later). Primitives are written with their type so that
 * the number 1 and the string '1' stay distinct: `[number 1]`, `[boolean true]`, `[bigint 5]`.
 * Other keys become a placeholder numbered in order of appearance within the Map, so they never
 * overwrite each other: `[binary 24 bytes #1]`, `[non-string #2]`.
 */
function mapKey(k: unknown, counter: { n: number }): string {
  if (typeof k === 'string') return k;
  if (typeof k === 'number' || typeof k === 'boolean' || typeof k === 'bigint') return `[${typeof k} ${String(k)}]`;
  const label = typeof k === 'object' && k !== null ? (binaryPlaceholder(k) ?? '[non-string]') : '[non-string]';
  return `${label.slice(0, -1)} #${++counter.n}]`;
}

function scrub(value: unknown, depth: number, b: Budget): unknown {
  try {
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return UNSERIALISABLE;
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH || b.seen.has(value) || ++b.nodes > MAX_NODES) return TRUNCATED;
    b.seen.add(value);
    try {
      return scrubObject(value, depth, b);
    } finally {
      b.seen.delete(value); // only ancestors count as cycles; a shared reference is logged each time
    }
  } catch {
    return UNSERIALISABLE;
  }
}

function scrubObject(value: object, depth: number, b: Budget): unknown {
  const binary = binaryPlaceholder(value);
  if (binary !== undefined) return binary;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: scrub(value.name, depth + 1, b),
      message: scrub(value.message, depth + 1, b),
      stack: scrub(value.stack, depth + 1, b),
      cause: value.cause === undefined ? undefined : scrub(value.cause, depth + 1, b),
    };
  }
  if (Array.isArray(value) || value instanceof Set) {
    const items: unknown[] = [];
    const source: Iterable<unknown> =
      value instanceof Set
        ? value
        : Array.from({ length: Math.min(value.length, MAX_ITEMS + 1) }, (_, i) => safeGet(value, String(i)));
    let n = 0;
    for (const v of source) {
      if (++n > MAX_ITEMS) { items.push(TRUNCATED); break; }
      items.push(scrub(v, depth + 1, b));
    }
    return items;
  }
  const entries: [unknown, unknown][] = [];
  let total: number;
  if (value instanceof Map) {
    total = value.size;
    for (const kv of value) {
      if (entries.length >= MAX_ITEMS) break;
      entries.push(kv);
    }
  } else {
    const keys = Object.keys(value);
    total = keys.length;
    for (const k of keys.slice(0, MAX_ITEMS)) entries.push([k, safeGet(value, k)]);
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const counter = { n: 0 };
  for (const [rawKey, v] of entries) {
    const k = typeof rawKey === 'string' && !(value instanceof Map) ? rawKey : mapKey(rawKey, counter);
    out[keyText(k)] = isSecretKey(k) ? REDACTED : scrub(v, depth + 1, b);
  }
  if (total > MAX_ITEMS) out[TRUNCATED] = `${total - MAX_ITEMS} more`;
  return out;
}

/** Scrub a field bag; reserved output keys are dropped. Never throws. */
export function scrubFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = scrub(fields ?? {}, 0, { nodes: 0, seen: new WeakSet() });
  if (typeof out !== 'object' || out === null || Array.isArray(out)) return { fields: UNSERIALISABLE };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) if (k !== 'ts' && k !== 'level' && k !== 'event') clean[k] = v;
  return clean;
}
