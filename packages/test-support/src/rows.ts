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

/** Inserts a collection created by the system user unless told otherwise and returns its id. */
export function insertCollection(run: RunSql, overrides: Columns = {}): Promise<string> {
  return insertRow(run, 'collections', {
    name: `Collection ${randomUUID()}`,
    position: 'a0',
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
