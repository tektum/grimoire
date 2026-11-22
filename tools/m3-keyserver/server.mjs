// Key server of the sign-in end-to-end test (TEST TOOL, never shipped): serves the JWKS of a key pair generated at start (kept in memory, never written to disk) at
// GET /v2/keys/<projectId> over https (the app refuses a plain-http base URL outside local mode), and signs test session tokens for the harness at
// POST /control/token. Node built-ins only (no dependency). The Dockerfile copies only the application packages, so `tools/` is never in the image;
// the compose overlay mounts this folder read-only into a throwaway container.
//
// Refuses to start unless GRIMOIRE_M3_KEYSERVER_TEST=1 is set, and refuses any bind address other than loopback unless
// GRIMOIRE_M3_KEYSERVER_ALLOW_BIND_ALL=1 is also set (the compose overlay sets it: the container must listen on its network, and its port is published on 127.0.0.1 only).
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const env = process.env;
const fail = (message) => { process.stderr.write(`m3-keyserver: refusing to start: ${message}\n`); process.exit(2); };
if (env.GRIMOIRE_M3_KEYSERVER_TEST !== '1') fail('this is a test tool; set GRIMOIRE_M3_KEYSERVER_TEST=1 to confirm');
const host = env.M3_KEYSERVER_HOST ?? '127.0.0.1';
const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
if (!loopback && env.GRIMOIRE_M3_KEYSERVER_ALLOW_BIND_ALL !== '1') fail(`bind address ${host} is not loopback; set GRIMOIRE_M3_KEYSERVER_ALLOW_BIND_ALL=1 only in the test compose overlay`);
const projectId = env.M3_KEYSERVER_PROJECT_ID ?? '';
if (!/^P[A-Za-z0-9]{20,40}$/.test(projectId)) fail('M3_KEYSERVER_PROJECT_ID must be a Descope-shaped project id');
const port = Number(env.M3_KEYSERVER_PORT ?? '8443');
const certFile = env.M3_KEYSERVER_TLS_CERT ?? ''; const keyFile = env.M3_KEYSERVER_TLS_KEY ?? '';
if (certFile === '' || keyFile === '') fail('M3_KEYSERVER_TLS_CERT and M3_KEYSERVER_TLS_KEY (test certificate) are required');

// A fresh key id at every start: the app caches keys by id, so after a key-server-only restart the new key must not hide behind the old id (the app would hold the old key for up to ten minutes).
const KID = `m3-test-key-${randomBytes(6).toString('hex')}`;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); // signs the "another key" variant; its public half is never published
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function sign(claims, key, kid) {
  const data = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(key).toString('base64url')}`;
}

const VARIANTS = ['good', 'expired', 'wrong-issuer', 'refresh', 'other-key'];
/** Builds a token: `sub`, `variant`, optional `ttlSeconds` and extra `claims` (email, name, ...). */
function token({ sub, variant = 'good', ttlSeconds = 600, claims = {} }) {
  if (typeof sub !== 'string' || sub === '') throw new Error('sub is required');
  if (!VARIANTS.includes(variant)) throw new Error(`variant must be one of ${VARIANTS.join(', ')}`);
  const now = Math.floor(Date.now() / 1000);
  const base = { sub, iss: projectId, drn: 'DS', iat: now, exp: now + ttlSeconds, ...claims };
  if (variant === 'expired') { base.iat = now - 7200; base.exp = now - 3600; }
  if (variant === 'wrong-issuer') base.iss = 'P2someoneelseprojectabcdefghi';
  if (variant === 'refresh') base.drn = 'DSR';
  return variant === 'other-key' ? sign(base, other.privateKey, KID) : sign(base, pair.privateKey, KID);
}

const body = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 65536) reject(new Error('too large')); }); req.on('end', () => { resolve(s); }); req.on('error', reject);
});
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };

const server = createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === `/v2/keys/${projectId}`) { json(res, 200, { keys: [jwk] }); return; }
  if (req.method === 'GET' && url === '/healthz') { json(res, 200, { ok: true, projectId }); return; }
  if (req.method === 'POST' && url === '/control/token') {
    body(req).then((raw) => { json(res, 200, { token: token(JSON.parse(raw)) }); }).catch((e) => { json(res, 400, { error: e instanceof Error ? e.message : 'bad request' }); });
    return;
  }
  json(res, 404, { error: 'not found' });
});
server.listen(port, host, () => { process.stdout.write(`m3-keyserver: listening on ${host}:${String(port)} (test tool)\n`); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); server.closeAllConnections(); process.exit(0); });
