import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireBuild, startServer } from './support/harness.js';
import type { ServerProcess } from './support/harness.js';

// No database is needed: the listener must survive whatever arrives before anything else is touched.
const DB_URL = 'postgresql://grimoire_app:grimoire-dev@127.0.0.1:1/grimoire';
let server: ServerProcess;

beforeAll(async () => {
  requireBuild();
  server = await startServer({ env: { GRIMOIRE_DATABASE_URL: DB_URL } });
});
afterAll(async () => { await server.kill(); });

/** Sends raw bytes and resolves with whatever comes back before the server closes the socket (or 500 ms pass). */
function raw(port: number, bytes: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.write(bytes); });
    let out = '';
    s.on('data', (d: Buffer) => { out += d.toString('latin1'); });
    s.on('error', () => { resolve(out); });
    s.on('close', () => { resolve(out); });
    // Not a wait for an outcome: the upper bound of the read window, for a socket the server answers and keeps alive; a close resolves earlier.
    setTimeout(() => { s.destroy(); }, 500).unref();
  });
}
const upgradeHead = (target: string, extra = ''): string => `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;

const faults = (s: ServerProcess): string[] => s.output.split('\n').filter((l) => /process\.fault|uncaught|unhandled/i.test(l));

describe('the listeners cannot be taken down by a request', () => {
  it('a malformed upgrade target gets 400 and the process stays up', async () => {
    const out = await raw(server.port, upgradeHead('//['));
    expect(out.startsWith('HTTP/1.1 400')).toBe(true);
    expect(server.alive).toBe(true);
    expect(faults(server)).toEqual([]);
  });

  it('a malformed target on a plain HTTP request does not stop the process either', async () => {
    await raw(server.port, 'GET //[ HTTP/1.1\r\nHost: x\r\n\r\n');
    await raw(server.port, 'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(server.alive).toBe(true);
    expect(faults(server)).toEqual([]);
  });

  it('sockets reset at every moment of an upgrade do not become uncaught socket errors', async () => {
    const head = upgradeHead('/collab', 'Origin: http://127.0.0.1:8080\r\n');
    await Promise.all(Array.from({ length: 300 }, (_, i) => new Promise<void>((resolve) => {
      const s = net.connect(server.port, '127.0.0.1', () => {
        s.write(head);
        setTimeout(() => { s.resetAndDestroy(); resolve(); }, i % 7); // 0 to 6 ms: before, during and after the guard's awaited step
      });
      s.on('error', () => { resolve(); });
    })));
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200); // answered after the resets: the server has been through them
    expect(server.alive).toBe(true);
    expect(faults(server)).toEqual([]);
  });

  it('2,000 random request lines and header sets: the process survives and no fault fires', async () => {
    let seed = 20261120;
    const rnd = (n: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const targets = ['/', '/collab', '//', '//[', '/[', 'http://[', 'http://', '*', '/%', '/%zz', '/collab?x=%', '//collab', '\\\\', '/collab/../..', 'ws://x/collab', ':', '/\u0000'];
    const junk = (): string => Array.from({ length: rnd(40) }, () => String.fromCharCode(32 + rnd(95))).join('');
    const headers = ['Origin: http://127.0.0.1:8080', 'Origin: null', 'X-Forwarded-For: ::ffff:[', 'X-Forwarded-For: ,,,', 'Host: [', 'Host:', 'Connection: Upgrade', 'Upgrade: websocket', 'Upgrade: h2c', 'Sec-WebSocket-Key: !!', 'Content-Length: 5', 'Transfer-Encoding: chunked'];
    const batch: Promise<string>[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const target = rnd(3) === 0 ? junk() : targets[rnd(targets.length)] ?? '/';
      const hs = Array.from({ length: rnd(6) }, () => (rnd(4) === 0 ? junk() : headers[rnd(headers.length)] ?? '')).join('\r\n');
      const upgrade = rnd(2) === 0;
      batch.push(raw(server.port, upgrade ? upgradeHead(target, hs ? `${hs}\r\n` : '') : `${rnd(2) === 0 ? 'GET' : junk()} ${target} HTTP/1.1\r\nHost: x\r\n${hs}\r\n\r\n`));
      if (batch.length === 50) { await Promise.all(batch.splice(0)); }
    }
    await Promise.all(batch);
    expect(server.alive).toBe(true);
    expect(faults(server)).toEqual([]);
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
  }, 120_000);
});
