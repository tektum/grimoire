import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fileStorageConformance,
  type FileStorageCapabilities,
  type FileStorageHarness,
  type SignedRequest,
  type SignedResponse,
} from '@tektum/grimoire-core/testing/file-storage-conformance';
import { createFileStorage, ensureBucket } from '../src/index.js';
import { adminOptions, allowedOrigins, filesConfig, publicEndpoint, runtimeBucket } from './store-support.js';

// The same cases the fake passes, on the Compose store, with signed URLs for the public endpoint while the client
// talks to the internal one. The create-only header is the default one: the other is proved with a recording server.
const capabilities: FileStorageCapabilities = {
  cors: true,
  anonymousDenied: true,
  realExpiry: true,
  flatMemory: true,
  signedHeadersEnforced: true,
  createOnlyHeader: 'if-none-match',
};

const store = createFileStorage(filesConfig());

async function send(request: SignedRequest): Promise<SignedResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers ?? {},
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: 'manual',
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
}

const harness: FileStorageHarness = {
  store,
  capabilities,
  publicOrigin: new URL(publicEndpoint).origin,
  corsOrigin: allowedOrigins[0] as string,
  send,
  // Signed URLs expire on the store's clock: let the real clock run.
  advance: async (seconds) => {
    const end = Date.now() + seconds * 1000;
    await vi.waitFor(
      () => {
        if (Date.now() < end) throw new Error('time has not passed');
      },
      { timeout: seconds * 1000 + 5000, interval: 250 },
    );
  },
  unsignedUrl: (key) => `${publicEndpoint}/${runtimeBucket}/${key}`,
};

beforeAll(() => ensureBucket(adminOptions(runtimeBucket)), 60_000);

afterAll(async () => {
  // Every case works under `conformance/`: take it all away again.
  let cursor: string | undefined;
  do {
    const page = await store.list('conformance/', { ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) await store.delete(item.key);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}, 120_000);

describe('the S3-protocol file store conformance (same cases as the fake)', () => {
  for (const c of fileStorageConformance) {
    const missing = c.requires !== undefined && !capabilities[c.requires];
    const title = missing ? `${c.name} (skipped: capability ${c.requires} is false)` : c.name;
    it.skipIf(missing)(title, () => c.run(harness), c.name.startsWith('stream') ? 300_000 : 60_000);
  }

  it('runs every case there is', () => {
    expect(fileStorageConformance.length).toBeGreaterThanOrEqual(20);
  });
});
