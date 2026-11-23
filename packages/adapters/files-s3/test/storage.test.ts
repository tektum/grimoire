import { describe, expect, it } from 'vitest';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import { createFileStorage, mapError } from '../src/index.js';
import { bucket, config, recorder, useRecordingServer, type Seen } from './recording-server.js';

useRecordingServer();
const seen: Seen[] = recorder.seen;

const store = (over: Partial<FilesConfig> = {}) => createFileStorage(config(over), { maxAttempts: 1 });
const kindOf = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(FileStorageError);
    return (error as FileStorageError).kind;
  }
  return 'no error';
};
const text = async (body: AsyncIterable<Uint8Array>) => {
  let out = '';
  for await (const part of body) out += new TextDecoder().decode(part);
  return out;
};

describe('the clients', () => {
  it('compute and validate checksums only where required, in both clients', async () => {
    const s = store();
    for (const client of [s.client, s.signer]) {
      expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
      expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
      expect(await client.config.region()).toBe('us-east-1');
    }
  });

  it('use the internal endpoint to talk and the public one to sign, with the addressing style of the setting', async () => {
    const path = store();
    expect(String(await path.client.config.forcePathStyle)).toBe('true');
    expect((await path.client.config.endpoint?.())?.hostname).toBe('127.0.0.1');
    expect((await path.signer.config.endpoint?.())?.hostname).toBe('public.invalid');
    expect(String(await store({ addressing: 'virtual' }).client.config.forcePathStyle)).toBe('false');
  });
});

