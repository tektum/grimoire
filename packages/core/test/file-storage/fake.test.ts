import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeFileStorage } from '../../src/testing/fake-file-storage.js';
import { FileStorageError, type ByteStream } from '../../src/ports/file-storage.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = async (body: ByteStream) => {
  let out = '';
  for await (const part of body) out += new TextDecoder().decode(part);
  return out;
};
const kindOf = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(FileStorageError);
    return (error as FileStorageError).kind;
  }
  return 'no error';
};
const png = { size: 10, contentType: 'image/png' };

describe('FakeFileStorage objects', () => {
  it('puts, heads and gets back the same bytes', async () => {
    const clock = new FakeClock(5000);
    const store = new FakeFileStorage({ clock });
    const { etag } = await store.put('a/b', bytes('0123456789'), png);
    expect(await store.head('a/b')).toEqual({
      size: 10,
      contentType: 'image/png',
      etag,
      modifiedAt: 5000,
    });
    const got = await store.get('a/b');
    expect(got.size).toBe(10);
    expect(got.contentType).toBe('image/png');
    expect(await text(got.body)).toBe('0123456789');
  });

  it('accepts a stream body and gives each put its own etag', async () => {
    const store = new FakeFileStorage();
    const stream = (async function* () {
      yield bytes('01234');
      yield bytes('56789');
    })();
    const first = await store.put('k', stream, png);
    const second = await store.put('k', bytes('9876543210'), png);
    expect(second.etag).not.toBe(first.etag);
    expect(await text((await store.get('k')).body)).toBe('9876543210');
  });

  it('refuses a body that is not the declared size', async () => {
    const store = new FakeFileStorage();
    expect(await kindOf(store.put('k', bytes('123'), png))).toBe('unavailable');
    expect(await kindOf(store.head('k'))).toBe('not-found');
  });

  it('does not let a caller change stored bytes through the array it passed', async () => {
    const store = new FakeFileStorage();
    const input = bytes('0123456789');
    await store.put('k', input, png);
    input.fill(0);
    expect(await text((await store.get('k')).body)).toBe('0123456789');
  });

  it('reads an inclusive range, clamps its end and refuses a start past the end', async () => {
    const store = new FakeFileStorage();
    await store.put('k', bytes('0123456789'), png);
    const middle = await store.get('k', { range: { start: 2, end: 4 } });
    expect(await text(middle.body)).toBe('234');
    expect(middle.size).toBe(3);
    expect(await text((await store.get('k', { range: { start: 8, end: 99 } })).body)).toBe('89');
    expect(await text((await store.get('k', { range: { start: 0, end: 0 } })).body)).toBe('0');
    for (const range of [
      { start: 10, end: 12 },
      { start: 5, end: 4 },
      { start: -1, end: 3 },
      { start: 0.5, end: 3 },
    ]) {
      expect(await kindOf(store.get('k', { range }))).toBe('range-not-satisfiable');
    }
  });

  it('answers not-found for an absent key and succeeds deleting one', async () => {
    const store = new FakeFileStorage();
    expect(await kindOf(store.head('nope'))).toBe('not-found');
    expect(await kindOf(store.get('nope'))).toBe('not-found');
    await expect(store.delete('nope')).resolves.toBeUndefined();
    await store.put('k', bytes('0123456789'), png);
    await store.delete('k');
    expect(await kindOf(store.head('k'))).toBe('not-found');
  });

  it('refuses a second conditional put and leaves the first object alone', async () => {
    const store = new FakeFileStorage();
    await store.put('k', bytes('0123456789'), { ...png, ifNoneMatch: true });
    expect(await kindOf(store.put('k', bytes('abcdefghij'), { ...png, ifNoneMatch: true }))).toBe('already-exists');
    expect(await text((await store.get('k')).body)).toBe('0123456789');
    await store.put('k', bytes('abcdefghij'), png);
    expect(await text((await store.get('k')).body)).toBe('abcdefghij');
  });

  it('lets only one of two concurrent conditional puts win', async () => {
    const store = new FakeFileStorage();
    const results = await Promise.allSettled([
      store.put('k', bytes('0123456789'), { ...png, ifNoneMatch: true }),
      store.put('k', bytes('abcdefghij'), { ...png, ifNoneMatch: true }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await text((await store.get('k')).body)).toBe('0123456789');
  });

  it('refuses a bad key on every method before doing anything', async () => {
    const store = new FakeFileStorage();
    const bad = 'a//b';
    const sign = { size: 1, contentType: 'image/png', ttlSeconds: 60 };
    for (const action of [
      store.head(bad),
      store.get(bad),
      store.put(bad, bytes('1'), { size: 1, contentType: 'image/png' }),
      store.delete(bad),
      store.signUpload(bad, sign),
      store.signDownload(bad, { ttlSeconds: 60, disposition: 'inline' }),
    ]) {
      expect(await kindOf(action)).toBe('invalid-key');
    }
  });
});

describe('FakeFileStorage list', () => {
  const filled = async () => {
    const store = new FakeFileStorage();
    for (const key of ['b/2', 'a/3', 'a/1', 'a/2', 'c'])
      await store.put(key, bytes('x'), { size: 1, contentType: 'text/plain' });
    return store;
  };

  it('lists a prefix ascending by key with size and modification time', async () => {
    const store = await filled();
    const { items, nextCursor } = await store.list('a/');
    expect(items.map((item) => item.key)).toEqual(['a/1', 'a/2', 'a/3']);
    expect(items[0]).toMatchObject({ size: 1 });
    expect(nextCursor).toBeNull();
    expect((await store.list('')).items).toHaveLength(5);
    expect((await store.list('zz')).items).toEqual([]);
  });

  it('pages with a cursor until the end', async () => {
    const store = await filled();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.list('', {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.key));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(seen).toEqual(['a/1', 'a/2', 'a/3', 'b/2', 'c']);
    expect(pages).toBe(3);
  });

  it('clamps the limit between 1 and 1000', async () => {
    const store = await filled();
    expect((await store.list('', { limit: 0 })).items).toHaveLength(1);
    expect((await store.list('', { limit: 50000 })).items).toHaveLength(5);
  });
});

describe('FakeFileStorage signed URLs', () => {
  it('signs an upload with the headers the browser must send and records its parameters', async () => {
    const clock = new FakeClock(1_000);
    const store = new FakeFileStorage({ clock });
    const signed = await store.signUpload('attachments/x', {
      ...png,
      ttlSeconds: 600,
      ifNoneMatch: true,
      disposition: 'attachment',
    });
    expect(signed.method).toBe('PUT');
    expect(signed.expiresAt).toBe(601_000);
    expect(signed.url.startsWith('https://fake.invalid/attachments/x?')).toBe(true);
    expect(signed.headers).toEqual({
      'content-type': 'image/png',
      'if-none-match': '*',
      'content-disposition': 'attachment',
    });
    expect(store.signed).toEqual([
      expect.objectContaining({
        kind: 'upload',
        key: 'attachments/x',
        size: 10,
        ifNoneMatch: true,
        disposition: 'attachment',
        expiresAt: 601_000,
      }),
    ]);
    const plain = await store.signUpload('attachments/y', {
      ...png,
      ttlSeconds: 1,
    });
    expect(Object.keys(plain.headers)).toEqual(['content-type']);
    expect(plain.url).not.toBe(signed.url);
  });

  it('stores what a valid signed upload sends and nothing else', async () => {
    const store = new FakeFileStorage();
    const { url, headers } = await store.signUpload('k', {
      ...png,
      ttlSeconds: 60,
    });
    await store.receiveSignedUpload(url, headers, bytes('0123456789'));
    expect(await text((await store.get('k')).body)).toBe('0123456789');
    expect(
      await kindOf(store.receiveSignedUpload('https://fake.invalid/k?sig=forged', headers, bytes('0123456789'))),
    ).toBe('unavailable');
  });

  it('refuses a wrong size, a wrong type and an expired signature, leaving the key absent', async () => {
    const clock = new FakeClock(0);
    const store = new FakeFileStorage({ clock });
    const { url, headers } = await store.signUpload('k', {
      ...png,
      ttlSeconds: 60,
    });
    expect(await kindOf(store.receiveSignedUpload(url, headers, bytes('123')))).toBe('unavailable');
    expect(await kindOf(store.receiveSignedUpload(url, { 'Content-Type': 'text/html' }, bytes('0123456789')))).toBe(
      'unavailable',
    );
    clock.advance(59_999);
    await store.receiveSignedUpload(url, { 'Content-Type': 'image/png' }, bytes('0123456789'));
    await store.delete('k');
    clock.advance(1);
    expect(await kindOf(store.receiveSignedUpload(url, headers, bytes('0123456789')))).toBe('unavailable');
    expect(await kindOf(store.head('k'))).toBe('not-found');
  });

  it('refuses an upload that drops or alters the signed content-disposition', async () => {
    const store = new FakeFileStorage();
    const { url, headers } = await store.signUpload('k', { ...png, ttlSeconds: 60, disposition: 'attachment' });
    expect(await kindOf(store.receiveSignedUpload(url, { 'content-type': 'image/png' }, bytes('0123456789')))).toBe(
      'unavailable',
    );
    expect(
      await kindOf(
        store.receiveSignedUpload(url, { ...headers, 'content-disposition': 'inline' }, bytes('0123456789')),
      ),
    ).toBe('unavailable');
    expect(await kindOf(store.head('k'))).toBe('not-found');
    await store.receiveSignedUpload(
      url,
      { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment' },
      bytes('0123456789'),
    );
    expect((await store.head('k')).size).toBe(10);
  });

  it('signs a download with its overrides, expiring on the clock', async () => {
    const clock = new FakeClock(0);
    const store = new FakeFileStorage({ clock });
    const { url, expiresAt } = await store.signDownload('k', {
      ttlSeconds: 30,
      disposition: 'attachment',
      fileName: 'caf\u00e9\r\n.png',
      contentType: 'image/png',
    });
    expect(expiresAt).toBe(30_000);
    const parsed = new URL(url);
    expect(parsed.host).toBe('fake.invalid');
    expect(parsed.searchParams.get('fileName')).toBe('caf\u00e9\r\n.png');
    expect(url).not.toMatch(/[\r\n]/);
    expect(store.signed[0]).toMatchObject({
      kind: 'download',
      disposition: 'attachment',
      fileName: 'caf\u00e9\r\n.png',
      contentType: 'image/png',
    });
    const bare = await store.signDownload('k', {
      ttlSeconds: 30,
      disposition: 'inline',
    });
    expect(store.signed[1]).not.toHaveProperty('fileName');
    expect(bare.url).not.toBe(url);
  });
});
