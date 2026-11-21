#!/bin/sh
# Hand-written because the postgres image runs *.sql init files without variables: this passes the shared dev password to psql.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$GRIMOIRE_DEV_DB_PASSWORD" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/roles.psql