describe('objects', () => {
  it('heads an object from the response headers', async () => {
    recorder.reply = {
      status: 200,
      headers: {
        'content-length': '12',
        'content-type': 'image/png',
        etag: '"abc"',
        'last-modified': 'Mon, 23 Nov 2026 10:00:00 GMT',
      },
    };
    expect(await store().head('a/b')).toEqual({
      size: 12,
      contentType: 'image/png',
      etag: '"abc"',
      modifiedAt: Date.UTC(2026, 10, 23, 10),
    });
    expect(seen[0]).toMatchObject({ method: 'HEAD', path: `/${bucket}/a/b` });
  });

  it('gets the body, asking for an inclusive range when given one', async () => {
    recorder.reply = { status: 206, headers: { 'content-type': 'image/png', 'content-length': '3' }, body: '234' };
    const got = await store().get('k', { range: { start: 2, end: 4 } });
    expect(seen[0]?.headers.range).toBe('bytes=2-4');
    expect(got.size).toBe(3);
    expect(got.contentType).toBe('image/png');
    expect(await text(got.body)).toBe('234');
  });

  it('refuses a range that cannot be valid without asking the store', async () => {
    const s = store();
    for (const range of [
      { start: -1, end: 3 },
      { start: 5, end: 4 },
      { start: 0.5, end: 3 },
    ]) {
      expect(await kindOf(s.get('k', { range }))).toBe('range-not-satisfiable');
    }
    expect(seen).toHaveLength(0);
  });

  it('never sends an invalid key', async () => {
    const s = store();
    const bad = 'a//b';
    for (const action of [
      s.head(bad),
      s.get(bad),
      s.put(bad, new Uint8Array(1), { size: 1, contentType: 'x/y' }),
      s.delete(bad),
      s.signDownload(bad, { ttlSeconds: 5, disposition: 'inline' }),
    ]) {
      expect(await kindOf(action)).toBe('invalid-key');
    }
    expect(seen).toHaveLength(0);
  });

  it('maps the store answers to the port errors', async () => {
    const s = store();
    recorder.reply = {
      status: 404,
      headers: { 'content-type': 'application/xml' },
      body: '<Error><Code>NoSuchKey</Code></Error>',
    };
    expect(await kindOf(s.get('k'))).toBe('not-found');
    expect(await kindOf(s.head('k'))).toBe('not-found');
    recorder.reply = {
      status: 416,
      headers: { 'content-type': 'application/xml' },
      body: '<Error><Code>InvalidRange</Code></Error>',
    };
    expect(await kindOf(s.get('k', { range: { start: 9, end: 10 } }))).toBe('range-not-satisfiable');
    recorder.reply = { status: 500, body: 'broken' };
    expect(await kindOf(s.get('k'))).toBe('unavailable');
    expect(await kindOf(s.delete('k'))).toBe('unavailable');
  });

  it('does not mistake a missing bucket for a missing key, and does not count it as a delete', async () => {
    const s = store();
    recorder.reply = {
      status: 404,
      headers: { 'content-type': 'application/xml' },
      body: '<Error><Code>NoSuchBucket</Code></Error>',
    };
    expect(await kindOf(s.get('k'))).toBe('unavailable');
    expect(await kindOf(s.delete('k'))).toBe('unavailable');
  });

  it('deletes, and counts an absent key as deleted', async () => {
    const s = store();
    recorder.reply = { status: 204 };
    await s.delete('k');
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: `/${bucket}/k` });
    recorder.reply = {
      status: 404,
      headers: { 'content-type': 'application/xml' },
      body: '<Error><Code>NoSuchKey</Code></Error>',
    };
    await expect(s.delete('k')).resolves.toBeUndefined();
  });

  it('puts bytes and streams with their length and type, and no checksum header', async () => {
    recorder.reply = { status: 200, headers: { etag: '"e1"' } };
    const s = store();
    const stream = (async function* () {
      yield new TextEncoder().encode('0123');
      yield new TextEncoder().encode('456789');
    })();
    for (const body of [new TextEncoder().encode('0123456789'), stream]) {
      seen.length = 0;
      expect(await s.put('k', body, { size: 10, contentType: 'image/png' })).toEqual({ etag: '"e1"' });
      const request = seen[0];
      expect(request).toMatchObject({ method: 'PUT', path: `/${bucket}/k` });
      expect(request?.headers['content-length']).toBe('10');
      expect(request?.headers['content-type']).toBe('image/png');
      expect(request?.headers['if-none-match']).toBeUndefined();
      expect(Object.keys(request?.headers ?? {}).filter((name) => /checksum/.test(name))).toEqual([]);
      expect(request?.body.toString()).toBe('0123456789');
    }
  });

  it('sends the configured create-only header with its value, and maps 412 to already-exists', async () => {
    for (const [header, value] of [
      ['if-none-match', '*'],
      ['x-goog-if-generation-match', '0'],
    ] as const) {
      seen.length = 0;
      recorder.reply = { status: 200, headers: { etag: '"e"' } };
      const s = store({ createOnlyHeader: header });
      await s.put('k', new Uint8Array(2), { size: 2, contentType: 'x/y', ifNoneMatch: true });
      expect(seen[0]?.headers[header]).toBe(value);
      recorder.reply = {
        status: 412,
        headers: { 'content-type': 'application/xml' },
        body: '<Error><Code>PreconditionFailed</Code></Error>',
      };
      expect(await kindOf(s.put('k', new Uint8Array(2), { size: 2, contentType: 'x/y', ifNoneMatch: true }))).toBe(
        'already-exists',
      );
    }
  });

  it('lists a prefix with a page size and a continuation token', async () => {
    recorder.reply = {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok2</NextContinuationToken>
        <Contents><Key>p/a</Key><Size>3</Size><LastModified>2026-11-23T10:00:00.000Z</LastModified></Contents>
        <Contents><Key>p/b</Key><Size>4</Size><LastModified>2026-11-23T10:00:01.000Z</LastModified></Contents></ListBucketResult>`,
    };
    const page = await store().list('p/', { limit: 2, cursor: 'tok1' });
    expect(seen[0]?.query.get('list-type')).toBe('2');
    expect(seen[0]?.query.get('prefix')).toBe('p/');
    expect(seen[0]?.query.get('max-keys')).toBe('2');
    expect(seen[0]?.query.get('continuation-token')).toBe('tok1');
    expect(page).toEqual({
      items: [
        { key: 'p/a', size: 3, modifiedAt: Date.UTC(2026, 10, 23, 10) },
        { key: 'p/b', size: 4, modifiedAt: Date.UTC(2026, 10, 23, 10, 0, 1) },
      ],
      nextCursor: 'tok2',
    });
    recorder.reply = {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
    };
    expect(await store().list('none/')).toEqual({ items: [], nextCursor: null });
    expect(seen[1]?.query.get('max-keys')).toBe('1000');
  });
});

describe('signDownload', () => {
  it('signs for the public endpoint with the response overrides and a private cache rule, without calling the store', async () => {
    const now = 5_000;
    const s = createFileStorage(config(), { now: () => now });
    const { url, expiresAt } = await s.signDownload('attachments/x', {
      ttlSeconds: 300,
      disposition: 'attachment',
      fileName: 'caf\u00e9\r\nx-injected: yes.png',
      contentType: 'text/plain',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://public.invalid:8333');
    expect(parsed.pathname).toBe(`/${bucket}/attachments/x`);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('response-content-type')).toBe('text/plain');
    expect(parsed.searchParams.get('response-cache-control')).toBe('private, no-store');
    const disposition = parsed.searchParams.get('response-content-disposition') ?? '';
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain("filename*=UTF-8''caf%C3%A9");
    expect(expiresAt).toBe(5_000 + 300_000);
    expect(seen).toHaveLength(0);
  });

  it('keeps the stored type and uses a bare disposition when no override is given', async () => {
    const { url } = await store().signDownload('k', { ttlSeconds: 60, disposition: 'inline' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response-content-disposition')).toBe('inline');
    expect(parsed.searchParams.has('response-content-type')).toBe(false);
  });
});

describe('mapError', () => {
  it.each([
    [{ name: 'NoSuchKey' }, 'not-found'],
    [{ name: 'NotFound' }, 'not-found'],
    [{ name: 'Other', $metadata: { httpStatusCode: 404 } }, 'not-found'],
    [{ name: 'InvalidRange' }, 'range-not-satisfiable'],
    [{ name: 'Other', $metadata: { httpStatusCode: 416 } }, 'range-not-satisfiable'],
    [{ name: 'PreconditionFailed' }, 'already-exists'],
    [{ name: 'Other', $metadata: { httpStatusCode: 412 } }, 'already-exists'],
    [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'unavailable'],
    [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'unavailable'],
    [{ name: 'InternalError', $metadata: { httpStatusCode: 500 } }, 'unavailable'],
    [new Error('connect ECONNREFUSED'), 'unavailable'],
    ['a string', 'unavailable'],
    [null, 'unavailable'],
  ])('maps %j to %s', (error, kind) => {
    expect(mapError(error).kind).toBe(kind);
  });

  it('passes a port error through unchanged', () => {
    const own = new FileStorageError('invalid-key', 'x');
    expect(mapError(own)).toBe(own);
  });
});
