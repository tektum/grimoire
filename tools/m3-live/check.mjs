// Live sign-in check against a real provider project (TEST TOOL, never shipped; run by hand with `make test-m3-live`, never in CI, and never run so far).
// Signs the existing test user in with a one-time code that the management API generates for test users, then checks what the application's verifier relies on, with Node
// built-ins only (a provider SDK may appear only inside its adapter):
//   1. the session token has three parts, RS256, a `kid`, `iss` equal to the project id, `drn` DS, and an `exp` in the future;
//   2. the project's public key set (GET /v2/keys/<project id>) has an RS256 key with that `kid`, and Node can import it and verify the token's signature;
//   3. a copy of the token with a changed payload does NOT verify.
// It reads nothing but the variables below, prints no secret and no token, and changes nothing in the provider project (a sign-in only).
// UNVERIFIED: the two endpoint shapes below follow the provider's public documentation and have not been exercised.
import { createPublicKey, createVerify } from 'node:crypto';

const need = (name) => { const v = process.env[name] ?? ''; if (v === '') { process.stderr.write(`m3-live: ${name} is not set\n`); process.exit(2); } return v; };
const projectId = need('DESCOPE_DEV_PROJECT_ID');
const loginId = need('DESCOPE_DEV_TEST_LOGIN');
const managementKey = need('DESCOPE_DEV_MANAGEMENT_KEY');
// The host follows the region in the project id, as the application's adapter does (an explicit base URL overrides it).
const region = projectId.slice(1, -27);
const base = process.env.DESCOPE_DEV_BASE_URL ?? (region === '' ? 'https://api.descope.com' : `https://api.${region}.descope.com`);

const post = async (path, bearer, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path} answered ${String(res.status)}`);
  return res.json();
};
const failures = [];
const check = (ok, what) => { process.stdout.write(`${ok ? 'ok' : 'FAIL'} ${what}\n`); if (!ok) failures.push(what); };

const generated = await post('/v1/mgmt/tests/generate/otp', `${projectId}:${managementKey}`, { loginId, deliveryMethod: 'email' });
const signedIn = await post('/v1/auth/otp/verify/email', projectId, { loginId, code: generated.code });
const token = signedIn.sessionJwt;
const parts = typeof token === 'string' ? token.split('.') : [];
check(parts.length === 3, 'the session token has three parts');
const [h = '', p = '', s = ''] = parts;
const json = (b64) => JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
const header = json(h); const claims = json(p);
check(header.alg === 'RS256' && typeof header.kid === 'string', 'RS256 with a key id');
check(claims.iss === projectId && claims.drn === 'DS' && claims.exp * 1000 > Date.now(), 'issuer is the project id, a session token, not expired');

const keys = await (await fetch(`${base}/v2/keys/${projectId}`, { signal: AbortSignal.timeout(15_000) })).json();
const jwk = (keys.keys ?? []).find((k) => k.kid === header.kid && k.alg === 'RS256');
check(jwk !== undefined, 'the public key set has an RS256 key with the token\'s key id');
const verifies = (payload) => jwk !== undefined && createVerify('RSA-SHA256').update(`${h}.${payload}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
check(verifies(p), 'the signature verifies against that key');
const tampered = Buffer.from(JSON.stringify({ ...claims, sub: `${String(claims.sub)}x` })).toString('base64url');
check(!verifies(tampered), 'a copy with a changed payload does not verify');
process.exit(failures.length === 0 ? 0 : 1);
