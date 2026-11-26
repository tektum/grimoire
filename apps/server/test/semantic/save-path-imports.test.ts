import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// M7-T13: embedding is not in the path of a save, so the code a save runs through imports none of the semantic or embedding code. The path is the page store that the collaboration host saves
// with, and the host. The page store takes `scoped` from its adapter's barrel (`./index.js`), which re-exports the embedding store: that is a load of the module, not a use, so the check reads
// the module names AND the names a file brings in, and a file that took the embedding store from the barrel (or any `embed`/`semantic` name) fails it. (`jobs/not-in-save-path.int.test.ts`
// shows the other half on a database: a save is fast while the embedder is stuck.)
const root = path.resolve(import.meta.dirname, '../../../..');
const sourcesOf = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesOf(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
/** The module names a source text imports or re-exports from, with the names it takes from each, on one line or several, and its dynamic and side-effect imports. */
const importedFrom = (text: string): string[] => [...text.matchAll(/\b(?:import|export)\s+([^;'"]*?)\s*from\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)]
  .flatMap((m) => m.slice(1).filter((part): part is string => part !== undefined && part !== ''));
const touchesEmbedding = (part: string): boolean => /semantic|embed/i.test(part);

describe('the source of the save path', () => {
  it('imports nothing of the semantic or embedding code', () => {
    const files = [path.join(root, 'packages/adapters/db-kysely/src/page-store.ts'), ...sourcesOf(path.join(root, 'packages/adapters/collab-hocuspocus/src'))];
    expect(files.length).toBeGreaterThan(5);
    const offending = files.flatMap((file) => importedFrom(readFileSync(file, 'utf8')).filter(touchesEmbedding).map((spec) => `${path.relative(root, file)}: ${spec}`));
    expect(offending).toEqual([]);
  });

  it('sees an import of the embedding code however it is written, so a clean result means something', () => {
    const written = [
      `import { x } from '@tektum/grimoire-core/semantic/chunk';`,
      `import {\n  a,\n  b,\n} from '../jobs/embed-page.js';`,
      `export * from '@tektum/grimoire-core/ports/embedding-store';`,
      `const m = await import('./semantic/model-key.js');`,
      `import '@tektum/grimoire-core/semantic/side-effect';`,
      `import { createEmbeddingStore } from './index.js';`, // through the barrel: the specifier is clean, the name is not
      `import {\n  scoped,\n  type EmbeddingStore,\n} from '@tektum/grimoire-adapter-db-kysely';`,
    ];
    for (const text of written) expect(importedFrom(text).filter(touchesEmbedding), text).not.toHaveLength(0);
    expect(importedFrom(`import { y } from 'kysely';\nimport type { Q } from '../ports/page-repo.js';\nimport { scoped } from './index.js';`).filter(touchesEmbedding)).toEqual([]);
  });
});
