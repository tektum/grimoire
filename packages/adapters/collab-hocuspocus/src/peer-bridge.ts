import type { Hocuspocus } from '@hocuspocus/server';
import type { Hooks, Peer } from 'crossws';
import { randomUUID } from 'node:crypto';
import type { ConnectionContext } from './context.js';
import { codeFor, FALLBACK_REFUSAL_CODE, REFUSAL_CLOSE_CODES } from './refusal.js';
import type { PeerRegistry } from './peers.js';
import type { UpgradeGuard } from './upgrade-guard.js';

export interface BridgeOptions {
  readonly hocuspocus: Pick<Hocuspocus, 'handleConnection'>;
  readonly peers: PeerRegistry;
  readonly guard: UpgradeGuard;
  /** Called when `ws` closed a socket with 1009 (a frame over `maxPayload`, which `ws` enforces before any of our code sees it). */
  readonly onFrameTooLarge?: () => void;
}

type Connection = ReturnType<Hocuspocus['handleConnection']>;
type RawSocket = Parameters<Hocuspocus['handleConnection']>[0];
interface Emitter { on(event: string, listener: () => void): unknown }

const isEmitter = (v: unknown): v is Emitter => typeof v === 'object' && v !== null && 'on' in v && typeof v.on === 'function';

/** The reservation `host.handleUpgrade` attached to this socket's request context (absent when the socket did not come through it). */
function ticketOf(context: Record<string, unknown> | undefined): object | undefined {
  const t = context?.['ticket'];
  return typeof t === 'object' && t !== null ? t : undefined;
}

/** crossws hooks forwarding each socket to Hocuspocus, which has no server of its own here. */
export function createPeerHooks(o: BridgeOptions): Partial<Hooks> {
  const bound = new WeakMap<Peer, { connection: Connection; peerId: string }>();

  const openPeer = (peer: Peer): void => {
    const peerId = randomUUID();
    const address = o.guard.resolveAddress(peer.request.headers, peer.remoteAddress);
    const request = new Request(new URL(peer.request.url, 'http://collab.invalid'), { headers: peer.request.headers });
    const context: ConnectionContext = { address, peerId };
    // crossws hands over the `ws` socket typed as the web WebSocket; Hocuspocus accepts the ws API it really is.
    const connection = o.hocuspocus.handleConnection(peer.websocket as unknown as RawSocket, request, context);
    bound.set(peer, { connection, peerId });
    o.peers.add(peerId, peer);
    o.guard.onOpen(peerId, address, ticketOf(peer.context));
    // crossws pings every 30 s; Hocuspocus only counts messages, so a pong must count as activity or silent clients are dropped.
    const raw: unknown = peer.websocket;
    if (isEmitter(raw)) raw.on('pong', () => { connection.touch(); });
  };

  return {
    open(peer) {
      try {
        openPeer(peer);
      } catch {
        peer.close(FALLBACK_REFUSAL_CODE, 'internal-error'); // Hocuspocus never got this socket, so nothing else would close it
      }
    },
    message(peer, message) {
      const b = bound.get(peer);
      if (!b) return;
      // Frames of a socket that has not authenticated count toward the global queued-bytes cap; past it the socket is closed.
      if (!o.guard.onFrame(b.peerId, message.uint8Array().byteLength)) { peer.close(codeFor(REFUSAL_CLOSE_CODES, 'server-full'), 'server-full'); return; }
      b.connection.handleMessage(message.uint8Array());
    },
    // `ws` reports an oversize frame only as an error (its close code is seen as 1006 here) and crossws keeps nothing but the text: match it.
    error(_peer, error) {
      if (error.message.includes('Max payload size exceeded')) o.onFrameTooLarge?.();
    },
    close(peer, details) {
      const b = bound.get(peer);
      if (!b) return;
      bound.delete(peer);
      o.peers.remove(b.peerId);
      o.guard.onClose(b.peerId);
      b.connection.handleClose({ code: details.code ?? 1005, reason: details.reason ?? '' });
    },
  };
}
