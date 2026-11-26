import { describe, expect, it, vi } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { passOne, passTwo } from '../../../src/import/engine.js';
import { notionProfile } from '../../../src/import/notion/profile.js';
import { openArchive } from '../../../src/import/zip-reader.js';
import { SegmentStore } from '../hostile/segment-store.js';
import { buildSegments } from '../hostile/zip-builder.js';
import type { BuilderEntry } from '../hostile/zip-builder.js';

// The constructs of a Notion page that the import converts, drops or keeps are counted for each page (the construct report, spec R6.41), from the text the engine really handles.
const TENANT = 't';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const text = (s: string) => new TextEncoder().encode(s);
const file = (name: string, body: string): BuilderEntry => ({ name, data: Buffer.from(body) });
class EchoConverter implements MarkdownConverter {
  seed(markdown: string): Promise<SeedResult> { return Promise.resolve({ ok: true, state: text(markdown.length === 0 ? ' ' : markdown) }); }
  toMarkdown(state: Uint8Array): Promise<ConvertResult> {
    const markdown = new TextDecoder().decode(state).replace(/^ $/, '');
    return Promise.resolve({ ok: true, markdown, text: markdown });
  }
  reseed(): Promise<SeedResult> { return Promise.reject(new Error('not used')); }
  close(): Promise<void> { return Promise.resolve(); }
}

async function run(entries: readonly BuilderEntry[]) {
  const store = new SegmentStore(buildSegments(entries as BuilderEntry[]));
  const opened = await openArchive(store, 'imports/x.zip', store.size, defaultImportConfig);
  if (opened.kind !== 'ok') throw new Error(`refused: ${opened.reason}`);
  const repo = new FakeImportRepo();
  repo.seed({ id: 'imp', tenantId: TENANT, status: 'running', createdBy: 'user-1', targetCollectionId: 'col' });
  await passOne(repo, TENANT, 'imp', opened.entries, { profile: notionProfile, allowNestedZips: false, maxPages: 10_000 });
  const deps = {
    repo, files: new FakeFileStorage(), converter: new EchoConverter(), profile: notionProfile, ordering: { between: (before: string | null) => `${before ?? ''}a`, isValidPosition: () => true },
    reader: { openEntry: vi.fn(opened.reader.openEntry.bind(opened.reader)) }, entries: opened.entries,
    limits: { ...defaultImportConfig, maxStateBytes: 1_536_000, seedMaxMarkdownBytes: 128 * 1024 }, pageLimits: { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 }, now: () => 1_700_000_000_000,
  };
  const record = await repo.get(TENANT, 'imp');
  if (record === undefined) throw new Error('no import');
  expect((await passTwo(deps, record)).kind).toBe('done');
  return { repo, constructsOf: (title: string) => repo.written.find((w) => w.page.title === title)?.page.constructs };
}

describe('the constructs counted for a page', () => {
  it('counts what was dropped, converted and kept on the page, once each time it happened', async () => {
    const t = await run([
      file(`Alpha ${A}.md`, [
        '---', 'icon: 🙂', 'cover: https://example.invalid/c.png', 'status: Done', '---', '',
        '<aside>', '💡 One', '</aside>', '', '<aside>', '💡 Two', '</aside>', '',
        '<details>', '<summary>More</summary>', '', 'hidden', '', '</details>', '',
        `Links: [Beta](Beta%20${B}.md) and [Beta again](Beta%20${B}.md) and [gone](Gone%20${'c'.repeat(32)}.md).`, '',
        'Plain <u>underlined</u> text.', '',
      ].join('\n')),
      file(`Beta ${B}.md`, 'Just text.\n'),
    ]);
    expect(t.constructsOf('Alpha')).toEqual({ icon_cover: 1, front_matter: 1, callout: 2, toggle: 1, page_mention: 2, unresolved_link: 1, raw_html: 2 });
    expect(t.constructsOf('Beta')).toEqual({});
  });

  it('front matter with only icon and cover keys is icon_cover alone, and front matter with other keys only is front_matter alone', async () => {
    const t = await run([
      file(`Alpha ${A}.md`, '---\nicon: 🙂\ncover: x\n---\n\nText.\n'),
      file(`Beta ${B}.md`, '---\nstatus: Done\ntags: [a]\n---\n\nText.\n'),
    ]);
    expect(t.constructsOf('Alpha')).toEqual({ icon_cover: 1 });
    expect(t.constructsOf('Beta')).toEqual({ front_matter: 1 });
  });
});
