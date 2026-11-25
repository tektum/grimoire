import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakePageStore } from '../../src/testing/fake-page-store.js';
import type { PageWrite } from '../../src/ports/collaboration-host.js';

// The fake has no titles, so its hash must equal the real store's rule (SHA-256 of title, NUL, Markdown, db-kysely page-store.ts hashOf) for the empty title.
const realRule = (title: string, markdown: string): Uint8Array => new Uint8Array(createHash('sha256').update(title, 'utf8').update('\0').update(markdown, 'utf8').digest());
const write = (markdown: string, state: number[]): PageWrite => ({ kind: 'converted', state: Uint8Array.from(state), markdown, text: markdown, epoch: 0, editedAt: 1 });

describe('FakePageStore markdown hash', () => {
  it('is the real store rule for the empty title', async () => {
    const store = new FakePageStore();
    store.seed('p', Uint8Array.from([1]));
    await store.store('legacy', 'p', write('# a', [2]));
    expect(store.hashes.get('p')).toEqual(realRule('', '# a'));
    expect(store.hashes.get('p')).not.toEqual(realRule('t', '# a'));
  });

  it('skips the Markdown columns for the same Markdown and rewrites them when it changes', async () => {
    const store = new FakePageStore();
    store.seed('p', Uint8Array.from([1]));
    expect(await store.store('legacy', 'p', write('a', [2]))).toEqual({ written: true });
    expect(await store.store('legacy', 'p', write('a', [2]))).toEqual({ written: false, reason: 'unchanged' });
    expect(await store.store('legacy', 'p', write('a', [3]))).toEqual({ written: true });
    expect(store.rows.get('p')).toEqual(Uint8Array.from([3]));
    expect(store.markdowns.get('p')).toBe('a');
    expect(await store.store('legacy', 'p', write('b', [3]))).toEqual({ written: true });
    expect(store.markdowns.get('p')).toBe('b');
    expect(store.texts.get('p')).toBe('b');
    expect(store.hashes.get('p')).toEqual(realRule('', 'b'));
  });
});
