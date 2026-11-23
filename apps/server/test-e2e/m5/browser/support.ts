import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStorage, ensureBucket, type S3FileStorage } from '@tektum/grimoire-adapter-files-s3';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';

// The keys come from the ignored `.env` that `make` writes from `.env.example`, or from the environment; no key is
// written in this directory, and every object key and origin is made up at run time.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fromFile: Record<string, string> = {};
if (existsSync(path.join(repoRoot, '.env'))) {
  for (const line of readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
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
/** The host the browser uses for the store: the internal address under another name, so the origin is not the page's. */
export const publicEndpoint = endpoint.replace('127.0.0.1', 'localhost');
const bucket = setting('GRIMOIRE_S3_BUCKET', 'grimoire');
const admin = { accessKey: setting('GRIMOIRE_DEV_S3_ACCESS_KEY'), secretKey: setting('GRIMOIRE_DEV_S3_SECRET_KEY') };
/** The origins `files-setup` writes: split and trimmed the way the settings loader does. */
export const defaultOrigins = setting('GRIMOIRE_ALLOWED_ORIGINS', 'http://127.0.0.1:8080,http://localhost:8080')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

export const filesConfig = (): FilesConfig => ({
  endpoint,
  publicEndpoint,
  publicOrigin: new URL(publicEndpoint).origin,
  bucket,
  accessKey: setting('GRIMOIRE_S3_ACCESS_KEY'),
  secretKey: setting('GRIMOIRE_S3_SECRET_KEY'),
  region: 'us-east-1',
  addressing: 'path',
  createOnlyHeader: 'if-none-match',
  corsMode: 'api',
  maxBytes: 26_214_400,
  allowedTypes: ['image/png', 'image/gif'],
  pendingMaxPerUser: 20,
});

/** The store as the server uses it: the runtime identity. */
export const runtimeStore = (): S3FileStorage => createFileStorage(filesConfig());

/** Sets the bucket's CORS rule to these origins with the admin key (only this test holds it). */
export const setCors = (origins: readonly string[]): Promise<void> =>
  ensureBucket({ endpoint, bucket, region: 'us-east-1', addressing: 'path', ...admin, allowedOrigins: origins });

export const freshKey = (): string => `e2e/${randomUUID()}`;

export interface PageServer {
  readonly origin: string;
  /** The paths asked of this server. */
  readonly hits: string[];
  close(): Promise<void>;
}

/** A tiny static server: one empty page at `/`, optionally with a Content-Security-Policy. Every other path is a 404. */
export async function startServer(options: { csp?: string } = {}): Promise<PageServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''}`);
    req.resume();
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...(options.csp === undefined ? {} : { 'content-security-policy': options.csp }),
      });
      res.end('<!doctype html><title>page</title><body></body>');
      return;
    }
    res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
