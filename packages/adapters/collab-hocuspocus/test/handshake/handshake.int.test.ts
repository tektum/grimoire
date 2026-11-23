import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { KNOWN_PAGES, PAGE } from '../host/support.js';
import { connect, eventually, startLive } from '../host/live-support.js';
import type { Client, Live } from '../host/live-support.js';

const lives: Live[] = [];
const clients: Client[] = [];
const live = async (): Promise<Live> => {
  const l = await startLive('member');
  l.t.pages.seed(PAGE);
  lives.push(l);
  return l;
};
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(lives.splice(0).map((l) => l.stop()));
});

const wrap = (o: { t?: string; v?: string; e?: number }): string => `g1.${Buffer.from(JSON.stringify({ t: 't', ...o })).toString('base64url')}`;
const setEpoch = (l: Live, epoch: number): void => { const p = l.t.world.pages.find((x) => x.id === PAGE); if (p) p.epoch = epoch; };
const open = (l: Live, token: string, stateless: string[] = []): Client => {
  const c = connect(l, PAGE, token, { onStateless: (p: string) => { stateless.push(p); } });
  clients.push(c);
  return c;
};

const withTombstones = (): Uint8Array => {
  const d = new Y.Doc();
  const t = d.getText('prosemirror');
  t.insert(0, 'abc');
  t.delete(1, 1);
  return Y.encodeStateAsUpdate(d);
};

describe('connect-time handshake over real sockets', () => {
  it('a first connect without e is told the epoch exactly once; a reconnect with that e is accepted', async () => {
    const l = await live(); setEpoch(l, 3);
    const told: string[] = [];
    const first = open(l, wrap({}), told);
    await eventually(() => first.provider.synced, 3000, 'first synced');
    await eventually(() => told.length > 0, 3000, 'epoch message');
    expect(told).toEqual([JSON.stringify({ grimoire: 1, kind: 'epoch', epoch: 3 })]);
    const again = open(l, wrap({ e: 3 }));
    await eventually(() => again.provider.synced, 3000, 'reconnect synced');
    expect(again.failures).toEqual([]);
  });

  it('a version below the minimum is refused client-too-old before the verifier is called', async () => {
    const l = await live();
    l.t.deps.config = { ...l.t.deps.config, minClientVersion: '1.2.0' };
    const calls = l.t.verifier.calls;
    const old = open(l, wrap({ v: '1.1.9' }));
    await eventually(() => old.failures.length > 0, 3000, 'refusal');
    expect(old.failures).toEqual(['client-too-old']);
    expect(l.t.verifier.calls).toBe(calls);
    for (const v of ['1.2.0', '2.0.0']) {
      const ok = open(l, wrap({ v }));
      await eventually(() => ok.provider.synced, 3000, `${v} synced`);
    }
  });

  it('a recorded epoch that differs from the page, older or newer, is refused stale-epoch', async () => {
    const l = await live(); setEpoch(l, 4);
    for (const e of [3, 9]) {
      const c = open(l, wrap({ e }));
      await eventually(() => c.failures.length > 0, 3000, `refusal for e=${String(e)}`);
      expect(c.failures).toEqual(['stale-epoch']);
    }
  });

  it('no merge: a client that offers old edits without knowing the epoch is refused and the page is untouched', async () => {
    const l = await live(); setEpoch(l, 2);
    const told: string[] = [];
    const stale = connect(l, PAGE, wrap({}), { onStateless: (p: string) => { told.push(p); } });
    clients.push(stale);
    stale.text.insert(0, 'old-edit'); // made offline, before any sync
    await eventually(() => told.some((m) => m.includes('"stale-epoch"')), 3000, 'stale-epoch message');
    const reader = open(l, wrap({ e: 2 }));
    await eventually(() => reader.provider.synced, 3000, 'reader synced');
    expect(reader.text.toString()).toBe('');
  });

  it('a first connect with an empty document is not refused on a page past epoch 0', async () => {
    const l = await live(); setEpoch(l, 2);
    const c = open(l, wrap({}));
    await eventually(() => c.provider.synced, 3000, 'synced');
    c.text.insert(0, 'later edits are not inspected');
    const reader = open(l, wrap({ e: 2 }));
    await eventually(() => reader.text.toString() === 'later edits are not inspected', 3000, 'edit arrives');
    expect(c.failures).toEqual([]);
  });

  it('a first connect to a page that has deleted text is not refused: the page\'s own deletions offered back carry no new content', async () => {
    const l = await live(); setEpoch(l, 2); l.t.pages.seed(PAGE, withTombstones());
    const c = open(l, wrap({}));
    await eventually(() => c.provider.synced, 3000, 'synced');
    expect(c.text.toString()).toBe('ac');
    c.text.insert(2, '!');
    const reader = open(l, wrap({ e: 2 }));
    await eventually(() => reader.text.toString() === 'ac!', 3000, 'edit arrives');
    expect(c.failures).toEqual([]);
  });

  it('order with admission: refusals for stale-epoch and client-too-old take no reservation, so a one-document user can still open two pages in turn', async () => {
    const l = await startLive('member', {}, (t) => { Object.assign(t.deps, { config: makeFakeConfig({ minClientVersion: '1.2.0', collab: { maxDocumentsPerUser: 1 } }) }); });
    lives.push(l);
    const other = KNOWN_PAGES[1] as string;
    l.t.pages.seed(PAGE); l.t.pages.seed(other); setEpoch(l, 4);
    for (const token of [wrap({ e: 3 }), wrap({ e: 9 }), wrap({ v: '1.1.9' }), wrap({ e: 3 }), wrap({ e: 9 })]) {
      const c = open(l, token);
      await eventually(() => c.failures.length > 0, 3000, 'refusal');
    }
    const first = connect(l, PAGE, wrap({ e: 4 })); clients.push(first);
    await eventually(() => first.provider.synced, 3000, 'the one allowed document opens after five refusals');
    first.destroy();
    await eventually(() => (l.host.hocuspocus?.documents.get(PAGE)?.getConnectionsCount() ?? 0) === 0 && l.host.hocuspocus?.documents.has(PAGE) !== true, 5000, 'the server released the first page');
    const second = connect(l, other, wrap({})); clients.push(second);
    await eventually(() => second.provider.synced, 5000, 'a second page opens once the first is closed');
    expect(second.failures).toEqual([]);
  });
});
