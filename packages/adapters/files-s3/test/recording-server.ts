import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';

/** A request the recording server saw. */
export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A local HTTP server standing in for the store: it records every request and answers with `recorder.reply`.
 * Call `useRecordingServer()` once in a test file; the state is reset before each test.
 */
export const recorder: { seen: Seen[]; reply: Reply; origin: string } = {
  seen: [],
  reply: { status: 200 },
  origin: '',
};

export function useRecordingServer(): void {
  let server: Server;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://store.invalid');
        recorder.seen.push({
          method: req.method ?? '',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.concat(parts),
        });
        res.writeHead(recorder.reply.status, recorder.reply.headers);
        res.end(req.method === 'HEAD' ? undefined : recorder.reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    recorder.origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    recorder.seen.length = 0;
    recorder.reply = { status: 200 };
  });
}

/** Names and keys are made up at run time. */
export const bucket = `b-${randomUUID()}`;
export const config = (over: Partial<FilesConfig> = {}): FilesConfig => ({
  endpoint: recorder.origin,
  publicEndpoint: 'http://public.invalid:8333',
  publicOrigin: 'http://public.invalid:8333',
  bucket,
  accessKey: randomUUID(),
  secretKey: randomUUID(),
  region: 'us-east-1',
  addressing: 'path',
  createOnlyHeader: 'if-none-match',
  corsMode: 'api',
  maxBytes: 1000,
  allowedTypes: ['image/png'],
  pendingMaxPerUser: 5,
  ...over,
});
