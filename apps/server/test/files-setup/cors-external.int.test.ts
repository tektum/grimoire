import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireBuild, runToEnd, serverDir } from '../server/support/harness.js';

// `grimoire files-setup` with the store's CORS owned by an operator (`external`): a stub store that answers preflights,
// records what it was asked and fails the test's expectations if the command ever writes a CORS rule.
const ONE = 'https://one.example.test';
const TWO = 'https://two.example.test';
const cli = path.join(serverDir, 'dist/cli.js');
const bucket = `t-${randomUUID()}`;
const adminAccess = randomUUID();
const adminSecret = randomUUID();

interface Asked {
  method: string;
  query: string;
  headers: IncomingHttpHeaders;
}
const asked: Asked[] = [];
let allow: (origin: string, method: string) => { origin: boolean; methods: string; headers: string } = () => ({
  origin: true,
  methods: '',
  headers: '',
});
let server: Server;
let endpoint = '';

beforeAll(async () => {
  requireBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub.invalid');
      asked.push({ method: req.method ?? '', query: url.search, headers: req.headers });
      if (req.method === 'OPTIONS') {
        const origin = String(req.headers.origin);
        const rule = allow(origin, String(req.headers['access-control-request-method']));
        if (!rule.origin) return void res.writeHead(403).end();
        return void res
          .writeHead(200, {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': rule.methods,
            'access-control-allow-headers': rule.headers,
          })
          .end();
      }
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  asked.length = 0;
  allow = () => ({
    origin: true,
    methods: 'GET, PUT, HEAD',
    headers: 'content-type, content-disposition, if-none-match',
  });
});

const run = (env: Record<string, string> = {}) =>
  runToEnd([cli, 'files-setup'], {
    GRIMOIRE_S3_ENDPOINT: endpoint,
    GRIMOIRE_S3_BUCKET: bucket,
    GRIMOIRE_S3_ADMIN_ACCESS_KEY: adminAccess,
    GRIMOIRE_S3_ADMIN_SECRET_KEY: adminSecret,
    GRIMOIRE_S3_CORS_MODE: 'external',
    GRIMOIRE_ALLOWED_ORIGINS: `${ONE},${TWO}`,
    ...env,
  });
const writesCors = () => asked.some((a) => a.method === 'PUT' && a.query.includes('cors'));
const preflights = () => asked.filter((a) => a.method === 'OPTIONS');

describe('files-setup with GRIMOIRE_S3_CORS_MODE=external', () => {
  it('writes no rule, sends a preflight for each origin on the upload and download paths, and exits 0 when allowed', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(writesCors()).toBe(false);
    expect(preflights().map((p) => [p.headers.origin, p.headers['access-control-request-method']])).toEqual([
      [ONE, 'PUT'],
      [ONE, 'GET'],
      [ONE, 'HEAD'],
      [TWO, 'PUT'],
      [TWO, 'GET'],
      [TWO, 'HEAD'],
    ]);
    expect(result.output).toContain(bucket);
    expect(result.output).not.toContain(adminSecret);
    expect(result.output).not.toContain(adminAccess);
  }, 60_000);

  it('exits 1 naming the first origin the store does not allow', async () => {
    allow = (origin) => ({
      origin: origin === ONE,
      methods: 'GET, PUT, HEAD',
      headers: 'content-type, content-disposition, if-none-match',
    });
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain(TWO);
    expect(result.output).toContain(`origin ${TWO} is not allowed`);
    expect(result.output).not.toContain(`origin ${ONE} is not allowed`);
    expect(writesCors()).toBe(false);
  }, 60_000);

  it('exits 1 naming a method or a header the store does not allow, the create-only header of the setting included', async () => {
    allow = () => ({ origin: true, methods: 'GET, PUT', headers: 'content-type, content-disposition, if-none-match' });
    const method = await run();
    expect(method.code).toBe(1);
    expect(method.output).toContain('HEAD');
    allow = () => ({ origin: true, methods: 'GET, PUT, HEAD', headers: 'content-type, content-disposition' });
    const header = await run();
    expect(header.code).toBe(1);
    expect(header.output).toContain('if-none-match');
    allow = () => ({
      origin: true,
      methods: 'GET, PUT, HEAD',
      headers: 'content-type, content-disposition, if-none-match',
    });
    const other = await run({ GRIMOIRE_S3_CREATE_ONLY_HEADER: 'x-goog-if-generation-match' });
    expect(other.code).toBe(1);
    expect(other.output).toContain('x-goog-if-generation-match');
  }, 120_000);

  it('with api, the default, writes the rule and sends no preflight', async () => {
    const result = await run({ GRIMOIRE_S3_CORS_MODE: 'api' });
    expect(result.code).toBe(0);
    expect(writesCors()).toBe(true);
    expect(preflights()).toEqual([]);
  }, 60_000);
});
