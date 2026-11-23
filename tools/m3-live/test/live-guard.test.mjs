// Offline: the live checker refuses to start without configuration and makes exactly one management call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFake } from './fake-provider.mjs';
import { runCheck, goodEnv } from './helpers.mjs';

for (const name of ['DESCOPE_DEV_PROJECT_ID', 'DESCOPE_DEV_TEST_LOGIN', 'DESCOPE_DEV_MANAGEMENT_KEY']) {
  test(`without ${name} it exits 2, names the variable and sends no request`, async () => {
    const fake = await startFake();
    try {
      const env = goodEnv(fake.url);
      delete env[name];
      const r = await runCheck(env);
      assert.equal(r.status, 2);
      assert.match(r.stderr, new RegExp(name));
      assert.equal(fake.requests.length, 0);
    } finally { await fake.close(); }
  });
}

test('an empty variable counts as unset', async () => {
  const r = await runCheck({ ...goodEnv('http://127.0.0.1:1'), DESCOPE_DEV_MANAGEMENT_KEY: '' });
  assert.equal(r.status, 2);
});

test('the only management request is the one-time code of the test user', async () => {
  const fake = await startFake();
  try {
    const r = await runCheck(goodEnv(fake.url));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const mgmt = fake.requests.filter((q) => q.path.startsWith('/v1/mgmt/'));
    assert.deepEqual(mgmt.map((q) => `${q.method} ${q.path}`), ['POST /v1/mgmt/tests/generate/otp']);
    assert.deepEqual(fake.requests.filter((q) => !q.path.startsWith('/v1/mgmt/')).map((q) => q.method), ['POST', 'GET']);
  } finally { await fake.close(); }
});
