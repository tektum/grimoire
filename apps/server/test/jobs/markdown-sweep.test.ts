import { describe, expect, it } from 'vitest';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakePageStore } from '@tektum/grimoire-core/testing/fake-page-store';
import { createMarkdownSweep, SWEEP_QUIET_MS } from '../../src/jobs/markdown-sweep.js';

const MIN = 60_000;
const T0 = 10_000 * MIN;
const state = (n: number) => new Uint8Array([n]);

function world(options: { convert?: FakeMarkdownConverter } = {}) {
  const pages = new FakePageStore();
  const converter = options.convert ?? new FakeMarkdownConverter({ convert: { ok: true, markdown: '# fixed', text: 'fixed' } });
  let now = T0;
  const failures: [string, string][] = [];
  const sweep = createMarkdownSweep({ pages, converter, now: () => now, onConvertFailure: (id, reason) => failures.push([id, reason]) });
  const stalePage = (id: string, sinceMinutesAgo: number, bytes = state(1)) => { pages.seed(id, bytes); pages.stale.set(id, T0 - sinceMinutesAgo * MIN); };
  return { pages, converter, sweep, failures, stalePage, advance: (ms: number) => { now += ms; }, run: () => sweep(new AbortController().signal) };
}

describe('the markdown sweep', () => {
  it('re-derives the Markdown of a page whose Markdown is stale and clears the mark', async () => {
    const w = world();
    w.stalePage('p1', 5);
    expect(await w.run()).toEqual({ repaired: 1, skipped: 0, failed: 0 });
    expect([w.pages.markdowns.get('p1'), w.pages.texts.get('p1'), w.pages.stale.get('p1')]).toEqual(['# fixed', 'fixed', null]);
    expect(await w.run()).toEqual({ repaired: 0, skipped: 0, failed: 0 });
  });

  it('leaves a page alone that was touched in the last two minutes, as a load optimisation', async () => {
    const w = world();
    w.stalePage('p1', 1);
    expect(SWEEP_QUIET_MS).toBe(2 * MIN);
    expect(await w.run()).toEqual({ repaired: 0, skipped: 0, failed: 0 });
    expect(w.converter.convertCalls).toHaveLength(0);
    w.advance(2 * MIN);
    expect((await w.run()).repaired).toBe(1);
  });

  it('skips, and never overwrites, a page that was saved between the read and the write', async () => {
    const w = world();
    w.stalePage('p1', 5);
    w.converter.enqueueConvert(async () => {
      await w.pages.store('p1', { kind: 'converted', state: state(2), markdown: '# typed meanwhile', text: 't', epoch: 0, editedAt: T0 });
      return { ok: true, markdown: '# from the old state', text: 'old' };
    });
    expect(await w.run()).toEqual({ repaired: 0, skipped: 1, failed: 0 });
    expect(w.pages.markdowns.get('p1')).toBe('# typed meanwhile');
    expect(w.pages.rows.get('p1')).toEqual(state(2));
  });

  it('skips a page whose state was stored without Markdown meanwhile, and repairs it at the next sweep', async () => {
    const w = world();
    w.stalePage('p1', 5);
    w.converter.enqueueConvert(async () => {
      await w.pages.store('p1', { kind: 'state-only', state: state(3), epoch: 0 });
      return { ok: true, markdown: '# old', text: 'old' };
    });
    expect((await w.run()).skipped).toBe(1);
    expect(w.pages.stale.get('p1')).not.toBeNull();
    expect(await w.run()).toEqual({ repaired: 1, skipped: 0, failed: 0 });
    expect(w.pages.markdowns.get('p1')).toBe('# fixed');
  });

  it('keeps the mark of a page that cannot be converted, retries it later with a growing wait, and reports it once an hour', async () => {
    const convert = new FakeMarkdownConverter({ convert: { ok: false, reason: 'invalid-state', detail: 'bad' } });
    const w = world({ convert });
    w.stalePage('p1', 5);
    expect(await w.run()).toEqual({ repaired: 0, skipped: 0, failed: 1 });
    expect(w.pages.stale.get('p1')).not.toBeNull();
    expect(await w.run()).toEqual({ repaired: 0, skipped: 0, failed: 0 }); // backing off: not tried again at once
    expect(convert.convertCalls).toHaveLength(1);
    w.advance(MIN);
    expect((await w.run()).failed).toBe(1); // first wait: one minute
    w.advance(MIN);
    expect((await w.run()).failed).toBe(0); // second wait: two minutes
    w.advance(MIN);
    expect((await w.run()).failed).toBe(1);
    expect(w.failures).toEqual([['p1', 'invalid-state']]); // all within the hour: one report
    w.advance(61 * MIN);
    await w.run();
    expect(w.failures).toHaveLength(2);
  });

  it('takes at most 50 pages a run, and passes over the ones that are backing off', async () => {
    const w = world({ convert: new FakeMarkdownConverter({ convert: (s) => (s[0] === 9 ? { ok: false, reason: 'internal', detail: 'x' } : { ok: true, markdown: 'm', text: 't' }) }) });
    for (let i = 0; i < 60; i += 1) w.stalePage(`ok${String(i).padStart(2, '0')}`, 20 - i / 100);
    w.stalePage('bad', 30, state(9));
    expect((await w.run()).repaired).toBe(49); // `bad` is the oldest and takes one of the 50
    expect((await w.run()).repaired).toBe(11);
  });

  it('is not filled up by pages that keep failing: later stale pages are still reached', async () => {
    const w = world({ convert: new FakeMarkdownConverter({ convert: (s) => (s[0] === 9 ? { ok: false, reason: 'internal', detail: 'x' } : { ok: true, markdown: 'm', text: 't' }) }) });
    for (let i = 0; i < 210; i += 1) w.stalePage(`bad${String(i).padStart(3, '0')}`, 100 - i / 100, state(9));
    for (let i = 0; i < 5; i += 1) await w.run(); // the failing ones are tried, 50 a run, and then back off: more than the 200 the sweep looks at
    for (let i = 0; i < 10; i += 1) w.stalePage(`good${String(i)}`, 20 - i / 100);
    expect((await w.run()).repaired).toBe(10);
  });

  it('forgets the backoff of a page whose mark was cleared, so a later failure of it is reported again', async () => {
    const convert = new FakeMarkdownConverter({ convert: { ok: false, reason: 'internal', detail: 'x' } });
    const w = world({ convert });
    w.stalePage('p1', 5);
    await w.run();
    await w.pages.store('p1', { kind: 'converted', state: state(2), markdown: 'saved', text: 't', epoch: 0, editedAt: T0 }); // an editor save clears the mark
    await w.run(); // the sweep sees p1 is no longer stale and drops what it knew
    w.pages.stale.set('p1', T0 - 5 * MIN);
    expect((await w.run()).failed).toBe(1); // not delayed by the old retry time
    expect(w.failures).toEqual([['p1', 'internal'], ['p1', 'internal']]);
  });

  it('skips a page without state or without a mark, and stops when the signal aborts', async () => {
    const w = world();
    w.pages.seed('nostate', null);
    w.pages.stale.set('nostate', T0 - 9 * MIN);
    w.stalePage('p1', 5);
    const stop = new AbortController();
    stop.abort();
    expect(await w.sweep(stop.signal)).toEqual({ repaired: 0, skipped: 0, failed: 0 });
    expect(await w.run()).toEqual({ repaired: 1, skipped: 1, failed: 0 });
  });
});
