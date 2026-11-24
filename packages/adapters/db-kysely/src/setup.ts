import type { KyselyDatabase } from './index.js';

/** The two database roles of the product. Their names are fixed by the migrations (they grant to `grimoire_app`) and by the job queue set-up. */
export const DATABASE_ROLES = { app: 'grimoire_app', migrator: 'grimoire_migrator' } as const;
export interface DatabaseRoles { readonly app: string; readonly migrator: string }

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const MIN_PASSWORD_LENGTH = 16;

export interface SetupResult { readonly created: readonly string[]; readonly updated: readonly string[] }

/**
 * Makes a managed database ready for `grimoire migrate`, as the cluster's administrator (the master user of a managed service, or a superuser): the same end
 * state as `db/init/roles.psql`, which does this for the local stack, but safe to run again. The two login roles exist with the given passwords (a run with
 * new passwords rotates them), only they may connect, the migration role owns schema `public` and the job queue's schema `pgboss`, the runtime role may
 * use `public` and nothing more (each migration grants it what it needs), and the `citext` extension exists (the migration role cannot create one).
 * Passwords are quoted by the server (`quote_literal`) and never logged or returned. `roles` is for tests; the product always uses `DATABASE_ROLES`.
 */
export async function setupDatabase(
  db: KyselyDatabase,
  passwords: { readonly app: string; readonly migrator: string },
  roles: DatabaseRoles = DATABASE_ROLES,
): Promise<SetupResult> {
  for (const name of [roles.app, roles.migrator]) if (!ROLE_NAME.test(name)) throw new Error('a database role name must be lowercase letters, digits and underscores');
  if (roles.app === roles.migrator) throw new Error('the runtime role and the migration role must be different roles');
  for (const password of [passwords.app, passwords.migrator]) if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`a database password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`);

  const quote = async (kind: 'ident' | 'literal', value: string): Promise<string> => {
    const [row] = await db.query<{ q: string }>(`select quote_${kind}($1::text) as q`, [value]);
    if (row === undefined) throw new Error('the server did not quote a value');
    return row.q;
  };
  const created: string[] = [];
  const updated: string[] = [];
  for (const [name, password] of [[roles.migrator, passwords.migrator], [roles.app, passwords.app]] as const) {
    const exists = (await db.query('select 1 from pg_roles where rolname = $1', [name])).length > 0;
    await db.query(`${exists ? 'alter' : 'create'} role ${await quote('ident', name)} with login password ${await quote('literal', password)}`);
    (exists ? updated : created).push(name);
  }
  const app = await quote('ident', roles.app);
  const migrator = await quote('ident', roles.migrator);
  const database = await quote('ident', (await db.query<{ name: string }>('select current_database() as name'))[0]?.name ?? '');

  // A managed service's master user is not a superuser: to hand an object to the migration role it must be able to become that role.
  const [me] = await db.query<{ super: boolean }>('select rolsuper as super from pg_roles where rolname = current_user');
  if (me?.super === false) await db.query(`grant ${migrator} to current_user with set true`);

  await db.query(`revoke all on database ${database} from public`);
  await db.query(`grant connect on database ${database} to ${migrator}, ${app}`);
  await db.query(`alter schema public owner to ${migrator}`);
  await db.query('revoke all on schema public from public');
  await db.query(`grant usage on schema public to ${app}`);
  await db.query(`create schema if not exists pgboss authorization ${migrator}`);
  await db.query('create extension if not exists citext');
  return { created, updated };
}
