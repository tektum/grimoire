import type { Database, Queryable } from '../ports/database.js';

type Row = Record<string, unknown>;

/**
 * In-memory Database for other packages' unit tests. Hand-written because no library fakes a Database port;
 * it understands only `insert into t (cols) values ($n, ...)` and `select cols from t [order by c]` (enough for
 * conformance and simple unit tests). Any other statement is recorded and answered by the optional `handler`.
 */
export class FakeDatabase implements Database {
  /** Every statement run, in order, including those of rolled-back transactions. */
  readonly statements: { sql: string; params: readonly unknown[] }[] = [];
  private tables = new Map<string, Row[]>();
  private closed = false;

  constructor(private readonly handler?: (sql: string, params: readonly unknown[]) => readonly Row[]) {}

  private exec(tables: Map<string, Row[]>, sql: string, params: readonly unknown[]): readonly Row[] {
    if (this.closed) throw new Error('database is closed');
    this.statements.push({ sql, params });
    const ins = /^\s*insert\s+into\s+(\w+)\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/i.exec(sql);
    if (ins) {
      const [, table, cols, vals] = ins as unknown as [string, string, string, string];
      const names = cols.split(',').map((c) => c.trim());
      const row: Row = {};
      vals.split(',').forEach((v, i) => {
        const m = /^\s*\$(\d+)\s*$/.exec(v);
        row[names[i] as string] = m ? params[Number(m[1]) - 1] : undefined;
      });
      tables.set(table, [...(tables.get(table) ?? []), row]);
      return [];
    }
    const sel = /^\s*select\s+(.+?)\s+from\s+(\w+)(?:\s+order\s+by\s+(\w+))?\s*$/i.exec(sql);
    if (sel) {
      const [, cols, table, order] = sel as unknown as [string, string, string, string | undefined];
      let rows = [...(tables.get(table) ?? [])];
      if (order) rows = rows.sort((a, b) => (a[order] as number) - (b[order] as number));
      const names = cols.trim() === '*' ? undefined : cols.split(',').map((c) => c.trim());
      return rows.map((r) => (names ? Object.fromEntries(names.map((n) => [n, r[n]])) : { ...r }));
    }
    return this.handler ? this.handler(sql, params) : [];
  }

  async query<R = unknown>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
    return this.exec(this.tables, sql, params) as readonly R[];
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('database is closed');
    const work = new Map([...this.tables].map(([k, v]) => [k, [...v]]));
    const tx: Queryable = { query: async <R>(sql: string, params: readonly unknown[] = []) => this.exec(work, sql, params) as readonly R[] };
    const result = await fn(tx);
    this.tables = work; // commit: reached only when fn resolved
    return result;
  }

  async ping(): Promise<void> {
    if (this.closed) throw new Error('database is closed');
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
