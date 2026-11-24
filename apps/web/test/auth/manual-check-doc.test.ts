// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const doc = readFileSync(path.join(root, 'docs/proof/m6-signin-manual.md'), 'utf8');

/** The rows of the table that follows the heading `title` (the cells of each row), header and separator left out. */
function rows(title: string): string[][] {
  const section = doc.split(/^## /m).find((s) => s.startsWith(title));
  if (section === undefined) return [];
  return section
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    .filter((cells) => !cells.every((c) => /^-+$/.test(c)))
    .slice(1);
}

describe('docs/proof/m6-signin-manual.md', () => {
  it('lists the nine recording items, R1 to R9, each once', () => {
    const items = rows('What is recorded');
    expect(items.map((r) => r[0])).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']);
  });

  it('has a row for each CSP option (C1 to C3)', () => {
    expect(rows('CSP options').map((r) => r[0])).toEqual(['C1', 'C2', 'C3']);
  });

  it('has no result row other than "not run" (the check has not been run)', () => {
    for (const row of [...rows('What is recorded'), ...rows('CSP options')]) expect([row[0], row.at(-1)]).toEqual([row[0], 'not run']);
    expect(doc).toContain('Status: **not run.**');
  });

  it('names what the owner has to provide or approve, the two writes that need approval first, and the job that never runs on a pull request', () => {
    for (const needle of [
      'development project',
      'approved origin',
      'sign-up-or-in',
      'test user',
      'DESCOPE_DEV_MANAGEMENT_KEY',
      'approval',
      'never runs on a pull request',
      'blocked: Descope dev project not provisioned',
    ])
      expect(doc).toContain(needle);
    expect(rows('What the owner has to provide or approve first').length).toBeGreaterThanOrEqual(6);
  });

  it('does not send the reader to a command that does not exist: the policy modes depend on the header renderer, said so', () => {
    expect(doc).not.toContain('--signin=');
    expect(doc).toContain('depends on the header renderer, which is not built yet');
    expect(rows('CSP options').find((r) => r[0] === 'C3')?.[1]).toContain('not built yet');
  });

  it('holds no secret, no project id and no machine path', () => {
    expect(doc).not.toMatch(/\bP2[A-Za-z0-9]{20,}\b/); // a project id
    expect(doc).not.toMatch(/\/home\/|\/Users\/|C:\\\\/);
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // a token
    expect(doc).not.toMatch(/Bearer dev:/);
  });
});

describe('the tests of the client and the end-to-end specs', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
  const files = [...walk(path.join(root, 'apps/web/test')), ...walk(path.join(root, 'apps/web/test-e2e'))].filter((f) => /\.(tsx?|mjs)$/.test(f) && !f.endsWith('manual-check-doc.test.ts'));

  it("name the provider's domain only in a route interception (none needs the provider or the network beyond localhost)", () => {
    const offenders = files
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f, i, line })),
      )
      .filter(({ line }) => /descope\.com/.test(line) && !/route\(/.test(line));
    expect(offenders.map(({ f, i }) => `${path.relative(root, f)}:${i + 1}`)).toEqual([]);
  });
});
