// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(path.resolve(import.meta.dirname, '../../../../docs/web-security.md'), 'utf8');

describe('docs/web-security.md', () => {
  it.each(['fpnpmcdn.net', 'DSR', 'Apache-2.0', 'frame-ancestors', 'decision 94', 'decision 103'])('says %s', (text) => {
    expect(doc).toContain(text);
  });

  it('lists the same link schemes as the one allow-list of the editor schema', async () => {
    const { isSafeUrl } = await import('@tektum/grimoire-editor-schema');
    // The list is the run of backticked scheme names that follows `http`, `https`, `mailto`: it ends at the first thing that is not one.
    const listed = [...(/`http`, `https`, `mailto`, ((?:`[a-z]+`(?:, | and )?)+)/.exec(doc)?.[1] ?? '').matchAll(/`([a-z]+)`/g)].map((m) => m[1] ?? '');
    expect(listed.at(-1)).toBe('geo');
    expect(listed.length).toBeGreaterThan(5);
    for (const scheme of ['http', 'https', 'mailto', ...listed]) expect(isSafeUrl(`${scheme}:x`, 'link'), scheme).toBe(true);
    for (const scheme of ['javascript', 'file', 'vbscript', 'data', 'blob']) expect(isSafeUrl(`${scheme}:x`, 'link'), scheme).toBe(false);
  });
});
