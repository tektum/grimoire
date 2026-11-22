import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_ORIGIN, startLive } from '../host/live-support.js';
import type { Live } from '../host/live-support.js';

const lives: Live[] = [];
afterEach(async () => { for (const l of lives.splice(0)) await l.stop(); });

function status(l: Live, headers: Record<string, string>): Promise<number> {
  const port = (l.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: '/collab', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

describe('origin refusal happens before any hook', () => {
  it('a wrong and a missing Origin get 403 and onConnect of a probe extension runs 0 times; an allowed one gets 101', async () => {
    let onConnect = 0;
    const l = await startLive('member', { extensions: [{ extensionName: 'probe', onConnect: () => { onConnect += 1; return Promise.resolve(); } }] });
    lives.push(l);
    expect(await status(l, { Origin: 'https://evil.example' })).toBe(403);
    expect(await status(l, {})).toBe(403);
    expect(onConnect).toBe(0);
    expect(await status(l, { Origin: ALLOWED_ORIGIN })).toBe(101);
    expect(l.t.logger.entries.some((r) => JSON.stringify(r).includes('evil'))).toBe(false);
  });
});
