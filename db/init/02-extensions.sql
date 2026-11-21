-- Local development only. Run once by the postgres image's init step (after 01-roles.sh), as the container superuser, against database grimoire.
-- grimoire_migrator has only CONNECT on the database and cannot create extensions; migration 0004 repeats `create extension if not exists citext`, which is a no-op once this ran.
-- Both are trusted extensions. On a managed service (Cloud SQL) the administrator is not a superuser: install them there with a role that may create extensions
-- (cloudsqlsuperuser) before the first `grimoire migrate`.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
