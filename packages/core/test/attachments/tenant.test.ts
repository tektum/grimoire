import { describe, expect, it } from 'vitest';
import { signedDownload } from '../../src/attachments/downloads.js';
import { attachmentKey, tenantOfKey } from '../../src/attachments/key.js';
import { createUpload, findUploadOf, resignUpload } from '../../src/attachments/uploads.js';
import { LIMITS, PAGE, row, setup, USER } from './support.js';

// docs/tenancy.md 3.5 (section 7, item 3): the key of a new upload sits under its tenant, and a row, a key or a link of another tenant is not found.
const input = { pageId: PAGE, uploaderId: USER, fileName: 'a.png', contentType: 'image/png', size: 10 };
const A = 'tenant-a';
const B = 'tenant-b';

describe('the key', () => {
  it('sits under the tenant for a tenant, and as it always did without one', () => {
    expect(attachmentKey('abc', A)).toBe('tenants/tenant-a/attachments/abc');
    expect(attachmentKey('abc')).toBe('attachments/abc');
    expect(tenantOfKey('tenants/tenant-a/attachments/abc')).toBe('tenant-a');
    expect(tenantOfKey('attachments/abc')).toBeUndefined();
  });

  it.each(['', 'a/b', '..', 'a b', 'x'.repeat(129), 'a\u0000b'])('refuses a tenant id that could change the path: %j', (tenant) => {
    expect(() => attachmentKey('abc', tenant)).toThrow(/tenant/i);
  });
});

describe('an upload of tenant A', () => {
  it('is created under tenant A\'s prefix, and the row says A', async () => {
    const { deps, repo } = setup();
    const r = await createUpload(deps, { ...input, tenantId: A }, LIMITS);
    if (r.kind !== 'created') throw new Error('not created');
    const stored = await repo.get(r.id);
    expect([stored?.tenantId, stored?.key]).toEqual([A, `tenants/${A}/attachments/${r.id}`]);
  });

  it('is found, re-signed and completed for A, and not found for B (as an upload that is not there)', async () => {
    const { deps } = setup();
    const r = await createUpload(deps, { ...input, tenantId: A }, LIMITS);
    if (r.kind !== 'created') throw new Error('not created');
    expect(await findUploadOf(deps, r.id, USER, A)).toBeDefined();
    expect(await findUploadOf(deps, r.id, USER, B)).toBeUndefined();
    expect(await findUploadOf(deps, r.id, USER)).toBeUndefined();
    expect((await resignUpload(deps, r.id, USER, A)).kind).toBe('resigned');
    expect(await resignUpload(deps, r.id, USER, B)).toEqual({ kind: 'gone' });
  });

  it('signs for A only A\'s key, and refuses to sign for B, whatever the row\'s key says', async () => {
    const { deps, files } = setup();
    const r = await createUpload(deps, { ...input, tenantId: A }, LIMITS);
    if (r.kind !== 'created') throw new Error('not created');
    const stored = (await deps.repo.get(r.id))!;
    await expect(signedDownload(files, stored, false, A)).resolves.toMatchObject({ url: expect.any(String) });
    expect(files.signed.at(-1)?.key).toBe(`tenants/${A}/attachments/${r.id}`);
    const before = files.signed.length;
    await expect(signedDownload(files, stored, false, B)).rejects.toThrow(/tenant/i);
    expect(files.signed.length).toBe(before);
  });

  it('is refused a link when its key lies under another tenant\'s prefix (a row and a key that disagree)', async () => {
    const { files } = setup();
    const bad = row({ tenantId: A, key: `tenants/${B}/attachments/x`, status: 'ready', expiresAt: null });
    await expect(signedDownload(files, bad, false, A)).rejects.toThrow(/tenant/i);
  });

  it('keeps the files of an adopted tenant downloadable: the rows moved to it, the objects stayed under the legacy prefix', async () => {
    const { files } = setup();
    const adopted = row({ tenantId: A, key: 'tenants/legacy/attachments/x', status: 'ready', expiresAt: null });
    await expect(signedDownload(files, adopted, false, A)).resolves.toBeDefined();
    await expect(signedDownload(files, adopted, false, B)).rejects.toThrow(/tenant/i);
  });
});

describe('a row from before tenants', () => {
  it('keeps its key, and is read through its own tenant check (the row\'s tenant, not the key\'s prefix)', async () => {
    const { files } = setup();
    const old = row({ tenantId: 'legacy', status: 'ready', expiresAt: null });
    expect(old.key.startsWith('attachments/')).toBe(true);
    await expect(signedDownload(files, old, false, 'legacy')).resolves.toBeDefined();
    await expect(signedDownload(files, old, false, A)).rejects.toThrow(/tenant/i);
  });

  it('is unchanged while nobody names a tenant (rows and callers without one)', async () => {
    const { deps, files } = setup();
    const r = await createUpload(deps, input, LIMITS);
    if (r.kind !== 'created') throw new Error('not created');
    const stored = (await deps.repo.get(r.id))!;
    expect(stored.key).toBe(`attachments/${r.id}`);
    expect(await findUploadOf(deps, r.id, USER)).toBeDefined();
    await expect(signedDownload(files, { ...stored, status: 'ready' }, false)).resolves.toBeDefined();
  });
});
