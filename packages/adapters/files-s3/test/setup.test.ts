import { describe, expect, it } from 'vitest';
import {
  createBucket,
  deleteBucket,
  ensureBucket,
  putBucketCors,
  readBucketCors,
  type EnsureBucketOptions,
} from '../src/index.js';
import { bucket, config, recorder, useRecordingServer } from './recording-server.js';

useRecordingServer();

const options = (over: Partial<EnsureBucketOptions> = {}): EnsureBucketOptions => ({
  endpoint: recorder.origin,
  bucket,
  region: 'us-east-1',
  addressing: 'path',
  accessKey: config().accessKey,
  secretKey: config().secretKey,
  allowedOrigins: ['https://one.example.test', 'https://two.example.test'],
  ...over,
});
const xmlHeaders = { 'content-type': 'application/xml' };

describe('createBucket', () => {
  it('creates the bucket, and counts one the caller already owns as created', async () => {
    await createBucket(options());
    expect(recorder.seen[0]).toMatchObject({ method: 'PUT', path: `/${bucket}/` });
    recorder.reply = { status: 409, headers: xmlHeaders, body: '<Error><Code>BucketAlreadyOwnedByYou</Code></Error>' };
    await expect(createBucket(options())).resolves.toBeUndefined();
  });

  it('sends the region as the location outside us-east-1, and nothing in us-east-1', async () => {
    await createBucket(options({ region: 'eu-west-1' }));
    await createBucket(options());
    expect(recorder.seen[0]?.body.toString()).toContain('<LocationConstraint>eu-west-1</LocationConstraint>');
    expect(recorder.seen[1]?.body.toString()).toBe('');
  });

  it('refuses a bucket that belongs to someone else, and a refused key, as unavailable', async () => {
    recorder.reply = { status: 409, headers: xmlHeaders, body: '<Error><Code>BucketAlreadyExists</Code></Error>' };
    await expect(createBucket(options())).rejects.toMatchObject({ kind: 'unavailable' });
    recorder.reply = { status: 403, headers: xmlHeaders, body: '<Error><Code>AccessDenied</Code></Error>' };
    await expect(createBucket(options())).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('403'),
    });
  });
});

describe('putBucketCors', () => {
  it('writes one rule: GET, PUT and HEAD from the origins, the signed headers, ETag exposed, ten minutes', async () => {
    await putBucketCors(options());
    const request = recorder.seen[0];
    expect(request).toMatchObject({ method: 'PUT', path: `/${bucket}/` });
    expect(request?.query.has('cors')).toBe(true);
    const body = request?.body.toString() ?? '';
    for (const text of [
      'https://one.example.test',
      'https://two.example.test',
      '<AllowedMethod>GET</AllowedMethod>',
      '<AllowedMethod>PUT</AllowedMethod>',
      '<AllowedMethod>HEAD</AllowedMethod>',
      '<ExposeHeader>ETag</ExposeHeader>',
      '<MaxAgeSeconds>600</MaxAgeSeconds>',
      '<AllowedHeader>if-none-match</AllowedHeader>',
      '<AllowedHeader>x-amz-*</AllowedHeader>',
    ]) {
      expect(body).toContain(text);
    }
  });

  it('allows the create-only header of the setting too, once', async () => {
    await putBucketCors(options({ createOnlyHeader: 'x-create-header' }));
    await putBucketCors(options({ createOnlyHeader: 'if-none-match' }));
    const [first, second] = recorder.seen.map((request) => request.body.toString());
    expect(first).toContain('<AllowedHeader>x-create-header</AllowedHeader>');
    expect(second?.match(/<AllowedHeader>if-none-match<\/AllowedHeader>/g)).toHaveLength(1);
  });

  it('is unavailable when the store refuses', async () => {
    recorder.reply = { status: 403, headers: xmlHeaders, body: '<Error><Code>AccessDenied</Code></Error>' };
    await expect(putBucketCors(options())).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('ensureBucket', () => {
  it('creates, then sets the rule, in that order', async () => {
    await ensureBucket(options());
    expect(recorder.seen.map((request) => request.query.has('cors'))).toEqual([false, true]);
  });

  it('stops when the bucket cannot be created', async () => {
    recorder.reply = { status: 403, headers: xmlHeaders, body: '<Error><Code>AccessDenied</Code></Error>' };
    await expect(ensureBucket(options())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(recorder.seen).toHaveLength(1);
  });
});

describe('readBucketCors and deleteBucket', () => {
  it('reads the rules back, or none', async () => {
    recorder.reply = {
      status: 200,
      headers: xmlHeaders,
      body: '<CORSConfiguration><CORSRule><AllowedOrigin>https://one.example.test</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>',
    };
    const rules = await readBucketCors(options());
    expect(recorder.seen[0]?.query.has('cors')).toBe(true);
    expect(rules).toEqual([{ AllowedOrigins: ['https://one.example.test'], AllowedMethods: ['GET'] }]);
    recorder.reply = { status: 200, headers: xmlHeaders, body: '<CORSConfiguration></CORSConfiguration>' };
    expect(await readBucketCors(options())).toEqual([]);
  });

  it('is unavailable for a bucket that is not there, and refused calls are unavailable too', async () => {
    recorder.reply = { status: 404, headers: xmlHeaders, body: '<Error><Code>NoSuchBucket</Code></Error>' };
    await expect(readBucketCors(options())).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(deleteBucket(options())).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('deletes the bucket', async () => {
    recorder.reply = { status: 204 };
    await deleteBucket(options());
    expect(recorder.seen[0]).toMatchObject({ method: 'DELETE', path: `/${bucket}/` });
  });
});
