import { Buffer } from 'node:buffer';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { sqlAdmin } from '../server/support/harness.js';
import { originProviderConfig } from '@tektum/grimoire-test-support';
import { ALLOWED_ORIGIN, eventually, originSocket } from './support.js';

/** Hocuspocus wire format, just enough for raw-socket tests: message type numbers from its protocol. */
type Bytes = Uint8Array<ArrayBuffer>;
const SYNC = 0; const AUTH = 2; const STATELESS = 5;

const varUint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};
const varString = (s: string): number[] => { const b = Buffer.from(s); return [...varUint(b.length), ...b]; };

export function syncUpdateFrame(doc: string, update: Uint8Array): Bytes {
  return Uint8Array.from([...varString(doc), ...varUint(SYNC), ...varUint(2), ...varUint(update.length), ...update]);
}
/** A sync-update frame of exactly `bytes` bytes holding one well-formed update (a text insert), for the boundary of `maxPayload`. */
export function syncUpdateFrameOfSize(doc: string, bytes: number): Bytes {
  let length = bytes - 40;
  for (let i = 0; i < 20; i++) {
    const d = new Y.Doc();
    d.getText('prosemirror').insert(0, 'z'.repeat(length));
    const frame = syncUpdateFrame(doc, Y.encodeStateAsUpdate(d));
    if (frame.length === bytes) return frame;
    length += bytes - frame.length;
  }
  throw new Error(`no frame of ${String(bytes)} bytes`);
}
export const authOnlyFrame = (doc: string, token: string): Bytes => Uint8Array.from([...varString(doc), ...varUint(AUTH), ...varUint(0), ...varString(token)]);

function readVarUint(b: Uint8Array, at: number): [number, number] {
  let n = 0; let mul = 1; let i = at;
  for (;;) { const byte = b[i++] ?? 0; n += (byte & 127) * mul; if (byte < 128) return [n, i]; mul *= 128; }
}
/** The payload of a stateless message, or undefined for any other frame. */
export function statelessOf(frame: Uint8Array): string | undefined {
  const [nameLength, nameAt] = readVarUint(frame, 0);
  const [type, typeEnd] = readVarUint(frame, nameAt + nameLength);
  if (type !== STATELESS) return undefined;
  const [length, start] = readVarUint(frame, typeEnd);
  return Buffer.from(frame.slice(start, start + length)).toString();
}

/** A WebSocket the test drives by hand: authenticates for one document, keeps every frame it receives and the close code. */
export class RawClient {
  readonly frames: Uint8Array[] = [];
  closed: { code: number; reason: string } | undefined;
  private constructor(readonly socket: WebSocket, readonly doc: string) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (e: MessageEvent) => { this.frames.push(new Uint8Array(e.data as ArrayBuffer)); });
    socket.addEventListener('close', (e) => { this.closed = { code: e.code, reason: e.reason }; });
  }
  static async open(url: string, doc: string, token = 'dev:test-secret-0123456789abcdef:alice:member'): Promise<RawClient> {
    const socket = new (originSocket(ALLOWED_ORIGIN))(url);
    const c = new RawClient(socket, doc);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => { resolve(); }); socket.addEventListener('error', () => { reject(new Error('socket error')); }); });
    socket.send(authOnlyFrame(doc, token));
    await eventually(() => (c.frames.length >= 1 ? true : undefined), 5000, 'raw client authenticated');
    await new Promise((r) => setTimeout(r, 300)); // the document is set up and loaded right after the Authenticated frame
    return c;
  }
  /** A socket that has not authenticated: only open. */
  static async openUnauthenticated(url: string): Promise<RawClient> {
    const socket = new (originSocket(ALLOWED_ORIGIN))(url);
    const c = new RawClient(socket, '');
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => { resolve(); }); socket.addEventListener('error', () => { reject(new Error('socket error')); }); });
    return c;
  }
  send(frame: Bytes): void { this.socket.send(frame); }
  /** Authenticate another real session on this same WebSocket. */
  authenticate(token: string): void { this.socket.send(authOnlyFrame(this.doc, token)); }

  get stateless(): string[] { return this.frames.map(statelessOf).filter((s): s is string => s !== undefined); }
  close(): void { this.socket.close(); }
}

export async function setPageState(db: string, id: string, state: Uint8Array): Promise<void> {
  await sqlAdmin(db, `update pages set ydoc = decode('${Buffer.from(state).toString('hex')}', 'hex'), ydoc_size = ${String(state.byteLength)} where id = '${id}'`);
}

/** A Yjs state of `bytes` bytes of text (one insert), as the server would store it. */
export function stateOfSize(bytes: number): Bytes {
  let length = bytes - 12;
  for (let i = 0; i < 20; i++) {
    const d = new Y.Doc();
    d.getText('prosemirror').insert(0, 'p'.repeat(length));
    const s = Y.encodeStateAsUpdate(d);
    if (s.byteLength === bytes) return new Uint8Array(s);
    length += bytes - s.byteLength;
  }
  throw new Error(`no state of ${String(bytes)} bytes`);
}

export interface Editor {
  readonly provider: HocuspocusProvider;
  readonly text: Y.Text;
  readonly stateless: string[];
  readonly failures: string[];
  readonly closes: number[];
  destroy(): void;
}
/** A provider that also records stateless messages (refusals and warnings). */
export function editor(url: string, name: string, token = 'dev:test-secret-0123456789abcdef:alice:member'): Editor {
  const stateless: string[] = []; const failures: string[] = []; const closes: number[] = [];
  const document = new Y.Doc();
  const provider = new HocuspocusProvider(originProviderConfig({
    url, name, token, document, WebSocketPolyfill: originSocket(ALLOWED_ORIGIN),
    onStateless: ({ payload }) => { stateless.push(payload); },
    onAuthenticationFailed: ({ reason }) => { failures.push(reason); },
    onClose: ({ event }) => { closes.push(event.code); },
  }));
  return { provider, text: document.getText('prosemirror'), stateless, failures, closes, destroy: () => { provider.destroy(); } };
}

/** A well-formed Awareness update frame (message type 1) for `doc`, as a client publishing `state` would send it; `clock` rises with each call. */
export function awarenessFrame(doc: string, awareness: Awareness, state: Record<string, unknown>): Bytes {
  awareness.setLocalState(state);
  const update = encodeAwarenessUpdate(awareness, [awareness.clientID]);
  return Uint8Array.from([...varString(doc), ...varUint(1), ...varUint(update.length), ...update]);
}
