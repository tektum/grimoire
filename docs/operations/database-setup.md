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
- The `citext`, `pg_trgm` and `vector` (pgvector) extensions exist. The migration role has only `CONNECT` on the database, so it cannot create an extension, not even a trusted one: this step does, with the administrator's right to create extensions. The migrations that need an extension (the users and groups one for `citext`, title search for `pg_trgm`, the page embeddings for `vector`) only repeat `create extension if not exists`, or check that it is there, which is a no-op once this step ran. `vector` is not a trusted extension at all: on Amazon RDS for PostgreSQL its creation needs `rds_superuser`, which the master user holds. RDS for PostgreSQL 17 offers pgvector 0.8.0 from 17.3, 0.8.1 from 17.8 and 0.8.2 from 17.10 (the AWS table of extension versions); the semantic search uses only the `vector` type and the `<=>` operator, which all of them have. The local image has 0.8.5.

**Run it again on every upgrade.** `db-setup` is not a one-time step: a release may need an extension that the previous one did not (`pg_trgm` came with title search), and only this step can create it. A managed database set up by an older release therefore needs `db-setup` before the `migrate` of the new one. The deploy does that by itself: the task starts `db-setup`, then `migrate`, then the app, on every deploy (`infra/stack/init-order.ts`; `tools/ci/test/stack-init-order.test.mjs` asserts that `migrate` waits for `db-setup` to exit with 0, and the recorded staging declaration pins the three containers). An operator who runs the commands by hand does the same two in that order. Run alone against a database that was not set up by the current version, `migrate` stops at the first migration that needs an extension that is missing, with a message that names this step, and applies nothing: the migrations run in one transaction.

**Order.** Every deploy runs `grimoire db-setup` before `grimoire migrate` (the start order of the task in `infra/stack/init-order.ts`). The migrations rely on it: the migration role has only `CONNECT` on the database, so it cannot create an extension, even a trusted one such as `pg_trgm` (the title search migration only repeats `create extension if not exists`, a no-op once this step ran), and `vector` (the page embeddings migration) is not trusted at all. `migrate` on its own against a database that `db-setup` has not set up with the current version fails on the first extension it needs, with a message that says so. **Engine version.** `infra/stages.ts` pins one Postgres minor for every stage (`POSTGRES_VERSION`, never below 17.3), because the pgvector an RDS instance has depends on its minor.

The server receives a SCRAM-SHA-256 verifier computed here, not the password, so the password is not in any statement the server may log or record (`log_statement`, pgaudit, `pg_stat_statements`). The command never logs it either.

The server refuses to start when the administrator connection or a role password is set: only this step holds them. The server takes the operator role's connection as `GRIMOIRE_DATABASE_OPS_URL`, which every role (`api`, `collab`, `all`) requires: sign-in looks people up through it (docs/tenancy.md section 3.2). A server without it refuses to start; nothing falls back to the runtime connection.

Tested against PostgreSQL 17 as a superuser and as a non-superuser with `CREATEROLE` (the shape of a managed master user). Not yet run on a real managed service: on one, the master user must be able to become the migration role to hand it the schemas, which the command arranges with `GRANT ... WITH SET TRUE`.

## Moving the existing workspace into a tenant: `grimoire tenant-adopt`

Migration 0009 put every row a database held before tenancy in the tenant `legacy`. `grimoire tenant-adopt --from legacy --to <tenant id> [--name <name> --domain <domain>]` moves all of it into a real tenant, once, by hand (`docs/tenancy.md` section 5, item 4). It runs as the migration role, with `GRIMOIRE_DATABASE_MIGRATION_URL` like `grimoire migrate`.

- One transaction: every row of every tenant table moves, or none does. Writes to those tables wait until it ends; reads go on.
- The target's `tenants` row is used when it exists (a first sign-in made it). When it does not, `--name` and `--domain` make it, and without them the command refuses.
- It refuses, and changes nothing, when the target already holds a row in any tenant table other than `users`, or when the source holds no row at all (so a second run is refused). The tenant ids must have the shape `[A-Za-z0-9_-]{1,128}` and differ.
- The `legacy` row of `tenants` stays: the columns still default to it. The migration that drops those defaults removes it.
- It prints `tenant_adopt.done` with the rows moved in each table, or `tenant_adopt.refused` with its reason (`bad-tenant-id`, `same-tenant`, `source-unknown`, `source-empty`, `target-unnamed`, `target-not-empty`); never a name, a domain or anything of a person. Exit 0 when done, 1 when refused or failed, 2 for a usage or settings error.

## Moving a stage to Aurora Serverless v2

Every stage moves once, dev first, each move with its own go (decision 166). The stage's RDS instance stays as the way back, with deletion protection, until a later change removes it. The site is down from step 1 to the end of step 4, most of it the restore.

1. **Freeze.** Dispatch `descope-infra.yml` with `action=freeze` for the stage. Its service then runs no task, so nothing writes to the database.
2. **Snapshot.** `tools/adopt/targets.sh <stage>` prints the instance (`database=<id>`, `database_kind=instance`); `tools/adopt/snapshot.sh instance <id> grimoire-<stage>-to-aurora` returns once the snapshot is available.
3. **Variable.** Set `GRIMOIRE_AURORA_SNAPSHOT` in the stage's GitHub environment to the snapshot's ARN (`aws rds describe-db-snapshots --db-snapshot-identifier grimoire-<stage>-to-aurora --query 'DBSnapshots[0].DBSnapshotArn' --output text`: a cluster restores from an instance's snapshot by ARN only). The deploy refuses a snapshot whose name does not start with `grimoire-<stage>-`, so another stage's snapshot cannot be restored here by mistake: dev and staging share an account. It stays set: without it the cluster would leave the program.
4. **Deploy.** Dispatch `action=deploy`. SST restores the cluster `DbCluster` from the snapshot (Aurora PostgreSQL at `POSTGRES_VERSION`, 0.5 to 2 ACU and never paused, the stage's database security group, deletion protection, 7 days of backups, the snapshot ignored once the cluster exists), points the four connection strings at it and protects the instance. The deploy then starts the service, whose `db-setup` and `migrate` run against the cluster, and the gate waits for `/readyz`.
5. **Check.** `targets.sh` prints `database_kind=cluster`. Sign in, open a page and the tree, edit and save, import, search; `/readyz` answers 200 and the load balancer logs no 5xx.

If the deploy fails, the service stays stopped. While `targets.sh` still prints the instance (the connection strings change only once the cluster exists), `tools/deploy/freeze.sh thaw <stage>` runs the stage on the instance again, with nothing lost. Once it prints the cluster, fix the cause and deploy again; never unset the variable then.

Not yet run: the dev move is the first. It checks what only a real restore shows: that the cluster takes the master password SST gives it, that Amazon's bundle in the image verifies the cluster's endpoint, and that Aurora's pgvector for 17.9 is at least the one the database has.
