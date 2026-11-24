import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Runs against the Compose file store that `make db-up` starts; the keys are read from .env (created by make), never written here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const env = Object.fromEntries(
  readFileSync(path.join(root, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const admin = { id: env.GRIMOIRE_DEV_S3_ACCESS_KEY ?? '', secret: env.GRIMOIRE_DEV_S3_SECRET_KEY ?? '' };
const app = { id: env.GRIMOIRE_DEV_S3_APP_ACCESS_KEY ?? '', secret: env.GRIMOIRE_DEV_S3_APP_SECRET_KEY ?? '' };
const HOST = '127.0.0.1:8333';
const BUCKET = env.GRIMOIRE_S3_BUCKET || 'grimoire';
const CORS = '<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>';

const sha = (d: string | Buffer): string => createHash('sha256').update(d).digest('hex');
const hmac = (k: string | Buffer, d: string): Buffer => createHmac('sha256', k).update(d).digest();

/** AWS Signature Version 4, path-style. The query is given in canonical order; a parameter without a value (`cors`) is signed and sent as `cors=`. */
async function call(key: { id: string; secret: string } | null, method: string, p: string, rawQuery = '', body = ''): Promise<{ status: number; text: string }> {
  const query = rawQuery.split('&').filter(Boolean).map((q) => (q.includes('=') ? q : `${q}=`)).join('&');
  const headers: Record<string, string> = {};
  if (key) {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = now.slice(0, 8);
    const payload = sha(body);
    const signed = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, p, query, `host:${HOST}\nx-amz-content-sha256:${payload}\nx-amz-date:${now}\n`, signed, payload].join('\n');
    const scope = `${day}/us-east-1/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', now, scope, sha(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secret}`, day), 'us-east-1'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    headers['x-amz-date'] = now;
    headers['x-amz-content-sha256'] = payload;
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${key.id}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  }
  const res = await fetch(`http://${HOST}${p}${query ? `?${query}` : ''}`, { method, headers, ...(body ? { body } : {}) });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  expect(app.id && app.secret && admin.id && admin.secret, '.env lacks the file store keys: run `make db-up`').toBeTruthy();
  expect(app.id).not.toBe(admin.id);
  const made = await call(admin, 'PUT', `/${BUCKET}`);
  expect([200, 409]).toContain(made.status);
}, 30_000);

describe('Compose file store identities', () => {
  it('the admin pair passes the healthcheck request (signed ListBuckets)', async () => {
    const r = await call(admin, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('ListAllMyBucketsResult');
  });

  it('the runtime pair can put, get, list and delete objects in the grimoire bucket', async () => {
    const name = `identity-check/${randomBytes(6).toString('hex')}`;
    const content = `hello ${randomBytes(4).toString('hex')}`;
    expect((await call(app, 'PUT', `/${BUCKET}/${name}`, '', content)).status).toBe(200);
    const got = await call(app, 'GET', `/${BUCKET}/${name}`);
    expect(got).toEqual({ status: 200, text: content });
    const list = await call(app, 'GET', `/${BUCKET}`, 'list-type=2&prefix=identity-check%2F');
    expect(list.status).toBe(200);
    expect(list.text).toContain(name);
    expect((await call(app, 'DELETE', `/${BUCKET}/${name}`)).status).toBe(204);
  });

  it('the runtime pair is refused for another bucket, for creating or deleting a bucket, and for CORS', async () => {
    const other = `other-${randomBytes(4).toString('hex')}`;
    expect((await call(app, 'PUT', `/${other}/x`, '', 'x')).status).toBe(403);
    expect((await call(app, 'GET', `/${other}`, 'list-type=2')).status).toBe(403);
    expect((await call(app, 'PUT', `/${other}`)).status).toBe(403);
    expect((await call(app, 'DELETE', `/${BUCKET}`)).status).toBe(403);
    expect((await call(app, 'PUT', `/${BUCKET}`, 'cors', CORS)).status).toBe(403);
    // The refused bucket creation really did nothing.
    expect((await call(admin, 'HEAD', `/${other}`)).status).toBe(404);
  });

  it('ListBuckets answered to the runtime pair names only the bucket it may use, never another bucket', async () => {
    const scratch = `scratch-${randomBytes(4).toString('hex')}`;
    expect((await call(admin, 'PUT', `/${scratch}`)).status).toBe(200);
    try {
      const r = await call(app, 'GET', '/');
      expect(r.status).toBe(200);
      const names = [...r.text.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1]);
      expect(names).toContain(BUCKET);
      expect(names.filter((n) => n !== BUCKET)).toEqual([]);
    } finally {
      await call(admin, 'DELETE', `/${scratch}`);
    }
  });

  it('the CORS request used above is well formed: the admin pair is accepted for it on a scratch bucket (control)', async () => {
    const scratch = `scratch-${randomBytes(4).toString('hex')}`;
    expect((await call(admin, 'PUT', `/${scratch}`)).status).toBe(200);
    try {
      expect((await call(admin, 'PUT', `/${scratch}`, 'cors', CORS)).status).toBe(200);
    } finally {
      await call(admin, 'DELETE', `/${scratch}`);
    }
  });

  it('a request without a signature and one with a wrong secret are refused', async () => {
    expect((await call(null, 'GET', `/${BUCKET}`, 'list-type=2')).status).toBe(403);
    expect((await call(null, 'GET', `/${BUCKET}/x`)).status).toBe(403);
    expect((await call({ id: app.id, secret: `${app.secret}x` }, 'GET', `/${BUCKET}`, 'list-type=2')).status).toBe(403);
  });
});
