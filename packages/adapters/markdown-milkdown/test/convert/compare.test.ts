import { describe, expect, it } from 'vitest';
import { compareDocuments } from '../../src/guards.js';

/** The comparison on its own, with hand-made documents: what each named rule accepts and what it does not. */
const link = (href: string) => ({ type: 'link', attrs: { href, title: null } });
const doc = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { level: 0 }, content }] });
const t = (text: string, ...marks: unknown[]) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });

describe('compareDocuments', () => {
  it('equal documents, and a difference in the list spread flag only, are equal', () => {
    expect(compareDocuments(doc(t('a')), doc(t('a')))).toBeUndefined();
    const list = (spread: boolean) => ({ type: 'doc', content: [{ type: 'bullet_list', attrs: { spread }, content: [] }] });
    expect(compareDocuments(list(true), list(false))).toBeUndefined();
  });

  it('rule 1: a link whose target is its own text (with the usual prefix) is accepted where the expected run had none', () => {
    expect(compareDocuments(doc(t('www.x.org')), doc(t('www.x.org', link('http://www.x.org'))))).toBeUndefined();
    expect(compareDocuments(doc(t('me@x.com')), doc(t('me@x.com', link('mailto:me@x.com'))))).toBeUndefined();
    expect(compareDocuments(doc(t('see '), t('http://x.y')), doc(t('see '), t('http://x.y', link('http://x.y'))))).toBeUndefined();
  });

  it('rule 1 is not widened: another target, a title, or a link on text that was a link already is refused', () => {
    expect(compareDocuments(doc(t('docs')), doc(t('docs', link('https://evil.example'))))).toBeDefined();
    expect(compareDocuments(doc(t('www.x.org')), doc(t('www.x.org', link('http://www.other.org'))))).toBeDefined();
    expect(compareDocuments(doc(t('www.x.org')), doc(t('www.x.org', { type: 'link', attrs: { href: 'http://www.x.org', title: 'T' } })))).toBeDefined();
    expect(compareDocuments(doc(t('a', link('u'))), doc(t('a', link('v'))))).toBeDefined();
  });

  it('rule 1 does not hide other marks or other text', () => {
    expect(compareDocuments(doc(t('www.x.org', { type: 'strong' })), doc(t('www.x.org', link('http://www.x.org'))))).toBeDefined();
    expect(compareDocuments(doc(t('www.x.org')), doc(t('www.x.org!', link('http://www.x.org'))))).toBeDefined();
  });

  it('rule 3: NUL and a lone surrogate equal their replacement', () => {
    expect(compareDocuments(doc(t('a\u0000b')), doc(t('a\uFFFDb')))).toBeUndefined();
    expect(compareDocuments(doc(t('a\uD800b')), doc(t('a\uFFFDb')))).toBeUndefined();
    expect(compareDocuments(doc(t('a\uDC00b')), doc(t('a\uFFFDb')))).toBeUndefined();
    expect(compareDocuments(doc(t('a\uD83D\uDE00b')), doc(t('a\uFFFDb')))).toBeDefined(); // a valid pair is a character, not a lone surrogate
    expect(compareDocuments(doc(t('a\u0000b')), doc(t('axb')))).toBeDefined();
  });

  const mark = (type: string) => (type === 'link' ? link('http://u.example/x') : { type });
  const editor = (type: string) => ({ marked: (text: string) => t(text, mark(type)) });

  it.each(['emphasis', 'strong', 'strike_through', 'link'])('rule 4: a space at the edge of a %s run may lose that mark', (type) => {
    const { marked } = editor(type);
    // end of the run, then plain text; and start of the run, after plain text
    expect(compareDocuments(doc(marked('a b '), t('end')), doc(marked('a b'), t(' end')))).toBeUndefined();
    expect(compareDocuments(doc(t('end'), marked(' a b')), doc(t('end '), marked('a b')))).toBeUndefined();
  });

  it.each(['link', 'inlineCode', 'strike_through', 'strong', 'emphasis'])('rule 4 is not wider: a lone %s space between letters is refused', (type) => {
    // a run that is only whitespace has no longer marked run to be the edge of
    expect(compareDocuments(doc(t('a'), t(' ', mark(type)), t('b')), doc(t('a b')))).toBeDefined();
  });

  it('rule 4 is not wider: a whitespace-only marked run next to marked text on one side only is still refused when it is not the edge of a longer run', () => {
    expect(compareDocuments(doc(t('a'), t('  ', mark('strike_through')), t('b')), doc(t('a  b')))).toBeDefined();
  });

  it.each([
    ['a tab', '\t'],
    ['a no-break space', '\u00a0'],
    ['a zero-width space', '\u200b'],
    ['a line separator', '\u2028'],
  ])('rule 4 never covers %s at the edge of a run', (_name, character) => {
    expect(compareDocuments(doc(t(`x${character}`, mark('strong')), t('end')), doc(t('x', mark('strong')), t(`${character}end`)))).toBeDefined();
  });

  it('rule 4 never covers two spaces in a row', () => {
    expect(compareDocuments(doc(t('x  ', mark('strong')), t('end')), doc(t('x', mark('strong')), t('  end')))).toBeDefined();
  });

  it('rule 4 never covers a letter, and keeps a mark the writer can keep (inline code) on a space', () => {
    expect(compareDocuments(doc(t('ab', mark('strong')), t(' end')), doc(t('a', mark('strong')), t('b end')))).toBeDefined();
    expect(compareDocuments(doc(t('x', mark('inlineCode')), t(' ', mark('inlineCode')), t('end')), doc(t('x', mark('inlineCode')), t(' end')))).toBeDefined();
  });

  it('rule 4 does not apply inside a run: a space between two strong letters keeps its mark', () => {
    expect(compareDocuments(doc(t('a b', mark('strong'))), doc(t('a', mark('strong')), t(' '), t('b', mark('strong'))))).toBeDefined();
  });

  it('rule 5: the order of marks is not a difference; the marks are', () => {
    expect(compareDocuments(doc(t('a', { type: 'strong' }, { type: 'emphasis' })), doc(t('a', { type: 'emphasis' }, { type: 'strong' })))).toBeUndefined();
    expect(compareDocuments(doc(t('a', { type: 'strong' })), doc(t('a', { type: 'emphasis' })))).toBeDefined();
  });

  it('a different node type, attribute or text is a difference and the place is a path of node types', () => {
    const found = compareDocuments(doc(t('a')), { type: 'doc', content: [{ type: 'blockquote', content: [] }] });
    expect(found).toContain('paragraph became blockquote');
    expect(compareDocuments(doc(t('a')), doc(t('b')))).toBeDefined();
    expect(compareDocuments({ type: 'doc', content: [{ type: 'paragraph', attrs: { level: 1 } }] }, { type: 'doc', content: [{ type: 'paragraph', attrs: { level: 2 } }] })).toBeDefined();
  });
});
