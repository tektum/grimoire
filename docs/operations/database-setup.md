# Database set-up on a managed PostgreSQL

`grimoire db-setup` makes an empty managed database ready for `grimoire migrate`. The local stack does the same through `db/init/roles.psql`; a managed database has no such step, so the command does it, as the database administrator (the master user of the service).

Run it before the first migration, in the same pre-rollout step, and again whenever a password is rotated. It is safe to run again.

| Setting | Meaning |
|---|---|
| `GRIMOIRE_DATABASE_ADMIN_URL` | the administrator's connection to the product database |
| `GRIMOIRE_DB_APP_PASSWORD` | the password to give the runtime role `grimoire_app` (at least 16 characters) |
| `GRIMOIRE_DB_MIGRATOR_PASSWORD` | the password to give the migration role `grimoire_migrator` (at least 16 characters) |

End state: both roles exist and can log in, only they may connect to the database, the migration role owns schema `public` and the job queue's schema `pgboss`, the runtime role may use `public` and nothing more (each migration grants it what it needs), and the `citext` extension exists. A run with new passwords changes them. The passwords are quoted by the server and never logged.

The server refuses to start when any of these three settings is set: only this step holds the administrator connection and the passwords.

Tested against PostgreSQL 17 as a superuser and as a non-superuser with `CREATEROLE` (the shape of a managed master user). Not yet run on a real managed service: on one, the master user must be able to become the migration role to hand it the schemas, which the command arranges with `GRANT ... WITH SET TRUE`.
