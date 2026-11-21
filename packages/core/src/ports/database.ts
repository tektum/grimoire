/** Something SQL can run on: the database itself or a transaction on it. Positional parameters are `$1`, `$2`, ... */
export interface Queryable {
  query<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly Row[]>;
}

export interface Database extends Queryable {
  /** Runs `fn` in one transaction: commits when it resolves, rolls back and rethrows when it rejects. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Resolves when the database answers a trivial query; rejects otherwise. */
  ping(): Promise<void>;
  /** Releases every connection. Safe to call more than once. */
  close(): Promise<void>;
}
