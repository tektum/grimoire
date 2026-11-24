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
