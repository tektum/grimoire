import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deleteBucket, readBucketCors, type EnsureBucketOptions } from '@tektum/grimoire-adapter-files-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, requireBuild, runToEnd, serverDir } from '../server/support/harness.js';

// Runs `grimoire files-setup` against the Compose file store (`make db-up`) on the host, with buckets named at run time.
// The keys come from the ignored `.env` that `make` writes, or from the environment; none is written in this file.
const envFile = path.join(repoRoot, '.env');
const fromFile: Record<string, string> = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fromFile[match[1]] = match[2];
  }
}
const setting = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fromFile[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set: run \`make db-up\` to write .env`);
  return value;
};

const endpoint = setting('GRIMOIRE_S3_ENDPOINT', 'http://127.0.0.1:8333');
const admin = { accessKey: setting('GRIMOIRE_DEV_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_DEV_S3_SECRET_KEY') };
const runtime = { accessKey: setting('GRIMOIRE_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_S3_SECRET_KEY') };
const origins = ['http://127.0.0.1:8080', 'http://localhost:8080'];
const cli = path.join(serverDir, 'dist/cli.js');

const ours = `t-${randomUUID()}`;
const asAdmin = (bucket: string): EnsureBucketOptions => ({
  endpoint,
  bucket,
  region: 'us-east-1',
  addressing: 'path',
  ...admin,
  allowedOrigins: origins,
});
const run = (env: Record<string, string>) =>
  runToEnd([cli, 'files-setup'], {
    GRIMOIRE_S3_ENDPOINT: endpoint,
    GRIMOIRE_S3_BUCKET: ours,
    GRIMOIRE_S3_ADMIN_ACCESS_KEY: admin.accessKey,
    GRIMOIRE_S3_ADMIN_SECRET_KEY: admin.secretKey,
    GRIMOIRE_ALLOWED_ORIGINS: origins.join(','),
    ...env,
  });
const secrets = [admin.accessKey, admin.secretKey, runtime.accessKey, runtime.secretKey];
const leaks = (output: string): string[] => secrets.filter((secret) => output.includes(secret));

beforeAll(() => requireBuild());
afterAll(() => deleteBucket(asAdmin(ours)).catch(() => undefined), 60_000);

describe('grimoire files-setup against the store', () => {
  it('on a fresh store creates the bucket and its CORS rule, and prints the bucket and origins and no key', async () => {
    const first = await run({});
    expect(first.code).toBe(0);
    expect(first.output).toContain(ours);
    for (const origin of origins) expect(first.output).toContain(origin);
    expect(leaks(first.output)).toEqual([]);
    const rules = await readBucketCors(asAdmin(ours));
    expect(rules).toHaveLength(1);
    expect([...(rules[0]?.AllowedOrigins ?? [])].sort()).toEqual([...origins].sort());
    expect([...(rules[0]?.AllowedMethods ?? [])].sort()).toEqual(['GET', 'HEAD', 'PUT']);
  }, 60_000);

  it('run a second time succeeds and leaves the same rule', async () => {
    const again = await run({});
    expect(again.code).toBe(0);
    expect(leaks(again.output)).toEqual([]);
    expect(await readBucketCors(asAdmin(ours))).toHaveLength(1);
  }, 60_000);

  it('without the admin keys is a configuration error (exit 2) that names them and prints no key', async () => {
    const result = await run({ GRIMOIRE_S3_ADMIN_ACCESS_KEY: '', GRIMOIRE_S3_ADMIN_SECRET_KEY: '' });
    expect(result.code).toBe(2);
    expect(result.output).toContain('GRIMOIRE_S3_ADMIN_ACCESS_KEY');
    expect(leaks(result.output)).toEqual([]);
  });

  it('with the runtime key in place of the admin key is a store error (exit 1) that prints no key', async () => {
    const result = await run({
      GRIMOIRE_S3_BUCKET: `t-${randomUUID()}`,
      GRIMOIRE_S3_ADMIN_ACCESS_KEY: runtime.accessKey,
      GRIMOIRE_S3_ADMIN_SECRET_KEY: runtime.secretKey,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('files_setup.failed');
    expect(leaks(result.output)).toEqual([]);
  }, 60_000);
});
