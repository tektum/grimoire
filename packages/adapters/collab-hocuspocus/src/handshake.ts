import { Refusal } from './refusal.js';

/** The longest handshake token accepted; the same figure as the session-token policy's cap. */
export const MAX_HANDSHAKE_LENGTH = 8192;
const PREFIX = 'g1.';
const TRIPLE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const MAX_EPOCH = 2147483647;

/** What the connect-time token carries: the session token, and the client's version and recorded state epoch when it sent a wrapper. */
export interface Handshake {
  readonly token: string;
  readonly version?: readonly [number, number, number];
  readonly epoch?: number;
  /** True when the client sent the `g1.` wrapper, false for a bare session token. */
  readonly wrapped: boolean;
}

const invalid = (): Refusal => new Refusal('invalid-token');

/** `major.minor.patch` as numbers, or undefined when the text is not a dotted triple. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = TRIPLE.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative when `a` is older than `b`. */
export function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Step 1 and 2 of the connect-time handshake (R4.32): no database, no verifier. Throws `invalid-token` for a string that is too long or a
 * malformed wrapper, `client-too-old` for a bare token when the handshake is required or a version below `minClientVersion`.
 */
export function readHandshake(raw: unknown, options: { readonly requireHandshake: boolean; readonly minClientVersion: string }): Handshake {
  if (typeof raw !== 'string' || raw.length > MAX_HANDSHAKE_LENGTH) throw invalid();
  let h: Handshake;
  if (!raw.startsWith(PREFIX)) {
    if (options.requireHandshake) throw new Refusal('client-too-old');
    h = { token: raw, wrapped: false };
  } else {
    h = decode(raw.slice(PREFIX.length));
  }
  const min = parseVersion(options.minClientVersion);
  if (h.version !== undefined && min !== undefined && compareVersions(h.version, min) < 0) throw new Refusal('client-too-old');
  return h;
}

function decode(body: string): Handshake {
  if (!BASE64URL.test(body) || body.length % 4 === 1) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(body, 'base64url')));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();
  const { t, v, e } = parsed as Record<string, unknown>;
  if (typeof t !== 'string' || t === '') throw invalid();
  let version: [number, number, number] | undefined;
  if (v !== undefined) {
    version = typeof v === 'string' ? parseVersion(v) : undefined;
    if (version === undefined) throw invalid();
  }
  if (e !== undefined && (typeof e !== 'number' || !Number.isInteger(e) || e < 0 || e > MAX_EPOCH)) throw invalid();
  return { token: t, wrapped: true, ...(version ? { version } : {}), ...(typeof e === 'number' ? { epoch: e } : {}) };
}
