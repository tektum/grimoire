// @vitest-environment node
import { isSafeUrl } from '@tektum/grimoire-editor-schema';
import { describe, expect, it } from 'vitest';
import { type Expectation, markdownLink, nestedLists, xssCorpus } from '../corpus/xss';

describe('the XSS corpus', () => {
  it('has at least 40 entries with unique ids', () => {
    expect(xssCorpus.length).toBeGreaterThanOrEqual(40);
    const ids = xssCorpus.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every entry some input and a known expectation', () => {
    const known: Expectation[] = ['link-kept', 'link-refused', 'inert', 'sanitised', 'image-blocked', 'image-kept', 'bounded'];
    for (const entry of xssCorpus) {
      expect([entry.id, entry.markdown !== undefined || entry.html !== undefined || entry.href !== undefined]).toEqual([entry.id, true]);
      expect(known).toContain(entry.expect);
    }
  });

  it('names every scheme of the rendering rule, in the spellings the rule lists', () => {
    const hrefs = xssCorpus.flatMap((e) => (e.href === undefined ? [] : [e.href]));
    const has = (test: (value: string) => boolean) => hrefs.some(test);
    for (const scheme of ['javascript', 'file', 'vbscript', 'data', 'blob', 'ftp', 'tel', 'http', 'https', 'mailto'])
      expect([scheme, has((h) => h.toLowerCase().startsWith(`${scheme}:`))]).toEqual([scheme, true]);
    expect(has((h) => h.startsWith('JaVaScRiPt:'))).toBe(true); // mixed case
    expect(has((h) => /^java\tscript:/.test(h))).toBe(true); // a tab inside the scheme
    expect(has((h) => /^&#\d+;avascript:|^jav&#x/i.test(h))).toBe(true); // entity-encoded
    expect(has((h) => /^[\u0000-\u001f]javascript:/.test(h))).toBe(true); // a leading control character
    expect(has((h) => /^%6Aavascript:/i.test(h))).toBe(true); // percent-encoded
  });

  it('covers the kinds of hostile input: script and handlers, frames, forms, styles, remote and data images', () => {
    const pasted = xssCorpus.flatMap((e) => (e.html === undefined ? [] : [e.html.toLowerCase()]));
    const any = (needle: string) => pasted.some((h) => h.includes(needle));
    for (const needle of ['<script', 'onerror=', 'onload=', 'onclick=', '<iframe', '<form', '<style', 'style="']) expect([needle, any(needle)]).toEqual([needle, true]);
    // The address of each blocked Markdown image, read as an address: a `data:` one, and one on a remote host.
    const blocked = xssCorpus.flatMap((e) => (e.expect === 'image-blocked' && e.markdown !== undefined ? [...e.markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]!) : []));
    expect(blocked.some((address) => address.startsWith('data:image/'))).toBe(true);
    expect(blocked.some((address) => URL.canParse(address) && new URL(address).protocol === 'https:' && new URL(address).hostname === 'evil.example')).toBe(true);
    expect(xssCorpus.some((e) => e.expect === 'image-kept')).toBe(true);
  });

  it('agrees with the single allow-list of the editor schema on every address', () => {
    for (const entry of xssCorpus) {
      if (entry.href === undefined) continue;
      expect([entry.id, isSafeUrl(entry.href)]).toEqual([entry.id, entry.expect === 'link-kept']);
    }
  });

  it('agrees with the allow-list for images: only an http(s) or relative address passes, never data:', () => {
    expect(isSafeUrl('data:image/png;base64,iVBORw0KGgo=', 'image')).toBe(false);
    expect(isSafeUrl('./files/a.png', 'image')).toBe(true);
  });

  it('gives an address entry Markdown only when the address can be a link destination, and the destination is the address', () => {
    for (const entry of xssCorpus) {
      if (entry.href === undefined || entry.markdown === undefined) continue;
      const destination = entry.markdown.slice('[link]('.length, -1);
      const angled = destination.startsWith('<') && destination.endsWith('>');
      expect([entry.id, angled ? destination.slice(1, -1) : destination]).toEqual([entry.id, entry.href]);
      // A bare destination has no space or control character: otherwise a renderer shows the text, not a link.
      if (!angled) expect([entry.id, /[\u0000-\u0020\u007f]/.test(destination)]).toEqual([entry.id, false]);
      // The angle form has no line ending and no angle bracket inside.
      if (angled) expect([entry.id, /[\r\n<>]/.test(entry.href)]).toEqual([entry.id, false]);
    }
  });

  it('keeps the spellings a destination cannot hold as address-only entries, and the tab and control-character ones as angle links', () => {
    const byId = (id: string) => xssCorpus.find((e) => e.id === id);
    expect(byId('href-javascript-newline')?.markdown).toBeUndefined();
    expect(byId('href-javascript-tab')?.markdown).toBe('[link](<java\tscript:alert(1)>)');
    expect(byId('href-javascript-leading-control')?.markdown).toBe('[link](<\u0001javascript:alert(1)>)');
    expect(byId('href-javascript-leading-space')?.markdown).toBe('[link](< javascript:alert(1)>)');
    expect(byId('href-javascript')?.markdown).toBe('[link](javascript:alert(1))');
    expect(byId('href-data-html')?.markdown).toBe('[link](data:text/html,<script>alert(1)</script>)');
    expect(markdownLink('a\nb')).toBeUndefined();
    expect(markdownLink('a<b')).toBe('[link](a<b)'); // a bare destination may hold < inside
    expect(markdownLink('<a b>')).toBeUndefined(); // it may not start with one, and the angle form takes no brackets
    expect(markdownLink('a b')).toBe('[link](<a b>)');
  });

  it('has a nested-list text of at least 1 MB', () => {
    const big = xssCorpus.find((e) => e.id === 'nested-lists-1mb')?.markdown ?? '';
    expect(big.length).toBeGreaterThanOrEqual(1_000_000);
    expect(big.split('\n').some((l) => l.startsWith(' '.repeat(78)))).toBe(true); // nested 39 levels deep
    expect(nestedLists(100).length).toBeGreaterThanOrEqual(100);
  });
});
