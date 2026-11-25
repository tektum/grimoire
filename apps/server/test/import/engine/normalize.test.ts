import { describe, expect, it } from 'vitest';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { normalizePage } from '../../../src/import/normalize.js';

// Stage 4c (M7 contracts section 4): seed fail-closed, the state size cap, and the canonical Markdown from the converter, never the text that came in.
const CAP = 1_536_000;
const run = (converter: FakeMarkdownConverter, markdown = 'Hello w\u00f6rld\n', title = 'T') => normalizePage(converter, 'importer', title, markdown, CAP);

describe('a page that seeds and converts back', () => {
  it('stores the converter\'s canonical Markdown and text, the hash of title and that Markdown, and both sizes', async () => {
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(40) }, convert: { ok: true, markdown: 'Hello w\u00f6rld.\n', text: 'Hello w\u00f6rld.' } });
    const out = await run(converter, '*Hello*   w\u00f6rld\n', 'Title');
    expect(out).toEqual({ kind: 'ok', markdown: 'Hello w\u00f6rld.\n', text: 'Hello w\u00f6rld.', hash: markdownHash('Title', 'Hello w\u00f6rld.\n'), state: new Uint8Array(40), markdownBytes: Buffer.byteLength('*Hello*   w\u00f6rld\n'), stateBytes: 40 });
    expect(converter.seedKeys).toEqual(['importer']);
  });

  it('a state of exactly the cap is kept, one byte over is state_too_large with both sizes recorded and no page content', async () => {
    const at = await run(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(CAP) } }));
    expect(at.kind).toBe('ok');
    const over = await run(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(CAP + 1) } }));
    expect(over).toEqual({ kind: 'failed', reason: 'state_too_large', markdownBytes: Buffer.byteLength('Hello w\u00f6rld\n'), stateBytes: CAP + 1 });
  });
});

describe('what the converter refuses', () => {
  it.each(['invalid-markdown', 'timeout', 'out-of-memory', 'internal'] as const)('a seed refused as %s is a failed item with that reason, the Markdown size recorded and no state size', async (reason) => {
    const out = await run(new FakeMarkdownConverter({ seed: { ok: false, reason, detail: 'x' } }));
    expect(out).toEqual({ kind: 'failed', reason, markdownBytes: Buffer.byteLength('Hello w\u00f6rld\n') });
  });

  it('a seed refused as too-large is skipped as too-large-to-seed (the measured limit of what the editor can hold), not failed', async () => {
    const out = await run(new FakeMarkdownConverter({ seed: { ok: false, reason: 'too-large', detail: 'x' } }));
    expect(out).toEqual({ kind: 'skipped', reason: 'too-large-to-seed', markdownBytes: Buffer.byteLength('Hello w\u00f6rld\n') });
  });

  it('a loss class on the way back (content-lost) is a failed item, with the state size recorded', async () => {
    const out = await run(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(7) }, convert: { ok: false, reason: 'content-lost', detail: 'x' } }));
    expect(out).toEqual({ kind: 'failed', reason: 'content-lost', markdownBytes: Buffer.byteLength('Hello w\u00f6rld\n'), stateBytes: 7 });
  });

  it('a queue-timeout is not the page\'s fault: the item is to be tried again, not failed', async () => {
    expect(await run(new FakeMarkdownConverter({ seed: { ok: false, reason: 'queue-timeout', detail: 'x' } }))).toEqual({ kind: 'retry', reason: 'queue-timeout' });
    expect(await run(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(1) }, convert: { ok: false, reason: 'queue-timeout', detail: 'x' } }))).toEqual({ kind: 'retry', reason: 'queue-timeout' });
  });

  it.each([['queue-full'], ['closed'], ['one-at-a-time']])('the pool refusing as busy (internal, %s) is a retry at the seed and on the way back, not a failed page', async (detail) => {
    const busy = { ok: false, reason: 'internal', detail } as const;
    expect(await run(new FakeMarkdownConverter({ seed: busy }))).toEqual({ kind: 'retry', reason: 'internal' });
    expect(await run(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(1) }, convert: busy }))).toEqual({ kind: 'retry', reason: 'internal' });
  });

  it('an internal failure with any other detail is a real failure', async () => {
    expect(await run(new FakeMarkdownConverter({ seed: { ok: false, reason: 'internal', detail: 'worker-crashed' } }))).toMatchObject({ kind: 'failed', reason: 'internal' });
  });

  it('every other failure on the way back is a failed item with its reason', async () => {
    const out = await run(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(1) }, convert: { ok: false, reason: 'timeout', detail: 'x' } }));
    expect(out).toMatchObject({ kind: 'failed', reason: 'timeout', stateBytes: 1 });
  });
});
