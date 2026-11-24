import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The key server of the sign-in end-to-end test signs the session tokens of that suite. A real Descope token carries the tenants of the person (docs/tenancy.md section 2.1), and the
// server refuses a token without one on every route and on the WebSocket, so the tokens of the suite carry one: `legacy`, the tenant of the rows the scenarios insert.
const root = path.resolve(import.meta.dirname, '../../..');

function post(port, ca, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: '/control/token', method: 'POST', ca, headers: { 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { resolve(JSON.parse(body).token); });
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

async function withKeyServer(run) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-m3ks-'));
  execFileSync('sh', [path.join(root, 'tools/m3-keyserver/pki.sh'), dir], { stdio: 'ignore' });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(root, 'tools/m3-keyserver/server.mjs')], {
    env: { ...process.env, GRIMOIRE_M3_KEYSERVER_TEST: '1', M3_KEYSERVER_PROJECT_ID: 'P2m3exittestprojectabcdefghij', M3_KEYSERVER_PORT: String(port), M3_KEYSERVER_TLS_CERT: path.join(dir, 'server.pem'), M3_KEYSERVER_TLS_KEY: path.join(dir, 'server.key') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }); child.on('exit', (code) => { reject(new Error(`key server exited ${String(code)}`)); }); });
    await run(port, readFileSync(path.join(dir, 'ca.pem')));
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

test('a token of the key server names exactly one tenant, `legacy`, and a scenario can name its own', async () => {
  await withKeyServer(async (port, ca) => {
    assert.deepEqual(Object.keys(claimsOf(await post(port, ca, { sub: 'alice' })).tenants ?? {}), ['legacy']);
    assert.deepEqual(Object.keys(claimsOf(await post(port, ca, { sub: 'alice', claims: { tenants: { 'T-other': {} } } })).tenants), ['T-other']);
  });
});
