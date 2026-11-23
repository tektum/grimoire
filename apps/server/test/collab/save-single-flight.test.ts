import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createCollabLog, createConversionGate, createSaver } from '@tektum/grimoire-adapter-collab-hocuspocus/testing';
import { createMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import type { PooledMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';

// Verification finding F1: a page whose text is a very long run of `]` never converts in time. While one conversion of it runs, later saves of the SAME
// page must not start their own: the saver keeps at most one conversion per page in flight (and one waiting, latest wins). The REAL pool, with short
// time limits injected so the scenario takes seconds, not the 140 s of the original measurement. No database.
// The hostile page's time limit is derived, not a literal: the honest page is converted by the OTHER worker while the hostile one runs, and that worker's first
// conversion starts its editor (about 120 ms idle, 300 to 600 ms on a loaded 2-CPU runner, seen: one 616 ms against a literal 600 ms). The limit is a multiple of the
// slowest cold conversion measured on a throwaway pool right before, with 600 ms as the floor so the scenario still takes seconds, not minutes.
const paragraph = (text: string): Y.Doc => {
  const d = new Y.Doc();
  const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); t.insert(0, text); p.insert(0, [t]);
  d.getXmlFragment('prosemirror').insert(0, [p]);
  return d;
};
const FLOOR_MS = 600;
const HEADROOM = 5;
const CEILING_MS = 5_000; // a pathological measurement must not make the limit meaningless (production: 10 s)
const POOL_SIZE = Number(process.env['SINGLE_FLIGHT_PROBE_POOL_SIZE'] ?? '2'); // 1 only to show that the test fails when both conversions share one worker
let pool: PooledMarkdownConverter;
beforeAll(async () => {
  const probe = createMarkdownConverter({ poolSize: 2 });
  const honestState = Y.encodeStateAsUpdate(paragraph('hello *world*'));
  const started = Date.now();
  await Promise.all([probe.toMarkdown(honestState), probe.toMarkdown(honestState)]); // both workers cold, as in the scenario
  const coldMs = Date.now() - started;
  await probe.close();
  const timeoutMs = Math.min(CEILING_MS, Math.max(FLOOR_MS, HEADROOM * coldMs));
  process.stderr.write(`single-flight: cold conversion ${String(coldMs)} ms, hostile limit ${String(timeoutMs)} ms, pool ${String(POOL_SIZE)}\n`);
  pool = createMarkdownConverter({ poolSize: POOL_SIZE, timeoutMs, maxStateBytes: HOSTILE_STATE_LIMIT });
}, 30_000);
afterAll(async () => { await pool.close(); });

/**
 * A page whose Markdown the parser cannot verify within these limits: 20,000 runs under nested marks (about 2 MB of state), whose verifying parse takes seconds
 * (7 s on a 32-core machine) and grows with the square of the runs. A run of brackets was used before, until the serialiser began to escape them.
 */
const HOSTILE_RUNS = 20_000;
const HOSTILE_STATE_LIMIT = 8_000_000;
const NESTED = [{ emphasis: {}, strong: {} }, { strong: {} }, { emphasis: {}, strike_through: {} }];
const hostileDoc = (): Y.Doc => {
  const d = new Y.Doc();
  const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText();
  for (let i = 0; i < HOSTILE_RUNS; i++) t.insert(t.length, 'a', NESTED[i % 3]);
  p.insert(0, [t]);
  d.getXmlFragment('prosemirror').insert(0, [p]);
  return d;
};
const isHostile = (state: Uint8Array): boolean => state.byteLength > 50_000;

/** The real pool, watched: how many conversions of the hostile page are in the pool at once, and which states reached it. */
function watched() {
  const seen = { now: 0, max: 0, calls: 0, last: undefined as Uint8Array | undefined };
  const inner: MarkdownConverter = {
    seed: (m, k) => pool.seed(m, k), reseed: (m, k) => pool.reseed(m, k), close: () => pool.close(),
    async toMarkdown(state) {
      const hostile = isHostile(state);
      if (hostile) { seen.now++; seen.calls++; seen.max = Math.max(seen.max, seen.now); seen.last = state; }
      try { return await pool.toMarkdown(state); } finally { if (hostile) seen.now--; }
    },
  };
  return { seen, inner };
}

describe('one conversion in flight per page (real pool)', () => {
  // Driven by events, not by a clock: the first save is sent, the test waits until its conversion has reached the pool, and then the other 29 saves are sent
  // at once while it runs (it cannot end before its time limit: the page is a run of nested marks the parser cannot finish). Every count below follows from that order.
  it.each([['breaker off (the verifier\'s worst case)', true], ['breaker as in production', false]])('30 saves of one page during one running conversion, %s', async (_n, disabled) => {
    const { seen, inner } = watched();
    const gate = createConversionGate(inner, { concurrency: 2, waitMs: 5_000 });
    const saver = createSaver({ converter: gate, log: createCollabLog(new FakeLogger()), breaker: { disabled } });
    const doc = hostileDoc();
    const edit = (i: number): Uint8Array => { doc.getXmlFragment('prosemirror').toArray()[0]!.toArray()[0]!.insert(i, 'x'); return Y.encodeStateAsUpdate(doc); }; // a different state at each save
    // Every state is made before the first save is sent: encoding a 2 MB document 30 times inside the window would block this process for longer than the limit.
    const states = Array.from({ length: 30 }, (_, i) => edit(i));
    const hostileSaves = [saver.convert('hostile', states[0]!)];
    await vi.waitFor(() => { expect(seen.calls).toBe(1); }, { timeout: 5_000, interval: 5 });
    let firstSettled = false;
    void hostileSaves[0]!.then(() => { firstSettled = true; });
    let lastState = new Uint8Array();
    for (let i = 1; i < 30; i++) { lastState = states[i]!; hostileSaves.push(saver.convert('hostile', lastState)); }
    const honest = await saver.convert('honest', Y.encodeStateAsUpdate(paragraph('hello *world*')));
    const servedWhileHostileRan = !firstSettled;
    const results = await Promise.all(hostileSaves);
    expect(seen.max).toBe(1); // never two workers for one page
    expect(honest.ok).toBe(true); // another page was served ...
    expect(servedWhileHostileRan).toBe(true); // ... while the hostile page's conversion was still running
    expect(results.filter((r) => !r.ok && r.reason === 'superseded')).toHaveLength(28); // saves 2 to 29 were replaced by a newer one
    expect(results[0]).toMatchObject({ ok: false, reason: 'timeout' });
    expect(seen.now).toBe(0); // nothing is running ...
    expect(gate.waiting()).toBe(0); // ... nor waiting
    if (disabled) {
      expect(seen.calls).toBe(2); // the first and the newest, nothing in between
      expect(Buffer.from(seen.last!).equals(Buffer.from(lastState))).toBe(true); // the newest state was converted last (latest wins)
      expect(results.at(-1)).toMatchObject({ ok: false, reason: 'timeout' }); // the newest save got a real answer, not a "superseded" one
    } else {
      expect(seen.calls).toBe(1); // the timeout opened the breaker, which answers the waiting save
      expect(results.at(-1)).toEqual({ ok: false, busy: false, reason: 'breaker-open' });
    }
  }, 60_000);
});
