// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { xssCorpus } from '../corpus/xss';
import { isSafeHref } from '../../src/safety';

describe('isSafeHref', () => {
  it.each(['https://a.test', 'http://a.test', 'mailto:a@b.test', 'tel:+1555', 'ftp://a.test/x', '/x', './x', '../x', '#a', '?q=1'])('accepts %s', (value) => {
    expect(isSafeHref(value)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    '&#106;avascript:alert(1)',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://a.test/1',
  ])('refuses %j', (value) => {
    expect(isSafeHref(value)).toBe(false);
  });

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 1, {}, ['https://a.test']]) expect(isSafeHref(value)).toBe(false);
  });

  it('refuses every unsafe address of the corpus and accepts every safe one', () => {
    const entries = xssCorpus.filter((e) => e.href !== undefined && (e.expect === 'link-kept' || e.expect === 'link-refused'));
    expect(entries.length).toBeGreaterThan(10);
    for (const e of entries) expect([e.id, isSafeHref(e.href)]).toEqual([e.id, e.expect === 'link-kept']);
  });
});
