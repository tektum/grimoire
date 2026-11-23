import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeleteBucketCommand, GetBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import { createBucket, createFileStorage, ensureBucket, putBucketCors } from '../src/index.js';
import { adminOptions, allowedOrigins, endpoint, filesConfig, publicEndpoint } from './store-support.js';

// The runtime key may read, write and list its own bucket and nothing else; only the admin key sets the store up.
// Buckets are named at run time and removed afterwards.
const ours = `t-${randomUUID()}`;
const other = `t-${randomUUID()}`;
const admin = adminOptions(ours);
const adminClient = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: admin.accessKey, secretAccessKey: admin.secretKey },
});
const runtimeAs = (bucket: string) => ({
  ...admin,
  bucket,
  accessKey: filesConfig().accessKey,
  secretKey: filesConfig().secretKey,
});

async function refusal(action: Promise<unknown>): Promise<FileStorageError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(FileStorageError);
    return error as FileStorageError;
  }
  throw new Error('the store accepted what the runtime key must not do');
}

beforeAll(async () => {
  await adminClient.send(new CreateBucketCommand({ Bucket: other }));
}, 60_000);
afterAll(async () => {
  for (const Bucket of [ours, other])
    await adminClient.send(new DeleteBucketCommand({ Bucket })).catch(() => undefined);
  adminClient.destroy();
}, 60_000);

describe('the runtime key', () => {
  it('cannot create a bucket or set CORS', async () => {
    expect((await refusal(createBucket(runtimeAs(ours)))).message).toContain('403');
    await ensureBucket(admin);
    expect((await refusal(putBucketCors(runtimeAs(ours)))).message).toContain('403');
  });

  it('is refused on a bucket that is not its own, for every call', async () => {
    const elsewhere = createFileStorage(filesConfig({ bucket: other }), { maxAttempts: 1 });
    for (const action of [
      () => elsewhere.head('x'),
      () => elsewhere.get('x'),
      () => elsewhere.put('x', new Uint8Array(1), { size: 1, contentType: 'image/png' }),
      () => elsewhere.list(''),
    ]) {
      // Each call starts only when it is awaited, so no rejection waits unhandled.
      expect((await refusal(action())).kind).toBe('unavailable');
    }
  });

  it('is not what an unsigned request is: reading and listing without a signature are 403', async () => {
    const object = await fetch(`${publicEndpoint}/${ours}/x`);
    const list = await fetch(`${publicEndpoint}/${ours}?list-type=2`);
    expect([object.status, list.status]).toEqual([403, 403]);
  });
});

describe('ensureBucket with the admin key', () => {
  it('succeeds twice and leaves the CORS rule listing the allowed origins', async () => {
    await ensureBucket(admin);
    await ensureBucket(admin);
    const { CORSRules } = await adminClient.send(new GetBucketCorsCommand({ Bucket: ours }));
    expect(CORSRules).toHaveLength(1);
    expect([...(CORSRules?.[0]?.AllowedOrigins ?? [])].sort()).toEqual([...allowedOrigins].sort());
    expect([...(CORSRules?.[0]?.AllowedMethods ?? [])].sort()).toEqual(['GET', 'HEAD', 'PUT']);
    expect(CORSRules?.[0]?.ExposeHeaders).toEqual(['ETag']);
    expect(CORSRules?.[0]?.MaxAgeSeconds).toBe(600);
  });
});
