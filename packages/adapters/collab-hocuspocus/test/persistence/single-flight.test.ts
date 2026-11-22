import type { ConvertResult, MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { describe, expect, it, vi } from 'vitest';
import { createCollabLog } from '../../src/events.js';
import { createSaver, createConversionGate, WAITING_DETAIL } from '../../src/save.js';
import { setup, textOf } from './support.js';

/** A converter whose conversions finish when the test says; `started` lists the first byte of each state it was given, in order. */
function controlled() {
  const started: number[] = [];
  const finish: ((r: ConvertResult) => void)[] = [];
  const base = new FakeMarkdownConverter();
  const converter: MarkdownConverter = {
    seed: (m, k) => base.seed(m, k), reseed: (m, k) => base.reseed(m, k), close: () => base.close(),
    toMarkdown: (state) => new Promise((resolve) => { started.push(state[0] ?? -1); finish.push(resolve); }),
  };
  const log = createCollabLog({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never);
  const saver = createSaver({ converter: createConversionGate(converter, { concurrency: 2 }), log });
  const ok = (n: number): ConvertResult => ({ ok: true, markdown: `m${n}`, text: `m${n}` });
  return { started, finish, saver, ok };
}
/** Waits until the saver has handed `n` states to the converter (event-driven: no fixed number of turns). */
const startedCount = (r: { started: number[] }, n: number): Promise<void> => vi.waitFor(() => { expect(r.started.length).toBeGreaterThanOrEqual(n); }, { timeout: 2000, interval: 5 });


describe('the saver keeps one conversion in flight per page; the newest waiting state wins', () => {
  it('a save during a running conversion of the same page starts nothing; a still newer one replaces it; the newest is converted when the first ends', async () => {
    const r = controlled();
    const first = r.saver.convert('p', Uint8Array.of(1));
    const second = r.saver.convert('p', Uint8Array.of(2));
    const third = r.saver.convert('p', Uint8Array.of(3));
    await startedCount(r, 1);
    expect(r.started).toEqual([1]);
    expect(await second).toEqual({ ok: false, busy: true, reason: 'superseded' });
    r.finish[0]!(r.ok(1));
    expect(await first).toMatchObject({ ok: true, markdown: 'm1' });
    await startedCount(r, 2);
    expect(r.started).toEqual([1, 3]);
    r.finish[1]!(r.ok(3));
    expect(await third).toMatchObject({ ok: true, markdown: 'm3' });
  });

  it('another page is converted at once, meanwhile', async () => {
    const r = controlled();
    void r.saver.convert('p', Uint8Array.of(1));
    void r.saver.convert('q', Uint8Array.of(9));
    await startedCount(r, 2);
    expect(r.started).toEqual([1, 9]);
  });

  it('the running conversion timing out opens the breaker: the waiting save is answered by it, nothing more is converted', async () => {
    const r = controlled();
    const first = r.saver.convert('p', Uint8Array.of(1));
    const second = r.saver.convert('p', Uint8Array.of(2));
    await startedCount(r, 1);
    r.finish[0]!({ ok: false, reason: 'timeout', detail: 'the conversion exceeded its time limit' });
    expect(await first).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await second).toEqual({ ok: false, busy: false, reason: 'breaker-open' });
    expect(r.started).toEqual([1]);
  });

  it('once the page is idle again the next save starts a conversion', async () => {
    const r = controlled();
    const first = r.saver.convert('p', Uint8Array.of(1));
    await startedCount(r, 1);
    r.finish[0]!(r.ok(1));
    await first;
    void r.saver.convert('p', Uint8Array.of(2));
    await startedCount(r, 2);
    expect(r.started).toEqual([1, 2]);
  });
});

describe('a conversion that throws', () => {
  it('still answers the save waiting behind it (never left pending)', async () => {
    const started: number[] = [];
    const base = new FakeMarkdownConverter();
    const converter: MarkdownConverter = {
      seed: (m, k) => base.seed(m, k), reseed: (m, k) => base.reseed(m, k), close: () => base.close(),
      toMarkdown: (state) => { started.push(state[0] ?? -1); return Promise.resolve({ ok: false, reason: 'timeout', detail: 'the conversion exceeded its time limit' }); },
    };
    const throwing = () => { throw new Error('log sink down'); };
    const log = createCollabLog({ debug: throwing, info: throwing, warn: throwing, error: throwing } as never);
    const saver = createSaver({ converter: createConversionGate(converter), log, breaker: { disabled: true } });
    const first = saver.convert('p', Uint8Array.of(1));
    const second = saver.convert('p', Uint8Array.of(2));
    await expect(first).rejects.toThrow('log sink down');
    expect(await second).toEqual({ ok: false, busy: false, reason: 'internal' });
    expect(started).toEqual([1, 2]);
  });
});

describe('the production save path (the page extension) coalesces too', () => {
  /** A converter whose conversions finish when the test says; `texts` lists the text of each state it was given, in order. */
  function held() {
    const texts: string[] = [];
    const finish: ((r: ConvertResult) => void)[] = [];
    const base = new FakeMarkdownConverter();
    const converter: MarkdownConverter = {
      seed: (m, k) => base.seed(m, k), reseed: (m, k) => base.reseed(m, k), close: () => base.close(),
      toMarkdown: (state) => new Promise((resolve) => { texts.push(textOf(state)); finish.push(resolve); }),
    };
    return { texts, finish, converter };
  }
  it('stores of one page that arrive while a conversion runs share ONE waiting save: five stores, two conversions, the second holding every edit', async () => {
    const h = held();
    const s = setup({}, 'member', h.converter);
    await s.edit('a');
    const stores = [s.store()];
    await vi.waitFor(() => { expect(h.texts).toEqual(['a']); });
    for (const text of ['b', 'c', 'd', 'e']) { await s.edit(text); stores.push(s.store()); }
    h.finish[0]!({ ok: true, markdown: 'm1', text: 'm1' });
    await vi.waitFor(() => { expect(h.texts).toHaveLength(2); });
    expect(h.texts[1]).toBe('edcba'); // encoded when it started: every edit made while the first ran
    h.finish[1]!({ ok: true, markdown: 'm2', text: 'm2' });
    await Promise.all(stores);
    expect(h.texts).toHaveLength(2); // not five
  });

  it('the retry timer is cancelled when a save of the page starts, so a timer-started save never waits beside the page\'s own saves (one waiting slot per page is enough)', async () => {
    const h = held();
    const s = setup({}, 'member', h.converter);
    await s.edit('a');
    const first = s.store();
    await vi.waitFor(() => { expect(h.texts).toEqual(['a']); });
    h.finish[0]!({ ok: false, reason: 'timeout', detail: WAITING_DETAIL }); // busy: the state is stored and a retry is scheduled
    await first;
    await vi.waitFor(() => { expect(s.waits).toHaveLength(1); });
    await s.edit('b');
    const running = s.store(); // starts: this cancels the scheduled retry
    await vi.waitFor(() => { expect(h.texts).toHaveLength(2); });
    s.waits[0]!.release(); // the cancelled timer's wait is released: nothing may start from it
    h.finish[1]!({ ok: true, markdown: 'm', text: 'm' });
    await running;
    expect(s.events('collab.convert_retry')).toEqual([]);
    expect(h.texts).toHaveLength(2); // no third conversion from the cancelled timer
  });
});
