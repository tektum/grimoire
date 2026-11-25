import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { openArchive } from '../../../src/import/zip-reader.js';
import { SegmentStore } from '../hostile/segment-store.js';
import { buildNotionExport, buildPlainMarkdownExport, NOTION_CONSTRUCTS, notionExportFiles, plainMarkdownFiles } from './notion-synthetic/build.js';

// M7-T03a: the fixtures hold what the contracts list, read with the zip reader of M7-T03, and build to the same bytes every time.
const REQUIRED = [
  'id of 32 hex characters after a space', 'id of 32 hex characters without a space', 'nested folders', 'a page with children', 'duplicate titles with different ids', 'a long name',
  'a URL-encoded link', 'a plain link with ../', 'images and files in sibling folders', 'a PDF', 'an aside with an emoji', 'details and summary', 'a to-do list', 'a table', 'a code fence',
  'a $$ equation', 'front matter', 'a database summary csv (_all.csv)', 'a database csv', 'database rows with page files and rows without', 'a csv with a BOM', 'a nested zip',
];

const readAll = async (archive: Buffer): Promise<Map<string, Buffer>> => {
  const s = new SegmentStore([{ bytes: archive }]);
  const opened = await openArchive(s, 'imports/x.zip', s.size, defaultImportConfig);
  if (opened.kind !== 'ok') throw new Error(`the archive is refused: ${opened.reason}`);
  const out = new Map<string, Buffer>();
  for (const entry of opened.entries) {
    const chunks: Buffer[] = [];
    for await (const chunk of await opened.reader.openEntry(entry, defaultImportConfig)) chunks.push(chunk as Buffer);
    out.set(entry.path, Buffer.concat(chunks));
  }
  opened.reader.close();
  return out;
};

describe('the synthetic Notion export', () => {
  it('names every construct the contracts list, and holds each', () => {
    expect(NOTION_CONSTRUCTS.map((c) => c.name).sort()).toEqual([...REQUIRED].sort());
    const files = notionExportFiles();
    const missing = NOTION_CONSTRUCTS.filter((c) => !c.present(files)).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it('is read back by the zip reader with the content that was put in, and passes the header check', async () => {
    const read = await readAll(buildNotionExport());
    const files = notionExportFiles();
    expect([...read.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, content] of files) expect(read.get(path)?.equals(content), path).toBe(true);
  });

  it('builds to the same bytes twice', () => {
    expect(buildNotionExport().equals(buildNotionExport())).toBe(true);
    expect(buildPlainMarkdownExport().equals(buildPlainMarkdownExport())).toBe(true);
  });

  it('says in the first line of its README that it is constructed and not observed', () => {
    const first = readFileSync(new URL('./notion-synthetic/README.md', import.meta.url), 'utf8').split('\n')[0] ?? '';
    expect(first).toContain('constructed');
    expect(first).toContain('not observed');
  });
});

describe('the plain Markdown export', () => {
  it('has at least 30 pages in 3 levels, 10 relative links, 5 images, and a link that matches nothing', async () => {
    const files = plainMarkdownFiles();
    const pages = [...files.keys()].filter((p) => p.endsWith('.md'));
    expect(pages.length).toBeGreaterThanOrEqual(30);
    expect(Math.max(...pages.map((p) => p.split('/').length))).toBe(3);
    const text = pages.map((p) => files.get(p)?.toString() ?? '').join('\n');
    const links = [...text.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1] as string);
    expect(links.filter((l) => !/^[a-z]+:/.test(l)).length).toBeGreaterThanOrEqual(10);
    expect([...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].length).toBeGreaterThanOrEqual(5);
    const base = (p: string): string => p.split('/').slice(0, -1).join('/');
    const dangling = pages.flatMap((p) => [...(files.get(p)?.toString() ?? '').matchAll(/\]\(([^)]+)\)/g)].map((m) => ({ from: p, to: m[1] as string }))).filter(({ from, to }) => {
      const parts = [...(base(from) === '' ? [] : base(from).split('/'))];
      for (const seg of to.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
      return !files.has(parts.join('/'));
    });
    expect(dangling.map((d) => d.to)).toEqual(['missing/nowhere.md']);
  });

  it('is read back by the zip reader', async () => {
    const read = await readAll(buildPlainMarkdownExport());
    expect([...read.keys()].sort()).toEqual([...plainMarkdownFiles().keys()].sort());
  });
});
