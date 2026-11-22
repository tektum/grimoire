import type { Extension } from '@hocuspocus/server';
import type { CollabLog } from './events.js';
import { readContext } from './context.js';
import type { PeerRegistry } from './peers.js';
import { Refusal } from './refusal.js';

/**
 * Wraps the hooks that run while a document is being opened, for ours and for any extension added from outside: whatever they throw
 * is logged as one `collab.refused` event, the socket close is scheduled (unless another document on it is open), and what reaches
 * Hocuspocus is a `Refusal` carrying only a reason. An unexpected error becomes `internal-error`, and its message is never seen.
 */
export function guardConnectHooks(ext: Extension, o: { log: CollabLog; peers: PeerRegistry }): Extension {
  const failed = (context: unknown, e: unknown): Refusal => {
    const refusal = e instanceof Refusal ? e : new Refusal('internal-error');
    o.log.emit('collab.refused', { code: refusal.reason, ...(refusal.detail !== undefined ? { detail: refusal.detail } : {}) });
    const peerId = readContext(context).peerId;
    if (peerId !== undefined) o.peers.refused(peerId, refusal.reason);
    return refusal;
  };
  const wrap = <D extends { context: unknown }>(fn: (d: D) => Promise<unknown>) => async (d: D): Promise<unknown> => {
    try { return await fn(d); } catch (e) { throw failed(d.context, e); }
  };
  // The wrapped extension is the prototype: a class instance keeps every hook it defines on its own prototype (a spread would copy only own properties).
  const out = Object.create(ext) as Extension;
  if (ext.onConnect) out.onConnect = wrap(ext.onConnect.bind(ext));
  if (ext.onAuthenticate) out.onAuthenticate = wrap(ext.onAuthenticate.bind(ext));
  if (ext.onLoadDocument) out.onLoadDocument = wrap(ext.onLoadDocument.bind(ext));
  if (ext.afterLoadDocument) out.afterLoadDocument = wrap(ext.afterLoadDocument.bind(ext));
  if (ext.connected) out.connected = wrap(ext.connected.bind(ext));
  return out;
}
