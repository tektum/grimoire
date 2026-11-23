import { FRAGMENT_NAME, isSafeUrl } from '@tektum/grimoire-editor-schema';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { convertInProcess, seedInProcess } from '../../src/index.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { stateFromDocJson } from '../../src/testing/states.js';

// Review finding F4: a Yjs state can carry any address directly, so the converter enforces the allow-list again at save time.
type Json = Record<string, unknown>;
const HOSTILE = ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', '&#106;avascript:alert(1)', '%6Aavascript:alert(1)', 'file:///etc/passwd'];

/** The seeded document as the XML the editor binding writes: every mark and attribute of it, before any conversion. */
const xmlOf = (state: Uint8Array): string => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(FRAGMENT_NAME).toString();
};

const run = (text: string, marks: Json[] = []): Json => ({ type: 'text', text, ...(marks.length > 0 ? { marks } : {}) });
const link = (href: string): Json => ({ type: 'link', attrs: { href, title: null, nest: 'inner' } });
const image = (src: string, href = ''): Json => ({ type: 'image', attrs: { src, alt: 'pic', title: '', href, linkTitle: '' } });
const para = (...content: Json[]): Json => ({ type: 'paragraph', attrs: { level: 0 }, content });

describe('the converter refuses to store an address that is not allowed', () => {
  it.each(HOSTILE.map((url) => [url] as const))('a state with %j as a link, an image and an image link', async (url) => {
    const state = await stateFromDocJson({ type: 'doc', content: [para(run('see'), run(' link', [link(url)]), image(url), image('https://example.com/ok.png', url))] });
    const result = await convertInProcess(state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).not.toContain(url.trim());
    expect(result.markdown).not.toMatch(/javascript|vbscript|data:|file:/i);
    expect(result.markdown).toContain('see link');
    expect(result.markdown).toContain('![pic](https://example.com/ok.png)');
  });

  it('an address of nearly the state cap is not stored', async () => {
    const state = await stateFromDocJson({ type: 'doc', content: [para(run('long', [link(`https://example.com/${'p'.repeat(Math.floor(DEFAULT_LIMITS.maxStateBytes * 0.9))}`)]))] });
    const result = await convertInProcess(state);
    expect(result).toMatchObject({ ok: true, markdown: 'long\n' });
  });

  it('allowed addresses are kept', async () => {
    const state = await stateFromDocJson({ type: 'doc', content: [para(run('a', [link('https://example.com/a')]), run(' '), run('b', [link('/relative')]), run(' '), run('c', [link('mailto:x@example.com')]), image('https://example.com/i.png'))] });
    const result = await convertInProcess(state);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.markdown).toBe('[a](https://example.com/a) [b](/relative) [c](mailto:x@example.com)![pic](https://example.com/i.png)\n');
  });

  it('a seed from Markdown never holds one, and converts back to Markdown without it', async () => {
    const seeded = await seedInProcess('[a](javascript:alert(1)) ![x](data:text/html;base64,AAAA) [v](vbscript:x) [![i](https://example.com/i.png)](javascript:y)\n');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    // The seeded state itself holds no unsafe address (before the converter's own removal could hide it).
    const xml = xmlOf(seeded.state);
    expect(xml).toContain('https://example.com/i.png');
    expect(xml).not.toMatch(/javascript:|vbscript:|data:text/i);
    const result = await convertInProcess(seeded.state);
    expect(result).toMatchObject({ ok: true, markdown: 'a x v ![i](https://example.com/i.png)\n' });
  });

  it('every hostile spelling above is refused by isSafeUrl, the allow-list the schema and the converter apply', () => {
    for (const url of HOSTILE) expect(isSafeUrl(url)).toBe(false);
  });
});
