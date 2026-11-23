import { afterEach, describe, expect, it } from 'vitest';
import { PAGE } from '../host/support.js';
import { connect, eventually, startLive } from '../host/live-support.js';
import type { Client, Live } from '../host/live-support.js';

const lives: Live[] = [];
const clients: Client[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(lives.splice(0).map((l) => l.stop()));
});

const wrap = (e: number | undefined): string => `g1.${Buffer.from(JSON.stringify({ t: 't', ...(e === undefined ? {} : { e }) })).toString('base64url')}`;
const setEpoch = (l: Live, epoch: number): void => {
  const p = l.t.world.pages.find((x) => x.id === PAGE);
  if (p) p.epoch = epoch;
  l.t.pages.epoch = epoch;
};
/** A client the way the web client does it: the token function returns the epoch the server last told it. */
function tab(l: Live): { c: Client; recorded: () => number | undefined; reasons: string[] } {
  const reasons: string[] = [];
  let recorded: number | undefined;
  const c = connect(l, PAGE, () => wrap(recorded), {
    onStateless: (p: string) => { const m = JSON.parse(p) as { kind?: string; epoch?: number }; if (m.kind === 'epoch') recorded = m.epoch; },
  });
  c.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
  clients.push(c);
  return { c, recorded: () => recorded, reasons };
}

/** What the server passes to each document connection of the page when it closes it (the provider is told only the reason). */
function spyCloses(l: Live): { code: number; reason: string }[] {
  const seen: { code: number; reason: string }[] = [];
  for (const c of l.host.hocuspocus?.documents.get(PAGE)?.getConnections() ?? []) {
    const original = c.close.bind(c);
    c.close = (event) => { if (event) seen.push({ code: event.code ?? 0, reason: event.reason ?? '' }); original(event); };
  }
  return seen;
}

describe('the stale tab after a reset or restore', { timeout: 30_000 }, () => {
  it('is closed with 4409, refused on its own reconnect, and none of its edits are saved; a fresh client works at the new epoch', async () => {
    const l = await startLive('member'); lives.push(l);
    l.t.pages.seed(PAGE); setEpoch(l, 1);
    const a = tab(l);
    await eventually(() => a.c.provider.synced && a.recorded() === 1, 3000, 'A synced and told the epoch');
    const before = l.t.pages.rows.get(PAGE);
    const writes = l.t.pages.writes.length;

    setEpoch(l, 2); // the reset: the page's epoch is raised while A is connected
    a.c.text.insert(0, 'old-edit'); // A's next save is refused for the epoch, which closes the page's connections with 4409
    await eventually(() => a.reasons.includes('stale-epoch'), 5000, 'A closed with the stale-epoch reason');
    // A document close leaves the socket up and the provider does not reconnect by itself: a client reads the reason and reloads. The tab here
    // instead loses its network, and the provider's automatic reconnect carries the epoch it recorded.
    a.c.provider.configuration.websocketProvider.webSocket?.close();
    await eventually(() => a.c.failures.includes('stale-epoch'), 10_000, 'A refused on its own reconnect');

    expect(l.t.pages.rows.get(PAGE)).toEqual(before);
    expect(l.t.pages.writes).toHaveLength(writes);

    const fresh = tab(l);
    await eventually(() => fresh.c.provider.synced && fresh.recorded() === 2, 3000, 'fresh client at epoch 2');
    expect(fresh.c.text.toString()).not.toContain('old-edit');
    fresh.c.text.insert(0, 'new');
    const reader = tab(l);
    await eventually(() => reader.c.text.toString() === 'new', 3000, 'edit arrives');
  });
});

describe('closeConnections with a refusal reason', () => {
  it('closes a page\'s connections with the reason\'s code, and the client sees the reason', async () => {
    const l = await startLive('member'); lives.push(l);
    l.t.pages.seed(PAGE);
    const a = tab(l);
    await eventually(() => a.c.provider.synced, 3000, 'synced');
    const seen = spyCloses(l);
    await l.host.closeConnections({ documentName: PAGE }, 'stale-epoch');
    await eventually(() => a.reasons.includes('stale-epoch'), 3000, 'client told');
    expect(seen).toEqual([{ code: 4409, reason: 'stale-epoch' }]);
  });

  it('closes a user\'s documents with the reason\'s code; an unknown reason gets the fallback code, never an open connection', async () => {
    const l = await startLive('member'); lives.push(l);
    l.t.pages.seed(PAGE);
    const a = tab(l);
    await eventually(() => a.c.provider.synced, 3000, 'synced');
    const seen = spyCloses(l);
    await l.host.closeConnections({ userId: '0a000000-0000-4000-8000-000000000001' }, 'not-a-reason');
    await eventually(() => a.reasons.includes('not-a-reason'), 3000, 'client told');
    expect(seen).toEqual([{ code: 4500, reason: 'not-a-reason' }]);
  });

  it('without a reason the existing closes are unchanged: a user\'s documents end with 1001 going away', async () => {
    const l = await startLive('member'); lives.push(l);
    l.t.pages.seed(PAGE);
    const a = tab(l);
    await eventually(() => a.c.provider.synced, 3000, 'synced');
    const seen = spyCloses(l);
    await l.host.closeConnections({ userId: '0a000000-0000-4000-8000-000000000001' });
    await eventually(() => seen.length > 0, 3000, 'closed');
    expect(seen).toEqual([{ code: 1001, reason: 'going away' }]);
  });
});
