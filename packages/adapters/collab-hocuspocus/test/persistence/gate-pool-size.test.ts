import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../../src/registry.js';
import { makeDeps, PAGE } from '../host/support.js';
import { seedDoc, textOf } from './support.js';

const OTHER_PAGE = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11';

describe('the conversion gate follows the pool size (the host passes it from the configuration)', () => {
  it('with the default of two workers, a second page converts while a slow page holds one of them', async () => {
    const started: string[] = [];
    const base = new FakeMarkdownConverter();
    const converter: MarkdownConverter = {
      seed: (m, k) => base.seed(m, k), reseed: (m, k) => base.reseed(m, k), close: () => base.close(),
      toMarkdown: (state) => new Promise(() => { started.push(textOf(state)); }), // never finishes: the pages hold their workers
    };
    const t = makeDeps('member');
    t.pages.seed(PAGE);
    t.pages.seed(OTHER_PAGE);
    expect(t.deps.config.collab.convertPoolSize).toBe(2);
    const { persistence } = buildExtensions({ deps: { ...t.deps, converter }, log: t.log, peers: {} as never, guard: {} as never, sleep: () => new Promise(() => undefined) });
    const docs = [seedDoc('one'), seedDoc('two')];
    void persistence.onStoreDocument?.({ document: docs[0]!, documentName: PAGE } as never);
    void persistence.onStoreDocument?.({ document: docs[1]!, documentName: OTHER_PAGE } as never);
    await vi.waitFor(() => { expect(started).toHaveLength(2); }); // with a gate of one, the second would still wait
  });
});
