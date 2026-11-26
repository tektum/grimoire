import { randomUUID } from 'node:crypto';

/** The two rows migration 0004 seeds: the owner of everything created by the migration, and the collection old pages live in. */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';
export const UNFILED_COLLECTION_ID = '00000000-0000-4000-8000-000000000002';

/** Runs one SQL statement; any of the suites' executors fits (`sqlAdmin(db, ...)`, a pooled client, a psql wrapper). */
export type RunSql = (sql: string) => Promise<unknown>;

/** A raw SQL expression, inserted as written (for `now()`, `decode(...)` and the like). */
export interface RawSql { readonly raw: string }
export type ColumnValue = string | number | boolean | null | Date | Uint8Array | RawSql;
export type Columns = Readonly<Record<string, ColumnValue>>;

export const raw = (expression: string): RawSql => ({ raw: expression });

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function literal(value: ColumnValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (value instanceof Uint8Array) return `'\\x${Buffer.from(value).toString('hex')}'`;
  if (typeof value === 'object') return value.raw;
  return `'${value.replaceAll("'", "''")}'`;
}

export function insertSql(table: string, columns: Columns): string {
  const names = Object.keys(columns);
  for (const name of [table, ...names]) if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  if (names.length === 0) return `insert into ${table} default values`;
  return `insert into ${table} (${names.join(', ')}) values (${names.map((n) => literal(columns[n] as ColumnValue)).join(', ')})`;
}

async function insertRow(run: RunSql, table: string, columns: Columns): Promise<string> {
  if (columns.id !== undefined && typeof columns.id !== 'string') throw new Error('An explicit id must be a string: the helper returns it');
  const id = columns.id ?? randomUUID();
  await run(insertSql(table, { ...columns, id }));
  return id;
}

/** Inserts a member and returns its id. Other columns keep their defaults. */
export function insertUser(run: RunSql, overrides: Columns = {}): Promise<string> {
  const unique = randomUUID();
  return insertRow(run, 'users', {
    descope_user_id: `test:${unique}`,
    email: `${unique}@grimoire.invalid`,
    name: 'Test user',
    ...overrides,
  });
}

/** Inserts a collection with its own position, created by the system user unless told otherwise and returns its id. */
export function insertCollection(run: RunSql, overrides: Columns = {}): Promise<string> {
  return insertRow(run, 'collections', {
    name: `Collection ${randomUUID()}`,
    position: `b${randomUUID().replaceAll('-', '')}`, // unique: collection positions are unique since migration 0006
    created_by: SYSTEM_USER_ID,
    ...overrides,
  });
}

/** Inserts a page in the Unfiled collection, created by the system user, unless told otherwise; returns its id. */
export function insertPage(run: RunSql, overrides: Columns = {}): Promise<string> {
  return insertRow(run, 'pages', {
    collection_id: UNFILED_COLLECTION_ID,
    created_by: SYSTEM_USER_ID,
    ...overrides,
  });
}

/** The tables that carry `tenant_id` (migrations 0009 and 0011). */
export const TENANT_TABLES = ['users', 'groups', 'group_members', 'collections', 'collection_access', 'pages', 'revisions', 'attachments', 'audit_events', 'idempotency_keys', 'imports', 'import_items', 'import_parts', 'page_chunks', 'page_embedding_state'] as const;

/** One row in every tenant table, all in `tenantId` (whose `tenants` row must exist), around a new person of that tenant; returns that person's id. */
export async function insertTenantRows(run: RunSql, tenantId: string): Promise<string> {
  const tenant = { tenant_id: tenantId };
  const hash = raw(`decode(repeat('00', 32), 'hex')`);
  const user = await insertUser(run, tenant);
  const group = await insertRow(run, 'groups', { name: `Group ${randomUUID()}`, ...tenant });
  await run(insertSql('group_members', { group_id: group, user_id: user, ...tenant }));
  const collection = await insertCollection(run, { created_by: user, ...tenant });
  await run(insertSql('collection_access', { collection_id: collection, user_id: user, permission: 'read', ...tenant }));
  const page = await insertPage(run, { collection_id: collection, created_by: user, ...tenant });
  await insertRow(run, 'revisions', { page_id: page, title: 'T', markdown: 'M', markdown_hash: hash, reason: 'manual', created_at: raw('now()'), ...tenant });
  const attachment = randomUUID();
  await insertRow(run, 'attachments', { id: attachment, page_id: page, file_name: 'a.png', content_type: 'image/png', size: 3, s3_key: `attachments/${attachment}`, status: 'ready', ...tenant });
  await run(insertSql('audit_events', { actor_id: user, action: 'test', ...tenant }));
  await run(insertSql('idempotency_keys', { user_id: user, key: 'k', request_hash: hash, ...tenant }));
  const imported = await insertRow(run, 'imports', { target_collection_id: collection, source: 'markdown_zip', ...tenant });
  await run(insertSql('import_items', { import_id: imported, path: 'a.md', kind: 'page', ...tenant }));
  await run(insertSql('import_parts', { import_id: imported, ordinal: 0, s3_key: 'imports/a.zip', bytes: 1, ...tenant }));
  await run(insertSql('page_chunks', { page_id: page, chunk_index: 0, model: 'test', content_hash: hash, char_start: 0, char_end: 1, token_count: 1, embedding: '[1,2,3]', ...tenant }));
  await run(insertSql('page_embedding_state', { page_id: page, markdown_hash: hash, model: 'test', status: 'ready', ...tenant }));
  return user;
}
