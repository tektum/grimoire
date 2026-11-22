import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Extension } from '@hocuspocus/server';
import { PAGE } from '../host/support.js';
import { connect, eventually, startLive } from '../host/live-support.js';
import type { Client, Live } from '../host/live-support.js';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import type { CollabConfig } from '@tektum/grimoire-core/ports/config';

const lives: Live[] = [];
const clients: Client[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(lives.splice(0).map((l) => l.stop()));
});
async function live(collab: Partial<CollabConfig>, options: Parameters<typeof startLive>[1] = {}): Promise<Live> {
  const l = await startLive('member', options, (t) => { t.deps = { ...t.deps, config: makeFakeConfig({ collab: { debounceMs: 100, maxDebounceMs: 500, ...collab } }) }; });
  lives.push(l); l.t.pages.seed(PAGE);
  return l;
}
const client = (l: Live): Client => { const c = connect(l, PAGE); clients.push(c); return c; };
const open = (l: Live): number => l.host.hocuspocus?.getDocumentsCount() ?? -1;

describe('idle unload (R4.49)', () => {
  it('Hocuspocus unloads a page right after its last save: no extra waiting, and the page is stored first', async () => {
    const l = await live({ idleUnloadSeconds: 2 });
    const a = client(l); await eventually(() => a.provider.synced, 3000, 'synced');
    a.text.insert(0, 'saved');
    await eventually(() => l.t.pages.calls.store > 0, 3000, 'stored');
    const t0 = Date.now(); a.destroy();
    await eventually(() => open(l) === 0, 1500, 'unloaded');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(l.t.pages.calls.store).toBeGreaterThan(0);
  });

  it('a page that stays loaded without connections is unloaded after the idle time (2 s), no earlier than its save and no later than 2 s + 5 s', async () => {
    let blockUntil = Infinity;
    let blocked = false;
    // Stands in for whatever could keep a page loaded after its last connection: refuses every unload attempt until the test has seen the first one refused (counted from the server's own attempt, not a time window).
    const blocker: Extension = { extensionName: 'blocker', async beforeUnloadDocument() { if (Date.now() < blockUntil) { blocked = true; throw new Error(''); } } };
    const l = await live({ idleUnloadSeconds: 2 }, { extensions: [blocker] });
    const a = client(l); await eventually(() => a.provider.synced, 3000, 'synced');
    a.text.insert(0, 'saved');
    await eventually(() => l.t.pages.calls.store > 0, 3000, 'stored');
    const stores = l.t.pages.calls.store;
    const t0 = Date.now(); a.destroy();
    await eventually(() => blocked, 10_000, 'first unload attempt refused');
    blockUntil = 0; // from here on the idle sweep may unload
    expect(open(l)).toBe(1); // the refused attempt left it loaded; `took` below shows it stayed loaded until the idle time (nothing can reload it)
    await eventually(() => open(l) === 0, 7000, 'unloaded by the idle sweep');
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThanOrEqual(7000);
    expect(l.t.pages.calls.store).toBe(stores); // it was saved before, and nothing was lost by unloading
  }, 20_000);
});

describe('memory guard, injected reader (R4.49)', () => {
  it('above 80% of the limit a connection to an unopened page gets memory-guard; a page already open still takes connections', async () => {
    let used = 0;
    const l = await live({ memoryLimitBytes: 1000, memoryGuardPercent: 80 }, { memoryUsed: () => used });
    const first = client(l); await eventually(() => first.provider.synced, 3000, 'synced');
    used = 801;
    const second = client(l); await eventually(() => second.provider.synced, 3000, 'open page accepted');
    l.t.pages.seed('0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11');
    const other = connect(l, '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11'); clients.push(other);
    await eventually(() => other.failures.length > 0, 3000, 'refused');
    expect(other.failures).toEqual(['memory-guard']);
    used = 800;
    other.provider.destroy();
    const retry = connect(l, '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11'); clients.push(retry);
    await eventually(() => retry.provider.synced, 3000, 'accepted at exactly 80%');
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.limit_hit' && e.fields['limit'] === 'memory')).toHaveLength(1);
  });
});

describe('editing round trip (reported, not a limit)', () => {
  it('1,000 small edits, each acknowledged by a second client', async () => {
    // Sequential edits arrive faster than 30 messages a second, which the default rate limit (300 per 10 s) is meant to stop: lifted here so the cost of the hooks is what is measured.
    const l = await live({ messagesPerWindow: 1_000_000 });
    const a = client(l); const b = client(l);
    await eventually(() => a.provider.synced && b.provider.synced, 3000, 'synced');
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      a.text.insert(a.text.length, 'x');
      const want = i + 1;
      while (b.text.length < want) await tick();
    }
    const ms = performance.now() - t0;
    // The reporter hides console output: the number goes to a file for the findings note.
    appendFileSync(join(tmpdir(), 'grimoire-t10-roundtrip.txt'), `total_ms=${ms.toFixed(0)} mean_ms=${(ms / 1000).toFixed(3)}\n`);
    expect(b.text.length).toBe(1000);
  }, 60_000);
});
