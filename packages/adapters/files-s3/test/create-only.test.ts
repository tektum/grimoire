import { describe, expect, it } from 'vitest';
import { createFileStorage } from '../src/index.js';
import { config, recorder, useRecordingServer } from './recording-server.js';

useRecordingServer();

const store = (createOnlyHeader: 'if-none-match' | 'x-goog-if-generation-match') =>
  createFileStorage(config({ createOnlyHeader }), { maxAttempts: 1 });
const signedHeaders = (url: string): string[] =>
  (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
const headersOf = [
  ['if-none-match', '*', 'x-goog-if-generation-match'],
  ['x-goog-if-generation-match', '0', 'if-none-match'],
] as const;

describe.each(headersOf)('create-only header %s', (header, value, other) => {
  it('is signed, and is returned with the exact value the browser must send', async () => {
    const signed = await store(header).signUpload('attachments/x', {
      size: 300,
      contentType: 'image/png',
      ttlSeconds: 600,
      ifNoneMatch: true,
    });
    expect(signed.method).toBe('PUT');
    expect(signed.headers).toEqual({ 'content-type': 'image/png', [header]: value });
    const names = signedHeaders(signed.url);
    expect(names).toEqual(expect.arrayContaining(['host', 'content-type', 'content-length', header]));
    expect(names).not.toContain(other);
    expect(new URL(signed.url).origin).toBe('http://public.invalid:8333');
    expect(new URL(signed.url).searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('is left out, signature and headers alike, when the upload is not create-only', async () => {
    const signed = await store(header).signUpload('k', { size: 1, contentType: 'image/png', ttlSeconds: 60 });
    expect(signed.headers).toEqual({ 'content-type': 'image/png' });
    expect(signedHeaders(signed.url)).not.toContain(header);
    expect(signedHeaders(signed.url)).not.toContain(other);
  });

  it('answers already-exists to a 412 from the store, and sends no checksum header on a put', async () => {
    const s = store(header);
    recorder.reply = { status: 200, headers: { etag: '"e"' } };
    await s.put('k', new Uint8Array(4), { size: 4, contentType: 'image/png', ifNoneMatch: true });
    const sent = recorder.seen[0]?.headers ?? {};
    expect(sent[header]).toBe(value);
    expect(sent[other]).toBeUndefined();
    expect(Object.keys(sent).filter((name) => /^x-amz-(checksum-|sdk-checksum-algorithm)/.test(name))).toEqual([]);
    recorder.reply = {
      status: 412,
      headers: { 'content-type': 'application/xml' },
      body: '<Error><Code>PreconditionFailed</Code></Error>',
    };
    await expect(
      s.put('k', new Uint8Array(4), { size: 4, contentType: 'image/png', ifNoneMatch: true }),
    ).rejects.toMatchObject({ kind: 'already-exists' });
  });

  it('builds both clients with checksums only where required', async () => {
    const s = store(header);
    for (const client of [s.client, s.signer]) {
      expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
      expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
    }
  });
});

describe('signed upload headers', () => {
  it('sign the disposition when it is asked for, and no other header', async () => {
    const signed = await store('if-none-match').signUpload('k', {
      size: 5,
      contentType: 'application/pdf',
      ttlSeconds: 60,
      disposition: 'attachment',
      ifNoneMatch: true,
    });
    expect(signed.headers).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': 'attachment',
      'if-none-match': '*',
    });
    expect(signedHeaders(signed.url).sort()).toEqual(
      ['content-disposition', 'content-length', 'content-type', 'host', 'if-none-match'].sort(),
    );
  });

  it('end where the clock says: expiresAt is the injected time plus the lifetime', async () => {
    const s = createFileStorage(config(), { now: () => 10_000 });
    expect((await s.signUpload('k', { size: 1, contentType: 'image/png', ttlSeconds: 600 })).expiresAt).toBe(610_000);
  });

  it('refuse a bad key before signing', async () => {
    await expect(
      store('if-none-match').signUpload('a//b', { size: 1, contentType: 'image/png', ttlSeconds: 60 }),
    ).rejects.toMatchObject({ kind: 'invalid-key' });
  });
});
