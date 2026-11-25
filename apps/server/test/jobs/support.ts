import { randomUUID } from 'node:crypto';
import { createDatabase, createOpsDatabase, type KyselyDatabase, type OperatorDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { insertCollection, insertPage, insertSql, insertUser, opsUrl, raw } from '@tektum/grimoire-test-support/database';
import { createJobQueue, type PgBossJobQueue } from '@tektum/grimoire-adapter-jobs-pgboss';
import type { QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';
import { appUrl, createTestDatabase, dropTestDatabase, migratorUrl, requireBuild, sqlAdmin } from '../server/support/harness.js';

/** A migrated database of its own, the runtime and operator roles' connections to it, and a way to seed rows as the owner. */
export async function jobsDatabase(name: string): Promise<{ readonly app: KyselyDatabase; readonly ops: OperatorDatabase; readonly sql: (text: string) => Promise<unknown>; drop(): Promise<void> }> {
  requireBuild();
  await createTestDatabase(name, true);
  const app = createDatabase(appUrl(name), { maxConnections: 4 });
  const ops = createOpsDatabase(opsUrl(name));
  return { app, ops, sql: (text) => sqlAdmin(name, text), async drop() { await app.close(); await ops.close(); await dropTestDatabase(name); } };
}

type Sql = (text: string) => Promise<unknown>;

/** A tenant with a person and a collection; returns what pages and attachments need. */
export async function seedTenant(sql: Sql, tenantId: string): Promise<{ readonly tenantId: string; readonly userId: string; readonly collectionId: string }> {
  await sql(insertSql('tenants', { id: tenantId, name: tenantId }));
  const userId = await insertUser(sql, { tenant_id: tenantId });
  const collectionId = await insertCollection(sql, { created_by: userId, tenant_id: tenantId });
  return { tenantId, userId, collectionId };
}

/** A deleted page that is the root of its own batch, deleted `days` ago, with one revision and one ready attachment whose key is returned. */
export async function seedDeletedPage(sql: Sql, tenant: Awaited<ReturnType<typeof seedTenant>>, days: number): Promise<{ readonly id: string; readonly key: string }> {
  const id = randomUUID();
  await insertPage(sql, { id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, deleted_at: raw(`now() - interval '${String(days)} days'`), deleted_batch: id });
  await sql(insertSql('revisions', { page_id: id, title: 't', markdown: 'm', markdown_hash: raw(`decode(repeat('00', 32), 'hex')`), reason: 'manual', created_at: raw('now()'), tenant_id: tenant.tenantId }));
  const key = `tenants/${tenant.tenantId}/attachments/${id}`;
  await sql(insertSql('attachments', { id: randomUUID(), page_id: id, file_name: 'a.png', content_type: 'image/png', size: 1, s3_key: key, status: 'ready', tenant_id: tenant.tenantId }));
  return { id, key };
}

/** A queue made by the migration role, as `grimoire migrate` makes them (the runtime role may not), with the dead-letter queue of the migrated database. */
export async function makeQueue(database: string, name: string, over: Partial<QueueDefinition> = {}): Promise<void> {
  const admin = await createJobQueue({ connectionString: migratorUrl(database), max: 1, onError: () => undefined });
  try {
    await admin.ensureQueue({ name, policy: 'standard', retryLimit: 0, retryDelaySeconds: 1, retryBackoff: false, expireInSeconds: 60, retentionSeconds: 3600, deadLetter: 'dead-letter', ...over });
  } finally {
    await admin.stop({ graceMs: 1000 });
  }
}

/** The job queue the server runs on: the runtime role's connection. */
export function runtimeQueue(database: string): Promise<PgBossJobQueue> {
  return createJobQueue({ connectionString: appUrl(database), max: 4, onError: () => undefined });
}
