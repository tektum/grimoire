import { describe, expect, it } from 'vitest';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import { createOnnxEmbedder } from '../src/index.js';

const config = (over: Partial<SemanticConfig> = {}): SemanticConfig => ({
  enabled: true,
  model: 'multilingual-e5-base',
  modelDir: '/app/models',
  threads: 2,
  debounceSeconds: 30,
  sweepSeconds: 15,
  maxChunksPerMinute: 600,
  queryTimeoutMs: 1500,
  minSimilarity: 0,
  candidates: 100,
  ...over,
});

describe('createOnnxEmbedder before the model is wired in', () => {
  it('describes the model the setting names: its vector length and the 512-token limit', () => {
    expect(createOnnxEmbedder(config()).model).toMatchObject({ name: 'multilingual-e5-base', dims: 768, maxTokens: 512 });
    expect(createOnnxEmbedder(config({ model: 'multilingual-e5-small' })).model).toMatchObject({ name: 'multilingual-e5-small', dims: 384, maxTokens: 512 });
  });

  it('reports unavailable and answers every embedding call with unavailable, never throwing', async () => {
    const e = createOnnxEmbedder(config());
    expect(e.status()).toBe('unavailable');
    expect(await e.embedPassages(['a page'])).toEqual({ ok: false, reason: 'unavailable' });
    expect(await e.embedQuery('a search', { timeoutMs: 10 })).toEqual({ ok: false, reason: 'unavailable' });
    await e.close();
    await e.close();
    expect(e.status()).toBe('unavailable');
  });

  it('shows the threads of the setting and an idle queue', () => {
    expect(createOnnxEmbedder(config({ threads: 3 })).stats()).toEqual({ threads: 3, queued: 0, chunksPerMinute: 0 });
  });

  it('estimates tokens at three characters each, so a longer text never counts less than a shorter one', () => {
    const e = createOnnxEmbedder(config());
    expect(e.countTokens('')).toBe(0);
    expect(e.countTokens('abc')).toBe(1);
    expect(e.countTokens('abcd')).toBe(2);
    expect(e.countTokens('x'.repeat(300))).toBeGreaterThan(e.countTokens('x'.repeat(30)));
  });
});
