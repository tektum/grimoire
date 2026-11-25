import { describe, expect, it } from 'vitest';
import { markdownProfile } from '../../../src/import/markdown-profile.js';
import type { IndexedItem, LinkIndex } from '../../../src/import/profile.js';

// The generic `markdown_zip` profile (contracts section 4): folders and Markdown files, a folder without a page file is an empty container page, the title is the first heading or the file name.
const p = markdownProfile;
const index = (...items: IndexedItem[]): LinkIndex => ({ byPath: new Map(items.map((i) => [i.path, i])), byId: new Map() });

describe('classify', () => {
  it.each([['a.md', 'page'], ['dir/B.MD', 'page'], ['x.markdown', 'page'], ['img/cat.png', 'attachment'], ['doc.pdf', 'attachment'], ['data.csv', 'attachment'], ['noext', 'attachment'], ['.md', 'attachment']])('%s is %s', (path, kind) => {
    expect(p.classify({ path })).toBe(kind);
  });
});

describe('titleOf', () => {
  it('is the first heading of the page, wherever it is, when there is one', () => {
    expect(p.titleOf('notes/a.md', 'Intro text\n\n# The Title\n\nbody\n\n# Second\n')).toBe('The Title');
    expect(p.titleOf('a.md', 'Setext Title\n============\n\nbody')).toBe('Setext Title');
    expect(p.titleOf('a.md', '## Only a level two\n')).toBe('Only a level two');
  });

  it('prefers a level-one heading to an earlier deeper one', () => {
    expect(p.titleOf('a.md', '## Sub\n\n# Main\n')).toBe('Main');
  });

  it('does not read a heading inside a code fence, and strips emphasis marks and a closing hash run', () => {
    expect(p.titleOf('my notes.md', '```\n# not a heading\n```\n')).toBe('my notes');
    expect(p.titleOf('a.md', '# **Bold** title ##\n')).toBe('Bold title');
  });

  it('is the file name without its extension when there is no heading or the heading is empty', () => {
    expect(p.titleOf('dir/Plan 2026.md', 'just text\n')).toBe('Plan 2026');
    expect(p.titleOf('dir/readme.markdown', '#\n')).toBe('readme');
    expect(p.titleOf('a.b.md', '')).toBe('a.b');
  });

  it('skips front matter when looking for the heading', () => {
    expect(p.titleOf('a.md', '---\ntitle: Not this\n---\n# Real\n')).toBe('Real');
  });
});

describe('parentPathOf: the folder a page lives in, or the folder above the folder a page stands for', () => {
  it('a page in a folder has that folder as its parent; a page at the root has none', () => {
    expect(p.parentPathOf('a.md')).toBeNull();
    expect(p.parentPathOf('dir/x.md')).toBe('dir');
    expect(p.parentPathOf('a/b/c.md')).toBe('a/b');
  });

  it('a folder\'s own page file (index.md or README.md inside it) stands for the folder, so its parent is the folder above', () => {
    expect(p.parentPathOf('dir/index.md')).toBeNull();
    expect(p.parentPathOf('a/dir/README.md')).toBe('a');
    expect(p.parentPathOf('a/dir/Index.MD')).toBe('a');
  });
});

describe('parentPathOf when a folder has both an index.md and a README.md', () => {
  const paths = (...names: string[]): ReadonlySet<string> => new Set(names.map((n) => n.toLowerCase()));

  it('index.md is the folder\'s page and README.md is an ordinary child of the folder', () => {
    const all = paths('a/dir/index.md', 'a/dir/README.md', 'a/other/README.md');
    expect(p.parentPathOf('a/dir/index.md', all)).toBe('a');
    expect(p.parentPathOf('a/dir/README.md', all)).toBe('a/dir');
    expect(p.parentPathOf('a/other/README.md', all)).toBe('a'); // no index.md beside it: it stands for its folder
  });

  it('the match is case-insensitive and takes either extension', () => {
    expect(p.parentPathOf('dir/readme.md', paths('dir/INDEX.markdown', 'dir/readme.md'))).toBe('dir');
    expect(p.parentPathOf('dir/INDEX.markdown', paths('dir/INDEX.markdown', 'dir/readme.md'))).toBeNull();
  });

  it('without the list of paths a README.md stands for its folder', () => {
    expect(p.parentPathOf('dir/README.md')).toBeNull();
  });
});

describe('preprocess: front matter is stripped (R10.10)', () => {
  const ctx = { path: 'a.md' };
  it('strips a YAML block at the start, and a BOM before it', () => {
    expect(p.preprocess('---\ntitle: X\ntags: [a]\n---\n# Body\n', ctx)).toBe('# Body\n');
    expect(p.preprocess('\uFEFF---\ntitle: X\n...\nText\n', ctx)).toBe('Text\n');
  });

  it('strips a TOML block', () => {
    expect(p.preprocess('+++\ntitle = "X"\n+++\nText\n', ctx)).toBe('Text\n');
  });

  it('leaves a page that merely starts with a rule, or has no closing line, as it is', () => {
    const rule = '---\n\nSome text\n\n---\n\nMore\n';
    expect(p.preprocess(rule, ctx)).toBe(rule);
    const open = '---\ntitle: X\nno end\n';
    expect(p.preprocess(open, ctx)).toBe(open);
    expect(p.preprocess('Text\n---\ntitle: X\n---\n', ctx)).toBe('Text\n---\ntitle: X\n---\n');
  });

  it('strips a block that is empty', () => {
    expect(p.preprocess('---\n---\nText\n', ctx)).toBe('Text\n');
  });
});

describe('resolveLink', () => {
  const idx = index({ itemId: 'P1', path: 'dir/b.md', kind: 'page' }, { itemId: 'F1', path: 'img/cat.png', kind: 'attachment' }, { itemId: 'P2', path: 'My Page.md', kind: 'page' });

  it('finds a page and an attachment by a relative path, plain or URL-encoded, and keeps a fragment apart', () => {
    expect(p.resolveLink('b.md', 'dir/a.md', idx)).toEqual({ kind: 'page', itemId: 'P1' });
    expect(p.resolveLink('../img/cat.png', 'dir/a.md', idx)).toEqual({ kind: 'attachment', itemId: 'F1' });
    expect(p.resolveLink('My%20Page.md#part', 'dir/a.md'.replace('dir/', ''), idx)).toEqual({ kind: 'page', itemId: 'P2', fragment: 'part' });
    expect(p.resolveLink('%2e%2e/My%20Page.md', 'dir/a.md', idx)).toEqual({ kind: 'page', itemId: 'P2' });
  });

  it('finds nothing for an unknown path, an external address, or a path that leaves the archive', () => {
    for (const url of ['missing.md', 'https://example.com/b.md', '../../../b.md', '#top', 'mailto:x@example.com']) expect(p.resolveLink(url, 'dir/a.md', idx)).toBeUndefined();
  });
});
