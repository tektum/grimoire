import { describe, expect, it } from 'vitest';
import { rewriteMarkdown } from '../../../src/import/markdown-rewrite.js';
import type { Resolved, ResolveTarget } from '../../../src/import/markdown-rewrite.js';

// What the engine knows: the page items and the files of the archive. The rewrite itself only asks.
const page = (url: string): Resolved => ({ kind: 'page', url });
const file = (url: string): Resolved => ({ kind: 'file', url });
const known: Record<string, Resolved> = { 'a.md': page('/p/AAA'), 'dir/b.md': page('/p/BBB'), 'img/cat.png': file('attachments/11/cat.png'), 'my%20file.pdf': file('attachments/22/my file.pdf'), 'doc.pdf': file('attachments/33/doc.pdf') };
const calls: string[] = [];
const resolve: ResolveTarget = (target) => { calls.push(target); return known[target]; };

describe('rewriting links and images (R10.2)', () => {
  it('a page link becomes /p/<url_id>, a fragment is kept, an image becomes an attachment path', () => {
    const out = rewriteMarkdown('See [A](a.md) and [B](dir/b.md#part).\n\n![cat](img/cat.png)\n', resolve);
    expect(out.markdown).toBe('See [A](/p/AAA) and [B](/p/BBB#part).\n\n![cat](attachments/11/cat.png)\n');
    expect(out.rewritten).toBe(3);
    expect(out.unresolved).toEqual([]);
  });

  it('a file linked as a link (not an image) is replaced the same way, and a target is handed over as written (still URL-encoded)', () => {
    const out = rewriteMarkdown('[doc](my%20file.pdf)\n', resolve);
    expect(out.markdown).toBe('[doc](<attachments/22/my file.pdf>)\n');
    expect(calls).toContain('my%20file.pdf');
  });

  it('a fragment is kept on a page link and dropped on a file, so an attachment path stays exactly attachments/<id>/<name>', () => {
    const out = rewriteMarkdown('[p](a.md#part) [f](doc.pdf#page=2) ![i](img/cat.png#x)\n', resolve);
    expect(out.markdown).toBe('[p](/p/AAA#part) [f](attachments/33/doc.pdf) ![i](attachments/11/cat.png)\n');
  });

  it('a protocol-relative address is external: untouched, not looked up, not reported unresolved', () => {
    calls.length = 0;
    const source = '[l](//cdn.example.com/a) ![i](//cdn.example.com/a.png)\n';
    const out = rewriteMarkdown(source, resolve);
    expect(out).toMatchObject({ markdown: source, rewritten: 0, unresolved: [], remoteImages: [] });
    expect(calls).toEqual([]);
  });

  it('a link inside a code fence, an inline code span or raw HTML is untouched, even when the path would match', () => {
    const source = '```\n[A](a.md)\n```\n\n`[A](a.md)` and <a href="a.md">x</a>\n';
    const out = rewriteMarkdown(source, resolve);
    expect(out.markdown).toBe(source);
    expect(out.rewritten).toBe(0);
  });

  it('an https link, a mailto link and a fragment-only link are untouched and not counted', () => {
    const source = '[w](https://example.com/a.md) [m](mailto:x@example.com) [f](#top)\n';
    const out = rewriteMarkdown(source, resolve);
    expect(out).toMatchObject({ markdown: source, rewritten: 0, unresolved: [] });
  });

  it('a relative link that matches nothing stays as written and is reported unresolved, with its fragment', () => {
    const out = rewriteMarkdown('[gone](missing.md#x) and [A](a.md)\n', resolve);
    expect(out.markdown).toBe('[gone](missing.md#x) and [A](/p/AAA)\n');
    expect(out.unresolved).toEqual(['missing.md#x']);
  });

  it('a path that only looks like it has a scheme after a ./ is looked up like any other relative path', () => {
    const out = rewriteMarkdown('[x](./a:b.md)\n', resolve);
    expect(out.unresolved).toEqual(['./a:b.md']);
    expect(out.markdown).toBe('[x](./a:b.md)\n');
  });

  it('a page with nothing to rewrite comes back byte for byte, odd formatting included', () => {
    const source = '* one\n* two\n\n\nSetext\n======\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(rewriteMarkdown(source, resolve).markdown).toBe(source);
  });

  it('http and https images are listed in document order for the remote image step, and left as they are', () => {
    const source = '![a](https://example.com/a.png) text ![b](http://example.com/b.png) ![c](img/cat.png)\n';
    const out = rewriteMarkdown(source, resolve);
    expect(out.remoteImages).toEqual(['https://example.com/a.png', 'http://example.com/b.png']);
    expect(out.markdown).toBe('![a](https://example.com/a.png) text ![b](http://example.com/b.png) ![c](attachments/11/cat.png)\n');
  });

  it('a table and a task list survive the rewrite when another link on the page was rewritten', () => {
    const out = rewriteMarkdown('| a | b |\n| - | - |\n| [A](a.md) | 2 |\n\n- [x] done\n- [ ] open\n', resolve);
    expect(out.markdown).toContain('[A](/p/AAA)');
    expect(out.markdown).toMatch(/\| *a *\| *b *\|/);
    expect(out.markdown).toContain('* [x] done');
  });
});
