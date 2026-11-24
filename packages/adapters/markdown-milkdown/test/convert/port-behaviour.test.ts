import { describe, expect, it } from 'vitest';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { InProcessConverter } from '../../src/testing/in-process-converter.js';

/**
 * The behaviour tests of packages/core/test/markdown-converter, applied to the adapter and to the fake together (a
 * test file of core cannot be imported from here, so the cases are repeated; both files must stay in step).
 */
const NOT_A_STATE = new Uint8Array([255, 255, 255, 255, 255]);

const subjects: [string, () => MarkdownConverter][] = [
  ['adapter (in process)', () => new InProcessConverter()],
  ['fake', () => new FakeMarkdownConverter({ convert: { ok: false, reason: 'invalid-state', detail: 'scripted' } })],
];

describe.each(subjects)('MarkdownConverter behaviour: %s', (_name, make) => {
  it('resolves a typed failure for a state it cannot convert, and never rejects', async () => {
    const converter = make();
    const result = await converter.toMarkdown(NOT_A_STATE);
    expect(result).toMatchObject({ ok: false, reason: 'invalid-state' });
    expect(typeof (result.ok ? '' : result.detail)).toBe('string');
    await converter.close();
  });

  it('answers every call after close with internal/closed, and close is idempotent', async () => {
    const converter = make();
    await converter.close();
    await converter.close();
    expect(await converter.toMarkdown(new Uint8Array(0))).toEqual({ ok: false, reason: 'internal', detail: 'closed' });
    expect(await converter.seed('# x', 'test-key')).toEqual({ ok: false, reason: 'internal', detail: 'closed' });
  });
});

describe('MarkdownConverter on the adapter: seed failure', () => {
  it('returns too-large as a typed failure', async () => {
    const converter: MarkdownConverter = new InProcessConverter({ maxSeedMarkdownBytes: 4 });
    expect(await converter.seed('too long for the limit', 'test-key')).toMatchObject({ ok: false, reason: 'too-large' });
  });
});
