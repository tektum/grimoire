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
  it('are 46: the generated document, the list the policy walk compares it with and the committed surface agree', () => {
    const surface = readFileSync(path.join(root, 'docs/api-surface.txt'), 'utf8')
      .split('\n')
      .filter((line) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(line));
    expect(operations()).toHaveLength(46);
    expect(EXPECTED_OPERATIONS).toHaveLength(46);
    expect(surface).toHaveLength(46);
  });

  it('include the seven of milestone 7, in the document, the list and the surface', () => {
    const keys = operations().map((o) => o.key);
    const listed = EXPECTED_OPERATIONS.map(([key]) => key);
    const surface = readFileSync(path.join(root, 'docs/api-surface.txt'), 'utf8');
    for (const key of M7) {
      expect(keys, key).toContain(key);
      expect(listed, key).toContain(key);
      expect(surface, key).toContain(`${key} | op:`);
    }
  });
});
