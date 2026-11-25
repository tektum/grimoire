import type { Page } from '@playwright/test';

export interface Handshake {
  t: string;
  v?: string;
  e?: number;
}

/** The handshake tokens the page's own sockets send: the `g1.` text inside each frame the page writes, decoded. */
export function recordHandshakes(page: Page): Handshake[] {
  const seen: Handshake[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('latin1');
      const match = /g1\.([A-Za-z0-9_-]+)/.exec(text);
      if (match?.[1] !== undefined) seen.push(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as Handshake);
    });
  });
  return seen;
}

/** What a recorder saw, and a wait that says why it ended without what was asked. */
export interface HandshakeTrace {
  readonly handshakes: Handshake[];
  /** The address of each websocket the page opened, without its query (a token may be in it). */
  readonly sockets: string[];
  /** How many frames the page sent over all of them. */
  frames: number;
  /** The errors the page wrote to its console, and the ones it did not catch. */
  readonly errors: string[];
  /** Resolves when `count` handshakes have been seen; rejects at `timeoutMs` with what the page did: no socket at all, or sockets that sent no token. */
  waitFor(count: number, timeoutMs: number): Promise<void>;
}

const withoutQuery = (url: string): string => url.split('?')[0] ?? url;

/** `recordHandshakes` with the context of a failure: sockets opened and closed, frames sent, console errors. */
export function traceHandshakes(page: Page): HandshakeTrace {
  const handshakes: Handshake[] = [];
  const sockets: string[] = [];
  const closed = new Set<number>();
  const errors: string[] = [];
  const trace: HandshakeTrace = {
    handshakes,
    sockets,
    frames: 0,
    errors,
    async waitFor(count, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (handshakes.length < count) {
        if (Date.now() >= deadline) throw new Error(describe(count));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  const describe = (wanted: number): string => {
    const first =
      sockets.length === 0
        ? 'no websocket was opened by the page'
        : `${String(sockets.length)} websocket${sockets.length === 1 ? ' was' : 's were'} opened (${sockets.map((s, n) => `${s}${closed.has(n) ? ' [closed]' : ''}`).join(', ')}) and ${String(trace.frames)} frame${trace.frames === 1 ? '' : 's'} sent, none with a handshake token`;
    const seen = handshakes.length === 0 ? '' : `; ${String(handshakes.length)} of ${String(wanted)} handshakes were seen`;
    return `expected ${String(wanted)} handshake${wanted === 1 ? '' : 's'}: ${first}${seen}${errors.length === 0 ? '; the page wrote no console error' : `; console: ${errors.slice(0, 5).join(' | ')}`}`;
  };
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
  page.on('websocket', (socket) => {
    const index = sockets.push(withoutQuery(socket.url())) - 1;
    socket.on('close', () => closed.add(index));
    socket.on('framesent', (frame) => {
      trace.frames += 1;
      const text = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('latin1');
      const match = /g1\.([A-Za-z0-9_-]+)/.exec(text);
      if (match?.[1] !== undefined) handshakes.push(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as Handshake);
    });
  });
  return trace;
}
