import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { describe, expect, it, vi } from 'vitest';
import { createConversionGate, isBusy, WAITING_DETAIL } from '../../src/save.js';

describe('isBusy', () => {
  it.each([
    ['internal', 'queue-full', true], ['internal', 'closed', true], ['internal', 'one-at-a-time', true], ['timeout', WAITING_DETAIL, true],
    ['timeout', 'the conversion exceeded its time limit', false], ['internal', 'worker-failed', false], ['internal', 'worker-exited', false],
    ['out-of-memory', 'x', false], ['invalid-state', 'x', false], ['too-large', 'x', false], ['too-deep', 'x', false], ['content-lost', 'x', false],
  ] as const)('%s / %s -> busy %s', (reason, detail, busy) => { expect(isBusy(reason, detail)).toBe(busy); });
});

describe('the conversion gate', () => {
  it('admits one call at a time, in submission order', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inner = new FakeMarkdownConverter({
      convert: async (state: Uint8Array) => {
        const id = String(state[0]);
        order.push(`start-${id}`);
        if (state[0] === 1) await held; // the first call stays running until the test lets it end
        order.push(`end-${id}`);
        return { ok: true as const, markdown: id, text: id };
      },
    });
    const gate = createConversionGate(inner);
    const calls = [1, 2, 3].map((n) => gate.toMarkdown(new Uint8Array([n])));
    await vi.waitFor(() => { expect(gate.waiting()).toBe(2); }); // the second and third wait behind the first
    expect(order).toEqual(['start-1']); // neither has started while the first runs
    release();
    const all = await Promise.all(calls);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
    expect(all.map((r) => r.ok && r.markdown)).toEqual(['1', '2', '3']);
  });

  it('a call that waits too long gets the busy answer and never reaches the converter', async () => {
    const inner = new FakeMarkdownConverter({ convert: () => new Promise(() => undefined) });
    const gate = createConversionGate(inner, { waitMs: 30 });
    void gate.toMarkdown(new Uint8Array([1]));
    const r = await gate.toMarkdown(new Uint8Array([2]));
    expect(r).toEqual({ ok: false, reason: 'timeout', detail: WAITING_DETAIL, message: 'The converter is busy with other pages. Try again in a moment.' });
    expect(inner.convertCalls).toHaveLength(1);
    expect(gate.waiting()).toBe(0);
  });

  it('a converter that throws becomes a typed failure and frees its slot', async () => {
    const inner = new FakeMarkdownConverter({ convert: () => { throw new Error('boom'); } });
    const gate = createConversionGate(inner);
    expect(await gate.toMarkdown(new Uint8Array([1]))).toEqual({ ok: false, reason: 'internal', detail: 'worker-failed' });
    expect(await gate.toMarkdown(new Uint8Array([1]))).toEqual({ ok: false, reason: 'internal', detail: 'worker-failed' }); // the exact answer: a leaked slot would give the waiting timeout
    expect(inner.convertCalls).toHaveLength(2); // both calls reached the converter
  });

  it('a low-priority probe is admitted only when no ordinary call waits, even if it asked first', async () => {
    const order: number[] = [];
    let release: () => void = () => undefined;
    const inner = new FakeMarkdownConverter({
      convert: async (state: Uint8Array) => {
        order.push(state[0] ?? 0);
        if (state[0] === 1) await new Promise<void>((r) => { release = r; });
        return { ok: true as const, markdown: '', text: '' };
      },
    });
    const gate = createConversionGate(inner);
    const first = gate.toMarkdown(new Uint8Array([1]));
    const probe = gate.toMarkdown(new Uint8Array([2]), { low: true });
    const ordinary = gate.toMarkdown(new Uint8Array([3]));
    await vi.waitFor(() => { expect(gate.waiting()).toBe(2); }); // the probe and the ordinary call are both queued behind the first
    release();
    await Promise.all([first, probe, ordinary]);
    expect(order).toEqual([1, 3, 2]);
  });
});
