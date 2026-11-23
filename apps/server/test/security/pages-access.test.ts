import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { operations } from './document.js';

/**
 * Where a page is read or written, the decision comes from the shared authoriser (security review F7; the runtime role keeps plain DML grants, decision 128, so
 * nothing in the database refuses a query that a route forgot to check). Read from the sources, so a route added later is held to it too.
 */
const routesDir = new URL('../../src/routes/', import.meta.url);
const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
const source = (name: string): string => readFileSync(new URL(name, routesDir), 'utf8');
const all = files.map((f) => ({ file: f, text: source(f) }));

/** The text of the handler of an operation: from its `router.openapi(<name>, ...)` to the next handler or the end of the file. */
function handlerOf(operationId: string): { file: string; text: string } | undefined {
  for (const { file, text } of all) {
    const at = text.search(new RegExp(`router\\.openapi\\(\\s*${operationId}\\s*,`));
    if (at < 0) continue;
    const rest = text.slice(at + 1);
    const next = rest.search(/router\.openapi\(|export default/);
    return { file, text: text.slice(at, next < 0 ? undefined : at + 1 + next) };
  }
  return undefined;
}

describe('routes and pages', () => {
  it('no route queries the database itself: pages and page chunks are reached only through the repositories', () => {
    for (const { file, text } of all) {
      expect(text, `${file} runs SQL`).not.toMatch(/\.query\(|\b(from|join|update|into)\s+(pages|page_chunks)\b/i);
      expect(text, `${file} reaches an adapter`).not.toMatch(/grimoire-adapter-|\bdb\./);
    }
  });

  it('the two guards that routes call take their decision from the core authoriser', () => {
    expect(readFileSync(new URL('../../src/http/page-guard.ts', import.meta.url), 'utf8')).toMatch(/\.access\.pageAccess\(/);
    expect(readFileSync(new URL('../../src/http/collection-guard.ts', import.meta.url), 'utf8')).toMatch(/\.authorizer\.checkCollection\(/);
  });

  // Every route that reads or writes a page, or a collection's pages: the pages and trash routes, the tree, and the collection that is deleted with its pages.
  const touchesPages = (path: string, method: string): boolean => /^\/v1\/(pages|trash)/.test(path) || path.endsWith('/tree') || (method === 'DELETE' && path === '/v1/collections/{id}');
  // The authoriser, or the role of an administrator (who reads everything: the one purge that needs no more than the role).
  const checked = /guardPage\(|guardCollection\(|authorizer\.(checkCollection|visibleCollections)\(|\.pageAccess\(|role !== 'admin'|requireAdmin\(/;

  /** Whether the text, or a function of the same file that it calls with the request context, takes the decision. One level of helper is enough for these routes. */
  function decides(file: string, text: string, depth = 2): boolean {
    if (checked.test(text)) return true;
    if (depth === 0) return false;
    const fileText = all.find((a) => a.file === file)?.text ?? '';
    for (const [, name] of text.matchAll(/\b(\w+)\(c[,)]/g)) {
      const at = fileText.search(new RegExp(`(async function|function|const)\\s+${name as string}\\b`));
      if (at < 0) continue;
      const end = fileText.slice(at + 1).search(/\n(export |async function |function |const |router\.)/);
      if (decides(file, fileText.slice(at, end < 0 ? undefined : at + 1 + end), depth - 1)) return true;
    }
    return false;
  }

  it.each(operations().filter((o) => touchesPages(o.path, o.method)).map((o) => [o.key, o] as const))('%s calls the authoriser, directly or through a guard', (_key, op) => {
    const handler = handlerOf(op.operationId);
    expect(handler, `no handler found for ${op.operationId}`).toBeDefined();
    expect(decides(handler?.file ?? '', handler?.text ?? ''), `${handler?.file}: ${op.operationId}`).toBe(true);
  });

  it('matches the walk: every operation has exactly one handler in the routes directory', () => {
    for (const op of operations()) {
      const count = all.reduce((n, { text }) => n + [...text.matchAll(new RegExp(`router\\.openapi\\(\\s*${op.operationId}\\s*,`, 'g'))].length, 0);
      expect(count, op.key).toBe(1);
    }
  });
});
