import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { requiredGracePeriodMs } from '../../../apps/server/src/lifecycle/budget.ts';
import { APP_STOP_TIMEOUT_SECONDS, inStartOrder } from '../../../infra/stack/init-order.ts';

const task = (...names) => names.map((name) => ({ name, image: `${name}:1`, essential: true, environment: [{ name: 'X', value: name }] }));
const by = (definitions) => Object.fromEntries(definitions.map((d) => [d.name, d]));

test('the set-up and the migration finish before the app starts, one after the other', () => {
  const d = by(inStartOrder(task('db-setup', 'migrate', 'app')));
  assert.equal(d['db-setup'].dependsOn, undefined);
  assert.deepEqual(d.migrate.dependsOn, [{ containerName: 'db-setup', condition: 'SUCCESS' }]);
  assert.deepEqual(d.app.dependsOn, [{ containerName: 'migrate', condition: 'SUCCESS' }]);
});

test('only the app keeps the task alive: the steps before it may end without stopping it', () => {
  const d = by(inStartOrder(task('db-setup', 'migrate', 'app')));
  assert.deepEqual([d['db-setup'].essential, d.migrate.essential, d.app.essential], [false, false, true]);
});

test('the order does not depend on the order of the definitions, and the rest of a definition and any other container pass through', () => {
  const input = [...task('app', 'migrate'), { name: 'sidecar', essential: true }, ...task('db-setup')];
  const out = inStartOrder(input);
  assert.deepEqual(out.map((d) => d.name), ['app', 'migrate', 'sidecar', 'db-setup']);
  assert.deepEqual(by(out).sidecar, { name: 'sidecar', essential: true });
  assert.deepEqual(by(out).app.environment, [{ name: 'X', value: 'app' }]);
  assert.equal(by(out).app.image, 'app:1');
  assert.deepEqual(input[0].dependsOn, undefined); // the input is not changed
});

test('a task without one of the three containers is refused, naming what it has', () => {
  assert.throws(() => inStartOrder(task('migrate', 'app')), /no container "db-setup" \(it has migrate, app\)/);
});

test('the app alone gets a stop timeout, and it covers what the server needs to drain and save the open pages (and ECS allows)', () => {
  const d = by(inStartOrder(task('db-setup', 'migrate', 'app')));
  assert.equal(d.app.stopTimeout, APP_STOP_TIMEOUT_SECONDS);
  assert.equal(d['db-setup'].stopTimeout, undefined);
  assert.equal(d.migrate.stopTimeout, undefined);
  const schema = readFileSync(new URL('../../../packages/adapters/config-env/src/schema.ts', import.meta.url), 'utf8');
  const defaultSaveMs = Number(/GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: field\(int\(1, MAX_INT\)\)\.default\((\d+)\)/.exec(schema)?.[1]);
  assert.ok(defaultSaveMs > 0);
  assert.ok(APP_STOP_TIMEOUT_SECONDS * 1000 >= requiredGracePeriodMs(defaultSaveMs), 'SIGKILL would come before the server has finished saving');
  assert.ok(APP_STOP_TIMEOUT_SECONDS <= 120, 'Fargate allows at most 120 seconds');
});

test('no component of the staging stack is named "App": SST refuses that name for a linkable component and the whole diff fails with it', () => {
  const source = readFileSync(new URL('../../../infra/stage.ts', import.meta.url), 'utf8');
  const names = [...source.matchAll(/new (?:sst|aws|random|descope)\.[\w.]+\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.includes("Server"), names.join());
  assert.equal(names.some((name) => name.toLowerCase() === 'app'), false, names.join());
});

test('every load balancer rule of the staging service names its container: SST refuses a rule without one when the task has more than one container (app, migrate, db-setup), a check that only a deploy ran before', () => {
  const source = readFileSync(new URL('../../../infra/stage.ts', import.meta.url), 'utf8');
  const rules = [...source.matchAll(/\{ listen: '[^']+'[^\n]*\},?$/gm)].map((m) => m[0]);
  assert.equal(rules.length, 2, rules.join());
  for (const rule of rules) assert.match(rule, /container: '(app)'/, rule);
});
