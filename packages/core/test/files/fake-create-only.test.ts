import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeFileStorage, type CreateOnlyHeader } from '../../src/testing/fake-file-storage.js';
import { FileStorageError } from '../../src/ports/file-storage.js';

const body = (text: string) => new TextEncoder().encode(text);
const sign = { size: 3, contentType: 'text/plain', ttlSeconds: 60 };

const cases: {
  header: CreateOnlyHeader;
  value: string;
  other: CreateOnlyHeader;
  otherValue: string;
}[] = [
  {
    header: 'if-none-match',
    value: '*',
    other: 'x-goog-if-generation-match',
    otherValue: '0',
  },
  {
    header: 'x-goog-if-generation-match',
    value: '0',
    other: 'if-none-match',
    otherValue: '*',
  },
];

describe.each(cases)('create-only header $header', ({ header, value, other, otherValue }) => {
  it('is signed with its own value and refuses a second put of the key with already-exists', async () => {
    const store = new FakeFileStorage({ createOnlyHeader: header });
    const first = await store.signUpload('k', { ...sign, ifNoneMatch: true });
    expect(first.headers[header]).toBe(value);
    expect(first.headers).not.toHaveProperty(other);
    await store.receiveSignedUpload(first.url, first.headers, body('one'));
    const second = await store.signUpload('k', {
      ...sign,
      ifNoneMatch: true,
    });
    await expect(store.receiveSignedUpload(second.url, second.headers, body('two'))).rejects.toMatchObject({
      kind: 'already-exists',
    });
    expect(new TextDecoder().decode((await collect(store)).bytes)).toBe('one');
  });

  it('ignores the other header: it neither protects the key nor satisfies the signature', async () => {
    const store = new FakeFileStorage({ createOnlyHeader: header });
    const open = await store.signUpload('k', sign);
    await store.receiveSignedUpload(open.url, { ...open.headers, [other]: otherValue }, body('one'));
    const again = await store.signUpload('k', sign);
    await store.receiveSignedUpload(again.url, { ...again.headers, [other]: otherValue }, body('two'));
    expect(new TextDecoder().decode((await collect(store)).bytes)).toBe('two');

    const guarded = await store.signUpload('guarded', {
      ...sign,
      ifNoneMatch: true,
    });
    const sent = { 'content-type': 'text/plain', [other]: otherValue };
    await expect(store.receiveSignedUpload(guarded.url, sent, body('abc'))).rejects.toBeInstanceOf(FileStorageError);
    await expect(store.head('guarded')).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('matches the header name whatever its case', async () => {
    const store = new FakeFileStorage({ createOnlyHeader: header });
    await store.put('k', body('one'), { size: 3, contentType: 'text/plain' });
    const upload = await store.signUpload('k', {
      ...sign,
      ifNoneMatch: true,
    });
    const shouting = Object.fromEntries(Object.entries(upload.headers).map(([name, v]) => [name.toUpperCase(), v]));
    await expect(store.receiveSignedUpload(upload.url, shouting, body('two'))).rejects.toMatchObject({
      kind: 'already-exists',
    });
  });
});

describe('the default and the provider-name rule', () => {
  it('defaults to if-none-match', async () => {
    const signed = await new FakeFileStorage().signUpload('k', { ...sign, ifNoneMatch: true });
    expect(signed.headers).toEqual({ 'content-type': 'text/plain', 'if-none-match': '*' });
  });

  it('never names a storage provider in the fake', () => {
    const source = readFileSync(new URL('../../src/testing/fake-file-storage.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/s3|aws|bucket|presign|minio|seaweed/i);
  });
});

async function collect(store: FakeFileStorage): Promise<{ bytes: Uint8Array }> {
  const parts: Uint8Array[] = [];
  for await (const part of (await store.get('k')).body) parts.push(part);
  return { bytes: parts[0] ?? new Uint8Array() };
}
