import { describe, expect, it } from 'vitest';
import { markdownHash } from '../../src/pages/hash.js';
import type { SeededContent } from '../../src/pages/seeded-content.js';
import { isSeedRefusal, seedUserMarkdown } from '../../src/pages/seeded-content.js';
import { FakeMarkdownConverter } from '../../src/testing/fake-markdown-converter.js';

const STATE = new Uint8Array([1, 2, 3]);

describe('seedUserMarkdown', () => {
  it('passes the user id as the key, once, and the sent Markdown to seed', async () => {
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: STATE } });
    await seedUserMarkdown(converter, 'user-7', 'Title', '# raw');
    expect(converter.seedKeys).toEqual(['user-7']);
    expect(converter.seedCalls).toEqual(['# raw']);
    expect(converter.reseedKeys).toEqual([]);
  });

  it('returns the serialiser text, the search text, the state and the hash of that text', async () => {
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: STATE }, convert: { ok: true, markdown: 'canonical\n', text: 'canonical' } });
    const r = await seedUserMarkdown(converter, 'u', 'T', '  raw  ');
    if (isSeedRefusal(r)) throw new Error('refused');
    expect(r.state).toBe(STATE);
    expect(r.markdown).toBe('canonical\n');
    expect(r.text).toBe('canonical');
    expect(r.hash.equals(markdownHash('T', 'canonical\n'))).toBe(true);
    expect(converter.convertCalls).toEqual([STATE]);
  });

  it('returns no state when the seed is refused, and never converts', async () => {
    const converter = new FakeMarkdownConverter({ seed: { ok: false, reason: 'invalid-markdown', detail: 'lines', message: 'the Markdown has 9 lines; the limit is 8 lines' } });
    const r = await seedUserMarkdown(converter, 'u', 'T', 'x');
    expect(r).toEqual({ ok: false, stage: 'seed', reason: 'invalid-markdown', detail: 'lines', message: 'the Markdown has 9 lines; the limit is 8 lines' });
    expect(r).not.toHaveProperty('state');
    expect(converter.convertCalls).toEqual([]);
  });

  it('refuses with stage convert when the state cannot be written back', async () => {
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: STATE }, convert: { ok: false, reason: 'content-lost', detail: 'x' } });
    const r = await seedUserMarkdown(converter, 'u', 'T', 'x');
    expect(r).toEqual({ ok: false, stage: 'convert', reason: 'content-lost', detail: 'x' });
  });

  it('holds the user until the conversion back has finished: a second call is refused at once, and the user is free afterwards', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    class Gated extends FakeMarkdownConverter {
      override async toMarkdown(state: Uint8Array) { await gate; return super.toMarkdown(state); }
    }
    const converter = new Gated({ seed: { ok: true, state: STATE }, convert: { ok: true, markdown: 'a', text: 'a' } });
    const first = seedUserMarkdown(converter, 'busy-user', 'T', 'x');
    await new Promise((r) => setImmediate(r));
    expect(await seedUserMarkdown(converter, 'busy-user', 'T', 'y')).toEqual({ ok: false, stage: 'seed', reason: 'internal', detail: 'one-at-a-time' });
    expect(converter.seedCalls).toEqual(['x']);
    release();
    expect(isSeedRefusal(await first)).toBe(false);
    expect(isSeedRefusal(await seedUserMarkdown(converter, 'busy-user', 'T', 'z'))).toBe(false);
  });

  it('is the only way to get a SeededContent: a plain string is not one', () => {
    // @ts-expect-error a string is not seeded content
    const bad: SeededContent = '# raw';
    expect(typeof bad).toBe('string');
  });
});

describe('markdownHash', () => {
  it('matches fixed vectors, with a NUL between title and Markdown', () => {
    expect(markdownHash('', '').toString('hex')).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
    expect(markdownHash('a', 'b').toString('hex')).toBe('59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138');
  });
  it('separates title from Markdown', () => {
    expect(markdownHash('ab', 'c').equals(markdownHash('a', 'bc'))).toBe(false);
  });
  it('hashes UTF-8', () => {
    expect(markdownHash('é', '').equals(markdownHash('e', ''))).toBe(false);
  });
});
