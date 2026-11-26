import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The settings the stack passes through to the application for a test target to change are empty unless it sets them, and an empty setting is an unset one (the environment schema says so): the default of the
// server is the default of the stack. A pass-through with a value of its own would pin the stack to a number the server may stop using.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const compose = readFileSync(new URL('compose.yaml', `file://${root}`), 'utf8');

test('the import expiry reaches the application and the migrate command (which defines the queues) only when a test sets it, and is empty (unset) otherwise', () => {
  const lines = compose.match(/^ {6}GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS: "\$\{GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS:-\}"$/gm) ?? [];
  assert.equal(lines.length, 2, 'one in the app service and one in the migrate service');
  const service = (name) => compose.match(new RegExp(`\\n {2}${name}:\\n[\\s\\S]*?(?=\\n {2}[a-z-]+:\\n|\\n[a-z]|$)`))?.[0] ?? '';
  for (const name of ['app', 'migrate']) assert.match(service(name), /GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS: "\$\{GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS:-\}"/, `the ${name} service passes it through`);
});

test('the sweep schedule reaches the application only when a test sets it, and is empty (unset) otherwise', () => {
  const lines = compose.match(/^ {6}GRIMOIRE_JOBS_SWEEP_CRON: "\$\{GRIMOIRE_JOBS_SWEEP_CRON:-\}"$/gm) ?? [];
  assert.equal(lines.length, 1, 'in the app service only: the migrate command defines no schedule');
});

test('the environment schema counts an empty value as unset', () => {
  const schema = readFileSync(new URL('packages/adapters/config-env/src/schema.ts', `file://${root}`), 'utf8');
  assert.match(schema, /empty string counts as unset/);
});
