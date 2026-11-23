// Offline: the live checker's claim checks, against a fake provider with a recorded-shape RS256 token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFake, PROJECT_ID } from './fake-provider.mjs';
import { runCheck, goodEnv } from './helpers.mjs';

async function run(claims, header, flags) {
  const fake = await startFake(claims, header, flags);
  try { return await runCheck(goodEnv(fake.url)); } finally { await fake.close(); }
}

test('a well-formed session token passes every claim check and prints no token', async () => {
  const r = await run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/^ok /gm) ?? []).length, 6);
  assert.doesNotMatch(r.stdout + r.stderr, /eyJ|123456|mgmt-secret/);
});

for (const [name, claims, header, line] of [
  ['an issuer in URL form is refused', { iss: `https://api.descope.com/${PROJECT_ID}` }, {}, 'issuer is the project id'],
  ['a refresh token (drn DSR) is refused', { drn: 'DSR' }, {}, 'issuer is the project id'],
  ['an expired token is refused', { exp: 1 }, {}, 'issuer is the project id'],
  ['another algorithm is refused', {}, { alg: 'RS512' }, 'RS256 with a key id'],
]) {
  test(name, async () => {
    const r = await run(claims, header);
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`FAIL .*${line}`));
  });
}

test('a token whose key id is not in the key set fails the key and signature checks', async () => {
  const r = await run({}, { kid: 'other' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL the public key set has an RS256 key/);
  assert.match(r.stdout, /FAIL the signature verifies/);
});

test('a token whose key id matches but whose signature is wrong fails the signature check only', async () => {
  const r = await run({}, {}, { wrongSignature: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ok the public key set has an RS256 key/);
  assert.match(r.stdout, /FAIL the signature verifies/);
});
