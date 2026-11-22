import { createServer } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { rejectUpgrades } from '../../src/collab/index.js';

// Review claim: after Node emits 'upgrade' it no longer listens for socket errors, so a client that resets the connection while a 404/400/503 answer is being
// written would be an uncaught exception that takes the process down.
const servers: net.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.close(() => { resolve(); }); }))); });

describe('a rejected upgrade whose client resets the connection', () => {
  it('is never an uncaught exception', async () => {
    const server = createServer();
    servers.push(server);
    rejectUpgrades(server, createEventLog(new FakeLogger()));
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    const uncaught: unknown[] = [];
    const record = (e: unknown): void => { uncaught.push(e); };
    process.on('uncaughtException', record);
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise<void>((resolve) => {
          const client = net.connect(port, '127.0.0.1', () => {
            client.write('GET /nowhere HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n');
            client.resetAndDestroy(); // RST right behind the request: the server's answer meets a reset connection
          });
          client.on('error', () => undefined);
          client.on('close', () => { resolve(); });
        });
      }
      await new Promise((resolve) => setImmediate(resolve)); // let any late socket error surface
    } finally {
      process.off('uncaughtException', record);
    }
    expect(uncaught).toEqual([]);
  });
});
