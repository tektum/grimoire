import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inStartOrder } from '../../../infra/staging/init-order.ts';

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
