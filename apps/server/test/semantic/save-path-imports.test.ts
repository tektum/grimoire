import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// M7-T13: embedding is not in the path of a save, so the code a save runs through imports none of the semantic or embedding code. The path is the page store that the collaboration host saves
// with, and the host. (`jobs/not-in-save-path.int.test.ts` shows the other half on a database: a save is fast while the embedder is stuck.)
const root = path.resolve(import.meta.dirname, '../../../..');
const sourcesOf = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesOf(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
/** The module names a source text imports or re-exports from, on one line or several, and its dynamic imports. */
const importedFrom = (text: string): string[] => [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
const touchesEmbedding = (specifier: string): boolean => /semantic|embed/i.test(specifier);

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
    ];
    for (const text of written) expect(importedFrom(text).filter(touchesEmbedding), text).toHaveLength(1);
    expect(importedFrom(`import { y } from 'kysely';\nimport type { Q } from '../ports/page-repo.js';`).filter(touchesEmbedding)).toEqual([]);
  });
});
