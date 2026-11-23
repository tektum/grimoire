import { compareVersions, parseVersion } from '@tektum/grimoire-core/version';
import type { VersionTriple } from '@tektum/grimoire-core/version';
import { Refusal } from './refusal.js';

/** The longest session token (the policy's cap): a bare token, or the `t` inside a wrapper. */
export const MAX_TOKEN_LENGTH = 8192;
/** The longest wrapper: the prefix, plus the base64url of a maximal token with room for the JSON around it (`v`, `e`, quotes). */
export const MAX_HANDSHAKE_LENGTH = 3 + Math.ceil(((MAX_TOKEN_LENGTH + 64) * 4) / 3);
const PREFIX = 'g1.';
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const MAX_EPOCH = 2147483647;

/** What the connect-time token carries: the session token, and the client's version and recorded state epoch when it sent a wrapper. */
export interface Handshake {
  readonly token: string;
  readonly version?: VersionTriple;
  readonly epoch?: number;
  /** True when the client sent the `g1.` wrapper, false for a bare session token. */
  readonly wrapped: boolean;
}

const invalid = (): Refusal => new Refusal('invalid-token');

/**
 * Step 1 and 2 of the connect-time handshake (R4.32): no database, no verifier. Throws `invalid-token` for a string that is too long or a
 * malformed wrapper, `client-too-old` for a bare token when the handshake is required or a version below `minClientVersion`.
 */
export function readHandshake(raw: unknown, options: { readonly requireHandshake: boolean; readonly minClientVersion: string }): Handshake {
  if (typeof raw !== 'string' || raw.length > MAX_HANDSHAKE_LENGTH) throw invalid();
  if (!raw.startsWith(PREFIX) && raw.length > MAX_TOKEN_LENGTH) throw invalid();
  let h: Handshake;
  if (!raw.startsWith(PREFIX)) {
    if (options.requireHandshake) throw new Refusal('client-too-old');
    h = { token: raw, wrapped: false };
  } else {
    h = decode(raw.slice(PREFIX.length));
  }
  const min = parseMinimum(options.minClientVersion);
  if (h.version !== undefined && compareVersions(h.version, min) < 0) throw new Refusal('client-too-old');
  return h;
}

/** The floor is validated at config load with the same parser; an unreadable one here is a bug, so it fails closed. */
function parseMinimum(text: string): VersionTriple {
  const min = parseVersion(text);
  if (min === null) throw new Error('minClientVersion is not a dotted triple');
  return min;
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
  if (typeof t !== 'string' || t === '' || t.length > MAX_TOKEN_LENGTH) throw invalid();
  let version: VersionTriple | undefined;
  if (v !== undefined) {
    const parsed = typeof v === 'string' ? parseVersion(v) : null;
    if (parsed === null) throw invalid();
    version = parsed;
  }
  if (e !== undefined && (typeof e !== 'number' || !Number.isInteger(e) || e < 0 || e > MAX_EPOCH)) throw invalid();
  return { token: t, wrapped: true, ...(version ? { version } : {}), ...(typeof e === 'number' ? { epoch: e } : {}) };
}
