// Hand-built Hocuspocus frames. Reason this exists: the provider only sends well-formed frames, and the scenarios need malformed,
// oversize and forged ones; the vitest suite's equivalent helpers cannot be imported by a plain Node process (they import `.js` names).
import { Buffer } from 'node:buffer';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { BASE, ORIGIN, eventually, originSocket } from './support.ts';

const SYNC = 0; const AWARENESS = 1; const AUTH = 2; const STATELESS = 5;
const SYNC_STEP_1 = 0; const SYNC_STEP_2 = 1;
type Bytes = Uint8Array<ArrayBuffer>;

function frame(doc: string, type: number, build: (e: encoding.Encoder) => void): Bytes {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, doc);
  encoding.writeVarUint(e, type);
  build(e);
  return Uint8Array.from(encoding.toUint8Array(e));
}
export const authFrame = (doc: string, token: string): Bytes => frame(doc, AUTH, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, token); });
export const syncUpdateFrame = (doc: string, update: Uint8Array): Bytes => frame(doc, SYNC, (e) => { encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, update); });
/** An awareness update: one entry per `[clientId, clock, state]`; a `null` state is a removal. */
export function awarenessFrame(doc: string, entries: readonly (readonly [number, number, unknown])[]): Bytes {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const [id, clock, state] of entries) { encoding.writeVarUint(inner, id); encoding.writeVarUint(inner, clock); encoding.writeVarString(inner, JSON.stringify(state)); }
  return frame(doc, AWARENESS, (e) => { encoding.writeVarUint8Array(e, encoding.toUint8Array(inner)); });
}
/** A sync-update frame of exactly `bytes` bytes that holds one well-formed insert. */
export function syncUpdateFrameOfSize(doc: string, bytes: number): Bytes {
  let length = bytes - 40;
  for (let i = 0; i < 20; i++) {
    const d = new Y.Doc();
    d.getText('prosemirror').insert(0, 'z'.repeat(length));
    const f = syncUpdateFrame(doc, Y.encodeStateAsUpdate(d));
    if (f.length === bytes) return f;
    length += bytes - f.length;
  }
  throw new Error(`no frame of ${String(bytes)} bytes`);
}

/** The message type of a frame, the sync sub-type for sync frames, and the text of a stateless frame. */
function parse(f: Uint8Array): { type: number; syncStep: number | undefined; stateless: string | undefined } {
  let i = 0;
  const varUint = (): number => { let n = 0; let mul = 1; for (;;) { const b = f[i++] ?? 0; n += (b & 127) * mul; if (b < 128) return n; mul *= 128; } };
  const nameLength = varUint(); i += nameLength;
  const type = varUint();
  if (type === SYNC) return { type, syncStep: varUint(), stateless: undefined };
  if (type !== STATELESS) return { type, syncStep: undefined, stateless: undefined };
  const len = varUint();
  return { type, syncStep: undefined, stateless: Buffer.from(f.slice(i, i + len)).toString() };
}

/** A WebSocket driven by hand, authenticated for one document; keeps the stateless messages and the close code. */
export class RawClient {
  readonly stateless: string[] = [];
  closed: { code: number; reason: string } | undefined;
  readonly socket: WebSocket; readonly doc: string;
  private frames = 0; private syncReplies = 0;
  private constructor(socket: WebSocket, doc: string) {
    this.socket = socket; this.doc = doc;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (e) => {
      this.frames += 1;
      if (!(e.data instanceof ArrayBuffer)) return;
      const m = parse(new Uint8Array(e.data));
      if (m.stateless !== undefined) this.stateless.push(m.stateless);
      if (m.type === SYNC && m.syncStep === SYNC_STEP_2) this.syncReplies += 1;
    });
    socket.addEventListener('close', (e) => { this.closed = { code: e.code, reason: e.reason }; });
  }
  static async open(doc: string, token: string): Promise<RawClient> {
    const socket = new (originSocket(ORIGIN))(`${BASE.replace('http', 'ws')}/collab`);
    const c = new RawClient(socket, doc);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => { resolve(); }); socket.addEventListener('error', () => { reject(new Error('socket error')); }); });
    socket.send(authFrame(doc, token));
    await eventually(() => (c.frames >= 1 ? true : undefined), 8000, 'raw client authenticated');
    // A sync round trip (step 1 with an empty state vector, answered by step 2) shows the document is loaded and the connection serves it.
    socket.send(frame(doc, SYNC, (e) => { encoding.writeVarUint(e, SYNC_STEP_1); encoding.writeVarUint8Array(e, Y.encodeStateVector(new Y.Doc())); }));
    await eventually(() => (c.syncReplies >= 1 ? true : undefined), 8000, 'raw client sync reply');
    return c;
  }
  send(f: Bytes): void { this.socket.send(f); }
  close(): void { this.socket.close(); }
}
