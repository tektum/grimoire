# Database set-up on a managed PostgreSQL

`grimoire db-setup` makes an empty managed database ready for `grimoire migrate`. The local stack does the same through `db/init/roles.psql`; a managed database has no such step, so the command does it, as the database administrator (the master user of the service).

Run it before the first migration, in the same pre-rollout step, and again whenever a password is rotated. It is safe to run again.

| Setting | Meaning |
|---|---|
| `GRIMOIRE_DATABASE_ADMIN_URL` | the administrator's connection to the product database |
| `GRIMOIRE_DB_APP_PASSWORD` | the password to give the runtime role `grimoire_app` (at least 16 characters) |
| `GRIMOIRE_DB_MIGRATOR_PASSWORD` | the password to give the migration role `grimoire_migrator` (at least 16 characters) |
| `GRIMOIRE_DB_OPS_PASSWORD` | the password to give the operator role `grimoire_ops` (at least 16 characters) |

End state, in one transaction (a failure leaves the database as it was):

- The three roles exist as plain `LOGIN` roles with no other attribute: no privilege attribute, no connection limit, no expiry. A role that exists already is reset to that, and the command refuses a role that is a member of another role, except the one membership below.
- The operator role `grimoire_ops` is a member of the runtime role `grimoire_app`, so it has exactly the runtime role's grants and none of its own, and it cannot become the migration role or the administrator. It is for the few call sites that cross tenants (`docs/tenancy.md` section 3.2): the row-level security policies name it. It has no `BYPASSRLS`: on a managed service the master user does not hold that attribute (on RDS only the service's own `rdsadmin` does), and PostgreSQL lets only a superuser or a role that holds it give it.
- A non-superuser administrator can only reset a privilege attribute (`CREATEDB`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`) that it holds itself, on PostgreSQL 16 and later. When it cannot, the command fails, changes nothing and says to reset the role as a superuser or drop it. A clean database never hits this.
- The roles have the passwords you gave. A run with new passwords changes them.
- The public may not connect to the database. A role that already holds an explicit grant keeps it: that is the administrator's decision.
- The migration role owns schema `public` and the job queue's schema `pgboss`, also when `pgboss` was there before.
- The runtime role may use `public` and nothing more. Each migration grants it what it needs.
- The `citext` extension exists.

The server receives a SCRAM-SHA-256 verifier computed here, not the password, so the password is not in any statement the server may log or record (`log_statement`, pgaudit, `pg_stat_statements`). The command never logs it either.

The server refuses to start when the administrator connection or a role password is set: only this step holds them. The server takes the operator role's connection as `GRIMOIRE_DATABASE_OPS_URL` (optional for now; nothing falls back to the runtime connection when it is missing).

Tested against PostgreSQL 17 as a superuser and as a non-superuser with `CREATEROLE` (the shape of a managed master user). Not yet run on a real managed service: on one, the master user must be able to become the migration role to hand it the schemas, which the command arranges with `GRANT ... WITH SET TRUE`.

## Moving the existing workspace into a tenant: `grimoire tenant-adopt`

Migration 0009 put every row a database held before tenancy in the tenant `legacy`. `grimoire tenant-adopt --from legacy --to <tenant id> [--name <name> --domain <domain>]` moves all of it into a real tenant, once, by hand (`docs/tenancy.md` section 5, item 4). It runs as the migration role, with `GRIMOIRE_DATABASE_MIGRATION_URL` like `grimoire migrate`.

- One transaction: every row of every tenant table moves, or none does. Writes to those tables wait until it ends; reads go on.
- The target's `tenants` row is used when it exists (a first sign-in made it). When it does not, `--name` and `--domain` make it, and without them the command refuses.
- It refuses, and changes nothing, when the target already holds a row in any tenant table other than `users`, or when the source holds no row at all (so a second run is refused). The tenant ids must have the shape `[A-Za-z0-9_-]{1,128}` and differ.
- The `legacy` row of `tenants` stays: the columns still default to it. The migration that drops those defaults removes it.
- It prints `tenant_adopt.done` with the rows moved in each table, or `tenant_adopt.refused` with its reason (`bad-tenant-id`, `same-tenant`, `source-unknown`, `source-empty`, `target-unnamed`, `target-not-empty`); never a name, a domain or anything of a person. Exit 0 when done, 1 when refused or failed, 2 for a usage or settings error.
