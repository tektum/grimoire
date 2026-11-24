import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { authenticatedMessage, parseMessage, permissionDeniedMessage, statelessMessage } from './hocuspocus-wire';

// A WebSocket server that speaks just enough of the Hocuspocus protocol for a client to authenticate, and that a test can script: it records every token
// it is given, sends chosen stateless messages, and closes sockets with a chosen code (4429, 4401, ...). It needs no package: RFC 6455 framing is small.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (length >= 65536) head.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([head, payload]);
}

interface Decoded {
  opcode: number;
  payload: Buffer;
}
/** Takes whole frames off the front of `buffer` (client frames are masked); returns them and what is left. */
function decodeFrames(buffer: Buffer): { frames: Decoded[]; rest: Buffer } {
  const frames: Decoded[] = [];
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0]! & 0x0f;
    const masked = (rest[1]! & 0x80) !== 0;
    let length = rest[1]! & 0x7f;
    let at = 2;
    if (length === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      at = 4;
    } else if (length === 127) {
      if (rest.length < 10) break;
      length = Number(rest.readBigUInt64BE(2));
      at = 10;
    }
    const maskAt = at;
    if (masked) at += 4;
    if (rest.length < at + length) break;
    const payload = Buffer.from(rest.subarray(at, at + length));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ rest[maskAt + (i % 4)]!;
    frames.push({ opcode, payload });
    rest = rest.subarray(at + length);
  }
  return { frames, rest };
}

export interface ScriptedCollabServerOptions {
  /** What to do when a client sends its token: accept it (default), refuse it with a reason, or close the socket with a code. */
  readonly onAuth?: 'accept' | { readonly deny: string } | { readonly close: number; readonly reason?: string };
  /** A stateless message sent to a client right after it authenticates. */
  readonly statelessOnAuth?: string;
  /** The scope of the authenticated message (default `read-write`): `readonly` for a reader. */
  readonly scope?: 'read-write' | 'readonly';
}

export interface ScriptedCollabServer {
  /** `ws://127.0.0.1:<port>`: the address to give the client as the collaboration URL. */
  readonly url: string;
  /** Every token received, in order. */
  readonly tokens: string[];
  /** The document name of every authentication message, in order. */
  readonly documents: string[];
  /** Number of sockets open now. */
  sockets(): number;
  /** Sends a stateless message to every open socket. */
  sendStateless(payload: string): void;
  /** Closes every open socket with `code` (the close frame carries it and the reason). */
  closeAll(code: number, reason?: string): void;
  stop(): Promise<void>;
}

export async function scriptedCollabServer(options: ScriptedCollabServerOptions = {}): Promise<ScriptedCollabServer> {
  const tokens: string[] = [];
  const documents: string[] = [];
  const open = new Set<Duplex>();
  const documentOf = new Map<Duplex, string>();
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  const send = (socket: Duplex, opcode: number, payload: Uint8Array) => {
    if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
  };
  const close = (socket: Duplex, code: number, reason = '') => {
    const body = Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)]);
    if (!socket.destroyed) socket.end(encodeFrame(0x8, body));
  };

  server.on('upgrade', (req, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') return void socket.destroy();
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    open.add(socket);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const decoded = decodeFrames(Buffer.concat([pending, chunk]));
      pending = decoded.rest;
      for (const { opcode, payload } of decoded.frames) {
        if (opcode === 0x8) return void socket.end(encodeFrame(0x8, payload.subarray(0, 2)));
        if (opcode === 0x9) send(socket, 0xa, payload);
        if (opcode !== 0x2) continue;
        let message;
        try {
          message = parseMessage(payload);
        } catch {
          continue; // a malformed message is ignored: the scripted server never throws at a client
        }
        if (message.kind !== 'auth-token') continue;
        tokens.push(message.token);
        documents.push(message.document);
        documentOf.set(socket, message.document);
        const action = options.onAuth ?? 'accept';
        if (action === 'accept') {
          send(socket, 0x2, authenticatedMessage(message.document, options.scope));
          if (options.statelessOnAuth !== undefined) send(socket, 0x2, statelessMessage(message.document, options.statelessOnAuth));
        } else if ('deny' in action) send(socket, 0x2, permissionDeniedMessage(message.document, action.deny));
        else close(socket, action.close, action.reason);
      }
    });
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => open.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tokens,
    documents,
    sockets: () => open.size,
    sendStateless: (payload) => {
      for (const socket of open) send(socket, 0x2, statelessMessage(documentOf.get(socket) ?? '', payload));
    },
    closeAll: (code, reason) => {
      for (const socket of open) close(socket, code, reason);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
