import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * A test that empties a database must have created that database itself, or it wipes the shared `grimoire` database
 * under everyone using the stack. Limits: a text check. It sees `DROP SCHEMA` and `TRUNCATE <name>` statements in test files and
 * accepts any file that also contains `CREATE DATABASE` or calls createTestDatabase; it cannot tell that the statement runs
 * against that database, nor see SQL assembled at run time or kept in another file.
 */
const DESTRUCTIVE = /\bDROP\s+SCHEMA\b|\bTRUNCATE\s+(?:TABLE\s+)?["a-z_]/i;
const OWN_DATABASE = /\bCREATE\s+DATABASE\b|\bcreateTestDatabase\b/i;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mjs|js)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}dist${path.sep}`) && /[\\/](test|test-e2e)[\\/]/.test(f));
}

it('destructive SQL appears only in test files that create their own database', () => {
  const offenders = ['apps', 'packages']
    .flatMap((d) => testFiles(path.join(root, d)))
    .filter((f) => f !== fileURLToPath(import.meta.url))
    .filter((f) => { const t = readFileSync(f, 'utf8'); return DESTRUCTIVE.test(t) && !OWN_DATABASE.test(t); })
    .map((f) => path.relative(root, f));
  expect(offenders).toEqual([]);
});
