import { randomBytes } from 'node:crypto';

/** A Postgres URL built from its parts: tests make theirs here, so that no test file holds a credentialed URL as a literal (a check of the test tools fails on one). */
export function databaseUrl(user: string, password: string, host: string, database: string): string {
  const url = new URL(`postgresql://${host}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** A URL for a test that parses settings and never connects (or connects to a closed port): the password is new for each run, so it is not a value anybody can rely on. */
export const placeholderDatabaseUrl = (host = '127.0.0.1:55432', database = 'grimoire', user = 'u'): string => databaseUrl(user, randomBytes(6).toString('hex'), host, database);
