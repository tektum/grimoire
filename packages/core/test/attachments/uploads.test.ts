import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, completeUpload, createUpload, findUploadOf, resignUpload } from '../../src/attachments/uploads.js';
import { FileStorageError } from '../../src/ports/file-storage.js';
import type { FileStorage } from '../../src/ports/file-storage.js';
import { LIMITS, NOW, PAGE, USER, row, setup } from './support.js';

const meta = { pageId: PAGE, uploaderId: USER, fileName: 'a.png', contentType: 'image/png', size: 10 };

describe('createUpload', () => {
  it('refuses the type first, then the size, and a size that is not a positive whole number', async () => {
    const { deps } = setup();
    expect(await createUpload(deps, { ...meta, contentType: 'image/svg+xml', size: 10 ** 9 }, LIMITS)).toEqual({ kind: 'refused', reason: 'type_not_allowed' });
    expect(await createUpload(deps, { ...meta, size: LIMITS.maxBytes + 1 }, LIMITS)).toEqual({ kind: 'refused', reason: 'too_large' });
    for (const size of [0, -1, 1.5, Number.NaN]) expect(await createUpload(deps, { ...meta, size }, LIMITS), String(size)).toEqual({ kind: 'refused', reason: 'invalid' });
  });

  it('inserts a pending row with the cleaned name and an hour to live, signs the exact size and type, and gives the Markdown path', async () => {
    const { deps, repo, files } = setup();
    const result = await createUpload(deps, { ...meta, fileName: '../x y.png', contentType: 'IMAGE/PNG' }, LIMITS);
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(await repo.get(result.id)).toMatchObject({ pageId: PAGE, uploaderId: USER, fileName: '_x y.png', contentType: 'image/png', size: 10, key: `attachments/${result.id}`, status: 'pending', expiresAt: NOW + PENDING_TTL_MS });
    expect(result.markdownPath).toBe(`attachments/${result.id}/_x%20y.png`);
    expect(result.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png', 'if-none-match': '*' } });
    expect(result.upload.headers['content-disposition']).toBeUndefined();
    expect(files.signed).toMatchObject([{ kind: 'upload', key: `attachments/${result.id}`, size: 10, contentType: 'image/png' }]);
  });

  it('signs an attachment disposition for a type a browser would not show inline', async () => {
    const { deps } = setup();
    const result = await createUpload(deps, { ...meta, fileName: 'n.txt', contentType: 'text/plain' }, LIMITS);
    expect(result.kind === 'created' && result.upload.headers['content-disposition']).toBe('attachment');
  });

  it('refuses at the cap of live pending uploads, a missing page, and a missing user', async () => {
    const { deps, clock } = setup({ pages: (id) => id === PAGE });
    expect((await createUpload(deps, meta, LIMITS)).kind).toBe('created');
    expect((await createUpload(deps, meta, LIMITS)).kind).toBe('created');
    expect(await createUpload(deps, meta, LIMITS)).toEqual({ kind: 'refused', reason: 'rate_limited' });
    clock.at += PENDING_TTL_MS + 1; // the two have expired: they no longer count
    expect((await createUpload(deps, meta, LIMITS)).kind).toBe('created');
    expect(await createUpload(deps, { ...meta, pageId: '00000000-0000-4000-8000-0000000000ff' }, LIMITS)).toEqual({ kind: 'refused', reason: 'no-page' });
    const users = setup({ pages: () => true });
    const strict = { ...users.deps, repo: new (users.repo.constructor as new (e: object) => typeof users.repo)({ users: () => false }) };
    expect(await createUpload(strict, meta, LIMITS)).toEqual({ kind: 'refused', reason: 'no-user' });
  });

  it('removes the row again when the store cannot sign, so a store that is down does not use up the cap', async () => {
    const { files, repo, deps } = setup();
    const down: FileStorage = { ...files, signUpload: () => Promise.reject(new FileStorageError('unavailable', 'down')) } as unknown as FileStorage;
    await expect(createUpload({ ...deps, files: down }, meta, LIMITS)).rejects.toThrow('down');
    expect(repo.all()).toEqual([]);
  });
});

describe('resignUpload', () => {
  it('signs a new upload for the uploader\'s pending row that has not expired', async () => {
    const { deps, files } = setup();
    const made = await createUpload(deps, meta, LIMITS);
    if (made.kind !== 'created') throw new Error('setup');
    const again = await resignUpload(deps, made.id, USER);
    expect(again.kind).toBe('resigned');
    expect(again.kind === 'resigned' && [again.upload.url !== made.upload.url, again.markdownPath]).toEqual([true, made.markdownPath]);
    expect(files.signed).toHaveLength(2);
  });

  it('answers gone for an unknown row, another user, a ready row, an expired row and a pending row with no expiry', async () => {
    const { deps, repo, clock } = setup();
    const made = await createUpload(deps, meta, LIMITS);
    if (made.kind !== 'created') throw new Error('setup');
    expect(await resignUpload(deps, '00000000-0000-4000-8000-0000000000aa', USER)).toEqual({ kind: 'gone' });
    expect(await resignUpload(deps, made.id, 'someone-else')).toEqual({ kind: 'gone' });
    repo.seed(row({ id: 'r', status: 'ready', expiresAt: null, readyAt: NOW }));
    expect(await resignUpload(deps, 'r', USER)).toEqual({ kind: 'gone' });
    repo.seed(row({ id: 'n', expiresAt: null }));
    expect(await resignUpload(deps, 'n', USER)).toEqual({ kind: 'gone' });
    clock.at += PENDING_TTL_MS;
    expect(await resignUpload(deps, made.id, USER)).toEqual({ kind: 'gone' });
  });
});

describe('findUploadOf', () => {
  it('finds the caller\'s own pending row until it expires, and a ready one', async () => {
    const { deps, repo, clock } = setup();
    const pending = repo.seed(row({ id: 'p' }));
    const ready = repo.seed(row({ id: 'q', status: 'ready', expiresAt: null, readyAt: NOW }));
    expect(await findUploadOf(deps, 'p', USER)).toEqual(pending);
    expect(await findUploadOf(deps, 'q', USER)).toEqual(ready);
    expect(await findUploadOf(deps, 'p', 'another')).toBeUndefined();
    expect(await findUploadOf(deps, 'missing', USER)).toBeUndefined();
    repo.seed(row({ id: 'n', expiresAt: null }));
    expect(await findUploadOf(deps, 'n', USER)).toBeUndefined();
    clock.at += PENDING_TTL_MS;
    expect(await findUploadOf(deps, 'p', USER)).toBeUndefined();
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
async function uploaded(over: { contentType?: string; size?: number; stored?: number; sniffed?: string | undefined } = {}) {
  const t = setup({ sniff: () => Promise.resolve('sniffed' in over ? over.sniffed : 'image/png') });
  const made = await createUpload(t.deps, { ...meta, contentType: over.contentType ?? 'image/png', size: over.size ?? 4 }, LIMITS);
  if (made.kind !== 'created') throw new Error('setup');
  if (over.stored !== 0) await t.files.put(`attachments/${made.id}`, PNG.slice(0, over.stored ?? 4), { size: over.stored ?? 4, contentType: over.contentType ?? 'image/png' });
  const stored = (await t.repo.get(made.id)) ?? row();
  return { ...t, id: made.id, stored };
}

describe('completeUpload', () => {
  it('makes the row ready when the object is there with the declared size and the bytes show the declared type', async () => {
    const t = await uploaded();
    const result = await completeUpload(t.deps, t.stored);
    expect(result).toMatchObject({ kind: 'ready', row: { id: t.id, status: 'ready', expiresAt: null, readyAt: NOW } });
    expect(await completeUpload(t.deps, t.stored)).toMatchObject({ kind: 'ready' }); // the same call again is the same answer
  });

  it('answers a ready row as it is, without touching the store', async () => {
    const t = setup();
    const ready = row({ status: 'ready', expiresAt: null, readyAt: NOW });
    expect(await completeUpload(t.deps, ready)).toEqual({ kind: 'ready', row: ready });
    expect(t.files.signed).toEqual([]);
  });

  it('refuses a missing object (upload_missing), a size that differs, and bytes of another type, each deleting the object and the row', async () => {
    const missing = await uploaded({ stored: 0 });
    expect(await completeUpload(missing.deps, missing.stored)).toEqual({ kind: 'refused', reason: 'upload_missing' });
    expect(await missing.repo.get(missing.id)).toBeUndefined();
    const wrongSize = await uploaded({ stored: 3 });
    expect(await completeUpload(wrongSize.deps, wrongSize.stored)).toEqual({ kind: 'refused', reason: 'size_mismatch' });
    await expect(wrongSize.files.head(wrongSize.stored.key)).rejects.toMatchObject({ kind: 'not-found' });
    expect(await wrongSize.repo.get(wrongSize.id)).toBeUndefined();
    for (const sniffed of ['image/jpeg', undefined]) {
      const wrongType = await uploaded({ sniffed });
      expect(await completeUpload(wrongType.deps, wrongType.stored)).toEqual({ kind: 'refused', reason: 'type_mismatch' });
      await expect(wrongType.files.head(wrongType.stored.key)).rejects.toMatchObject({ kind: 'not-found' });
      expect(await wrongType.repo.get(wrongType.id)).toBeUndefined();
    }
  });

  it('does not look at the bytes of a type that is not checked', async () => {
    let looked = false;
    const t = setup({ sniff: () => { looked = true; return Promise.resolve(undefined); } });
    const made = await createUpload(t.deps, { ...meta, fileName: 'n.txt', contentType: 'text/plain', size: 4 }, LIMITS);
    if (made.kind !== 'created') throw new Error('setup');
    await t.files.put(`attachments/${made.id}`, PNG, { size: 4, contentType: 'text/plain' });
    expect(await completeUpload(t.deps, (await t.repo.get(made.id)) as never)).toMatchObject({ kind: 'ready' });
    expect(looked).toBe(false);
  });

  it('passes on a store error other than a missing object', async () => {
    const t = await uploaded();
    const down: FileStorage = { ...t.files, head: () => Promise.reject(new FileStorageError('unavailable', 'down')) } as unknown as FileStorage;
    await expect(completeUpload({ ...t.deps, files: down }, t.stored)).rejects.toThrow('down');
    expect(await t.repo.get(t.id)).toBeDefined();
    const other: FileStorage = { ...t.files, head: () => Promise.reject(new Error('boom')) } as unknown as FileStorage;
    await expect(completeUpload({ ...t.deps, files: other }, t.stored)).rejects.toThrow('boom');
  });

  it('reads at most 512 bytes in as many chunks as the store sends, and a short object whole', async () => {
    const seen: number[] = [];
    const t = setup({ sniff: (bytes) => { seen.push(bytes.length); return Promise.resolve('application/pdf'); } });
    const chunked = (sizes: number[]): FileStorage => ({
      head: (key: string) => t.files.head(key),
      get: () => Promise.resolve({ body: (async function* () { for (const n of sizes) yield new Uint8Array(n).fill(1); })(), size: 700, contentType: 'application/pdf' }),
      delete: (key: string) => t.files.delete(key),
    }) as unknown as FileStorage;
    for (const [sizes, stored] of [[[300, 300, 100], 700], [[100, 50], 150], [[512], 512]] as [number[], number][]) {
      const made = await createUpload(t.deps, { ...meta, fileName: 'd.pdf', contentType: 'application/pdf', size: stored }, { ...LIMITS, maxBytes: 5000, pendingMaxPerUser: 50 });
      if (made.kind !== 'created') throw new Error('setup');
      await t.files.put(`attachments/${made.id}`, new Uint8Array(stored), { size: stored, contentType: 'application/pdf' });
      expect(await completeUpload({ ...t.deps, files: chunked(sizes) }, (await t.repo.get(made.id)) as never)).toMatchObject({ kind: 'ready' });
    }
    expect(seen).toEqual([512, 150, 512]);
  });

  it('answers ready when another completion won the race, and gone when the row expired and was cleaned', async () => {
    const t = await uploaded();
    const raced = { ...t.repo, markReady: async () => { await t.repo.markReady(t.id, NOW); return undefined; }, get: (id: string) => t.repo.get(id) } as unknown as typeof t.repo;
    expect(await completeUpload({ ...t.deps, repo: raced }, t.stored)).toMatchObject({ kind: 'ready', row: { id: t.id } });
    const second = await uploaded();
    t.clock.at = second.clock.at;
    second.clock.at += PENDING_TTL_MS + 1; // the upload passed its expiry between the check and the update
    expect(await completeUpload(second.deps, second.stored)).toEqual({ kind: 'gone' });
  });
});

describe('review: the two races', () => {
  it('signs a re-signed upload for no longer than the row has left, and answers gone with less than a second left', async () => {
    const { deps, files, clock } = setup();
    const made = await createUpload(deps, meta, LIMITS);
    if (made.kind !== 'created') throw new Error('setup');
    clock.at += PENDING_TTL_MS - 120_000; // two minutes left
    const again = await resignUpload(deps, made.id, USER);
    expect(again.kind === 'resigned' && again.upload.expiresAt).toBe(clock.at + 120_000);
    expect(files.signed.at(-1)).toMatchObject({ kind: 'upload' });
    clock.at += 119_500; // half a second left
    expect(await resignUpload(deps, made.id, USER)).toEqual({ kind: 'gone' });
  });

  it('does not delete an upload that another completion made ready while this one saw no object', async () => {
    const t = await uploaded({ stored: 0 });
    // The object arrives and the other completion finishes after this one looked.
    const racing = { ...t.repo, removeIfPending: async () => { await t.files.put(t.stored.key, PNG, { size: 4, contentType: 'image/png' }); await t.repo.markReady(t.id, NOW); return false; }, get: (id: string) => t.repo.get(id) } as unknown as typeof t.repo;
    expect(await completeUpload({ ...t.deps, repo: racing }, t.stored)).toMatchObject({ kind: 'ready', row: { id: t.id, status: 'ready' } });
    expect((await t.files.head(t.stored.key)).size).toBe(4);
    expect(await t.repo.get(t.id)).toMatchObject({ status: 'ready' });
  });

  it('answers gone when the row to discard is already removed', async () => {
    const t = await uploaded({ stored: 0 });
    await t.repo.remove(t.id);
    expect(await completeUpload(t.deps, t.stored)).toEqual({ kind: 'gone' });
  });
});
