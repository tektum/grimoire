import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findOperatorUses } from '../check-operator-sites.mjs';
import { OPERATOR_SITES } from '../operator-sites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A repository of the given files (path from its root: content), removed after `check` returns. */
function inTree(files, check) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'operator-sites-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return check(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const offender = "import { operator } from '@tektum/grimoire-adapter-db-kysely';\nimport type { OperatorDatabase } from 'x';\nexport const run = (ops: OperatorDatabase | undefined) => operator(ops);\n";

test('a module outside the registry that uses the operator handle is found, at each use', () => {
  const found = inTree({ 'apps/server/src/jobs/sweep.ts': offender, 'apps/server/src/boot.ts': 'const ops = createOpsDatabase(url);\n' }, (dir) => findOperatorUses(dir, []));
  assert.deepEqual(found, ['apps/server/src/boot.ts:1 createOpsDatabase', 'apps/server/src/jobs/sweep.ts:1 operator', 'apps/server/src/jobs/sweep.ts:2 OperatorDatabase', 'apps/server/src/jobs/sweep.ts:3 OperatorDatabase', 'apps/server/src/jobs/sweep.ts:3 operator']);
});

test('a module that reads the operator URL from the settings is found: a plain database over it would be the operator role with `query`', () => {
  const reads = "const a = createDatabase(config.database.opsUrl!);\nconst b = settings['opsUrl'];\nconst { opsUrl } = config.database;\nconst { opsUrl: renamed } = config.database;\n";
  const found = inTree({ 'apps/server/src/jobs/sweep.ts': reads }, (dir) => findOperatorUses(dir, []));
  assert.deepEqual(found, ['apps/server/src/jobs/sweep.ts:1 opsUrl', 'apps/server/src/jobs/sweep.ts:2 opsUrl', 'apps/server/src/jobs/sweep.ts:3 opsUrl', 'apps/server/src/jobs/sweep.ts:4 opsUrl']);
});

test('the settings that define the operator URL, and composition, which hands it to createOpsDatabase, may read it', () => {
  const reads = 'const url = config.database.opsUrl;\n';
  const found = inTree({
    'packages/adapters/config-env/src/schema.ts': reads, 'packages/core/src/ports/config.ts': reads, 'apps/server/src/composition.ts': reads,
  }, (dir) => findOperatorUses(dir, []));
  assert.deepEqual(found, []);
});

test('operator reached as a property (`import * as db`, then `db.operator(ops)`) is found', () => {
  const found = inTree({ 'apps/server/src/jobs/sweep.ts': "import * as db from '@tektum/grimoire-adapter-db-kysely';\nconst ops = db.operator(handle);\nconst f = db.operator;\n" }, (dir) => findOperatorUses(dir, []));
  assert.deepEqual(found, ['apps/server/src/jobs/sweep.ts:2 operator', 'apps/server/src/jobs/sweep.ts:3 operator']);
});

test('a registered module, the module that defines the handle, test files, comments, strings and object keys named operator or opsUrl pass', () => {
  const found = inTree({
    'apps/server/src/jobs/sweep.ts': offender,
    'packages/adapters/db-kysely/src/index.ts': 'export function createOpsDatabase() {}\nexport interface OperatorDatabase {}\nexport function operator() {}\n',
    'packages/adapters/db-kysely/test/handles.int.test.ts': offender,
    'apps/server/src/other.ts': "// OperatorDatabase and createOpsDatabase in a comment\nconst s = 'operator(ops) config.database.opsUrl';\nconst rule = { operator: 'is-true', opsUrl: 'x' };\n",
    'apps/server/dist/sweep.js': offender,
  }, (dir) => findOperatorUses(dir, [{ module: 'apps/server/src/jobs/sweep.ts', reason: 'sweeps every tenant' }]));
  assert.deepEqual(found, []);
});

test('an entry without a reason is refused: the registry says why each module crosses tenants', () => {
  assert.throws(() => inTree({}, (dir) => findOperatorUses(dir, [{ module: 'apps/server/src/jobs/sweep.ts', reason: '' }])), /reason/);
});

test('the repository uses the operator handle only where the registry allows', () => {
  assert.deepEqual(findOperatorUses(root, OPERATOR_SITES), []);
});
