import { randomUUID } from 'node:crypto';
import { createAttachments, createTenants } from '@tektum/grimoire-adapter-db-kysely';
import { insertPage, insertSql, raw } from '@tektum/grimoire-test-support/database';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runUploadCleanup } from '../../src/jobs/upload-cleanup.js';
import { jobsDatabase, seedTenant } from './support.js';

let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase('grimoire_m7t02_uploads'); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('the upload clean-up job on a real database', () => {
  it('removes pending uploads past their hour in every tenant, with their objects, and not ready or live ones', async () => {
    const files = new FakeFileStorage();
    const tenants = [await seedTenant(db.sql, 'T-up-a'), await seedTenant(db.sql, 'T-up-b')];
    const rows: { id: string; key: string; expired: boolean }[] = [];
    for (const tenant of tenants) {
      const page = await insertPage(db.sql, { collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId });
      for (const [status, expires] of [['pending', "now() - interval '2 hours'"], ['pending', "now() + interval '1 hour'"], ['ready', 'null']] as const) {
        const id = randomUUID();
        const key = `tenants/${tenant.tenantId}/attachments/${id}`;
        await db.sql(insertSql('attachments', { id, page_id: page, uploader_id: tenant.userId, file_name: 'a.png', content_type: 'image/png', size: 1, s3_key: key, status, expires_at: raw(expires), tenant_id: tenant.tenantId }));
        await files.put(key, new Uint8Array([1]), { size: 1, contentType: 'image/png' });
        rows.push({ id, key, expired: status === 'pending' && expires.startsWith('now() -') });
      }
    }
    const deps = { tenants: createTenants(db.app), attachments: createAttachments(db.app), files, now: () => Date.now() };
    expect(await runUploadCleanup(deps, new AbortController().signal)).toBe(2);
    for (const r of rows) {
      const left = (await db.sql(`select count(*)::int as n from attachments where id = '${r.id}'`)) as { n: number }[];
      expect([r.expired, left[0]?.n, await files.head(r.key).then(() => true, () => false)]).toEqual(r.expired ? [true, 0, false] : [false, 1, true]);
    }
    expect(await runUploadCleanup(deps, new AbortController().signal)).toBe(0);
  }, 60_000);
});
