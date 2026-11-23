import { compareVersions, parseVersion } from '@tektum/grimoire-core/version';
import type { VersionTriple } from '@tektum/grimoire-core/version';
import type { Extension, HookPayloadByName } from '@hocuspocus/server';
import * as Y from 'yjs';
import { readContext, updateContext } from './context.js';
import { REFUSAL_CLOSE_CODES, Refusal } from './refusal.js';

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

/** The stateless message that tells a client the page's epoch, so it records it for its next connect (M1-contracts section 6). */
export const epochMessage = (epoch: number): string => JSON.stringify({ grimoire: 1, kind: 'epoch', epoch });

/** Closes the document connection with the stale-epoch code: Hocuspocus uses `code` and `reason` of what a message hook throws. */
class StaleEpoch extends Error {
  readonly code = REFUSAL_CLOSE_CODES['stale-epoch'];
  readonly reason = 'stale-epoch';
  constructor() { super(''); }
}

/** True when every deleted range of `offered` lies inside a range `held` already deletes (both are sorted and merged per client). */
interface Deleted { readonly clients: ReadonlyMap<number, readonly { readonly clock: number; readonly len: number }[]> }
function deletesNothingNew(offered: Deleted, held: Deleted): boolean {
  for (const [client, items] of offered.clients) {
    const have = held.clients.get(client) ?? [];
    for (const { clock, len } of items) {
      if (!have.some((h) => h.clock <= clock && clock + len <= h.clock + h.len)) return false;
    }
  }
  return true;
}

/**
 * The belt: a wrapper client that did not know the epoch must open with an empty document, because the editor mounts only after `synced`.
 * Its first sync step 2 or update is diffed against the loaded document; any struct the page does not already have, on a page past epoch 0 is old
 * state from before a reset, and is refused before it is applied. The flag is cleared by that first message, so later edits are not inspected.
 */
export function createHandshakeExtension(): Extension {
  return {
    extensionName: 'grimoire-handshake',
    priority: 950,
    async beforeSync(data: HookPayloadByName['beforeSync']): Promise<void> {
      if (data.type !== 1 && data.type !== 2) return;
      const c = readContext(data.context);
      if (c.epochUnknown !== true) return;
      updateContext(data.context, { epochUnknown: false });
      if ((c.epoch ?? 0) === 0) return;
      let diff: Uint8Array;
      try { diff = Y.diffUpdate(data.payload, Y.encodeStateVector(data.document)); } catch { return; } // malformed bytes are the limits extension's refusal
      // Only content the page lacks counts: structs it does not have, and deletions it has not already made. The diff keeps the whole delete
      // set, and a fresh client that has just applied this page (tombstones included) offers the page's own deletions back.
      const offered = Y.decodeUpdate(diff);
      if (offered.structs.length === 0 && deletesNothingNew(offered.ds, Y.createDeleteSetFromStructStore(data.document.store))) return;
      try { data.connection.sendStateless(JSON.stringify({ grimoire: 1, kind: 'refusal', code: 'stale-epoch' })); } catch { /* a closing socket cannot be told */ }
      throw new StaleEpoch();
    },
  };
}
