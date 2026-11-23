import { existsSync, readFileSync } from 'node:fs';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import type { EnsureBucketOptions } from '../src/index.js';

// Runs against the Compose file store (`make db-up`). The keys are read from the ignored `.env` that `make` writes
// from `.env.example`, or from the environment; nothing secret-looking is written in a test.
const envFile = new URL('../../../../.env', import.meta.url);

function readEnvFile(): Record<string, string> {
  if (!existsSync(envFile)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

const fromFile = readEnvFile();
function setting(name: string, fallback?: string): string {
  const value = process.env[name] ?? fromFile[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set: run \`make db-up\` to write .env`);
  return value;
}

export const endpoint = setting('GRIMOIRE_S3_ENDPOINT', 'http://127.0.0.1:8333');
/** The host the browser would use: it differs from the internal one, as in production. */
export const publicEndpoint = endpoint.replace('127.0.0.1', 'localhost');
export const allowedOrigins = setting('GRIMOIRE_ALLOWED_ORIGINS', 'http://127.0.0.1:8080,http://localhost:8080').split(
  ',',
);

const runtime = { accessKey: setting('GRIMOIRE_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_S3_SECRET_KEY') };
const admin = { accessKey: setting('GRIMOIRE_DEV_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_DEV_S3_SECRET_KEY') };
export const runtimeBucket = setting('GRIMOIRE_S3_BUCKET', 'grimoire');

export const filesConfig = (over: Partial<FilesConfig> = {}): FilesConfig => ({
  endpoint,
  publicEndpoint,
  publicOrigin: new URL(publicEndpoint).origin,
  bucket: runtimeBucket,
  ...runtime,
  region: 'us-east-1',
  addressing: 'path',
  createOnlyHeader: 'if-none-match',
  corsMode: 'api',
  maxBytes: 26_214_400,
  allowedTypes: ['image/png'],
  pendingMaxPerUser: 20,
  ...over,
});

/** The admin identity: only the set-up step and these tests hold it. */
export const adminOptions = (bucket: string): EnsureBucketOptions => ({
  endpoint,
  bucket,
  region: 'us-east-1',
  addressing: 'path',
  ...admin,
  allowedOrigins,
});
