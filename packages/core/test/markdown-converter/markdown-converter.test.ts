import { describe, expect, it } from 'vitest';
import type { ConvertResult, MarkdownConverter, SeedResult } from '../../src/ports/markdown-converter.js';
import { FakeMarkdownConverter } from '../../src/testing/fake-markdown-converter.js';

/**
 * Behaviour every `MarkdownConverter` must show for its typed failures. The adapter runs the same function against
 * the real implementation (packages/adapters/markdown-milkdown/test/convert/port-behaviour.test.ts).
 */
export function portBehaviour(name: string, make: () => { converter: MarkdownConverter; failing: Uint8Array }): void {
  describe(`MarkdownConverter behaviour: ${name}`, () => {
    it('resolves a typed failure for a state it cannot convert, and never rejects', async () => {
      const { converter, failing } = make();
      const result = await converter.toMarkdown(failing);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(['invalid-state', 'too-large', 'too-deep', 'content-lost', 'timeout', 'out-of-memory', 'internal']).toContain(result.reason);
      expect(typeof result.detail).toBe('string');
      await converter.close();
    });

    it('answers every call after close with internal/closed, and close is idempotent', async () => {
      const { converter } = make();
      await converter.close();
      await converter.close();
      expect(await converter.toMarkdown(new Uint8Array(0))).toEqual({ ok: false, reason: 'internal', detail: 'closed' });
      expect(await converter.seed('# x')).toEqual({ ok: false, reason: 'internal', detail: 'closed' });
    });
  });
}

const contentLost: ConvertResult = { ok: false, reason: 'content-lost', detail: 'scripted' };

portBehaviour('fake', () => ({
  converter: new FakeMarkdownConverter({ convert: contentLost }),
  failing: new Uint8Array([1]),
}));

describe('FakeMarkdownConverter', () => {
  it('returns scripted results in order, then the default, and counts calls', async () => {
    const ok: ConvertResult = { ok: true, markdown: 'm', text: 't' };
    const fake = new FakeMarkdownConverter().enqueueConvert(contentLost).enqueueConvert(ok);
    expect(await fake.toMarkdown(new Uint8Array([1]))).toEqual(contentLost);
    expect(await fake.toMarkdown(new Uint8Array([2]))).toEqual(ok);
    expect(await fake.toMarkdown(new Uint8Array([3]))).toEqual({ ok: true, markdown: '', text: '' });
    expect(fake.convertCalls.map((s) => s[0])).toEqual([1, 2, 3]);
  });

  it('scripts seeding, including by function of the input', async () => {
    const failed: SeedResult = { ok: false, reason: 'too-large', detail: 'scripted' };
    const fake = new FakeMarkdownConverter({ seed: (markdown) => ({ ok: true, state: new Uint8Array([markdown.length]) }) });
    fake.enqueueSeed(failed);
    expect(await fake.seed('abc')).toEqual(failed);
    expect(await fake.seed('abc')).toEqual({ ok: true, state: new Uint8Array([3]) });
    expect(fake.seedCalls).toEqual(['abc', 'abc']);
  });

  it('does not count calls made after close', async () => {
    const fake = new FakeMarkdownConverter();
    await fake.close();
    await fake.toMarkdown(new Uint8Array(0));
    expect(fake.convertCalls).toHaveLength(0);
    expect(fake.closeRequested).toBe(true);
  });
});
