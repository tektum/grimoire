import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { operations } from '../security/document.js';
import { EXPECTED_OPERATIONS } from '../security/expected-operations.js';

// M7-T07: the final count of the API. Milestone 7 adds seven operations (search, and create, get, items, source, cancel and start of an import) to the 39 before it. The contracts of the milestone said
// 45 in total, counted before the 39 were counted on main: the document, the list of the policy walk and the committed surface all say 46, and this is the place that says so.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const M7 = ['GET /v1/search', 'POST /v1/imports', 'GET /v1/imports/{id}', 'GET /v1/imports/{id}/items', 'GET /v1/imports/{id}/items/{itemId}/source', 'POST /v1/imports/{id}/cancel', 'POST /v1/imports/{id}/start'];

describe('the operations of the API at the end of milestone 7', () => {
  const surface = (): string[] =>
    readFileSync(path.join(root, 'docs/api-surface.txt'), 'utf8')
      .split('\n')
      .filter((line) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(line))
      .map((line) => line.split(' | ')[0] as string);

  it('are 46, and the generated document, the list the policy walk compares it with and the committed surface name the same ones', () => {
    const keys = operations()
      .map((o) => o.key)
      .sort();
    expect(keys).toHaveLength(46);
    expect(new Set(keys).size, 'no operation twice').toBe(46);
    expect([...EXPECTED_OPERATIONS.map(([key]) => key)].sort()).toEqual(keys);
    expect([...surface()].sort()).toEqual(keys);
  });

  it('include the seven of milestone 7', () => {
    const keys = operations().map((o) => o.key);
    for (const key of M7) expect(keys, key).toContain(key);
  });
});
