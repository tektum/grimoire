import { describe, expect, it } from 'vitest';
import { compareDocuments } from '../../src/guards.js';

// The read-back check accepts two differences (an address read back as a link, a space moved out of a marked run) and nothing else.
// Each rule is tested at its boundary: what it accepts, and the nearest case it must still refuse.
const doc = (...content: object[]): object => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { level: 0 }, content }] });
const text = (value: string, ...marks: object[]): object => ({ type: 'text', text: value, ...(marks.length ? { marks } : {}) });
const strong = { type: 'strong' };
const link = (href: string, title: string | null = null): object => ({ type: 'link', attrs: { href, title } });
const ADDRESS = 'http://a.example';

describe('an address read back as a link (accepted)', () => {
  it('is accepted when the link target is the text itself', () => {
    expect(compareDocuments(doc(text(`see ${ADDRESS}`)), doc(text('see '), text(ADDRESS, link(ADDRESS))))).toBeUndefined();
    expect(compareDocuments(doc(text('me@x.example')), doc(text('me@x.example', link('mailto:me@x.example'))))).toBeUndefined();
  });

  it('is refused when the link has a title, another target, or the text changed', () => {
    expect(compareDocuments(doc(text(ADDRESS)), doc(text(ADDRESS, link(ADDRESS, 'title'))))).toBeDefined();
    expect(compareDocuments(doc(text(ADDRESS)), doc(text(ADDRESS, link('http://other.example'))))).toBeDefined();
    expect(compareDocuments(doc(text(ADDRESS)), doc(text('http://b.example', link('http://b.example'))))).toBeDefined();
  });

  it('is accepted for each run on its own: the same address as an explicit link and as plain text', () => {
    const expected = doc(text(ADDRESS, link(ADDRESS)), text(` and ${ADDRESS}`));
    const actual = doc(text(ADDRESS, link(ADDRESS)), text(' and '), text(ADDRESS, link(ADDRESS)));
    expect(compareDocuments(expected, actual)).toBeUndefined();
  });

  it('is refused for a link that the expected document had on other text', () => {
    expect(compareDocuments(doc(text('go', link(ADDRESS)), text(' there')), doc(text('go', link(ADDRESS)), text(' there', link('there'))))).toBeDefined();
  });
});

describe('a space moved out of a marked run (accepted)', () => {
  it('is accepted for one ordinary space at the edge of a strong run', () => {
    expect(compareDocuments(doc(text('x ', strong), text('y')), doc(text('x', strong), text(' y')))).toBeUndefined();
  });

  it('is refused for a tab, a no-break space, or two spaces', () => {
    expect(compareDocuments(doc(text('x\t', strong), text('y')), doc(text('x', strong), text('\ty')))).toBeDefined();
    expect(compareDocuments(doc(text('x\u00a0', strong), text('y')), doc(text('x', strong), text('\u00a0y')))).toBeDefined();
    expect(compareDocuments(doc(text('x  ', strong), text('y')), doc(text('x', strong), text('  y')))).toBeDefined();
  });

  it('is refused for a lone marked space between words, and for a marked space that is not at an edge', () => {
    expect(compareDocuments(doc(text('a'), text(' ', link('x')), text('b')), doc(text('a b')))).toBeDefined();
    expect(compareDocuments(doc(text('x y', strong)), doc(text('x', strong), text(' '), text('y', strong)))).toBeDefined();
  });

  it('only drops the marks the writer cannot keep: inline code on the space stays a difference', () => {
    expect(compareDocuments(doc(text('x', { type: 'inlineCode' }), text(' ', { type: 'inlineCode' })), doc(text('x', { type: 'inlineCode' }), text(' ')))).toBeDefined();
  });
});
