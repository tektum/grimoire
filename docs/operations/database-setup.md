# Database set-up on a managed PostgreSQL

`grimoire db-setup` makes an empty managed database ready for `grimoire migrate`. The local stack does the same through `db/init/roles.psql`; a managed database has no such step, so the command does it, as the database administrator (the master user of the service).

Run it before the first migration, in the same pre-rollout step, and again whenever a password is rotated. It is safe to run again.

| Setting | Meaning |
|---|---|
| `GRIMOIRE_DATABASE_ADMIN_URL` | the administrator's connection to the product database |
| `GRIMOIRE_DB_APP_PASSWORD` | the password to give the runtime role `grimoire_app` (at least 16 characters) |
| `GRIMOIRE_DB_MIGRATOR_PASSWORD` | the password to give the migration role `grimoire_migrator` (at least 16 characters) |

End state, in one transaction (a failure leaves the database as it was):

- Both roles exist as plain `LOGIN` roles with no other attribute: no privilege attribute, no connection limit, no expiry. A role that exists already is reset to that, and the command refuses a role that is a member of another role.
- A non-superuser administrator can only reset a privilege attribute (`CREATEDB`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`) that it holds itself, on PostgreSQL 16 and later. When it cannot, the command fails, changes nothing and says to reset the role as a superuser or drop it. A clean database never hits this.
- Both roles have the password you gave. A run with new passwords changes them.
- The public may not connect to the database. A role that already holds an explicit grant keeps it: that is the administrator's decision.
- The migration role owns schema `public` and the job queue's schema `pgboss`, also when `pgboss` was there before.
- The runtime role may use `public` and nothing more. Each migration grants it what it needs.
- The `citext` extension exists.

The server receives a SCRAM-SHA-256 verifier computed here, not the password, so the password is not in any statement the server may log or record (`log_statement`, pgaudit, `pg_stat_statements`). The command never logs it either.

The server refuses to start when any of these three settings is set: only this step holds the administrator connection and the passwords.

Tested against PostgreSQL 17 as a superuser and as a non-superuser with `CREATEROLE` (the shape of a managed master user). Not yet run on a real managed service: on one, the master user must be able to become the migration role to hand it the schemas, which the command arranges with `GRANT ... WITH SET TRUE`.
