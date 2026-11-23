// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { authMessage, authenticatedMessage, parseMessage, permissionDeniedMessage, Reader, statelessMessage, writeVarString, writeVarUint } from '../../test-e2e/support/hocuspocus-wire';
import { type ScriptedCollabServer, scriptedCollabServer } from '../../test-e2e/support/collab-server';

const stops: ScriptedCollabServer[] = [];
const start = async (options?: Parameters<typeof scriptedCollabServer>[0]) => {
  const server = await scriptedCollabServer(options);
  stops.push(server);
  return server;
};
afterEach(async () => {
  for (const s of stops.splice(0)) await s.stop();
});

/** A Node WebSocket client that collects what it receives and how the socket ends. */
function connect(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const messages: Uint8Array[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });
  socket.addEventListener('message', (e) => messages.push(new Uint8Array(e.data as ArrayBuffer)));
  const next = async (count: number) => {
    for (let i = 0; i < 200 && messages.length < count; i++) await new Promise((r) => setTimeout(r, 10));
    expect(messages.length).toBeGreaterThanOrEqual(count);
  };
  return { socket, messages, closed, opened, next };
}

describe('the wire codec', () => {
  it('round-trips varints and strings, also past one byte and with non-ASCII text', () => {
    const out: number[] = [];
    for (const n of [0, 1, 127, 128, 300, 70000, 2 ** 31]) writeVarUint(out, n);
    writeVarString(out, 'héllo 日本');
    const reader = new Reader(Uint8Array.from(out));
    expect([0, 1, 127, 128, 300, 70000, 2 ** 31].map(() => reader.varUint())).toEqual([0, 1, 127, 128, 300, 70000, 2 ** 31]);
    expect(reader.varString()).toBe('héllo 日本');
  });
  it('throws on a message that ends early instead of looping', () => {
    expect(() => new Reader(Uint8Array.from([0x80])).varUint()).toThrow('inside a number');
    expect(() => new Reader(Uint8Array.from([5, 65])).varString()).toThrow('inside a string');
  });
  it('parses the token message and the stateless message, and calls anything else other', () => {
    expect(parseMessage(authMessage('page-1', 'tok'))).toEqual({ document: 'page-1', kind: 'auth-token', token: 'tok' });
    expect(parseMessage(statelessMessage('page-1', '{"a":1}'))).toEqual({ document: 'page-1', kind: 'stateless', payload: '{"a":1}' });
    expect(parseMessage(authenticatedMessage('page-1')).kind).toBe('other');
    expect(parseMessage(permissionDeniedMessage('page-1', 'no')).kind).toBe('other');
  });
});

describe('scriptedCollabServer', () => {
  it('records the token and document of every authentication and answers authenticated', async () => {
    const server = await start();
    const client = connect(server.url);
    await client.opened;
    client.socket.send(authMessage('page-7', 'first-token'));
    await client.next(1);
    expect(server.tokens).toEqual(['first-token']);
    expect(server.documents).toEqual(['page-7']);
    expect(parseMessage(client.messages[0]!).kind).toBe('other'); // the authenticated answer
    expect(Array.from(client.messages[0]!)).toEqual(Array.from(authenticatedMessage('page-7')));
    client.socket.send(authMessage('page-7', 'second-token'));
    await client.next(2);
    expect(server.tokens).toEqual(['first-token', 'second-token']);
    expect(server.sockets()).toBe(1);
    client.socket.close();
    await client.closed;
  });

  it('sends a stateless message after authenticating, and on request', async () => {
    const server = await start({ statelessOnAuth: '{"hello":true}' });
    const client = connect(server.url);
    await client.opened;
    client.socket.send(authMessage('page-1', 't'));
    await client.next(2);
    expect(parseMessage(client.messages[1]!)).toEqual({ document: 'page-1', kind: 'stateless', payload: '{"hello":true}' });
    server.sendStateless('{"later":1}');
    await client.next(3);
    expect(parseMessage(client.messages[2]!)).toEqual({ document: 'page-1', kind: 'stateless', payload: '{"later":1}' });
    client.socket.close();
  });

  it('closes every socket with the chosen code and reason (4429)', async () => {
    const server = await start();
    const clients = [connect(server.url), connect(server.url)];
    await Promise.all(clients.map((c) => c.opened));
    await Promise.all(clients.map((c) => c.socket.send(authMessage('page-1', 't'))));
    await Promise.all(clients.map((c) => c.next(1)));
    server.closeAll(4429, 'too-many-connections');
    for (const c of clients) expect(await c.closed).toEqual({ code: 4429, reason: 'too-many-connections' });
  });

  it('can close at authentication with a code, or refuse with a reason', async () => {
    const closing = await start({ onAuth: { close: 4401, reason: 'bad-token' } });
    const a = connect(closing.url);
    await a.opened;
    a.socket.send(authMessage('p', 'x'));
    expect(await a.closed).toEqual({ code: 4401, reason: 'bad-token' });
    expect(closing.tokens).toEqual(['x']);
    const denying = await start({ onAuth: { deny: 'not allowed' } });
    const b = connect(denying.url);
    await b.opened;
    b.socket.send(authMessage('p', 'y'));
    await b.next(1);
    expect(b.messages[0]!.length).toBeGreaterThan(0);
    expect(Array.from(b.messages[0]!)).toEqual(Array.from(permissionDeniedMessage('p', 'not allowed')));
    b.socket.close();
  });

  it('ignores a malformed message and keeps serving', async () => {
    const server = await start();
    const client = connect(server.url);
    await client.opened;
    client.socket.send(Uint8Array.from([0x80, 0x80]));
    client.socket.send(authMessage('p', 'after-garbage'));
    await client.next(1);
    expect(server.tokens).toEqual(['after-garbage']);
    client.socket.close();
  });

  it('handles a message longer than 125 bytes (extended frame length)', async () => {
    const server = await start();
    const client = connect(server.url);
    await client.opened;
    const long = 'x'.repeat(300);
    client.socket.send(authMessage('p', long));
    await client.next(1);
    expect(server.tokens).toEqual([long]);
    client.socket.close();
  });

  it('stops: the port is released and sockets end', async () => {
    const server = await start();
    const client = connect(server.url);
    await client.opened;
    await server.stop();
    await client.closed;
    expect(server.sockets()).toBe(0);
  });
});
