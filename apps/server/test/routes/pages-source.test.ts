import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const files = { route: 'apps/server/src/routes/pages.ts', repo: 'packages/adapters/db-kysely/src/pages.ts', store: 'packages/adapters/db-kysely/src/page-store.ts' };

describe('what the page code must not contain', () => {
  it('names no state size cap in the route or the repository: the cap is a setting', () => {
    for (const file of [files.route, files.repo]) expect(read(file)).not.toMatch(/1_?000_?000|1_?536_?000|1,000,000|1,536,000/);
  });

  it('removes no page row: pages are only ever soft-deleted here', () => {
    for (const file of [files.route, files.repo]) expect(read(file)).not.toMatch(/delete\s+from\s+pages|deleteFrom\(\s*'pages'/i);
  });

  it('has the page store take the one hash definition from core', () => {
    expect(read(files.store)).toMatch(/import \{ markdownHash as hashOf \} from '@tektum\/grimoire-core\/pages\/hash'/);
  });
});
