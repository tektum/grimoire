import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer } from '../server/support/harness.js';
import { RawClient, stateOfSize, syncUpdateFrame } from './limits-support.js';
import { eventually, newPage, seedPage, wsUrl } from './support.js';

const DB = `grimoire_m3t01b_bytes_${String(process.pid)}`;
const pages = Array.from({ length: 6 }, newPage);
const token = (user: string) => `dev:test-secret-0123456789abcdef:${user}:member`;
const running: RawClient[] = [];
const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
afterAll(async () => { for (const c of running) c.close(); for (const s of servers) await s.kill(); await dropTestDatabase(DB); });

const open = async (server: Awaited<ReturnType<typeof startServer>>, page: string, user: string) => { const c = await RawClient.open(wsUrl(server.port), page, token(user)); running.push(c); return c; };

/** Sync step 1 (a state vector), which the server answers with step 2: a message round trip that changes nothing. */
const stateVectorFrame = (page: string): Uint8Array<ArrayBuffer> => { const sv = Y.encodeStateVector(new Y.Doc()); return Uint8Array.from([...Buffer.from([page.length]), ...Buffer.from(page), 0, 0, sv.length, ...sv]); };

describe('authenticated per-user byte budget', () => {
  it('300 x 100 KB on 5 pages in 10 s is refused past the budget (4429) after about 2 MiB, and a second user round trip stays under 200 ms', async () => {
    const server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW: '10000', GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100', GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: '10000' } });
    servers.push(server);
    const heavy = await Promise.all(pages.slice(0, 5).map((p) => open(server, p, 'heavy')));
    const light = await open(server, pages[5] as string, 'light');
    const update = stateOfSize(102400);
    let sent = 0; let firstRefusalAt: number | undefined; let worst = 0;
    const started = performance.now();
    for (let tick = 0; tick < 100; tick++) { // 3 messages every 100 ms: 300 messages in 10 s, 3 MB/s against 2 MiB/s
      for (let i = 0; i < 3; i++) {
        const page = sent % 5;
        if (!heavy[page]?.closed) heavy[page]?.send(syncUpdateFrame(pages[page] as string, update));
        sent++;
      }
      if (firstRefusalAt === undefined && heavy.some((c) => c.closed !== undefined)) firstRefusalAt = sent;
      if (tick % 10 === 5) { // the other user's round trip while the flood runs
        const before = light.frames.length; const t0 = performance.now();
        light.send(stateVectorFrame(pages[5] as string));
        await eventually(() => (light.frames.length > before ? true : undefined), 2000, 'second user answered');
        worst = Math.max(worst, performance.now() - t0);
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, started + (tick + 1) * 100 - performance.now())); });
    }
    expect(heavy.filter((c) => c.closed?.code === 4429)).not.toHaveLength(0);
    expect(heavy.flatMap((c) => (c.closed === undefined || c.closed.reason === 'rate-limited' ? [] : [`${String(c.closed.code)} ${c.closed.reason}`]))).toEqual([]); // any other close names its code and reason
    expect(firstRefusalAt).toBeGreaterThanOrEqual(20); // about 2 MiB of 100 KB messages went through first
    expect(light.closed).toBeUndefined();
    expect(worst).toBeLessThan(200);
  }, 60_000);
});
beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); for (const page of pages) await seedPage(DB, page); }, 60000);
