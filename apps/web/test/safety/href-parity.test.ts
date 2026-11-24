// @vitest-environment node
import { readFileSync } from 'node:fs';
import { isSafeUrl } from '@tektum/grimoire-editor-schema';
import { describe, expect, it } from 'vitest';
import { xssCorpus } from '../corpus/xss';
import { isSafeHref } from '../../src/safety';

const source = readFileSync(new URL('../../src/safety/index.ts', import.meta.url), 'utf8');

describe('isSafeHref is the allow-list of the editor schema, not a second one', () => {
  it('agrees with isSafeUrl(href, "link") for every corpus address', () => {
    const hrefs = xssCorpus.flatMap((e) => (e.href === undefined ? [] : [e.href]));
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) expect([h, isSafeHref(h)]).toEqual([h, isSafeUrl(h, 'link')]);
  });

  it('imports isSafeUrl from editor-schema and keeps no scheme list of its own', () => {
    expect(source).toMatch(/from '@tektum\/grimoire-editor-schema'/);
    expect(source).toContain('isSafeUrl');
    expect(source).not.toMatch(/javascript|vbscript|mailto|https?:/i);
  });
});
