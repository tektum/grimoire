import { describe, expect, it } from 'vitest';
import { convertInProcess, reseedInProcess, seedInProcess } from '../../src/index.js';
import { nestedState, paragraphWith, stateFromFragment, stateFromMarkdown } from '../../src/testing/states.js';

// What saving does with pages that are dense in delimiters but valid: they SAVE (the Markdown is written and reads back as the same
// document). The cost is bounded by the save direction's time limit in the pool, not by a pre-check. See docs/proof/m2-conversion.md.
const shapes: [string, string][] = [
  ['python listing of 2,500 lines in a code block', '```python\n' + 'def foo_bar_baz(a_b, c_d):\n    return a_b * c_d_e\n'.repeat(1_250) + '```\n'],
  ['pretty JSON of 150 KB in a code block', '```json\n' + '  {"a_b": [1, 2, {"c": "d_e"}], "f": "*g*"},\n'.repeat(3_300) + '```\n'],
  ['task list of 3,000 items', '- [ ] task *a* done_x\n'.repeat(3_000)],
  ['table of 1,000 rows with links', '| h | h | h | h | h | h |\n|---|---|---|---|---|---|\n' + '| [a](http://x.y/1) | [b](u) | [c](u) | [d](u) | [e](u) | [f](u) |\n'.repeat(1_000)],
];

describe('saving a page that holds the shapes the seed direction accepts', () => {
  it.each(shapes)('%s: saved with fresh Markdown that reads back as the same document', async (_name, markdown) => {
    const seeded = await seedInProcess(markdown);
    if (!seeded.ok) throw new Error(seeded.detail);
    const saved = await convertInProcess(seeded.state);
    if (!saved.ok) throw new Error(`${saved.reason}: ${saved.detail}`);
    expect(saved.markdown.length).toBeGreaterThan(markdown.length / 2);
    // Re-parsed by the system rebuild, it saves again to exactly the same Markdown.
    const rebuilt = await reseedInProcess(saved.markdown);
    if (!rebuilt.ok) throw new Error(rebuilt.detail);
    const again = await convertInProcess(rebuilt.state);
    expect(again).toEqual(saved);
  }, 60_000);
});

describe('what saving stores can always be rebuilt', () => {
  it('Markdown over the stored-Markdown cap is refused by the save, naming the limit (so that it never is stored)', async () => {
    const state = await stateFromMarkdown('```\n' + 'a_b\n'.repeat(262_200) + '```\n'); // 1,048,800 bytes of Markdown, a small state
    expect(await convertInProcess(state)).toEqual({ ok: false, reason: 'too-large', detail: expect.stringMatching(/^the Markdown is 10488\d\d bytes; the limit is 1048576 bytes$/) });
    expect((await convertInProcess(state, { maxReseedMarkdownBytes: 2_000_000 })).ok).toBe(true);
  }, 60_000);

  it('the stored-Markdown cap is exact: a Markdown of exactly the limit is stored, one byte more is refused', async () => {
    const state = await stateFromMarkdown('hello\n');
    const saved = await convertInProcess(state);
    if (!saved.ok) throw new Error(saved.detail);
    const size = Buffer.byteLength(saved.markdown, 'utf8');
    expect((await convertInProcess(state, { maxReseedMarkdownBytes: size })).ok).toBe(true);
    expect(await convertInProcess(state, { maxReseedMarkdownBytes: size - 1 })).toEqual({ ok: false, reason: 'too-large', detail: `the Markdown is ${size} bytes; the limit is ${size - 1} bytes` });
  }, 60_000);

  it('the cap is measured on the Markdown that is stored: a NUL character becomes three bytes (U+FFFD) before the check', async () => {
    // The Markdown reader replaces a NUL by U+FFFD, so such a state can only come from a client that edits the document directly.
    const state = stateFromFragment((fragment) => { fragment.insert(0, [paragraphWith(`a${'\u0000'.repeat(400)}`)]); });
    const saved = await convertInProcess(state);
    if (!saved.ok) throw new Error(saved.detail);
    const size = Buffer.byteLength(saved.markdown, 'utf8');
    expect(size).toBeGreaterThanOrEqual(1_200); // the stored text holds 400 three-byte replacement characters
    expect((await convertInProcess(state, { maxReseedMarkdownBytes: size })).ok).toBe(true);
    // Between the serialiser's own output (800 bytes smaller) and the stored size: refused, because reseed would refuse what is stored.
    expect(await convertInProcess(state, { maxReseedMarkdownBytes: size - 1 })).toMatchObject({ ok: false, reason: 'too-large' });
  }, 60_000);

  it('what is stored passes every limit of the rebuild, not only its size: a code line of 101 quote markers is refused by the save, and 100 is stored and rebuilt', async () => {
    const withMarkers = (n: number): string => `\`\`\`\n${'>'.repeat(n)}\n\`\`\`\n`;
    const refused = await convertInProcess(await stateFromMarkdown(withMarkers(101)));
    expect(refused).toMatchObject({ ok: false, reason: 'too-large' });
    expect(JSON.stringify(refused)).toMatch(/line 2 has 101 quote or list markers; the limit is 100 per line/);
    const stored = await convertInProcess(await stateFromMarkdown(withMarkers(100)));
    if (!stored.ok) throw new Error(stored.detail);
    expect((await reseedInProcess(stored.markdown)).ok).toBe(true);
  }, 60_000);

  it('the deepest nesting the converter accepts is written with at most the markers the rebuild accepts, and rebuilds', async () => {
    for (const name of ['blockquote', 'bullet_list']) {
      const saved = await convertInProcess(nestedState(name, 99));
      if (!saved.ok) continue; // a nesting the schema does not allow in this form is not stored
      const rebuilt = await reseedInProcess(saved.markdown);
      expect(rebuilt.ok, name).toBe(true);
    }
    const quote = await convertInProcess(nestedState('blockquote', 99));
    expect(quote.ok).toBe(true);
    if (quote.ok) expect((await reseedInProcess(quote.markdown)).ok).toBe(true);
  });
});
