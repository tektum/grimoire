import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyFields, exampleBody, operations } from './document.js';
import { USER_ID, bodyHints, buildWorld, pathFor } from './world.js';

/**
 * User Markdown reaches the database only through `seedUserMarkdown` (strict limits, the user's id as key, 422 for a refusal) and is stored with its editor
 * state. The walk finds every operation whose body has a Markdown field in the generated document, sends it Markdown the converter refuses, and checks that
 * nothing changed; the sources are read to check that no other path writes Markdown.
 */
const SENTENCE = 'The page has 3 headings, the limit is 2.';
const withMarkdown = operations().filter((op) => bodyFields(op).includes('markdown'));

describe('the operations with a Markdown field', () => {
  it('are the ones this walk knows: creating a page and resetting its state', () => {
    expect(withMarkdown.map((o) => o.key)).toEqual(['POST /v1/pages', 'POST /v1/pages/{id}/reset-state']);
  });

  it.each(withMarkdown.map((o) => [o.key, o] as const))('%s: Markdown over the limit is 422 invalid with the converter\'s sentence, the seed key is the caller, and nothing changes', async (_key, op) => {
    const w = await buildWorld();
    w.converter.enqueueSeed({ ok: false, reason: 'too-large', detail: SENTENCE });
    const snapshot = (): string => JSON.stringify({
      pages: w.pages.count(), page: w.pages.stored(w.ids.page), state: w.pageState.stored(w.ids.page), hiddenState: w.pageState.stored(w.ids.hiddenPage),
      audit: w.collections.audit.events.length, stateAudit: w.pageState.audit.length,
    });
    const before = snapshot();
    const body = { ...(exampleBody(op.bodySchema as never, bodyHints(w)) as object), markdown: '# a page over every limit' };
    const res = await w.call('admin', op.method, pathFor(op, w), body);
    expect([res.status, await res.json()]).toEqual([422, { error: { code: 'invalid', message: SENTENCE } }]);
    expect(snapshot()).toBe(before);
    expect(w.converter.seedKeys).toEqual([USER_ID.admin]);
    expect(w.converter.reseedKeys).toEqual([]);
  });
});

describe('the sources', () => {
  const routes = new URL('../../src/routes/', import.meta.url);
  const routeFiles = readdirSync(routes).filter((f) => f.endsWith('.ts')).map((file) => ({ file, text: readFileSync(new URL(file, routes), 'utf8') }));
  const ports = new URL('../../../../packages/core/src/ports/', import.meta.url);
  const portFiles = readdirSync(ports).filter((f) => f.endsWith('.ts')).map((file) => ({ file, text: readFileSync(new URL(file, ports), 'utf8') }));

  it('a route that reads the Markdown of a body seeds it with seedUserMarkdown', () => {
    const readers = routeFiles.filter(({ text }) => /\bbody\.markdown\b|\.markdown\b[^:]/.test(text) && /valid\('json'\)/.test(text));
    expect(readers.map((r) => r.file).sort()).toEqual(['pages.ts', 'reset-state.ts']);
    for (const { file, text } of readers) expect(text, file).toMatch(/seedUserMarkdown\(/);
  });

  it('no route calls the seed or the rebuild of the converter itself', () => {
    for (const { file, text } of routeFiles) expect(text, file).not.toMatch(/converter\.(seed|reseed)\(/);
  });

  it('no repository method takes Markdown as a plain string: writes take a SeededContent, whose state comes with it', () => {
    // Method parameters named `markdown: string` anywhere but the converter's own port and the callback of the host's seed (the system rebuild from stored Markdown).
    const offenders = portFiles
      .filter(({ file }) => file !== 'markdown-converter.ts' && file !== 'collaboration-host.ts')
      .flatMap(({ file, text }) => text.split('\n').map((line, i) => ({ file, line: i + 1, text: line })).filter((l) => /\([^)]*\bmarkdown: string/.test(l.text)));
    expect(offenders).toEqual([]);
    for (const file of ['page-repo.ts', 'page-state-repo.ts']) expect(portFiles.find((p) => p.file === file)?.text, file).toMatch(/content\??: SeededContent/);
  });
});
