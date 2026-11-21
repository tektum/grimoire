import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as decideModule from '../../src/authorize/decide.js';
import { createAuthorizer } from '../../src/authorize/authorizer.js';
import { decide, decideCollection } from '../../src/authorize/decide.js';
import { accessCases, collectionExpectOf, collectionFactsOfCase, factsOfCase, worldOfCases } from '../../src/testing/access-cases.js';
import { createFakeAccessStore } from '../../src/testing/fake-access-store.js';
import type { AccessStore } from '../../src/ports/access-store.js';

// Mutation check: each mutant is the real source with one line changed, loaded from a scratch copy; the shared table must catch it.
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const { world, ids } = worldOfCases();

type DecideFn = typeof decide;
type CollectionFn = typeof decideCollection;

function failuresOfDecide(fn: DecideFn): number {
  return accessCases.filter((c, i) => {
    const id = ids[i];
    if (!id) return true;
    const d = fn(factsOfCase(c, id, i + 1), { includeDeleted: c.includeDeleted });
    return (d.access === 'none' ? d.reason : d.access) !== c.expect;
  }).length;
}
function failuresOfCollection(fn: CollectionFn): number {
  return accessCases.filter((c, i) => {
    const id = ids[i];
    const want = collectionExpectOf(c);
    if (!id || want === 'skip') return false;
    const d = fn(collectionFactsOfCase(c, id), { includeDeleted: c.includeDeleted });
    return (d.access === 'none' ? d.reason : d.access) !== want;
  }).length;
}
async function failuresOfStore(store: AccessStore): Promise<number> {
  const a = createAuthorizer(store);
  let bad = 0;
  for (const [i, c] of accessCases.entries()) {
    const id = ids[i];
    if (!id) { bad++; continue; }
    const d = await a.check({ userId: id.userId, pageId: id.pageId }, { includeDeleted: c.includeDeleted });
    if ((d.access === 'none' ? d.reason : d.access) !== c.expect) bad++;
    const want = collectionExpectOf(c);
    if (want !== 'skip') {
      const k = await a.checkCollection({ userId: id.userId, collectionId: id.collectionId }, { includeDeleted: c.includeDeleted });
      if ((k.access === 'none' ? k.reason : k.access) !== want) bad++;
    }
  }
  return bad;
}

/** Compiles `file` with `from` replaced by `to` (the replacement must happen) and evaluates it as CommonJS; its only runtime import is the real decide module. */
function mutate<T>(file: string, from: string, to: string, name: string): T {
  const source = readFileSync(path.join(SRC, file), 'utf8');
  if (!source.includes(from)) throw new Error(`mutant ${name}: the line to change is gone from ${file}`);
  const js = ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const fn: unknown = runInThisContext(`(function (module, exports, require) {${js}\n})`, { filename: `mutant-${name}.js` });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  Reflect.apply(fn as (...a: unknown[]) => unknown, undefined, [mod, mod.exports, (id: string) => (id === '../authorize/decide.js' ? decideModule : {})]);
  return mod.exports as T;
}

describe('mutants', () => {
  it('the unmutated code passes the table', async () => {
    expect(failuresOfDecide(decide)).toBe(0);
    expect(failuresOfCollection(decideCollection)).toBe(0);
    expect(await failuresOfStore(createFakeAccessStore(world))).toBe(0);
  });
  it('mutant 1: the viewer cap removed in decide fails the table', () => {
    const m = mutate<{ decide: DecideFn }>('authorize/decide.ts', 'Math.min(best, 1)', 'best', 'm1');
    expect(failuresOfDecide(m.decide)).toBeGreaterThan(0);
  });
  it('mutant 2: group entries ignored in the store fails the table', async () => {
    const m = mutate<{ createFakeAccessStore: typeof createFakeAccessStore }>('testing/fake-access-store.ts', '|| (a.groupId !== undefined && groups.has(a.groupId))', '', 'm2');
    expect(await failuresOfStore(m.createFakeAccessStore(world))).toBeGreaterThan(0);
  });
  it('mutant 3: the collection deleted flag ignored in collectionFacts fails the table', async () => {
    const m = mutate<{ createFakeAccessStore: typeof createFakeAccessStore }>('testing/fake-access-store.ts', 'deleted: c.deleted, defaultPermission', 'deleted: false, defaultPermission', 'm3');
    expect(await failuresOfStore(m.createFakeAccessStore(world))).toBeGreaterThan(0);
  });
  it('mutant 4: the viewer cap removed in decideCollection fails the table', () => {
    const m = mutate<{ decideCollection: CollectionFn }>('authorize/decide.ts', 'Math.min(best, 1)', 'best', 'm4');
    expect(failuresOfCollection(m.decideCollection)).toBeGreaterThan(0);
  });
});
